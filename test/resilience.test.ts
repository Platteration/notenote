import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-resilience-tests";
// Short deadlines so the tests exercise the real timers without being slow.
process.env.PROVIDER_TIMEOUT_MS = "60";
process.env.PROVIDER_BUDGET_MS = "150";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { encrypt } = await import("@/lib/crypto");
const { collectItems } = await import("@/lib/connections");
const { getJson, ProviderTimeoutError, requestTimeoutMs } = await import("@/lib/providers/http");
const { PROVIDERS } = await import("@/lib/providers");
const { purgeExpired, purgeExpiredIfDue, resetPurgeSchedule } = await import("@/lib/feed");

const realFetch = globalThis.fetch;
let userId: string;

beforeAll(async () => {
  userId = (await signUp({ email: "resilience@example.com", displayName: "R", password: "password123" })).id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("per-request timeouts", () => {
  it("reads its deadline from the environment", () => {
    expect(requestTimeoutMs()).toBe(60);
  });

  it("gives up on a platform that never answers", async () => {
    // Never resolves on its own; only the abort signal ends it.
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    }) as unknown as typeof fetch;

    const started = Date.now();
    await expect(getJson("TestPlatform", "https://example.test/slow")).rejects.toThrow(ProviderTimeoutError);
    await expect(getJson("TestPlatform", "https://example.test/slow")).rejects.toThrow(/did not respond within 60ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out against a real socket that accepts and never answers", async () => {
    // The mocked cases above assume how an aborted fetch surfaces; this proves it against
    // the real runtime, where the abort arrives as a DOMException named TimeoutError.
    const http = await import("node:http");
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const started = Date.now();
      await expect(getJson("TestPlatform", `http://127.0.0.1:${port}/hang`)).rejects.toThrow(ProviderTimeoutError);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      server.close();
    }
  });

  it("passes a network failure through unchanged rather than calling it a timeout", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
    await expect(getJson("TestPlatform", "https://example.test/x")).rejects.toThrow(/network down/);
  });

  it("leaves a caller's own signal in place", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const mine = new AbortController().signal;
    await getJson("TestPlatform", "https://example.test/x", { signal: mine });
    expect(seen[0]).toBe(mine);
  });
});

describe("per-platform budget", () => {
  function connect(provider: string) {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO connections
         (user_id, provider, provider_user_id, display_name, access_token, refresh_token, expires_at, scope, demo, connected_at)
         VALUES (?, ?, 'me', 'Test', ?, NULL, NULL, NULL, 0, 0)`,
      )
      .run(userId, provider, encrypt("token"));
  }

  beforeEach(() => {
    getDb().prepare("DELETE FROM connections WHERE user_id = ?").run(userId);
    getDb().prepare("DELETE FROM provider_cache WHERE user_id = ?").run(userId);
    // A failing platform is logged in full; the assertions below are about what the *client*
    // is told, so keep the expected noise out of the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("skips a platform that runs past its budget instead of hanging the feed", async () => {
    connect("youtube");
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const results = await collectItems(userId);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(results).toHaveLength(1);
    expect(results[0].items).toEqual([]);
    // A short classified reason, not the internal message: this string is frozen into the
    // feed row, returned by /api/feed and re-served by the account export.
    expect(results[0].error).toBe("timed out");
    expect(results[0].error).not.toMatch(/150|skipped/);
  });

  it("serves the last good items when a platform stalls", async () => {
    connect("youtube");
    const stale = [{ key: "youtube:cached", provider: "youtube", externalId: "cached" }];
    getDb()
      .prepare("INSERT OR REPLACE INTO provider_cache (user_id, provider, items_json, fetched_at) VALUES (?, ?, ?, ?)")
      .run(userId, "youtube", JSON.stringify(stale), 0); // fetched long ago, so the cache is cold
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockImplementation(() => new Promise(() => {}));

    const results = await collectItems(userId);
    expect(results[0].items).toEqual(stale);
    expect(results[0].fromCache).toBe(true);
    expect(results[0].error).toBe("timed out");
  });

  it("one slow platform does not stop the others returning", async () => {
    connect("youtube");
    connect("reddit");
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(PROVIDERS.reddit, "fetchItems").mockResolvedValue([
      { key: "reddit:ok", provider: "reddit", externalId: "ok", title: "t", creator: "c", creatorHandle: "c", permalink: "https://x", thumbnailUrl: null, videoUrl: null, durationSeconds: 20, publishedAt: 0, metrics: {} },
    ]);

    const results = await collectItems(userId);
    const byProvider = Object.fromEntries(results.map((r) => [r.provider, r]));
    expect(byProvider.reddit.items).toHaveLength(1);
    expect(byProvider.reddit.error).toBeNull();
    expect(byProvider.youtube.error).toBe("timed out");
  });
});

describe("housekeeping", () => {
  beforeEach(() => resetPurgeSchedule());

  it("removes expired sessions, stale handshakes and old feeds", () => {
    const db = getDb();
    const at = 10_000_000;
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('live', ?, 0, ?)").run(userId, at + 1000);
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('dead', ?, 0, ?)").run(userId, at - 1000);
    db.prepare("INSERT INTO oauth_states (state, user_id, provider, code_verifier, created_at) VALUES ('fresh', ?, 'youtube', NULL, ?)").run(userId, at - 60_000);
    db.prepare("INSERT INTO oauth_states (state, user_id, provider, code_verifier, created_at) VALUES ('abandoned', ?, 'youtube', NULL, ?)").run(userId, at - 60 * 60_000);
    db.prepare("INSERT INTO daily_feeds (user_id, day_key, items_json, generated_at, opens_at, closes_at) VALUES (?, 'old', '{\"items\":[]}', 0, 0, ?)").run(userId, at - 3 * 86_400_000);

    const counts = purgeExpired(at);
    expect(counts).toEqual({ feeds: 1, sessions: 1, oauthStates: 1 });
    expect(db.prepare("SELECT token FROM sessions WHERE user_id = ?").all(userId)).toEqual([{ token: "live" }]);
    expect(db.prepare("SELECT state FROM oauth_states WHERE user_id = ?").all(userId)).toEqual([{ state: "fresh" }]);
  });

  it("sweeps at most once an hour when driven by ordinary requests", () => {
    const at = 20_000_000;
    expect(purgeExpiredIfDue(at)).not.toBeNull();
    expect(purgeExpiredIfDue(at + 60_000)).toBeNull();
    expect(purgeExpiredIfDue(at + 61 * 60_000)).not.toBeNull();
  });
});
