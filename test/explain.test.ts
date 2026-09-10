import { describe, expect, it } from "vitest";
import { curate, type CurationReason } from "@/lib/curation";
import { explainReason, reasonBars, summariseReason } from "@/lib/explain";
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

function reason(overrides: Partial<CurationReason> = {}): CurationReason {
  return {
    engagement: 0.5,
    recency: 0.9,
    ageHours: 2,
    score: 0.66,
    rankInPlatform: 3,
    divertedForDiversity: false,
    creatorAlreadyPicked: 0,
    ...overrides,
  };
}

describe("what the curation records", () => {
  it("explains every clip it picks, and nothing it didn't", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ provider: "youtube", externalId: `y${i}`, creatorHandle: `c${i}` }),
    );
    const result = curate(items, { ...base, size: 6 });

    expect(result.items).toHaveLength(6);
    expect(Object.keys(result.reasons).sort()).toEqual(result.items.map((i) => i.key).sort());
  });

  it("records the components the scorer actually used, not a reconstruction", () => {
    const result = curate([item({ provider: "youtube", externalId: "only" })], { ...base, size: 1 });
    const r = result.reasons["youtube:only"];

    expect(r.engagement).toBeGreaterThanOrEqual(0);
    expect(r.engagement).toBeLessThanOrEqual(1);
    expect(r.recency).toBeGreaterThan(0.9); // an hour old
    expect(r.ageHours).toBeCloseTo(1, 1);
    // The blend is the one the ordering used.
    expect(r.score).toBeCloseTo(0.6 * r.engagement + 0.4 * r.recency, 6);
  });

  it("marks the first pick from a platform as its strongest remaining", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ provider: "reddit", externalId: `r${i}`, creatorHandle: `c${i}` }),
    );
    const result = curate(items, { ...base, size: 5 });
    expect(result.reasons[result.items[0].key].rankInPlatform).toBe(1);
  });

  it("notes when a higher-scoring clip was passed over to vary the creator", () => {
    // One creator holds the three strongest clips; the cap of two forces a diversion.
    const dominant = Array.from({ length: 3 }, (_, i) =>
      item({ provider: "youtube", externalId: `big${i}`, creatorHandle: "megastar", metrics: { views: 1e7, likes: 1e6 } }),
    );
    const others = Array.from({ length: 3 }, (_, i) =>
      item({ provider: "youtube", externalId: `small${i}`, creatorHandle: `indie${i}`, metrics: { views: 10, likes: 1 } }),
    );
    const result = curate([...dominant, ...others], { ...base, size: 4 });

    const diverted = result.items.filter((i) => result.reasons[i.key].divertedForDiversity);
    expect(diverted.length).toBeGreaterThan(0);
    // The clip that was reached past the head is not from the creator who was capped.
    expect(diverted.every((i) => i.creatorHandle !== "megastar")).toBe(true);
  });

  it("counts how many clips from the same creator came before", () => {
    const items = Array.from({ length: 4 }, (_, i) => item({ provider: "twitch", externalId: `t${i}`, creatorHandle: "same" }));
    const result = curate(items, { ...base, size: 4 });
    const counts = result.items.map((i) => result.reasons[i.key].creatorAlreadyPicked);
    expect(counts).toEqual([0, 1, 2, 3]);
  });
});

describe("putting it into words", () => {
  it("leads with the platform's strongest when this clip topped the queue", () => {
    expect(explainReason(reason({ rankInPlatform: 1 }), "YouTube")[0]).toMatch(/strongest YouTube clip/);
  });

  it("describes strong engagement without ranking the creator", () => {
    expect(explainReason(reason({ engagement: 0.85 }), "Reddit")[0]).toMatch(/most watched on Reddit/);
    expect(explainReason(reason({ engagement: 0.5 }), "Reddit")[0]).toMatch(/Doing well on Reddit/);
  });

  it("says nothing at all about a clip that scored poorly", () => {
    // Never disparage a clip: silence rather than "unpopular".
    const notes = explainReason(reason({ engagement: 0.05, rankInPlatform: 9 }), "TikTok");
    expect(notes.join(" ")).not.toMatch(/low|poor|weak|unpopular|badly/i);
    expect(notes.some((n) => /TikTok/.test(n))).toBe(false);
  });

  it("phrases age in a way a person would", () => {
    expect(explainReason(reason({ ageHours: 1 }), "X")).toContain("Posted in the last few hours");
    expect(explainReason(reason({ ageHours: 10 }), "X")).toContain("Posted today");
    expect(explainReason(reason({ ageHours: 40 }), "X")).toContain("From the last couple of days");
    expect(explainReason(reason({ ageHours: 100 }), "X")).toContain("From this week");
    // Older than the curation window: no age note rather than a wrong one.
    expect(explainReason(reason({ ageHours: 400 }), "X").join(" ")).not.toMatch(/Posted|From this/);
  });

  it("explains a diversion, and otherwise a repeat creator", () => {
    expect(explainReason(reason({ divertedForDiversity: true }), "X").join(" ")).toMatch(/vary who you hear from/);
    expect(explainReason(reason({ creatorAlreadyPicked: 1 }), "X").join(" ")).toMatch(/Second clip from this creator/);
    expect(explainReason(reason({ creatorAlreadyPicked: 2 }), "X").join(" ")).toMatch(/Third clip from this creator/);
  });

  it("never overwhelms the slide", () => {
    const busiest = reason({ rankInPlatform: 1, engagement: 1, ageHours: 0.5, divertedForDiversity: true });
    expect(explainReason(busiest, "YouTube").length).toBeLessThanOrEqual(3);
  });

  it("always has something to say, even for an unremarkable clip", () => {
    expect(summariseReason(reason({ engagement: 0, ageHours: 500, rankInPlatform: 12 }), "Pinterest")).toBe(
      "Picked from Pinterest",
    );
  });

  it("turns the score components into whole percentages", () => {
    expect(reasonBars(reason({ engagement: 0.5, recency: 0.25 }))).toEqual([
      { label: "Engagement on its platform", percent: 50 },
      { label: "Freshness", percent: 25 },
    ]);
  });
});

describe("the explain module stays client-safe", () => {
  it("imports nothing that would drag the database into the browser bundle", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/explain.ts", "utf8");
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
    // Only a type-only import of the curation record.
    expect(imports).toEqual(["./curation"]);
    expect(source).toMatch(/import type \{ CurationReason \}/);
  });
});
