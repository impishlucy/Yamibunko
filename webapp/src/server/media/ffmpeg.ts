import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { execa } from "execa"

import { registerFileEncodingProcess } from "@/server/transcode/processPriority"

import type { PlaybackProfile } from "@/lib/types"
import {
  getServerConfig,
  type FileEncodeAcceleration,
  type TranscodeAcceleration,
} from "@/server/config"

let cachedAmdVaapiDevice: string | undefined
let cachedQsvDevice: string | undefined

const targetAacBitrate = "320k"
const targetOpusBitrate = "320k"

export const mp4FileExtension = ".mp4"
export const mp4OutputFormat = "mp4"
export const webmFileExtension = ".webm"

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

export function getOpusStereoArgs() {
  return [
    "-c:a",
    "libopus",
    "-b:a",
    targetOpusBitrate,
    "-ac",
    "2",
    "-vbr",
    "on",
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

const ffmpegFatalStderrPatterns = [/cannot allocate memory/i]
const ffmpegStderrTailMaxLength = 8000

export type FfmpegProgress = {
  outTimeSeconds: number
  speed: number | null
  status: string | null
}

function parseFfmpegProgressSeconds(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10)

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }

  return parsed / 1_000_000
}

function parseFfmpegProgressSpeed(value: string | undefined) {
  const parsed = Number.parseFloat((value ?? "").replace(/x$/i, ""))

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function runFfmpeg(
  args: string[],
  options: {
    priorityRole?: "file-encoding"
    protectFromParentSignals?: boolean
    onProgress?: (progress: FfmpegProgress) => void
  } = {}
) {
  const config = getServerConfig()

  const child = execa(config.ffmpegPath, args, {
    windowsHide: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    buffer: false,
    cleanup: !options.protectFromParentSignals,
    detached: options.protectFromParentSignals,
  })
  let stderrTail = ""
  let fatalStderrDetected = false
  let processExited = false
  let progressLineBuffer = ""
  const progressFields: Record<string, string> = {}

  const terminateFfmpeg = () => {
    if (processExited) {
      return
    }

    child.kill("SIGTERM")
    setTimeout(() => {
      if (!processExited) {
        child.kill("SIGKILL")
      }
    }, 1000)
  }

  child.once("exit", () => {
    processExited = true
  })

  const emitProgress = () => {
    if (!options.onProgress) {
      return
    }

    try {
      options.onProgress({
        outTimeSeconds: parseFfmpegProgressSeconds(progressFields.out_time_ms),
        speed: parseFfmpegProgressSpeed(progressFields.speed),
        status: progressFields.progress ?? null,
      })
    } catch (error) {
      void error
    }
  }

  const consumeProgressOutput = (text: string) => {
    if (!options.onProgress) {
      return
    }

    progressLineBuffer += text
    const lines = progressLineBuffer.split(/\r?\n/)
    progressLineBuffer = lines.pop() ?? ""

    for (const line of lines) {
      const separatorIndex = line.indexOf("=")

      if (separatorIndex <= 0) {
        continue
      }

      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1).trim()

      if (!key) {
        continue
      }

      progressFields[key] = value

      if (key === "progress") {
        emitProgress()
      }
    }
  }

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString()
    stderrTail = `${stderrTail}${text}`.slice(-ffmpegStderrTailMaxLength)
    consumeProgressOutput(text)

    if (fatalStderrDetected) {
      return
    }

    if (!ffmpegFatalStderrPatterns.some((pattern) => pattern.test(text))) {
      return
    }

    fatalStderrDetected = true
    terminateFfmpeg()
  })

  void child.catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      !("stderr" in error) &&
      stderrTail.trim()
    ) {
      Object.defineProperty(error, "stderr", {
        value: stderrTail,
        configurable: true,
      })
    }
  })

  if (options.priorityRole === "file-encoding") {
    registerFileEncodingProcess(child)
  }

  return child
}

function findLinuxRenderDevice(vendorId: string) {
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
  cachedAmdVaapiDevice ??= findLinuxRenderDevice("0x1002")
  return cachedAmdVaapiDevice
}

