import crypto from "node:crypto"
import dgram from "node:dgram"
import net from "node:net"
import os from "node:os"
import tls from "node:tls"

import type {
  ServerCastCandidate,
  ServerCastDevice,
  ServerCastMediaState,
} from "@/lib/server-cast"

const mdnsAddress = "224.0.0.251"
const mdnsPort = 5353
const googleCastServiceName = "_googlecast._tcp.local"
const defaultMediaReceiverAppId = "CC1AD845"
const connectionNamespace = "urn:x-cast:com.google.cast.tp.connection"
const heartbeatNamespace = "urn:x-cast:com.google.cast.tp.heartbeat"
const receiverNamespace = "urn:x-cast:com.google.cast.receiver"
const mediaNamespace = "urn:x-cast:com.google.cast.media"
const serverCastSourceId = `sender-${crypto.randomBytes(4).toString("hex")}`
const sessionMaxIdleMs = 30 * 60_000
const statusTimeoutMs = 7_000
const loadTimeoutMs = 45_000

const discoveredDevices = new Map<string, ServerCastDevice>()
const sessions = new Map<string, ServerCastSession>()

type DnsNameResult = {
  name: string
  offset: number
}

type DnsRecord = {
  classCode: number
  dataOffset: number
  length: number
  name: string
  nextOffset: number
  ttl: number
  type: number
}

type ServiceRecord = {
  hostName?: string
  host?: string
  name: string
  port?: number
  txt: Record<string, string>
}

type CastPayload = {
  [key: string]: unknown
  requestId?: number
  type?: string
}

type CastMessage = {
  destinationId?: string
  namespace?: string
  payload?: CastPayload
  sourceId?: string
}

type PendingCastRequest = {
  namespace: string
  reject: (error: Error) => void
  requestId: number
  resolve: (payload: CastPayload) => void
  timer: ReturnType<typeof setTimeout>
}

type ReceiverStatusPayload = CastPayload & {
  status?: {
    applications?: Array<{
      appId?: string
      displayName?: string
      sessionId?: string
      statusText?: string
      transportId?: string
    }>
  }
}

type MediaStatusPayload = CastPayload & {
  status?: Array<{
    currentTime?: number
    idleReason?: string
    media?: {
      contentId?: string
      duration?: number
    }
    mediaSessionId?: number
    playerState?: string
  }>
}

type ServerCastSession = {
  contentId: string
  device: ServerCastDevice
  heartbeat: ReturnType<typeof setInterval>
  id: string
  idleTimer: ReturnType<typeof setTimeout>
  mediaSessionId?: number
  socket: CastSocket
  transportId: string
  username: string
}

type ServerCastDiscoveryOptions = {
  receiverBaseUrl?: string
}

type MdnsDiscoveryOptions = {
  bindPort: number
  interfaceAddress?: string
  timeoutMs: number
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".")

  if (parts.length !== 4) {
    return null
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }

    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null
  })

  if (octets.some((octet) => octet === null)) {
    return null
  }

  return octets as [number, number, number, number]
}

function isPrivateLanIpv4(hostname: string) {
  const octets = parseIpv4(hostname.trim())

  if (!octets) {
    return false
  }

  const [first, second] = octets

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function isLocalHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()

  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true
  }

  const octets = parseIpv4(normalized)
  return octets?.[0] === 127 || normalized === "0.0.0.0"
}

function getFirstLanIpv4() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateLanIpv4(address.address)) {
        return address.address
      }
    }
  }

  return null
}

function getRequestLanHost(request: Request) {
  const requestUrl = new URL(request.url)

  if (isPrivateLanIpv4(requestUrl.hostname)) {
    return requestUrl.hostname
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const host = forwardedHost ?? request.headers.get("host")

  if (!host) {
    return getFirstLanIpv4()
  }

  const hostname = host.includes(":") ? host.split(":")[0] : host
  return isPrivateLanIpv4(hostname) ? hostname : getFirstLanIpv4()
}

function getDiscoveryLanHost(receiverBaseUrl?: string) {
  if (!receiverBaseUrl) {
    return getFirstLanIpv4()
  }

  try {
    const url = new URL(receiverBaseUrl)

    if (url.protocol === "http:" && isPrivateLanIpv4(url.hostname)) {
      return url.hostname
    }
  } catch {
    return getFirstLanIpv4()
  }

  return getFirstLanIpv4()
}

function getSubnetPrefix(hostname: string) {
  const octets = parseIpv4(hostname)

  if (!octets) {
    return null
  }

  return `${octets[0]}.${octets[1]}.${octets[2]}`
}

function buildMdnsQuery() {
  const labels = googleCastServiceName.split(".")
  const nameParts: number[] = []

  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8")
    nameParts.push(bytes.length, ...bytes)
  }

  return Buffer.from([
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00,
    ...nameParts,
    0x00,
    0x00, 0x0c,
    0x80, 0x01,
  ])
}

