using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Launcher;

public class AppSettings
{
    private static readonly string[] StartupFieldNames =
    {
        nameof(BaseUrl),
        nameof(InputFolderPath),
        nameof(OutputFolderPath),
        nameof(ImportEnabled),
        nameof(FfmpegDir),
        nameof(TranscodeAccel),
        nameof(AnilistClientId),
        nameof(AnilistClientSecret),
        nameof(BunPath)
    };

    public string BaseUrl { get; set; } = "http://localhost:3000";
    public string InputFolderPath { get; set; } = "";
    public string OutputFolderPath { get; set; } = "";
    public bool ImportEnabled { get; set; } = true;
    public string FfmpegDir { get; set; } = "";
    public string TranscodeAccel { get; set; } = "cpu";
    public string AnilistClientId { get; set; } = "";
    public string AnilistClientSecret { get; set; } = "";
    public string BunPath { get; set; } = "";

    [JsonIgnore]
    public IReadOnlyDictionary<string, JsonValueKind>? LoadedPropertyKinds { get; private set; }

    private static readonly string SettingsPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "settings.json");

    public static AppSettings? Load()
    {
        if (!File.Exists(SettingsPath)) return null;

        var json = File.ReadAllText(SettingsPath);
        var propertyKinds = ReadPropertyKinds(json);
        var settings = JsonSerializer.Deserialize<AppSettings>(json);

        if (settings != null)
        {
            settings.LoadedPropertyKinds = propertyKinds;
        }

        return settings;
    }

    public bool IsValidForStartup(out IReadOnlyList<string> errors)
    {
        var validationErrors = new List<string>();

        foreach (var fieldName in StartupFieldNames)
        {
            if (!HasLoadedField(fieldName))
            {
                validationErrors.Add($"Missing required settings field: {fieldName}.");
            }
        }

        if (string.IsNullOrWhiteSpace(BaseUrl))
        {
            validationErrors.Add("BaseUrl must be filled.");
        }

        if (string.IsNullOrWhiteSpace(InputFolderPath))
        {
            validationErrors.Add("InputFolderPath must be filled.");
        }

        if (ImportEnabled && string.IsNullOrWhiteSpace(OutputFolderPath))
        {
            validationErrors.Add("OutputFolderPath must be filled when import is enabled.");
        }

        errors = validationErrors;
        return validationErrors.Count == 0;
    }

    public void Save()
    {
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(SettingsPath, json);
    }

    private bool HasLoadedField(string fieldName)
    {
        if (LoadedPropertyKinds == null)
        {
            return true;
        }

        return LoadedPropertyKinds.TryGetValue(fieldName, out var kind) &&
               kind != JsonValueKind.Null &&
               kind != JsonValueKind.Undefined;
    }

    private static Dictionary<string, JsonValueKind> ReadPropertyKinds(string json)
    {
        using var document = JsonDocument.Parse(json);
        var propertyKinds = new Dictionary<string, JsonValueKind>(StringComparer.OrdinalIgnoreCase);

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            return propertyKinds;
        }

        foreach (var property in document.RootElement.EnumerateObject())
        {
            propertyKinds[property.Name] = property.Value.ValueKind;
        }

        return propertyKinds;
    }
}