function getQsvDevice() {
  cachedQsvDevice ??= findLinuxRenderDevice("0x8086")
  return cachedQsvDevice
}

function getAmdBackend() {
  switch (process.platform) {
    case "win32":
      return "amf"

    case "linux":
      return "vaapi"

    default:
      throw new Error(
        `AMD transcoding is only supported on Windows or Linux. Current platform: ${process.platform}`
      )
  }
}

export function getHardwareInputArgs(
  options: { keepFramesOnDevice?: boolean } = {}
) {
  const config = getServerConfig()

  switch (config.transcodeAccel) {
    case "nvenc":
      return options.keepFramesOnDevice
        ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
        : ["-hwaccel", "cuda"]

    case "intel_gpu":
    case "intel_cpu": {
      const deviceArgs =
        process.platform === "linux" ? ["-qsv_device", getQsvDevice()] : []

      return options.keepFramesOnDevice
        ? [...deviceArgs, "-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
        : [...deviceArgs, "-hwaccel", "qsv"]
    }

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return options.keepFramesOnDevice
            ? ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]
            : ["-hwaccel", "d3d11va"]

        case "vaapi":
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

    case "cpu":
      return []
  }
}

function normalizeInputVideoCodec(codec: string | null | undefined) {
  return (codec ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_")
}

function mappedHardwareDecoder(
  codec: string | null | undefined,
  decoders: Record<string, string>
) {
  return decoders[normalizeInputVideoCodec(codec)]
}

function getNvidiaInputDecoder(codec: string | null | undefined) {
  return mappedHardwareDecoder(codec, {
    av1: "av1_cuvid",
    avc: "h264_cuvid",
    avc1: "h264_cuvid",
    h264: "h264_cuvid",
    h265: "hevc_cuvid",
    hevc: "hevc_cuvid",
    mjpeg: "mjpeg_cuvid",
    mpeg1video: "mpeg1_cuvid",
    mpeg2video: "mpeg2_cuvid",
    mpeg4: "mpeg4_cuvid",
    vc1: "vc1_cuvid",
    vp8: "vp8_cuvid",
    vp9: "vp9_cuvid",
    wmv3: "vc1_cuvid",
  })
}

function getIntelInputDecoder(codec: string | null | undefined) {
  return mappedHardwareDecoder(codec, {
    av1: "av1_qsv",
    avc: "h264_qsv",
    avc1: "h264_qsv",
    h264: "h264_qsv",
    h265: "hevc_qsv",
    hevc: "hevc_qsv",
    mjpeg: "mjpeg_qsv",
    mpeg2video: "mpeg2_qsv",
    vp9: "vp9_qsv",
  })
}

export function getHardwareInputArgsForCodec(input: {
  inputVideoCodec?: string | null
  keepFramesOnDevice?: boolean
}) {
  const config = getServerConfig()
  const baseArgs = getHardwareInputArgs({
    keepFramesOnDevice: input.keepFramesOnDevice,
  })

  switch (config.transcodeAccel) {
    case "nvenc": {
      const decoder = getNvidiaInputDecoder(input.inputVideoCodec)
      return decoder ? [...baseArgs, "-c:v", decoder] : baseArgs
    }

    case "intel_gpu":
    case "intel_cpu": {
      const decoder = getIntelInputDecoder(input.inputVideoCodec)
      return decoder ? [...baseArgs, "-c:v", decoder] : baseArgs
    }

    case "amd_gpu":
    case "amd_cpu":
    case "cpu":
      return baseArgs
  }
}

export function getFileHardwareInputArgs(input: {
  inputVideoCodec?: string | null
  keepFramesOnDevice?: boolean
}) {
  const config = getServerConfig()

  switch (config.transcodeAccel) {
    case "nvenc":
    case "intel_gpu":
    case "intel_cpu":
      return getHardwareInputArgsForCodec({
        inputVideoCodec: input.inputVideoCodec,
        keepFramesOnDevice: input.keepFramesOnDevice,
      })

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return getHardwareInputArgs({
            keepFramesOnDevice: input.keepFramesOnDevice,
          })

        case "vaapi":
          return getHardwareInputArgs({ keepFramesOnDevice: true })
      }

    case "cpu":
      return getHardwareInputArgs({
        keepFramesOnDevice: input.keepFramesOnDevice,
      })
  }
}

