using System;
using System.IO;
using System.Text.Json;

namespace Launcher;

public class AppSettings
{
    public string BaseUrl { get; set; } = "http://localhost:3000";
    public string InputFolderPath { get; set; } = "";
    public string OutputFolderPath { get; set; } = "";
    public string FfmpegDir { get; set; } = "";
    public string TranscodeAccel { get; set; } = "cpu";
    public string AnilistClientId { get; set; } = "";
    public string AnilistClientSecret { get; set; } = "";
    public string BunPath { get; set; } = "";

    private static readonly string SettingsPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "settings.json");

    public static AppSettings? Load()
    {
        if (!File.Exists(SettingsPath)) return null;
        var json = File.ReadAllText(SettingsPath);
        return JsonSerializer.Deserialize<AppSettings>(json);
    }

    public void Save()
    {
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(SettingsPath, json);
    }
}