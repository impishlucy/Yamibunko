<div align="center">

# Yamibunko

**The all-in-one anime server that processes, organizes, enriches, and plays your local collection from one WebUI.**

<br />

[![Project Status](https://img.shields.io/badge/status-in%20development-7c3aed?style=for-the-badge)](#)
[![Download Latest Release](https://img.shields.io/badge/download-latest%20release-9333ea?style=for-the-badge)](https://github.com/impishlucy/Yamibunko/releases)

<br />

[Install](#install) • [What it does](#what-it-does) • [Development](#development-setup) • [License](#license)

</div>

---

<div align="center">

## What is Yamibunko?

</div>

Yamibunko is an all-in-one anime app for people who want a <b>singular</b> place to handle most parts of managing a collection.

Just drop files into an folder and it will optimize & organize them, and make them available through a polished WebUI.

It does **not** include or provide access to any copyrighted material. <ins>You bring your own local files.</ins>

---

<div align="center">

## Install

</div>

### Prerequisites

You **need** a 64 bit OS, as Yamibunko wont work with just 4GB of Ram.

If the launcher does not open you need to manually install [.NET 9](https://dotnet.microsoft.com/en-us/download/dotnet/9.0).

The Yamibunko launcher will download required frameworks and files automatically upon first launching it.

### Download

<div align="center">

</div>

1. Open the [Yamibunko Releases](https://github.com/impishlucy/Yamibunko/releases) page.
2. Download the latest release ZIP for your OS (Win or Linux).
3. Unpack the ZIP fully.
4. Start `Yamibunko.exe` from the unzipped folder.
5. Wait for the tray icon to report the current status.
6. The WebUI will open automatically when the app is ready.

If the WebUI does not open, check the tray icon.</br>
It will report startup status, setup progress, or problems that need attention.

---

<div align="center" id="what-it-does">

## What it does (Technical Stuff)

</div>

Yamibunko is meant to replace a pile of small tools with one focused local workflow.

Core features (Planned):

* Watches an input folder for new episode files.
* Checks file format, codec, size, duration, and audio tracks.
* Converts episodes to HEVC when needed.
* Targets small, consistent file sizes based on episode length.
* Can remove unwanted audio tracks.
* Convert audio to MP3 when audio is in FLAC or WAV.
* Sorts finished files into an organized library.
* Fetches AniList metadata for new library entries.
* Generates episode thumbnails.
* Provides a WebUI for browsing and playback with accounts.
* Supports Direct Play when the device can handle the file.
* Falls back to controlled live transcoding when needed.
* Uses transcode slots so the GPU/CPU is not overloaded.

---

<div align="center">

## Development Setup

</div>

This section is only for developers who want to change Yamibunko and need to run it from source.

Normal users should **ALWAYS** use the release ZIP from the [Install](#install) section.

### Clone the repository

```bash
git clone https://github.com/impishlucy/Yamibunko.git
cd Yamibunko
```

### Install dependencies

Windows:
https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip

Linux:
https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz

```bash
bun install
```

### Environment variables

While developing, create a `.env` file: (since we dont have the launcher to pass that)

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
FFPROBE_PATH=/absolute/path/to/ffprobe

ANIME_INPUT_DIR=/absolute/path/to/input
ANIME_MEDIA_DIR=/absolute/path/to/library
ANIME_CACHE_DIR=/absolute/path/to/cache

TRANSCODE_ACCEL=nvenc
BACKGROUND_TRANSCODE_CONCURRENCY=1
LIVE_TRANSCODE_SLOTS=3
```

Supported `TRANSCODE_ACCEL` values:

```txt
nvenc
qsv
cpu
```

### Run in development

```bash
bun run dev
```

### Start production server

```bash
bun run start
```

### Build

```bash
bun run build
```

---

<div align="center">

## References and Thanks

</div>

Yamibunko uses and is inspired by major open source tools and libraries:

* [Next.js](https://nextjs.org/) — React framework and App Router foundation.
* [shadcn/ui](https://ui.shadcn.com/) — UI component foundation.
* [Bun](https://bun.sh/) — JavaScript runtime and package manager.
* [BtbN FFmpeg Builds](https://github.com/BtbN/FFmpeg-Builds) — source for static FFmpeg builds downloaded by the launcher, when needed.
* [Vidstack](https://www.vidstack.io/) — media player UI tooling.
* [`@api-wrappers/anilist-wrapper`](https://github.com/Api-Wrappers/anilist-wrapper) — TypeScript AniList API wrapper.
* [`chokidar`](https://github.com/paulmillr/chokidar) — cross-platform file watching.

---

<div align="center">

## License

This project is licensed under the
[Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/deed.en).

You may share and adapt this project with attribution for non-commercial purposes.
Commercial use is not permitted.

</div>

---

<div align="center">

## Disclaimer

Yamibunko is intended for organizing, processing, and playing local files that you own or are allowed to use.

It does not include anime files, does not provide anime files, and does not provide access to licensed media.

</div>
