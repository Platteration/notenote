import { beforeEach, describe, expect, it } from "vitest";
import { clearRateLimit, clientKey, rateLimit, resetAllRateLimits, trustedProxyHops } from "@/lib/rate-limit";

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
