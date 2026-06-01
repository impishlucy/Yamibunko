using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
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
    private readonly string _pidFile = Path.Combine(AppContext.BaseDirectory, "server.pid");

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
        }
        catch (Exception ex)
        {
            Log($"[CRITICAL ERROR] {ex.Message}");
        }
    }

    public void StopServer()
    {
        try
        {
            if (_serverProcess != null)
            {
                if (!_serverProcess.HasExited)
                {
                    _serverProcess.Kill(true);
                    Log("Server process killed.");
                }

                _serverProcess.Dispose();
                _serverProcess = null;
            }

            if (File.Exists(_pidFile))
            {
                File.Delete(_pidFile);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Failed to stop server: {ex.Message}");
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

        var dump = "";

        try
        {
            dump = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? await DetectWindowsGpuAsync()
                : await DetectUnixGpuAsync();
        }
        catch (Exception ex)
        {
            Log($"Hardware detection failed: {ex.Message}");
        }

        var normalized = dump.ToLowerInvariant();

        if (normalized.Contains("nvidia"))
        {
            Log("Found Nvidia GPU, using nvenc.");
            settings.TranscodeAccel = "nvenc";
        }
        else if (normalized.Contains("intel"))
        {
            Log("Found Intel GPU/CPU, using qsv.");
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
            throw new InvalidOperationException($"Failed to start command: {fileName}");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        await WaitForExitAsync(process, options.Timeout ?? DefaultCommandTimeout);

        var result = new CommandResult(process.ExitCode, output.ToString(), error.ToString());
        if (options.ThrowOnError && result.ExitCode != 0)
        {
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
            throw new InvalidOperationException($"Failed to start command: {fileName}");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return process;
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

    private async Task<string> DetectWindowsGpuAsync()
    {
        var registryDump = ReadWindowsGpuNamesFromRegistry();
        if (!string.IsNullOrWhiteSpace(registryDump))
        {
            return registryDump;
        }

        var result = await TryRunProcessAsync("powershell", new[]
        {
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
        }, new CommandOptions
        {
            Timeout = HardwareDetectionTimeout
        });

        return result?.Output ?? "";
    }

    private async Task<string> DetectUnixGpuAsync()
    {
        var result = await TryRunProcessAsync("lspci", Array.Empty<string>(), new CommandOptions
        {
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

    private static string ResolveWebAppDirectory()
    {
        var candidates = new[]
        {
            Environment.CurrentDirectory,
            AppContext.BaseDirectory
        };

        foreach (var candidate in candidates)
        {
            var directory = new DirectoryInfo(candidate);
            while (directory != null)
            {
                var webappPath = Path.Combine(directory.FullName, "webapp");
                if (File.Exists(Path.Combine(webappPath, "package.json")))
                {
                    return webappPath;
                }

                directory = directory.Parent;
            }
        }

        throw new DirectoryNotFoundException("Could not find the webapp directory.");
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
        Avalonia.Threading.Dispatcher.UIThread.Post(() => ServerLogs.Add($"[{DateTime.Now:HH:mm:ss}] {message}"));
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
}
