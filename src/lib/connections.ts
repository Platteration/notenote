import { decrypt, DecryptionError, encrypt, isDecryptable } from "./crypto";
import { getDb, now, type ConnectionRow } from "./db";
import { BlockedHostError } from "./net-guard";
import { enabledProviders, getProvider, liveAvailable, PROVIDERS } from "./providers";
import { credentialsFor } from "./providers";
import { demoItems } from "./providers/demo";
import { ProviderHttpError, ProviderResponseTooLargeError, ProviderTimeoutError } from "./providers/http";
import { sanitiseItems, type MediaItem, type OAuthTokens, type ProviderId } from "./providers/types";

/** How long fetched provider items are reused before hitting the platform again. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Total time one platform gets to produce its items. Individual requests already time out,
 * but some providers make several rounds of calls (YouTube walks subscriptions, then
 * channels, then uploads, then videos), so the whole sequence needs its own ceiling.
 */
function providerBudgetMs(): number {
  const configured = Number(process.env.PROVIDER_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}

export class ProviderBudgetError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider} took longer than ${ms}ms and was skipped`);
    this.name = "ProviderBudgetError";
  }
}

/**
 * Resolve with whatever the platform returns, or reject once the budget is spent. The
 * underlying requests are left to die on their own timeouts; we simply stop waiting, so
 * one slow platform cannot hold up the other nine.
 */
async function withBudget<T>(provider: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProviderBudgetError(provider, ms)), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ConnectionSummary {
  provider: ProviderId;
  name: string;
  color: string;
  capability: string;
  connected: boolean;
  demo: boolean;
  /** Whether a live connection is possible: OAuth keys configured, or a credential form. */
  credentialsConfigured: boolean;
  /** Platform has no third-party content API; only the demo catalogue exists. */
  demoOnly: boolean;
  /**
   * The stored tokens cannot be decrypted, so this connection cannot fetch anything until it
   * is made again. It happens when SESSION_SECRET is rotated without the old value being kept
   * in PREVIOUS_SESSION_SECRETS — the connection would otherwise keep reporting itself live
   * while the feed silently came back empty.
   */
  needsReconnect: boolean;
  /** How a live connection is made. */
  connectMode: "oauth" | "credentials" | "none";
  /** Form definition for credential-based platforms. */
  credentialFields: Array<{ name: string; label: string; type: "text" | "password" | "url"; placeholder?: string; required?: boolean; help?: string }> | null;
  credentialHelp: string | null;
  displayName: string | null;
  connectedAt: number | null;
}

export function listConnections(userId: string): ConnectionSummary[] {
  const rows = getDb().prepare("SELECT * FROM connections WHERE user_id = ?").all(userId) as unknown as ConnectionRow[];
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return enabledProviders().map((p) => {
    const id = p.id;
    const row = byProvider.get(id);
    return {
      provider: id,
      name: p.name,
      color: p.color,
      capability: p.capability,
      connected: Boolean(row),
      demo: row ? row.demo === 1 : false,
      needsReconnect: row ? row.demo !== 1 && !isDecryptable(row.access_token) : false,
      credentialsConfigured: liveAvailable(p),
      demoOnly: Boolean(p.demoOnly),
      connectMode: p.demoOnly ? "none" : p.credentialConnect ? "credentials" : "oauth",
      credentialFields: p.credentialConnect?.fields ?? null,
      credentialHelp: p.credentialConnect?.help ?? null,
      displayName: row?.display_name ?? null,
      connectedAt: row?.connected_at ?? null,
    };
  });
}

export function saveConnection(userId: string, provider: ProviderId, tokens: OAuthTokens, demo: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO connections (user_id, provider, provider_user_id, display_name, access_token, refresh_token, expires_at, scope, demo, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET provider_user_id = excluded.provider_user_id,
         display_name = excluded.display_name, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope,
         demo = excluded.demo, connected_at = excluded.connected_at`,
    )
    .run(
      userId,
      provider,
      tokens.providerUserId,
      tokens.displayName,
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      tokens.expiresAt,
      tokens.scope,
      demo ? 1 : 0,
      now(),
    );
  getDb().prepare("DELETE FROM provider_cache WHERE user_id = ? AND provider = ?").run(userId, provider);
}

export function connectDemo(userId: string, provider: ProviderId): void {
  saveConnection(
    userId,
    provider,
    {
      accessToken: "demo",
      refreshToken: null,
      expiresAt: null,
      scope: null,
      providerUserId: `demo-${userId.slice(0, 8)}`,
      displayName: `Demo ${PROVIDERS[provider].name} account`,
    },
    true,
  );
}