export function getLiveTranscodeInputArgs(inputVideoCodec?: string | null) {
  const config = getServerConfig()

  switch (config.transcodeAccel) {
    case "amd_gpu":
    case "amd_cpu":
      if (getAmdBackend() === "vaapi") {
        return ["-vaapi_device", getAmdVaapiDevice()]
      }

      return getHardwareInputArgs()

    case "nvenc":
    case "intel_gpu":
    case "intel_cpu":
      return getHardwareInputArgsForCodec({ inputVideoCodec })

    case "cpu":
      return getHardwareInputArgs()
  }
}

export function getHardwareInputLabel() {
  const config = getServerConfig()

  switch (config.transcodeAccel) {
    case "nvenc":
      return "cuda"
    case "intel_gpu":
    case "intel_cpu":
      return process.platform === "linux" ? `qsv:${getQsvDevice()}` : "qsv"
    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return "d3d11va/amf"

        case "vaapi":
          return `vaapi:${getAmdVaapiDevice()}`
      }
    case "cpu":
      return "none"
  }
}

function getLiveAvcEncoderArgs(
  acceleration: TranscodeAcceleration,
  options: { castCompatible?: boolean } = {}
) {
  if (options.castCompatible) {
    return getLiveCastAvcEncoderArgs(acceleration)
  }

  switch (acceleration) {
    case "nvenc":
      return [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p2",
        "-tune",
        "hq",
        "-rc-lookahead",
        "0",
        "-bf",
        "0",
      ]

    case "intel_gpu":
    case "intel_cpu":
      return ["-c:v", "h264_qsv", "-preset", "faster", "-async_depth", "8", "-bf", "0"]

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return [
            "-c:v",
            "h264_amf",
            "-usage",
            "lowlatency_high_quality",
            "-quality",
            "balanced",
          ]

        case "vaapi":
          return ["-c:v", "h264_vaapi"]
      }

    case "cpu":
      return ["-c:v", "libx264", "-preset", "superfast", "-bf", "0"]
  }
}


function getLiveCastAvcEncoderArgs(acceleration: TranscodeAcceleration) {
  switch (acceleration) {
    case "nvenc":
      return [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p2",
        "-tune",
        "hq",
        "-rc-lookahead",
        "0",
        "-bf",
        "0",
      ]

    case "intel_gpu":
    case "intel_cpu":
      return ["-c:v", "h264_qsv", "-preset", "faster", "-async_depth", "8", "-bf", "0"]

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return [
            "-c:v",
            "h264_amf",
            "-usage",
            "lowlatency_high_quality",
            "-quality",
            "balanced",
          ]

        case "vaapi":
          return ["-c:v", "h264_vaapi"]
      }

    case "cpu":
      return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-bf", "0"]
  }
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

  switch (getAmdBackend()) {
    case "amf":
      return [
        "-c:v",
        "hevc_amf",
        "-usage",
        "high_quality",
        "-quality",
        "balanced",
        "-rc",
        "vbr_peak",
        ...bitrateArgs,
      ]

    case "vaapi":
      return [
        "-c:v",
        "hevc_vaapi",
        "-rc_mode",
        "VBR",
        "-compression_level",
        "3",
        ...bitrateArgs,
      ]
  }
}

type LiveTranscodeVideoShape = {
  width?: number
  height?: number
  frameRate?: number
}

function getH264LevelForLiveTranscode(input: LiveTranscodeVideoShape = {}) {
  const width = Math.ceil(input.width ?? 0)
  const height = Math.ceil(input.height ?? 0)
  const inputFrameRate = input.frameRate
  const frameRate =
    typeof inputFrameRate === "number" &&
    Number.isFinite(inputFrameRate) &&
    inputFrameRate > 0
      ? inputFrameRate
      : 30

  if (width <= 0 || height <= 0) {
    return "4.1"
  }

  const frameMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const macroblocksPerSecond = frameMacroblocks * frameRate

  if (frameMacroblocks <= 8192 && macroblocksPerSecond <= 245760) {
    return "4.1"
  }

  if (frameMacroblocks <= 8704 && macroblocksPerSecond <= 522240) {
    return "4.2"
  }

  if (frameMacroblocks <= 22080 && macroblocksPerSecond <= 589824) {
    return "5.0"
  }

  if (frameMacroblocks <= 36864 && macroblocksPerSecond <= 983040) {
    return "5.1"
  }

  return "5.2"
}

