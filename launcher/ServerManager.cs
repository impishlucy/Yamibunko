using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Launcher;

public class ServerManager
{
    private static readonly TimeSpan DefaultCommandTimeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan InstallCommandTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan CrashShutdownDelay = TimeSpan.FromSeconds(30);
    private Process? _serverProcess;
    private Process? _activeManagedProcess;
    private Task? _stopServerTask;
    private IntPtr _serverJobHandle = IntPtr.Zero;
    private readonly object _shutdownLock = new();
    private readonly object _logCleanupLock = new();
    private readonly string _pidFile = Path.Combine(AppContext.BaseDirectory, "server.pid");
    private Timer? _dailyLogCleanupTimer;
    private TimeSpan _dailyLogCleanupTime;

    public ObservableCollection<string> ServerLogs { get; } = new();

    public event Action? LogsWindowRequested;
    public event Action? ServerStopStateChanged;
    public event Action<TimeSpan>? ServerCrashShutdownRequested;

    public bool IsStoppingServer
    {
        get
        {
            lock (_shutdownLock)
            {
                return _stopServerTask != null;
            }
        }
    }

    public bool CanStopServer
    {
        get
        {
            lock (_shutdownLock)
            {
                return _stopServerTask == null;
            }
        }
    }

    public bool CanOpenInBrowser
    {
        get
        {
            lock (_shutdownLock)
            {
                return _stopServerTask == null && _serverProcess != null && !HasProcessExited(_serverProcess);
            }
        }
    }

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

    public void StartDailyLogCleanup(TimeSpan cleanupTime)
    {
        lock (_logCleanupLock)
        {
            _dailyLogCleanupTime = cleanupTime;
            _dailyLogCleanupTimer?.Dispose();
            _dailyLogCleanupTimer = new Timer(OnDailyLogCleanupTimerElapsed);
            ScheduleNextDailyLogCleanup();
        }
    }

    public void StopDailyLogCleanup()
    {
        lock (_logCleanupLock)
        {
            _dailyLogCleanupTimer?.Dispose();
            _dailyLogCleanupTimer = null;
        }
    }

    private void OnDailyLogCleanupTimerElapsed(object? state)
    {
        ClearLogs();

        lock (_logCleanupLock)
        {
            if (_dailyLogCleanupTimer != null)
            {
                ScheduleNextDailyLogCleanup();
            }
        }
    }

    private void ScheduleNextDailyLogCleanup()
    {
        var now = DateTime.Now;
        var nextRun = now.Date.Add(_dailyLogCleanupTime);

        if (nextRun <= now)
        {
            nextRun = nextRun.AddDays(1);
        }

        var dueTime = nextRun - now;
        _dailyLogCleanupTimer?.Change(dueTime, Timeout.InfiniteTimeSpan);
    }

