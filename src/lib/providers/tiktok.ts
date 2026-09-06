/**
 * TikTok — Login Kit + Display API.
 * Docs: https://developers.tiktok.com/doc/login-kit-web
 *       https://developers.tiktok.com/doc/display-api-get-user-videos
 *
 * The Display API exposes the connected user's *own* published videos. TikTok does not
 * offer a third-party "For You" feed, so the Daily Scroll shows your recent uploads here.
 */
import { expiresAtFrom, getJson, postForm } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  open_id: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UserInfoResponse {
  data?: { user?: { display_name?: string; open_id?: string } };
}

interface VideoListResponse {
  data?: {
    videos?: Array<{
      id: string;
      title?: string;
      video_description?: string;
      cover_image_url?: string;
      share_url?: string;
      duration?: number;
      create_time?: number;
      like_count?: number;
      comment_count?: number;
      share_count?: number;
      view_count?: number;
    }>;
    cursor?: number;
    has_more?: boolean;
  };
}

export const tiktok: SocialProvider = {
  id: "tiktok",
  name: "TikTok",
  capability: "Your recent published TikToks (Display API).",
  color: "#ff2d55",
  envVars: { clientId: "TIKTOK_CLIENT_KEY", clientSecret: "TIKTOK_CLIENT_SECRET" },
  usesPkce: false,

  buildAuthorizeUrl(creds, { state }) {
    const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
    u.searchParams.set("client_key", creds.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "user.info.basic,video.list");
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(creds, code) {
    const tok = await postForm<TokenResponse>("tiktok", "https://open.tiktokapis.com/v2/oauth/token/", {
      client_key: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
    });
    if (tok.error) throw new Error(`TikTok: ${tok.error_description ?? tok.error}`);
    const me = await getJson<UserInfoResponse>(
      "tiktok",
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
      { headers: { Authorization: `Bearer ${tok.access_token}` } },
    );
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
      providerUserId: tok.open_id,
      displayName: me.data?.user?.display_name ?? "TikTok user",
    };
  },

  async refresh(creds, refreshToken): Promise<OAuthTokens | null> {
    const tok = await postForm<TokenResponse>("tiktok", "https://open.tiktokapis.com/v2/oauth/token/", {
      client_key: creds.clientId,
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
      providerUserId: tok.open_id,
      displayName: "",
    };
  },

  async fetchItems(accessToken, providerUserId): Promise<MediaItem[]> {
    const fields =
      "id,title,video_description,cover_image_url,share_url,duration,create_time,like_count,comment_count,share_count,view_count";
    const res = await getJson<VideoListResponse>(
      "tiktok",
      `https://open.tiktokapis.com/v2/video/list/?fields=${fields}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ max_count: 20 }),
      },
    );
    return (res.data?.videos ?? []).map((v) => ({
      key: `tiktok:${v.id}`,
      provider: "tiktok",
      externalId: v.id,
      title: v.title || v.video_description || "Untitled TikTok",
      creator: "You",
      creatorHandle: providerUserId,
      permalink: v.share_url ?? `https://www.tiktok.com/`,
      thumbnailUrl: v.cover_image_url ?? null,
      videoUrl: null,
      durationSeconds: v.duration ?? null,
      publishedAt: (v.create_time ?? 0) * 1000,
      metrics: {
        views: v.view_count,
        likes: v.like_count,
        comments: v.comment_count,
        shares: v.share_count,
      },
    }));
  },
};
