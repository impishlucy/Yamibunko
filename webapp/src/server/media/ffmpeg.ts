import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { execa } from "execa"

import type { PlaybackProfile } from "@/lib/types"
import { getServerConfig, type TranscodeAcceleration } from "@/server/config"

let cachedAmdVaapiDevice: string | undefined

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

function getAmdVaapiDevice() {
  if (cachedAmdVaapiDevice) {
    return cachedAmdVaapiDevice
  }

  try {
    const renderNodes = readdirSync("/sys/class/drm")
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort()
    const amdNode = renderNodes.find((entry) => {
      const vendorPath = path.join("/sys/class/drm", entry, "device", "vendor")
      return readFileSync(vendorPath, "utf8").trim().toLowerCase() === "0x1002"
    })

    cachedAmdVaapiDevice = `/dev/dri/${amdNode ?? renderNodes[0] ?? "renderD128"}`
  } catch {
    cachedAmdVaapiDevice = "/dev/dri/renderD128"
  }

  return cachedAmdVaapiDevice
}

function getAmdBackend() {
  if (process.platform === "win32") {
    return "amf"
  }

  if (process.platform === "linux") {
    return "vaapi"
  }

  throw new Error(
    `AMD transcoding is only supported on Windows or Linux. Current platform: ${process.platform}`
  )
}

export function getHardwareInputArgs(
  options: { keepFramesOnDevice?: boolean } = {}
) {
  const config = getServerConfig()

  if (config.transcodeAccel === "nvenc") {
    return options.keepFramesOnDevice
      ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
      : ["-hwaccel", "cuda"]
  }

  if (config.transcodeAccel === "qsv") {
    return options.keepFramesOnDevice
      ? ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
      : ["-hwaccel", "qsv"]
  }

  if (config.transcodeAccel === "amd") {
    const backend = getAmdBackend()

    if (backend === "amf") {
      return options.keepFramesOnDevice
        ? ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]
        : ["-hwaccel", "d3d11va"]
    }

    return options.keepFramesOnDevice
      ? [
          "-vaapi_device",
          getAmdVaapiDevice(),
          "-hwaccel",
          "vaapi",
          "-hwaccel_output_format",
          "vaapi",
        ]
      : ["-vaapi_device", getAmdVaapiDevice(), "-hwaccel", "vaapi"]
  }

  return []
}

export function getLiveTranscodeInputArgs() {
  const config = getServerConfig()

  if (config.transcodeAccel === "amd" && getAmdBackend() === "vaapi") {
    return ["-vaapi_device", getAmdVaapiDevice()]
  }

  return getHardwareInputArgs()
}

export function getHardwareInputLabel() {
  const config = getServerConfig()

  if (config.transcodeAccel === "nvenc") {
    return "cuda"
  }

  if (config.transcodeAccel === "qsv") {
    return "qsv"
  }

  if (config.transcodeAccel === "amd") {
    return getAmdBackend() === "amf"
      ? "d3d11va/amf"
      : `vaapi:${getAmdVaapiDevice()}`
  }

  return "none"
}

function getAmdH264EncoderArgs() {
  return getAmdBackend() === "amf"
    ? [
        "-c:v",
        "h264_amf",
        "-usage",
        "lowlatency_high_quality",
        "-quality",
        "balanced",
      ]
    : ["-c:v", "h264_vaapi"]
}

function getAmdHevcEncoderArgs(videoBitrateKbps: number) {
  return getAmdBackend() === "amf"
    ? [
        "-c:v",
        "hevc_amf",
        "-usage",
        "high_quality",
        "-quality",
        "quality",
        "-rc",
        "vbr_peak",
        "-b:v",
        `${videoBitrateKbps}k`,
      ]
    : ["-c:v", "hevc_vaapi", "-b:v", `${videoBitrateKbps}k`]
}

export function getLiveH264Args(
  profile: PlaybackProfile,
  options: { sourceBitrateKbps?: number } = {}
) {
  const config = getServerConfig()
  const audioBitrate = profile === "dataSaver" ? "128k" : "192k"

  const encoderArgs =
    config.transcodeAccel === "nvenc"
      ? [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p4",
          "-tune",
          "ll",
          "-spatial-aq",
          "1",
          "-temporal-aq",
          "1",
        ]
      : config.transcodeAccel === "qsv"
        ? ["-c:v", "h264_qsv", "-preset", "veryfast", "-async_depth", "8"]
        : config.transcodeAccel === "amd"
          ? getAmdH264EncoderArgs()
          : ["-c:v", "libx264", "-preset", "fast"]

  const qualityArgs = getLiveOriginalQualityArgs(
    config.transcodeAccel,
    options.sourceBitrateKbps
  )

  const profileArgs =
    profile === "dataSaver"
      ? getLiveDataSaverArgs(
          config.transcodeAccel,
          options.sourceBitrateKbps
        )
      : [...getLiveH264FormatArgs(config.transcodeAccel), ...qualityArgs]

  return [
    "-map",
    "0:V:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    ...encoderArgs,
    ...profileArgs,
    ...getLivePixelFormatArgs(config.transcodeAccel),
    "-g",
    "48",
    "-keyint_min",
    "48",
    ...getLiveBrowserH264Args(config.transcodeAccel),
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
  ]
}