function readDnsName(buffer: Buffer, startOffset: number, depth = 0): DnsNameResult {
  if (depth > 12) {
    throw new Error("Compressed DNS name is too deep")
  }

  const labels: string[] = []
  let offset = startOffset
  let nextOffset = startOffset
  let jumped = false

  while (offset < buffer.length) {
    const length = buffer[offset]

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) {
        throw new Error("Invalid DNS pointer")
      }

      const pointerOffset = ((length & 0x3f) << 8) | buffer[offset + 1]
      const pointed = readDnsName(buffer, pointerOffset, depth + 1)
      labels.push(pointed.name)

      if (!jumped) {
        nextOffset = offset + 2
      }

      jumped = true
      break
    }

    if (length === 0) {
      if (!jumped) {
        nextOffset = offset + 1
      }
      break
    }

    offset += 1

    if (offset + length > buffer.length) {
      throw new Error("Invalid DNS label")
    }

    labels.push(buffer.subarray(offset, offset + length).toString("utf8"))
    offset += length
  }

  return {
    name: labels.filter(Boolean).join("."),
    offset: nextOffset,
  }
}

function readDnsRecord(buffer: Buffer, offset: number): DnsRecord | null {
  if (offset >= buffer.length) {
    return null
  }

  const name = readDnsName(buffer, offset)
  const headerOffset = name.offset

  if (headerOffset + 10 > buffer.length) {
    return null
  }

  const type = buffer.readUInt16BE(headerOffset)
  const classCode = buffer.readUInt16BE(headerOffset + 2)
  const ttl = buffer.readUInt32BE(headerOffset + 4)
  const length = buffer.readUInt16BE(headerOffset + 8)
  const dataOffset = headerOffset + 10
  const nextOffset = dataOffset + length

  if (nextOffset > buffer.length) {
    return null
  }

  return {
    classCode,
    dataOffset,
    length,
    name: name.name,
    nextOffset,
    ttl,
    type,
  }
}

function parseTxtRecord(buffer: Buffer, record: DnsRecord) {
  const txt: Record<string, string> = {}
  let offset = record.dataOffset
  const end = record.dataOffset + record.length

  while (offset < end) {
    const length = buffer[offset]
    offset += 1

    if (!length || offset + length > end) {
      continue
    }

    const value = buffer.subarray(offset, offset + length).toString("utf8")
    offset += length
    const separator = value.indexOf("=")

    if (separator === -1) {
      txt[value] = ""
    } else {
      txt[value.slice(0, separator)] = value.slice(separator + 1)
    }
  }

  return txt
}

function parseMdnsPacket(
  buffer: Buffer,
  services: Map<string, ServiceRecord>,
  addressRecords: Map<string, string>
) {
  if (buffer.length < 12) {
    return
  }

  const questionCount = buffer.readUInt16BE(4)
  const answerCount = buffer.readUInt16BE(6)
  const authorityCount = buffer.readUInt16BE(8)
  const additionalCount = buffer.readUInt16BE(10)
  let offset = 12

  for (let index = 0; index < questionCount; index += 1) {
    const name = readDnsName(buffer, offset)
    offset = name.offset + 4
  }

  const recordCount = answerCount + authorityCount + additionalCount

  for (let index = 0; index < recordCount; index += 1) {
    const record = readDnsRecord(buffer, offset)

    if (!record) {
      break
    }

    offset = record.nextOffset

    if (record.type === 12) {
      const ptr = readDnsName(buffer, record.dataOffset).name

      if (record.name.toLowerCase() === googleCastServiceName && ptr) {
        const service = services.get(ptr) ?? { name: ptr, txt: {} }
        services.set(ptr, service)
      }
      continue
    }

    if (record.type === 33) {
      if (record.dataOffset + 6 > buffer.length) {
        continue
      }

      const port = buffer.readUInt16BE(record.dataOffset + 4)
      const target = readDnsName(buffer, record.dataOffset + 6).name
      const service = services.get(record.name) ?? { name: record.name, txt: {} }
      service.port = port
      service.hostName = target
      services.set(record.name, service)
      continue
    }

    if (record.type === 16) {
      const service = services.get(record.name) ?? { name: record.name, txt: {} }
      service.txt = {
        ...service.txt,
        ...parseTxtRecord(buffer, record),
      }
      services.set(record.name, service)
      continue
    }

    if (record.type === 1 && record.length === 4) {
      const address = Array.from(buffer.subarray(record.dataOffset, record.dataOffset + 4)).join(".")
      addressRecords.set(record.name.toLowerCase(), address)
    }
  }

  for (const service of services.values()) {
    if (!service.host && service.hostName) {
      service.host = addressRecords.get(service.hostName.toLowerCase())
    }
  }
}

