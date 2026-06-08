import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { execa } from "execa"

import type { PlaybackProfile } from "@/lib/types"
import {
  getServerConfig,
  type FileEncodeAcceleration,
  type TranscodeAcceleration,
} from "@/server/config"

let cachedAmdVaapiDevice: string | undefined
let cachedQsvDevice: string | undefined

const targetAacBitrate = "320k"

function isIntelAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "intel_gpu" || acceleration === "intel_cpu"
}

function isAmdAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "amd_gpu" || acceleration === "amd_cpu"
}

function isHardwareAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration !== "cpu"
}

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

function isRenderDevicePath(value: string) {
  return /^\/dev\/dri\/renderD\d+$/.test(value)
}

function getConfiguredRenderDevice() {
  const device = getServerConfig().transcodeHwDevice

  return process.platform === "linux" && device && isRenderDevicePath(device)
    ? device
    : undefined
}

function findLinuxRenderDevice(vendorId: string) {
  const configuredDevice = getConfiguredRenderDevice()

  if (configuredDevice) {
    return configuredDevice
  }

  try {
    const renderNodes = readdirSync("/sys/class/drm")
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort()
    const matchingNode = renderNodes.find((entry) => {
      const vendorPath = path.join("/sys/class/drm", entry, "device", "vendor")
      return readFileSync(vendorPath, "utf8").trim().toLowerCase() === vendorId
    })

    return `/dev/dri/${matchingNode ?? renderNodes[0] ?? "renderD128"}`
  } catch {
    return "/dev/dri/renderD128"
  }
}

function getAmdVaapiDevice() {
  if (!cachedAmdVaapiDevice || getConfiguredRenderDevice()) {
    cachedAmdVaapiDevice = findLinuxRenderDevice("0x1002")
  }

  return cachedAmdVaapiDevice
}

