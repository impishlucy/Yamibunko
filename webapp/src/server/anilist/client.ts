import { gql, MediaListStatus } from "@api-wrappers/anilist-wrapper"

import { getServerConfig } from "@/server/config"
import {
  getAniListConnection,
  getSafeAniListConnection,
  markAniListConnectionSynced,
} from "@/server/db/anilistConnections"
import { markEpisodesCompleteThrough } from "@/server/db/library"
import { joinBaseUrl } from "@/server/http/baseUrl"
import { getPublicBaseUrl } from "@/server/http/request"
import {
  queueAniListOperation,
  requestAniListGraphQL,
} from "@/server/anilist/transport"
import { serverLog } from "@/server/logger"

type AniListTokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number | null
}

type AniListViewerResponse = {
  Viewer?: {
    id: number
    name: string
  } | null
}

type AniListMediaListResponse = {
  MediaList?: {
    id: number
    status: string | null
    progress: number | null
  } | null
}

type AniListSaveMediaListResponse = {
  SaveMediaListEntry?: {
    id: number
    status: string | null
    progress: number | null
  } | null
}

type AniListUserAnimeListResponse = {
  MediaListCollection?: {
    lists?: Array<{
      entries?: Array<{
        mediaId: number | null
        status: string | null
        progress: number | null
      } | null> | null
    } | null> | null
  } | null
}

const viewerQuery = gql`
  query YamibunkoViewer {
    Viewer {
      id
      name
    }
  }
`

const mediaListQuery = gql`
  query YamibunkoMediaList($mediaId: Int) {
    MediaList(mediaId: $mediaId) {
      id
      status
      progress
    }
  }
`

const userAnimeListQuery = gql`
  query YamibunkoUserAnimeList($userId: Int!) {
    MediaListCollection(userId: $userId, type: ANIME) {
      lists {
        entries {
          mediaId
          status
          progress
        }
      }
    }
  }
`

const saveMediaListProgressMutation = gql`
  mutation YamibunkoSaveMediaListProgress(
    $mediaId: Int
    $status: MediaListStatus
    $progress: Int
  ) {
    SaveMediaListEntry(
      mediaId: $mediaId
      status: $status
      progress: $progress
    ) {
      id
      status
      progress
    }
  }
`

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
    serverLog.error("Anilist", "OAuth authorization URL requested but AniList is not configured.")
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
    serverLog.error("Anilist", "OAuth code exchange requested but AniList is not configured.")
    throw new Error("AniList OAuth is not configured")
  }

  const redirectUri = await getAniListRedirectUri(request)
  serverLog.info("Anilist", "Exchanging OAuth authorization code.", {
    redirectUri,
  })

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
    serverLog.error("Anilist", "AniList token exchange failed.", {
      status: response.status,
      statusText: response.statusText,
      body,
    })
    throw new Error("AniList token exchange failed")
  }

  const payload = (await response.json()) as AniListTokenResponse

  if (!payload.access_token) {
    serverLog.error("Anilist", "AniList token response did not include an access token.", {
      tokenType: payload.token_type,
      expiresIn: payload.expires_in,
    })
    throw new Error("AniList token response did not include an access token")
  }

  serverLog.info("Anilist", "AniList OAuth token exchange completed.", {
    tokenType: payload.token_type ?? "Bearer",
    expiresIn: payload.expires_in ?? null,
  })

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type ?? "Bearer",
  }
}

export async function getAniListViewer(accessToken: string) {
  const result = await requestAniListGraphQL<AniListViewerResponse>({
    query: viewerQuery,
    accessToken,
  })
  const viewer = result.Viewer

  if (!viewer) {
    serverLog.error("Anilist", "AniList viewer lookup returned no viewer.")
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

export async function getAniListTrackingState(
  username: string,
  animeId: number
) {
  if (!isAniListConfigured()) {
    return {
      configured: false,
      connected: false,
      entry: null,
    }
  }

  const safeConnection = getSafeAniListConnection(username)

  if (!safeConnection) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
    }
  }

  const accessToken = getAniListAccessTokenForUser(username)

  if (!accessToken) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
    }
  }

  const result = await requestAniListGraphQL<
    AniListMediaListResponse,
    { mediaId: number }
  >({
    query: mediaListQuery,
    variables: { mediaId: animeId },
    accessToken,
  })
  const entry = result.MediaList

  if (entry?.progress) {
    markEpisodesCompleteThrough({
      username,
      animeId,
      progress: entry.progress,
    })
  }

  serverLog.info("Anilist", "Loaded AniList tracking state.", {
    username,
    animeId,
    connected: true,
    progress: entry?.progress ?? null,
    status: entry?.status ?? null,
  })

  return {
    configured: isAniListConfigured(),
    connected: true,
    user: safeConnection,
    entry: entry
      ? {
          id: entry.id,
          status: entry.status,
          progress: entry.progress ?? 0,
        }
      : null,
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

  const saved = await requestAniListGraphQL<
    AniListSaveMediaListResponse,
    {
      mediaId: number
      status: MediaListStatus
      progress: number
    }
  >({
    query: saveMediaListProgressMutation,
    variables: {
      mediaId: input.animeId,
      status: MediaListStatus.Current,
      progress: Math.max(input.progress, 0),
    },
    accessToken,
  })

  markEpisodesCompleteThrough({
    username: input.username,
    animeId: input.animeId,
    progress: input.progress,
  })

  serverLog.info("Anilist", "Saved AniList progress.", {
    username: input.username,
    animeId: input.animeId,
    progress: input.progress,
    savedProgress: saved.SaveMediaListEntry?.progress ?? null,
    status: saved.SaveMediaListEntry?.status ?? null,
  })

  return saved.SaveMediaListEntry ?? null
}

export async function syncAniListLibraryProgress(username: string) {
  if (!isAniListConfigured()) {
    return { synced: false, reason: "not-configured" as const }
  }

  const connection = getAniListConnection(username)

  if (!connection) {
    return { synced: false, reason: "not-connected" as const }
  }

  const result = await requestAniListGraphQL<
    AniListUserAnimeListResponse,
    { userId: number }
  >({
    query: userAnimeListQuery,
    variables: { userId: connection.aniListUserId },
    accessToken: connection.accessToken,
  })
  const entries =
    result.MediaListCollection?.lists
      ?.flatMap((list) => list?.entries ?? [])
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) ??
    []

  let matchedEntries = 0

  for (const entry of entries) {
    if (!entry.mediaId || !entry.progress) {
      continue
    }

    markEpisodesCompleteThrough({
      username,
      animeId: entry.mediaId,
      progress: entry.progress,
    })
    matchedEntries += 1
  }

  markAniListConnectionSynced(username)

  serverLog.info("Anilist", "Synced AniList library progress.", {
    username,
    entries: entries.length,
    matchedEntries,
  })

  return { synced: true, matchedEntries }
}