function displayServiceName(name: string) {
  return name
    .replace(new RegExp(`\\.${googleCastServiceName.replace(/\./g, "\\.")}$`, "i"), "")
    .replace(/\\032/g, " ")
    .trim()
}

function serviceToDevice(service: ServiceRecord): ServerCastDevice | null {
  const host = service.host
  const port = service.port ?? 8009

  if (!host || !net.isIPv4(host) || !port) {
    return null
  }

  const idSeed = service.txt.id || `${host}:${port}:${service.name}`
  const id = crypto.createHash("sha1").update(idSeed).digest("hex")
  const name = service.txt.fn || displayServiceName(service.name) || host

  return {
    id,
    name,
    host,
    port,
    modelName: service.txt.md || undefined,
  }
}

async function discoverServerCastDevicesWithMdns(
  services: Map<string, ServiceRecord>,
  addressRecords: Map<string, string>,
  options: MdnsDiscoveryOptions
) {
  const socket = dgram.createSocket({ reuseAddr: true, type: "udp4" })
  let socketClosed = false
  const query = buildMdnsQuery()

  socket.on("message", (message) => {
    try {
      parseMdnsPacket(message, services, addressRecords)
    } catch {
      // Ignore malformed mDNS replies from unrelated devices.
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("error", onError)
        reject(error)
      }

      socket.once("error", onError)
      socket.bind(
        {
          address: "0.0.0.0",
          exclusive: false,
          port: options.bindPort,
        },
        () => {
          socket.off("error", onError)
          try {
            socket.setMulticastTTL(255)

            if (options.interfaceAddress) {
              socket.addMembership(mdnsAddress, options.interfaceAddress)
              socket.setMulticastInterface(options.interfaceAddress)
            } else {
              socket.addMembership(mdnsAddress)
            }

            socket.send(query, 0, query.length, mdnsPort, mdnsAddress, (error) => {
              if (error) {
                reject(error)
                return
              }

              setTimeout(() => {
                if (!socketClosed) {
                  socket.send(query, 0, query.length, mdnsPort, mdnsAddress, () => undefined)
                }
              }, 350).unref?.()
              resolve()
            })
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
      )
    })

    await new Promise((resolve) => setTimeout(resolve, options.timeoutMs))
  } finally {
    socketClosed = true

    try {
      socket.close()
    } catch {
      void 0
    }
  }
}

async function probeLanCastDevice(host: string, timeoutMs = 800) {
  const id = crypto.createHash("sha1").update(`server-scan:${host}:8009`).digest("hex")
  const device: ServerCastDevice = {
    id,
    name: `Chromecast / Google TV ${host}`,
    host,
    port: 8009,
  }
  const socket = new CastSocket(device)

  try {
    await socket.connect()
    await socket.request<ReceiverStatusPayload>(
      receiverNamespace,
      { type: "GET_STATUS" },
      "receiver-0",
      timeoutMs
    )
    return device
  } catch {
    return null
  } finally {
    socket.close()
  }
}

async function scanLanForCastDevices(lanHost: string) {
  const subnetPrefix = getSubnetPrefix(lanHost)

  if (!subnetPrefix) {
    return []
  }

  const hosts: string[] = []

  for (let index = 1; index <= 254; index += 1) {
    const host = `${subnetPrefix}.${index}`

    if (host !== lanHost) {
      hosts.push(host)
    }
  }

  const devices: ServerCastDevice[] = []
  let cursor = 0
  const workerCount = 48

  async function runWorker() {
    while (cursor < hosts.length) {
      const host = hosts[cursor]
      cursor += 1
      const device = await probeLanCastDevice(host)

      if (device) {
        devices.push(device)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  return devices.sort((left, right) => left.name.localeCompare(right.name))
}

function collectDiscoveredDevices(services: Map<string, ServiceRecord>) {
  const devices = Array.from(services.values())
    .map(serviceToDevice)
    .filter((device): device is ServerCastDevice => Boolean(device))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const device of devices) {
    discoveredDevices.set(device.id, device)
  }

  return devices
}

export async function discoverServerCastDevices(
  timeoutMs = 2500,
  options: ServerCastDiscoveryOptions = {}
) {
  const services = new Map<string, ServiceRecord>()
  const addressRecords = new Map<string, string>()
  const lanHost = getDiscoveryLanHost(options.receiverBaseUrl) ?? undefined

  console.log(
    `[Info] [Cast] Discovering Chromecast devices - Receiver base ${options.receiverBaseUrl ?? "none"}, server LAN interface ${lanHost ?? "auto"}.`
  )

  await discoverServerCastDevicesWithMdns(services, addressRecords, {
    bindPort: mdnsPort,
    interfaceAddress: lanHost,
    timeoutMs,
  }).catch((error) => {
    console.warn(
      `[Warn] [Cast] Multicast Chromecast discovery failed - ${error instanceof Error ? error.message : String(error)}`
    )
  })

  let devices = collectDiscoveredDevices(services)
  console.log(`[Info] [Cast] Multicast Chromecast discovery found ${devices.length} device(s).`)

  if (!devices.length) {
    await discoverServerCastDevicesWithMdns(services, addressRecords, {
      bindPort: 0,
      interfaceAddress: lanHost,
      timeoutMs: Math.max(1200, Math.floor(timeoutMs / 2)),
    }).catch((error) => {
      console.warn(
        `[Warn] [Cast] Unicast-reply Chromecast discovery failed - ${error instanceof Error ? error.message : String(error)}`
      )
    })
    devices = collectDiscoveredDevices(services)
    console.log(`[Info] [Cast] Unicast-reply Chromecast discovery found ${devices.length} device(s).`)
  }

  if (!devices.length && lanHost) {
    console.log(`[Info] [Cast] Scanning ${getSubnetPrefix(lanHost) ?? lanHost}.0/24 for Chromecast port 8009.`)
    const scannedDevices = await scanLanForCastDevices(lanHost)

    for (const device of scannedDevices) {
      discoveredDevices.set(device.id, device)
    }

    devices = scannedDevices
    console.log(`[Info] [Cast] Subnet Chromecast scan found ${devices.length} device(s).`)
  }

  if (!devices.length) {
    console.warn(
      `[Warn] [Cast] No Chromecast devices found from the Yamibunko server. Receiver base: ${options.receiverBaseUrl ?? "none"}.`
    )
  }

  return devices
}

function encodeVarint(value: number) {
  const bytes: number[] = []
  let next = value >>> 0

  while (next >= 0x80) {
    bytes.push((next & 0x7f) | 0x80)
    next >>>= 7
  }

  bytes.push(next)
  return Buffer.from(bytes)
}

function encodeDelimitedField(field: number, value: string) {
  const payload = Buffer.from(value, "utf8")
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ])
}

function encodeVarintField(field: number, value: number) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)])
}

