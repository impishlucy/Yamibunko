import { execa } from "execa"

import type { PlaybackProfile } from "@/lib/types"
import { getServerConfig } from "@/server/config"

export async function ffprobe(file: string) {
  const config = getServerConfig()
  const { stdout } = await execa(
    config.ffprobePath,
    [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      file,
    ],
    { windowsHide: true }
  )

  return JSON.parse(stdout) as unknown
}

export function runFfmpeg(args: string[]) {
  const config = getServerConfig()
  return execa(config.ffmpegPath, args, { windowsHide: true })
}

export function getLiveH264Args(profile: PlaybackProfile) {
  const config = getServerConfig()
  const audioBitrate = profile === "dataSaver" ? "128k" : "192k"

  const profileArgs =
    profile === "dataSaver"
      ? [
          "-vf",
          "scale=-2:720",
          "-b:v",
          "1800k",
          "-maxrate",
          "2200k",
          "-bufsize",
          "3600k",
        ]
      : ["-crf", "20"]

  const encoderArgs =
    config.transcodeAccel === "nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p5"]
      : config.transcodeAccel === "qsv"
        ? ["-c:v", "h264_qsv", "-preset", "veryfast"]
        : ["-c:v", "libx264", "-preset", "veryfast"]

  return [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    ...encoderArgs,
    ...profileArgs,
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
  ]
}
