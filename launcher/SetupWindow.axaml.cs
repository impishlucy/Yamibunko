using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using System;
using System.IO;
using System.Text.RegularExpressions;

namespace Launcher;

public partial class SetupWindow : Window
{
    private static readonly Regex BaseUrlRegex = new(@"^https?://\S+$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ClientIdRegex = new(@"^\d+$", RegexOptions.Compiled);

    public event Action<AppSettings>? OnSetupComplete;
    private bool _isSetupComplete;

    public SetupWindow()
    {
        AvaloniaXamlLoader.Load(this);
        UpdateFileProcessingState();
        ValidateForm();
    }

    private void OnInputChanged(object? sender, TextChangedEventArgs e)
    {
        ValidateForm();
    }

    private void OnDisableFileProcessingChanged(object? sender, RoutedEventArgs e)
    {
        UpdateFileProcessingState();
        ValidateForm();
    }

    private async void SelectInputFolder_Click(object? sender, RoutedEventArgs e)
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null)
        {
            return;
        }

        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select Input Folder Directory",
            AllowMultiple = false
        });

        var uri = folders[0].Path;
        if (uri != null && uri.IsAbsoluteUri)
        {
            SetTextBoxValue("InputFolderBox", uri.LocalPath);
        }
        else
        {
            // fallback: show the URI string or use storage APIs to access files
            SetTextBoxValue("InputFolderBox", uri?.ToString() ?? string.Empty);
        }
    }

    private async void SelectOutputFolder_Click(object? sender, RoutedEventArgs e)
    {
        if (IsFileProcessingDisabled())
        {
            return;
        }

        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel == null)
        {
            return;
        }

        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select Output Folder Directory",
            AllowMultiple = false
        });

        if (folders.Count == 0)
        {
            return;
        }

        var uri = folders[0].Path;
        if (uri != null && uri.IsAbsoluteUri)
        {
            SetTextBoxValue("OutputFolderBox", uri.LocalPath);
        }
        else
        {
            // fallback: show the URI string or use storage APIs to access files
            SetTextBoxValue("OutputFolderBox", uri?.ToString() ?? string.Empty);
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

        saveButton.IsEnabled = isBaseUrlValid && isInputValid && isOutputValid && isClientIdValid;
    }

    private void SaveButton_Click(object? sender, RoutedEventArgs e)
    {
        var settings = new AppSettings
        {
            BaseUrl = GetTextBoxValue("BaseUrlBox"),
            InputFolderPath = GetTextBoxValue("InputFolderBox"),
            OutputFolderPath = GetTextBoxValue("OutputFolderBox"),
            ImportEnabled = !IsFileProcessingDisabled(),
            AnilistClientId = GetTextBoxValue("ClientIdBox"),
            AnilistClientSecret = GetTextBoxValue("ClientSecretBox")
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
        return this.FindControl<CheckBox>("DisableFileProcessingBox")?.IsChecked == true;
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
