/**
 * Runs once when the server starts.
 *
 * Configuration mistakes used to surface as a 500 on the first request that happened to
 * touch encryption, which is a poor way to find out. Checking here means a misconfigured
 * deployment says so at boot instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const problems: string[] = [];
  const secret = process.env.SESSION_SECRET ?? "";

  if (process.env.NODE_ENV === "production") {
    if (!secret) problems.push("SESSION_SECRET is not set. Sessions cannot be signed and provider tokens cannot be encrypted.");
    else if (secret.length < 16) problems.push(`SESSION_SECRET is ${secret.length} characters; at least 16 are required.`);

    const base = process.env.APP_BASE_URL;
    if (base && !/^https?:\/\//.test(base)) problems.push(`APP_BASE_URL must be an absolute URL, got "${base}".`);
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (Boolean(publicKey) !== Boolean(privateKey)) {
    problems.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together; push is disabled until both are present.");
  }

  if (problems.length > 0) {
    const message = ["The Daily Scroll cannot start with this configuration:", ...problems.map((p) => `  - ${p}`)].join("\n");
    // Refuse to serve rather than fail later, mid-request, on one unlucky code path.
    throw new Error(message);
  }
}
