/**
 * Curation: turn a pile of items from every connected platform into one balanced,
 * deterministic, short-form-only feed for a single day.
 */
import { isShortForm, type MediaItem, type ProviderId } from "./providers/types";

export interface CurationOptions {
  /** Number of items in the final feed. */
  size: number;
  /** Deterministic seed (userId + dayKey) so the feed is stable for the whole hour. */
  seed: string;
  /** "now" used for recency scoring. */
  now: number;
  /** Items the user has already been shown on previous days. */
  seenKeys: Set<string>;
  /** Ignore items older than this many days. */
  maxAgeDays?: number;
  /** Fraction of the feed one platform may occupy when several are connected. */
  maxPlatformShare?: number;
}

/** Small, fast, seedable PRNG (mulberry32) so ordering is reproducible. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#@]\w+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function engagement(item: MediaItem): number {
  const m = item.metrics;
  // Likes and comments are stronger signals of "worth your minute" than raw views.
  return (m.views ?? 0) * 0.02 + (m.likes ?? 0) * 1 + (m.comments ?? 0) * 3 + (m.shares ?? 0) * 4;
}

/**
 * Score each item on a 0..1-ish scale that is comparable *across* platforms:
 * engagement is normalised within its platform (log-scaled) so a platform with bigger
 * numbers cannot crowd the others out, then blended with a recency decay.
 */
export function scoreItems(items: MediaItem[], now: number): Map<string, number> {
  const byProvider = new Map<ProviderId, MediaItem[]>();
  for (const it of items) {
    const list = byProvider.get(it.provider) ?? [];
    list.push(it);
    byProvider.set(it.provider, list);
  }
  const scores = new Map<string, number>();
  for (const [, list] of byProvider) {
    const logs = list.map((it) => Math.log1p(engagement(it)));
    const max = Math.max(...logs, 1e-9);
    list.forEach((it, i) => {
      const eng = logs[i] / max; // 0..1 within platform
      const ageHours = Math.max(0, (now - it.publishedAt) / 3_600_000);
      const recency = Math.exp(-ageHours / 72); // ~1/e after three days
      scores.set(it.key, 0.6 * eng + 0.4 * recency);
    });
  }
  return scores;
}

export interface CurationResult {
  items: MediaItem[];
  stats: {
    considered: number;
    afterFilters: number;
    perProvider: Record<string, number>;
  };
}

export function curate(all: MediaItem[], opts: CurationOptions): CurationResult {
  const maxAgeMs = (opts.maxAgeDays ?? 7) * 86_400_000;
  const rand = seededRandom(opts.seed);

  // 1. Hard filters: short-form only, unseen, recent.
  const fresh = all.filter(
    (it) =>
      isShortForm(it) &&
      !opts.seenKeys.has(it.key) &&
      opts.now - it.publishedAt <= maxAgeMs &&
      it.publishedAt <= opts.now + 300_000,
  );

  // 2. Deduplicate cross-posts (same creator handle + near-identical caption) and exact keys.
  const seenKeys = new Set<string>();
  const seenSignatures = new Set<string>();
  const deduped: MediaItem[] = [];
  for (const it of fresh) {
    if (seenKeys.has(it.key)) continue;
    seenKeys.add(it.key);
    const sig = `${it.creatorHandle.toLowerCase()}|${normaliseTitle(it.title)}`;
    if (normaliseTitle(it.title).length > 0 && seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    deduped.push(it);
  }

  // 3. Score and sort within each platform. Random jitter breaks ties deterministically.
  const scores = scoreItems(deduped, opts.now);
  const queues = new Map<ProviderId, MediaItem[]>();
  for (const it of deduped) {
    const q = queues.get(it.provider) ?? [];
    q.push(it);
    queues.set(it.provider, q);
  }
  const jitter = new Map<string, number>();
  for (const it of deduped) jitter.set(it.key, rand() * 0.05);
  for (const q of queues.values()) {
    q.sort(
      (a, b) =>
        (scores.get(b.key)! + jitter.get(b.key)!) - (scores.get(a.key)! + jitter.get(a.key)!),
    );
  }

  // 4. Weighted round-robin across platforms with a creator-diversity penalty and a per-platform cap.
  const providers = [...queues.keys()].sort();
  const share = opts.maxPlatformShare ?? 0.5;
  const cap = providers.length > 1 ? Math.max(1, Math.ceil(opts.size * share)) : opts.size;
  const perProvider: Record<string, number> = {};
  const perCreator = new Map<string, number>();
  const picked: MediaItem[] = [];

  // Start the rotation at a seeded position so the opening item varies day to day.
  let cursor = providers.length ? Math.floor(rand() * providers.length) : 0;
  let idleRounds = 0;
  while (picked.length < opts.size && providers.length && idleRounds < providers.length) {
    const provider = providers[cursor % providers.length];
    cursor++;
    const q = queues.get(provider)!;
    if ((perProvider[provider] ?? 0) >= cap || q.length === 0) {
      idleRounds++;
      continue;
    }
    // Prefer the best item whose creator hasn't dominated yet; fall back to the head.
    let idx = q.findIndex((it) => (perCreator.get(it.creatorHandle) ?? 0) < 2);
    if (idx === -1) idx = 0;
    const [item] = q.splice(idx, 1);
    picked.push(item);
    perProvider[provider] = (perProvider[provider] ?? 0) + 1;
    perCreator.set(item.creatorHandle, (perCreator.get(item.creatorHandle) ?? 0) + 1);
    idleRounds = 0;
  }

  return {
    items: picked,
    stats: { considered: all.length, afterFilters: deduped.length, perProvider },
  };
}
