import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-feed-tests";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { encrypt } = await import("@/lib/crypto");
const { collectItems } = await import("@/lib/connections");
const { feedGenerationsInFlight, getFeed } = await import("@/lib/feed");
const { PROVIDERS } = await import("@/lib/providers");
const { MAX_ITEMS_PER_PROVIDER, MAX_ITEM_KEY, MAX_ITEM_TEXT, MAX_ITEM_URL, sanitiseItems } = await import(
  "@/lib/providers/types"
);
import type { MediaItem } from "@/lib/providers/types";

let userId: string;
/** Inside the default window, which opens at 20:00 in UTC. */
const IN_THE_HOUR = Date.UTC(2026, 8, 6, 20, 30);

function connect(provider: string) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO connections
       (user_id, provider, provider_user_id, display_name, access_token, refresh_token, expires_at, scope, demo, connected_at)
       VALUES (?, ?, 'me', 'Test', ?, NULL, NULL, NULL, 0, 0)`,
    )
    .run(userId, provider, encrypt("token"));
}

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    key: "youtube:one",
    provider: "youtube",
    externalId: "one",
    title: "A clip",
    creator: "Ada",
    creatorHandle: "ada",
    permalink: "https://www.youtube.com/shorts/one",
    thumbnailUrl: "https://cdn.example/one.jpg",
    videoUrl: null,
    durationSeconds: 20,
    publishedAt: IN_THE_HOUR - 3_600_000,
    metrics: { views: 10 },
    ...overrides,
  };
}

beforeAll(async () => {
  userId = (await signUp({ email: "feed@example.com", displayName: "Feed", password: "password123" })).id;
});

beforeEach(() => {
  const db = getDb();
  for (const table of ["connections", "provider_cache", "daily_feeds", "hour_opens", "seen_items"]) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generating the day's feed once", () => {
  it("fans out to the platforms once, however many requests arrive together", async () => {
    connect("youtube");
    let fetches = 0;
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockImplementation(async () => {
      fetches++;
      // Long enough that the other callers are certainly inside the same generation.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [item()];
    });

    const answers = await Promise.all([
      getFeed(userId, IN_THE_HOUR),
      getFeed(userId, IN_THE_HOUR),
      getFeed(userId, IN_THE_HOUR),
    ]);

    // The row is only written once every platform has answered, so before the single-flight
    // guard each of these ran the whole fan-out on the operator's credentials.
    expect(fetches).toBe(1);
    for (const answer of answers) {
      expect(answer.status).toBe("open");
      expect(answer.status === "open" && answer.items.map((i) => i.key)).toEqual(["youtube:one"]);
    }
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM daily_feeds WHERE user_id = ?").get(userId)).toEqual({ c: 1 });
    // Nothing is left behind to leak between days.
    expect(feedGenerationsInFlight()).toBe(0);
  });

  it("clears the in-flight entry even when a platform fails", async () => {
    connect("youtube");
    const failing = vi.spyOn(PROVIDERS.youtube, "fetchItems").mockRejectedValue(new Error("platform is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await getFeed(userId, IN_THE_HOUR);
    expect(first.status).toBe("open");
    expect(feedGenerationsInFlight()).toBe(0);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("serves the stored feed on later requests without touching the platforms", async () => {
    connect("youtube");
    const fetch = vi.spyOn(PROVIDERS.youtube, "fetchItems").mockResolvedValue([item()]);

    await getFeed(userId, IN_THE_HOUR);
    await getFeed(userId, IN_THE_HOUR + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("what a platform is allowed to put in a feed", () => {
  it("truncates text, drops unusable URLs and caps how many items arrive", async () => {
    connect("youtube");
    const huge = "A".repeat(50_000);
    vi.spyOn(PROVIDERS.youtube, "fetchItems").mockResolvedValue([
      item({
        key: `youtube:${huge}`,
        externalId: huge,
        title: huge,
        creator: huge,
        creatorHandle: huge,
        thumbnailUrl: `https://cdn.example/${huge}.jpg`,
      }),
      ...Array.from({ length: MAX_ITEMS_PER_PROVIDER + 50 }, (_, i) => item({ key: `youtube:${i}`, externalId: String(i) })),
    ]);

    const [result] = await collectItems(userId, IN_THE_HOUR);
    expect(result.items).toHaveLength(MAX_ITEMS_PER_PROVIDER);
    const first = result.items[0];
    expect(first.key).toHaveLength(MAX_ITEM_KEY);
    expect(first.title).toHaveLength(MAX_ITEM_TEXT);
    expect(first.creator).toHaveLength(MAX_ITEM_TEXT);
    expect(first.creatorHandle).toHaveLength(MAX_ITEM_TEXT);
    expect(first.thumbnailUrl).toBeNull();

    // The cache row is read back into memory on later requests, so its size is the point.
    const row = getDb()
      .prepare("SELECT items_json FROM provider_cache WHERE user_id = ? AND provider = 'youtube'")
      .get(userId) as { items_json: string };
    // A bound built from the limits above rather than from what the code happened to produce.
    const perItem = 3 * MAX_ITEM_TEXT + 2 * MAX_ITEM_KEY + 3 * MAX_ITEM_URL + 200;
    expect(row.items_json.length).toBeLessThan(MAX_ITEMS_PER_PROVIDER * perItem);
    expect(row.items_json).not.toContain(huge);
  });

  it("drops an item with nothing to identify it by or open", () => {
    const kept = sanitiseItems([
      item(),
      item({ key: "", externalId: "" }),
      item({ key: "youtube:no-link", permalink: "" as unknown as string }),
      item({ key: "youtube:endless-link", permalink: `https://x.example/${"b".repeat(MAX_ITEM_URL)}` }),
    ]);
    expect(kept.map((i) => i.key)).toEqual(["youtube:one"]);
  });

  it("keeps the numbers numbers", () => {
    const [only] = sanitiseItems([
      item({
        durationSeconds: Number.NaN,
        publishedAt: "yesterday" as unknown as number,
        metrics: { views: Number.POSITIVE_INFINITY, likes: 3 },
      }),
    ]);
    expect(only.durationSeconds).toBeNull();
    expect(only.publishedAt).toBe(0);
    expect(only.metrics.views).toBeUndefined();
    expect(only.metrics.likes).toBe(3);
  });
});
