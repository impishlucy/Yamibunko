import {
  AniListOperations,
  type SaveMediaListEntryInput,
} from "@api-wrappers/anilist-wrapper"

import { getServerConfig } from "@/server/config"
import {
  getAniListConnection,
  getCachedAniListMediaListEntry,
  getSafeAniListConnection,
  markAniListConnectionSynced,
  updateAniListConnectionScoreFormat,
  upsertAniListMediaListEntries,
  type AniListConnection,
  type CachedAniListMediaListEntry,
} from "@/server/db/anilistConnections"
import { markEpisodesCompleteThrough } from "@/server/db/library"
import { joinBaseUrl } from "@/server/http/baseUrl"
import { getPublicBaseUrl } from "@/server/http/request"
import {
  getAniListClient,
  queueAniListOperation,
} from "@/server/anilist/transport"

type AniListTokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number | null
}

type AniListViewer = {
  id: number
  name: string
  mediaListOptions?: {
    scoreFormat?: string | null
  } | null
}

type AniListListEntry = {
  id: number
  mediaId: number | null
  status: string | null
  progress: number | null
  score: number | null
  repeat: number | null
  createdAt?: number | string | null
  updatedAt?: number | string | null
}

type AniListListCollection = {
  MediaListCollection?: {
    lists?: Array<{
      entries?: Array<AniListListEntry | null> | null
    } | null> | null
  } | null
}

type MediaListStatusInput = NonNullable<SaveMediaListEntryInput["status"]>

const mediaListStatus = AniListOperations.MediaListStatus
const completedStatus = "COMPLETED" as MediaListStatusInput
const rewatchingStatus = mediaListStatus.Repeating as MediaListStatusInput
const watchingStatuses = new Set<string>([
  mediaListStatus.Current,
  mediaListStatus.Repeating,
])

function getAniListOAuthConfig() {
  const config = getServerConfig()

  if (!config.anilistClientId || !config.anilistClientSecret) {
    return null
  }

  return {
    clientId: config.anilistClientId,
    clientSecret: config.anilistClientSecret,
  }
}

export function isAniListConfigured() {
  return Boolean(getAniListOAuthConfig())
}

export async function getAniListRedirectUri(_request: Request) {
  void _request
  return joinBaseUrl(await getPublicBaseUrl(), "/api/anilist/oauth/callback")
}

export async function getAniListAuthorizationUrl(
  request: Request,
  state: string
) {
  const oauthConfig = getAniListOAuthConfig()

  if (!oauthConfig) {
    console.error(
      "[Error] [Anilist] OAuth authorization URL requested but AniList is not configured - client.ts"
    )
    throw new Error("AniList OAuth is not configured")
  }

  const url = new URL("https://anilist.co/api/v2/oauth/authorize")
  url.searchParams.set("client_id", oauthConfig.clientId)
  url.searchParams.set("redirect_uri", await getAniListRedirectUri(request))
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", state)

  return url
}