function getQsvDevice() {
  if (!cachedQsvDevice || getConfiguredRenderDevice()) {
    cachedQsvDevice = findLinuxRenderDevice("0x8086")
  }

  return cachedQsvDevice
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

  if (isIntelAcceleration(config.transcodeAccel)) {
    const deviceArgs = process.platform === "linux" ? ["-qsv_device", getQsvDevice()] : []

    return options.keepFramesOnDevice
      ? [...deviceArgs, "-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
      : [...deviceArgs, "-hwaccel", "qsv"]
  }

  if (isAmdAcceleration(config.transcodeAccel)) {
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

  if (isAmdAcceleration(config.transcodeAccel) && getAmdBackend() === "vaapi") {
    return ["-vaapi_device", getAmdVaapiDevice()]
  }

  return getHardwareInputArgs()
}

export function getHardwareInputLabel() {
  const config = getServerConfig()

  if (config.transcodeAccel === "nvenc") {
    return "cuda"
  }

  if (isIntelAcceleration(config.transcodeAccel)) {
    return process.platform === "linux" ? `qsv:${getQsvDevice()}` : "qsv"
  }

  if (isAmdAcceleration(config.transcodeAccel)) {
    return getAmdBackend() === "amf"
      ? "d3d11va/amf"
      : `vaapi:${getAmdVaapiDevice()}`
  }

  return "none"
}

function getLiveAvcEncoderArgs(acceleration: TranscodeAcceleration) {
  if (acceleration === "nvenc") {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p2",
      "-tune",
      "hq",
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
    ]
  }

  if (isIntelAcceleration(acceleration)) {
    return ["-c:v", "h264_qsv", "-preset", "faster", "-async_depth", "8"]
  }

  if (isAmdAcceleration(acceleration)) {
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

  return ["-c:v", "libx264", "-preset", "superfast"]
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

function getAmdAv1EncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const bitrateArgs = getFileVideoBitrateArgs(input)

  return getAmdBackend() === "amf"
    ? [
        "-c:v",
        "av1_amf",
        "-usage",
        "high_quality",
        "-quality",
        "balanced",
        "-rc",
        "vbr_peak",
        ...bitrateArgs,
      ]
    : [
        "-c:v",
        "av1_vaapi",
        "-rc_mode",
        "VBR",
        "-compression_level",
        "3",
        ...bitrateArgs,
      ]
}

export function getLiveMp4AvcAacLcArgs(
  _profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  const config = getServerConfig()
  const encoderArgs = getLiveAvcEncoderArgs(config.transcodeAccel)
  const qualityArgs = getLiveOriginalQualityArgs(
    config.transcodeAccel,
    options.sourceBitrateKbps
  )
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
    ...getLiveAvcFormatArgs(config.transcodeAccel),
    ...qualityArgs,
    ...getLivePixelFormatArgs(config.transcodeAccel),
    "-g",
    "48",
    "-keyint_min",
    "48",
    ...getLiveBrowserAvcArgs(config.transcodeAccel),
    "-tag:v",
    "avc1",
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

  if (isIntelAcceleration(acceleration)) {
    return ["-global_quality:v", "20", ...bitrateArgs]
  }

  if (isAmdAcceleration(acceleration)) {
    return [...getAmdLiveQualityArgs(), ...bitrateArgs]
  }

  return ["-crf", "20", ...bitrateArgs]
}

function getAmdLiveQualityArgs() {
  if (getAmdBackend() === "amf") {
    return ["-rc", "qvbr", "-qvbr_quality_level", "20"]
  }

  return ["-rc_mode", "VBR"]
}

function getLiveAvcFormatArgs(acceleration: TranscodeAcceleration) {
  const format = isIntelAcceleration(acceleration) ? "format=nv12" : "format=yuv420p"

  if (acceleration === "nvenc") {
    return ["-vf", format]
  }

  if (isIntelAcceleration(acceleration)) {
    return ["-vf", format]
  }

  if (isAmdAcceleration(acceleration)) {
    return getAmdBackend() === "amf"
      ? ["-vf", format]
      : ["-vf", "format=nv12,hwupload"]
  }

  return []
}

function getLivePixelFormatArgs(acceleration: TranscodeAcceleration) {
  return acceleration === "cpu" ? ["-pix_fmt", "yuv420p"] : []
}

function getLiveBrowserAvcArgs(acceleration: TranscodeAcceleration) {
  const args = ["-profile:v", "high"]

  if (acceleration === "nvenc") {
    return [...args, "-forced-idr:v", "1"]
  }

  if (acceleration === "cpu") {
    return [...args, "-tune", "zerolatency"]
  }

  return args
}

function isFileEncodeAcceleration(
  acceleration: TranscodeAcceleration
): acceleration is FileEncodeAcceleration {
  return isHardwareAcceleration(acceleration)
}

function getAv1FileEncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const config = getServerConfig()

  if (!isFileEncodeAcceleration(config.transcodeAccel)) {
    throw new Error(
      "AV1 file encoding requires hardware acceleration. CPU AV1 encoding is deprecated."
    )
  }

  const bitrateArgs = getFileVideoBitrateArgs(input)

  if (config.transcodeAccel === "nvenc") {
    return [
      "-c:v",
      "av1_nvenc",
      "-preset",
      "p4",
      "-tune",
      "hq",
      "-rc:v",
      "vbr",
      "-cq:v",
      "24",
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
    ]
  }

  if (isIntelAcceleration(config.transcodeAccel)) {
    return [
      "-c:v",
      "av1_qsv",
      "-preset",
      "medium",
      "-async_depth",
      "6",
      "-global_quality:v",
      "24",
      ...bitrateArgs,
    ]
  }

  if (isAmdAcceleration(config.transcodeAccel)) {
    return getAmdAv1EncoderArgs(input)
  }

  throw new Error("Unsupported AV1 hardware encoder.")
}

export type WebmSubtitleOutputStream = {
  inputIndex: number
  streamIndex: number
  codec: "copy" | "webvtt"
}

export function getFileSubtitleInputArgs() {
  return ["-analyzeduration", "100M", "-probesize", "100M"]
}

export function getWebmFileArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
  convertVideo: boolean
  audioOutputIndexesToOpus: number[]
  subtitleStreams: WebmSubtitleOutputStream[]
}) {
  const videoArgs = input.convertVideo
    ? getAv1FileEncoderArgs(input)
    : ["-c:v", "copy"]
  const audioArgs = [
    "-c:a",
    "copy",
    ...input.audioOutputIndexesToOpus.flatMap((outputAudioIndex) => [
      `-c:a:${outputAudioIndex}`,
      "libopus",
      `-b:a:${outputAudioIndex}`,
      "320k",
      `-vbr:a:${outputAudioIndex}`,
      "on",
    ]),
  ]
  const subtitleMapArgs = input.subtitleStreams.flatMap((stream) => [
    "-map",
    `${stream.inputIndex}:${stream.streamIndex}`,
  ])
  const subtitleArgs = input.subtitleStreams.length
    ? input.subtitleStreams.flatMap((stream, outputSubtitleIndex) => [
        `-c:s:${outputSubtitleIndex}`,
        stream.codec,
      ])
    : ["-sn"]

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
    ...audioArgs,
    ...subtitleArgs,
    "-dn",
    "-max_interleave_delta",
    "1000000",
    "-flush_packets",
    "1",
    "-f",
    "webm",
  ]
}
