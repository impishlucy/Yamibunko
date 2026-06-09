using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using System;
using System.Threading.Tasks;

namespace Launcher;

public partial class App : Application
{
    public static ServerManager ServerManager { get; } = new();

    private LogWindow? _logWindow;
    private SetupWindow? _setupWindow;
    private NativeMenuItem? _openInBrowserTrayMenuItem;
    private NativeMenuItem? _openSettingsTrayMenuItem;
    private NativeMenuItem? _stopServerTrayMenuItem;
    private bool _shutdownRequested;
    private bool _shutdownCompleted;
    private bool _crashShutdownScheduled;
    private bool _isOpeningSettings;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public App()
    {
        AppDomain.CurrentDomain.ProcessExit += (s, e) => ServerManager.StopServer();
        AppDomain.CurrentDomain.DomainUnload += (s, e) => ServerManager.StopServer();
        AppDomain.CurrentDomain.UnhandledException += (s, e) => ServerManager.StopServer();
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            ServerManager.StopServer();
        };
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.ShutdownMode = Avalonia.Controls.ShutdownMode.OnExplicitShutdown;
            desktop.ShutdownRequested += OnShutdownRequested;
            desktop.Exit += (s, e) =>
            {
                ServerManager.StopDailyLogCleanup();
                ServerManager.StopServer();
                SingleInstanceManager.Shutdown();
            };

            _openInBrowserTrayMenuItem = FindTrayMenuItem("Open in Browser");
            _openSettingsTrayMenuItem = FindTrayMenuItem("Open Settings");
            _stopServerTrayMenuItem = FindTrayMenuItem("Stop Server & Exit");
            ServerManager.LogsWindowRequested += ShowLogsWindow;
            ServerManager.ServerStopStateChanged += OnServerStopStateChanged;
            ServerManager.ServerCrashShutdownRequested += OnServerCrashShutdownRequested;
            ServerManager.StartDailyLogCleanup(new TimeSpan(3, 0, 0));
            SingleInstanceManager.StartListening(ShowLogsWindow);
            UpdateStopServerControls();

            ServerManager.CleanupOrphans();

