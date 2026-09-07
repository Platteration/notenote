import { beforeEach, describe, expect, it } from "vitest";
import { clearRateLimit, clientKey, rateLimit, resetAllRateLimits } from "@/lib/rate-limit";

beforeEach(() => resetAllRateLimits());

describe("rate limit", () => {
  const T0 = 1_000_000;

  it("allows up to the limit and then refuses", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000, T0).ok).toBe(true);
    const denied = rateLimit("k", 3, 60_000, T0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfter).toBe(60);
  });

  it("counts down the remaining attempts", () => {
    expect(rateLimit("k", 3, 60_000, T0).remaining).toBe(2);
    expect(rateLimit("k", 3, 60_000, T0).remaining).toBe(1);
    expect(rateLimit("k", 3, 60_000, T0).remaining).toBe(0);
  });

  it("opens a fresh window once the old one expires", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 60_000, T0);
    expect(rateLimit("k", 3, 60_000, T0 + 59_000).ok).toBe(false);
    expect(rateLimit("k", 3, 60_000, T0 + 60_001).ok).toBe(true);
  });

  it("keeps separate keys independent", () => {
    for (let i = 0; i < 3; i++) rateLimit("a", 3, 60_000, T0);
    expect(rateLimit("a", 3, 60_000, T0).ok).toBe(false);
    expect(rateLimit("b", 3, 60_000, T0).ok).toBe(true);
  });

  it("forgets a key on demand, as a successful sign-in does", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 60_000, T0);
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(false);
    clearRateLimit("k");
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(true);
  });

  it("sweeps expired buckets so the map cannot grow without bound", () => {
    for (let i = 0; i < 500; i++) rateLimit(`key-${i}`, 1, 1_000, T0);
    // A later call past the sweep interval clears everything already expired.
    rateLimit("trigger", 1, 1_000, T0 + 120_000);
    for (let i = 0; i < 500; i++) expect(rateLimit(`key-${i}`, 1, 1_000, T0 + 120_000).ok).toBe(true);
  });
});

describe("client key", () => {
  it("prefers the first x-forwarded-for hop", () => {
    const req = new Request("https://x.test", { headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" } });
    expect(clientKey(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip, then to a constant", () => {
    expect(clientKey(new Request("https://x.test", { headers: { "x-real-ip": "198.51.100.7" } }))).toBe("198.51.100.7");
    expect(clientKey(new Request("https://x.test"))).toBe("unknown");
  });
});
