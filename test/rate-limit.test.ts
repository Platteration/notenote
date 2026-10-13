import { beforeEach, describe, expect, it } from "vitest";
import { CALLER_KEYED, clearRateLimit, clientKey, MAX_RATE_LIMIT_BUCKETS, rateLimit, rateLimitBucketCount, rateLimitIfTracked, refundRateLimit, resetAllRateLimits, trustedProxyHops } from "@/lib/rate-limit";

beforeEach(() => resetAllRateLimits());

const T0 = 1_000_000;

describe("rate limit", () => {

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

  it("gives an attempt back when the request it was charged for did nothing", () => {
    // What a bucket charged for work done rather than for a request made needs: sign-up
    // reserves a place on the way in and hands it back when no account came of the request.
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000, T0).ok).toBe(true);
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(false);
    // Four requests were charged, the refused one included, and none of them created anything.
    for (let i = 0; i < 4; i++) refundRateLimit("k", T0);
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000, T0).ok).toBe(true);
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(false);
  });

  it("cannot be refunded below nothing, or into a window that has already reset", () => {
    for (let i = 0; i < 5; i++) refundRateLimit("k", T0);
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000, T0).ok).toBe(true);
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(false);
    // A refund arriving after the window turned over belongs to a bucket that no longer exists.
    refundRateLimit("k", T0 + 60_001);
    expect(rateLimit("k", 3, 60_000, T0).ok).toBe(false);
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

  it("bounds sustained distinct keys without denying an existing or fresh account globally", () => {
    // Account names are the caller's to invent, so these are the keys the cap is for.
    rateLimit("login:acct:active", 2, 900_000, T0);
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS * 3; i++) {
      rateLimit(`login:acct:unknown-${i}`, 1, 900_000, T0);
      rateLimit("login:acct:active", Number.MAX_SAFE_INTEGER, 900_000, T0);
    }
    expect(rateLimitBucketCount()).toBe(MAX_RATE_LIMIT_BUCKETS);
    expect(rateLimit("login:acct:active", Number.MAX_SAFE_INTEGER, 900_000, T0).remaining).toBeLessThan(Number.MAX_SAFE_INTEGER - 2);
    expect(rateLimit("login:acct:honest-new-account", 2, 900_000, T0).ok).toBe(true);
    expect(rateLimitBucketCount()).toBe(MAX_RATE_LIMIT_BUCKETS);
  });

  it.each(CALLER_KEYED)("caps keys under %s at the same number, counted for that kind alone", (kind) => {
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 50; i++) rateLimit(`${kind}${i}`, 1, 900_000, T0);
    expect(rateLimitBucketCount()).toBe(MAX_RATE_LIMIT_BUCKETS);
  });

  it("never forgets a ceiling the server keyed, whatever floods the keys callers choose", () => {
    // The deployment-wide sign-up ceiling and a signed-in account's current-password guesses,
    // each spent. One shared capped map let 10,000 fresh sign-in keys push both out.
    for (let i = 0; i < 3; i++) rateLimit("signup:deployment", 2, 3_600_000, T0);
    for (let i = 0; i < 9; i++) rateLimit("password:user-1", 8, 900_000, T0);
    for (const kind of CALLER_KEYED) {
      for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 1; i++) rateLimit(`${kind}flood-${i}`, 1, 900_000, T0);
    }
    expect(rateLimit("signup:deployment", 2, 3_600_000, T0).ok).toBe(false);
    expect(rateLimit("password:user-1", 8, 900_000, T0).ok).toBe(false);
  });

  it("does not cap the keys the server chose: there are only as many as there are accounts", () => {
    for (let i = 0; i < 9; i++) rateLimit("password:user-0", 8, 900_000, T0);
    for (let i = 1; i <= MAX_RATE_LIMIT_BUCKETS; i++) rateLimit(`password:user-${i}`, 8, 900_000, T0);
    expect(rateLimitBucketCount()).toBe(MAX_RATE_LIMIT_BUCKETS + 1);
    expect(rateLimit("password:user-0", 8, 900_000, T0).ok).toBe(false);
  });

  it("lets a flood of one kind of caller-chosen key push out only keys of that kind", () => {
    // Fresh addresses are free behind a proxy; they must not empty an account's ceiling, which
    // costs a password check per key to refill.
    for (let i = 0; i < 101; i++) rateLimit("login:acct:victim@example.com", 100, 900_000, T0);
    for (const kind of CALLER_KEYED.filter((k) => k !== "login:acct:")) {
      for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 1; i++) rateLimit(`${kind}flood-${i}`, 1, 900_000, T0);
    }
    expect(rateLimitIfTracked("login:acct:victim@example.com", 100, 900_000, T0)?.ok).toBe(false);
  });

  it("sweeps expired buckets of every kind, not only the server's", () => {
    rateLimit("login:ip:203.0.113.9", 1, 1_000, T0);
    rateLimit("password:user-1", 1, 1_000, T0);
    rateLimit("trigger", 1, 1_000, T0 + 120_000);
    expect(rateLimitBucketCount()).toBe(1);
  });

  it("does not allocate unseen account hints before work-queue admission", () => {
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS * 2; i++) {
      expect(rateLimitIfTracked(`unknown-${i}`, 100, 900_000, T0)).toBeNull();
    }
    expect(rateLimitBucketCount()).toBe(0);
    rateLimit("known", 1, 900_000, T0);
    expect(rateLimitIfTracked("known", 1, 900_000, T0)?.ok).toBe(false);
    expect(rateLimitBucketCount()).toBe(1);
  });
});

