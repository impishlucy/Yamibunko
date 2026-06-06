import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { execa } from "execa"

import type { PlaybackProfile } from "@/lib/types"
import { getServerConfig, type TranscodeAcceleration } from "@/server/config"

let cachedAmdVaapiDevice: string | undefined

const targetAacBitrate = "320k"

export function getLcAacStereoArgs() {
  return [
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    targetAacBitrate,
    "-ac",
    "2",
  ]
}

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

export function runFfmpeg(
  args: string[],
  options: { protectFromParentSignals?: boolean } = {}
) {
  const config = getServerConfig()

  return execa(config.ffmpegPath, args, {
    windowsHide: true,
    stdin: "ignore",
    cleanup: !options.protectFromParentSignals,
    detached: options.protectFromParentSignals,
  })
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

function getLiveH264EncoderArgs(
  acceleration: TranscodeAcceleration,
  profile: PlaybackProfile
) {
  const dataSaver = profile === "dataSaver"

  if (acceleration === "nvenc") {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      dataSaver ? "p1" : "p2",
      "-tune",
      dataSaver ? "ll" : "hq",
      ...(dataSaver
        ? []
        : [
            "-spatial-aq",
            "1",
            "-temporal-aq",
            "1",
            "-aq-strength",
            "6",
            "-rc-lookahead",
            "16",
            "-bf",
            "3",
            "-b_ref_mode",
            "middle",
          ]),
    ]
  }

  if (acceleration === "qsv") {
    return [
      "-c:v",
      "h264_qsv",
      "-preset",
      dataSaver ? "veryfast" : "faster",
      "-async_depth",
      "8",
    ]
  }

  if (acceleration === "amd") {
    return getAmdBackend() === "amf"
      ? [
          "-c:v",
          "h264_amf",
          "-usage",
          dataSaver ? "lowlatency" : "lowlatency_high_quality",
          "-quality",
          dataSaver ? "speed" : "balanced",
        ]
      : ["-c:v", "h264_vaapi"]
  }

  return ["-c:v", "libx264", "-preset", dataSaver ? "ultrafast" : "superfast"]
}

function getFileVideoBitrateArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  return [
    "-b:v",
    `${input.videoBitrateKbps}k`,
    "-maxrate",
    `${input.maxVideoBitrateKbps}k`,
    "-bufsize",
    `${input.maxVideoBitrateKbps * 2}k`,
  ]
}

function getAmdHevcEncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const bitrateArgs = getFileVideoBitrateArgs(input)

  return getAmdBackend() === "amf"
    ? [
        "-c:v",
        "hevc_amf",
        "-usage",
        "high_quality",
        "-quality",
        "quality",
        "-rc",
        "hqvbr",
        "-preanalysis",
        "true",
        "-pa_lookahead_buffer_depth",
        "40",
        "-pa_paq_mode",
        "caq",
        "-pa_taq_mode",
        "2",
        "-pa_high_motion_quality_boost_mode",
        "auto",
        ...bitrateArgs,
      ]
    : [
        "-c:v",
        "hevc_vaapi",
        "-rc_mode",
        "VBR",
        "-compression_level",
        "2",
        ...bitrateArgs,
      ]
}

export function getLiveH264Args(
  profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  const config = getServerConfig()
  const encoderArgs = getLiveH264EncoderArgs(config.transcodeAccel, profile)

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

  const audioMap = Number.isInteger(options.audioStreamIndex)
    ? `0:${options.audioStreamIndex}?`
    : "0:a:0?"

  return [
    "-map",
    "0:V:0",
    "-map",
    audioMap,
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
    ...getLcAacStereoArgs(),
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
    return [...getAmdLiveQualityArgs("original"), ...bitrateArgs]
  }

  return ["-crf", "20", ...bitrateArgs]
}

