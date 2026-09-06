/**
 * Facebook — Facebook Login + Graph API.
 * Docs: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *       https://developers.facebook.com/docs/graph-api/reference/user/videos/
 *
 * Third parties can read the connected user's own uploaded videos (`user_videos`, which
 * requires App Review). Reels are the ones short enough to pass the short-form filter.
 */
import { expiresAtFrom, getJson } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const GRAPH = "https://graph.facebook.com/v21.0";

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  error?: { message?: string };
}
interface Me {
  id: string;
  name?: string;
}
interface Videos {
  data?: Array<{
    id: string;
    description?: string;
    title?: string;
    permalink_url?: string;
    picture?: string;
    source?: string;
    length?: number;
    created_time?: string;
  }>;
}

export const facebook: SocialProvider = {
  id: "facebook",
  name: "Facebook",
  capability: "Reels and short videos from your own profile (Graph API).",
  color: "#0866ff",
  envVars: { clientId: "FACEBOOK_APP_ID", clientSecret: "FACEBOOK_APP_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "public_profile,user_videos");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const t = new URL(`${GRAPH}/oauth/access_token`);
    t.searchParams.set("client_id", creds.clientId);
    t.searchParams.set("client_secret", creds.clientSecret);
    t.searchParams.set("redirect_uri", creds.redirectUri);
    t.searchParams.set("code", code);
    const short = await getJson<TokenResponse>("facebook", t.toString());
    if (short.error) throw new Error(`Facebook: ${short.error.message}`);
    // Upgrade to a ~60 day long-lived token.
    const l = new URL(`${GRAPH}/oauth/access_token`);
    l.searchParams.set("grant_type", "fb_exchange_token");
    l.searchParams.set("client_id", creds.clientId);
    l.searchParams.set("client_secret", creds.clientSecret);
    l.searchParams.set("fb_exchange_token", short.access_token);
    const long = await getJson<TokenResponse>("facebook", l.toString());
    const token = long.access_token ?? short.access_token;
    const me = await getJson<Me>("facebook", `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    return {
      accessToken: token,
      refreshToken: null,
      expiresAt: expiresAtFrom(long.expires_in ?? short.expires_in),
      scope: "public_profile,user_videos",
      providerUserId: me.id,
      displayName: me.name ?? "Facebook user",
    };
  },

  async refresh(): Promise<OAuthTokens | null> {
    return null; // long-lived user tokens are re-issued by sending the user through login again
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const fields = "id,description,title,permalink_url,picture,source,length,created_time";
    const res = await getJson<Videos>(
      "facebook",
      `${GRAPH}/me/videos?fields=${fields}&limit=40&access_token=${encodeURIComponent(accessToken)}`,
    );
    return (res.data ?? []).map((v) => ({
      key: `facebook:${v.id}`,
      provider: "facebook" as const,
      externalId: v.id,
      title: v.title || (v.description ?? "").split("\n")[0] || "Video",
      creator: "You",
      creatorHandle: providerUserId,
      permalink: v.permalink_url
        ? v.permalink_url.startsWith("http")
          ? v.permalink_url
          : `https://www.facebook.com${v.permalink_url}`
        : `https://www.facebook.com/watch/?v=${v.id}`,
      thumbnailUrl: v.picture ?? null,
      videoUrl: v.source ?? null,
      durationSeconds: v.length != null ? Math.round(v.length) : null,
      publishedAt: v.created_time ? Date.parse(v.created_time) : 0,
      metrics: {},
    }));
  },
};
