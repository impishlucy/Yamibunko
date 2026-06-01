# Yamibunko

Yamibunko is a local anime library server with a desktop launcher and a web UI. It processes your own media files, organizes them into a library, enriches entries with metadata, and plays them through the browser.

Yamibunko does not include, download, or provide access to copyrighted media. You bring your own local files.

[Download releases](https://github.com/impishlucy/Yamibunko/releases)

## Install

### Normal Install

1. Open the [Yamibunko releases](https://github.com/impishlucy/Yamibunko/releases) page.
2. Download the latest release ZIP for your OS.
3. Extract the ZIP completely.
4. Start the launcher from the extracted folder.
5. Fill in the setup fields:
   - Base URL, usually `http://localhost:3000` or the website url of the app.
   - Input folder for new files
   - Library folder for processed files
   - AniList API client ID and secret if you want AniList login, tracking, or metadata features
6. Save the setup and wait for the launcher to start the web UI.

The launcher prepares the local runtime, starts the webapp, and downloads whats needed.
If the web UI does not open automatically, check the launcher log window or tray status.

For best results, use a 64-bit OS with more than 4 GB of RAM.

### AniList Setup

AniList features require an AniList API client. Configure the client redirect URL to match the Yamibunko callback URL:

```text
http://localhost:3000/api/anilist/oauth/callback
https://your-domain.example/api/anilist/oauth/callback
```

Use the same base URL in the launcher or `.env` file. If you host Yamibunko behind a path prefix, the callback path is appended behind that base URL.

### Manual Webapp Install

The webapp can run without the launcher, but you must provide the runtime yourself:

- Node.js 20 or newer, with Node.js 24 recommended for development
- Bun
- FFmpeg and FFprobe with HEVC support
- A configured `.env` file

From the `webapp` directory:

```bash
bun install
bun run build
bun run start
```

Supported `TRANSCODE_ACCEL` values in env are `nvenc`, `qsv`, and `cpu`.

## Features

Yamibunko is built around a local media workflow:

- Watches an input folder for new episode files.
- Checks file format, codec, size, duration, and audio tracks.
- Converts episodes to HEVC when needed.
- Targets consistent file sizes based on episode length.
- Can remove unwanted audio tracks.
- Converts FLAC or WAV audio when needed.
- Sorts processed files into an organized library.
- Fetches AniList metadata for library entries.
- Generates episode thumbnails.
- Provides a web UI for browsing and playback with accounts.
- Supports direct play when the client can handle the file.
- Falls back to controlled live transcoding when needed.
- Uses transcode slots so the GPU or CPU is not overloaded.

## Contributing

### Repository Setup

```bash
git clone https://github.com/impishlucy/Yamibunko.git
cd Yamibunko
```

### Webapp Development

```bash
cd webapp
bun install
cp .env.example .env
bun run dev
```

Before opening a pull request, run:

```bash
bun run lint
bun run typecheck
bun run build
```

### Launcher Development

The launcher is a C# Avalonia project in `launcher`.

```bash
dotnet restore launcher/Launcher.csproj
dotnet build launcher/Launcher.csproj
dotnet run --project launcher/Launcher.csproj
```

Use a .NET SDK that supports the launcher target framework in `launcher/Launcher.csproj`.

## References and Thanks

Yamibunko uses and is inspired by these projects:

- [Next.js](https://nextjs.org/) for the webapp.
- [Avalonia UI](https://avaloniaui.net/) for the desktop launcher.
- [Bun](https://bun.sh/) for webapp package management and scripts.
- [BtbN FFmpeg Builds](https://github.com/BtbN/FFmpeg-Builds) for FFmpeg builds used by the launcher.
- [Vidstack](https://www.vidstack.io/) for media player UI tooling.
- [`@api-wrappers/anilist-wrapper`](https://github.com/Api-Wrappers/anilist-wrapper) for AniList API access.
- [`chokidar`](https://github.com/paulmillr/chokidar) for file watching.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/deed.en).

You may share and adapt this project with attribution for non-commercial purposes. Commercial use is not permitted.

## Disclaimer

Yamibunko is intended for organizing, processing, and playing local files that you own or are allowed to use.

It does not include anime files, does not provide anime files, and does not provide access to licensed media.
