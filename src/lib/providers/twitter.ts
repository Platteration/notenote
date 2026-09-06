/**
 * X (Twitter) — OAuth 2.0 with PKCE + API v2.
 * Docs: https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code
 *       https://developer.x.com/en/docs/x-api/tweets/timelines/api-reference/get-users-id-reverse-chronological
 *
 * We read the reverse-chronological home timeline and keep posts carrying a short video.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const API = "https://api.x.com/2";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface Me {
  data?: { id: string; name?: string; username?: string };
}
interface Timeline {
  data?: Array<{
    id: string;
    text: string;
    author_id?: string;
    created_at?: string;
    attachments?: { media_keys?: string[] };
    public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number; impression_count?: number };
  }>;
  includes?: {
    media?: Array<{
      media_key: string;
      type: "video" | "photo" | "animated_gif";
      preview_image_url?: string;
      duration_ms?: number;
      variants?: Array<{ content_type: string; url: string; bit_rate?: number }>;
    }>;
    users?: Array<{ id: string; name?: string; username?: string }>;
  };
}

function basicAuth(creds: { clientId: string; clientSecret: string }): Record<string, string> {
  const b = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  return { Authorization: `Basic ${b}` };
}

export const twitter: SocialProvider = {
  id: "twitter",
  name: "X",
  capability: "Short videos from your home timeline (X API v2).",
  color: "#000000",
  envVars: { clientId: "TWITTER_CLIENT_ID", clientSecret: "TWITTER_CLIENT_SECRET" },
  usesPkce: true,

  buildAuthorizeUrl(creds, { state, codeChallenge }) {
    const u = new URL("https://x.com/i/oauth2/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("scope", "tweet.read users.read offline.access");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async exchangeCode(creds, code, codeVerifier) {
    const tok = await postForm<TokenResponse>(
      "twitter",
      `${API}/oauth2/token`,
      {
        code,
        grant_type: "authorization_code",
        client_id: creds.clientId,
        redirect_uri: creds.redirectUri,
        code_verifier: codeVerifier ?? "",
      },
      basicAuth(creds),
    );
    if (tok.error) throw new Error(`X: ${tok.error_description ?? tok.error}`);
    const me = await getJson<Me>("twitter", `${API}/users/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: me.data?.id ?? "me",
      displayName: me.data?.username ? `@${me.data.username}` : "X user",
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>(
      "twitter",
      `${API}/oauth2/token`,
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: creds.clientId },
      basicAuth(creds),
    );
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

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const u = new URL(`${API}/users/${providerUserId}/timelines/reverse_chronological`);
    u.searchParams.set("max_results", "100");
    u.searchParams.set("expansions", "attachments.media_keys,author_id");
    u.searchParams.set("media.fields", "type,preview_image_url,duration_ms,variants");
    u.searchParams.set("tweet.fields", "created_at,public_metrics,attachments");
    u.searchParams.set("user.fields", "name,username");
    const tl = await getJson<Timeline>("twitter", u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const media = new Map((tl.includes?.media ?? []).map((m) => [m.media_key, m]));
    const users = new Map((tl.includes?.users ?? []).map((usr) => [usr.id, usr]));
    const out: MediaItem[] = [];
    for (const t of tl.data ?? []) {
      const key = t.attachments?.media_keys?.find((k) => media.get(k)?.type === "video");
      if (!key) continue;
      const m = media.get(key)!;
      const author = users.get(t.author_id ?? "");
      const handle = author?.username ?? t.author_id ?? "";
      const best = (m.variants ?? [])
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
      out.push({
        key: `twitter:${t.id}`,
        provider: "twitter",
        externalId: t.id,
        title: t.text.replace(/https:\/\/t\.co\/\S+/g, "").trim() || "Video post",
        creator: author?.name ?? handle,
        creatorHandle: handle,
        permalink: `https://x.com/${handle}/status/${t.id}`,
        thumbnailUrl: m.preview_image_url ?? null,
        videoUrl: best?.url ?? null,
        durationSeconds: m.duration_ms != null ? Math.round(m.duration_ms / 1000) : null,
        publishedAt: t.created_at ? Date.parse(t.created_at) : 0,
        metrics: {
          views: t.public_metrics?.impression_count,
          likes: t.public_metrics?.like_count,
          comments: t.public_metrics?.reply_count,
          shares: t.public_metrics?.retweet_count,
        },
      });
    }
    return out;
  },
};
