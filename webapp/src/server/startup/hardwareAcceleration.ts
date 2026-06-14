import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import type { FileEncodeAcceleration, ImportEncoding, TranscodeAcceleration } from "@/server/config"

export const importHardwareUnsupportedMessage =
  "HW encoding is not supported for AV1 or HEVC on your device"

const commandTimeoutMs = 8_000
const probeTimeoutMs = 10_000

export type HardwareAcceleration = FileEncodeAcceleration
type EncoderProbeKind = "av1" | "hevc" | "live"
type HardwareSource = "gpu" | "cpu"

type HardwareInfo = {
  gpuInfo: string
  cpuInfo: string
  renderDevices: RenderDevice[]
}

type RenderDevice = {
  path: string
  vendorId: string
  description: string
}

type EncoderCandidate = {
  acceleration: HardwareAcceleration
  device?: string
  source: HardwareSource
}

export type HardwareAccelerationDetection = {
  importEncoding: ImportEncoding
  importAcceleration: HardwareAcceleration | null
  importDevice?: string
  av1ImportAcceleration: HardwareAcceleration | null
  av1ImportDevice?: string
  hevcImportAcceleration: HardwareAcceleration | null
  hevcImportDevice?: string
  liveTranscodeAcceleration: TranscodeAcceleration
  liveTranscodeDevice?: string
  gpuInfo: string
  cpuInfo: string
}

function executableName(name: "ffmpeg" | "ffprobe") {
  return process.platform === "win32" ? `${name}.exe` : name
}

function runCommand(fileName: string, args: string[]) {
  try {
    const result = spawnSync(fileName, args, {
      encoding: "utf8",
      timeout: commandTimeoutMs,
      windowsHide: true,
    })

    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
  } catch {
    return ""
  }
}

function detectHardwareInfo(): HardwareInfo {
  const renderDevices = detectRenderDevices()

  if (process.platform === "win32") {
    return {
      gpuInfo: runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ]),
      cpuInfo: runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name",
      ]),
      renderDevices,
    }
  }

  if (process.platform === "linux") {
    return {
      gpuInfo: [runCommand("lspci", []), formatRenderDeviceInfo(renderDevices)]
        .filter(Boolean)
        .join("\n"),
      cpuInfo: readLinuxCpuInfo(),
      renderDevices,
    }
  }

  return {
    gpuInfo: "",
    cpuInfo:
      process.platform === "darwin"
        ? runCommand("sysctl", ["-n", "machdep.cpu.brand_string"])
        : os.cpus().map((cpu) => cpu.model).join("\n"),
    renderDevices,
  }
}

function readLinuxCpuInfo() {
  try {
    return existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf8") : ""
  } catch {
    return ""
  }
}

function detectRenderDevices(): RenderDevice[] {
  if (process.platform !== "linux") {
    return []
  }

  try {
    return readdirSync("/sys/class/drm")
      .filter((entry) => /^renderD\d+$/.test(entry))
      .sort()
      .map((entry) => {
        const root = path.join("/sys/class/drm", entry, "device")
        const vendorId = readOptionalFile(path.join(root, "vendor")).toLowerCase()
        const deviceId = readOptionalFile(path.join(root, "device")).toLowerCase()
        const uevent = readOptionalFile(path.join(root, "uevent"))
        const driver = path.basename(readOptionalLink(path.join(root, "driver")))

        return {
          path: `/dev/dri/${entry}`,
          vendorId,
          description: [entry, vendorId, deviceId, driver, uevent]
            .filter(Boolean)
            .join(" "),
        }
      })
  } catch {
    return []
  }
}

function readOptionalFile(filePath: string) {
  try {
    return readFileSync(filePath, "utf8").trim()
  } catch {
    return ""
  }
}

function readOptionalLink(filePath: string) {
  try {
    return existsSync(filePath) ? readlinkSync(filePath) : ""
  } catch {
    return ""
  }
}

function formatRenderDeviceInfo(renderDevices: RenderDevice[]) {
  return renderDevices
    .map((device) => `${device.path} ${device.vendorId} ${device.description}`.trim())
    .join("\n")
}

function splitHardwareLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, " ")
}

function includesAny(value: string, tokens: string[]) {
  return tokens.some((token) => value.includes(token))
}

function hasNvidiaGpu(value: string) {
  return includesAny(value, ["nvidia", "geforce", "quadro", "rtx"])
}

function hasAmdGpu(value: string) {
  return includesAny(value, [
    "amd",
    "advanced micro devices",
    "ati technologies",
    "radeon",
    "firepro",
  ])
}

function hasIntelGpu(value: string) {
  return includesAny(value, ["intel", "iris", "uhd graphics", "arc"])
}

function isNvidiaAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "nvenc"
}

function isIntelAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "intel_gpu" || acceleration === "intel_cpu"
}

function isAmdAcceleration(acceleration: TranscodeAcceleration) {
  return acceleration === "amd_gpu" || acceleration === "amd_cpu"
}

function supportsNvidiaAv1Encode(value: string) {
  const normalized = normalize(value)

  return (
    /\brtx\s*(40|50)\d{2}\b/.test(normalized) ||
    /\brtx\s*(40|50)\d{2}\s*(ti|super|laptop)?\b/.test(normalized) ||
    /\brtx\s*(20|40|45|50|60)00\b.*\bada\b/.test(normalized) ||
    /\bada\b/.test(normalized) ||
    /\bblackwell\b/.test(normalized) ||
    /\bl4\b/.test(normalized) ||
    /\bl40s?\b/.test(normalized) ||
    /\bgb\d{3}\b/.test(normalized)
  )
}

function supportsIntelAv1Encode(value: string) {
  const normalized = normalize(value)

  return (
    /\barc\s*(a|b)\d{3}\b/.test(normalized) ||
    /\barc\s*pro\s*(a|b)\d{2,4}\b/.test(normalized) ||
    /\bintel\s*arc\b/.test(normalized) ||
    /\bcore\s*ultra\b.*\barc\b/.test(normalized) ||
    /\barc\b.*\bcore\s*ultra\b/.test(normalized) ||
    /\bmeteor\s*lake\b.*\barc\b/.test(normalized) ||
    /\blunar\s*lake\b/.test(normalized) ||
    /\barrow\s*lake\b.*\barc\b/.test(normalized)
  )
}

function supportsIntelCpuAv1Encode(value: string) {
  const normalized = normalize(value)

  return (
    /\bcore\s*ultra\b/.test(normalized) ||
    /\bmeteor\s*lake\b/.test(normalized) ||
    /\blunar\s*lake\b/.test(normalized) ||
    /\barrow\s*lake\b/.test(normalized)
  )
}

function supportsAmdAv1Encode(value: string) {
  const normalized = normalize(value)

  return (
    /\bradeon\b.*\brx\s*[789]\d{3}\b/.test(normalized) ||
    /\brx\s*[789]\d{3}\b/.test(normalized) ||
    /\bradeon\b.*\bpro\s*w[789]\d{3}\b/.test(normalized) ||
    /\bpro\s*w[789]\d{3}\b/.test(normalized) ||
    /\bradeon\b.*\b(740m|760m|780m|780m graphics|880m|890m)\b/.test(normalized) ||
    /\bryzen\s*ai\b/.test(normalized) ||
    /\bryzen\s*[3579]\s*(7040|8040|8\d{3}g?)\w*\b/.test(normalized) ||
    /\bryzen\s*z1\b/.test(normalized) ||
    /\bvcn\s*(4|5)(\.\d*)?\b/.test(normalized) ||
    /\bnavi\s*(3|4)\d\b/.test(normalized) ||
    /\brdna\s*(3|4)\b/.test(normalized) ||
    /\bstrix\b/.test(normalized) ||
    /\bphoenix\b/.test(normalized) ||
    /\bhawk\s*point\b/.test(normalized)
  )
}