function getAmdLiveQualityArgs(profile: PlaybackProfile) {
  const dataSaver = profile === "dataSaver"

  if (getAmdBackend() === "amf") {
    return [
      "-rc",
      "qvbr",
      "-qvbr_quality_level",
      dataSaver ? "30" : "20",
    ]
  }

  return ["-rc_mode", "VBR"]
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
  const targetTotalKbps = Math.min(
    Math.floor((sourceBitrateKbps ?? 4000) * 0.45),
    3500
  )

  return Math.max(targetTotalKbps - Number.parseInt(targetAacBitrate, 10), 500)
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
      "-cq:v",
      "30",
      ...bitrateArgs,
    ]
  }

  if (acceleration === "qsv") {
    return [
      ...getLiveH264FormatArgs(acceleration),
      "-global_quality:v",
      "30",
      ...bitrateArgs,
    ]
  }

  if (acceleration === "amd") {
    return [
      ...getLiveH264FormatArgs(acceleration),
      ...getAmdLiveQualityArgs("dataSaver"),
      ...bitrateArgs,
    ]
  }

  return [
    ...getLiveH264FormatArgs(acceleration),
    "-crf",
    "30",
    ...bitrateArgs,
  ]
}

export function getHevcFileArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
  convertVideo: boolean
  audioOutputIndexesToAac: number[]
  subtitleStreamIndexesToMovText: number[]
}) {
  const config = getServerConfig()
  const bitrateArgs = getFileVideoBitrateArgs(input)

  const videoArgs = input.convertVideo
    ? config.transcodeAccel === "nvenc"
      ? [
          "-c:v",
          "hevc_nvenc",
          "-preset",
          "p5",
          "-tune",
          "hq",
          "-rc:v",
          "vbr",
          "-cq:v",
          "21",
          ...bitrateArgs,
          "-multipass",
          "fullres",
          "-spatial-aq",
          "1",
          "-temporal-aq",
          "1",
          "-aq-strength",
          "8",
          "-rc-lookahead",
          "32",
          "-bf",
          "4",
          "-b_ref_mode",
          "middle",
        ]
      : config.transcodeAccel === "qsv"
        ? [
            "-c:v",
            "hevc_qsv",
            "-preset",
            "slow",
            "-async_depth",
            "6",
            "-extbrc",
            "1",
            "-look_ahead",
            "1",
            "-look_ahead_depth",
            "40",
            "-adaptive_i",
            "1",
            "-adaptive_b",
            "1",
            "-mbbrc",
            "1",
            "-bf",
            "4",
            "-b_strategy",
            "1",
            ...bitrateArgs,
          ]
        : config.transcodeAccel === "amd"
          ? getAmdHevcEncoderArgs(input)
          : [
              "-c:v",
              "libx265",
              "-preset",
              "slow",
              "-crf",
              "20",
              "-x265-params",
              `vbv-maxrate=${input.maxVideoBitrateKbps}:vbv-bufsize=${input.maxVideoBitrateKbps * 2}:aq-mode=3:psy-rd=2.0:psy-rdoq=1.0`,
            ]
    : ["-c:v", "copy"]

  const audioArgs = [
    "-c:a",
    "copy",
    ...input.audioOutputIndexesToAac.flatMap((outputAudioIndex) => [
      `-c:a:${outputAudioIndex}`,
      "aac",
      `-profile:a:${outputAudioIndex}`,
      "aac_low",
      `-b:a:${outputAudioIndex}`,
      targetAacBitrate,
      `-ac:a:${outputAudioIndex}`,
      "2",
    ]),
  ]
  const subtitleMapArgs = input.subtitleStreamIndexesToMovText.flatMap(
    (streamIndex) => ["-map", `0:${streamIndex}`]
  )
  const subtitleArgs = input.subtitleStreamIndexesToMovText.length
    ? ["-c:s", "mov_text"]
    : []

  return [
    "-map",
    "0:V:0",
    "-map",
    "0:a?",
    ...subtitleMapArgs,
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    ...videoArgs,
    "-tag:v",
    "hvc1",
    ...audioArgs,
    ...subtitleArgs,
    "-dn",
    "-movflags",
    "+faststart",
  ]
}