function evenDimension(value: number) {
  const rounded = Math.max(Math.floor(value), 2)

  return rounded % 2 === 0 ? rounded : rounded - 1
}

function getLiveOutputShape(input: {
  sourceWidth?: number
  sourceHeight?: number
  maxWidth?: number
  maxHeight?: number
}) {
  const sourceWidth = Math.trunc(input.sourceWidth ?? 0)
  const sourceHeight = Math.trunc(input.sourceHeight ?? 0)
  const maxWidth = Math.trunc(input.maxWidth ?? 0)
  const maxHeight = Math.trunc(input.maxHeight ?? 0)

  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
    return { width: sourceWidth || undefined, height: sourceHeight || undefined }
  }

  if (sourceWidth <= maxWidth && sourceHeight <= maxHeight) {
    return { width: sourceWidth, height: sourceHeight }
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight)

  return {
    width: evenDimension(sourceWidth * scale),
    height: evenDimension(sourceHeight * scale),
  }
}

function getLiveVideoFilterArgs(
  acceleration: TranscodeAcceleration,
  outputShape: { width?: number; height?: number },
  sourceShape: { width?: number; height?: number }
) {
  const shouldScale =
    typeof outputShape.width === "number" &&
    typeof outputShape.height === "number" &&
    outputShape.width > 0 &&
    outputShape.height > 0 &&
    (outputShape.width !== sourceShape.width || outputShape.height !== sourceShape.height)

  const scaleFilter = shouldScale ? `scale=${outputShape.width}:${outputShape.height}` : null

  switch (acceleration) {
    case "nvenc":
      return ["-vf", [scaleFilter, "format=yuv420p"].filter(Boolean).join(",")]

    case "amd_gpu":
    case "amd_cpu":
      if (getAmdBackend() === "vaapi") {
        return shouldScale
          ? ["-vf", `scale_vaapi=${outputShape.width}:${outputShape.height}:format=nv12`]
          : ["-vf", "scale_vaapi=format=nv12"]
      }

      return ["-vf", [scaleFilter, "format=yuv420p"].filter(Boolean).join(",")]

    case "intel_gpu":
    case "intel_cpu":
      return ["-vf", [scaleFilter, "format=nv12"].filter(Boolean).join(",")]

    case "cpu":
      return scaleFilter ? ["-vf", scaleFilter] : []
  }
}

function getLiveAvcAacArgs(input: {
  castCompatible?: boolean
  includeMp4Tag: boolean
  options?: {
    audioStreamIndex?: number
    sourceBitrateKbps?: number
    videoBitrateKbps?: number
    videoWidth?: number
    videoHeight?: number
    videoFrameRate?: number
    maxVideoWidth?: number
    maxVideoHeight?: number
  }
}) {
  const config = getServerConfig()
  const encoderArgs = getLiveAvcEncoderArgs(config.transcodeAccel, {
    castCompatible: input.castCompatible,
  })
  const qualityArgs = getLiveOriginalQualityArgs(config.transcodeAccel, {
    sourceBitrateKbps: input.options?.sourceBitrateKbps,
    videoBitrateKbps: input.options?.videoBitrateKbps,
  })
  const audioMap = Number.isInteger(input.options?.audioStreamIndex)
    ? `0:${input.options?.audioStreamIndex}?`
    : "0:a:0?"
  const outputShape = getLiveOutputShape({
    sourceWidth: input.options?.videoWidth,
    sourceHeight: input.options?.videoHeight,
    maxWidth: input.options?.maxVideoWidth,
    maxHeight: input.options?.maxVideoHeight,
  })

  return [
    "-map",
    "0:V:0",
    "-map",
    audioMap,
    "-sn",
    "-dn",
    ...encoderArgs,
    ...getLiveVideoFilterArgs(
      config.transcodeAccel,
      outputShape,
      { width: input.options?.videoWidth, height: input.options?.videoHeight }
    ),
    ...qualityArgs,
    ...getLivePixelFormatArgs(config.transcodeAccel),
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    ...getLiveBrowserAvcArgs(config.transcodeAccel, {
      width: outputShape.width,
      height: outputShape.height,
      frameRate: input.options?.videoFrameRate,
    }),
    ...(input.includeMp4Tag ? ["-tag:v", "avc1"] : []),
    ...getLcAacStereoArgs(),
  ]
}

