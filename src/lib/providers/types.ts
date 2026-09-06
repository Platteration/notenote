export type ProviderId = "tiktok" | "instagram" | "youtube" | "twitter";

export const PROVIDER_IDS: ProviderId[] = ["tiktok", "instagram", "youtube", "twitter"];

/** A normalised short-form media item, regardless of which platform it came from. */
export interface MediaItem {
  /** Globally unique, stable key: `${provider}:${externalId}`. */
  key: string;
  provider: ProviderId;
  externalId: string;
  title: string;
  creator: string;
  creatorHandle: string;
  /** Link back to the item on the source platform. */
  permalink: string;
  /** Poster/thumbnail image URL (may be a data: URI in demo mode). */
  thumbnailUrl: string | null;
  /** Direct video URL when the platform exposes one (rarely for third parties). */
  videoUrl: string | null;
  durationSeconds: number | null;
  publishedAt: number; // ms epoch
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
  };
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // ms epoch
  scope: string | null;
  providerUserId: string;
  displayName: string;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthorizeParams {
  state: string;
  codeChallenge: string;
}

export interface SocialProvider {
  id: ProviderId;
  name: string;
  /** Short explanation of what the platform lets us read. */
  capability: string;
  /** Brand colour used by the UI. */
  color: string;
  /** Env var names required for real OAuth; when missing we run in demo mode. */
  envVars: { clientId: string; clientSecret: string };
  usesPkce: boolean;
  buildAuthorizeUrl(creds: ProviderCredentials, params: AuthorizeParams): string;
  exchangeCode(
    creds: ProviderCredentials,
    code: string,
    codeVerifier: string | null,
  ): Promise<OAuthTokens>;
  refresh?(creds: ProviderCredentials, refreshToken: string): Promise<OAuthTokens | null>;
  /** Fetch recent short-form items for the connected account. */
  fetchItems(accessToken: string, providerUserId: string): Promise<MediaItem[]>;
}

export const SHORT_FORM_MAX_SECONDS = 90;

export function isShortForm(item: MediaItem): boolean {
  if (item.durationSeconds == null) return true; // platform marks it short-form (e.g. Reels/TikTok)
  return item.durationSeconds <= SHORT_FORM_MAX_SECONDS;
}
