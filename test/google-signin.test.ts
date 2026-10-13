import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID, CLIENT_SECRET, createFakeGoogle, upstreams, type FakeGoogle } from "./helpers/fake-upstreams";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-google-sign-in-tests";

/** The browser's cookie jar for this app's own session, as next/headers hands it to a route. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const BASE = "https://scroll.example";
const SIGN_IN_ENV = {
  APP_BASE_URL: BASE,
  GOOGLE_SIGNIN_CLIENT_ID: CLIENT_ID,
  GOOGLE_SIGNIN_CLIENT_SECRET: CLIENT_SECRET,
};

const { signUp, signIn, changePassword, NO_PASSWORD } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { SESSION_COOKIE, currentUser, createSession } = await import("@/lib/session");
const { resetIntegrations } = await import("@/lib/integrations");
const { returnPath, timezoneParam, OAUTH_COOKIE } = await import("@/lib/integrations/google");
const { resetAllRateLimits, rateLimit } = await import("@/lib/rate-limit");
const { GET: start } = await import("@/app/api/auth/google/start/route");
const { GET: callback } = await import("@/app/api/auth/google/callback/route");
const { POST: linkStart } = await import("@/app/api/account/google/route");
const { GET: config } = await import("@/app/api/config/route");

let clock = Date.UTC(2026, 9, 13, 12, 0);
let google: FakeGoogle;
const logged: string[] = [];

beforeEach(async () => {
  jar.clear();
  resetAllRateLimits();
  logged.length = 0;
  Object.assign(process.env, SIGN_IN_ENV);
  resetIntegrations();
  google = await createFakeGoogle({ now: () => clock });
  // The routes' way out to Google is the global fetch; here it is the fake, and only the fake.
  vi.stubGlobal("fetch", upstreams(google, null));
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => void logged.push(String(m)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of Object.keys(SIGN_IN_ENV)) delete process.env[name];
  resetIntegrations();
});

/** The cookie a Set-Cookie header sets: its name, value and attributes. */
function cookieOf(res: Response, name: string): { value: string; attributes: string } | null {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) {
      const semi = line.indexOf(";");
      return { value: line.slice(name.length + 1, semi < 0 ? undefined : semi), attributes: semi < 0 ? "" : line.slice(semi) };
    }
  }
  return null;
}

/** Start a sign-in as the browser does, and consent at Google: what the callback is then sent. */
async function signInAtGoogle(who: Parameters<FakeGoogle["consent"]>[1], query = ""): Promise<{ url: string; cookie: string }> {
  const res = await start(new Request(`${BASE}/api/auth/google/start${query}`));
  expect(res.status).toBe(302);
  const flow = cookieOf(res, OAUTH_COOKIE)!;
  const { code, state, redirectUri } = google.consent(res.headers.get("location")!, who);
  return { url: `${redirectUri}?code=${code}&state=${state}`, cookie: `${OAUTH_COOKIE}=${flow.value}` };
}

const back = (url: string, cookie: string) => callback(new Request(url, { headers: { cookie } }));

const users = () => getDb().prepare("SELECT id, email, password_hash FROM users").all() as Array<{ id: string; email: string; password_hash: string }>;
const identities = () => getDb().prepare("SELECT sub, user_id, email FROM google_identities").all() as Array<{ sub: string; user_id: string; email: string | null }>;

function resetDatabase() {
  const db = getDb();
  for (const table of ["google_identities", "sessions", "settings", "users"]) db.exec(`DELETE FROM ${table}`);
}

beforeEach(() => resetDatabase());

describe("with sign in with Google not configured", () => {
  it("answers 404 at every Google route and says so in /api/config", async () => {
    for (const name of Object.keys(SIGN_IN_ENV)) delete process.env[name];
    resetIntegrations();
    expect((await start(new Request(`${BASE}/api/auth/google/start`))).status).toBe(404);
    expect((await callback(new Request(`${BASE}/api/auth/google/callback?code=x&state=y`))).status).toBe(404);
    expect(await (await config()).json()).toEqual({ auth: { google: false }, shop: { products: [] } });
    expect(google.calls).toEqual([]);
  });
});