export function disconnect(userId: string, provider: ProviderId): void {
  const db = getDb();
  db.prepare("DELETE FROM connections WHERE user_id = ? AND provider = ?").run(userId, provider);
  db.prepare("DELETE FROM provider_cache WHERE user_id = ? AND provider = ?").run(userId, provider);
}

/** Return a usable access token, refreshing it if the platform says it has expired. */
async function usableAccessToken(row: ConnectionRow): Promise<string> {
  const provider = getProvider(row.provider)!;
  const token = decrypt(row.access_token);
  const expiringSoon = row.expires_at != null && row.expires_at - now() < 5 * 60 * 1000;
  if (!expiringSoon || !provider.refresh) return token;
  // Credential-based platforms refresh with their own session token and need no app keys.
  const creds = credentialsFor(provider) ?? (provider.credentialConnect ? { clientId: "", clientSecret: "", redirectUri: "" } : null);
  if (!creds) return token;
  // Instagram refreshes using the access token itself; others use a refresh token.
  const secret = row.refresh_token ? decrypt(row.refresh_token) : token;
  const refreshed = await provider.refresh(creds, secret, row.scope);
  if (!refreshed) return token;
  getDb()
    .prepare("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ? WHERE user_id = ? AND provider = ?")
    .run(
      encrypt(refreshed.accessToken),
      refreshed.refreshToken ? encrypt(refreshed.refreshToken) : row.refresh_token,
      refreshed.expiresAt,
      refreshed.scope ?? row.scope,
      row.user_id,
      row.provider,
    );
  return refreshed.accessToken;
}

export interface ProviderFetchResult {
  provider: ProviderId;
  items: MediaItem[];
  /** A short, classified reason. See failureReason. */
  error: string | null;
  fromCache: boolean;
}

/**
 * Why a platform produced nothing, in a few words.
 *
 * The raw message used to be stored here, and it does not stay local: it is frozen into
 * `daily_feeds.items_json`, returned by /api/feed and re-served by the account export. That
 * meant a platform's HTTP error — which carries up to 200 bytes of an upstream body — and
 * decrypt's "Unsupported state or unable to authenticate data" were handed to the client and
 * kept for a day. The detail belongs in the server log; the client needs to know which
 * platform failed and roughly why.
 */
export function failureReason(err: unknown): string {
  if (err instanceof ProviderBudgetError || err instanceof ProviderTimeoutError) return "timed out";
  if (err instanceof DecryptionError) return "needs reconnecting";
  if (err instanceof BlockedHostError) return "host refused";
  if (err instanceof ProviderResponseTooLargeError) return "sent too much data";
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) return "authorisation expired";
    if (err.status === 429) return "rate limited";
    return `http ${err.status}`;
  }
  return "unavailable";
}

/** Fetch (or reuse cached) items from every connected platform for a user. */
export async function collectItems(userId: string, at: number = now()): Promise<ProviderFetchResult[]> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM connections WHERE user_id = ?").all(userId) as unknown as ConnectionRow[];
  return Promise.all(
    rows.map(async (row): Promise<ProviderFetchResult> => {
      const providerId = row.provider as ProviderId;
      if (row.demo === 1) {
        return { provider: providerId, items: demoItems(providerId, userId, at), error: null, fromCache: false };
      }
      const cached = db
        .prepare("SELECT items_json, fetched_at FROM provider_cache WHERE user_id = ? AND provider = ?")
        .get(userId, providerId) as { items_json: string; fetched_at: number } | undefined;
      if (cached && at - cached.fetched_at < CACHE_TTL_MS) {
        return { provider: providerId, items: JSON.parse(cached.items_json) as MediaItem[], error: null, fromCache: true };
      }
      try {
        const provider = getProvider(providerId)!;
        const items = await withBudget(
          provider.name,
          (async () => {
            const token = await usableAccessToken(row);
            return provider.fetchItems(token, row.provider_user_id, row.scope);
          })(),
          providerBudgetMs(),
        );
        // Whatever the platform sent is bounded here, before it is stored and before anything
        // downstream parses it back. One place, so it covers every provider.
        const bounded = sanitiseItems(items);
        db.prepare(
          `INSERT INTO provider_cache (user_id, provider, items_json, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, provider) DO UPDATE SET items_json = excluded.items_json, fetched_at = excluded.fetched_at`,
        ).run(userId, providerId, JSON.stringify(bounded), at);
        return { provider: providerId, items: bounded, error: null, fromCache: false };
      } catch (err) {
        console.error(`Fetching items from ${providerId} failed:`, err);
        const reason = failureReason(err);
        // Serve stale data rather than nothing when the platform is unhappy.
        if (cached) {
          return { provider: providerId, items: JSON.parse(cached.items_json) as MediaItem[], error: reason, fromCache: true };
        }
        return { provider: providerId, items: [], error: reason, fromCache: false };
      }
    }),
  );
}
