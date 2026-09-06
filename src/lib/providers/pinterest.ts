/**
 * Pinterest — OAuth 2.0 + API v5.
 * Docs: https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/
 *
 * Reads the connected account's own pins and keeps the video ones.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const API = "https://api.pinterest.com/v5";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  message?: string;
}
interface Account {
  username?: string;
  id?: string;
}
interface Pins {
  items?: Array<{
    id: string;
    title?: string;
    description?: string;
    created_at?: string;
    link?: string;
    media?: {
      media_type?: string;
      cover_image_url?: string;
      video_url?: string;
      duration?: number;
      images?: Record<string, { url?: string }>;
    };
  }>;
}

function basic(creds: { clientId: string; clientSecret: string }): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}` };
}

export const pinterest: SocialProvider = {
  id: "pinterest",
  name: "Pinterest",
  capability: "Video pins from your own account (Pinterest API v5).",
  color: "#bd081c",
  envVars: { clientId: "PINTEREST_APP_ID", clientSecret: "PINTEREST_APP_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://www.pinterest.com/oauth/");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "pins:read,user_accounts:read");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const tok = await postForm<TokenResponse>(
      "pinterest",
      `${API}/oauth/token`,
      { grant_type: "authorization_code", code, redirect_uri: creds.redirectUri },
      basic(creds),
    );
    if (tok.error) throw new Error(`Pinterest: ${tok.message ?? tok.error}`);
    const me = await getJson<Account>("pinterest", `${API}/user_account`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: me.id ?? me.username ?? "me",
      displayName: me.username ? `@${me.username}` : "Pinterest user",
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>(
      "pinterest",
      `${API}/oauth/token`,
      { grant_type: "refresh_token", refresh_token: refreshToken },
      basic(creds),
    );
    if (tok.error || !tok.access_token) return null;
    return { accessToken: tok.access_token, refreshToken, expiresAt: expiresAtFrom(tok.expires_in), scope: tok.scope ?? null, providerUserId: "", displayName: "" };
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const res = await getJson<Pins>("pinterest", `${API}/pins?page_size=50`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return (res.items ?? [])
      .filter((p) => p.media?.media_type === "video")
      .map((p) => {
        const images = p.media?.images ?? {};
        const thumb = p.media?.cover_image_url ?? images["1200x"]?.url ?? images["600x"]?.url ?? images.originals?.url ?? null;
        return {
          key: `pinterest:${p.id}`,
          provider: "pinterest" as const,
          externalId: p.id,
          title: p.title || (p.description ?? "").split("\n")[0] || "Video pin",
          creator: "You",
          creatorHandle: providerUserId,
          permalink: `https://www.pinterest.com/pin/${p.id}/`,
          thumbnailUrl: thumb,
          videoUrl: p.media?.video_url ?? null,
          durationSeconds: p.media?.duration != null ? Math.round(p.media.duration / (p.media.duration > 1000 ? 1000 : 1)) : null,
          publishedAt: p.created_at ? Date.parse(p.created_at) : 0,
          metrics: {},
        };
      });
  },
};
