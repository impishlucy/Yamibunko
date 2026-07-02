<div align="center">

<picture>
  <img src="https://raw.githubusercontent.com/impishlucy/Yamibunko/refs/heads/main/webapp/src/app/favicon.ico" height=64>
</picture>
  
# Yamibunko

Yamibunko is local anime library and file processor, with a launcher and a web UI. <br/> It can optimize your files, organizes them and can play them back through the WebUI.

<img width="48%" alt="library" src="https://github.com/user-attachments/assets/fe05f186-7b1e-42e2-b154-da7c737952bb" />
<img width="48%" alt="overview" src="https://github.com/user-attachments/assets/97a719da-e392-4089-82be-fc1d983a979b" />
<img width="48%" alt="player" src="https://github.com/user-attachments/assets/752f0712-4df7-4d7f-8c90-04585f7cdde4" />

</div>

## Features

### General

* Custom player, with custom subtitles, skip buttons and casting.</br>(Casting is not available via iOS.)
* Responsive layouts for all pages, on desktop, tablets, and phones.
* Direct-File play and transcoding for older devices are possible.
* Per-series grouping, no more specific searching, its grouped together per series.
* AniList for metadata, tracking, watching progress and watching status.
* Desktop launcher that prepares, starts, and keeps it easier to use.
* Bandwidth-aware streaming, uses a limit to avoid overloading the connection.
* One stream per user, with confirmation when switching to another device.
* VIP priority streaming so selected users can get better access.
* Now comes with a Android TV App, to avoid the need for casting.

### File Processing
* If enabled it can convert input files for smaller files, using HEVC.
* If disabled it only servers your existing files and does not edit them.
* Support for non Anime, just put them in /NotAnime in the Input Folder.</br>(e.g. /Input/NotAnime/Series/files..)

## Install

### Normal Install (with Launcher)

The only required things are an 64bit OS and .NET 10.

0. Install [.NET 10 Runtime](https://dotnet.microsoft.com/en-us/download/dotnet/10.0).
1. Open the [Yamibunko releases](https://github.com/impishlucy/Yamibunko/releases) page.
2. Download the latest release ZIP for your OS.
3. Extract the ZIP completely.
4. Start the launcher from the extracted folder.
5. Fill in the setup fields:

   * Base URL, usually ur Devices lan IP (e.g. `http://192.168.178.10:3000`),<br/>
     or your Websites URL (https only) (If ur using a reverse proxy for the app).
   * Input folder for new files.
   * Output folder for processed files.
   * AniList API client ID and secret if you want AniList tracking.
6. Save the setup and wait for the launcher to start the web UI.

The launcher prepares the runtime, downloads whats needed and starts the webapp.<br/>
The app runs in the backround and has right clickable tray icon.

### Update (with Launcher)
1. Stop any Yamibunko instance running and wait for shutdown.
2. Open the Folder of your Yamibunko Install.
3. Execute the Updater script and wait for it to complete.
4. Start the Launcher and ur done.

- - - - - -

### AniList Setup

AniList user features require an [AniList API client](https://anilist.co/settings/developer).<br/>
Configure the client redirect URL to match the Yamibunko callback URL:

```text
Examples:
http://192.168.178.10:3000/api/anilist/oauth/callback
https://your-domain.example/api/anilist/oauth/callback
```

Use the same base URL in the launcher or in the manual startup arguments.<br/>
If you host Yamibunko behind a path prefix (.e.g https://your.url/anime/), the callback path is appended behind that path.

- - - - - -

### Manual Webapp Install

The webapp can run without the launcher, but you must provide the runtime yourself:

* [Node.js 20 or newer](https://nodejs.org/)
* [Bun](https://bun.sh/)
* [FFmpeg and FFprobe with AV1/HEVC support](https://github.com/btbn/ffmpeg-builds/)

#### Steps

Run following commands from the cloned `webapp` directory:

1. Setup commands
```bash
bun install
bun run build
```
2. Run the WebApp (Configure the parameters)
```bash
bun run start -- \
  --BASE_URL=http://localhost:3000 \
  --ANIME_INPUT_DIR=/path/to/input \
  --ANIME_MEDIA_DIR=/path/to/output \
  --IMPORT_ENABLED=true \
  --FFMPEG_DIR=/path/to/ffmpeg/bin \
  --TRANSCODE_ACCEL=nvenc \
  --ANILIST_CLIENT_ID=optional-client-id \
  --ANILIST_CLIENT_SECRET=optional-client-secret
```

Minimal argument notes:

* `BASE_URL`: the URL users open in their browser, also used for the AniList callback.
* `ANIME_INPUT_DIR`: folder watched for new files.
* `ANIME_MEDIA_DIR`: output library folder, required when `IMPORT_ENABLED=true`.
* `IMPORT_ENABLED`: `true` processes/moves files, `false` does not.
* `FFMPEG_DIR`: folder containing `ffmpeg` and `ffprobe`.
* `TRANSCODE_ACCEL`: `nvenc`, `intel_gpu`, `intel_cpu`, `amd_gpu`, `amd_cpu`,`cpu`.</br>
Use `cpu` only when `IMPORT_ENABLED=false` and your hardware does not support `av1` or `hevc`.
* `ANILIST_CLIENT_ID` and `ANILIST_CLIENT_SECRET`: Needed for AniList tracking.

### Manual Webapp Update

0. Download the new version zip and unpack it.
1. Stop the currently running Instance.
2. Paste the webapp contents over the one in your instance folder.
3. Delete the .next folder inside your instance folder.
4. Run `bun run build` before starting it.
5. Start it.

## Disclaimer

Yamibunko is intended for organizing, processing, and playing local files.</br>
<ins>Yamibunko does not include, download, or provide access to copyrighted media.</ins>

## License

This project is licensed under the [CCA-NC 4.0 License](https://creativecommons.org/licenses/by-nc/4.0/deed.en).</br>
You may share and adapt this project with attribution for non-commercial purposes.</br>
Commercial use is <ins>not</ins> permitted in any way or form.

## External Resources

This project uses ffmpeg under the hood, specifically [this](https://github.com/btbn/ffmpeg-builds/) version.</br>
The Android TV app was made using [this project](https://github.com/DedBash/AndroidTV-WebAPP) as a base. 
