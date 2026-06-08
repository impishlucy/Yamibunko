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
    public const string Av1HardwareUnsupportedMessage = "HW encoding is not supported for AV1 on your device";
    public const string Av1CatalogModeTooltip = "HW encoding is not supported for AV1 on your device, encode mode is disabled";

    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    public static async Task<HardwareAccelerationDetection> DetectAsync(string? ffmpegDir = null, bool probeEncoders = true)
    {
        var hardware = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? await DetectWindowsHardwareAsync()
            : await DetectUnixHardwareAsync();
        var ffmpegPath = ResolveFfmpegPath(ffmpegDir);
        var usableFfmpegPath = probeEncoders && File.Exists(ffmpegPath) ? ffmpegPath : null;
        var av1Acceleration = await ResolveWithOptionalProbeAsync(
            usableFfmpegPath,
            GetAv1Candidates(hardware),
            EncoderProbeKind.Av1);
        var liveAcceleration = await ResolveWithOptionalProbeAsync(
            usableFfmpegPath,
            GetLiveCandidates(hardware),
            EncoderProbeKind.Live);

        return new HardwareAccelerationDetection(
            av1Acceleration?.Acceleration,
            av1Acceleration?.Device,
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
        return string.Equals(acceleration, "nvenc", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsIntelAcceleration(string acceleration)
    {
        return string.Equals(acceleration, "intel_gpu", StringComparison.OrdinalIgnoreCase)
            || string.Equals(acceleration, "intel_cpu", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAmdAcceleration(string acceleration)
    {
        return string.Equals(acceleration, "amd_gpu", StringComparison.OrdinalIgnoreCase)
            || string.Equals(acceleration, "amd_cpu", StringComparison.OrdinalIgnoreCase);
    }

    private static bool SupportsNvidiaAv1Encode(string value)
    {
        var normalized = Normalize(value);

        return Regex.IsMatch(normalized, @"\brtx\s*(40|50)\d{2}\b")
            || Regex.IsMatch(normalized, @"\brtx\s*(40|50)\d{2}\s*(ti|super|laptop)?\b")
            || Regex.IsMatch(normalized, @"\brtx\s*(20|40|45|50|60)00\b.*\bada\b")
            || Regex.IsMatch(normalized, @"\bada\b")
            || Regex.IsMatch(normalized, @"\bblackwell\b")
            || Regex.IsMatch(normalized, @"\bl4\b")
            || Regex.IsMatch(normalized, @"\bl40s?\b")
            || Regex.IsMatch(normalized, @"\bgb\d{3}\b");
    }

    private static bool SupportsIntelGpuAv1Encode(string value)
    {
        var normalized = Normalize(value);

        return Regex.IsMatch(normalized, @"\barc\s*(a|b)\d{3}\b")
            || Regex.IsMatch(normalized, @"\barc\s*pro\s*(a|b)\d{2,4}\b")
            || Regex.IsMatch(normalized, @"\bintel\s*arc\b")
            || Regex.IsMatch(normalized, @"\bcore\s*ultra\b.*\barc\b")
            || Regex.IsMatch(normalized, @"\barc\b.*\bcore\s*ultra\b")
            || Regex.IsMatch(normalized, @"\bmeteor\s*lake\b.*\barc\b")
            || Regex.IsMatch(normalized, @"\blunar\s*lake\b")
            || Regex.IsMatch(normalized, @"\barrow\s*lake\b.*\barc\b");
    }

    private static bool SupportsIntelCpuAv1Encode(string value)
    {
        var normalized = Normalize(value);

        return Regex.IsMatch(normalized, @"\bcore\s*ultra\b")
            || Regex.IsMatch(normalized, @"\bmeteor\s*lake\b")
            || Regex.IsMatch(normalized, @"\blunar\s*lake\b")
            || Regex.IsMatch(normalized, @"\barrow\s*lake\b");
    }

    private static bool SupportsAmdAv1Encode(string value)
    {
        var normalized = Normalize(value);

        return Regex.IsMatch(normalized, @"\bradeon\b.*\brx\s*[789]\d{3}\b")
            || Regex.IsMatch(normalized, @"\brx\s*[789]\d{3}\b")
            || Regex.IsMatch(normalized, @"\bradeon\b.*\bpro\s*w[789]\d{3}\b")
            || Regex.IsMatch(normalized, @"\bpro\s*w[789]\d{3}\b")
            || Regex.IsMatch(normalized, @"\bradeon\b.*\b(740m|760m|780m|780m graphics|880m|890m)\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*ai\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*[3579]\s*(7040|8040|8\d{3}g?)\w*\b")
            || Regex.IsMatch(normalized, @"\bryzen\s*z1\b")
            || Regex.IsMatch(normalized, @"\bvcn\s*(4|5)(\.\d*)?\b")
            || Regex.IsMatch(normalized, @"\bnavi\s*(3|4)\d\b")
            || Regex.IsMatch(normalized, @"\brdna\s*(3|4)\b")
            || Regex.IsMatch(normalized, @"\bstrix\b")
            || Regex.IsMatch(normalized, @"\bphoenix\b")
            || Regex.IsMatch(normalized, @"\bhawk\s*point\b");
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

        if (IsAmdAcceleration(acceleration))
        {
            var devices = hardware.RenderDevices
                .Where(device => string.Equals(device.VendorId, "0x1002", StringComparison.OrdinalIgnoreCase))
                .Select(device => (string?)device.Path)
                .ToArray();
            return devices.Length > 0 ? devices : new string?[] { "/dev/dri/renderD128" };
        }

        if (IsIntelAcceleration(acceleration))
        {
            var devices = hardware.RenderDevices
                .Where(device => string.Equals(device.VendorId, "0x8086", StringComparison.OrdinalIgnoreCase))
                .Select(device => (string?)device.Path)
                .ToArray();
            return devices.Length > 0 ? devices : new string?[] { "/dev/dri/renderD128" };
        }

        return new string?[] { null };
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

    private static IReadOnlyList<EncoderCandidate> GetAv1Candidates(HardwareInfo hardware)
    {
        var candidates = new List<EncoderCandidate>();

        foreach (var line in SplitHardwareLines(hardware.GpuInfo))
        {
            var normalized = Normalize(line);

            if (HasNvidiaGpu(normalized) && SupportsNvidiaAv1Encode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "nvenc", HardwareSource.Gpu));
            }

            if (HasIntelGpu(normalized) && SupportsIntelGpuAv1Encode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_gpu", HardwareSource.Gpu));
            }

            if (HasAmdGpu(normalized) && SupportsAmdAv1Encode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_gpu", HardwareSource.Gpu));
            }
        }

        foreach (var line in SplitHardwareLines(hardware.CpuInfo))
        {
            var normalized = Normalize(line);

            if (normalized.Contains("intel") && SupportsIntelCpuAv1Encode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "intel_cpu", HardwareSource.Cpu));
            }

            if (normalized.Contains("amd") && SupportsAmdAv1Encode(normalized))
            {
                candidates.AddRange(MakeCandidates(hardware, "amd_cpu", HardwareSource.Cpu));
            }
        }

        return UniqueCandidates(candidates);
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

        return UniqueCandidates(candidates);
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

    private static IReadOnlyList<string> GetAv1ProbeQualityArgs(string acceleration)
    {
        if (IsNvidiaAcceleration(acceleration))
        {
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
        }

        if (IsIntelAcceleration(acceleration))
        {
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

    private static IReadOnlyList<string> GetEncoderProbeArgs(EncoderCandidate candidate, EncoderProbeKind kind)
    {
        var inputArgs = new[] { "-f", "lavfi", "-i", "testsrc2=size=256x256:rate=1" };
        var suffixArgs = new[] { "-frames:v", "1", "-an", "-f", "null", "-" };

        if (IsNvidiaAcceleration(candidate.Acceleration))
        {
            return inputArgs
                .Concat(new[]
                {
                    "-c:v",
                    kind == EncoderProbeKind.Av1 ? "av1_nvenc" : "h264_nvenc"
                })
                .Concat(kind == EncoderProbeKind.Av1 ? GetAv1ProbeQualityArgs(candidate.Acceleration) : new[] { "-preset", "p2" })
                .Concat(suffixArgs)
                .ToArray();
        }

        if (IsIntelAcceleration(candidate.Acceleration))
        {
            return GetQsvDeviceArgs(candidate)
                .Concat(inputArgs)
                .Concat(new[]
                {
                    "-vf",
                    "format=nv12",
                    "-c:v",
                    kind == EncoderProbeKind.Av1 ? "av1_qsv" : "h264_qsv"
                })
                .Concat(kind == EncoderProbeKind.Av1 ? GetAv1ProbeQualityArgs(candidate.Acceleration) : new[] { "-preset", "veryfast" })
                .Concat(suffixArgs)
                .ToArray();
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return GetVaapiDeviceArgs(candidate)
                .Concat(inputArgs)
                .Concat(new[]
                {
                    "-vf",
                    "format=nv12,hwupload",
                    "-c:v",
                    kind == EncoderProbeKind.Av1 ? "av1_vaapi" : "h264_vaapi"
                })
                .Concat(kind == EncoderProbeKind.Av1 ? GetAv1ProbeQualityArgs(candidate.Acceleration) : Array.Empty<string>())
                .Concat(suffixArgs)
                .ToArray();
        }

        return inputArgs
            .Concat(new[]
            {
                "-c:v",
                kind == EncoderProbeKind.Av1 ? "av1_amf" : "h264_amf"
            })
            .Concat(kind == EncoderProbeKind.Av1 ? GetAv1ProbeQualityArgs(candidate.Acceleration) : Array.Empty<string>())
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
        Av1,
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
    string? Av1ImportAcceleration,
    string? Av1ImportDevice,
    string LiveTranscodeAcceleration,
    string? LiveTranscodeDevice,
    string GpuInfo,
    string CpuInfo);
