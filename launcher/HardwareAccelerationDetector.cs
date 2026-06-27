using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Launcher;

public static class HardwareAccelerationDetector
{
    public const string ImportHardwareUnsupportedMessage = "HW encoding is not supported for HEVC on your device";
    public const string ImportCatalogModeTooltip = "HW encoding is not supported for HEVC on your device, encode mode is disabled";

    public static string FormatAccelerationForDisplay(string? acceleration)
    {
        if (IsUnsupportedAcceleration(acceleration))
        {
            return "unsupported";
        }

        return string.Equals(acceleration!.Trim(), "cpu", StringComparison.OrdinalIgnoreCase)
            ? "software"
            : acceleration.Trim();
    }

    public static string SelectServerTranscodeAcceleration(HardwareAccelerationDetection detection, bool importEnabled)
    {
        return ShouldUseImportAcceleration(detection, importEnabled)
            ? NormalizeSupportedAccelerationForExport(detection.ImportAcceleration)
            : NormalizeLiveAccelerationForExport(detection.LiveTranscodeAcceleration);
    }

    public static bool IsUnsupportedAcceleration(string? acceleration)
    {
        return string.IsNullOrWhiteSpace(acceleration)
            || string.Equals(acceleration.Trim(), "unsupported", StringComparison.OrdinalIgnoreCase);
    }

    public static bool SupportsImportAcceleration(HardwareAccelerationDetection detection)
    {
        return !IsUnsupportedAcceleration(detection.ImportAcceleration);
    }

    private static bool ShouldUseImportAcceleration(HardwareAccelerationDetection detection, bool importEnabled)
    {
        return importEnabled && SupportsImportAcceleration(detection);
    }

    private static string NormalizeSupportedAccelerationForExport(string? acceleration)
    {
        return string.IsNullOrWhiteSpace(acceleration)
            ? "cpu"
            : acceleration.Trim().ToLowerInvariant();
    }

    private static string NormalizeLiveAccelerationForExport(string? acceleration)
    {
        if (IsUnsupportedAcceleration(acceleration)
            || string.Equals(acceleration?.Trim(), "software", StringComparison.OrdinalIgnoreCase))
        {
            return "cpu";
        }

        return acceleration!.Trim().ToLowerInvariant();
    }

    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    public static async Task<HardwareAccelerationDetection> DetectAsync(string? ffmpegDir = null, bool probeEncoders = true)
    {
        var hardware = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? await DetectWindowsHardwareAsync()
            : await DetectUnixHardwareAsync();
        var ffmpegPath = ResolveFfmpegPath(ffmpegDir);
        var usableFfmpegPath = probeEncoders && File.Exists(ffmpegPath) ? ffmpegPath : null;
        var hevcAcceleration = await ResolveWithOptionalProbeAsync(
            usableFfmpegPath,
            GetHevcCandidates(hardware),
            EncoderProbeKind.Hevc);
        var importAcceleration = hevcAcceleration;
        var liveAcceleration = await ResolveWithOptionalProbeAsync(
            usableFfmpegPath,
            PrioritizeLiveCandidates(GetLiveCandidates(hardware), importAcceleration),
            EncoderProbeKind.Live);

        return new HardwareAccelerationDetection(
            importAcceleration?.Acceleration,
            importAcceleration?.Device,
            liveAcceleration?.Acceleration ?? "cpu",
            liveAcceleration?.Device,
            hardware.GpuInfo,
            hardware.CpuInfo);
    }

    private static string ResolveFfmpegPath(string? ffmpegDir)
    {
        if (string.IsNullOrWhiteSpace(ffmpegDir))
        {
            return string.Empty;
        }

        return Path.Combine(ffmpegDir, RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "ffmpeg.exe" : "ffmpeg");
    }

    private static async Task<HardwareInfo> DetectWindowsHardwareAsync()
    {
        return new HardwareInfo(
            await RunProcessOutputAsync("powershell", new[]
            {
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
            }, CommandTimeout),
            await RunProcessOutputAsync("powershell", new[]
            {
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name"
            }, CommandTimeout),
            Array.Empty<RenderDevice>());
    }

    private static async Task<HardwareInfo> DetectUnixHardwareAsync()
    {
        var renderDevices = DetectRenderDevices();
        var gpuInfo = string.Join(Environment.NewLine, new[]
        {
            await RunProcessOutputAsync("lspci", Array.Empty<string>(), CommandTimeout),
            FormatRenderDeviceInfo(renderDevices)
        }.Where(value => !string.IsNullOrWhiteSpace(value)));
        var cpuInfo = ReadUnixCpuInfo();

        if (string.IsNullOrWhiteSpace(cpuInfo) && RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            cpuInfo = await RunProcessOutputAsync("sysctl", new[] { "-n", "machdep.cpu.brand_string" }, CommandTimeout);
        }

        return new HardwareInfo(gpuInfo, cpuInfo, renderDevices);
    }