function encodeCastMessage(input: {
  destinationId: string
  namespace: string
  payload: CastPayload
  sourceId: string
}) {
  return Buffer.concat([
    encodeVarintField(1, 0),
    encodeDelimitedField(2, input.sourceId),
    encodeDelimitedField(3, input.destinationId),
    encodeDelimitedField(4, input.namespace),
    encodeVarintField(5, 0),
    encodeDelimitedField(6, JSON.stringify(input.payload)),
  ])
}

function readVarint(buffer: Buffer, offset: number) {
  let value = 0
  let shift = 0
  let cursor = offset

  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    value |= (byte & 0x7f) << shift
    cursor += 1

    if ((byte & 0x80) === 0) {
      return { value, offset: cursor }
    }

    shift += 7
  }

  throw new Error("Invalid protobuf varint")
}

function decodeCastMessage(buffer: Buffer): CastMessage {
  let offset = 0
  const message: CastMessage = {}

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    offset = tag.offset
    const field = tag.value >> 3
    const wireType = tag.value & 7

    if (wireType === 0) {
      const value = readVarint(buffer, offset)
      offset = value.offset
      continue
    }

    if (wireType !== 2) {
      throw new Error(`Unsupported Cast protobuf wire type ${wireType}`)
    }

    const length = readVarint(buffer, offset)
    offset = length.offset
    const value = buffer.subarray(offset, offset + length.value)
    offset += length.value

    if (field === 2) {
      message.sourceId = value.toString("utf8")
    } else if (field === 3) {
      message.destinationId = value.toString("utf8")
    } else if (field === 4) {
      message.namespace = value.toString("utf8")
    } else if (field === 6) {
      message.payload = JSON.parse(value.toString("utf8")) as CastPayload
    }
  }

  return message
}