export function getLiveMp4AvcAacArgs(
  _profile: PlaybackProfile,
  options: {
    audioStreamIndex?: number
    sourceBitrateKbps?: number
    videoBitrateKbps?: number
    videoWidth?: number
    videoHeight?: number
    videoFrameRate?: number
    maxVideoWidth?: number
    maxVideoHeight?: number
  } = {}
) {
  return getLiveAvcAacArgs({ includeMp4Tag: true, options })
}

export function getLiveCastMp4AvcAacArgs(
  _profile: PlaybackProfile,
  options: {
    audioStreamIndex?: number
    sourceBitrateKbps?: number
    videoBitrateKbps?: number
    videoWidth?: number
    videoHeight?: number
    videoFrameRate?: number
    maxVideoWidth?: number
    maxVideoHeight?: number
  } = {}
) {
  return getLiveAvcAacArgs({ castCompatible: true, includeMp4Tag: true, options })
}

export function getLiveHlsAvcAacArgs(
  _profile: PlaybackProfile,
  options: {
    audioStreamIndex?: number
    sourceBitrateKbps?: number
    videoBitrateKbps?: number
    videoWidth?: number
    videoHeight?: number
    videoFrameRate?: number
    maxVideoWidth?: number
    maxVideoHeight?: number
  } = {}
) {
  return getLiveAvcAacArgs({ includeMp4Tag: false, options })
}

export function getLiveCastHlsAvcAacArgs(
  _profile: PlaybackProfile,
  options: {
    audioStreamIndex?: number
    sourceBitrateKbps?: number
    videoBitrateKbps?: number
    videoWidth?: number
    videoHeight?: number
    videoFrameRate?: number
    maxVideoWidth?: number
    maxVideoHeight?: number
  } = {}
) {
  return getLiveAvcAacArgs({ castCompatible: true, includeMp4Tag: false, options })
}

function getLiveOriginalVideoBitrateKbps(input: {
  sourceBitrateKbps?: number
  videoBitrateKbps?: number
}) {
  return Math.max(
    Math.ceil(input.videoBitrateKbps ?? input.sourceBitrateKbps ?? 6000),
    1
  )
}

function getLiveVideoBitrateArgs(videoBitrateKbps: number) {
  return [
    "-b:v",
    `${videoBitrateKbps}k`,
    "-maxrate",
    `${videoBitrateKbps}k`,
    "-bufsize",
    `${videoBitrateKbps * 2}k`,
  ]
}

function getLiveOriginalQualityArgs(
  acceleration: TranscodeAcceleration,
  input: { sourceBitrateKbps?: number; videoBitrateKbps?: number }
) {
  const bitrateArgs = getLiveVideoBitrateArgs(
    getLiveOriginalVideoBitrateKbps(input)
  )

  switch (acceleration) {
    case "nvenc":
      return ["-rc:v", "vbr", ...bitrateArgs]
    case "intel_gpu":
    case "intel_cpu":
      return bitrateArgs
    case "amd_gpu":
    case "amd_cpu":
      return [...getAmdLiveRateControlArgs(), ...bitrateArgs]
    case "cpu":
      return bitrateArgs
  }
}

function getAmdLiveRateControlArgs() {
  switch (getAmdBackend()) {
    case "amf":
      return ["-rc", "vbr_peak"]

    case "vaapi":
      return ["-rc_mode", "VBR"]
  }
}