    private static IReadOnlyList<RenderDevice> DetectRenderDevices()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return Array.Empty<RenderDevice>();
        }

        try
        {
            const string drmRoot = "/sys/class/drm";
            if (!Directory.Exists(drmRoot))
            {
                return Array.Empty<RenderDevice>();
            }

            return Directory.EnumerateFileSystemEntries(drmRoot)
                .Select(Path.GetFileName)
                .Where(name => name != null && Regex.IsMatch(name, @"^renderD\d+$"))
                .Select(name => name!)
                .OrderBy(name => name, StringComparer.Ordinal)
                .Select(name =>
                {
                    var root = Path.Combine(drmRoot, name, "device");
                    var vendorId = ReadOptionalFile(Path.Combine(root, "vendor")).ToLowerInvariant();
                    var deviceId = ReadOptionalFile(Path.Combine(root, "device")).ToLowerInvariant();
                    var uevent = ReadOptionalFile(Path.Combine(root, "uevent"));
                    var driver = Path.GetFileName(ReadOptionalLink(Path.Combine(root, "driver")));
                    var description = string.Join(" ", new[] { name, vendorId, deviceId, driver, uevent }.Where(value => !string.IsNullOrWhiteSpace(value)));

                    return new RenderDevice($"/dev/dri/{name}", vendorId, description);
                })
                .ToArray();
        }
        catch
        {
            return Array.Empty<RenderDevice>();
        }
    }

    private static string FormatRenderDeviceInfo(IReadOnlyList<RenderDevice> renderDevices)
    {
        return string.Join(Environment.NewLine, renderDevices.Select(device => $"{device.Path} {device.VendorId} {device.Description}".Trim()));
    }

    private static string ReadUnixCpuInfo()
    {
        try
        {
            return File.Exists("/proc/cpuinfo") ? File.ReadAllText("/proc/cpuinfo") : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string ReadOptionalFile(string filePath)
    {
        try
        {
            return File.Exists(filePath) ? File.ReadAllText(filePath).Trim() : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string ReadOptionalLink(string filePath)
    {
        try
        {
            return File.Exists(filePath) ? new FileInfo(filePath).LinkTarget ?? string.Empty : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static async Task<string> RunProcessOutputAsync(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }
            };

            foreach (var argument in arguments)
            {
                process.StartInfo.ArgumentList.Add(argument);
            }

            var output = new StringBuilder();
            var error = new StringBuilder();
            process.OutputDataReceived += (_, e) => AppendLine(output, e.Data);
            process.ErrorDataReceived += (_, e) => AppendLine(error, e.Data);

            if (!process.Start())
            {
                return string.Empty;
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var waitTask = process.WaitForExitAsync();
            var completed = await Task.WhenAny(waitTask, Task.Delay(timeout)) == waitTask;
            if (!completed)
            {
                TryKill(process);
                return string.Empty;
            }

            process.WaitForExit();
            return string.Join(Environment.NewLine, output.ToString(), error.ToString()).Trim();
        }
        catch
        {
            return string.Empty;
        }
    }

    private static void AppendLine(StringBuilder target, string? line)
    {
        if (!string.IsNullOrWhiteSpace(line))
        {
            target.AppendLine(line);
        }
    }

    private static string[] SplitHardwareLines(string value)
    {
        return value
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToArray();
    }

    private static string Normalize(string value)
    {
        return Regex.Replace(value.ToLowerInvariant(), @"[\s_-]+", " ");
    }

    private static bool ContainsAny(string value, params string[] tokens)
    {
        return tokens.Any(value.Contains);
    }

    private static bool HasNvidiaGpu(string value)
    {
        return ContainsAny(value, "nvidia", "geforce", "quadro", "rtx");
    }

    private static bool HasAmdGpu(string value)
    {
        return ContainsAny(value, "amd", "advanced micro devices", "ati technologies", "radeon", "firepro");
    }

    private static bool HasIntelGpu(string value)
    {
        return ContainsAny(value, "intel", "iris", "uhd graphics", "arc");
    }

    private static bool IsNvidiaAcceleration(string acceleration)
    {
        return acceleration.Equals("nvenc", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsIntelAcceleration(string acceleration)
    {
        return acceleration.ToLowerInvariant() switch
        {
            "intel_gpu" or "intel_cpu" => true,
            _ => false
        };
    }

    private static bool SupportsNvidiaHevcEncode(string value)
    {
        var normalized = Normalize(value);

        return HasNvidiaGpu(normalized)
            && !Regex.IsMatch(normalized, @"\b(gt\s*710|gt\s*730|gtx\s*(5|6|7)\d{2})\b");
    }

    private static bool SupportsIntelHevcEncode(string value)
    {
        var normalized = Normalize(value);

        return HasIntelGpu(normalized) || normalized.Contains("intel");
    }

    private static bool SupportsAmdHevcEncode(string value)
    {
        var normalized = Normalize(value);

        return HasAmdGpu(normalized) || HasAmdApuHint(normalized);
    }

    private static bool HasAmdApuHint(string value)
    {
        var normalized = Normalize(value);

        return Regex.IsMatch(normalized, @"\bwith\s+radeon\s+graphics\b")
            || Regex.IsMatch(normalized, @"\bradeon\s+graphics\b")
            || Regex.IsMatch(normalized, @"\bradeon\b.*\b(610m|660m|680m|740m|760m|780m|880m|890m)\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*ai\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*z1\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*[3579]\s*\d{4}g\b");
    }

    private static IReadOnlyList<EncoderCandidate> MakeCandidates(HardwareInfo hardware, string acceleration, HardwareSource source)
    {
        return DefaultDevicePathsForAcceleration(hardware, acceleration)
            .Select(device => new EncoderCandidate(acceleration, device, source))
            .ToArray();
    }

    private static IReadOnlyList<string?> DefaultDevicePathsForAcceleration(HardwareInfo hardware, string acceleration)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return new string?[] { null };
        }

        var vendorId = acceleration.ToLowerInvariant() switch
        {
            "amd_gpu" or "amd_cpu" => "0x1002",
            "intel_gpu" or "intel_cpu" => "0x8086",
            _ => null
        };

        if (vendorId == null)
        {
            return new string?[] { null };
        }

        var devices = hardware.RenderDevices
            .Where(device => string.Equals(device.VendorId, vendorId, StringComparison.OrdinalIgnoreCase))
            .Select(device => (string?)device.Path)
            .ToArray();

        return devices.Length > 0 ? devices : new string?[] { "/dev/dri/renderD128" };
    }

    private static IReadOnlyList<EncoderCandidate> UniqueCandidates(IEnumerable<EncoderCandidate> candidates)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<EncoderCandidate>();

        foreach (var candidate in candidates)
        {
            var key = $"{candidate.Acceleration}|{candidate.Device ?? string.Empty}";
            if (!seen.Add(key))
            {
                continue;
            }

            result.Add(candidate);
        }

        return result;
    }

    private static IReadOnlyList<EncoderCandidate> PrioritizeCandidates(IEnumerable<EncoderCandidate> candidates)
    {
        return UniqueCandidates(candidates)
            .OrderBy(candidate => candidate.Source == HardwareSource.Gpu ? 0 : 1)
            .ThenBy(candidate => AccelerationPriority(candidate.Acceleration))
            .ThenBy(candidate => candidate.Device ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IReadOnlyList<EncoderCandidate> PrioritizeLiveCandidates(
        IReadOnlyList<EncoderCandidate> candidates,
        EncoderCandidate? importCandidate)
    {
        return candidates
            .OrderBy(candidate => CandidateMatchesPreferred(candidate, importCandidate) ? 0 : 1)
            .ThenBy(candidate => candidate.Source == HardwareSource.Gpu ? 0 : 1)
            .ThenBy(candidate => AccelerationPriority(candidate.Acceleration))
            .ThenBy(candidate => candidate.Device ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static bool CandidateMatchesPreferred(EncoderCandidate candidate, EncoderCandidate? preferred)
    {
        if (preferred is null)
        {
            return false;
        }

        return string.Equals(candidate.Acceleration, preferred.Acceleration, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.Device ?? string.Empty, preferred.Device ?? string.Empty, StringComparison.OrdinalIgnoreCase);
    }

    private static int AccelerationPriority(string acceleration)
    {
        return acceleration.ToLowerInvariant() switch
        {
            "nvenc" => 0,
            "amd_gpu" => 1,
            "intel_gpu" => 2,
            "amd_cpu" => 3,
            "intel_cpu" => 4,
            _ => 100
        };
    }

    private static IReadOnlyList<EncoderCandidate> GetHevcCandidates(HardwareInfo hardware)
    {
        var candidates = new List<EncoderCandidate>();

        foreach (var line in SplitHardwareLines(hardware.GpuInfo))
        {
            var normalized = Normalize(line);

            if (HasNvidiaGpu(normalized) && SupportsNvidiaHevcEncode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "nvenc", HardwareSource.Gpu));
            }

            if (HasIntelGpu(normalized) && SupportsIntelHevcEncode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_gpu", HardwareSource.Gpu));
            }

            if (HasAmdGpu(normalized) && SupportsAmdHevcEncode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_gpu", HardwareSource.Gpu));
            }
        }

        foreach (var line in SplitHardwareLines(hardware.CpuInfo))
        {
            var normalized = Normalize(line);

            if (normalized.Contains("intel") && SupportsIntelHevcEncode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_cpu", HardwareSource.Cpu));
            }

            if (normalized.Contains("amd") && SupportsAmdHevcEncode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_cpu", HardwareSource.Cpu));
            }
        }

        return PrioritizeCandidates(candidates);
    }

    private static IReadOnlyList<EncoderCandidate> GetLiveCandidates(HardwareInfo hardware)
    {
        var candidates = new List<EncoderCandidate>();

        foreach (var line in SplitHardwareLines(hardware.GpuInfo))
        {
            var normalized = Normalize(line);

            if (HasNvidiaGpu(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "nvenc", HardwareSource.Gpu));
            }

            if (HasIntelGpu(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_gpu", HardwareSource.Gpu));
            }

            if (HasAmdGpu(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_gpu", HardwareSource.Gpu));
            }
        }

        foreach (var line in SplitHardwareLines(hardware.CpuInfo))
        {
            var normalized = Normalize(line);

            if (normalized.Contains("intel") && !Regex.IsMatch(normalized, @"\bcore\s*i[3579][\s-]*\d{4,5}f\b"))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_cpu", HardwareSource.Cpu));
            }

            if (normalized.Contains("amd") && HasAmdApuHint(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_cpu", HardwareSource.Cpu));
            }
        }

        return PrioritizeCandidates(candidates);
    }

    private static async Task<EncoderCandidate?> ResolveWithOptionalProbeAsync(
        string? ffmpegPath,
        IReadOnlyList<EncoderCandidate> candidates,
        EncoderProbeKind kind)
    {
        if (string.IsNullOrWhiteSpace(ffmpegPath))
        {
            return candidates.FirstOrDefault();
        }

        foreach (var candidate in candidates)
        {
            if (await CanRunEncoderProbeAsync(ffmpegPath, candidate, kind))
            {
                return candidate;
            }
        }

        return null;
    }

    private static async Task<bool> CanRunEncoderProbeAsync(string ffmpegPath, EncoderCandidate candidate, EncoderProbeKind kind)
    {
        var args = new List<string> { "-hide_banner", "-loglevel", "error" };
        args.AddRange(GetEncoderProbeArgs(candidate, kind));

        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = ffmpegPath,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }
            };

            foreach (var arg in args)
            {
                process.StartInfo.ArgumentList.Add(arg);
            }

            if (!process.Start())
            {
                return false;
            }

            var waitTask = process.WaitForExitAsync();
            var completed = await Task.WhenAny(waitTask, Task.Delay(ProbeTimeout)) == waitTask;
            if (!completed)
            {
                TryKill(process);
                return false;
            }

            process.WaitForExit();
            return process.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static IReadOnlyList<string> GetHevcProbeQualityArgs(string acceleration)
    {
        switch (acceleration.ToLowerInvariant())
        {
            case "nvenc":
                return new[]
                {
                    "-preset",
                    "p4",
                    "-tune",
                    "hq",
                    "-rc:v",
                    "vbr",
                    "-cq:v",
                    "24",
                    "-b:v",
                    "2M",
                    "-maxrate",
                    "3M",
                    "-bufsize",
                    "6M",
                    "-multipass",
                    "fullres"
                };

            case "intel_gpu":
            case "intel_cpu":
                return new[]
                {
                    "-preset",
                    "medium",
                    "-global_quality:v",
                    "24",
                    "-b:v",
                    "2M",
                    "-maxrate",
                    "3M",
                    "-bufsize",
                    "6M"
                };
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return new[]
            {
                "-rc_mode",
                "VBR",
                "-compression_level",
                "3",
                "-b:v",
                "2M",
                "-maxrate",
                "3M",
                "-bufsize",
                "6M"
            };
        }

        return new[]
        {
            "-usage",
            "high_quality",
            "-quality",
            "balanced",
            "-rc",
            "vbr_peak",
            "-b:v",
            "2M",
            "-maxrate",
            "3M",
            "-bufsize",
            "6M"
        };
    }

    private static string EncoderName(EncoderCandidate candidate, EncoderProbeKind kind)
    {
        if (IsNvidiaAcceleration(candidate.Acceleration))
        {
            return kind switch
            {
                EncoderProbeKind.Hevc => "hevc_nvenc",
                _ => "h264_nvenc"
            };
        }

        if (IsIntelAcceleration(candidate.Acceleration))
        {
            return kind switch
            {
                EncoderProbeKind.Hevc => "hevc_qsv",
                _ => "h264_qsv"
            };
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return kind switch
            {
                EncoderProbeKind.Hevc => "hevc_vaapi",
                _ => "h264_vaapi"
            };
        }

        return kind switch
        {
            EncoderProbeKind.Hevc => "hevc_amf",
            _ => "h264_amf"
        };
    }

    private static IReadOnlyList<string> EncoderProbeQualityArgs(EncoderCandidate candidate, EncoderProbeKind kind)
    {
        if (kind is EncoderProbeKind.Hevc)
        {
            return GetHevcProbeQualityArgs(candidate.Acceleration);
        }

        if (IsNvidiaAcceleration(candidate.Acceleration))
        {
            return new[] { "-preset", "p2" };
        }

        if (IsIntelAcceleration(candidate.Acceleration))
        {
            return new[] { "-preset", "veryfast" };
        }

        return Array.Empty<string>();
    }

    private static IReadOnlyList<string> GetEncoderProbeArgs(EncoderCandidate candidate, EncoderProbeKind kind)
    {
        var inputArgs = new[] { "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=1" };
        var suffixArgs = new[] { "-frames:v", "1", "-an", "-f", "null", "-" };

        if (IsNvidiaAcceleration(candidate.Acceleration))
        {
            return inputArgs
                .Concat(new[] { "-c:v", EncoderName(candidate, kind) })
                .Concat(EncoderProbeQualityArgs(candidate, kind))
                .Concat(suffixArgs)
                .ToArray();
        }

        if (IsIntelAcceleration(candidate.Acceleration))
        {
            return GetQsvDeviceArgs(candidate)
                .Concat(inputArgs)
                .Concat(new[] { "-vf", "format=nv12", "-c:v", EncoderName(candidate, kind) })
                .Concat(EncoderProbeQualityArgs(candidate, kind))
                .Concat(suffixArgs)
                .ToArray();
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return GetVaapiDeviceArgs(candidate)
                .Concat(inputArgs)
                .Concat(new[] { "-vf", "format=nv12,hwupload", "-c:v", EncoderName(candidate, kind) })
                .Concat(EncoderProbeQualityArgs(candidate, kind))
                .Concat(suffixArgs)
                .ToArray();
        }

        return inputArgs
            .Concat(new[] { "-c:v", EncoderName(candidate, kind) })
            .Concat(EncoderProbeQualityArgs(candidate, kind))
            .Concat(suffixArgs)
            .ToArray();
    }

    private static IReadOnlyList<string> GetQsvDeviceArgs(EncoderCandidate candidate)
    {
        return RuntimeInformation.IsOSPlatform(OSPlatform.Linux) && !string.IsNullOrWhiteSpace(candidate.Device)
            ? new[] { "-qsv_device", candidate.Device! }
            : Array.Empty<string>();
    }

    private static IReadOnlyList<string> GetVaapiDeviceArgs(EncoderCandidate candidate)
    {
        return new[] { "-vaapi_device", candidate.Device ?? "/dev/dri/renderD128" };
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(true);
            }
        }
        catch
        {
        }
    }

    private enum EncoderProbeKind
    {
        Hevc,
        Live
    }

    private enum HardwareSource
    {
        Gpu,
        Cpu
    }

    private sealed record HardwareInfo(string GpuInfo, string CpuInfo, IReadOnlyList<RenderDevice> RenderDevices);
    private sealed record RenderDevice(string Path, string VendorId, string Description);
    private sealed record EncoderCandidate(string Acceleration, string? Device, HardwareSource Source);
}

public sealed record HardwareAccelerationDetection(
    string? ImportAcceleration,
    string? ImportDevice,
    string LiveTranscodeAcceleration,
    string? LiveTranscodeDevice,
    string GpuInfo,
    string CpuInfo);
