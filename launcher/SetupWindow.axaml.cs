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
        ValidateForm();
    }

    private void OnInputChanged(object? sender, TextChangedEventArgs e)
    {
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

        if (folders.Count == 0)
        {
            return;
        }

        SetTextBoxValue("InputFolderBox", folders[0].Path.LocalPath);
    }

    private async void SelectOutputFolder_Click(object? sender, RoutedEventArgs e)
    {
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

        SetTextBoxValue("OutputFolderBox", folders[0].Path.LocalPath);
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

        bool isInputValid = Directory.Exists(inputPath);
        bool isOutputValid = Directory.Exists(outputPath);
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