function supportsNvidiaHevcEncode(value: string) {
  const normalized = normalize(value)

  return (
    hasNvidiaGpu(normalized) &&
    !/\b(gt\s*710|gt\s*730|gtx\s*(5|6|7)\d{2})\b/.test(normalized)
  )
}

function supportsIntelHevcEncode(value: string) {
  const normalized = normalize(value)

  return hasIntelGpu(normalized) || normalized.includes("intel")
}

function supportsAmdHevcEncode(value: string) {
  const normalized = normalize(value)

  return hasAmdGpu(normalized) || hasAmdApuHint(normalized)
}

function hasAmdApuHint(value: string) {
  const normalized = normalize(value)

  return (
    /\bwith\s+radeon\s+graphics\b/.test(normalized) ||
    /\bradeon\s+graphics\b/.test(normalized) ||
    /\bradeon\b.*\b(610m|660m|680m|740m|760m|780m|880m|890m)\b/.test(normalized) ||
    /\bryzen\s*ai\b/.test(normalized) ||
    /\bryzen\s*z1\b/.test(normalized) ||
    /\bryzen\s*[3579]\s*\d{4}g\b/.test(normalized)
  )
}

function renderDevicesForVendor(hardware: HardwareInfo, vendorId: string) {
  return hardware.renderDevices.filter(
    (device) => device.vendorId.toLowerCase() === vendorId.toLowerCase()
  )
}

function renderDevicePathsForVendor(hardware: HardwareInfo, vendorId: string) {
  return renderDevicesForVendor(hardware, vendorId).map((device) => device.path)
}

function defaultDevicePathsForAcceleration(
  hardware: HardwareInfo,
  acceleration: HardwareAcceleration
) {
  if (process.platform !== "linux") {
    return [undefined]
  }

  if (isAmdAcceleration(acceleration)) {
    const devices = renderDevicePathsForVendor(hardware, "0x1002")
    return devices.length ? devices : ["/dev/dri/renderD128"]
  }

  if (isIntelAcceleration(acceleration)) {
    const devices = renderDevicePathsForVendor(hardware, "0x8086")
    return devices.length ? devices : ["/dev/dri/renderD128"]
  }

  return [undefined]
}

function makeCandidates(
  hardware: HardwareInfo,
  acceleration: HardwareAcceleration,
  source: HardwareSource
): EncoderCandidate[] {
  return defaultDevicePathsForAcceleration(hardware, acceleration).map((device) => ({
    acceleration,
    device,
    source,
  }))
}