class CastSocket {
  private buffer = Buffer.alloc(0)
  private isClosed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingCastRequest>()
  private socket?: tls.TLSSocket

  constructor(private readonly device: ServerCastDevice) {}

  async connect() {
    if (this.socket && !this.isClosed) {
      return
    }

    this.isClosed = false
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({
        host: this.device.host,
        port: this.device.port,
        rejectUnauthorized: false,
        servername: undefined,
        timeout: 8_000,
      })

      const cleanup = () => {
        socket.off("secureConnect", onConnect)
        socket.off("error", onError)
        socket.off("timeout", onTimeout)
      }
      const onConnect = () => {
        cleanup()
        resolve(socket)
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onTimeout = () => {
        cleanup()
        socket.destroy()
        reject(new Error(`Timed out connecting to ${this.device.name}`))
      }

      socket.once("secureConnect", onConnect)
      socket.once("error", onError)
      socket.once("timeout", onTimeout)
    })

    this.socket.on("data", (chunk) => this.handleData(chunk))
    this.socket.once("close", () => this.closePending(new Error("Cast socket closed")))
    this.socket.once("error", (error) => this.closePending(error))

    this.send(connectionNamespace, { type: "CONNECT" }, "receiver-0")
  }

  close() {
    this.closePending(new Error("Cast socket closed"))
    this.isClosed = true
    this.socket?.destroy()
    this.socket = undefined
  }

  send(namespace: string, payload: CastPayload, destinationId: string) {
    if (!this.socket || this.isClosed) {
      throw new Error("Cast socket is not connected")
    }

    const message = encodeCastMessage({
      destinationId,
      namespace,
      payload,
      sourceId: serverCastSourceId,
    })
    const length = Buffer.alloc(4)
    length.writeUInt32BE(message.length, 0)
    this.socket.write(Buffer.concat([length, message]))
  }

  async request<TPayload extends CastPayload>(
    namespace: string,
    payload: CastPayload,
    destinationId: string,
    timeoutMs = statusTimeoutMs
  ) {
    const requestId = this.nextRequestId
    this.nextRequestId += 1

    const requestPayload = {
      ...payload,
      requestId,
    }

    const responsePromise = new Promise<TPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error("Cast receiver did not answer in time"))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(requestId, {
        namespace,
        reject,
        requestId,
        resolve: resolve as (payload: CastPayload) => void,
        timer,
      })
    })

    this.send(namespace, requestPayload, destinationId)
    return await responsePromise
  }

  private handleData(chunk: string | Uint8Array) {
    const nextChunk = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    this.buffer = Buffer.concat([this.buffer, nextChunk])

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)

      if (this.buffer.length < length + 4) {
        return
      }

      const payload = this.buffer.subarray(4, length + 4)
      this.buffer = this.buffer.subarray(length + 4)

      try {
        this.handleMessage(decodeCastMessage(payload))
      } catch {
        // Ignore malformed Cast messages.
      }
    }
  }

  private handleMessage(message: CastMessage) {
    if (message.namespace === heartbeatNamespace && message.payload?.type === "PING") {
      this.send(heartbeatNamespace, { type: "PONG" }, message.sourceId ?? "receiver-0")
      return
    }

    const requestId = message.payload?.requestId

    if (typeof requestId !== "number") {
      return
    }

    const pending = this.pending.get(requestId)

    if (!pending) {
      return
    }

    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(message.payload ?? {})
  }

  private closePending(error: Error) {
    if (this.isClosed) {
      return
    }

    this.isClosed = true

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }

    this.pending.clear()
  }
}

function getDefaultReceiverApp(status: ReceiverStatusPayload) {
  return status.status?.applications?.find(
    (application) => application.appId === defaultMediaReceiverAppId
  )
}

