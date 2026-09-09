import { afterEach, describe, expect, it } from "vitest";

process.env.SESSION_SECRET = "test-secret-for-csrf-tests";

const { CrossSiteError, assertSameSite, readJson } = await import("@/lib/api");

const APP = "https://scroll.example";

/**
 * The body a cross-site `<form method=POST enctype="text/plain">` produces when its single
 * field is named `{"email":"attacker@x","password":"pw","x":"` with the value `"}`. Browsers
 * write `name=value\r\n`, which lands on a document JSON.parse accepts — no preflight, no
 * Content-Type the page had to choose.
 */
const FORM_SMUGGLED_JSON = '{"email":"attacker@x","password":"pw","x":"="}\r\n';

function post(headers: Record<string, string>, url = `${APP}/api/auth/login`): Request {
  return new Request(url, { method: "POST", headers, body: FORM_SMUGGLED_JSON });
}

afterEach(() => {
  delete process.env.APP_BASE_URL;
});

describe("the shape of the attack", () => {
  it("a text/plain form body really is valid JSON, which is why the check has to exist", () => {
    // Derived from the browser's own encoding rather than from anything the guard does: if
    // this stopped parsing the guard below would pass for the wrong reason.
    expect(JSON.parse(FORM_SMUGGLED_JSON)).toEqual({ email: "attacker@x", password: "pw", x: "=" });
  });
});

describe("cross-site guard", () => {
  it("refuses a state-changing request a browser made from another site", () => {
    expect(() => assertSameSite(post({ "sec-fetch-site": "cross-site", "content-type": "text/plain" }))).toThrow(CrossSiteError);
    // A sibling subdomain is not this origin either.
    expect(() => assertSameSite(post({ "sec-fetch-site": "same-site" }))).toThrow(CrossSiteError);
  });

  it("allows the app's own requests and a typed address", () => {
    expect(() => assertSameSite(post({ "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameSite(post({ "sec-fetch-site": "none" }))).not.toThrow();
  });

  it("falls back to Origin when the browser is too old to say", () => {
    process.env.APP_BASE_URL = APP;
    expect(() => assertSameSite(post({ origin: "https://evil.example" }))).toThrow(CrossSiteError);
    expect(() => assertSameSite(post({ origin: APP }))).not.toThrow();
  });

  it("compares Origin against the request's own host when APP_BASE_URL is unset", () => {
    expect(() => assertSameSite(post({ origin: "https://evil.example" }))).toThrow(CrossSiteError);
    expect(() => assertSameSite(post({ origin: APP }))).not.toThrow();
  });

  it("lets a non-browser client through: curl, the cron job, the smoke script", () => {
    expect(() => assertSameSite(post({ "content-type": "application/json" }))).not.toThrow();
  });

  it("does not interfere with reads", () => {
    expect(() => assertSameSite(new Request(`${APP}/api/feed`, { headers: { "sec-fetch-site": "cross-site" } }))).not.toThrow();
  });
});

describe("JSON body guard", () => {
  it("refuses a body a form could have sent, even though it parses as JSON", async () => {
    const req = post({ "content-type": "text/plain;charset=UTF-8" });
    await expect(readJson(req)).rejects.toThrow(/must be JSON/);
  });

  it("refuses the other two encodings a form can produce", async () => {
    await expect(readJson(post({ "content-type": "application/x-www-form-urlencoded" }))).rejects.toThrow(/must be JSON/);
    await expect(readJson(post({ "content-type": "multipart/form-data; boundary=x" }))).rejects.toThrow(/must be JSON/);
  });

  it("accepts a real JSON request, with or without a charset", async () => {
    await expect(readJson(post({ "content-type": "application/json" }))).resolves.toEqual({
      email: "attacker@x",
      password: "pw",
      x: "=",
    });
    await expect(readJson(post({ "content-type": "application/json; charset=utf-8" }))).resolves.toBeTypeOf("object");
  });

  it("still refuses a body that is not JSON at all", async () => {
    const req = new Request(`${APP}/api/saved`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    await expect(readJson(req)).rejects.toThrow(/must be JSON/);
  });
});