function uniqueCandidates(values: EncoderCandidate[]) {
  const seen = new Set<string>()
  const result: EncoderCandidate[] = []

  for (const value of values) {
    const key = [value.acceleration, value.device ?? ""].join("|")

    if (!seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }

  return result
}

function accelerationPriority(acceleration: TranscodeAcceleration) {
  switch (acceleration) {
    case "nvenc":
      return 0
    case "amd_gpu":
      return 1
    case "intel_gpu":
      return 2
    case "amd_cpu":
      return 3
    case "intel_cpu":
      return 4
    default:
      return 100
  }
}

function prioritizeCandidates(values: EncoderCandidate[]) {
  return uniqueCandidates(values).sort((left, right) => {
    const sourceComparison = sourcePriority(left.source) - sourcePriority(right.source)

    if (sourceComparison !== 0) {
      return sourceComparison
    }

    const accelerationComparison =
      accelerationPriority(left.acceleration) - accelerationPriority(right.acceleration)

    if (accelerationComparison !== 0) {
      return accelerationComparison
    }

    return (left.device ?? "").localeCompare(right.device ?? "")
  })
}

function sourcePriority(source: HardwareSource) {
  return source === "gpu" ? 0 : 1
}

function prioritizeLiveCandidates(
  candidates: EncoderCandidate[],
  importCandidate: EncoderCandidate | null
) {
  return [...candidates].sort((left, right) => {
    const preferredComparison =
      preferredCandidatePriority(left, importCandidate) -
      preferredCandidatePriority(right, importCandidate)

    if (preferredComparison !== 0) {
      return preferredComparison
    }

    const sourceComparison = sourcePriority(left.source) - sourcePriority(right.source)

    if (sourceComparison !== 0) {
      return sourceComparison
    }

    const accelerationComparison =
      accelerationPriority(left.acceleration) - accelerationPriority(right.acceleration)

    if (accelerationComparison !== 0) {
      return accelerationComparison
    }

    return (left.device ?? "").localeCompare(right.device ?? "")
  })
}

function preferredCandidatePriority(
  candidate: EncoderCandidate,
  preferred: EncoderCandidate | null
) {
  if (!preferred) {
    return 1
  }

  return candidate.acceleration === preferred.acceleration &&
    (candidate.device ?? "") === (preferred.device ?? "")
    ? 0
    : 1
}

function getAv1Candidates(
  hardware: HardwareInfo,
  accelerationFilter?: HardwareAcceleration
) {
  const gpuCandidates = splitHardwareLines(hardware.gpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (hasNvidiaGpu(normalized) && supportsNvidiaAv1Encode(normalized)) {
      candidates.push(...makeCandidates(hardware, "nvenc", "gpu"))
    }

    if (hasIntelGpu(normalized) && supportsIntelAv1Encode(normalized)) {
      candidates.push(...makeCandidates(hardware, "intel_gpu", "gpu"))
    }

    if (hasAmdGpu(normalized) && supportsAmdAv1Encode(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_gpu", "gpu"))
    }

    return candidates
  })

  const cpuCandidates = splitHardwareLines(hardware.cpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (normalized.includes("intel") && supportsIntelCpuAv1Encode(normalized)) {
      candidates.push(...makeCandidates(hardware, "intel_cpu", "cpu"))
    }

    if (normalized.includes("amd") && supportsAmdAv1Encode(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_cpu", "cpu"))
    }

    return candidates
  })

  const candidates = prioritizeCandidates([...gpuCandidates, ...cpuCandidates])

  return accelerationFilter
    ? candidates.filter((candidate) => candidate.acceleration === accelerationFilter)
    : candidates
}

function getHevcCandidates(
  hardware: HardwareInfo,
  accelerationFilter?: HardwareAcceleration
) {
  const gpuCandidates = splitHardwareLines(hardware.gpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (hasNvidiaGpu(normalized) && supportsNvidiaHevcEncode(normalized)) {
      candidates.push(...makeCandidates(hardware, "nvenc", "gpu"))
    }

    if (hasIntelGpu(normalized) && supportsIntelHevcEncode(normalized)) {
      candidates.push(...makeCandidates(hardware, "intel_gpu", "gpu"))
    }

    if (hasAmdGpu(normalized) && supportsAmdHevcEncode(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_gpu", "gpu"))
    }

    return candidates
  })

  const cpuCandidates = splitHardwareLines(hardware.cpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (normalized.includes("intel") && supportsIntelHevcEncode(normalized)) {
      candidates.push(...makeCandidates(hardware, "intel_cpu", "cpu"))
    }

    if (normalized.includes("amd") && supportsAmdHevcEncode(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_cpu", "cpu"))
    }

    return candidates
  })

  const candidates = prioritizeCandidates([...gpuCandidates, ...cpuCandidates])

  return accelerationFilter
    ? candidates.filter((candidate) => candidate.acceleration === accelerationFilter)
    : candidates
}

function getLiveCandidates(hardware: HardwareInfo) {
  const gpuCandidates = splitHardwareLines(hardware.gpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (hasNvidiaGpu(normalized)) {
      candidates.push(...makeCandidates(hardware, "nvenc", "gpu"))
    }

    if (hasIntelGpu(normalized)) {
      candidates.push(...makeCandidates(hardware, "intel_gpu", "gpu"))
    }

    if (hasAmdGpu(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_gpu", "gpu"))
    }

    return candidates
  })

  const cpuCandidates = splitHardwareLines(hardware.cpuInfo).flatMap((line) => {
    const normalized = normalize(line)
    const candidates: EncoderCandidate[] = []

    if (
      normalized.includes("intel") &&
      !/\bcore\s*i[3579][\s-]*\d{4,5}f\b/.test(normalized)
    ) {
      candidates.push(...makeCandidates(hardware, "intel_cpu", "cpu"))
    }

    if (normalized.includes("amd") && hasAmdApuHint(normalized)) {
      candidates.push(...makeCandidates(hardware, "amd_cpu", "cpu"))
    }

    return candidates
  })

  return prioritizeCandidates([...gpuCandidates, ...cpuCandidates])
}

function getAv1ProbeQualityArgs(acceleration: HardwareAcceleration) {
  if (isNvidiaAcceleration(acceleration)) {
    return [
      "-preset",
      "p4",
      "-tune",
      "hq",
      "-rc:v",
      "vbr",
      "-cq:v",
      "24",
      "-b:v",
      "2M",
      "-maxrate",
      "3M",
      "-bufsize",
      "6M",
      "-multipass",
      "fullres",
    ]
  }

  if (isIntelAcceleration(acceleration)) {
    return [
      "-preset",
      "medium",
      "-global_quality:v",
      "24",
      "-b:v",
      "2M",
      "-maxrate",
      "3M",
      "-bufsize",
      "6M",
    ]
  }

  if (process.platform === "linux") {
    return [
      "-rc_mode",
      "VBR",
      "-compression_level",
      "3",
      "-b:v",
      "2M",
      "-maxrate",
      "3M",
      "-bufsize",
      "6M",
    ]
  }

  return [
    "-usage",
    "high_quality",
    "-quality",
    "balanced",
    "-rc",
    "vbr_peak",
    "-b:v",
    "2M",
    "-maxrate",
    "3M",
    "-bufsize",
    "6M",
  ]
}

function getHevcProbeQualityArgs(acceleration: HardwareAcceleration) {
  return getAv1ProbeQualityArgs(acceleration)
}

function getQsvDeviceArgs(candidate: EncoderCandidate) {
  return process.platform === "linux" && candidate.device
    ? ["-qsv_device", candidate.device]
    : []
}

function getVaapiDeviceArgs(candidate: EncoderCandidate) {
  return ["-vaapi_device", candidate.device ?? "/dev/dri/renderD128"]
}

function encoderName(candidate: EncoderCandidate, kind: EncoderProbeKind) {
  if (isNvidiaAcceleration(candidate.acceleration)) {
    return kind === "av1" ? "av1_nvenc" : kind === "hevc" ? "hevc_nvenc" : "h264_nvenc"
  }

  if (isIntelAcceleration(candidate.acceleration)) {
    return kind === "av1" ? "av1_qsv" : kind === "hevc" ? "hevc_qsv" : "h264_qsv"
  }

  if (process.platform === "linux") {
    return kind === "av1" ? "av1_vaapi" : kind === "hevc" ? "hevc_vaapi" : "h264_vaapi"
  }

  return kind === "av1" ? "av1_amf" : kind === "hevc" ? "hevc_amf" : "h264_amf"
}

function encoderProbeQualityArgs(candidate: EncoderCandidate, kind: EncoderProbeKind) {
  if (kind === "av1") {
    return getAv1ProbeQualityArgs(candidate.acceleration)
  }

  if (kind === "hevc") {
    return getHevcProbeQualityArgs(candidate.acceleration)
  }

  if (isNvidiaAcceleration(candidate.acceleration)) {
    return ["-preset", "p2"]
  }

  if (isIntelAcceleration(candidate.acceleration)) {
    return ["-preset", "veryfast"]
  }

  return []
}

function getEncoderProbeArgs(candidate: EncoderCandidate, kind: EncoderProbeKind) {
  const inputArgs = ["-f", "lavfi", "-i", "testsrc2=size=256x256:rate=1"]
  const suffixArgs = ["-frames:v", "1", "-an", "-f", "null", "-"]

  if (isNvidiaAcceleration(candidate.acceleration)) {
    return [
      ...inputArgs,
      "-c:v",
      encoderName(candidate, kind),
      ...encoderProbeQualityArgs(candidate, kind),
      ...suffixArgs,
    ]
  }

  if (isIntelAcceleration(candidate.acceleration)) {
    return [
      ...getQsvDeviceArgs(candidate),
      ...inputArgs,
      "-vf",
      "format=nv12",
      "-c:v",
      encoderName(candidate, kind),
      ...encoderProbeQualityArgs(candidate, kind),
      ...suffixArgs,
    ]
  }

  if (process.platform === "linux") {
    return [
      ...getVaapiDeviceArgs(candidate),
      ...inputArgs,
      "-vf",
      "format=nv12,hwupload",
      "-c:v",
      encoderName(candidate, kind),
      ...encoderProbeQualityArgs(candidate, kind),
      ...suffixArgs,
    ]
  }

  return [
    ...inputArgs,
    "-c:v",
    encoderName(candidate, kind),
    ...encoderProbeQualityArgs(candidate, kind),
    ...suffixArgs,
  ]
}

function canRunEncoderProbe(
  ffmpegPath: string,
  candidate: EncoderCandidate,
  kind: EncoderProbeKind
) {
  try {
    const result = spawnSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...getEncoderProbeArgs(candidate, kind),
      ],
      {
        encoding: "utf8",
        timeout: probeTimeoutMs,
        windowsHide: true,
      }
    )

    return result.status === 0
  } catch {
    return false
  }
}

