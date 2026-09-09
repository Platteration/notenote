import { assertPublicHost, BlockedHostError } from "../net-guard";

/**
 * How long a single call to a platform may take. Without this a hung platform would hold
 * the user's first request of the hour open indefinitely, since feed generation waits on
 * every connected platform before it can answer.
 */
export function requestTimeoutMs(): number {
  const configured = Number(process.env.PROVIDER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 8_000;
}

/**
 * How much of a reply is buffered before it is refused. The destination of a Bluesky call is
 * chosen by the user, so a hostile one can answer with an endless stream and hold a request
 * open for the whole deadline while the process grows.
 */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** Long enough for a real API that moves an endpoint; short enough that a loop ends. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ProviderTimeoutError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider} did not respond within ${ms}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${provider} API responded ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderResponseTooLargeError extends Error {
  constructor(provider: string, limit: number) {
    super(`${provider} sent more than ${limit} bytes`);
    this.name = "ProviderResponseTooLargeError";
  }
}

/**
 * Read a body through a counting stream instead of res.text().
 *
 * res.text() buffers whatever arrives, so a destination that streams without end costs
 * memory for as long as the deadline allows. Counting as it goes stops that at a fixed size.
 */
async function readCapped(provider: string, res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new ProviderResponseTooLargeError(provider, limit);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/**
 * Fetch JSON, following redirects by hand.
 *
 * The default redirect mode would make each hop unguarded: net-guard checks the host the user
 * named, and a 302 from that host to 169.254.169.254 or a LAN address would then be followed
 * with no check at all — and part of the reply handed back in the error message. So every hop
 * is resolved and vetted like the first, the chain is bounded, and credentials are dropped
 * when a redirect leaves the origin they were meant for.
 */
export async function getJson<T>(provider: string, url: string, init?: RequestInit): Promise<T> {
  const timeout = requestTimeoutMs();
  // A caller that passes its own signal has its own deadline; otherwise apply ours. One
  // signal covers the whole chain, so redirects cannot extend it.
  const signal = init?.signal ?? AbortSignal.timeout(timeout);
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  let target = url;
  let method = (init?.method ?? "GET").toUpperCase();
  let body = init?.body;

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { ...init, method, headers, body, redirect: "manual", cache: "no-store", signal });
    } catch (err) {
      // fetch reports both an abort and a network failure by throwing; only the first is a timeout.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new ProviderTimeoutError(provider, timeout);
      }
      throw err;
    }

    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (!location) {
      const text = await readCapped(provider, res, MAX_RESPONSE_BYTES);
      if (!res.ok) throw new ProviderHttpError(provider, res.status, text);
      return JSON.parse(text) as T;
    }

    if (hop >= MAX_REDIRECTS) throw new Error(`${provider} redirected more than ${MAX_REDIRECTS} times`);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new BlockedHostError(location, "the redirect target is not an address");
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new BlockedHostError(next.protocol, "only http and https redirects are followed");
    }
    // The whole point of the guard is that the destination is checked, not merely the name
    // that was typed. A redirect is a new destination.
    await assertPublicHost(next.hostname);
    if (new URL(target).origin !== next.origin) {
      // A bearer token is issued for one origin; a redirect elsewhere must not carry it.
      headers.delete("authorization");
      headers.delete("cookie");
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    await res.body?.cancel().catch(() => {});
    target = next.href;
  }
}

export async function postForm<T>(
  provider: string,
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<T> {
  return getJson<T>(provider, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

export function expiresAtFrom(expiresIn: number | undefined | null): number | null {
  return typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : null;
}

/** Parse ISO 8601 durations such as PT1M3S into seconds (YouTube uses this format). */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => (x ? Number(x) : 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}
