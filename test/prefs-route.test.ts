import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-prefs-route-tests";

/** A cookie jar standing in for the one a request would carry. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { signUp } = await import("@/lib/auth");
const { createSession } = await import("@/lib/session");
const { DEFAULT_PREFS, getSettings, saveSettings } = await import("@/lib/settings");
const { DELETE } = await import("@/app/api/settings/prefs/route");

const URL_ = "https://scroll.example/api/settings/prefs";
const del = (headers: Record<string, string> = {}) => DELETE(new Request(URL_, { method: "DELETE", headers }), undefined);
const body = async (res: Response) => (await res.json()) as { error?: string; prefs?: typeof DEFAULT_PREFS };

let userId: string;

/** A signed-in user whose preferences are all away from their defaults. */
beforeEach(async () => {
  jar.clear();
  userId = (await signUp({ email: `prefs-${Math.random()}@example.com`, displayName: "Prefs", password: "password123" })).id;
  saveSettings(userId, {
    windowStart: "06:15",
    feedSize: 33,
    prefs: { theme: "wire", reduceMotion: "off", haptics: false, sound: true },
  });
});

const chosen = { theme: "wire", reduceMotion: "off", haptics: false, sound: true };

/**
 * The reset route, driven as a request rather than through the library behind it. Only the
 * smoke walk reached it before, signed in and same-site, so a handler that had lost its gate
 * would have passed every check in CI.
 */
describe("DELETE /api/settings/prefs", () => {
  it("refuses a caller with no session, and changes nothing", async () => {
    const res = await del({ "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(401);
    expect((await body(res)).error).toBe("Not signed in");
    expect(getSettings(userId).prefs).toMatchObject(chosen);
  });

  it("refuses a signed-in request another site made, and changes nothing", async () => {
    await createSession(userId);
    const fromElsewhere: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      // A browser too old to send Sec-Fetch-Site still sends an Origin.
      { origin: "https://evil.example" },
    ];
    for (const headers of fromElsewhere) {
      const res = await del(headers);
      expect(res.status).toBe(403);
      expect(getSettings(userId).prefs).toMatchObject(chosen);
    }
  });

  it("resets the preferences for the app's own request, and leaves the hour where it was", async () => {
    await createSession(userId);
    const res = await del({ "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect((await body(res)).prefs).toEqual(DEFAULT_PREFS);
    // What it answered is not the point: what it wrote is.
    const after = getSettings(userId);
    expect(after.prefs).toEqual(DEFAULT_PREFS);
    expect(after.windowStart).toBe("06:15");
    expect(after.feedSize).toBe(33);
  });

  it("resets one account, not the signed-in user's neighbours", async () => {
    const other = (await signUp({ email: `other-${Math.random()}@example.com`, displayName: "Other", password: "password123" })).id;
    saveSettings(other, { prefs: { theme: "light" } });
    await createSession(userId);
    expect((await del({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(getSettings(other).prefs.theme).toBe("light");
  });
});
