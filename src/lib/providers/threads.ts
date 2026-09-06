/**
 * Threads — Threads API.
 * Docs: https://developers.facebook.com/docs/threads/get-started
 *
 * Reads the connected account's own posts and keeps the ones carrying a video.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const API = "https://graph.threads.net/v1.0";

interface ShortToken {
  access_token: string;
  user_id: string | number;
  error_message?: string;
}
interface LongToken {
  access_token: string;
  expires_in?: number;
}
interface Me {
  id: string;
  username?: string;
}
interface Posts {
  data?: Array<{
    id: string;
    media_type: "TEXT_POST" | "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | "AUDIO" | "REPOST_FACADE";
    media_url?: string;
    permalink?: string;
    text?: string;
    timestamp?: string;
    thumbnail_url?: string;
    username?: string;
  }>;
}

export const threads: SocialProvider = {
  id: "threads",
  name: "Threads",
  capability: "Video posts from your own Threads account (Threads API).",
  color: "#000000",
  envVars: { clientId: "THREADS_APP_ID", clientSecret: "THREADS_APP_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://threads.net/oauth/authorize");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "threads_basic");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const short = await postForm<ShortToken>("threads", "https://graph.threads.net/oauth/access_token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
      code,
    });
    if (short.error_message) throw new Error(`Threads: ${short.error_message}`);
    const l = new URL("https://graph.threads.net/access_token");
    l.searchParams.set("grant_type", "th_exchange_token");
    l.searchParams.set("client_secret", creds.clientSecret);
    l.searchParams.set("access_token", short.access_token);
    const long = await getJson<LongToken>("threads", l.toString());
    const me = await getJson<Me>("threads", `${API}/me?fields=id,username&access_token=${encodeURIComponent(long.access_token)}`);
    return {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt: expiresAtFrom(long.expires_in),
      scope: "threads_basic",
      providerUserId: String(me.id ?? short.user_id),
      displayName: me.username ? `@${me.username}` : "Threads user",
    };
  },

  async refresh(_creds, accessToken): Promise<OAuthTokens | null> {
    const u = new URL("https://graph.threads.net/refresh_access_token");
    u.searchParams.set("grant_type", "th_refresh_token");
    u.searchParams.set("access_token", accessToken);
    const r = await getJson<LongToken>("threads", u.toString());
    return { accessToken: r.access_token, refreshToken: null, expiresAt: expiresAtFrom(r.expires_in), scope: "threads_basic", providerUserId: "", displayName: "" };
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const fields = "id,media_type,media_url,permalink,text,timestamp,thumbnail_url,username";
    const res = await getJson<Posts>("threads", `${API}/me/threads?fields=${fields}&limit=50&access_token=${encodeURIComponent(accessToken)}`);
    return (res.data ?? [])
      .filter((p) => p.media_type === "VIDEO")
      .map((p) => ({
        key: `threads:${p.id}`,
        provider: "threads" as const,
        externalId: p.id,
        title: (p.text ?? "").split("\n")[0] || "Video post",
        creator: p.username ? `@${p.username}` : "You",
        creatorHandle: p.username ?? providerUserId,
        permalink: p.permalink ?? "https://www.threads.net/",
        thumbnailUrl: p.thumbnail_url ?? null,
        videoUrl: p.media_url ?? null,
        durationSeconds: null,
        publishedAt: p.timestamp ? Date.parse(p.timestamp) : 0,
        metrics: {},
      }));
  },
};
