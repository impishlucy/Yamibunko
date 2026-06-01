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

  const encoderArgs =
    config.transcodeAccel === "nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p5"]
      : config.transcodeAccel === "qsv"
        ? ["-c:v", "h264_qsv", "-preset", "fast"]
        : ["-c:v", "libx264", "-preset", "fast"]

  const qualityArgs =
    config.transcodeAccel === "nvenc"
      ? ["-rc:v", "vbr", "-cq:v", "20", "-b:v", "0"]
      : config.transcodeAccel === "qsv"
        ? ["-global_quality:v", "20"]
        : ["-crf", "20"]

  const profileArgs =
    profile === "dataSaver"
      ? [
          "-vf",
          "scale=-2:720:force_original_aspect_ratio=decrease",
          "-b:v",
          "1800k",
          "-maxrate",
          "2200k",
          "-bufsize",
          "3600k",
        ]
      : qualityArgs

  return [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    ...encoderArgs,
    ...profileArgs,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
  ]
}

export function getHevcFileArgs(input: {
  videoBitrateKbps: number
  convertVideo: boolean
  convertAudioToMp3: boolean
}) {
  const config = getServerConfig()

  const videoArgs = input.convertVideo
    ? config.transcodeAccel === "nvenc"
      ? [
          "-c:v",
          "hevc_nvenc",
          "-preset",
          "p5",
          "-b:v",
          `${input.videoBitrateKbps}k`,
          "-maxrate",
          `${Math.round(input.videoBitrateKbps * 1.25)}k`,
          "-bufsize",
          `${Math.round(input.videoBitrateKbps * 2)}k`,
        ]
      : config.transcodeAccel === "qsv"
        ? [
            "-c:v",
            "hevc_qsv",
            "-preset",
            "veryfast",
            "-b:v",
            `${input.videoBitrateKbps}k`,
            "-maxrate",
            `${Math.round(input.videoBitrateKbps * 1.25)}k`,
            "-bufsize",
            `${Math.round(input.videoBitrateKbps * 2)}k`,
          ]
        : [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-b:v",
            `${input.videoBitrateKbps}k`,
            "-maxrate",
            `${Math.round(input.videoBitrateKbps * 1.25)}k`,
            "-bufsize",
            `${Math.round(input.videoBitrateKbps * 2)}k`,
          ]
    : ["-c:v", "copy"]

  const audioArgs = input.convertAudioToMp3
    ? ["-c:a", "libmp3lame", "-b:a", "256k"]
    : ["-c:a", "copy"]

  return [
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    ...videoArgs,
    ...audioArgs,
    "-c:s",
    "copy",
    "-dn",
  ]
}
