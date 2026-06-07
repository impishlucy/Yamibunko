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
    private Func<Task>? _stopServerAndExitAsync;
    private Action? _openInBrowser;
    private TextBox? _logTextBox;
    private ScrollViewer? _logScrollViewer;
    private Button? _scrollToBottomButton;
    private Button? _openInBrowserButton;
    private Button? _stopServerButton;
    private bool _autoScrollToBottom = true;
    private bool _isProgrammaticScroll;
    private bool _pendingAutoScrollToBottom;
    private double _lastScrollOffsetY;
    private double _lastScrollExtentHeight;

    public LogWindow()
    {
        AvaloniaXamlLoader.Load(this);
        InitializeControls();
    }

    public LogWindow(ObservableCollection<string> logs, Func<Task> stopServerAndExitAsync, Action openInBrowser)
    {
        AvaloniaXamlLoader.Load(this);
        InitializeControls();

        _stopServerAndExitAsync = stopServerAndExitAsync;
        _openInBrowser = openInBrowser;
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
        _openInBrowserButton = this.FindControl<Button>("OpenInBrowserButton");
        _stopServerButton = this.FindControl<Button>("StopServerButton");

        if (_scrollToBottomButton != null)
        {
            _scrollToBottomButton.Click += OnScrollToBottomClicked;
        }

        if (_openInBrowserButton != null)
        {
            _openInBrowserButton.Click += OnOpenInBrowserClicked;
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

        if (_openInBrowserButton == null)
        {
            Debug.WriteLine("OpenInBrowserButton not found in XAML.");
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
        if (_logScrollViewer == null)
        {
            return;
        }

        if (_isProgrammaticScroll || _pendingAutoScrollToBottom)
        {
            UpdateLastScrollMetrics();
            return;
        }

        var offsetY = _logScrollViewer.Offset.Y;
        var extentHeight = _logScrollViewer.Extent.Height;
        var extentChanged = Math.Abs(extentHeight - _lastScrollExtentHeight) > 0.5;
        var offsetChanged = Math.Abs(offsetY - _lastScrollOffsetY) > 0.5;

        if (_autoScrollToBottom && extentChanged && !offsetChanged)
        {
            UpdateLastScrollMetrics();
            ScrollToEnd();
            return;
        }

        UpdateScrollToBottomState();
        UpdateLastScrollMetrics();
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
        _pendingAutoScrollToBottom = true;
        SetScrollToBottomButtonVisible(false);
        QueueScrollToEnd(2);
    }

    private void QueueScrollToEnd(int remainingPasses)
    {
        Dispatcher.UIThread.Post(() =>
        {
            if (_logTextBox == null || _logScrollViewer == null)
            {
                _pendingAutoScrollToBottom = false;
                return;
            }

            _isProgrammaticScroll = true;

            try
            {
                var maxOffsetY = Math.Max(0, _logScrollViewer.Extent.Height - _logScrollViewer.Viewport.Height);
                _logScrollViewer.Offset = new Vector(0, maxOffsetY);
                _logTextBox.CaretIndex = _logTextBox.Text?.Length ?? 0;
                UpdateLastScrollMetrics();
            }
            finally
            {
                _isProgrammaticScroll = false;
            }

            if (remainingPasses > 0)
            {
                QueueScrollToEnd(remainingPasses - 1);
                return;
            }

            _pendingAutoScrollToBottom = false;
            _autoScrollToBottom = true;
            SetScrollToBottomButtonVisible(false);
            UpdateLastScrollMetrics();
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
                var maxOffsetY = Math.Max(0, _logScrollViewer.Extent.Height - _logScrollViewer.Viewport.Height);
                _logScrollViewer.Offset = new Vector(0, Math.Min(offset.Y, maxOffsetY));
                UpdateLastScrollMetrics();
            }
            finally
            {
                _isProgrammaticScroll = false;
            }
        }, DispatcherPriority.Background);
    }

    private void UpdateLastScrollMetrics()
    {
        if (_logScrollViewer == null)
        {
            return;
        }

        _lastScrollOffsetY = _logScrollViewer.Offset.Y;
        _lastScrollExtentHeight = _logScrollViewer.Extent.Height;
    }

    private void SetScrollToBottomButtonVisible(bool isVisible)
    {
        if (_scrollToBottomButton != null)
        {
            _scrollToBottomButton.IsVisible = isVisible;
        }
    }

    public void SetStopServerState(bool canStop, bool isStopping)
    {
        if (_stopServerButton == null)
        {
            return;
        }

        _stopServerButton.IsEnabled = canStop;
        _stopServerButton.Content = isStopping
            ? "Stopping..."
            : canStop
                ? "Stop Server & Exit"
                : "Server stopped";
    }

    public void SetOpenInBrowserState(bool canOpen)
    {
        if (_openInBrowserButton != null)
        {
            _openInBrowserButton.IsEnabled = canOpen;
        }
    }

    private void OnScrollToBottomClicked(object? sender, RoutedEventArgs e)
    {
        ScrollToEnd();
    }

    private void OnOpenInBrowserClicked(object? sender, RoutedEventArgs e)
    {
        _openInBrowser?.Invoke();
    }

    private async void OnStopServerClicked(object? sender, RoutedEventArgs e)
    {
        if (_stopServerAndExitAsync == null)
        {
            return;
        }

        SetStopServerState(false, true);
        SetOpenInBrowserState(false);

        try
        {
            await _stopServerAndExitAsync();
            SetStopServerState(true, false);
        }
        catch (Exception ex)
        {
            SetStopServerState(true, false);
            AppendLogLine($"[{DateTime.Now:HH:mm:ss}] Server stop failed: {ex.Message}");
        }
    }
}
