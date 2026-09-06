import { decrypt, encrypt } from "./crypto";
import { getDb, now, type ConnectionRow } from "./db";
import { credentialsFor, getProvider, PROVIDERS } from "./providers";
import { demoItems } from "./providers/demo";
import type { MediaItem, OAuthTokens, ProviderId } from "./providers/types";

/** How long fetched provider items are reused before hitting the platform again. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface ConnectionSummary {
  provider: ProviderId;
  name: string;
  color: string;
  capability: string;
  connected: boolean;
  demo: boolean;
  /** Whether real OAuth credentials are configured server-side for this platform. */
  credentialsConfigured: boolean;
  displayName: string | null;
  connectedAt: number | null;
}

export function listConnections(userId: string): ConnectionSummary[] {
  const rows = getDb().prepare("SELECT * FROM connections WHERE user_id = ?").all(userId) as unknown as ConnectionRow[];
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    const row = byProvider.get(id);
    return {
      provider: id,
      name: p.name,
      color: p.color,
      capability: p.capability,
      connected: Boolean(row),
      demo: row ? row.demo === 1 : false,
      credentialsConfigured: credentialsFor(p) !== null,
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
  const creds = credentialsFor(provider);
  if (!creds) return token;
  // Instagram refreshes using the access token itself; others use a refresh token.
  const secret = row.refresh_token ? decrypt(row.refresh_token) : token;
  const refreshed = await provider.refresh(creds, secret);
  if (!refreshed) return token;
  getDb()
    .prepare("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ? AND provider = ?")
    .run(
      encrypt(refreshed.accessToken),
      refreshed.refreshToken ? encrypt(refreshed.refreshToken) : row.refresh_token,
      refreshed.expiresAt,
      row.user_id,
      row.provider,
    );
  return refreshed.accessToken;
}

export interface ProviderFetchResult {
  provider: ProviderId;
  items: MediaItem[];
  error: string | null;
  fromCache: boolean;
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
        const token = await usableAccessToken(row);
        const items = await provider.fetchItems(token, row.provider_user_id);
        db.prepare(
          `INSERT INTO provider_cache (user_id, provider, items_json, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, provider) DO UPDATE SET items_json = excluded.items_json, fetched_at = excluded.fetched_at`,
        ).run(userId, providerId, JSON.stringify(items), at);
        return { provider: providerId, items, error: null, fromCache: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Serve stale data rather than nothing when the platform is unhappy.
        if (cached) {
          return { provider: providerId, items: JSON.parse(cached.items_json) as MediaItem[], error: message, fromCache: true };
        }
        return { provider: providerId, items: [], error: message, fromCache: false };
      }
    }),
  );
}
