using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Launcher;

public class ServerManager
{
    private static readonly TimeSpan DefaultCommandTimeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan InstallCommandTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan HardwareDetectionTimeout = TimeSpan.FromSeconds(8);

    private Process? _serverProcess;
    private IntPtr _serverJobHandle = IntPtr.Zero;
    private readonly object _shutdownLock = new();
    private readonly string _pidFile = Path.Combine(AppContext.BaseDirectory, "server.pid");

    private LogWindow? _logWindow;

    public ObservableCollection<string> ServerLogs { get; } = new();

    public void CleanupOrphans()
    {
        if (!File.Exists(_pidFile))
        {
            return;
        }

        try
        {
            var pidContent = File.ReadAllText(_pidFile);
            if (int.TryParse(pidContent, out var pid))
            {
                using var process = Process.GetProcessById(pid);
                if (IsKnownServerProcess(process))
                {
                    process.Kill(true);
                    Log("Found and killed orphaned server process.");
                }
            }
        }
        catch (ArgumentException)
        {
        }
        catch (Exception ex)
        {
            Log($"Cleanup failed: {ex.Message}");
        }
        finally
        {
            TryDeleteFile(_pidFile);
        }
    }

    public async Task StartServerAsync(AppSettings settings)
    {
        try
        {
            Log("Setting up the server, please wait...");

            await EnsureNodeAsync();
            await EnsureBunAsync(settings);
            await EnsureFfmpegAsync(settings);
            await DetectHardwareAccelerationAsync(settings);

            var webappDir = ResolveWebAppDirectory();

            if (webappDir != String.Empty)
            {
                Log("- - - - - - - - - - - - - - - - - - - -");
                Log("Starting WebApp install process...");
                await RunBunCommandAsync(settings, webappDir, "install");

                Log("- - - - - - - - - - - - - - - - - - - -");
                Log("Starting WebApp building process...");
                await RunBunCommandAsync(settings, webappDir, "run", "build");

                Log("- - - - - - - - - - - - - - - - - - - -");
                Log("Build complete. Starting WebApp...");
                _serverProcess = StartBunServer(settings, webappDir);
                File.WriteAllText(_pidFile, _serverProcess.Id.ToString());

                OpenUrl(settings.BaseUrl);
            } else
            {
                ShowLogsWindow();
                throw new DirectoryNotFoundException("Could not find the webapp directory.");
            }
        }
        catch (Exception ex)
        {
            Log($"[CRITICAL ERROR] {ex.Message}");
        }
    }

    public void StopServer()
    {
        lock (_shutdownLock)
        {
            var process = _serverProcess;
            _serverProcess = null;

            try
            {
                if (process != null)
                {
                    try
                    {
                        StopProcessTree(process);
                    }
                    finally
                    {
                        CloseServerJob();
                        process.Dispose();
                    }
                }
                else
                {
                    CloseServerJob();
                }

                TryDeleteFile(_pidFile);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Failed to stop server: {ex.Message}");
                ShowLogsWindow();
            }
        }
    }

    private async Task EnsureNodeAsync()
    {
        Log("Checking for Node.js installation...");

        var versionOutput = await TryRunProcessAsync("node", new[] { "-v" }, new CommandOptions
        {
            Timeout = TimeSpan.FromSeconds(10)
        });

        if (TryGetNodeMajorVersion(versionOutput?.Output, out var majorVersion) && majorVersion >= 20)
        {
            Log("Node.js found, continuing.");
            return;
        }

        Log("Node.js (>=20) not found. Installing...");
        ShowLogsWindow();

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            await RunProcessAsync("winget", new[]
            {
                "install",
                "OpenJS.NodeJS",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity"
            }, new CommandOptions
            {
                LogOutput = true,
                Timeout = InstallCommandTimeout
            });
        }
        else if (File.Exists("/usr/bin/apt"))
        {
            await RunProcessAsync("sudo", new[] { "apt", "install", "-y", "nodejs", "npm" }, new CommandOptions
            {
                LogOutput = true,
                Timeout = InstallCommandTimeout
            });
        }
        else if (File.Exists("/usr/bin/dnf"))
        {
            await RunProcessAsync("sudo", new[] { "dnf", "install", "-y", "nodejs" }, new CommandOptions
            {
                LogOutput = true,
                Timeout = InstallCommandTimeout
            });
        }
        else if (File.Exists("/usr/bin/pacman"))
        {
            await RunProcessAsync("sudo", new[] { "pacman", "-S", "--noconfirm", "nodejs", "npm" }, new CommandOptions
            {
                LogOutput = true,
                Timeout = InstallCommandTimeout
            });
        }
        else
        {
            throw new InvalidOperationException("Node.js is missing and no supported package manager was found.");
        }

