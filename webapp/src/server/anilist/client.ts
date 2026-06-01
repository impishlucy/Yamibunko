import {
  Anilist,
  gql,
  type SaveMediaListEntryInput,
} from "@api-wrappers/anilist-wrapper"

import { getServerConfig } from "@/server/config"
import {
  getAniListConnection,
  getSafeAniListConnection,
} from "@/server/db/anilistConnections"
import { markEpisodesCompleteThrough } from "@/server/db/library"
import { getRequestOrigin } from "@/server/http/request"

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

function getAniListOAuthConfig() {
  const config = getServerConfig()

  if (!config.anilistClientId || !config.anilistClientSecret) {
    return null
  }

  return {
    clientId: config.anilistClientId,
    clientSecret: config.anilistClientSecret,
    baseUrl: config.baseUrl
  }
}

export function isAniListConfigured() {
  return Boolean(getAniListOAuthConfig())
}

export async function getAniListRedirectUri(request: Request) {
  const oauthConfig = getAniListOAuthConfig()

  if (!oauthConfig) {
    throw new Error("AniList OAuth is not configured")
  }

  // Reverse-proxy deployments should set YAMIBUNKO_BASE_URL or ANILIST_REDIRECT_URI.
  const origin =
    oauthConfig.baseUrl ?? (await getRequestOrigin(request)).replace(/\/+$/, "")

  return `${origin}/api/anilist/oauth/callback`
}

export async function getAniListAuthorizationUrl(
  request: Request,
  state: string
) {
  const oauthConfig = getAniListOAuthConfig()

  if (!oauthConfig) {
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
    throw new Error("AniList OAuth is not configured")
  }

  const response = await fetch("https://anilist.co/api/v2/oauth/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      redirect_uri: await getAniListRedirectUri(request),
      code,
    }),
  })

  if (!response.ok) {
    throw new Error("AniList token exchange failed")
  }

  const payload = (await response.json()) as AniListTokenResponse

  if (!payload.access_token) {
    throw new Error("AniList token response did not include an access token")
  }

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type ?? "Bearer",
  }
}

export async function getAniListViewer(accessToken: string) {
  const client = new Anilist(accessToken)
  const result =
    await client.graphql.request<AniListViewerResponse>(viewerQuery)
  const viewer = result.Viewer

  if (!viewer) {
    throw new Error("AniList viewer lookup failed")
  }

  return viewer
}

export function getAniListClientForUser(username: string) {
  const connection = getAniListConnection(username)

  if (!connection) {
    return null
  }

  return new Anilist(connection.accessToken)
}

export async function getAniListTrackingState(
  username: string,
  animeId: number
) {
  const safeConnection = getSafeAniListConnection(username)

  if (!safeConnection) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
    }
  }

  const client = getAniListClientForUser(username)

  if (!client) {
    return {
      configured: isAniListConfigured(),
      connected: false,
      entry: null,
    }
  }

  const result = await client.graphql.request<
    AniListMediaListResponse,
    { mediaId: number }
  >(mediaListQuery, { mediaId: animeId })
  const entry = result.MediaList

  if (entry?.progress) {
    markEpisodesCompleteThrough({
      username,
      animeId,
      progress: entry.progress,
    })
  }

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
  const client = getAniListClientForUser(input.username)

  if (!client) {
    return null
  }

  const saved = await client.mediaList.saveEntry({
    mediaId: input.animeId,
    status: "CURRENT" as SaveMediaListEntryInput["status"],
    progress: Math.max(input.progress, 0),
  })

  markEpisodesCompleteThrough({
    username: input.username,
    animeId: input.animeId,
    progress: input.progress,
  })

  return saved.SaveMediaListEntry ?? null
}
