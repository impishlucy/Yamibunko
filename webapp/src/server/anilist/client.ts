import {
  AniListOperations,
  type SaveMediaListEntryInput,
} from "@api-wrappers/anilist-wrapper"

import { getServerConfig } from "@/server/config"
import {
  getAniListConnection,
  getSafeAniListConnection,
  markAniListConnectionSynced,
} from "@/server/db/anilistConnections"
import {
  getAniListMediaEntry,
  replaceAniListMediaEntries,
  upsertAniListMediaEntry,
  type AniListMediaEntryInput,
} from "@/server/db/anilistMediaEntries"
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

  const response = await queueAniListOperation(() =>
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
    })
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

export async function getAniListViewer(accessToken: string) {
  const userService = getAniListClient(accessToken).user as {
    getUserInfo: (userId?: number) => Promise<{ User?: AniListViewer | null }>
  }
  const result = await queueAniListOperation(() =>
    userService.getUserInfo()
  )
  const viewer = result.User ?? null

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
      .filter((entry): entry is AniListListEntry => Boolean(entry)) ?? []
  )
}

function toLocalListEntry(
  entry: AniListListEntry | null | undefined
): AniListMediaEntryInput | null {
  if (!entry?.mediaId) {
    return null
  }

  return {
    mediaId: entry.mediaId,
    listEntryId: entry.id,
    status: entry.status,
    progress: entry.progress ?? 0,
    score: entry.score ?? null,
  }
}

async function readUserInfo(input: {
  accessToken: string
  aniListUserId: number
}) {
  const result = await queueAniListOperation(() =>
    getAniListClient(input.accessToken).user.getUserInfo(input.aniListUserId)
  )

  return result.User as AniListViewer | null
}

async function readUserAnimeList(input: {
  accessToken: string
  aniListUserId: number
}) {
  const result = await queueAniListOperation(() =>
    getAniListClient(input.accessToken).media.getMediaList(
      input.aniListUserId,
      "ANIME"
    )
  )

  return flattenListEntries(result as AniListListCollection)
}

async function ensureLocalAniListCache(username: string) {
  const connection = getAniListConnection(username)

  if (!connection) {
    return null
  }

  if (!connection.lastListSyncAt) {
    await syncAniListUserList(username)
  }

  return getAniListConnection(username)
}

function readLocalMediaListEntry(input: {
  username: string
  animeId: number
}) {
  const entry = getAniListMediaEntry(input.username, input.animeId)

  return {
    entry,
    scoreFormat: entry?.scoreFormat ?? null,
    ratingScale: getRatingScale(entry?.scoreFormat ?? null),
  }
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

  await ensureLocalAniListCache(username)

  const listState = readLocalMediaListEntry({
    username,
    animeId,
  })
  const entry = listState?.entry ?? null

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
          id: entry.listEntryId ?? entry.mediaId,
          status: entry.status,
          progress: entry.progress,
          score: entry.score ?? null,
          rating: scoreToRating(entry.score, listState?.scoreFormat ?? null),
        }
      : null,
    scoreFormat: listState?.scoreFormat ?? null,
    ratingScale: listState?.ratingScale ?? 10,
  }
}

export async function saveAniListProgress(input: {
  username: string
  animeId: number
  progress: number
}) {
  const accessToken = getAniListAccessTokenForUser(input.username)

  if (!accessToken) {
    return null
  }

  await ensureLocalAniListCache(input.username)

  const current = readLocalMediaListEntry({
    username: input.username,
    animeId: input.animeId,
  })
  const status = watchingStatuses.has(current?.entry?.status ?? "")
    ? (toMediaListStatus(current?.entry?.status) ?? mediaListStatus.Current)
    : mediaListStatus.Current
  const saved = await queueAniListOperation(() =>
    getAniListClient(accessToken).mediaList.saveEntry({
      mediaId: input.animeId,
      status,
      progress: Math.max(input.progress, 0),
      score: current?.entry?.score ?? undefined,
    })
  )
  const savedEntry = toLocalListEntry(saved.SaveMediaListEntry as AniListListEntry)

  if (savedEntry) {
    upsertAniListMediaEntry({
      username: input.username,
      entry: savedEntry,
      scoreFormat: current.scoreFormat,
    })
  }

  markEpisodesCompleteThrough({
    username: input.username,
    animeId: input.animeId,
    progress: input.progress,
  })

  console.log(
    `[Info] [Anilist] Saved progress - Anime id ${input.animeId}, Episode ${input.progress}`
  )

  return saved.SaveMediaListEntry ?? null
}

export async function saveAniListRating(input: {
  username: string
  animeId: number
  rating: number
}) {
  const accessToken = getAniListAccessTokenForUser(input.username)

  if (!accessToken) {
    return null
  }

  await ensureLocalAniListCache(input.username)

  const current = readLocalMediaListEntry({
    username: input.username,
    animeId: input.animeId,
  })
  const status = toMediaListStatus(current?.entry?.status) ?? mediaListStatus.Current
  const progress = current?.entry?.progress ?? 0
  const score = ratingToScore(input.rating, current?.scoreFormat ?? null)
  const saved = await queueAniListOperation(() =>
    getAniListClient(accessToken).mediaList.saveEntry({
      mediaId: input.animeId,
      status,
      progress,
      score,
    })
  )
  const savedEntry = toLocalListEntry(saved.SaveMediaListEntry as AniListListEntry)

  if (savedEntry) {
    upsertAniListMediaEntry({
      username: input.username,
      entry: savedEntry,
      scoreFormat: current.scoreFormat,
    })
  }

  console.log(
    `[Info] [Anilist] Saved rating - Anime id ${input.animeId}, Rating ${input.rating}/${current?.ratingScale ?? 10}`
  )

  return saved.SaveMediaListEntry ?? null
}

export async function syncAniListUserList(username: string) {
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
  const entries = await readUserAnimeList({
    accessToken: connection.accessToken,
    aniListUserId: connection.aniListUserId,
  })
  const localEntries = entries
    .map(toLocalListEntry)
    .filter((entry): entry is AniListMediaEntryInput => Boolean(entry))
  let matchedEntries = 0

  replaceAniListMediaEntries({
    username,
    entries: localEntries,
    scoreFormat,
  })

  for (const entry of entries) {
    if (!entry.mediaId || !entry.progress) {
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
    `[Info] [Anilist] Synced user media list - User ${username}, Entries: ${entries.length}, Matched: ${matchedEntries}`
  )

  return { synced: true, entries: entries.length, matchedEntries }
}

export const syncAniListLibraryProgress = syncAniListUserList
