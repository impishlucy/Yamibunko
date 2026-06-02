using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using System;

namespace Launcher;

public partial class App : Application
{
    public static ServerManager ServerManager { get; } = new();
    private LogWindow? _logWindow;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public App()
    {
        AppDomain.CurrentDomain.ProcessExit += (s, e) => ServerManager.StopServer();
        AppDomain.CurrentDomain.DomainUnload += (s, e) => ServerManager.StopServer();
        AppDomain.CurrentDomain.UnhandledException += (s, e) => ServerManager.StopServer();
        Console.CancelKeyPress += (s, e) => ServerManager.StopServer();
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.ShutdownMode = Avalonia.Controls.ShutdownMode.OnExplicitShutdown;
            desktop.ShutdownRequested += (s, e) => ServerManager.StopServer();
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
            _logWindow = new LogWindow(ServerManager.ServerLogs);
            _logWindow.Show();
        }
        else
        {
            _logWindow.Activate();
        }
    }

    private void OnExitClicked(object? sender, EventArgs e)
    {
        ServerManager.StopServer();
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.Shutdown();
        }
    }
}