function getLivePixelFormatArgs(acceleration: TranscodeAcceleration) {
  switch (acceleration) {
    case "cpu":
      return ["-pix_fmt", "yuv420p"]

    case "nvenc":
    case "intel_gpu":
    case "intel_cpu":
    case "amd_gpu":
    case "amd_cpu":
      return []
  }
}

function getLiveBrowserAvcArgs(
  acceleration: TranscodeAcceleration,
  videoShape: LiveTranscodeVideoShape = {}
) {
  const args = [
    "-profile:v",
    "high",
    "-level:v",
    getH264LevelForLiveTranscode(videoShape),
  ]

  switch (acceleration) {
    case "nvenc":
      return [...args, "-forced-idr:v", "1"]
    case "cpu":
      return [...args, "-tune", "zerolatency"]
    case "intel_gpu":
    case "intel_cpu":
    case "amd_gpu":
    case "amd_cpu":
      return args
  }
}

function isFileEncodeAcceleration(
  acceleration: TranscodeAcceleration
): acceleration is FileEncodeAcceleration {
  return isHardwareAcceleration(acceleration)
}

function getHevcFileEncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const { transcodeAccel } = getServerConfig()

  if (!isFileEncodeAcceleration(transcodeAccel)) {
    throw new Error("HEVC file encoding requires hardware acceleration.")
  }

  const bitrateArgs = getFileVideoBitrateArgs(input)

  switch (transcodeAccel) {
    case "nvenc":
      return [
        "-c:v",
        "hevc_nvenc",
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

    case "intel_gpu":
    case "intel_cpu":
      return [
        "-c:v",
        "hevc_qsv",
        "-preset",
        "medium",
        "-async_depth",
        "6",
        "-global_quality:v",
        "24",
        ...bitrateArgs,
      ]

    case "amd_gpu":
    case "amd_cpu":
      return getAmdHevcEncoderArgs(input)
  }
}

function getFileVideoEncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  return getHevcFileEncoderArgs(input)
}

function getFileVideoTagArgs() {
  return ["-tag:v", "hvc1"]
}

function getFileVideoFilterArgs(acceleration: TranscodeAcceleration) {
  switch (acceleration) {
    case "nvenc":
      return []

    case "intel_gpu":
    case "intel_cpu":
      return ["-vf", "format=nv12"]

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return []

        case "vaapi":
          return ["-vf", "scale_vaapi=format=nv12"]
      }

    case "cpu":
      return []
  }
}

export type FileSubtitleOutputStream = {
  inputIndex: number
  streamIndex: number
  codec: "copy" | "webvtt"
}

export function getFileSubtitleInputArgs() {
  return ["-analyzeduration", "100M", "-probesize", "100M"]
}

export function getMp4FileArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
  convertVideo: boolean
  audioOutputIndexesToOpus: number[]
  fastStart?: boolean
}) {
  const config = getServerConfig()
  const videoArgs = input.convertVideo
    ? [
        ...getFileVideoFilterArgs(config.transcodeAccel),
        ...getFileVideoEncoderArgs(input),
        ...getFileVideoTagArgs(),
      ]
    : ["-c:v", "copy", ...getFileVideoTagArgs()]
  const audioArgs = [
    "-c:a",
    "copy",
    ...input.audioOutputIndexesToOpus.flatMap((outputAudioIndex) => [
      `-c:a:${outputAudioIndex}`,
      "libopus",
      `-b:a:${outputAudioIndex}`,
      "320k",
      `-ac:a:${outputAudioIndex}`,
      "2",
      `-vbr:a:${outputAudioIndex}`,
      "on",
    ]),
  ]

  return [
    "-map",
    "0:V:0",
    "-map",
    "0:a?",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    ...videoArgs,
    ...audioArgs,
    "-sn",
    "-dn",
    ...(input.fastStart === false ? [] : ["-movflags", "+faststart"]),
    "-strict",
    "-2",
    "-f",
    mp4OutputFormat,
  ]
}

export function getWebVttSidecarFileArgs(stream: FileSubtitleOutputStream) {
  return [
    "-map",
    `${stream.inputIndex}:${stream.streamIndex}`,
    "-c:s",
    stream.codec,
    "-f",
    "webvtt",
  ]
}