export async function exchangeAniListAuthorizationCode(
  request: Request,
  code: string
) {
  const oauthConfig = getAniListOAuthConfig()

  if (!oauthConfig) {
    console.error(
      "[Error] [Anilist] OAuth code exchange requested but AniList is not configured - client.ts"
    )
    throw new Error("AniList OAuth is not configured")
  }

  const redirectUri = await getAniListRedirectUri(request)
  console.log("[Info] [Anilist] Exchanging OAuth authorization code.")

  const response = await queueAniListOperation((signal) =>
    fetch("https://anilist.co/api/v2/oauth/token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
      signal,
    }),
    { label: "Exchange AniList OAuth authorization code" }
  )

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error(
      `[Error] [Anilist] AniList token exchange failed - client.ts - HTTP ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
    )
    throw new Error("AniList token exchange failed")
  }

  const payload = (await response.json()) as AniListTokenResponse

  if (!payload.access_token) {
    console.error(
      "[Error] [Anilist] AniList token response did not include an access token - client.ts"
    )
    throw new Error("AniList token response did not include an access token")
  }

  console.log("[Info] [Anilist] AniList OAuth token exchange completed.")

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type ?? "Bearer",
  }
}

function decodeAniListUserIdFromToken(accessToken: string) {
  const [, payload] = accessToken.split(".")

  if (!payload) {
    throw new Error("AniList access token did not include a readable user id")
  }

  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: string | number
  }
  const userId = Number(decoded.sub)

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("AniList access token user id was invalid")
  }

  return userId
}

export async function getAniListViewer(accessToken: string) {
  const userId = decodeAniListUserIdFromToken(accessToken)
  const result = await queueAniListOperation(
    () => getAniListClient(accessToken).user.getUserInfo(userId),
    { label: `Load AniList viewer ${userId}` }
  )
  const viewer = result.User as AniListViewer | null

  if (!viewer) {
    console.error(
      "[Error] [Anilist] AniList viewer lookup returned no viewer - client.ts"
    )
    throw new Error("AniList viewer lookup failed")
  }

  return viewer
}

function getAniListAccessTokenForUser(username: string) {
  if (!isAniListConfigured()) {
    return null
  }

  const connection = getAniListConnection(username)

  if (!connection) {
    return null
  }

  return connection.accessToken
}

function getRatingScale(scoreFormat?: string | null): 5 | 10 {
  return scoreFormat === "POINT_5" || scoreFormat === "POINT_3" ? 5 : 10
}

function clampRating(value: number, scale: 5 | 10) {
  return Math.min(Math.max(Math.round(value), 1), scale)
}

function scoreToRating(
  score: number | null | undefined,
  scoreFormat?: string | null
) {
  if (!score || score <= 0) {
    return null
  }

  if (scoreFormat === "POINT_100") {
    return clampRating(score / 10, 10)
  }

  if (scoreFormat === "POINT_3") {
    return clampRating((score / 3) * 5, 5)
  }

  return clampRating(score, getRatingScale(scoreFormat))
}

function ratingToScore(rating: number, scoreFormat?: string | null) {
  const scale = getRatingScale(scoreFormat)
  const normalizedRating = clampRating(rating, scale)

  if (scoreFormat === "POINT_100") {
    return normalizedRating * 10
  }

  if (scoreFormat === "POINT_3") {
    return Math.min(Math.max(Math.round((normalizedRating / 5) * 3), 1), 3)
  }

  return normalizedRating
}

function toMediaListStatus(value: string | null | undefined) {
  const statuses = Object.values(mediaListStatus) as MediaListStatusInput[]

  if (value && statuses.includes(value as MediaListStatusInput)) {
    return value as MediaListStatusInput
  }

  return null
}

function flattenListEntries(collection: AniListListCollection) {
  return (
    collection.MediaListCollection?.lists
      ?.flatMap((list) => list?.entries ?? [])
      .filter((entry): entry is AniListListEntry => Boolean(entry?.id)) ?? []
  )
}

function toIsoDate(value: number | string | null | undefined) {
  if (!value) {
    return null
  }

  if (typeof value === "number") {
    return new Date(value * 1000).toISOString()
  }

  return value
}

function normalizeListEntry(entry: AniListListEntry) {
  if (!entry.id || !entry.mediaId) {
    return null
  }

  return {
    id: entry.id,
    mediaId: entry.mediaId,
    status: entry.status,
    progress: entry.progress,
    score: entry.score,
    createdAt: toIsoDate(entry.createdAt),
    updatedAt: toIsoDate(entry.updatedAt),
  }
}

function cachedToListEntry(entry: CachedAniListMediaListEntry): AniListListEntry {
  return {
    id: entry.listEntryId,
    mediaId: entry.mediaId,
    status: entry.status,
    progress: entry.progress,
    score: entry.score,
    repeat: null,
  }
}

async function readUserInfo(input: {
  accessToken: string
  aniListUserId: number
}) {
  const result = await queueAniListOperation(
    () => getAniListClient(input.accessToken).user.getUserInfo(input.aniListUserId),
    { label: `Read AniList user info ${input.aniListUserId}` }
  )

  return result.User as AniListViewer | null
}

async function readUserAnimeList(input: {
  accessToken: string
  aniListUserId: number
}) {
  const result = await queueAniListOperation(
    () =>
      getAniListClient(input.accessToken).media.getMediaList(
        input.aniListUserId,
        "ANIME"
      ),
    { label: `Read AniList anime list ${input.aniListUserId}` }
  )

  return flattenListEntries(result as AniListListCollection)
}


async function readMediaListEntryByAnimeId(input: {
  accessToken: string
  aniListUserId: number
  animeId: number
}) {
  const entries = await readUserAnimeList({
    accessToken: input.accessToken,
    aniListUserId: input.aniListUserId,
  })

  return entries.find((entry) => entry.mediaId === input.animeId) ?? null
}

async function getCachedOrSyncedEntry(connection: AniListConnection, animeId: number) {
  const cached = getCachedAniListMediaListEntry({
    username: connection.username,
    mediaId: animeId,
  })

  if (cached) {
    return cachedToListEntry(cached)
  }

  await syncAniListLibraryProgress(connection.username)

  const refreshed = getCachedAniListMediaListEntry({
    username: connection.username,
    mediaId: animeId,
  })

  return refreshed ? cachedToListEntry(refreshed) : null
}

function cacheSavedEntry(connection: AniListConnection, entry: AniListListEntry | null) {
  const normalized = entry ? normalizeListEntry(entry) : null

  if (!normalized) {
    return
  }

  upsertAniListMediaListEntries({
    username: connection.username,
    aniListUserId: connection.aniListUserId,
    entries: [normalized],
  })
}

export async function getAniListTrackingState(
  username: string,
  animeId: number
) {
  if (!isAniListConfigured()) {
    return {
      configured: false,
      connected: false,
      entry: null,
      ratingScale: 10,
    }
  }

  const safeConnection = getSafeAniListConnection(username)

  if (!safeConnection) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
      ratingScale: 10,
    }
  }

  const connection = getAniListConnection(username)

  if (!connection) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
      ratingScale: 10,
    }
  }

  const entry = await getCachedOrSyncedEntry(connection, animeId)
  const currentConnection = getAniListConnection(username) ?? connection

  if (entry?.progress) {
    markEpisodesCompleteThrough({
      username,
      animeId,
      progress: entry.progress,
    })
  }

  console.log(
    `[Info] [Anilist] Loaded tracking state - Anime id ${animeId}, Progress: ${entry?.progress ?? "none"}`
  )

  return {
    configured: isAniListConfigured(),
    connected: true,
    user: safeConnection,
    entry: entry
      ? {
          id: entry.id,
          status: entry.status,
          progress: entry.progress ?? 0,
          score: entry.score ?? null,
          rating: scoreToRating(entry.score, currentConnection.scoreFormat),
        }
      : null,
    scoreFormat: currentConnection.scoreFormat,
    ratingScale: getRatingScale(currentConnection.scoreFormat),
  }
}

export async function saveAniListProgress(input: {
  username: string
  animeId: number
  progress: number
  completed?: boolean
  allowProgressDecrease?: boolean
  updateLocalProgress?: boolean
}) {
  const connection = getAniListConnection(input.username)
  const accessToken = getAniListAccessTokenForUser(input.username)

  if (!connection || !accessToken) {
    return null
  }

  const current = await getCachedOrSyncedEntry(connection, input.animeId)
  const currentStatus = toMediaListStatus(current?.status)
  const progress = input.allowProgressDecrease
    ? Math.max(input.progress, 0)
    : Math.max(input.progress, current?.progress ?? 0, 0)
  const status = input.completed
    ? completedStatus
    : watchingStatuses.has(current?.status ?? "")
      ? (currentStatus ?? mediaListStatus.Current)
      : mediaListStatus.Current
  const saveInput: SaveMediaListEntryInput = {
    mediaId: input.animeId,
    status,
    progress,
    score: current?.score ?? undefined,
  }

  const saved = await queueAniListOperation(
    () => getAniListClient(accessToken).mediaList.saveEntry(saveInput),
    { label: `Save AniList progress for anime ${input.animeId}` }
  )
  const rawSavedEntry = (saved.SaveMediaListEntry ?? null) as AniListListEntry | null
  const savedEntry = rawSavedEntry ?? null

  cacheSavedEntry(connection, savedEntry)
  if (input.updateLocalProgress !== false) {
    markEpisodesCompleteThrough({
      username: input.username,
      animeId: input.animeId,
      progress,
    })
  }

  console.log(
    `[Info] [Anilist] Saved progress - Anime id ${input.animeId}, Episode ${progress}, Status: ${status}`
  )

  return savedEntry
}

export async function markAniListWatchingStarted(input: {
  username: string
  animeId: number
}) {
  const connection = getAniListConnection(input.username)
  const accessToken = getAniListAccessTokenForUser(input.username)

  if (!connection || !accessToken) {
    return null
  }

  const exactEntry = await readMediaListEntryByAnimeId({
    accessToken,
    aniListUserId: connection.aniListUserId,
    animeId: input.animeId,
  })
  const current = exactEntry ?? (await getCachedOrSyncedEntry(connection, input.animeId))
  const currentStatus = toMediaListStatus(current?.status)

  if (watchingStatuses.has(current?.status ?? "")) {
    cacheSavedEntry(connection, current)
    return current
  }

  const isCompletedRewatch = currentStatus === completedStatus
  const progress = isCompletedRewatch ? 0 : Math.max(current?.progress ?? 0, 0)
  const repeat = isCompletedRewatch
    ? Math.max(current?.repeat ?? 0, 0) + 1
    : current?.repeat ?? undefined
  const status = isCompletedRewatch ? rewatchingStatus : mediaListStatus.Current
  const saveInput: SaveMediaListEntryInput = {
    mediaId: input.animeId,
    status,
    progress,
    score: current?.score ?? undefined,
  }

  if (typeof repeat === "number") {
    saveInput.repeat = repeat
  }

  const saved = await queueAniListOperation(
    () => getAniListClient(accessToken).mediaList.saveEntry(saveInput),
    { label: `Mark AniList watching for anime ${input.animeId}` }
  )
  const rawSavedEntry = (saved.SaveMediaListEntry ?? null) as AniListListEntry | null
  const savedEntry = rawSavedEntry ?? null

  cacheSavedEntry(connection, savedEntry)

  if (progress > 0) {
    markEpisodesCompleteThrough({
      username: input.username,
      animeId: input.animeId,
      progress,
    })
  }

  console.log(
    `[Info] [Anilist] Marked anime as ${isCompletedRewatch ? "rewatching" : "watching"} - Anime id ${input.animeId}`
  )

  return savedEntry
}

export async function saveAniListRating(input: {
  username: string
  animeId: number
  rating: number
}) {
  const connection = getAniListConnection(input.username)
  const accessToken = getAniListAccessTokenForUser(input.username)

  if (!connection || !accessToken) {
    return null
  }

  const current = await getCachedOrSyncedEntry(connection, input.animeId)
  const currentConnection = getAniListConnection(input.username) ?? connection
  const status = toMediaListStatus(current?.status) ?? mediaListStatus.Current
  const progress = current?.progress ?? 0
  const score = ratingToScore(input.rating, currentConnection.scoreFormat)
  const saveInput: SaveMediaListEntryInput = {
    mediaId: input.animeId,
    status,
    progress,
    score,
  }

  const saved = await queueAniListOperation(
    () => getAniListClient(accessToken).mediaList.saveEntry(saveInput),
    { label: `Save AniList rating for anime ${input.animeId}` }
  )
  const rawSavedEntry = (saved.SaveMediaListEntry ?? null) as AniListListEntry | null
  const savedEntry = rawSavedEntry ?? null

  cacheSavedEntry(connection, savedEntry)

  console.log(
    `[Info] [Anilist] Saved rating - Anime id ${input.animeId}, Rating ${input.rating}/${getRatingScale(currentConnection.scoreFormat)}`
  )

  return savedEntry
}

export async function syncAniListLibraryProgress(username: string) {
  if (!isAniListConfigured()) {
    return { synced: false, reason: "not-configured" as const }
  }

  const connection = getAniListConnection(username)

  if (!connection) {
    return { synced: false, reason: "not-connected" as const }
  }

  const userInfo = await readUserInfo({
    accessToken: connection.accessToken,
    aniListUserId: connection.aniListUserId,
  })
  const scoreFormat = userInfo?.mediaListOptions?.scoreFormat ?? null

  updateAniListConnectionScoreFormat({
    username,
    scoreFormat,
  })

  const entries = await readUserAnimeList({
    accessToken: connection.accessToken,
    aniListUserId: connection.aniListUserId,
  })
  const normalizedEntries = entries
    .map(normalizeListEntry)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

  upsertAniListMediaListEntries({
    username,
    aniListUserId: connection.aniListUserId,
    entries: normalizedEntries,
    replace: true,
  })

  let matchedEntries = 0

  for (const entry of normalizedEntries) {
    if (!entry.progress) {
      continue
    }

    const updatedEpisodes = markEpisodesCompleteThrough({
      username,
      animeId: entry.mediaId,
      progress: entry.progress,
    })

    if (updatedEpisodes > 0) {
      matchedEntries += 1
    }
  }

  markAniListConnectionSynced(username)

  console.log(
    `[Info] [Anilist] Synced library progress - Entries: ${entries.length}, Matched: ${matchedEntries}`
  )

  return { synced: true, matchedEntries }
}
