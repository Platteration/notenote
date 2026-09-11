import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-credential-connect-tests";
// The service host is normally resolved and vetted before the call; these tests answer the
// call from a stub instead, so there is no name to resolve.
process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";

const { credentialConnectError } = await import("@/lib/connections");
const { UserFacingError } = await import("@/lib/errors");
const { BlockedHostError } = await import("@/lib/net-guard");
const { PROVIDERS } = await import("@/lib/providers");
const { ProviderHttpError, ProviderTimeoutError } = await import("@/lib/providers/http");

const SERVICE = "https://pds.example";
/** What a PDS answers `com.atproto.server.createSession` with when the credentials are wrong. */
const REFUSAL = '{"error":"AuthenticationRequired","message":"Invalid identifier or password"}';
/** The same refusal from a host that would rather the person went somewhere else for a password. */
const HOSTILE =
  '{"error":"AuthFactorTokenRequired","message":"Your app password was rejected. Reset it at https://bsky-security.example/reset and paste the new one here."}';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function pdsAnswers(status: number, body: string): void {
  globalThis.fetch = vi.fn(
    async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

/** Run the real connect path and hand back whatever it threw. */
async function connectWith(input: Record<string, string>): Promise<unknown> {
  return PROVIDERS.bluesky.credentialConnect!.authenticate({ service: SERVICE, ...input }).then(
    () => null,
    (err: unknown) => err,
  );
}

const wrongPassword = () => connectWith({ identifier: "someone.bsky.social", password: "xxxx-xxxx-xxxx-xxxx" });

describe("a wrong app password", () => {
  it("reaches the route as an HTTP error, not as anything carrying the platform's own words", async () => {
    // Derived from the provider path rather than assumed: getJson refuses a non-2xx before
    // the body is read, so the `session.error` branch that would quote the platform is never
    // reached for a rejected credential. This is why the mapping below has to exist.
    pdsAnswers(401, REFUSAL);
    const err = await wrongPassword();
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).not.toBeInstanceOf(UserFacingError);
  });

  it("is answered as a refusal of the credentials, in this app's words and no one else's", async () => {
    pdsAnswers(401, REFUSAL);
    const answer = credentialConnectError(await wrongPassword(), "Bluesky");
    expect(answer.message).toMatch(/^Bluesky did not accept/);
    // Distinct from what a blocked host or an upstream outage says.
    expect(answer.message).not.toMatch(/Check the details/);
    // And nothing of the reply itself: a user-chosen PDS writes that text.
    expect(answer.message).not.toMatch(/AuthenticationRequired|Invalid identifier|401/);
    // The operator still gets the detail.
    expect(answer.log).toBe(true);
  });

  it("reads the same whichever refusal status the platform picks", () => {
    for (const status of [400, 401, 403]) {
      expect(credentialConnectError(new ProviderHttpError("bluesky", status, REFUSAL), "Bluesky").message).toMatch(
        /did not accept those credentials/,
      );
    }
  });
});

describe("everything else on that path", () => {
  it("keeps the wording of what this app validated itself", async () => {
    const err = await connectWith({ identifier: "", password: "" });
    expect(err).toBeInstanceOf(UserFacingError);
    const answer = credentialConnectError(err, "Bluesky");
    expect(answer.message).toMatch(/Handle and app password are required/);
    // The app raised it, so there is nothing to log.
    expect(answer.log).toBe(false);
  });

  it("says nothing a 200 reply asked it to say either", async () => {
    // The rarer shape, and the one that used to be quoted: a 200 whose body carries an error.
    // The service host is the user's choice, so that `message` is a sentence its owner wrote,
    // and it would be shown in the app's own red error line beside the field an app password is
    // being typed into. A status is not what decides whether a reply can be repeated.
    pdsAnswers(200, HOSTILE);
    const err = await wrongPassword();
    expect(err).not.toBeInstanceOf(UserFacingError);
    const answer = credentialConnectError(err, "Bluesky");
    expect(answer.message).toMatch(/^Bluesky did not accept/);
    expect(answer.message).not.toMatch(/bsky-security\.example|Reset it at|AuthFactorTokenRequired/);
    // The operator still sees what the host actually said.
    expect(answer.log).toBe(true);
  });

  it("treats a 200 with no session in it as a refusal rather than a connection", async () => {
    pdsAnswers(200, '{"handle":"someone.bsky.social","did":"did:plc:abc"}');
    const answer = credentialConnectError(await wrongPassword(), "Bluesky");
    expect(answer.message).toMatch(/^Bluesky did not accept/);
  });

  it("says nothing about the server's network or an upstream fault", () => {
    const internal = [
      new BlockedHostError("10.0.0.7", "it is a private or reserved address"),
      new ProviderTimeoutError("bluesky", 8_000),
      new ProviderHttpError("bluesky", 503, '{"error":"Upstream","message":"10.0.0.7 refused"}'),
      new Error("connect ECONNREFUSED 10.0.0.7:443"),
    ];
    for (const err of internal) {
      const answer = credentialConnectError(err, "Bluesky");
      expect(answer.message).toBe("Could not connect Bluesky. Check the details and try again.");
      expect(answer.message).not.toMatch(/10\.0\.0\.7|503|Upstream|reserved/);
      expect(answer.log).toBe(true);
    }
  });
});
