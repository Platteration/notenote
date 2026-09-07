/**
 * How long a single call to a platform may take. Without this a hung platform would hold
 * the user's first request of the hour open indefinitely, since feed generation waits on
 * every connected platform before it can answer.
 */
export function requestTimeoutMs(): number {
  const configured = Number(process.env.PROVIDER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 8_000;
}

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

export async function getJson<T>(provider: string, url: string, init?: RequestInit): Promise<T> {
  const timeout = requestTimeoutMs();
  let res: Response;
  try {
    // A caller that passes its own signal has its own deadline; otherwise apply ours.
    res = await fetch(url, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(timeout) });
  } catch (err) {
    // fetch reports both an abort and a network failure by throwing; only the first is a timeout.
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ProviderTimeoutError(provider, timeout);
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderHttpError(provider, res.status, text);
  return JSON.parse(text) as T;
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