function getLiveOriginalVideoBitrateKbps(sourceBitrateKbps?: number) {
  return Math.min(Math.max(sourceBitrateKbps ?? 6000, 1500), 50_000)
}

function getLiveVideoBitrateArgs(videoBitrateKbps: number) {
  return [
    "-b:v",
    `${videoBitrateKbps}k`,
    "-maxrate",
    `${Math.ceil(videoBitrateKbps * 1.25)}k`,
    "-bufsize",
    `${videoBitrateKbps * 2}k`,
  ]
}

function getLiveOriginalQualityArgs(
  acceleration: TranscodeAcceleration,
  sourceBitrateKbps?: number
) {
  const bitrateArgs = getLiveVideoBitrateArgs(
    getLiveOriginalVideoBitrateKbps(sourceBitrateKbps)
  )

  if (acceleration === "nvenc") {
    return ["-rc:v", "vbr", "-cq:v", "20", ...bitrateArgs]
  }

  if (acceleration === "qsv") {
    return ["-global_quality:v", "20", ...bitrateArgs]
  }

  if (acceleration === "amd") {
    return [...getAmdLiveQualityArgs(), ...bitrateArgs]
  }

  return ["-crf", "20", ...bitrateArgs]
}

function getAmdLiveQualityArgs() {
  if (getAmdBackend() === "amf") {
    return ["-rc", "qvbr", "-qvbr_quality_level", "20"]
  }

  return ["-rc_mode", "CQP", "-qp", "23"]
}

function getLiveH264FormatArgs(acceleration: TranscodeAcceleration) {
  const format = acceleration === "qsv" ? "format=nv12" : "format=yuv420p"

  if (acceleration === "nvenc") {
    return ["-vf", format]
  }

  if (acceleration === "qsv") {
    return ["-vf", format]
  }

  if (acceleration === "amd") {
    return getAmdBackend() === "amf"
      ? ["-vf", format]
      : ["-vf", "format=nv12,hwupload"]
  }

  return []
}

function getLivePixelFormatArgs(acceleration: TranscodeAcceleration) {
  return acceleration === "cpu" ? ["-pix_fmt", "yuv420p"] : []
}

function getLiveBrowserH264Args(acceleration: TranscodeAcceleration) {
  const args = ["-profile:v", "high"]

  if (acceleration === "nvenc") {
    return [...args, "-forced-idr:v", "1"]
  }

  if (acceleration === "cpu") {
    return [...args, "-tune", "zerolatency"]
  }

  return args
}

function calculateLiveDataSaverVideoBitrateKbps(sourceBitrateKbps?: number) {
  const targetTotalKbps = Math.floor((sourceBitrateKbps ?? 4000) / 2)
  return Math.max(targetTotalKbps - 128, 500)
}

function getLiveDataSaverBitrateArgs(videoBitrateKbps: number) {
  return getLiveVideoBitrateArgs(videoBitrateKbps)
}

function getLiveDataSaverArgs(
  acceleration: TranscodeAcceleration,
  sourceBitrateKbps?: number
) {
  const videoBitrateKbps =
    calculateLiveDataSaverVideoBitrateKbps(sourceBitrateKbps)
  const bitrateArgs = getLiveDataSaverBitrateArgs(videoBitrateKbps)

  if (acceleration === "nvenc") {
    return [
      ...getLiveH264FormatArgs(acceleration),
      "-rc:v",
      "vbr",
      ...bitrateArgs,
    ]
  }

  if (acceleration === "qsv") {
    return [...getLiveH264FormatArgs(acceleration), ...bitrateArgs]
  }

  if (acceleration === "amd") {
    return [
      ...getLiveH264FormatArgs(acceleration),
      ...(getAmdBackend() === "amf" ? ["-rc", "vbr_peak"] : []),
      ...bitrateArgs,
    ]
  }

  return [...getLiveH264FormatArgs(acceleration), ...bitrateArgs]
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
          "p4",
          "-tune",
          "hq",
          "-spatial-aq",
          "1",
          "-temporal-aq",
          "1",
          "-b:v",
          `${input.videoBitrateKbps}k`,
        ]
      : config.transcodeAccel === "qsv"
        ? [
            "-c:v",
            "hevc_qsv",
            "-preset",
            "veryfast",
            "-async_depth",
            "8",
            "-b:v",
            `${input.videoBitrateKbps}k`,
          ]
        : config.transcodeAccel === "amd"
          ? getAmdHevcEncoderArgs(input.videoBitrateKbps)
          : [
              "-c:v",
              "libx265",
              "-preset",
              "medium",
              "-b:v",
              `${input.videoBitrateKbps}k`,
            ]
    : ["-c:v", "copy"]

  const audioArgs = input.convertAudioToMp3
    ? ["-c:a", "libmp3lame", "-b:a", "256k"]
    : ["-c:a", "copy"]

  return [
    "-map",
    "0:V:0",
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
