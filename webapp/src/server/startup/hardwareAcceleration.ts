import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import type { FileEncodeAcceleration, TranscodeAcceleration } from "@/server/config"

export const importHardwareUnsupportedMessage =
  "HW encoding is not supported for HEVC on your device"

const commandTimeoutMs = 8_000
const probeTimeoutMs = 10_000

export type HardwareAcceleration = FileEncodeAcceleration
type EncoderProbeKind = "hevc" | "live"
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
  importAcceleration: HardwareAcceleration | null
  importDevice?: string
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

function getHevcProbeQualityArgs(acceleration: HardwareAcceleration) {
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
    return kind === "hevc" ? "hevc_nvenc" : "h264_nvenc"
  }

  if (isIntelAcceleration(candidate.acceleration)) {
    return kind === "hevc" ? "hevc_qsv" : "h264_qsv"
  }

  if (process.platform === "linux") {
    return kind === "hevc" ? "hevc_vaapi" : "h264_vaapi"
  }

  return kind === "hevc" ? "hevc_amf" : "h264_amf"
}

function encoderProbeQualityArgs(candidate: EncoderCandidate, kind: EncoderProbeKind) {
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
}): HardwareAccelerationDetection {
  const hardware = detectHardwareInfo()
  const ffmpegPath = input.probeEncoders && input.ffmpegDir
    ? path.join(input.ffmpegDir, executableName("ffmpeg"))
    : null
  const usableFfmpegPath = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : null
  const accelerationFilter = input.importAccelerationFilter
  const hevcCandidates = accelerationFilter === null
    ? []
    : getHevcCandidates(hardware, accelerationFilter)
  const importCandidate = resolveWithOptionalProbe(
    usableFfmpegPath,
    hevcCandidates,
    "hevc"
  )
  const liveTranscodeCandidate = resolveWithOptionalProbe(
    usableFfmpegPath,
    prioritizeLiveCandidates(getLiveCandidates(hardware), importCandidate),
    "live"
  )

  return {
    importAcceleration: importCandidate?.acceleration ?? null,
    importDevice: importCandidate?.device,
    liveTranscodeAcceleration: liveTranscodeCandidate?.acceleration ?? "cpu",
    liveTranscodeDevice: liveTranscodeCandidate?.device,
    gpuInfo: hardware.gpuInfo,
    cpuInfo: hardware.cpuInfo,
  }
}