            var settings = AppSettings.Load();
            if (settings == null)
            {
                var setupWindow = CreateSetupWindow(null);
                _setupWindow = setupWindow;
                setupWindow.Closed += (_, _) =>
                {
                    if (ReferenceEquals(_setupWindow, setupWindow))
                    {
                        _setupWindow = null;
                        UpdateStopServerControls();
                    }
                };
                desktop.MainWindow = setupWindow;
                setupWindow.Show();
                UpdateStopServerControls();
            }
            else
            {
                _ = ServerManager.StartServerAsync(settings);
            }
        }
        base.OnFrameworkInitializationCompleted();
    }

    private void OnShowLogsClicked(object? sender, EventArgs e)
    {
        ShowLogsWindow();
    }

    private void ShowLogsWindow()
    {
        if (!Dispatcher.UIThread.CheckAccess())
        {
            Dispatcher.UIThread.Post(ShowLogsWindow);
            return;
        }

        if (_logWindow == null || !_logWindow.IsVisible)
        {
            _logWindow = new LogWindow(ServerManager.ServerLogs, StopServerAndShutdownAsync, OpenInBrowser);
            _logWindow.Closed += (_, _) => _logWindow = null;
            _logWindow.Show();
        }

        UpdateStopServerControls();

        if (_logWindow.WindowState == WindowState.Minimized)
        {
            _logWindow.WindowState = WindowState.Normal;
        }

        _logWindow.Activate();
        _logWindow.Focus();
    }

    private void OnOpenBrowserClicked(object? sender, EventArgs e)
    {
        OpenInBrowser();
    }

    private async void OnOpenSettingsClicked(object? sender, EventArgs e)
    {
        await StopServerAndOpenSettingsAsync();
    }

    private void OpenInBrowser()
    {
        if (_shutdownRequested || !ServerManager.CanOpenInBrowser)
        {
            return;
        }

        var settings = AppSettings.Load();
        if (settings == null || string.IsNullOrWhiteSpace(settings.BaseUrl))
        {
            ShowLogsWindow();
            return;
        }

        ServerManager.OpenUrl(settings.BaseUrl);
    }

    private async Task StopServerAndOpenSettingsAsync()
    {
        if (_shutdownRequested || _crashShutdownScheduled || _shutdownCompleted)
        {
            return;
        }

        if (_isOpeningSettings)
        {
            ActivateSetupWindow();
            return;
        }

        if (ActivateSetupWindow())
        {
            return;
        }

        _isOpeningSettings = true;
        DisableOpenInBrowserControls();
        UpdateStopServerControls();

        try
        {
            await ServerManager.StopServerAsync();
            OpenSettingsWindow();
        }
        finally
        {
            _isOpeningSettings = false;
            UpdateStopServerControls();
        }
    }

    private void OpenSettingsWindow()
    {
        if (!Dispatcher.UIThread.CheckAccess())
        {
            Dispatcher.UIThread.Post(OpenSettingsWindow);
            return;
        }

        if (ActivateSetupWindow())
        {
            return;
        }

        var settings = AppSettings.Load();
        var setupWindow = CreateSetupWindow(settings);
        _setupWindow = setupWindow;
        setupWindow.Closed += (_, _) =>
        {
            if (ReferenceEquals(_setupWindow, setupWindow))
            {
                _setupWindow = null;
                UpdateStopServerControls();
            }
        };

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = setupWindow;
        }

        setupWindow.Show();
        setupWindow.Activate();
        setupWindow.Focus();
        UpdateStopServerControls();
    }

    private SetupWindow CreateSetupWindow(AppSettings? settings)
    {
        var setupWindow = settings == null ? new SetupWindow() : new SetupWindow(settings);
        setupWindow.OnSetupComplete += async newSettings =>
        {
            setupWindow.Close();
            await ServerManager.StartServerAsync(newSettings);
        };

        return setupWindow;
    }

    private bool ActivateSetupWindow()
    {
        if (_setupWindow == null || !_setupWindow.IsVisible)
        {
            return false;
        }

        if (_setupWindow.WindowState == WindowState.Minimized)
        {
            _setupWindow.WindowState = WindowState.Normal;
        }

        _setupWindow.Activate();
        _setupWindow.Focus();
        return true;
    }

    private async void OnExitClicked(object? sender, EventArgs e)
    {
        await StopServerAndShutdownAsync();
    }

    private async void OnShutdownRequested(object? sender, ShutdownRequestedEventArgs e)
    {
        if (_shutdownCompleted)
        {
            return;
        }

        e.Cancel = true;
        await StopServerAndShutdownAsync();
    }

    private async Task StopServerAndShutdownAsync()
    {
        if (_shutdownRequested)
        {
            ShowLogsWindow();
            return;
        }

        _shutdownRequested = true;
        DisableOpenInBrowserControls();
        UpdateStopServerControls();
        ShowLogsWindow();
        await ServerManager.StopServerAsync();
        _shutdownCompleted = true;

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown();
        }
    }

    private void OnServerStopStateChanged()
    {
        if (!Dispatcher.UIThread.CheckAccess())
        {
            Dispatcher.UIThread.Post(OnServerStopStateChanged);
            return;
        }

        UpdateStopServerControls();
    }

    private void OnServerCrashShutdownRequested(TimeSpan delay)
    {
        if (!Dispatcher.UIThread.CheckAccess())
        {
            Dispatcher.UIThread.Post(() => OnServerCrashShutdownRequested(delay));
            return;
        }

        _ = ShutdownAfterServerCrashAsync(delay);
    }

    private async Task ShutdownAfterServerCrashAsync(TimeSpan delay)
    {
        if (_crashShutdownScheduled || _shutdownRequested || _shutdownCompleted)
        {
            return;
        }

        _crashShutdownScheduled = true;
        DisableOpenInBrowserControls();
        UpdateStopServerControls();
        ShowLogsWindow();

        await Task.Delay(delay);

        if (_shutdownCompleted)
        {
            return;
        }

        _shutdownRequested = true;
        Environment.ExitCode = LauncherExitCodes.ServerProcessCrashed;
        await ServerManager.StopServerAsync();
        _shutdownCompleted = true;

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown(LauncherExitCodes.ServerProcessCrashed);
        }
    }

    private void DisableOpenInBrowserControls()
    {
        if (_openInBrowserTrayMenuItem != null)
        {
            _openInBrowserTrayMenuItem.IsEnabled = false;
        }

        _logWindow?.SetOpenInBrowserState(false);
    }


    private NativeMenuItem? FindTrayMenuItem(string header)
    {
        var trayIcons = TrayIcon.GetIcons(this);
        if (trayIcons == null)
        {
            return null;
        }

        foreach (var trayIcon in trayIcons)
        {
            var menu = trayIcon.Menu;
            if (menu == null)
            {
                continue;
            }

            foreach (var item in menu.Items)
            {
                if (item is NativeMenuItem menuItem && string.Equals(menuItem.Header?.ToString(), header, StringComparison.Ordinal))
                {
                    return menuItem;
                }
            }
        }

        return null;
    }

    private void UpdateStopServerControls()
    {
        var hasOpenSetupWindow = _setupWindow != null && _setupWindow.IsVisible;
        var canStop = ServerManager.CanStopServer && !_shutdownRequested && !_crashShutdownScheduled && !_isOpeningSettings;
        var isStopping = ServerManager.IsStoppingServer || _shutdownRequested || _crashShutdownScheduled || _isOpeningSettings;
        var canOpenInBrowser = ServerManager.CanOpenInBrowser && !_shutdownRequested && !_crashShutdownScheduled && !_isOpeningSettings;
        var canOpenSettings = !_shutdownRequested && !_crashShutdownScheduled && !_isOpeningSettings && !hasOpenSetupWindow;

        if (_openInBrowserTrayMenuItem != null)
        {
            _openInBrowserTrayMenuItem.IsEnabled = canOpenInBrowser;
        }

        if (_openSettingsTrayMenuItem != null)
        {
            _openSettingsTrayMenuItem.IsEnabled = canOpenSettings;
            _openSettingsTrayMenuItem.Header = _isOpeningSettings ? "Opening Settings..." : "Open Settings";
        }

        if (_stopServerTrayMenuItem != null)
        {
            _stopServerTrayMenuItem.IsEnabled = canStop;
            _stopServerTrayMenuItem.Header = isStopping ? "Stopping Server..." : "Stop Server & Exit";
        }

        _logWindow?.SetStopServerState(canStop, isStopping);
        _logWindow?.SetOpenInBrowserState(canOpenInBrowser);
    }
}