async function getOrLaunchDefaultReceiver(socket: CastSocket) {
  const status = await socket.request<ReceiverStatusPayload>(
    receiverNamespace,
    { type: "GET_STATUS" },
    "receiver-0"
  )
  let app = getDefaultReceiverApp(status)

  if (!app?.transportId) {
    const launched = await socket.request<ReceiverStatusPayload>(
      receiverNamespace,
      { type: "LAUNCH", appId: defaultMediaReceiverAppId },
      "receiver-0",
      15_000
    )
    app = getDefaultReceiverApp(launched)
  }

  if (!app?.transportId) {
    throw new Error("The Chromecast default media receiver did not start.")
  }

  socket.send(connectionNamespace, { type: "CONNECT" }, app.transportId)
  return app.transportId
}

function mediaStatusFromPayload(payload: MediaStatusPayload): ServerCastMediaState {
  const status = payload.status?.[0]

  if (!status) {
    return {
      isAlive: false,
      playerState: "IDLE",
      positionSeconds: 0,
    }
  }

  return {
    contentId: status.media?.contentId,
    durationSeconds: status.media?.duration,
    idleReason: status.idleReason,
    isAlive: true,
    mediaSessionId: status.mediaSessionId,
    playerState: status.playerState,
    positionSeconds: Math.max(status.currentTime ?? 0, 0),
  }
}

function isLoadedMediaState(state: ServerCastMediaState, candidate?: ServerCastCandidate) {
  if (!state.isAlive) {
    return false
  }

  if (state.contentId && candidate && state.contentId !== candidate.url) {
    return false
  }

  return (
    state.playerState === "PLAYING" ||
    state.playerState === "PAUSED" ||
    state.playerState === "BUFFERING"
  )
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function waitForLoadedCandidateStatus(input: {
  candidate: ServerCastCandidate
  socket: CastSocket
  transportId: string
}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(attempt === 0 ? 250 : 600)

    const payload = await input.socket.request<MediaStatusPayload>(
      mediaNamespace,
      { type: "GET_STATUS" },
      input.transportId,
      statusTimeoutMs
    ).catch(() => null)

    if (!payload) {
      continue
    }

    const state = mediaStatusFromPayload(payload)

    if (isLoadedMediaState(state, input.candidate)) {
      return state
    }
  }

  return null
}

function createLoadPayload(candidate: ServerCastCandidate, autoplay: boolean) {
  const tracks = candidate.textTrack
    ? [
        {
          language: candidate.textTrack.language,
          name: candidate.textTrack.label,
          subtype: "SUBTITLES",
          trackContentId: candidate.textTrack.url,
          trackContentType: "text/vtt",
          trackId: candidate.textTrack.id,
          type: "TEXT",
        },
      ]
    : undefined

  return {
    type: "LOAD",
    media: {
      contentId: candidate.url,
      contentType: candidate.contentType,
      duration: candidate.durationSeconds && candidate.durationSeconds > 0 && Number.isFinite(candidate.durationSeconds)
        ? candidate.durationSeconds
        : undefined,
      metadata: {
        metadataType: 0,
        title: candidate.title ?? "Yamibunko",
      },
      streamType: "BUFFERED",
      tracks,
    },
    autoplay,
    currentTime: Math.max(candidate.currentTime, 0),
    activeTrackIds: candidate.textTrack ? [candidate.textTrack.id] : [],
  }
}

function touchSession(session: ServerCastSession) {
  clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    closeServerCastSession(session.id)
  }, sessionMaxIdleMs)
  session.idleTimer.unref?.()
}

function closeServerCastSession(sessionId: string) {
  const session = sessions.get(sessionId)

  if (!session) {
    return
  }

  clearInterval(session.heartbeat)
  clearTimeout(session.idleTimer)
  session.socket.close()
  sessions.delete(sessionId)
}

async function tryLoadCandidate(input: {
  autoplay: boolean
  candidate: ServerCastCandidate
  socket: CastSocket
  transportId: string
}) {
  try {
    const response = await input.socket.request<MediaStatusPayload>(
      mediaNamespace,
      createLoadPayload(input.candidate, input.autoplay),
      input.transportId,
      loadTimeoutMs
    )
    const state = mediaStatusFromPayload(response)

    if (isLoadedMediaState(state, input.candidate)) {
      return state
    }
  } catch {
    // Some receivers start playback but do not answer the LOAD request reliably.
  }

  return waitForLoadedCandidateStatus(input)
}

