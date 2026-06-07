using Avalonia;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using Avalonia.Interactivity;
using System;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

namespace Launcher;

public partial class LogWindow : Window
{
    private const double BottomScrollThreshold = 6;

    private readonly StringBuilder _logText = new();
    private Func<Task>? _stopServerAsync;
    private TextBox? _logTextBox;
    private ScrollViewer? _logScrollViewer;
    private Button? _scrollToBottomButton;
    private Button? _stopServerButton;
    private bool _autoScrollToBottom = true;
    private bool _isProgrammaticScroll;

    public LogWindow()
    {
        AvaloniaXamlLoader.Load(this);
        InitializeControls();
    }

    public LogWindow(ObservableCollection<string> logs, Func<Task> stopServerAsync)
    {
        AvaloniaXamlLoader.Load(this);
        InitializeControls();

        _stopServerAsync = stopServerAsync;
        PopulateInitialLogs(logs);

        logs.CollectionChanged += (_, e) =>
        {
            if (e.NewItems == null)
            {
                return;
            }

            Dispatcher.UIThread.Post(() =>
            {
                foreach (var item in e.NewItems)
                {
                    if (item is string line)
                    {
                        AppendLogLine(line);
                    }
                }
            });
        };
    }

    private void InitializeControls()
    {
        _logTextBox = this.FindControl<TextBox>("LogTextBox");
        _logScrollViewer = this.FindControl<ScrollViewer>("LogScrollViewer");
        _scrollToBottomButton = this.FindControl<Button>("ScrollToBottomButton");
        _stopServerButton = this.FindControl<Button>("StopServerButton");

        if (_scrollToBottomButton != null)
        {
            _scrollToBottomButton.Click += OnScrollToBottomClicked;
        }

        if (_stopServerButton != null)
        {
            _stopServerButton.Click += OnStopServerClicked;
        }

        if (_logScrollViewer != null)
        {
            _logScrollViewer.ScrollChanged += OnLogScrollChanged;
        }

        SetScrollToBottomButtonVisible(false);

        if (_logTextBox == null)
        {
            Debug.WriteLine("LogTextBox not found in XAML.");
        }

        if (_logScrollViewer == null)
        {
            Debug.WriteLine("LogScrollViewer not found in XAML.");
        }

        if (_scrollToBottomButton == null)
        {
            Debug.WriteLine("ScrollToBottomButton not found in XAML.");
        }

        if (_stopServerButton == null)
        {
            Debug.WriteLine("StopServerButton not found in XAML.");
        }
    }

    private void PopulateInitialLogs(ObservableCollection<string> logs)
    {
        foreach (var line in logs)
        {
            AppendLogLine(line, false);
        }

        ScrollToEnd();
    }

    private void AppendLogLine(string line, bool scrollToEnd = true)
    {
        if (_logText.Length > 0)
        {
            _logText.AppendLine();
        }

        _logText.Append(line);

        if (_logTextBox == null)
        {
            return;
        }

        var previousScrollOffset = _logScrollViewer?.Offset ?? default;
        var selectionStart = _logTextBox.SelectionStart;
        var selectionEnd = _logTextBox.SelectionEnd;
        var hadSelection = selectionStart != selectionEnd;
        _logTextBox.Text = _logText.ToString();

        if (hadSelection)
        {
            var textLength = _logTextBox.Text?.Length ?? 0;
            _logTextBox.SelectionStart = Math.Min(selectionStart, textLength);
            _logTextBox.SelectionEnd = Math.Min(selectionEnd, textLength);
            _autoScrollToBottom = false;
            SetScrollToBottomButtonVisible(true);
            RestoreScrollOffset(previousScrollOffset);
            return;
        }

        if (scrollToEnd && _autoScrollToBottom)
        {
            ScrollToEnd();
            return;
        }

        RestoreScrollOffset(previousScrollOffset);
        UpdateScrollToBottomState();
    }

    private void OnLogScrollChanged(object? sender, ScrollChangedEventArgs e)
    {
        if (_isProgrammaticScroll)
        {
            return;
        }

        UpdateScrollToBottomState();
    }

    private void UpdateScrollToBottomState()
    {
        if (_logScrollViewer == null)
        {
            return;
        }

        _autoScrollToBottom = IsScrolledToBottom();
        SetScrollToBottomButtonVisible(!_autoScrollToBottom);
    }

    private bool IsScrolledToBottom()
    {
        if (_logScrollViewer == null)
        {
            return true;
        }

        var maxOffsetY = Math.Max(0, _logScrollViewer.Extent.Height - _logScrollViewer.Viewport.Height);
        return _logScrollViewer.Offset.Y >= maxOffsetY - BottomScrollThreshold;
    }

    private void ScrollToEnd()
    {
        if (_logTextBox == null || _logScrollViewer == null)
        {
            return;
        }

        _autoScrollToBottom = true;
        SetScrollToBottomButtonVisible(false);

        Dispatcher.UIThread.Post(() =>
        {
            if (_logTextBox == null || _logScrollViewer == null)
            {
                return;
            }

            _isProgrammaticScroll = true;

            try
            {
                var maxOffsetY = Math.Max(0, _logScrollViewer.Extent.Height - _logScrollViewer.Viewport.Height);
                _logScrollViewer.Offset = new Vector(_logScrollViewer.Offset.X, maxOffsetY);
                _logTextBox.CaretIndex = _logTextBox.Text?.Length ?? 0;
            }
            finally
            {
                _isProgrammaticScroll = false;
            }

            UpdateScrollToBottomState();
        }, DispatcherPriority.Background);
    }

    private void RestoreScrollOffset(Vector offset)
    {
        if (_logScrollViewer == null)
        {
            return;
        }

        Dispatcher.UIThread.Post(() =>
        {
            if (_logScrollViewer == null)
            {
                return;
            }

            _isProgrammaticScroll = true;

            try
            {
                var maxOffsetX = Math.Max(0, _logScrollViewer.Extent.Width - _logScrollViewer.Viewport.Width);
                var maxOffsetY = Math.Max(0, _logScrollViewer.Extent.Height - _logScrollViewer.Viewport.Height);
                _logScrollViewer.Offset = new Vector(Math.Min(offset.X, maxOffsetX), Math.Min(offset.Y, maxOffsetY));
            }
            finally
            {
                _isProgrammaticScroll = false;
            }
        }, DispatcherPriority.Background);
    }

    private void SetScrollToBottomButtonVisible(bool isVisible)
    {
        if (_scrollToBottomButton != null)
        {
            _scrollToBottomButton.IsVisible = isVisible;
        }
    }

    private void OnScrollToBottomClicked(object? sender, RoutedEventArgs e)
    {
        ScrollToEnd();
    }

    private async void OnStopServerClicked(object? sender, RoutedEventArgs e)
    {
        if (_stopServerAsync == null || _stopServerButton == null)
        {
            return;
        }

        _stopServerButton.IsEnabled = false;
        _stopServerButton.Content = "Stopping...";

        try
        {
            await _stopServerAsync();
            _stopServerButton.Content = "Server stopped";
        }
        catch (Exception ex)
        {
            _stopServerButton.Content = "Stop Server";
            _stopServerButton.IsEnabled = true;
            AppendLogLine($"[{DateTime.Now:HH:mm:ss}] Server stop failed: {ex.Message}");
        }
    }
}
