import { constants } from "node:fs"
import { access, open } from "node:fs/promises"
import path from "node:path"

export const subtitleSidecarExtensions = [".vtt", ".ass", ".ssa", ".srt"] as const
export const subtitlesDirectoryName = "Subtitles"

export const webVttSubtitleCodec = "webvtt"

const subtitleCodecAliases = new Map(
  Object.entries({
    vtt: "webvtt",
    web_vtt: "webvtt",
    webvtt: "webvtt",
    ass: "ass",
    ssa: "ssa",
    srt: "subrip",
    subrip: "subrip",
    movtext: "mov_text",
    mov_text: "mov_text",
    text: "text",
    plain_text: "text",
    subviewer: "subviewer",
    subviewer1: "subviewer1",
    sami: "sami",
    smi: "sami",
    microdvd: "microdvd",
    mpl2: "mpl2",
    jacosub: "jacosub",
    realtext: "realtext",
    stl: "stl",
    spritestl: "stl",
    vplayer: "vplayer",
    pjs: "pjs",
    aqtitle: "aqtitle",
    ttml: "ttml",
    dfxp: "ttml",
    sbv: "sbv",
    scc: "scc",
    eia608: "eia_608",
    eia_608: "eia_608",
    cea608: "eia_608",
    cea_608: "eia_608",
  })
)

const webVttSubtitleCodecs = new Set([webVttSubtitleCodec])

const convertibleTextSubtitleCodecs = new Set([
  webVttSubtitleCodec,
  "ass",
  "ssa",
  "subrip",
  "mov_text",
  "text",
  "subviewer",
  "subviewer1",
  "sami",
  "microdvd",
  "mpl2",
  "jacosub",
  "realtext",
  "stl",
  "vplayer",
  "pjs",
  "aqtitle",
  "ttml",
  "sbv",
  "scc",
  "eia_608",
])

const subtitleCodecLabels = new Map(
  Object.entries({
    webvtt: "WebVTT",
    ass: "ASS",
    ssa: "SSA",
    subrip: "SRT",
    mov_text: "mov_text",
    text: "Text",
    subviewer: "SubViewer",
    subviewer1: "SubViewer 1",
    sami: "SAMI",
    microdvd: "MicroDVD",
    mpl2: "MPL2",
    jacosub: "JACOsub",
    realtext: "RealText",
    stl: "STL",
    vplayer: "VPlayer",
    pjs: "PJS",
    aqtitle: "AQTitle",
    ttml: "TTML",
    sbv: "SBV",
    scc: "SCC",
    eia_608: "EIA-608",
    hdmv_pgs_subtitle: "PGS",
    dvd_subtitle: "DVD Subtitle",
    dvb_subtitle: "DVB Subtitle",
    xsub: "XSUB",
  })
)

export function normalizeSubtitleCodecName(value: string | undefined | null) {
  const normalized = value?.trim().toLowerCase()

  if (!normalized) {
    return ""
  }

  return (
    subtitleCodecAliases.get(normalized.replace(/[ .-]+/g, "_")) ??
    subtitleCodecAliases.get(normalized.replace(/[._ -]+/g, "")) ??
    normalized
  )
}

export function isWebVttSubtitleCodec(value: string | undefined | null) {
  return webVttSubtitleCodecs.has(normalizeSubtitleCodecName(value))
}

export function isConvertibleTextSubtitleCodec(value: string | undefined | null) {
  return convertibleTextSubtitleCodecs.has(normalizeSubtitleCodecName(value))
}

export function subtitleCodecLabel(value: string | undefined | null) {
  const codec = normalizeSubtitleCodecName(value)

  if (!codec) {
    return "Unknown"
  }

  return subtitleCodecLabels.get(codec) ?? value?.trim() ?? codec
}

export const sidecarSubtitleStreamId = "sidecar"
export const sidecarSubtitleStreamIndex = -1

export type SubtitleSidecarExtension = (typeof subtitleSidecarExtensions)[number]

export type SubtitleSidecar = {
  filePath: string
  extension: SubtitleSidecarExtension
  codec: "webvtt" | "ass" | "ssa" | "subrip"
}

function sidecarCodec(extension: SubtitleSidecarExtension): SubtitleSidecar["codec"] {
  if (extension === ".vtt") {
    return "webvtt"
  }

  if (extension === ".ass") {
    return "ass"
  }

  if (extension === ".ssa") {
    return "ssa"
  }

  return "subrip"
}

export function isSubtitleSidecarFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  return subtitleSidecarExtensions.includes(extension as SubtitleSidecarExtension)
}

async function pathExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function subtitleSidecarDirectoryForMediaFile(mediaFilePath: string) {
  return path.join(path.dirname(mediaFilePath), subtitlesDirectoryName)
}

export function subtitleSidecarPathForMediaFile(
  mediaFilePath: string,
  extension: SubtitleSidecarExtension = ".vtt"
) {
  const parsed = path.parse(mediaFilePath)
  return path.join(subtitleSidecarDirectoryForMediaFile(mediaFilePath), `${parsed.name}${extension}`)
}

export async function findSubtitleSidecar(
  mediaFilePath: string,
  options: { extensions?: readonly SubtitleSidecarExtension[] } = {}
) {
  const parsed = path.parse(mediaFilePath)
  const extensions = options.extensions ?? subtitleSidecarExtensions
  const sidecarDirectories = [
    subtitleSidecarDirectoryForMediaFile(mediaFilePath),
    parsed.dir,
  ]

  for (const directory of sidecarDirectories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${parsed.name}${extension}`)

      if (await pathExists(candidate)) {
        return {
          filePath: candidate,
          extension,
          codec: sidecarCodec(extension),
        }
      }
    }
  }

  return null
}

export async function findWebVttSubtitleSidecar(mediaFilePath: string) {
  return findSubtitleSidecar(mediaFilePath, { extensions: [".vtt"] })
}

export function hasSupportedEmbeddedSubtitles(probe: {
  streams?: Array<{ codec_type?: string; codec_name?: string }>
}) {
  return (probe.streams ?? []).some(
    (stream) =>
      stream.codec_type === "subtitle" &&
      isConvertibleTextSubtitleCodec(stream.codec_name)
  )
}

export async function findPlaybackSubtitleSidecar(input: {
  mediaFilePath: string
  probe: { streams?: Array<{ codec_type?: string; codec_name?: string }> }
  importEnabled: boolean
}) {
  if (input.importEnabled) {
    return findWebVttSubtitleSidecar(input.mediaFilePath)
  }

  return hasSupportedEmbeddedSubtitles(input.probe)
    ? null
    : findSubtitleSidecar(input.mediaFilePath)
}

export async function readWebVttSidecar(sidecar: SubtitleSidecar) {
  if (sidecar.extension !== ".vtt") {
    throw new Error(`Subtitle sidecar is not WebVTT: ${sidecar.filePath}`)
  }

  const file = await open(sidecar.filePath, "r")

  try {
    const value = await file.readFile({ encoding: "utf8" })
    return value.replace(/^\uFEFF/, "")
  } finally {
    await file.close()
  }
}
