using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using System;
using System.Threading.Tasks;

namespace Launcher;

public partial class App : Application
{
    public static ServerManager ServerManager { get; } = new();
    private LogWindow? _logWindow;
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
        if (_logWindow == null || !_logWindow.IsVisible)
        {
            _logWindow = new LogWindow(ServerManager.ServerLogs, ServerManager.StopServerAsync);
            _logWindow.Show();
        }
        else
        {
            _logWindow.Activate();
        }
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
            return;
        }

        _shutdownRequested = true;
        await ServerManager.StopServerAsync();
        _shutdownCompleted = true;

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown();
        }
    }
}
