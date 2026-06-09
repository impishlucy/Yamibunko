using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using Avalonia.Media;
using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Launcher;

public partial class SetupWindow : Window
{
    private static readonly Regex BaseUrlRegex = new(@"^https?://\S+$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ClientIdRegex = new(@"^\d+$", RegexOptions.Compiled);
    private const string ForcedCatalogModeTooltipText = "HW encoding is not supported for AV1 on your device, encode mode is disabled";

    public event Action<AppSettings>? OnSetupComplete;
    private readonly AppSettings? _initialSettings;
    private HardwareAccelerationDetection? _hardwareDetection;
    private object? _defaultDisableFileProcessingTooltip;
    private bool _isSetupComplete;
    private bool _catalogModeForced;
    private bool _hardwareDetectionComplete;

    public SetupWindow()
    {
        AvaloniaXamlLoader.Load(this);
        CaptureDefaultDisableFileProcessingTooltip();
        UpdateFileProcessingState();
        ValidateForm();
        RefreshCatalogModeLockAsync();
    }

    public SetupWindow(AppSettings settings)
    {
        _initialSettings = settings;
        AvaloniaXamlLoader.Load(this);
        CaptureDefaultDisableFileProcessingTooltip();
        PopulateForm(settings);
        UpdateFileProcessingState();
        ValidateForm();
        RefreshCatalogModeLockAsync();
    }

    private void OnInputChanged(object? sender, TextChangedEventArgs e)
    {
        ValidateForm();
    }

    private void OnDisableFileProcessingChanged(object? sender, RoutedEventArgs e)
    {
        if (_catalogModeForced)
        {
            SetCatalogModeForced(true);
            return;
        }

        UpdateFileProcessingState();
        ValidateForm();
    }

    private async void SelectInputFolder_Click(object? sender, RoutedEventArgs e)
    {
        await SelectFolderIntoTextBoxAsync("Select Input Folder Directory", "InputFolderBox");
    }

    private async void SelectOutputFolder_Click(object? sender, RoutedEventArgs e)
    {
        if (IsFileProcessingDisabled())
        {
            return;
        }

        await SelectFolderIntoTextBoxAsync("Select Output Folder Directory", "OutputFolderBox");
    }

    private async Task SelectFolderIntoTextBoxAsync(string title, string textBoxName)
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null)
        {
            return;
        }

        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = title,
            AllowMultiple = false
        });

        if (folders.Count == 0)
        {
            return;
        }

        var uri = folders[0].Path;
        SetTextBoxValue(textBoxName, uri?.IsAbsoluteUri == true ? uri.LocalPath : uri?.ToString() ?? string.Empty);
    }

    private void PopulateForm(AppSettings settings)
    {
        SetTextBoxValue("BaseUrlBox", settings.BaseUrl ?? "");
        SetTextBoxValue("InputFolderBox", settings.InputFolderPath ?? "");
        SetTextBoxValue("OutputFolderBox", settings.OutputFolderPath ?? "");
        SetTextBoxValue("ClientIdBox", settings.AnilistClientId ?? "");
        SetTextBoxValue("ClientSecretBox", settings.AnilistClientSecret ?? "");

        var disableFileProcessingBox = this.FindControl<CheckBox>("DisableFileProcessingBox");
        if (disableFileProcessingBox != null)
        {
            disableFileProcessingBox.IsChecked = !settings.ImportEnabled;
        }
    }

    private void ValidateForm()
    {
        var saveButton = this.FindControl<Button>("SaveButton");
        if (saveButton == null)
        {
            return;
        }

        var baseUrl = GetTextBoxValue("BaseUrlBox");
        var inputPath = GetTextBoxValue("InputFolderBox");
        var outputPath = GetTextBoxValue("OutputFolderBox");
        var clientId = GetTextBoxValue("ClientIdBox");

        bool isBaseUrlValid = !string.IsNullOrWhiteSpace(baseUrl) &&
                              BaseUrlRegex.IsMatch(baseUrl);

        bool fileProcessingDisabled = IsFileProcessingDisabled();
        bool isInputValid = Directory.Exists(inputPath);
        bool isOutputValid = fileProcessingDisabled || Directory.Exists(outputPath);
        bool isClientIdValid = string.IsNullOrWhiteSpace(clientId) || ClientIdRegex.IsMatch(clientId);

        saveButton.IsEnabled = _hardwareDetectionComplete && isBaseUrlValid && isInputValid && isOutputValid && isClientIdValid;
    }

    private void SaveButton_Click(object? sender, RoutedEventArgs e)
    {
        if (!_hardwareDetectionComplete)
        {
            return;
        }

        var importEnabled = !_catalogModeForced && !IsFileProcessingDisabled();
        var settings = new AppSettings
        {
            BaseUrl = GetTextBoxValue("BaseUrlBox"),
            InputFolderPath = GetTextBoxValue("InputFolderBox"),
            OutputFolderPath = GetTextBoxValue("OutputFolderBox"),
            ImportEnabled = importEnabled,
            FfmpegDir = _initialSettings?.FfmpegDir ?? "",
            TranscodeAccel = ResolveSavedTranscodeAcceleration(importEnabled),
            AnilistClientId = GetTextBoxValue("ClientIdBox"),
            AnilistClientSecret = GetTextBoxValue("ClientSecretBox"),
            BunPath = _initialSettings?.BunPath ?? ""
        };

        settings.Save();

        _isSetupComplete = true;
        OnSetupComplete?.Invoke(settings);
    }

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);

        if (!_isSetupComplete)
        {
            Environment.Exit(0);
        }
    }

    private bool IsFileProcessingDisabled()
    {
        return _catalogModeForced || this.FindControl<CheckBox>("DisableFileProcessingBox")?.IsChecked == true;
    }

    private string ResolveSavedTranscodeAcceleration(bool importEnabled)
    {
        if (_hardwareDetection != null)
        {
            return HardwareAccelerationDetector.SelectServerTranscodeAcceleration(_hardwareDetection, importEnabled);
        }

        return AppSettings.NormalizeTranscodeAccel(_initialSettings?.TranscodeAccel);
    }

    private async void RefreshCatalogModeLockAsync()
    {
        _hardwareDetectionComplete = false;
        ValidateForm();

        try
        {
            var detection = await HardwareAccelerationDetector.DetectAsync(_initialSettings?.FfmpegDir, !string.IsNullOrWhiteSpace(_initialSettings?.FfmpegDir));
            _hardwareDetection = detection;
            UpdateHardwareAccelerationStatusText(detection);
            _hardwareDetectionComplete = true;
            SetCatalogModeForced(!HardwareAccelerationDetector.SupportsAv1ImportAcceleration(detection));
        }
        catch
        {
            UpdateHardwareAccelerationStatusText(null);
            _hardwareDetectionComplete = true;
            SetCatalogModeForced(true);
        }
    }

    private void UpdateHardwareAccelerationStatusText(HardwareAccelerationDetection? detection)
    {
        var statusText = this.FindControl<TextBlock>("HardwareAccelerationStatusText");
        if (statusText == null)
        {
            return;
        }

        if (detection == null)
        {
            statusText.Text = "Video Accelerator: Encoder: unsupported · Live transcoder: software";
            return;
        }

        var encodeAcceleration = !HardwareAccelerationDetector.SupportsAv1ImportAcceleration(detection)
            ? "unsupported"
            : HardwareAccelerationDetector.FormatAccelerationForDisplay(detection.Av1ImportAcceleration);
        var liveAcceleration = HardwareAccelerationDetector.FormatAccelerationForDisplay(detection.LiveTranscodeAcceleration);

        statusText.Text = $"Video Accelerator: Encoder: {encodeAcceleration} · Live transcoder: {liveAcceleration}";
    }

    private void CaptureDefaultDisableFileProcessingTooltip()
    {
        var container = this.FindControl<Border>("DisableFileProcessingContainer");
        _defaultDisableFileProcessingTooltip = container != null ? ToolTip.GetTip(container) : null;
    }

    private void SetCatalogModeForced(bool forced)
    {
        _catalogModeForced = forced;

        var disableFileProcessingBox = this.FindControl<CheckBox>("DisableFileProcessingBox");
        var container = this.FindControl<Border>("DisableFileProcessingContainer");

        if (disableFileProcessingBox != null)
        {
            disableFileProcessingBox.IsChecked = forced || disableFileProcessingBox.IsChecked == true;
            disableFileProcessingBox.IsEnabled = !forced;
        }

        if (container != null)
        {
            ToolTip.SetTip(container, forced ? CreateForcedCatalogModeTooltip() : _defaultDisableFileProcessingTooltip);
        }

        UpdateFileProcessingState();
        ValidateForm();
    }

    private static Control CreateForcedCatalogModeTooltip()
    {
        return new Border
        {
            Width = 310,
            Padding = new Thickness(4),
            Background = Brush.Parse("#18181B"),
            BorderBrush = Brush.Parse("#EF4444"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Child = new TextBlock
            {
                Text = ForcedCatalogModeTooltipText,
                FontSize = 13,
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brush.Parse("#EF4444")
            }
        };
    }

    private void UpdateFileProcessingState()
    {
        var fileProcessingDisabled = IsFileProcessingDisabled();
        var outputBox = this.FindControl<TextBox>("OutputFolderBox");
        var outputButton = this.FindControl<Button>("OutputFolderButton");

        if (outputBox != null)
        {
            if (fileProcessingDisabled && !string.IsNullOrWhiteSpace(outputBox.Text))
            {
                outputBox.Text = string.Empty;
            }

            outputBox.IsEnabled = !fileProcessingDisabled;
        }

        if (outputButton != null)
        {
            outputButton.IsEnabled = !fileProcessingDisabled;
        }
    }

    private string GetTextBoxValue(string name)
    {
        return this.FindControl<TextBox>(name)?.Text?.Trim() ?? "";
    }

    private void SetTextBoxValue(string name, string value)
    {
        var textBox = this.FindControl<TextBox>(name);
        if (textBox != null)
        {
            textBox.Text = value;
        }
    }
}
