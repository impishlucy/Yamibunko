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
    private NativeMenuItem? _stopServerTrayMenuItem;
    private bool _shutdownRequested;
    private bool _shutdownCompleted;

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
            desktop.Exit += (s, e) => ServerManager.StopServer();

            _stopServerTrayMenuItem = FindStopServerTrayMenuItem();
            ServerManager.LogsWindowRequested += ShowLogsWindow;
            ServerManager.ServerStopStateChanged += OnServerStopStateChanged;
            UpdateStopServerControls();

            ServerManager.CleanupOrphans();

            var settings = AppSettings.Load();
            if (settings == null)
            {
                var setupWindow = new SetupWindow();
                setupWindow.OnSetupComplete += async (newSettings) =>
                {
                    setupWindow.Close();
                    await ServerManager.StartServerAsync(newSettings);
                };
                desktop.MainWindow = setupWindow;
                setupWindow.Show();
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
            _logWindow = new LogWindow(ServerManager.ServerLogs, ServerManager.StopServerAsync);
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

    private async void OnExitClicked(object? sender, EventArgs e)
    {
        ShowLogsWindow();
        await StopServerAndShutdownAsync();
    }

    private async void OnShutdownRequested(object? sender, ShutdownRequestedEventArgs e)
    {
        if (_shutdownCompleted)
        {
            return;
        }

        e.Cancel = true;
        ShowLogsWindow();
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
        UpdateStopServerControls();
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


    private NativeMenuItem? FindStopServerTrayMenuItem()
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
                if (item is NativeMenuItem menuItem && string.Equals(menuItem.Header?.ToString(), "Stop Server & Exit", StringComparison.Ordinal))
                {
                    return menuItem;
                }
            }
        }

        return null;
    }

    private void UpdateStopServerControls()
    {
        var canStop = ServerManager.CanStopServer && !_shutdownRequested;
        var isStopping = ServerManager.IsStoppingServer || _shutdownRequested;

        if (_stopServerTrayMenuItem != null)
        {
            _stopServerTrayMenuItem.IsEnabled = canStop;
            _stopServerTrayMenuItem.Header = isStopping ? "Stopping Server..." : "Stop Server & Exit";
        }

        _logWindow?.SetStopServerState(canStop, isStopping);
    }
}
