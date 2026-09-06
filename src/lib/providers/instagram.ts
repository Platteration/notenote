/**
 * Instagram — "Instagram API with Instagram Login".
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 *
 * Third parties can read the connected account's *own* media (including Reels), not the
 * home feed. Reels are returned as media_type VIDEO; we treat them as short-form.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

interface ShortTokenResponse {
  access_token: string;
  user_id: string | number;
  error_message?: string;
}
interface LongTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}
interface MeResponse {
  id: string;
  username?: string;
}
interface MediaResponse {
  data?: Array<{
    id: string;
    caption?: string;
    media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
    media_product_type?: "FEED" | "REELS" | "STORY";
    media_url?: string;
    permalink?: string;
    thumbnail_url?: string;
    timestamp?: string;
    like_count?: number;
    comments_count?: number;
    username?: string;
  }>;
}

export const instagram: SocialProvider = {
  id: "instagram",
  name: "Instagram",
  capability: "Reels from your own account (Instagram API with Instagram Login).",
  color: "#e1306c",
  envVars: { clientId: "INSTAGRAM_APP_ID", clientSecret: "INSTAGRAM_APP_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://www.instagram.com/oauth/authorize");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "instagram_business_basic");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const short = await postForm<ShortTokenResponse>("instagram", "https://api.instagram.com/oauth/access_token", {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
      code,
    });
    if (short.error_message) throw new Error(`Instagram: ${short.error_message}`);
    // Exchange for a 60-day long-lived token.
    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", creds.clientSecret);
    longUrl.searchParams.set("access_token", short.access_token);
    const long = await getJson<LongTokenResponse>("instagram", longUrl.toString());
    const me = await getJson<MeResponse>(
      "instagram",
      `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(long.access_token)}`,
    );
    return {
      accessToken: long.access_token,
      refreshToken: null, // long-lived tokens are refreshed via ig_refresh_token, using the token itself
      expiresAt: expiresAtFrom(long.expires_in),
      scope: "instagram_business_basic",
      providerUserId: String(me.id ?? short.user_id),
      displayName: me.username ? `@${me.username}` : "Instagram user",
    };
  },

  async refresh(_creds, accessToken): Promise<OAuthTokens | null> {
    const u = new URL("https://graph.instagram.com/refresh_access_token");
    u.searchParams.set("grant_type", "ig_refresh_token");
    u.searchParams.set("access_token", accessToken);
    const r = await getJson<LongTokenResponse>("instagram", u.toString());
    return {
      accessToken: r.access_token,
      refreshToken: null,
      expiresAt: expiresAtFrom(r.expires_in),
      scope: "instagram_business_basic",
      providerUserId: "",
      displayName: "",
    };
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const fields =
      "id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,username";
    const res = await getJson<MediaResponse>(
      "instagram",
      `https://graph.instagram.com/v21.0/me/media?fields=${fields}&limit=40&access_token=${encodeURIComponent(accessToken)}`,
    );
    return (res.data ?? [])
      .filter((m) => m.media_type === "VIDEO")
      .map((m) => ({
        key: `instagram:${m.id}`,
        provider: "instagram" as const,
        externalId: m.id,
        title: (m.caption ?? "").split("\n")[0] || "Reel",
        creator: m.username ? `@${m.username}` : "You",
        creatorHandle: m.username ?? providerUserId,
        permalink: m.permalink ?? "https://www.instagram.com/",
        thumbnailUrl: m.thumbnail_url ?? null,
        videoUrl: m.media_url ?? null,
        durationSeconds: m.media_product_type === "REELS" ? null : 60,
        publishedAt: m.timestamp ? Date.parse(m.timestamp) : 0,
        metrics: { likes: m.like_count, comments: m.comments_count },
      }));
  },
};