function resolveWithOptionalProbe(
  ffmpegPath: string | null,
  candidates: EncoderCandidate[],
  kind: EncoderProbeKind
) {
  if (!ffmpegPath) {
    return candidates[0] ?? null
  }

  for (const candidate of candidates) {
    if (canRunEncoderProbe(ffmpegPath, candidate, kind)) {
      return candidate
    }
  }

  return null
}

export function detectHardwareAcceleration(input: {
  ffmpegDir?: string
  probeEncoders?: boolean
  importAccelerationFilter?: HardwareAcceleration | null
  av1AccelerationFilter?: HardwareAcceleration | null
}): HardwareAccelerationDetection {
  const hardware = detectHardwareInfo()
  const ffmpegPath = input.probeEncoders && input.ffmpegDir
    ? path.join(input.ffmpegDir, executableName("ffmpeg"))
    : null
  const usableFfmpegPath = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : null
  const accelerationFilter = input.importAccelerationFilter ?? input.av1AccelerationFilter
  const av1Candidates = accelerationFilter === null
    ? []
    : getAv1Candidates(hardware, accelerationFilter)
  const av1ImportCandidate = resolveWithOptionalProbe(
    usableFfmpegPath,
    av1Candidates,
    "av1"
  )
  const hevcCandidates = av1ImportCandidate || accelerationFilter === null
    ? []
    : getHevcCandidates(hardware, accelerationFilter)
  const hevcImportCandidate = resolveWithOptionalProbe(
    usableFfmpegPath,
    hevcCandidates,
    "hevc"
  )
  const importCandidate = av1ImportCandidate ?? hevcImportCandidate
  const liveTranscodeCandidate = resolveWithOptionalProbe(
    usableFfmpegPath,
    prioritizeLiveCandidates(getLiveCandidates(hardware), importCandidate),
    "live"
  )

  return {
    importEncoding: av1ImportCandidate ? "av1" : hevcImportCandidate ? "hevc" : "none",
    importAcceleration: importCandidate?.acceleration ?? null,
    importDevice: importCandidate?.device,
    av1ImportAcceleration: av1ImportCandidate?.acceleration ?? null,
    av1ImportDevice: av1ImportCandidate?.device,
    hevcImportAcceleration: hevcImportCandidate?.acceleration ?? null,
    hevcImportDevice: hevcImportCandidate?.device,
    liveTranscodeAcceleration: liveTranscodeCandidate?.acceleration ?? "cpu",
    liveTranscodeDevice: liveTranscodeCandidate?.device,
    gpuInfo: hardware.gpuInfo,
    cpuInfo: hardware.cpuInfo,
  }
}
