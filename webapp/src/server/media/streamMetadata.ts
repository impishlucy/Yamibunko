import path from "node:path"

import type {
  MediaStreamInfo,
  SubtitleStreamInfo,
  WatchPayload,
} from "@/lib/types"
import type { ProbeResult, ProbeStream } from "@/server/media/mediaFiles"

const languageAliases = new Map(
  Object.entries({
    en: "en",
    eng: "en",
    english: "en",
    ja: "ja",
    jpn: "ja",
    jap: "ja",
    japanese: "ja",
    de: "de",
    deu: "de",
    ger: "de",
    german: "de",
    fr: "fr",
    fra: "fr",
    fre: "fr",
    french: "fr",
    es: "es",
    spa: "es",
    spanish: "es",
    it: "it",
    ita: "it",
    italian: "it",
    ko: "ko",
    kor: "ko",
    korean: "ko",
    zh: "zh",
    chi: "zh",
    zho: "zh",
    chinese: "zh",
    pt: "pt",
    por: "pt",
    portuguese: "pt",
    ru: "ru",
    rus: "ru",
    russian: "ru",
  })
)

const languageNames = new Map(
  Object.entries({
    en: "English",
    ja: "Japanese",
    de: "German",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    ko: "Korean",
    zh: "Chinese",
    pt: "Portuguese",
    ru: "Russian",
  })
)

const textSubtitleCodecs = new Set([
  "ass",
  "ssa",
  "subrip",
  "srt",
  "webvtt",
  "mov_text",
  "text",
])

const managedAudioCopyCodecs = new Set([
  "aac",
  "ac3",
  "eac3",
  "mp2",
  "mp3",
  "opus",
  "vorbis",
])

function normalizeLanguage(value: string | undefined | null) {
  const normalized = value?.trim().toLowerCase()

  if (!normalized || normalized === "und" || normalized === "unknown") {
    return undefined
  }

  return languageAliases.get(normalized) ?? normalized.slice(0, 2)
}

function languageLabel(languageCode: string | undefined) {
  if (!languageCode) {
    return "Default"
  }

  return languageNames.get(languageCode) ?? languageCode.toUpperCase()
}

function streamTitle(stream: ProbeStream) {
  const title = stream.tags?.title?.trim()
  return title || undefined
}

function uniqueLabels<T extends MediaStreamInfo | SubtitleStreamInfo>(streams: T[]) {
  const counts = new Map<string, number>()

  return streams.map((stream) => {
    const count = (counts.get(stream.label) ?? 0) + 1
    counts.set(stream.label, count)

    if (count === 1) {
      return stream
    }

    return {
      ...stream,
      label: `${stream.label} ${count}`,
    }
  })
}


function subtitlePreferenceScore(stream: SubtitleStreamInfo) {
  const text = `${stream.label} ${stream.codec ?? ""}`
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")

  let score = 0

  if (stream.isDefault) {
    score += 6
  }

  if (stream.isForced) {
    score -= 35
  }

  if (/\bfull\b/.test(text) || /full subs?/.test(text)) {
    score += 80
  }

  if (/without\s+honou?rifics?/.test(text) || /no\s+honou?rifics?/.test(text)) {
    score += 70
  } else if (/with\s+honou?rifics?/.test(text)) {
    score -= 25
  }

  if (/signs?/.test(text) || /songs?/.test(text) || /karaoke/.test(text)) {
    score -= 75
  }

  if (/dialogue/.test(text)) {
    score += 15
  }

  return score
}

function findBestSubtitleStream(
  streams: SubtitleStreamInfo[],
  preferredLanguage?: string
) {
  const normalizedPreferredLanguage = normalizeLanguage(preferredLanguage)
  const candidates = normalizedPreferredLanguage
    ? streams.filter((stream) => stream.language === normalizedPreferredLanguage)
    : streams.filter((stream) => !stream.language)

  return candidates
    .slice()
    .sort((left, right) => {
      const scoreDiff = subtitlePreferenceScore(right) - subtitlePreferenceScore(left)

      if (scoreDiff !== 0) {
        return scoreDiff
      }

      return left.index - right.index
    })[0]
}

