/**
 * Reddit — OAuth2 + Data API.
 * Docs: https://github.com/reddit-archive/reddit/wiki/OAuth2
 *
 * Reads the user's home feed (`/best`) and keeps native video posts. This is one of the
 * few platforms that hands third parties a genuine personalised feed.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const UA = "daily-scroll/0.1 (+https://github.com/Platteration/notenote)";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface Me {
  id: string;
  name: string;
}
interface Listing {
  data?: {
    children?: Array<{
      data: {
        id: string;
        title: string;
        author: string;
        subreddit: string;
        permalink: string;
        created_utc: number;
        is_video?: boolean;
        score?: number;
        num_comments?: number;
        media?: { reddit_video?: { fallback_url?: string; duration?: number } } | null;
        preview?: { images?: Array<{ source?: { url?: string } }> };
        thumbnail?: string;
      };
    }>;
  };
}

function basic(creds: { clientId: string; clientSecret: string }): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`, "User-Agent": UA };
}

export const reddit: SocialProvider = {
  id: "reddit",
  name: "Reddit",
  capability: "Video posts from your home feed (Reddit API).",
  color: "#ff4500",
  envVars: { clientId: "REDDIT_CLIENT_ID", clientSecret: "REDDIT_CLIENT_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://www.reddit.com/api/v1/authorize");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("duration", "permanent");
    u.searchParams.set("scope", "identity read");
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const tok = await postForm<TokenResponse>(
      "reddit",
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "authorization_code", code, redirect_uri: creds.redirectUri },
      basic(creds),
    );
    if (tok.error) throw new Error(`Reddit: ${tok.error}`);
    const me = await getJson<Me>("reddit", "https://oauth.reddit.com/api/v1/me", {
      headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": UA },
    });
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: me.id,
      displayName: `u/${me.name}`,
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>(
      "reddit",
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "refresh_token", refresh_token: refreshToken },
      basic(creds),
    );
    if (tok.error || !tok.access_token) return null;
    return { accessToken: tok.access_token, refreshToken, expiresAt: expiresAtFrom(tok.expires_in), scope: tok.scope ?? null, providerUserId: "", displayName: "" };
  },

  async fetchItems(accessToken): Promise<MediaItem[]> {
    const res = await getJson<Listing>("reddit", "https://oauth.reddit.com/best?limit=100&raw_json=1", {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": UA },
    });
    const out: MediaItem[] = [];
    for (const child of res.data?.children ?? []) {
      const p = child.data;
      const video = p.media?.reddit_video;
      if (!p.is_video || !video) continue;
      const preview = p.preview?.images?.[0]?.source?.url;
      out.push({
        key: `reddit:${p.id}`,
        provider: "reddit",
        externalId: p.id,
        title: p.title,
        creator: `r/${p.subreddit}`,
        creatorHandle: p.author,
        permalink: `https://www.reddit.com${p.permalink}`,
        thumbnailUrl: preview ?? (p.thumbnail?.startsWith("http") ? p.thumbnail : null),
        videoUrl: video.fallback_url ?? null,
        durationSeconds: video.duration ?? null,
        publishedAt: p.created_utc * 1000,
        metrics: { likes: p.score, comments: p.num_comments },
      });
    }
    return out;
  },
};
