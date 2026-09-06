/**
 * Twitch — OAuth 2.0 + Helix API.
 * Docs: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow
 *       https://dev.twitch.tv/docs/api/reference/#get-clips
 *
 * Clips are Twitch's short-form format. We read recent clips from the channels you follow.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const HELIX = "https://api.twitch.tv/helix";
const MAX_CHANNELS = 20;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
  message?: string;
  status?: number;
}
interface Users {
  data?: Array<{ id: string; login: string; display_name?: string }>;
}
interface Followed {
  data?: Array<{ broadcaster_id: string; broadcaster_login: string; broadcaster_name: string }>;
}
interface Clips {
  data?: Array<{
    id: string;
    url: string;
    broadcaster_name: string;
    broadcaster_id: string;
    title: string;
    view_count?: number;
    created_at?: string;
    thumbnail_url?: string;
    duration?: number;
  }>;
}

function headers(token: string, clientId: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId } };
}

export const twitch: SocialProvider = {
  id: "twitch",
  name: "Twitch",
  capability: "Recent clips from the channels you follow (Helix API).",
  color: "#9146ff",
  envVars: { clientId: "TWITCH_CLIENT_ID", clientSecret: "TWITCH_CLIENT_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://id.twitch.tv/oauth2/authorize");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "user:read:follows");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const tok = await postForm<TokenResponse>("twitch", "https://id.twitch.tv/oauth2/token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
    });
    if (tok.status && tok.status >= 400) throw new Error(`Twitch: ${tok.message ?? tok.status}`);
    const me = await getJson<Users>("twitch", `${HELIX}/users`, headers(tok.access_token, creds.clientId));
    const u = me.data?.[0];
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope?.join(" ") ?? null,
      providerUserId: u?.id ?? "me",
      displayName: u?.display_name ?? u?.login ?? "Twitch user",
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>("twitch", "https://id.twitch.tv/oauth2/token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (!tok.access_token) return null;
    return { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? refreshToken, expiresAt: expiresAtFrom(tok.expires_in), scope: tok.scope?.join(" ") ?? null, providerUserId: "", displayName: "" };
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const clientId = process.env.TWITCH_CLIENT_ID ?? "";
    const followed = await getJson<Followed>(
      "twitch",
      `${HELIX}/channels/followed?user_id=${providerUserId}&first=${MAX_CHANNELS}`,
      headers(accessToken, clientId),
    );
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const out: MediaItem[] = [];
    await Promise.all(
      (followed.data ?? []).map(async (ch) => {
        try {
          const clips = await getJson<Clips>(
            "twitch",
            `${HELIX}/clips?broadcaster_id=${ch.broadcaster_id}&started_at=${since}&first=5`,
            headers(accessToken, clientId),
          );
          for (const c of clips.data ?? []) {
            out.push({
              key: `twitch:${c.id}`,
              provider: "twitch",
              externalId: c.id,
              title: c.title,
              creator: c.broadcaster_name,
              creatorHandle: ch.broadcaster_login,
              permalink: c.url,
              thumbnailUrl: c.thumbnail_url ?? null,
              videoUrl: null,
              durationSeconds: c.duration != null ? Math.round(c.duration) : null,
              publishedAt: c.created_at ? Date.parse(c.created_at) : 0,
              metrics: { views: c.view_count },
            });
          }
        } catch {
          /* one channel failing should not sink the rest */
        }
      }),
    );
    return out;
  },
};
