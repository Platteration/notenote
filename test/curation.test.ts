import { describe, expect, it } from "vitest";
import { curate, seededRandom } from "@/lib/curation";
import { demoItems } from "@/lib/providers/demo";
import type { MediaItem, ProviderId } from "@/lib/providers/types";

const NOW = Date.UTC(2026, 8, 6, 12, 0);

function item(overrides: Partial<MediaItem> & { provider: ProviderId; externalId: string }): MediaItem {
  return {
    key: `${overrides.provider}:${overrides.externalId}`,
    title: `Clip ${overrides.externalId}`,
    creator: "Creator",
    creatorHandle: "creator",
    permalink: "https://example.com",
    thumbnailUrl: null,
    videoUrl: null,
    durationSeconds: 30,
    publishedAt: NOW - 3_600_000,
    metrics: { views: 1000, likes: 50 },
    ...overrides,
  };
}

const base = { size: 10, seed: "user:2026-09-06", now: NOW, seenKeys: new Set<string>() };

describe("curate", () => {
  it("drops long-form, already-seen and stale items", () => {
    const items = [
      item({ provider: "youtube", externalId: "short" }),
      item({ provider: "youtube", externalId: "long", durationSeconds: 600 }),
      item({ provider: "youtube", externalId: "seen" }),
      item({ provider: "youtube", externalId: "old", publishedAt: NOW - 30 * 86_400_000 }),
    ];
    const r = curate(items, { ...base, seenKeys: new Set(["youtube:seen"]) });
    expect(r.items.map((i) => i.externalId)).toEqual(["short"]);
  });

  it("is deterministic for the same seed and different for another day", () => {
    const pool = (["tiktok", "instagram", "youtube", "twitter"] as ProviderId[]).flatMap((p) =>
      demoItems(p, "user-1", NOW, 30),
    );
    const a = curate(pool, { ...base, size: 20 });
    const b = curate(pool, { ...base, size: 20 });
    const c = curate(pool, { ...base, size: 20, seed: "user:2026-09-07" });
    expect(a.items.map((i) => i.key)).toEqual(b.items.map((i) => i.key));
    expect(a.items.map((i) => i.key)).not.toEqual(c.items.map((i) => i.key));
  });

  it("balances platforms so one cannot take more than half the feed", () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) =>
        item({ provider: "tiktok", externalId: `t${i}`, creatorHandle: `tt${i}`, metrics: { views: 10_000_000, likes: 500_000 } }),
      ),
      ...Array.from({ length: 6 }, (_, i) => item({ provider: "twitter", externalId: `x${i}`, creatorHandle: `x${i}`, metrics: { views: 10, likes: 1 } })),
    ];
    const r = curate(items, { ...base, size: 10 });
    expect(r.items).toHaveLength(10);
    expect(r.stats.perProvider.tiktok).toBe(5);
    expect(r.stats.perProvider.twitter).toBe(5);
  });

  it("fills the feed from a single platform when only one is connected", () => {
    const items = Array.from({ length: 30 }, (_, i) => item({ provider: "youtube", externalId: `y${i}`, creatorHandle: `c${i}` }));
    expect(curate(items, { ...base, size: 10 }).items).toHaveLength(10);
  });

  it("merges cross-posts from the same creator with the same caption", () => {
    const items = [
      item({ provider: "tiktok", externalId: "a", title: "My new song is out! #music", creatorHandle: "band" }),
      item({ provider: "instagram", externalId: "b", title: "My NEW song is out!!", creatorHandle: "band" }),
      item({ provider: "youtube", externalId: "c", title: "Something else", creatorHandle: "band" }),
    ];
    const r = curate(items, { ...base, size: 10 });
    expect(r.items).toHaveLength(2);
  });

  it("prefers spreading creators before repeating one", () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item({ provider: "youtube", externalId: `big${i}`, creatorHandle: "megastar", metrics: { views: 1e7, likes: 1e6 } }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        item({ provider: "youtube", externalId: `small${i}`, creatorHandle: `indie${i}`, metrics: { views: 100, likes: 5 } }),
      ),
    ];
    const r = curate(items, { ...base, size: 10 });
    const first10ByMegastar = r.items.filter((i) => i.creatorHandle === "megastar").length;
    expect(first10ByMegastar).toBe(2);
  });

  it("scores recency so a fresher clip outranks an older one with equal engagement", () => {
    const items = [
      item({ provider: "youtube", externalId: "old", creatorHandle: "a", publishedAt: NOW - 5 * 86_400_000 }),
      item({ provider: "youtube", externalId: "new", creatorHandle: "b", publishedAt: NOW - 3_600_000 }),
    ];
    expect(curate(items, { ...base, size: 2 }).items[0]?.externalId).toBe("new");
  });

  // Engagement is 60% of the score. One platform, so it is normalised against the same maximum;
  // different creators, so the creator spread does not reorder them.
  const quiet = { views: 1000, likes: 50 };
  const loved = { views: 1_000_000, likes: 100_000 };

  it("scores engagement so the more engaged of two equally fresh clips comes first", () => {
    const items = [
      item({ provider: "youtube", externalId: "quiet", creatorHandle: "a", metrics: quiet }),
      item({ provider: "youtube", externalId: "loved", creatorHandle: "b", metrics: loved }),
    ];
    // Ten days' seeds: with the engagement term ignored the two tie, and one seed's jitter could
    // still happen to put the right one first.
    for (let day = 1; day <= 10; day++) {
      const seed = `user:2026-09-${String(day).padStart(2, "0")}`;
      expect(curate(items, { ...base, size: 2, seed }).items.map((i) => i.externalId)).toEqual(["loved", "quiet"]);
    }
  });

  it("lets far higher engagement outweigh a clip a day newer", () => {
    const items = [
      item({ provider: "youtube", externalId: "fresh", creatorHandle: "a", publishedAt: NOW - 3_600_000, metrics: quiet }),
      item({ provider: "youtube", externalId: "loved", creatorHandle: "b", publishedAt: NOW - 25 * 3_600_000, metrics: loved }),
    ];
    expect(curate(items, { ...base, size: 2 }).items.map((i) => i.externalId)).toEqual(["loved", "fresh"]);
  });
});

describe("seededRandom", () => {
  it("is reproducible", () => {
    const a = seededRandom("x");
    const b = seededRandom("x");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
