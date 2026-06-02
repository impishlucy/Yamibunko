using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Launcher;

public partial class SetupWindow : Window
{
    private static readonly Regex BaseUrlRegex = new(@"^https?://\S+$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ClientIdRegex = new(@"^\d+$", RegexOptions.Compiled);
    private const int MaxInputFolderCount = 2;

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
            Title = "Select up to 2 Input Folder Directories",
            AllowMultiple = true
        });

        if (folders.Count == 0)
        {
            return;
        }

        var paths = folders
            .Take(MaxInputFolderCount)
            .Select(GetFolderPath)
            .Where(path => !string.IsNullOrWhiteSpace(path));

        SetTextBoxValue("InputFolderBox", string.Join(';', paths));
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

        SetTextBoxValue("OutputFolderBox", GetFolderPath(folders[0]));
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

        bool isInputValid = AreInputFoldersValid(inputPath);
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

    private static bool AreInputFoldersValid(string value)
    {
        var folders = SplitInputFolders(value);
        return folders.Length is > 0 and <= MaxInputFolderCount && folders.All(Directory.Exists);
    }

    private static string[] SplitInputFolders(string value)
    {
        return value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static string GetFolderPath(IStorageFolder folder)
    {
        var uri = folder.Path;
        return uri.IsAbsoluteUri ? uri.LocalPath : uri.ToString();
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
