using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using System.Collections.ObjectModel;
using System.Diagnostics;

namespace Launcher;

public partial class LogWindow : Window
{
    public LogWindow()
    {
        AvaloniaXamlLoader.Load(this);
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

        listBox.ScrollIntoView(logs[logs.Count - 1]);

        logs.CollectionChanged += (s, e) =>
        {
            if (logs.Count > 0)
            {
                listBox.ScrollIntoView(logs[logs.Count - 1]);
            }
        };
    }
}
