export type ProviderId =
  | "tiktok"
  | "instagram"
  | "youtube"
  | "twitter"
  | "facebook"
  | "threads"
  | "reddit"
  | "pinterest"
  | "twitch"
  | "snapchat"
  | "bluesky";

/** Display order everywhere in the product. */
export const PROVIDER_IDS: ProviderId[] = [
  "tiktok",
  "instagram",
  "youtube",
  "twitter",
  "facebook",
  "threads",
  "reddit",
  "pinterest",
  "twitch",
  "snapchat",
  "bluesky",
];

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

/** Field shown on the connect form for platforms that authenticate with user credentials. */
export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required?: boolean;
  help?: string;
}

/**
 * Platforms without a client-registration OAuth flow (Bluesky's AT Protocol uses per-user app
 * passwords) connect through a small form instead of a redirect.
 */
export interface CredentialConnect {
  fields: CredentialField[];
  help: string;
  authenticate(input: Record<string, string>): Promise<OAuthTokens>;
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
  /**
   * True when the platform offers no third-party API for its short-form content, so only
   * the demo catalogue is available. The UI says so instead of offering a live connection.
   */
  demoOnly?: boolean;
  /** Present when the platform connects with user-supplied credentials rather than OAuth. */
  credentialConnect?: CredentialConnect;
  buildAuthorizeUrl(creds: ProviderCredentials, params: AuthorizeParams): string;
  exchangeCode(
    creds: ProviderCredentials,
    code: string,
    codeVerifier: string | null,
  ): Promise<OAuthTokens>;
  refresh?(creds: ProviderCredentials, refreshToken: string, scope?: string | null): Promise<OAuthTokens | null>;
  /** Fetch recent short-form items for the connected account. `scope` is whatever was stored at connect time. */
  fetchItems(accessToken: string, providerUserId: string, scope?: string | null): Promise<MediaItem[]>;
}

export const SHORT_FORM_MAX_SECONDS = 90;

export function isShortForm(item: MediaItem): boolean {
  if (item.durationSeconds == null) return true; // platform marks it short-form (e.g. Reels/TikTok)
  return item.durationSeconds <= SHORT_FORM_MAX_SECONDS;
}