    private void ClearLogs()
    {
        try
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(ServerLogs.Clear);
        }
        catch
        {
        }
    }

    public async Task StartServerAsync(AppSettings settings)
    {
        if (!await EnsureValidStartupSettingsAsync(settings))
        {
            return;
        }

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
                DeleteNextBuildDirectory(webappDir);
                await RunBunCommandAsync(settings, webappDir, "run", "build");

                Log("- - - - - - - - - - - - - - - - - - - -");
                Log("Build complete. Starting WebApp...");
                _serverProcess = StartBunServer(settings, webappDir);
                File.WriteAllText(_pidFile, _serverProcess.Id.ToString());
                NotifyServerStopStateChanged();
            } else
            {
                ShowLogsWindow();
                throw new DirectoryNotFoundException("Could not find the webapp directory.");
            }
        }
        catch (Exception ex)
        {
            Log($"[CRITICAL ERROR] {ex.Message}");
            ShowLogsWindow();
        }
    }

    private async Task<bool> EnsureValidStartupSettingsAsync(AppSettings settings)
    {
        if (settings.IsValidForStartup(out var validationErrors))
        {
            return true;
        }

        Log("Launcher setup is incomplete. Opening setup window.");
        foreach (var validationError in validationErrors)
        {
            Log(validationError);
        }

        await OpenSetupWindowAsync(settings);
        return false;
    }

    private async Task OpenSetupWindowAsync(AppSettings settings)
    {
        await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(() =>
        {
            var setupWindow = new SetupWindow(settings);
            setupWindow.OnSetupComplete += async newSettings =>
            {
                setupWindow.Close();
                await StartServerAsync(newSettings);
            };

            if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            {
                desktop.MainWindow = setupWindow;
            }

            setupWindow.Show();
            setupWindow.Activate();
        });
    }

    public void StopServer()
    {
        StopServerAsync().GetAwaiter().GetResult();
    }

    public Task StopServerAsync()
    {
        Task stopTask;
        var createdTask = false;

        lock (_shutdownLock)
        {
            if (_stopServerTask == null)
            {
                var processToStop = _activeManagedProcess ?? _serverProcess;
                _stopServerTask = Task.Run(async () => await StopServerCoreAsync(processToStop).ConfigureAwait(false));
                createdTask = true;
            }

            stopTask = _stopServerTask;
        }

        if (createdTask)
        {
            NotifyServerStopStateChanged();
        }

        return stopTask;
    }

    private async Task StopServerCoreAsync(Process? process)
    {
        var disposeStoppedProcess = false;

        try
        {
            if (process != null)
            {
                var isServerProcess = IsServerProcess(process);
                await StopProcessTreeAsync(process, isServerProcess).ConfigureAwait(false);
            }
            else
            {
                CloseServerJob();
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Failed to stop server: {ex.Message}");
            Log($"Server shutdown failed: {ex.Message}");
            ShowLogsWindow();
        }
        finally
        {
            lock (_shutdownLock)
            {
                if (ReferenceEquals(_serverProcess, process))
                {
                    _serverProcess = null;
                    disposeStoppedProcess = true;
                }

                if (ReferenceEquals(_activeManagedProcess, process))
                {
                    _activeManagedProcess = null;
                }

                _stopServerTask = null;
            }

            if (disposeStoppedProcess)
            {
                process?.Dispose();
            }

            CloseServerJob();
            TryDeleteFile(_pidFile);
            NotifyServerStopStateChanged();
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
        var previousAcceleration = settings.TranscodeAccel;
        var hadOutdatedAcceleration = AppSettings.TryGetOutdatedTranscodeAccelReplacement(
            previousAcceleration,
            out var outdatedReplacement);

        Log(hadOutdatedAcceleration
            ? $"Outdated TRANSCODE_ACCEL value '{previousAcceleration}' was found in settings.json. Running hardware check and updating it."
            : "Detecting hardware acceleration type...");

        var detection = await HardwareAccelerationDetector.DetectAsync(settings.FfmpegDir, true);

        if (settings.ImportEnabled && !HardwareAccelerationDetector.SupportsAv1ImportAcceleration(detection))
        {
            Log(HardwareAccelerationDetector.Av1HardwareUnsupportedMessage);
            Log("Catalog mode was enabled automatically because AV1 hardware encoding is unavailable.");
            settings.ImportEnabled = false;
        }

        settings.TranscodeAccel = HardwareAccelerationDetector.SelectServerTranscodeAcceleration(detection, settings.ImportEnabled);

        var selectedAccelerationLabel = HardwareAccelerationDetector.FormatAccelerationForDisplay(settings.TranscodeAccel);
        var av1ImportAccelerationLabel = HardwareAccelerationDetector.FormatAccelerationForDisplay(detection.Av1ImportAcceleration);
        var liveTranscodeAccelerationLabel = HardwareAccelerationDetector.FormatAccelerationForDisplay(detection.LiveTranscodeAcceleration);

        if (hadOutdatedAcceleration)
        {
            Log($"Updated TRANSCODE_ACCEL from outdated value '{previousAcceleration}' to '{selectedAccelerationLabel}'. Suggested replacement for the old value was '{outdatedReplacement}'.");
        }

        Log(!HardwareAccelerationDetector.SupportsAv1ImportAcceleration(detection)
            ? $"AV1 hardware encoding unavailable. Live transcoding acceleration: {selectedAccelerationLabel}."
            : $"AV1 hardware encoding acceleration: {av1ImportAccelerationLabel}. Live transcoding acceleration: {liveTranscodeAccelerationLabel}.");

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

    private void DeleteNextBuildDirectory(string webappDir)
    {
        var nextDir = Path.Combine(webappDir, ".next");
        if (!Directory.Exists(nextDir))
        {
            return;
        }

        Log("Cleaning old WebApp build output...");

        try
        {
            Directory.Delete(nextDir, true);
        }
        catch (Exception ex)
        {
            ShowLogsWindow();
            throw new IOException($"Could not delete old WebApp build output: {ex.Message}", ex);
        }
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
            return await RunProcessAsync(fileName, arguments, WithoutProcessErrorWindow(options));
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

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException($"Failed to start command: {fileName}");
            }
        }
        catch
        {
            ShowProcessErrorWindow(options);
            throw;
        }

        MarkActiveProcess(process);
        AssignProcessToServerJob(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        try
        {
            await WaitForExitAsync(process, options.Timeout ?? DefaultCommandTimeout);
        }
        catch
        {
            ShowProcessErrorWindow(options);
            throw;
        }
        finally
        {
            ClearActiveProcess(process);
        }

        var result = new CommandResult(process.ExitCode, output.ToString(), error.ToString());
        if (options.ThrowOnError && result.ExitCode != 0)
        {
            ShowProcessErrorWindow(options);
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
        process.Exited += (_, _) => OnServerProcessExited(process);

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException($"Failed to start command: {fileName}");
            }
        }
        catch
        {
            ShowProcessErrorWindow(options);
            throw;
        }

        MarkActiveProcess(process);
        AssignProcessToServerJob(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return process;
    }

    private void OnServerProcessExited(Process process)
    {
        var exitCode = 0;

        try
        {
            exitCode = process.ExitCode;
        }
        catch (InvalidOperationException)
        {
        }

        var isStopping = IsStoppingServer;
        var isTrackedServer = false;

        lock (_shutdownLock)
        {
            if (ReferenceEquals(_activeManagedProcess, process))
            {
                _activeManagedProcess = null;
            }

            if (!isStopping && ReferenceEquals(_serverProcess, process))
            {
                _serverProcess = null;
                isTrackedServer = true;
            }
        }

        if (isTrackedServer)
        {
            CloseServerJob();
            TryDeleteFile(_pidFile);
            process.Dispose();
        }

        NotifyServerStopStateChanged();
        Log($"Server process exited with code {exitCode}.");

        if (!isTrackedServer)
        {
            return;
        }

        Log($"Server process exited unexpectedly. Launcher will close automatically in {CrashShutdownDelay.TotalSeconds:N0} seconds.");
        ShowLogsWindow();
        ServerCrashShutdownRequested?.Invoke(CrashShutdownDelay);
    }

    private void MarkActiveProcess(Process process)
    {
        lock (_shutdownLock)
        {
            _activeManagedProcess = process;
        }

        NotifyServerStopStateChanged();
    }

    private void ClearActiveProcess(Process process)
    {
        var cleared = false;

        lock (_shutdownLock)
        {
            if (ReferenceEquals(_activeManagedProcess, process))
            {
                _activeManagedProcess = null;
                cleared = true;
            }
        }

        if (cleared)
        {
            NotifyServerStopStateChanged();
        }
    }

    private bool IsServerProcess(Process process)
    {
        lock (_shutdownLock)
        {
            return ReferenceEquals(_serverProcess, process);
        }
    }

    private static CommandOptions WithoutProcessErrorWindow(CommandOptions? options)
    {
        options ??= new CommandOptions();

        return new CommandOptions
        {
            WorkingDirectory = options.WorkingDirectory,
            Environment = options.Environment,
            Timeout = options.Timeout,
            LogOutput = options.LogOutput,
            LogErrors = options.LogErrors,
            ThrowOnError = options.ThrowOnError,
            ShowLogsOnError = false
        };
    }

    private void ShowProcessErrorWindow(CommandOptions options)
    {
        if (options.ShowLogsOnError)
        {
            ShowLogsWindow();
        }
    }

    private async Task StopProcessTreeAsync(Process process, bool waitForServerShutdown)
    {
        try
        {
            if (process.HasExited)
            {
                Log("Server process already stopped.");
                return;
            }

            Log("Requesting graceful shutdown...");
            await RequestGracefulShutdownAsync(process).ConfigureAwait(false);

            if (waitForServerShutdown)
            {
                Log("Waiting for the server to finish active work...");
                await process.WaitForExitAsync().ConfigureAwait(false);
                Log("Server process stopped gracefully.");
            }
            else
            {
                Log("Waiting for the active startup command to stop...");
                await WaitForExitOrKillAsync(process, TimeSpan.FromSeconds(10)).ConfigureAwait(false);
                Log("Startup command stopped.");
            }
        }
        catch (InvalidOperationException)
        {
            Log("Server process already stopped.");
        }
        catch (Exception ex)
        {
            Log($"Server process stop failed: {ex.Message}");
        }
    }

    private async Task RequestGracefulShutdownAsync(Process process)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            if (TrySendWindowsCtrlC(process))
            {
                return;
            }

            await RunSignalCommandAsync("taskkill", $"/PID {process.Id} /T").ConfigureAwait(false);
            return;
        }

        await RunSignalCommandAsync("kill", $"-SIGINT {process.Id}").ConfigureAwait(false);
    }

    private async Task RunSignalCommandAsync(string fileName, string arguments)
    {
        using var signalProcess = Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            CreateNoWindow = true,
            UseShellExecute = false
        });

        if (signalProcess != null)
        {
            await signalProcess.WaitForExitAsync().ConfigureAwait(false);
        }
    }

    private bool TrySendWindowsCtrlC(Process process)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return false;
        }

        try
        {
            if (!AttachConsole((uint)process.Id))
            {
                return false;
            }

            SetConsoleCtrlHandler(null, true);
            var sent = GenerateConsoleCtrlEvent(CtrlCEvent, 0);
            Thread.Sleep(250);
            FreeConsole();
            SetConsoleCtrlHandler(null, false);

            return sent;
        }
        catch
        {
            try
            {
                FreeConsole();
                SetConsoleCtrlHandler(null, false);
            }
            catch
            {
            }

            return false;
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
            await process.WaitForExitAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw new TimeoutException($"Command timed out after {timeout.TotalSeconds:N0} seconds.");
        }
    }

    private static async Task WaitForExitOrKillAsync(Process process, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);

        try
        {
            await process.WaitForExitAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            await process.WaitForExitAsync().ConfigureAwait(false);
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
            ["IMPORT_ENABLED"] = settings.ImportEnabled ? "true" : "false",
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

    public void ShowLogsWindow()
    {
        try
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => LogsWindowRequested?.Invoke());
        }
        catch
        {
        }
    }

    private void NotifyServerStopStateChanged()
    {
        try
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => ServerStopStateChanged?.Invoke());
        }
        catch
        {
        }
    }

    private static bool HasProcessExited(Process process)
    {
        try
        {
            return process.HasExited;
        }
        catch (InvalidOperationException)
        {
            return true;
        }
        catch (Win32Exception)
        {
            return true;
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
        public bool ShowLogsOnError { get; init; } = true;
    }

    private sealed record CommandResult(int ExitCode, string Output, string Error);


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

    private const uint CtrlCEvent = 0;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate? handlerRoutine, bool add);

    private delegate bool ConsoleCtrlDelegate(uint ctrlType);

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
