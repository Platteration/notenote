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

/**
 * Bounds on an item built out of a platform's reply.
 *
 * Nothing in the pipeline used to limit these. A hostile host — the Bluesky PDS is chosen by
 * the user — could put a title as long as the reply itself into `MediaItem`, and those items
 * are persisted twice: the whole fetch into `provider_cache` for six hours, and the curated
 * subset into `daily_feeds` for a day. Both are parsed back into memory on later requests
 * (marking a clip seen reads the three most recent feeds, saving one reads seven, the account
 * export reads all of them), so an unbounded item is paid for over and over.
 *
 * These are generous next to anything a real platform sends: titles run to a line or two, and
 * a signed CDN thumbnail URL is a few hundred characters.
 */
export const MAX_ITEM_TEXT = 200;
export const MAX_ITEM_URL = 2000;
export const MAX_ITEM_KEY = 200;
/** A platform that answers with more items than this has stopped being a timeline. */
export const MAX_ITEMS_PER_PROVIDER = 200;

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function boundedUrl(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ITEM_URL ? value : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalise what a platform sent into something the app is willing to store.
 *
 * Applied in one place — `collectItems` — so it covers every provider rather than whichever
 * one was last audited. An item with no usable key or permalink is dropped: there is nothing
 * to identify it by and nothing to open.
 */
export function sanitiseItems(items: MediaItem[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const key = boundedText(item.key, MAX_ITEM_KEY);
    const permalink = boundedUrl(item.permalink);
    if (!key || !permalink) continue;
    out.push({
      key,
      provider: item.provider,
      externalId: boundedText(item.externalId, MAX_ITEM_KEY),
      title: boundedText(item.title, MAX_ITEM_TEXT),
      creator: boundedText(item.creator, MAX_ITEM_TEXT),
      creatorHandle: boundedText(item.creatorHandle, MAX_ITEM_TEXT),
      permalink,
      thumbnailUrl: boundedUrl(item.thumbnailUrl),
      videoUrl: boundedUrl(item.videoUrl),
      durationSeconds: finiteNumber(item.durationSeconds) ?? null,
      publishedAt: finiteNumber(item.publishedAt) ?? 0,
      metrics: {
        views: finiteNumber(item.metrics?.views),
        likes: finiteNumber(item.metrics?.likes),
        comments: finiteNumber(item.metrics?.comments),
        shares: finiteNumber(item.metrics?.shares),
      },
    });
    if (out.length === MAX_ITEMS_PER_PROVIDER) break;
  }
  return out;
}

export const SHORT_FORM_MAX_SECONDS = 90;

export function isShortForm(item: MediaItem): boolean {
  if (item.durationSeconds == null) return true; // platform marks it short-form (e.g. Reels/TikTok)
  return item.durationSeconds <= SHORT_FORM_MAX_SECONDS;
}