function streamIndex(stream: ProbeStream) {
  return typeof stream.index === "number" && Number.isInteger(stream.index)
    ? stream.index
    : undefined
}

function isDefaultStream(stream: ProbeStream) {
  return stream.disposition?.default === 1
}

function isForcedStream(stream: ProbeStream) {
  return stream.disposition?.forced === 1
}

function toBaseStreamInfo(stream: ProbeStream, fallbackIndex: number) {
  const index = streamIndex(stream) ?? fallbackIndex
  const language = normalizeLanguage(stream.tags?.language)
  const title = streamTitle(stream)
  const baseLabel = languageLabel(language)
  const label = language && title ? `${baseLabel} - ${title}` : baseLabel

  return {
    id: String(index),
    index,
    codec: stream.codec_name ?? undefined,
    language,
    label,
    isDefault: isDefaultStream(stream),
  }
}

export function isAudioStreamMp3Target(stream: ProbeStream) {
  const codec = (stream.codec_name ?? "").trim().toLowerCase()

  if (!codec) {
    return false
  }

  if (codec.startsWith("pcm_")) {
    return true
  }

  return !managedAudioCopyCodecs.has(codec)
}

export function getAudioOutputIndexesToMp3(probe: ProbeResult) {
  return (probe.streams ?? [])
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, outputAudioIndex) => ({ stream, outputAudioIndex }))
    .filter(({ stream }) => isAudioStreamMp3Target(stream))
    .map(({ outputAudioIndex }) => outputAudioIndex)
}

export function getMediaStreamMetadata(probe: ProbeResult): WatchPayload["media"] {
  const streams = probe.streams ?? []
  const audioStreams = uniqueLabels(
    streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream, index): MediaStreamInfo => toBaseStreamInfo(stream, index))
  )
  const subtitleStreams = uniqueLabels(
    streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream, index): SubtitleStreamInfo => {
        const base = toBaseStreamInfo(stream, index)
        const codec = (stream.codec_name ?? "").toLowerCase()

        return {
          ...base,
          isForced: isForcedStream(stream),
          isSupported: textSubtitleCodecs.has(codec),
        }
      })
  )
  const defaultAudioStream =
    audioStreams.find((stream) => stream.language === "en") ??
    audioStreams.find((stream) => stream.language === "ja") ??
    audioStreams.find((stream) => stream.isDefault) ??
    audioStreams[0]
  const playableSubtitleStreams = subtitleStreams.filter(
    (stream) => stream.isSupported
  )
  const defaultSubtitleStream = audioStreams.some(
    (stream) => stream.language === "en"
  )
    ? null
    : (findBestSubtitleStream(playableSubtitleStreams, "en") ??
      findBestSubtitleStream(playableSubtitleStreams) ??
      null)
  const firstVideoStream = streams.find((stream) => stream.codec_type === "video")
  const formatSize = Number.parseInt(probe.format?.size ?? "", 10)
  const formatDuration = Number.parseFloat(probe.format?.duration ?? "")
  const sourceBitrateMbps =
    Number.isFinite(formatSize) &&
    formatSize > 0 &&
    Number.isFinite(formatDuration) &&
    formatDuration > 0
      ? Number(((formatSize * 8) / formatDuration / 1_000_000).toFixed(2))
      : undefined

  return {
    audioStreams,
    subtitleStreams,
    defaultAudioStreamId: defaultAudioStream?.id ?? null,
    defaultSubtitleStreamId: defaultSubtitleStream?.id ?? null,
    directAudioStreamId: audioStreams[0]?.id ?? null,
    videoCodec: firstVideoStream?.codec_name ?? undefined,
    container: probe.format?.format_name
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean)[0],
    sourceBitrateMbps,
  }
}

export function getFileContainerLabel(filePath: string, probe: ProbeResult) {
  const probedContainer = probe.format?.format_name
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0]

  if (probedContainer) {
    return probedContainer
  }

  return path.extname(filePath).slice(1).toLowerCase() || undefined
}