        Log("Node.js installed, continuing.");
    }

    private async Task EnsureBunAsync(AppSettings settings)
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var bunDir = Path.Combine(userProfile, ".bun", "bin");
        var bunExe = Path.Combine(bunDir, RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "bun.exe" : "bun");

        Log("Checking for bun installation...");

        if (!File.Exists(bunExe))
        {
            Log("Bun not found. Installing...");
            ShowLogsWindow();

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                await RunProcessAsync("powershell", new[]
                {
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "irm bun.sh/install.ps1 | iex"
                }, new CommandOptions
                {
                    LogOutput = true,
                    Timeout = InstallCommandTimeout
                });
            }
            else
            {
                await RunShellCommandAsync("curl", "-fsSL https://bun.sh/install | bash", new CommandOptions
                {
                    LogOutput = true,
                    Timeout = InstallCommandTimeout
                });
            }
        }

        Log("Bun found, continuing.");
        settings.BunPath = bunExe;
        settings.Save();
    }

    private async Task EnsureFfmpegAsync(AppSettings settings)
    {
        var ffmpegDir = Path.Combine(AppContext.BaseDirectory, "ffmpeg");
        var executableSuffix = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? ".exe" : "";
        var ffmpegBinary = Path.Combine(ffmpegDir, $"ffmpeg{executableSuffix}");

        Log("Checking for ffmpeg files...");

        if (File.Exists(ffmpegBinary))
        {
            Log("Ffmpeg found, continuing.");
            settings.FfmpegDir = ffmpegDir;
            settings.Save();
            return;
        }

        Log("FFmpeg binaries not found. Downloading...");
        ShowLogsWindow();

        Directory.CreateDirectory(ffmpegDir);

        var archiveExtension = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? ".zip" : ".tar.xz";
        var archivePath = Path.Combine(Path.GetTempPath(), $"ffmpeg_{Guid.NewGuid():N}{archiveExtension}");
        var extractPath = Path.Combine(Path.GetTempPath(), $"ffmpeg_{Guid.NewGuid():N}");
        var url = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
            : "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

        try
        {
            using var client = new HttpClient { Timeout = InstallCommandTimeout };
            using var response = await client.GetAsync(url);
            response.EnsureSuccessStatusCode();

            await using (var fs = new FileStream(archivePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await response.Content.CopyToAsync(fs);
            }

            Directory.CreateDirectory(extractPath);

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                ZipFile.ExtractToDirectory(archivePath, extractPath);
            }
            else
            {
                await RunProcessAsync("tar", new[] { "-xf", archivePath, "-C", extractPath }, new CommandOptions
                {
                    Timeout = DefaultCommandTimeout
                });
            }

            CopyFfmpegBinaries(extractPath, ffmpegDir);

            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                foreach (var file in Directory.GetFiles(ffmpegDir))
                {
                    await RunProcessAsync("chmod", new[] { "+x", file }, new CommandOptions
                    {
                        Timeout = TimeSpan.FromSeconds(10)
                    });
                }
            }
        }
        finally
        {
            TryDeleteFile(archivePath);
            TryDeleteDirectory(extractPath);
        }

        settings.FfmpegDir = ffmpegDir;
        settings.Save();
        Log("FFmpeg installed, continuing...");
    }

    private async Task DetectHardwareAccelerationAsync(AppSettings settings)
    {
        Log("Detecting hardware acceleration type...");

        var hardware = new HardwareDetectionInfo("", "");

        try
        {
            hardware = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? await DetectWindowsHardwareAsync()
                : await DetectUnixHardwareAsync();
        }
        catch (Exception ex)
        {
            Log($"Hardware detection failed: {ex.Message}");
        }

        var gpuInfo = hardware.GpuInfo.ToLowerInvariant();
        var cpuInfo = hardware.CpuInfo.ToLowerInvariant();

        if (HasNvidiaGpu(gpuInfo))
        {
            Log("Found Nvidia GPU, using nvenc.");
            settings.TranscodeAccel = "nvenc";
        }
        else if (HasIntelHardware(gpuInfo))
        {
            Log("Found Intel GPU, using qsv.");
            settings.TranscodeAccel = "qsv";
        }
        else if (HasAmdGpu(gpuInfo))
        {
            Log("Found AMD GPU, using amd.");
            settings.TranscodeAccel = "amd";
        }
        else if (HasIntelHardware(cpuInfo))
        {
            Log("Found Intel CPU, using qsv.");
            settings.TranscodeAccel = "qsv";
        }
        else
        {
            Log("No supported hardware acceleration detected, using CPU fallback.");
            settings.TranscodeAccel = "cpu";
        }

        settings.Save();
    }

    private async Task RunBunCommandAsync(AppSettings settings, string workingDirectory, params string[] arguments)
    {
        await RunProcessAsync(settings.BunPath, arguments, new CommandOptions
        {
            Environment = CreateServerEnvironment(settings),
            LogOutput = true,
            Timeout = DefaultCommandTimeout,
            WorkingDirectory = workingDirectory
        });
    }

    private Process StartBunServer(AppSettings settings, string workingDirectory)
    {
        return StartBackgroundProcess(settings.BunPath, new[] { "run", "start" }, new CommandOptions
        {
            Environment = CreateServerEnvironment(settings),
            LogOutput = true,
            WorkingDirectory = workingDirectory
        });
    }

    private async Task<CommandResult> RunShellCommandAsync(string fileName, string args, CommandOptions? options = null)
    {
        var command = string.IsNullOrWhiteSpace(args)
            ? QuoteShellPart(fileName)
            : $"{QuoteShellPart(fileName)} {args}";

        return await RunProcessAsync(GetShellFileName(), GetShellArguments(command), options);
    }

    private async Task<CommandResult?> TryRunProcessAsync(string fileName, IReadOnlyList<string> arguments, CommandOptions? options = null)
    {
        try
        {
            return await RunProcessAsync(fileName, arguments, options);
        }
        catch (Win32Exception)
        {
            return null;
        }
        catch (TimeoutException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    private async Task<CommandResult> RunProcessAsync(string fileName, IReadOnlyList<string> arguments, CommandOptions? options = null)
    {
        options ??= new CommandOptions();

        using var process = CreateProcess(fileName, arguments, options);
        var output = new StringBuilder();
        var error = new StringBuilder();

        process.OutputDataReceived += (_, e) => AppendProcessLine(output, e.Data, options.LogOutput);
        process.ErrorDataReceived += (_, e) => AppendProcessLine(error, e.Data, options.LogErrors);

        if (!process.Start())
        {
            ShowLogsWindow();
            throw new InvalidOperationException($"Failed to start command: {fileName}");
        }

        AssignProcessToServerJob(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        await WaitForExitAsync(process, options.Timeout ?? DefaultCommandTimeout);

        var result = new CommandResult(process.ExitCode, output.ToString(), error.ToString());
        if (options.ThrowOnError && result.ExitCode != 0)
        {
            ShowLogsWindow();
            throw new InvalidOperationException($"Command failed ({fileName}) with exit code {result.ExitCode}: {result.Error.Trim()}");
        }

        return result;
    }

    private Process StartBackgroundProcess(string fileName, IReadOnlyList<string> arguments, CommandOptions options)
    {
        var process = CreateProcess(fileName, arguments, options);

        process.OutputDataReceived += (_, e) => AppendProcessLine(null, e.Data, true);
        process.ErrorDataReceived += (_, e) => AppendProcessLine(null, e.Data, true);
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => Log($"Server process exited with code {process.ExitCode}.");

        if (!process.Start())
        {
            ShowLogsWindow();
            throw new InvalidOperationException($"Failed to start command: {fileName}");
        }

        AssignProcessToServerJob(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return process;
    }

    private async void StopProcessTree(Process process)
    {
        try
        {
            if (process.HasExited)
            {
                return;
            }

            Log("Requesting graceful shutdown...");

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                using var taskKill = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {process.Id} /T",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
#pragma warning disable CS8602 // Dereference of a possibly null reference.
                await taskKill?.WaitForExitAsync();
#pragma warning restore CS8602 // Dereference of a possibly null reference.
            }
            else
            {
                using var killProcess = Process.Start(new ProcessStartInfo
                {
                    FileName = "kill",
                    Arguments = $"-SIGINT {process.Id}",
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
#pragma warning disable CS8602 // Dereference of a possibly null reference.
                await killProcess?.WaitForExitAsync();
#pragma warning restore CS8602 // Dereference of a possibly null reference.
            }

            if (process.WaitForExit(30000))
            {
                Log("Server process stopped gracefully.");
                return;
            }

            Log("Process did not exit gracefully, forcing hard kill...");
            process.Kill(true);

            if (process.WaitForExit(5000))
            {
                Log("Server process force stopped.");
                return;
            }

            Log("Server process did not exit after hard kill request.");
        }
        catch (InvalidOperationException)
        {
            // The process already exited before we could interact with it
        }
        catch (Exception ex)
        {
            Log($"Server process stop failed: {ex.Message}");
        }
    }

    private void AssignProcessToServerJob(Process process)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        try
        {
            EnsureServerJob();

            if (_serverJobHandle != IntPtr.Zero && !AssignProcessToJobObject(_serverJobHandle, process.Handle))
            {
                Log($"Failed to bind server process cleanup: {new Win32Exception(Marshal.GetLastWin32Error()).Message}");
            }
        }
        catch (Exception ex)
        {
            Log($"Failed to prepare server process cleanup: {ex.Message}");
        }
    }

    private void EnsureServerJob()
    {
        if (_serverJobHandle != IntPtr.Zero)
        {
            return;
        }

        var jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var info = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitFlags.KillOnJobClose
            }
        };

        var length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        var infoPointer = Marshal.AllocHGlobal(length);

        try
        {
            Marshal.StructureToPtr(info, infoPointer, false);
            if (!SetInformationJobObject(jobHandle, JobObjectInfoClass.ExtendedLimitInformation, infoPointer, (uint)length))
            {
                var error = Marshal.GetLastWin32Error();
                CloseHandle(jobHandle);
                throw new Win32Exception(error);
            }

            _serverJobHandle = jobHandle;
        }
        finally
        {
            Marshal.FreeHGlobal(infoPointer);
        }
    }

    private void CloseServerJob()
    {
        if (_serverJobHandle == IntPtr.Zero)
        {
            return;
        }

        CloseHandle(_serverJobHandle);
        _serverJobHandle = IntPtr.Zero;
    }

    private Process CreateProcess(string fileName, IReadOnlyList<string> arguments, CommandOptions options)
    {
        var info = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = string.IsNullOrWhiteSpace(options.WorkingDirectory) ? Environment.CurrentDirectory : options.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true
        };

        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        if (options.Environment != null)
        {
            foreach (var variable in options.Environment)
            {
                info.Environment[variable.Key] = variable.Value ?? "";
            }
        }

        return new Process { StartInfo = info };
    }

    private async Task WaitForExitAsync(Process process, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);

        try
        {
            await process.WaitForExitAsync(cancellation.Token);
            process.WaitForExit();
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw new TimeoutException($"Command timed out after {timeout.TotalSeconds:N0} seconds.");
        }
    }

    private void AppendProcessLine(StringBuilder? target, string? line, bool logLine)
    {
        if (line == null)
        {
            return;
        }

        target?.AppendLine(line);

        if (logLine)
        {
            Log(line);
        }
    }

    private async Task<HardwareDetectionInfo> DetectWindowsHardwareAsync()
    {
        var gpuInfo = ReadWindowsGpuNamesFromRegistry();
        var cpuInfo = ReadWindowsCpuNameFromRegistry();

        if (string.IsNullOrWhiteSpace(gpuInfo))
        {
            gpuInfo = await RunPowerShellOutputAsync("Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name");
        }

        if (string.IsNullOrWhiteSpace(cpuInfo))
        {
            cpuInfo = await RunPowerShellOutputAsync("Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name");
        }

        return new HardwareDetectionInfo(gpuInfo, cpuInfo);
    }

    private async Task<HardwareDetectionInfo> DetectUnixHardwareAsync()
    {
        var gpuResult = await TryRunProcessAsync("lspci", Array.Empty<string>(), new CommandOptions
        {
            LogErrors = false,
            Timeout = HardwareDetectionTimeout
        });

        var cpuInfo = ReadUnixCpuInfo();
        if (string.IsNullOrWhiteSpace(cpuInfo) && RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            var cpuResult = await TryRunProcessAsync("sysctl", new[] { "-n", "machdep.cpu.brand_string" }, new CommandOptions
            {
                LogErrors = false,
                Timeout = HardwareDetectionTimeout
            });

            cpuInfo = cpuResult?.Output ?? "";
        }

        return new HardwareDetectionInfo(gpuResult?.Output ?? "", cpuInfo);
    }

    private async Task<string> RunPowerShellOutputAsync(string command)
    {
        var result = await TryRunProcessAsync("powershell", new[]
        {
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command
        }, new CommandOptions
        {
            LogErrors = false,
            Timeout = HardwareDetectionTimeout
        });

        return result?.Output ?? "";
    }

    private string ReadWindowsGpuNamesFromRegistry()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return "";
        }

        try
        {
            using var videoKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Video");
            if (videoKey == null)
            {
                return "";
            }

            var names = new List<string>();
            foreach (var adapterId in videoKey.GetSubKeyNames())
            {
                using var adapterKey = videoKey.OpenSubKey(Path.Combine(adapterId, "0000"));
                var driverDescription = adapterKey?.GetValue("DriverDesc") as string;
                if (!string.IsNullOrWhiteSpace(driverDescription))
                {
                    names.Add(driverDescription);
                }
            }

            return string.Join(Environment.NewLine, names.Distinct(StringComparer.OrdinalIgnoreCase));
        }
        catch
        {
            return "";
        }
    }

    private string ReadWindowsCpuNameFromRegistry()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return "";
        }

        try
        {
            using var processorKey = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            return processorKey?.GetValue("ProcessorNameString") as string ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string ReadUnixCpuInfo()
    {
        try
        {
            return File.Exists("/proc/cpuinfo") ? File.ReadAllText("/proc/cpuinfo") : "";
        }
        catch
        {
            return "";
        }
    }

    private static bool HasNvidiaGpu(string gpuInfo)
    {
        return ContainsAny(gpuInfo, "nvidia", "geforce", "quadro");
    }

    private static bool HasAmdGpu(string gpuInfo)
    {
        return ContainsAny(gpuInfo, "amd", "radeon", "advanced micro devices", "ati technologies", "firepro");
    }

    private static bool HasIntelHardware(string hardwareInfo)
    {
        return ContainsAny(hardwareInfo, "intel", "iris", "uhd graphics");
    }

    private static bool ContainsAny(string value, params string[] tokens)
    {
        return tokens.Any(value.Contains);
    }

    private static bool TryGetNodeMajorVersion(string? output, out int version)
    {
        version = 0;

        if (string.IsNullOrWhiteSpace(output))
        {
            return false;
        }

        var normalized = output.Trim().TrimStart('v');
        var separatorIndex = normalized.IndexOf('.');
        var major = separatorIndex >= 0 ? normalized[..separatorIndex] : normalized;

        return int.TryParse(major, out version);
    }

    private static Dictionary<string, string> CreateServerEnvironment(AppSettings settings)
    {
        return new Dictionary<string, string>
        {
            ["BASE_URL"] = settings.BaseUrl,
            ["ANIME_INPUT_DIR"] = settings.InputFolderPath,
            ["ANIME_MEDIA_DIR"] = settings.OutputFolderPath,
            ["FFMPEG_DIR"] = settings.FfmpegDir,
            ["TRANSCODE_ACCEL"] = settings.TranscodeAccel,
            ["ANILIST_CLIENT_ID"] = settings.AnilistClientId,
            ["ANILIST_CLIENT_SECRET"] = settings.AnilistClientSecret
        };
    }

    private string ResolveWebAppDirectory()
    {
        var webappPath = Path.Combine(Environment.CurrentDirectory, "webapp");
        if (File.Exists(Path.Combine(webappPath, "package.json")))
        {
            return webappPath;
        }
        else
        {
            return String.Empty;
        }
    }

    private static void CopyFfmpegBinaries(string extractPath, string ffmpegDir)
    {
        foreach (var binDirectory in Directory.GetDirectories(extractPath, "bin", SearchOption.AllDirectories))
        {
            foreach (var file in Directory.GetFiles(binDirectory))
            {
                File.Copy(file, Path.Combine(ffmpegDir, Path.GetFileName(file)), true);
            }
        }
    }

    private static string GetShellFileName()
    {
        return RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "cmd.exe" : "sh";
    }

    private static IReadOnlyList<string> GetShellArguments(string command)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new[] { "/d", "/s", "/c", command };
        }

        return new[] { "-c", command };
    }

    private static string QuoteShellPart(string value)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return value.Contains(' ') ? $"\"{value.Replace("\"", "\\\"")}\"" : value;
        }

        return $"'{value.Replace("'", "'\\''")}'";
    }

    private static bool IsKnownServerProcess(Process process)
    {
        try
        {
            var processName = process.ProcessName;
            return processName.Contains("bun", StringComparison.OrdinalIgnoreCase)
                || processName.Contains("node", StringComparison.OrdinalIgnoreCase)
                || processName.Contains("cmd", StringComparison.OrdinalIgnoreCase)
                || processName.Contains("sh", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
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

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, true);
            }
        }
        catch
        {
        }
    }

    private void Log(string message)
    {
        try
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => ServerLogs.Add($"[{DateTime.Now:HH:mm:ss}] {message}"));
        }
        catch
        {
        }
    }

    private void ShowLogsWindow()
    {
        if (_logWindow == null || !_logWindow.IsVisible)
        {
            _logWindow = new LogWindow(ServerLogs);
            _logWindow.Show();
        }
        else
        {
            _logWindow.Activate();
        }
    }

    private sealed class CommandOptions
    {
        public string? WorkingDirectory { get; init; }
        public IReadOnlyDictionary<string, string>? Environment { get; init; }
        public TimeSpan? Timeout { get; init; }
        public bool LogOutput { get; init; }
        public bool LogErrors { get; init; } = true;
        public bool ThrowOnError { get; init; } = true;
    }

    private sealed record CommandResult(int ExitCode, string Output, string Error);

    private sealed record HardwareDetectionInfo(string GpuInfo, string CpuInfo);

    [Flags]
    private enum JobObjectLimitFlags : uint
    {
        KillOnJobClose = 0x2000
    }

    private enum JobObjectInfoClass
    {
        ExtendedLimitInformation = 9
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public JobObjectLimitFlags LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr jobHandle, JobObjectInfoClass infoClass, IntPtr jobObjectInfo, uint jobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr jobHandle, IntPtr processHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void OpenUrl(string url)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            Process.Start("xdg-open", url);
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            Process.Start("open", url);
        }
    }
}
