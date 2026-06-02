using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using System;
using System.Collections.ObjectModel;
using System.Diagnostics;
using Avalonia.Input;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;

namespace Launcher;

public partial class LogWindow : Window
{
    public LogWindow()
    {
        AvaloniaXamlLoader.Load(this);
        this.KeyDown += LogWindow_KeyDown;
    }

    public LogWindow(ObservableCollection<string> logs)
    {
        AvaloniaXamlLoader.Load(this);

        var listBox = this.FindControl<ListBox>("LogList");

        if (listBox == null)
        {
            Debug.WriteLine("LogList not found in XAML.");
            return;
        }

        listBox.ItemsSource = logs;

        logs.CollectionChanged += (s, e) =>
        {
            if (logs.Count > 0)
            {
                listBox.ScrollIntoView(logs[logs.Count - 1]);
            }
        };

        this.KeyDown += LogWindow_KeyDown;
    }

    private void LogWindow_KeyDown(object? sender, KeyEventArgs e)
    {
        // Detect Ctrl+C and gracefully stop the server, then close the logs window.
        if ((e.KeyModifiers & KeyModifiers.Control) == KeyModifiers.Control && e.Key == Key.C)
        {
            try
            {
                App.ServerManager.StopServer();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Failed to stop server via Ctrl+C: {ex.Message}");
            }

            // After stopping the server, shut down the entire application so the whole app exits.
            try
            {
                var lifetime = Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime;
                lifetime?.Shutdown();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Failed to shut down application after Ctrl+C: {ex.Message}");
                // Fallback: close just this window if shutdown fails
                this.Close();
            }
            e.Handled = true;
        }
    }
}
