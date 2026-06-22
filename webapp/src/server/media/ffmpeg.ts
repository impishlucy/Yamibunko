import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { execa } from "execa"

import { registerImportEncodingProcess } from "@/server/transcode/processPriority"

import type { PlaybackProfile } from "@/lib/types"
import {
  getServerConfig,
  type FileEncodeAcceleration,
  type ImportEncoding,
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

export function runFfmpeg(
  args: string[],
  options: {
    priorityRole?: "import-encoding"
    protectFromParentSignals?: boolean
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

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString()
    stderrTail = `${stderrTail}${text}`.slice(-ffmpegStderrTailMaxLength)

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

  if (options.priorityRole === "import-encoding") {
    registerImportEncodingProcess(child)
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

export function getLiveTranscodeInputArgs() {
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

    case "intel_gpu":
    case "intel_cpu":
      return ["-c:v", "h264_qsv", "-preset", "faster", "-async_depth", "8"]

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
      return ["-c:v", "libx264", "-preset", "superfast"]
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

function getAmdAv1EncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const bitrateArgs = getFileVideoBitrateArgs(input)

  switch (getAmdBackend()) {
    case "amf":
      return [
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

    case "vaapi":
      return [
        "-c:v",
        "av1_vaapi",
        "-rc_mode",
        "VBR",
        "-compression_level",
        "3",
        ...bitrateArgs,
      ]
  }
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

function getLiveAvcAacArgs(input: {
  castCompatible?: boolean
  includeMp4Tag: boolean
  options?: { audioStreamIndex?: number; sourceBitrateKbps?: number }
}) {
  const config = getServerConfig()
  const encoderArgs = getLiveAvcEncoderArgs(config.transcodeAccel, {
    castCompatible: input.castCompatible,
  })
  const qualityArgs = getLiveOriginalQualityArgs(
    config.transcodeAccel,
    input.options?.sourceBitrateKbps
  )
  const audioMap = Number.isInteger(input.options?.audioStreamIndex)
    ? `0:${input.options?.audioStreamIndex}?`
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
    "-sc_threshold",
    "0",
    ...getLiveBrowserAvcArgs(config.transcodeAccel, {
      castCompatible: input.castCompatible,
    }),
    ...(input.includeMp4Tag ? ["-tag:v", "avc1"] : []),
    ...getLcAacStereoArgs(),
  ]
}

export function getLiveMp4AvcAacArgs(
  _profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  return getLiveAvcAacArgs({ includeMp4Tag: true, options })
}

export function getLiveCastMp4AvcAacArgs(
  _profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  return getLiveAvcAacArgs({ castCompatible: true, includeMp4Tag: true, options })
}

export function getLiveHlsAvcAacArgs(
  _profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  return getLiveAvcAacArgs({ includeMp4Tag: false, options })
}

export function getLiveCastHlsAvcAacArgs(
  _profile: PlaybackProfile,
  options: { audioStreamIndex?: number; sourceBitrateKbps?: number } = {}
) {
  return getLiveAvcAacArgs({ castCompatible: true, includeMp4Tag: false, options })
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

  switch (acceleration) {
    case "nvenc":
      return ["-rc:v", "vbr", "-cq:v", "20", ...bitrateArgs]
    case "intel_gpu":
    case "intel_cpu":
      return ["-global_quality:v", "20", ...bitrateArgs]
    case "amd_gpu":
    case "amd_cpu":
      return [...getAmdLiveQualityArgs(), ...bitrateArgs]
    case "cpu":
      return ["-crf", "20", ...bitrateArgs]
  }
}

function getAmdLiveQualityArgs() {
  switch (getAmdBackend()) {
    case "amf":
      return ["-rc", "qvbr", "-qvbr_quality_level", "20"]

    case "vaapi":
      return ["-rc_mode", "VBR"]
  }
}

function getLiveAvcFormatArgs(acceleration: TranscodeAcceleration) {
  switch (acceleration) {
    case "nvenc":
      return ["-vf", "format=yuv420p"]

    case "intel_gpu":
    case "intel_cpu":
      return ["-vf", "format=nv12"]

    case "amd_gpu":
    case "amd_cpu":
      switch (getAmdBackend()) {
        case "amf":
          return ["-vf", "format=yuv420p"]

        case "vaapi":
          return ["-vf", "scale_vaapi=format=nv12"]
      }

    case "cpu":
      return []
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
  options: { castCompatible?: boolean } = {}
) {
  const args = options.castCompatible
    ? ["-profile:v", "high", "-level:v", "4.1"]
    : ["-profile:v", "high"]

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

function getAv1FileEncoderArgs(input: {
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  const { transcodeAccel } = getServerConfig()

  if (!isFileEncodeAcceleration(transcodeAccel)) {
    throw new Error(
      "AV1 file encoding requires hardware acceleration. CPU AV1 encoding is deprecated."
    )
  }

  const bitrateArgs = getFileVideoBitrateArgs(input)

  switch (transcodeAccel) {
    case "nvenc":
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

    case "intel_gpu":
    case "intel_cpu":
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

    case "amd_gpu":
    case "amd_cpu":
      return getAmdAv1EncoderArgs(input)
  }
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
  importEncoding: ImportEncoding
  videoBitrateKbps: number
  maxVideoBitrateKbps: number
}) {
  switch (input.importEncoding) {
    case "av1":
      return getAv1FileEncoderArgs(input)
    case "hevc":
      return getHevcFileEncoderArgs(input)
    case "none":
      throw new Error("File encoding is disabled.")
  }
}

function getFileVideoTagArgs(importEncoding: ImportEncoding) {
  switch (importEncoding) {
    case "av1":
      return ["-tag:v", "av01"]
    case "hevc":
      return ["-tag:v", "hvc1"]
    case "none":
      return []
  }
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
  importEncoding: ImportEncoding
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
        ...getFileVideoTagArgs(input.importEncoding),
      ]
    : ["-c:v", "copy", ...getFileVideoTagArgs(input.importEncoding)]
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