describe("client key", () => {
  const xff = (value: string) => new Request("https://x.test", { headers: { "x-forwarded-for": value } });

  it("has no address to give when no proxy is trusted, however hard the client tries", () => {
    // The default deployment is `next start` with nothing in front of it, so a forwarding
    // header is just something the client typed. Trusting it would hand every client a
    // private bucket per request; falling back to a constant would put every client in one
    // shared bucket, where 21 wrong sign-ins lock the whole deployment out.
    expect(clientKey(xff("203.0.113.5"), {})).toBeNull();
    expect(clientKey(new Request("https://x.test", { headers: { "x-real-ip": "198.51.100.7" } }), {})).toBeNull();
    expect(clientKey(new Request("https://x.test"), {})).toBeNull();
  });

  it("two unidentifiable clients never consume each other's budget", () => {
    // The failure this guards: any key at all, shared, is a deployment-wide lockout.
    const a = clientKey(new Request("https://x.test"), {});
    const b = clientKey(xff("203.0.113.9"), {});
    expect(a).toBeNull();
    expect(b).toBeNull();
    const keyed = (ip: string | null) => (ip ? rateLimit(`login:ip:${ip}`, 1, 60_000, T0).ok : true);
    expect(keyed(a)).toBe(true);
    expect(keyed(b)).toBe(true);
  });

  it("reads the client from the right of the chain once a proxy is trusted", () => {
    const env = { TRUSTED_PROXY_HOPS: "1" };
    expect(clientKey(xff("203.0.113.5, 70.41.3.18"), env)).toBe("70.41.3.18");
    expect(clientKey(xff("203.0.113.5, 70.41.3.18"), { TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.5");
    // A client that prepends its own entries cannot move the one the trusted proxy wrote.
    expect(clientKey(xff("1.1.1.1, 2.2.2.2, 70.41.3.18"), env)).toBe("70.41.3.18");
  });

  it("refuses a chain that is shorter than the trusted hops, or is not an address", () => {
    expect(clientKey(xff("203.0.113.5"), { TRUSTED_PROXY_HOPS: "2" })).toBeNull();
    expect(clientKey(new Request("https://x.test"), { TRUSTED_PROXY_HOPS: "1" })).toBeNull();
    expect(clientKey(xff("not-an-address"), { TRUSTED_PROXY_HOPS: "1" })).toBeNull();
  });

  it("reads an address that carries a port or brackets", () => {
    const env = { TRUSTED_PROXY_HOPS: "1" };
    expect(clientKey(xff("70.41.3.18:41234"), env)).toBe("70.41.3.18");
    expect(clientKey(xff("[2606:4700::1111]"), env)).toBe("2606:4700::1111");
  });

  it("treats a missing or nonsensical hop count as no proxy", () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "banana" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "-1" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2);
  });
});