export async function getServerCastDevices(options: ServerCastDiscoveryOptions = {}) {
  const devices = await discoverServerCastDevices(2500, options)

  if (devices.length) {
    return devices
  }

  const cachedDevices = Array.from(discoveredDevices.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  )

  if (cachedDevices.length) {
    console.log(`[Info] [Cast] Returning ${cachedDevices.length} cached Chromecast device(s).`)
  } else {
    console.warn("[Warn] [Cast] No live or cached Chromecast devices are available to server-side casting.")
  }

  return cachedDevices
}

function getKnownDevice(deviceId: string) {
  return discoveredDevices.get(deviceId)
}

function getRequestedReceiverBaseUrl(request: Request, receiverBaseUrl?: string) {
  if (!receiverBaseUrl) {
    return null
  }

  let url: URL

  try {
    url = new URL(receiverBaseUrl)
  } catch {
    throw new Error("Chromecast receiver base URL is invalid.")
  }

  if (url.protocol !== "http:" || !isPrivateLanIpv4(url.hostname)) {
    throw new Error("Server-side Chromecast needs the browser's http:// LAN IPv4 address as receiver base URL.")
  }

  const requestUrl = new URL(request.url)

  if (requestUrl.protocol === "http:" && isPrivateLanIpv4(requestUrl.hostname)) {
    const requestOrigin = `${requestUrl.protocol}//${requestUrl.host}`

    if (url.origin !== requestOrigin) {
      throw new Error("Chromecast receiver base URL must match the current Yamibunko LAN origin.")
    }
  }

  return url
}

