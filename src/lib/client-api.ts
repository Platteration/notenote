/** A request the server answered with an error. `body` is its JSON, when it sent any. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * A failed request always rejects with a message suitable for the UI. When the server answered,
 * the rejection is a RequestError carrying the status and body, so a caller can act on a 409.
 */
export async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(
      body?.error ?? (response.status === 401 ? "Please sign in again." : "Could not complete that change. Please try again."),
      response.status,
      body && typeof body === "object" ? body : null,
    );
  }
  if (body === null) throw new Error("The server returned an unexpected response. Please try again.");
  return body as T;
}

/** Keep sign-in return destinations inside this app, including encoded backslashes. */
export function safeReturnPath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\s]/.test(decoded)) return fallback;
    const base = "https://daily-scroll.invalid";
    return new URL(value, base).origin === base ? value : fallback;
  } catch {
    return fallback;
  }
}
