/**
 * YouTube — Google OAuth 2.0 + YouTube Data API v3.
 * Docs: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
 *
 * We read the user's subscriptions, take the most recent uploads from each channel and
 * keep only Shorts-length videos (<= 90s). Quota note: each fetch costs roughly
 * 1 + channels + 2*channels units; we cap at 15 channels per refresh.
 */
import { expiresAtFrom, getJson, parseIsoDuration, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const API = "https://www.googleapis.com/youtube/v3";
const MAX_CHANNELS = 15;
const UPLOADS_PER_CHANNEL = 5;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface ChannelsMine {
  items?: Array<{ id: string; snippet?: { title?: string } }>;
}
interface Subscriptions {
  items?: Array<{ snippet?: { resourceId?: { channelId?: string }; title?: string } }>;
}
interface Channels {
  items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}
interface PlaylistItems {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
}
interface Videos {
  items?: Array<{
    id: string;
    snippet?: { title?: string; channelTitle?: string; channelId?: string; publishedAt?: string; thumbnails?: Record<string, { url: string }> };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

function auth(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

export const youtube: SocialProvider = {
  id: "youtube",
  name: "YouTube",
  capability: "Shorts from the channels you subscribe to (YouTube Data API).",
  color: "#ff0000",
  envVars: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" },
  usesPkce: true,

  buildAuthorizeUrl(creds, { state, codeChallenge }) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.readonly");
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async exchangeCode(creds, code, codeVerifier) {
    const tok = await postForm<TokenResponse>("youtube", "https://oauth2.googleapis.com/token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      code_verifier: codeVerifier ?? "",
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
    });
    if (tok.error) throw new Error(`Google: ${tok.error_description ?? tok.error}`);
    const me = await getJson<ChannelsMine>("youtube", `${API}/channels?part=snippet&mine=true`, auth(tok.access_token));
    const channel = me.items?.[0];
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: channel?.id ?? "me",
      displayName: channel?.snippet?.title ?? "YouTube user",
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>("youtube", "https://oauth2.googleapis.com/token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (tok.error || !tok.access_token) return null;
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? refreshToken,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: "",
      displayName: "",
    };
  },

  async fetchItems(accessToken): Promise<MediaItem[]> {
    const subs = await getJson<Subscriptions>(
      "youtube",
      `${API}/subscriptions?part=snippet&mine=true&maxResults=50&order=relevance`,
      auth(accessToken),
    );
    const channelIds = (subs.items ?? [])
      .map((s) => s.snippet?.resourceId?.channelId)
      .filter((id): id is string => Boolean(id))
      .slice(0, MAX_CHANNELS);
    if (channelIds.length === 0) return [];

    const channels = await getJson<Channels>(
      "youtube",
      `${API}/channels?part=snippet,contentDetails&id=${channelIds.join(",")}&maxResults=50`,
      auth(accessToken),
    );
    const handles = new Map<string, string>();
    const uploads: string[] = [];
    for (const ch of channels.items ?? []) {
      handles.set(ch.id, ch.snippet?.customUrl?.replace(/^@/, "") ?? ch.id);
      const pl = ch.contentDetails?.relatedPlaylists?.uploads;
      if (pl) uploads.push(pl);
    }

    const videoIds: string[] = [];
    await Promise.all(
      uploads.map(async (pl) => {
        try {
          const items = await getJson<PlaylistItems>(
            "youtube",
            `${API}/playlistItems?part=contentDetails&playlistId=${pl}&maxResults=${UPLOADS_PER_CHANNEL}`,
            auth(accessToken),
          );
          for (const it of items.items ?? []) if (it.contentDetails?.videoId) videoIds.push(it.contentDetails.videoId);
        } catch {
          /* a single channel failing should not sink the whole fetch */
        }
      }),
    );
    if (videoIds.length === 0) return [];

    const out: MediaItem[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const vids = await getJson<Videos>(
        "youtube",
        `${API}/videos?part=snippet,contentDetails,statistics&id=${batch.join(",")}`,
        auth(accessToken),
      );
      for (const v of vids.items ?? []) {
        const duration = v.contentDetails?.duration ? parseIsoDuration(v.contentDetails.duration) : null;
        const thumbs = v.snippet?.thumbnails ?? {};
        const thumb = thumbs.maxres?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;
        out.push({
          key: `youtube:${v.id}`,
          provider: "youtube",
          externalId: v.id,
          title: v.snippet?.title ?? "Untitled Short",
          creator: v.snippet?.channelTitle ?? "Unknown channel",
          creatorHandle: handles.get(v.snippet?.channelId ?? "") ?? v.snippet?.channelId ?? "",
          permalink: `https://www.youtube.com/shorts/${v.id}`,
          thumbnailUrl: thumb,
          videoUrl: null,
          durationSeconds: duration,
          publishedAt: v.snippet?.publishedAt ? Date.parse(v.snippet.publishedAt) : 0,
          metrics: {
            views: Number(v.statistics?.viewCount ?? 0),
            likes: Number(v.statistics?.likeCount ?? 0),
            comments: Number(v.statistics?.commentCount ?? 0),
          },
        });
      }
    }
    return out;
  },
};