export function makeReceiverReachableUrl(request: Request, value: string, receiverBaseUrl?: string) {
  const requestedBaseUrl = getRequestedReceiverBaseUrl(request, receiverBaseUrl)
  const url = new URL(value, requestedBaseUrl?.toString() ?? request.url)
  const requestUrl = new URL(request.url)

  if (requestedBaseUrl) {
    url.protocol = requestedBaseUrl.protocol
    url.hostname = requestedBaseUrl.hostname
    url.port = requestedBaseUrl.port
  } else if (isLocalHost(url.hostname)) {
    const lanHost = getRequestLanHost(request)

    if (!lanHost) {
      throw new Error("No LAN IPv4 address could be found for Chromecast playback.")
    }

    url.hostname = lanHost
    url.protocol = requestUrl.protocol === "https:" ? "https:" : "http:"

    if (!url.port) {
      url.port = requestUrl.port
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Chromecast media URLs must use HTTP or HTTPS.")
  }

  if (url.protocol === "http:" && !isPrivateLanIpv4(url.hostname)) {
    throw new Error("HTTP Chromecast media URLs must use the server LAN IPv4 address.")
  }

  return url.toString()
}

function assertWatchMediaUrl(request: Request, value: string) {
  const url = new URL(value, request.url)

  if (!url.pathname.startsWith("/api/watch/") || !url.pathname.includes("/stream")) {
    throw new Error("Only Yamibunko watch streams can be cast through the server.")
  }
}

function assertWatchSubtitleUrl(request: Request, value: string) {
  const url = new URL(value, request.url)

  if (!url.pathname.startsWith("/api/watch/") || !url.pathname.includes("/subtitles")) {
    throw new Error("Only Yamibunko subtitle streams can be cast through the server.")
  }
}

export function normalizeServerCastCandidates(
  request: Request,
  candidates: ServerCastCandidate[],
  receiverBaseUrl?: string
) {
  return candidates.map((candidate) => {
    assertWatchMediaUrl(request, candidate.url)

    const textTrack = candidate.textTrack

    return {
      ...candidate,
      url: makeReceiverReachableUrl(request, candidate.url, receiverBaseUrl),
      textTrack: textTrack
        ? {
            ...textTrack,
            url: (() => {
              assertWatchSubtitleUrl(request, textTrack.url)
              return makeReceiverReachableUrl(request, textTrack.url, receiverBaseUrl)
            })(),
          }
        : undefined,
    }
  })
}

export async function startServerCast(input: {
  autoplay: boolean
  candidates: ServerCastCandidate[]
  deviceId: string
  username: string
}) {
  let device = getKnownDevice(input.deviceId)

  if (!device) {
    await discoverServerCastDevices(1800)
    device = getKnownDevice(input.deviceId)
  }

  if (!device) {
    throw new Error("The selected Chromecast device is no longer available.")
  }

  const socket = new CastSocket(device)
  await socket.connect()
  const transportId = await getOrLaunchDefaultReceiver(socket)

  for (const candidate of input.candidates) {
    const state = await tryLoadCandidate({
      autoplay: input.autoplay,
      candidate,
      socket,
      transportId,
    }).catch(() => null)

    if (!state) {
      continue
    }

    const sessionId = crypto.randomUUID()
    const sessionRef: { current?: ServerCastSession } = {}
    const heartbeat = setInterval(() => {
      const activeSession = sessionRef.current

      if (!activeSession) {
        return
      }

      try {
        socket.send(heartbeatNamespace, { type: "PING" }, "receiver-0")
        if (sessions.get(activeSession.id) === activeSession) {
          touchSession(activeSession)
        }
      } catch {
        closeServerCastSession(activeSession.id)
      }
    }, 5_000)
    const session: ServerCastSession = {
      contentId: candidate.url,
      device,
      heartbeat,
      id: sessionId,
      idleTimer: setTimeout(() => undefined, sessionMaxIdleMs),
      mediaSessionId: state.mediaSessionId,
      socket,
      transportId,
      username: input.username,
    }
    sessionRef.current = session
    session.heartbeat.unref?.()
    touchSession(session)
    sessions.set(sessionId, session)

    return {
      candidate,
      sessionId,
      state,
    }
  }

  socket.close()
  throw new Error("The Chromecast receiver could not load this episode.")
}

function getSessionForUser(sessionId: string, username: string) {
  const session = sessions.get(sessionId)

  if (!session || session.username !== username) {
    return null
  }

  touchSession(session)
  return session
}

export async function getServerCastStatus(sessionId: string, username: string) {
  const session = getSessionForUser(sessionId, username)

  if (!session) {
    return {
      isAlive: false,
      playerState: "IDLE",
      positionSeconds: 0,
    } satisfies ServerCastMediaState
  }

  const payload = await session.socket.request<MediaStatusPayload>(
    mediaNamespace,
    { type: "GET_STATUS" },
    session.transportId
  )
  const state = mediaStatusFromPayload(payload)

  if (state.mediaSessionId) {
    session.mediaSessionId = state.mediaSessionId
  }

  return state
}

async function resolveServerCastMediaSessionId(session: ServerCastSession) {
  if (session.mediaSessionId) {
    return session.mediaSessionId
  }

  const payload = await session.socket.request<MediaStatusPayload>(
    mediaNamespace,
    { type: "GET_STATUS" },
    session.transportId,
    statusTimeoutMs
  )
  const state = mediaStatusFromPayload(payload)

  if (!state.isAlive || !state.mediaSessionId) {
    throw new Error("The Chromecast media session is no longer active.")
  }

  session.mediaSessionId = state.mediaSessionId
  return state.mediaSessionId
}

export async function controlServerCast(input: {
  action: "pause" | "play" | "seek" | "stop"
  currentTime?: number
  sessionId: string
  username: string
}) {
  const idleState = {
    isAlive: false,
    playerState: "IDLE",
    positionSeconds: 0,
  } satisfies ServerCastMediaState
  const session = getSessionForUser(input.sessionId, input.username)

  if (!session) {
    if (input.action === "stop") {
      return idleState
    }

    throw new Error("Server Cast session is gone.")
  }

  if (input.action === "stop") {
    const mediaSessionId = await resolveServerCastMediaSessionId(session).catch(() => null)

    if (mediaSessionId !== null) {
      try {
        session.socket.send(
          mediaNamespace,
          { type: "STOP", mediaSessionId },
          session.transportId
        )
      } catch {
      }
    }

    closeServerCastSession(input.sessionId)
    return idleState
  }

  const mediaSessionId = await resolveServerCastMediaSessionId(session)

  const payload = input.action === "seek"
    ? {
        type: "SEEK",
        currentTime: Math.max(input.currentTime ?? 0, 0),
        mediaSessionId,
      }
    : { type: input.action === "play" ? "PLAY" : "PAUSE", mediaSessionId }

  const response = await session.socket.request<MediaStatusPayload>(
    mediaNamespace,
    payload,
    session.transportId
  )
  const state = mediaStatusFromPayload(response)

  if (state.mediaSessionId) {
    session.mediaSessionId = state.mediaSessionId
  }

  return state
}
