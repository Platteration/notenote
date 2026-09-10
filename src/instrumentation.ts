/**
 * Runs once when the server starts.
 *
 * Configuration mistakes used to surface as a 500 on the first request that happened to
 * touch encryption, which is a poor way to find out. Checking here means a misconfigured
 * deployment says so at boot instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const production = process.env.NODE_ENV === "production";
  const problems: string[] = [];
  const warnings: string[] = [];
  const secret = process.env.SESSION_SECRET ?? "";

  /**
   * The SESSION_SECRET check runs everywhere, not only in production.
   *
   * Outside production the app falls back to a secret that is committed to this repository, so
   * sha256 of it is a publicly known AES-256-GCM key — and it is the key protecting the access
   * and refresh tokens of every connected platform. That is fine for a local run with demo
   * connections and not fine at all for a dev server exposed through a tunnel to register OAuth
   * redirect URIs, which is a normal step and holds real tokens. Production refuses to boot;
   * everywhere else says so on every start.
   */
  if (!secret || secret.length < 16) {
    const how = secret ? `is only ${secret.length} characters (at least 16 are required)` : "is not set";
    if (production) {
      problems.push(`SESSION_SECRET ${how}. Provider tokens cannot be encrypted.`);
    } else {
      warnings.push(
        `SESSION_SECRET ${how}, so provider tokens are being encrypted with the development key from this repository. ` +
          "That key is public: do not connect a real account to this server, and do not expose it.",
      );
    }
  }

  const base = process.env.APP_BASE_URL;
  if (base && !/^https?:\/\//.test(base)) {
    const message = `APP_BASE_URL must be an absolute URL, got "${base}".`;
    if (production) problems.push(message);
    else warnings.push(message);
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (Boolean(publicKey) !== Boolean(privateKey)) {
    problems.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together; push is disabled until both are present.");
  }

  if (warnings.length > 0) {
    console.warn(["The Daily Scroll is running with an insecure configuration:", ...warnings.map((w) => `  - ${w}`)].join("\n"));
  }

  if (problems.length > 0) {
    const message = ["The Daily Scroll cannot start with this configuration:", ...problems.map((p) => `  - ${p}`)].join("\n");
    // Refuse to serve rather than fail later, mid-request, on one unlucky code path.
    throw new Error(message);
  }
}