describe("starting a sign-in", () => {
  it("sends the browser to Google with the code flow, PKCE and the redirect URI from APP_BASE_URL", async () => {
    const res = await start(new Request(`${BASE}/api/auth/google/start`));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(to.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${BASE}/api/auth/google/callback`,
      scope: "openid email",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    // The flow travels in a cookie only this site's pages send back, for ten minutes.
    const flow = cookieOf(res, OAUTH_COOKIE)!;
    expect(flow.attributes).toBe("; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax");
    // Nothing is written for a sign-in that has not finished.
    expect(users()).toEqual([]);
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "/%2F%2Fevil.example",
    "%2F%2Fevil.example",
    "/%5Cevil.example",
    "/.//evil.example",
    "/x/..//evil.example",
    "/feed\u0000",
    "/fe\ted",
    "/api/account",
    "/api",
    `/${"a".repeat(1100)}`,
  ])("refuses %j as a place to land afterwards", (path) => {
    expect(returnPath(path)).toBeNull();
  });

  it("keeps a path on this site as it is", () => {
    expect(returnPath("/saved?collection=abc#top")).toBe("/saved?collection=abc#top");
    expect(returnPath("/settings")).toBe("/settings");
    expect(timezoneParam("Europe/London")).toBe("Europe/London");
    expect(timezoneParam("Etc/GMT+5")).toBe("Etc/GMT+5");
    expect(timezoneParam("Europe/London; x")).toBeNull();
    expect(timezoneParam("a".repeat(65))).toBeNull();
  });
});

describe("the callback", () => {
  it("makes an account for a new Google account, keyed by its sub, with no password, and signs it in", async () => {
    const { url, cookie } = await signInAtGoogle({ sub: "1001", email: "New.Person@Example.com" }, "?tz=Europe/Paris");
    const res = await back(url, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/connect`);
    // The flow cookie is cleared, and a session cookie of the app's own is set.
    expect(cookieOf(res, OAUTH_COOKIE)?.attributes).toContain("Max-Age=0");
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    const [user] = users();
    expect(user).toEqual({ id: expect.any(String), email: "new.person@example.com", password_hash: NO_PASSWORD });
    expect(identities()).toEqual([{ sub: "1001", user_id: user!.id, email: "New.Person@Example.com" }]);
    expect((await currentUser())?.id).toBe(user!.id);
    const settings = getDb().prepare("SELECT timezone FROM settings WHERE user_id = ?").get(user!.id) as { timezone: string };
    expect(settings.timezone).toBe("Europe/Paris");
  });

  it("signs a linked Google account in to its account, whatever address either now holds, and lands where it was asked", async () => {
    const first = await signInAtGoogle({ sub: "1002", email: "first@example.com" });
    await back(first.url, first.cookie);
    const [user] = users();
    jar.clear();
    const again = await signInAtGoogle({ sub: "1002", email: "renamed@example.com" }, "?return=%2Fsaved");
    const res = await back(again.url, again.cookie);
    expect(res.headers.get("location")).toBe(`${BASE}/saved`);
    expect(users()).toHaveLength(1);
    expect((await currentUser())?.id).toBe(user!.id);
    expect(identities()[0]?.email).toBe("renamed@example.com");
  });

  it("never links by email: an account here with the same address is not signed in to, linked or changed", async () => {
    // Anyone can type an address into the sign-up form here, so its owner is unproven.
    const typed = await signUp({ email: "victim@example.com", displayName: "Typed", password: "password123" });
    const before = users();
    const { url, cookie } = await signInAtGoogle({ sub: "2001", email: "victim@example.com" });
    const res = await back(url, cookie);
    expect(res.headers.get("location")).toBe(`${BASE}/?signin=exists`);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(identities()).toEqual([]);
    expect(users()).toEqual(before);
    // The account keeps its password, and nothing else signs in to it.
    expect((await signIn("victim@example.com", "password123")).id).toBe(typed.id);
  });

  it("makes no account when Google has no verified address to give it, or one an account here could not have", async () => {
    for (const who of [{ sub: "3001" }, { sub: "3002", email: "unverified@example.com", emailVerified: false }, { sub: "3003", email: "someone@localhost" }]) {
      const { url, cookie } = await signInAtGoogle(who);
      expect((await back(url, cookie)).headers.get("location")).toBe(`${BASE}/?signin=noemail`);
    }
    expect(users()).toEqual([]);
  });

  it("ends the session the browser held and starts a new one, so none can be planted beforehand", async () => {
    const other = await signUp({ email: "held@example.com", displayName: "Held", password: "password123" });
    await createSession(other.id);
    const planted = jar.get(SESSION_COOKIE)!;
    const { url, cookie } = await signInAtGoogle({ sub: "4001", email: "fresh@example.com" });
    await back(url, cookie);
    expect(jar.get(SESSION_COOKIE)).not.toBe(planted);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?").get(other.id)).toEqual({ c: 0 });
  });

  it("charges a new account to the per-address sign-up limit behind a trusted proxy", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    try {
      const from = (url: string, cookie: string) => callback(new Request(url, { headers: { cookie, "X-Forwarded-For": "203.0.113.9" } }));
      for (let i = 0; i < 5; i++) {
        const { url, cookie } = await signInAtGoogle({ sub: `5100${i}`, email: `house${i}@example.com` });
        expect((await from(url, cookie)).headers.get("location")).toBe(`${BASE}/connect`);
        jar.clear();
      }
      const { url, cookie } = await signInAtGoogle({ sub: "51009", email: "house9@example.com" });
      expect((await from(url, cookie)).headers.get("location")).toBe(`${BASE}/?signin=limited`);
      expect(users()).toHaveLength(5);
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });

  it("charges a new account to the sign-up ceiling, and makes none once it is spent", async () => {
    for (let i = 0; i < 200; i++) rateLimit("signup:deployment", 200, 3_600_000, clock);
    const { url, cookie } = await signInAtGoogle({ sub: "5001", email: "late@example.com" });
    expect((await back(url, cookie)).headers.get("location")).toBe(`${BASE}/?signin=limited`);
    expect(users()).toEqual([]);
  });

  describe("refuses, clearing the flow cookie, creating nothing and reflecting nothing from Google", () => {
    async function refused(url: string, cookie: string, reason: string | null) {
      const res = await back(url, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${BASE}/?signin=failed`);
      expect(cookieOf(res, OAUTH_COOKIE)?.attributes).toContain("Max-Age=0");
      expect(jar.has(SESSION_COOKIE)).toBe(false);
      expect(users()).toEqual([]);
      expect(logged).toEqual(reason ? [`Sign in with Google failed (${reason})`] : []);
    }

    it("without the flow cookie", async () => {
      const { url } = await signInAtGoogle({ sub: "6001", email: "a@example.com" });
      await refused(url, "", "no valid sign-in cookie");
    });

    it("with a flow cookie this server did not sign", async () => {
      const { url, cookie } = await signInAtGoogle({ sub: "6002", email: "a@example.com" });
      const [payload, mac] = cookie.slice(OAUTH_COOKIE.length + 1).split(".");
      const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
      forged.r = "//evil.example";
      await refused(url, `${OAUTH_COOKIE}=${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`, "no valid sign-in cookie");
    });

    it("with a flow cookie past its ten minutes", async () => {
      const { url, cookie } = await signInAtGoogle({ sub: "6003", email: "a@example.com" });
      clock += 601_000;
      await refused(url, cookie, "no valid sign-in cookie");
      clock -= 601_000;
    });

    it("with a state that is not the flow's (a login CSRF)", async () => {
      // The attacker's own code and state, in the victim's browser with the victim's flow.
      const victim = await signInAtGoogle({ sub: "6004", email: "victim@example.com" });
      const attacker = await signInAtGoogle({ sub: "6005", email: "attacker@example.com" });
      await refused(attacker.url, victim.cookie, "state");
    });

    it("when the visitor said no at Google", async () => {
      const { cookie } = await signInAtGoogle({ sub: "6006", email: "a@example.com" });
      await refused(`${BASE}/api/auth/google/callback?error=access_denied&error_description=%3Cscript%3E`, cookie, null);
    });

    it("with a code too long to be Google's, without asking Google", async () => {
      const { url, cookie } = await signInAtGoogle({ sub: "6010", email: "a@example.com" });
      const long = url.replace(/code=[^&]+/, `code=${"x".repeat(4097)}`);
      await refused(long, cookie, "code");
      expect(google.calls).not.toContain("token");
    });

    it("when Google will not exchange the code", async () => {
      const { url, cookie } = await signInAtGoogle({ sub: "6007", email: "a@example.com" });
      await back(url, cookie); // the code is spent
      resetDatabase();
      jar.clear();
      logged.length = 0;
      await refused(url, cookie, "token");
    });

    it.each([
      ["a nonce from another sign-in", { nonce: "someone-elses" }, "nonce"],
      ["another audience", { aud: "other.apps.googleusercontent.com" }, "aud"],
      ["another authorised party", { azp: "other.apps.googleusercontent.com" }, "azp"],
      ["another issuer", { iss: "https://evil.example" }, "iss"],
      ["an expired token", { exp: Math.floor(Date.UTC(2026, 9, 13, 11, 0) / 1000) }, "exp"],
      ["a token issued in the future", { iat: Math.floor(Date.UTC(2026, 9, 13, 13, 0) / 1000) }, "iat"],
    ])("for an ID token with %s", async (_what, claims, reason) => {
      const { url, cookie } = await signInAtGoogle({ sub: "6008", email: "a@example.com", claims });
      await refused(url, cookie, reason);
    });
  });
});

describe("an account made with Google", () => {
  it("costs a password guess as much as any other account does, so it is not told apart", async () => {
    await signUp({ email: "timed@example.com", displayName: "Timed", password: "password123" });
    const { url, cookie } = await signInAtGoogle({ sub: "7002", email: "timed.google@example.com" });
    await back(url, cookie);
    expect(users().find((u) => u.email === "timed.google@example.com")?.password_hash).toBe(NO_PASSWORD);
    const time = async (email: string) => {
      const started = process.hrtime.bigint();
      await signIn(email, "definitely-the-wrong-password").catch(() => {});
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    await time("timed@example.com");
    await time("timed.google@example.com");
    let password = 0;
    let google = 0;
    for (let i = 0; i < 3; i++) {
      password += await time("timed@example.com");
      google += await time("timed.google@example.com");
    }
    // Both pay one scrypt: the account with no password is checked against the decoy hash.
    expect(google).toBeGreaterThan(password * 0.4);
    expect(password).toBeGreaterThan(3);
  });

  it("has no password that any guess opens, and none to change", async () => {
    const { url, cookie } = await signInAtGoogle({ sub: "7001", email: "nopass@example.com" });
    await back(url, cookie);
    const [user] = users();
    for (const guess of ["", "none", NO_PASSWORD, "password123"]) {
      await expect(signIn("nopass@example.com", guess)).rejects.toThrow("Email or password is incorrect");
    }
    await expect(changePassword(user!.id, "none", "a-new-password", null)).rejects.toThrow("has no password to change");
  });
});

describe("linking Google from Settings", () => {
  const sameSite = { "Sec-Fetch-Site": "same-origin" };

  async function signedInWithPassword(email: string) {
    const user = await signUp({ email, displayName: "Owner", password: "password123" });
    jar.clear();
    await createSession(user.id);
    return user;
  }

  async function linkAtGoogle(who: Parameters<FakeGoogle["consent"]>[1]) {
    const res = await linkStart(new Request(`${BASE}/api/account/google`, { method: "POST", headers: sameSite }), undefined as never);
    expect(res.status).toBe(200);
    const { url: consentAt } = (await res.json()) as { url: string };
    const flow = cookieOf(res, OAUTH_COOKIE)!;
    expect(flow.attributes).toBe("; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax");
    const { code, state, redirectUri } = google.consent(consentAt, who);
    return { url: `${redirectUri}?code=${code}&state=${state}`, cookie: `${OAUTH_COOKIE}=${flow.value}` };
  }

  it("links the Google account to the signed-in account, which it then signs in to", async () => {
    const owner = await signedInWithPassword("owner@example.com");
    const { url, cookie } = await linkAtGoogle({ sub: "8001", email: "owner.at.google@example.com" });
    const res = await back(url, cookie);
    expect(res.headers.get("location")).toBe(`${BASE}/settings?link=done`);
    expect(identities()).toEqual([{ sub: "8001", user_id: owner.id, email: "owner.at.google@example.com" }]);
    jar.clear();
    const later = await signInAtGoogle({ sub: "8001", email: "owner.at.google@example.com" });
    expect((await back(later.url, later.cookie)).headers.get("location")).toBe(`${BASE}/feed`);
    expect((await currentUser())?.id).toBe(owner.id);
    expect(users()).toHaveLength(1);
  });

  it("links nothing when the browser is no longer signed in to the account that asked", async () => {
    await signedInWithPassword("asker@example.com");
    const { url, cookie } = await linkAtGoogle({ sub: "8002", email: "g@example.com" });
    // Signed in as someone else by the time Google sends the browser back.
    const other = await signUp({ email: "other@example.com", displayName: "Other", password: "password123" });
    jar.clear();
    await createSession(other.id);
    expect((await back(url, cookie)).headers.get("location")).toBe(`${BASE}/settings?link=failed`);
    jar.clear();
    expect((await back(url, cookie)).headers.get("location")).toBe(`${BASE}/settings?link=failed`);
    expect(identities()).toEqual([]);
  });

  it("will not take a Google account that already signs in to another account here", async () => {
    const first = await signInAtGoogle({ sub: "8003", email: "taken@example.com" });
    await back(first.url, first.cookie);
    await signedInWithPassword("second@example.com");
    const { url, cookie } = await linkAtGoogle({ sub: "8003", email: "taken@example.com" });
    expect((await back(url, cookie)).headers.get("location")).toBe(`${BASE}/settings?link=taken`);
    expect(identities()).toHaveLength(1);
  });

  it("links one Google account at most, even when two links were started at once", async () => {
    const owner = await signedInWithPassword("twice@example.com");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await linkAtGoogle({ sub: "8005", email: "one@example.com" });
    const second = await linkAtGoogle({ sub: "8006", email: "two@example.com" });
    expect((await back(first.url, first.cookie)).headers.get("location")).toBe(`${BASE}/settings?link=done`);
    expect((await back(second.url, second.cookie)).headers.get("location")).toBe(`${BASE}/settings?link=failed`);
    expect(identities()).toEqual([{ sub: "8005", user_id: owner.id, email: "one@example.com" }]);
    // Refused as a rule of its own, not as a database error the route caught.
    expect(errors).not.toHaveBeenCalled();
  });

  it("cannot be started from another site, or signed out, or twice", async () => {
    await signedInWithPassword("guarded@example.com");
    const crossSite = await linkStart(new Request(`${BASE}/api/account/google`, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } }), undefined as never);
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
    const { url, cookie } = await linkAtGoogle({ sub: "8004", email: "g4@example.com" });
    await back(url, cookie);
    const twice = await linkStart(new Request(`${BASE}/api/account/google`, { method: "POST", headers: sameSite }), undefined as never);
    expect(twice.status).toBe(409);
    jar.clear();
    const signedOut = await linkStart(new Request(`${BASE}/api/account/google`, { method: "POST", headers: sameSite }), undefined as never);
    expect(signedOut.status).toBe(401);
  });
});
