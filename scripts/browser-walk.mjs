#!/usr/bin/env node
/**
 * The browser half of `npm run test:e2e`: the built app, driven in Chromium under the response
 * headers it really sends, failing on anything the policy refuses.
 *
 * `scripts/smoke.sh` walks the API over HTTP; this walks the pages. It signs up through the form,
 * connects two demo platforms, opens the hour from Settings, scrolls, saves a clip, files it in
 * the archive, changes the theme, signs out, and visits a page that does not exist — every page
 * reached by the app's own links, so the framework loads its route chunks the way a visitor's
 * browser does. Throughout, it fails on:
 *
 * - any Content-Security-Policy violation, seen both as a `securitypolicyviolation` event in the
 *   page and as the browser's console report;
 * - any uncaught exception in a page, and any console error;
 * - any request that leaves this origin (the demo catalogue's posters are inline SVG, so a
 *   walk on demo connections has no reason to reach anywhere else);
 * - any response from this origin without the security headers, or with headers other than the
 *   ones the README writes out, and a page nonce used twice;
 * - a Permissions-Policy feature Chromium does not recognise, or one the page is still allowed
 *   that the header denies;
 * - caching other than what the README describes: pages and API responses never stored, hashed
 *   build assets immutable, `public/` files revalidated on every use.
 *
 * Then, in fresh browsers: without JavaScript the page must say it needs it and the browser
 * must refuse to send a form itself, and a page whose scripts fail to arrive or throw while
 * starting must say so rather than show dead buttons.
 *
 * BASE names the server (`scripts/e2e.sh` starts one); the account it signs up is its own, so
 * point it only at a scratch instance.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const HTTPS = ORIGIN.startsWith("https:");

/** Steps print as they go, so a failure says where the walk was. */
function step(text) {
  console.log(`-> ${text}`);
}

const problems = [];
function problem(text) {
  problems.push(text);
  console.error(`   PROBLEM: ${text}`);
}
function fail(text) {
  console.error(`BROWSER WALK FAIL: ${text}`);
  process.exit(1);
}

/**
 * The headers as the README writes them out: the block in "The website: headers and hosting",
 * `Name: value` per line, for a deployment that answers on https, with `{nonce}` where each response's nonce
 * goes. Over plain http the server leaves out HSTS and `upgrade-insecure-requests`, as the README
 * says beside the block.
 */
function documentedHeaders() {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = /<!-- headers:begin -->\s*```text\n([\s\S]*?)```\s*<!-- headers:end -->/.exec(readme);
  if (!block) fail("README.md has no headers block between <!-- headers:begin --> and <!-- headers:end -->");
  const headers = new Map();
  for (const line of block[1].split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(": ");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 2));
  }
  if (!HTTPS) {
    headers.delete("strict-transport-security");
    const csp = headers.get("content-security-policy");
    headers.set("content-security-policy", csp.split("; ").filter((d) => d !== "upgrade-insecure-requests").join("; "));
  }
  return headers;
}

const EXPECTED = documentedHeaders();
const NONCE = /'nonce-([A-Za-z0-9+/=]+)'/;
/** Every page's nonce, so one used twice is caught: a nonce an attacker can predict is no nonce. */
const nonces = new Set();

/** Every response from this origin carries every header, and the policy is the documented one. */
function checkHeaders(response) {
  const url = response.url();
  if (!url.startsWith(`${ORIGIN}/`)) return;
  const got = response.headers();
  for (const [name, value] of EXPECTED) {
    const actual = got[name];
    if (actual === undefined) {
      problem(`${response.status()} ${url} has no ${name}`);
      continue;
    }
    if (name === "content-security-policy") {
      const nonce = NONCE.exec(actual);
      if (!nonce) {
        problem(`${url}: the policy carries no nonce: ${actual}`);
        continue;
      }
      if (actual.replace(nonce[0], "'nonce-{nonce}'") !== value) problem(`${url}: the policy is not the documented one:\n     ${actual}\n     ${value}`);
      // A page's own response; the files fetched with page.request have no browser request.
      if (typeof response.request === "function" && response.request().resourceType() === "document") {
        if (nonces.has(nonce[1])) problem(`${url}: the nonce ${nonce[1]} was used for an earlier page too`);
        nonces.add(nonce[1]);
      }
    } else if (actual !== value) {
      problem(`${url}: ${name} is "${actual}", the README says "${value}"`);
    }
  }
  if (!HTTPS && got["strict-transport-security"] !== undefined) problem(`${url}: HSTS was announced over plain http`);
}

/**
 * Caching, as the framework was measured to send it and the README says: every page and API
 * response is somebody's own and is never stored, and the content-hashed build assets never
 * change in place. (`public/` files are checked with the other files a deployment serves.)
 */
function checkCache(response) {
  const url = new URL(response.url());
  if (url.origin !== ORIGIN) return;
  const got = response.headers()["cache-control"] ?? "(none)";
  if (url.pathname.startsWith("/_next/static/")) {
    if (response.status() === 200 && got !== "public, max-age=31536000, immutable") problem(`${url.pathname}: a hashed build asset is cached as "${got}"`);
  } else if (url.pathname.startsWith("/api/") || response.request().resourceType() === "document") {
    if (!/\bno-store\b/.test(got)) problem(`${url.pathname}: a page or API response is cached as "${got}"`);
  }
}

function watch(page, label) {
  page.on("pageerror", (err) => problem(`${label}: uncaught ${err.name}: ${err.message}`));
  page.on("console", (msg) => {
    // Chromium reports the status of a page it was sent to on purpose: that one is expected.
    if (msg.text().includes("status of 404") && msg.location().url === `${ORIGIN}/no-such-page`) return;
    if (msg.type() === "error" || /Content Security Policy|Permissions-Policy|Refused to/i.test(msg.text())) {
      problem(`${label}: console ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("request", (req) => {
    const url = req.url();
    if (/^(https?|wss?):/.test(url) && new URL(url).origin !== ORIGIN) problem(`${label}: a request left the site: ${req.method()} ${url}`);
  });
  page.on("response", (res) => {
    checkHeaders(res);
    checkCache(res);
  });
}

/** `securitypolicyviolation` events reach Node through this binding, from every page. */
async function reportViolations(context, label) {
  await context.exposeBinding("__cspViolation", (_source, v) =>
    problem(`${label}: CSP violation: ${v.directive} blocked ${v.blocked || "(inline)"} on ${v.document}${v.sample ? ` (${v.sample})` : ""}`),
  );
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, document: e.documentURI, sample: e.sample });
    });
  });
}

/** The current time of day in UTC, the zone the walk's browser (and so its account) is in. */
function nowInUtc() {
  return new Date().toISOString().slice(11, 16);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ timezoneId: "UTC", baseURL: BASE });
  context.setDefaultTimeout(15_000);
  await reportViolations(context, "app");
  const page = await context.newPage();
  watch(page, "app");

  step("the landing page loads under the policy");
  const landing = await page.goto("/");
  if (landing?.status() !== 200) fail(`/ answered ${landing?.status()}`);
  await page.getByRole("heading", { level: 1 }).waitFor();

  step("every feature the Permissions-Policy names is one Chromium knows, and only autoplay is left on");
  const features = await page.evaluate(() => ({ known: document.featurePolicy.features(), allowed: document.featurePolicy.allowedFeatures() }));
  for (const entry of EXPECTED.get("permissions-policy").split(", ")) {
    const [feature, allowlist] = entry.split("=");
    if (!features.known.includes(feature)) problem(`Permissions-Policy names ${feature}, which Chromium does not recognise`);
    else if (features.allowed.includes(feature) !== (allowlist !== "()")) problem(`Permissions-Policy says ${entry}, but the page has ${feature} ${features.allowed.includes(feature) ? "on" : "off"}`);
  }

  step("sign up through the form");
  const email = `walk-${Date.now()}@example.com`;
  await page.getByLabel("Display name").fill("Browser Walk");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("walk-password-123");
  await page.getByRole("button", { name: "Start my Daily Scroll" }).click();
  await page.waitForURL("**/connect");

  step("connect two platforms in demo mode");
  for (const name of ["YouTube", "Reddit"]) {
    const card = page.locator(".card").filter({ has: page.getByRole("img", { name, exact: true }) });
    await card.getByRole("button", { name: /try demo/i }).click();
    await card.getByRole("button", { name: "Disconnect" }).waitFor();
  }

  step("open the hour from Settings");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.waitForURL("**/settings");
  await page.getByLabel("Daily scroll opens at").fill(nowInUtc());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved.").waitFor();

  step("scroll the feed, ask why a clip was chosen, and save it");
  await page.getByRole("link", { name: "Scroll", exact: true }).click();
  await page.waitForURL("**/feed");
  const first = page.locator("article.slide").first();
  await first.waitFor();
  const slides = await page.locator("article.slide").count();
  if (slides < 2) fail(`the open feed showed ${slides} clips`);
  await first.getByRole("button", { name: "Why this?" }).click();
  // The bar's width is a `style` attribute the server wrote; a policy without style-src-attr
  // would leave it at zero.
  const bar = first.locator(".why-bar b").first();
  await bar.waitFor();
  const width = await bar.evaluate((el) => el.getBoundingClientRect().width);
  if (!(width > 0)) fail("the reason bar has no width: the policy refused its style attribute");
  await first.getByRole("button", { name: "Save", exact: true }).click();
  await first.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.keyboard.press("ArrowDown");

  step("file the clip in a new collection in the archive");
  await page.goto("/saved");
  await page.getByLabel("New collection name").fill("Walked");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /^Walked · / }).waitFor();

  step("change the theme and accent, and register the notification worker");
  await page.goto("/settings");
  // Each choice is saved before the next is taken, so wait for one to land before the other.
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByRole("button", { name: "Sky" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.accent === "sky");
  // Notifications need a push service the walk cannot reach, so the worker is registered the
  // way NotificationSetting registers it, which is what worker-src governs.
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.register("/sw.js")).scope);
  if (scope !== `${ORIGIN}/`) fail(`the service worker registered at ${scope}`);
  const display = await page.evaluate(() => getComputedStyle(document.querySelector("h1, h2")).fontFamily);
  if (!/Sora/i.test(display)) fail(`the display face did not load: ${display}`);

  step("a page that started shows no note, even once the guard's grace period has passed");
  await page.reload();
  await page.waitForTimeout(5_000);
  if (await page.locator(".boot-note").count()) fail("the safety net's note is up on a page that started");

  step("sign out");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${ORIGIN}/`);

  step("a page that does not exist is the app's own not-found page, under the same headers");
  const missing = await page.goto("/no-such-page");
  if (missing?.status() !== 404) fail(`/no-such-page answered ${missing?.status()}`);
  await page.getByRole("heading", { name: "That page isn't here" }).waitFor();

  step("the files a deployment serves beside the pages");
  for (const [path, type] of [
    ["/robots.txt", "text/plain"],
    ["/.well-known/security.txt", "text/plain"],
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/sw.js", "application/javascript"],
    ["/guard.js", "application/javascript"],
  ]) {
    const res = await page.request.get(path);
    if (res.status() !== 200) fail(`${path} answered ${res.status()}`);
    if (!(res.headers()["content-type"] ?? "").startsWith(type)) fail(`${path} is ${res.headers()["content-type"]}, not ${type}`);
    // No version in the name, so revalidated on every use.
    if (!/\bmax-age=0\b/.test(res.headers()["cache-control"] ?? "")) fail(`${path} is cached as "${res.headers()["cache-control"]}"`);
    checkHeaders(res);
  }
  await context.close();

  step("without JavaScript the page says so, and the browser never sends a form itself");
  // Scripting off in Blink itself, so <noscript> renders as it does for a visitor; turning it off
  // from DevTools (javaScriptEnabled: false) still parses <noscript> as if scripts ran.
  const scriptless = await chromium.launch({ args: ["--blink-settings=scriptEnabled=false"] });
  try {
    const nojs = await scriptless.newPage({ baseURL: BASE });
    const refused = [];
    nojs.on("console", (msg) => {
      if (/form-action/.test(msg.text())) refused.push(msg.text());
    });
    const documents = [];
    nojs.on("request", (req) => {
      if (req.resourceType() === "document") documents.push(req.url());
    });
    await nojs.goto("/");
    if (!(await nojs.locator(".noscript-note").isVisible())) fail("a browser without JavaScript is not told the app needs it");
    // Every form is sent by its script, so `form-action 'none'`: pressed with no script to send
    // it, the form is refused rather than reloading the page and losing what was typed.
    // Every field filled, so the form's own validation lets it through to the policy.
    await nojs.getByLabel("Display name").fill("Someone");
    await nojs.getByLabel("Email").fill("someone@example.com");
    await nojs.getByLabel("Password").fill("typed-before-any-script");
    // The browser is expected to refuse the navigation, so there is none to wait for.
    await nojs.getByRole("button", { name: "Start my Daily Scroll" }).click({ noWaitAfter: true });
    await nojs.waitForTimeout(1_000);
    if (documents.length !== 1) fail(`the browser sent the form itself: ${documents.slice(1).join(", ")}`);
    if (!refused.length) fail("the browser reported no form-action refusal, so nothing was tested");
    if ((await nojs.getByLabel("Email").inputValue()) !== "someone@example.com") fail("what was typed did not survive the refused form");
  } finally {
    await scriptless.close();
  }

  step("a page whose scripts fail or throw while starting says so instead of showing dead buttons");
  const chunk = (url) => url.pathname.startsWith("/_next/static/chunks/") && url.pathname.endsWith(".js");
  const later = (ms, then) => async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await then(route);
  };
  const abort = (route) => route.abort();
  const throwing = (route) => route.fulfill({ contentType: "text/javascript", body: 'throw new Error("a script that fails while the app starts");' });
  for (const [how, routes, promptly] of [
    // After the guard is listening: the note is up by the time the page has loaded.
    ["fail to arrive", [[chunk, later(1_000, abort)]], true],
    ["throw", [[chunk, later(1_000, throwing)]], true],
    // Before it is listening (the framework's scripts are async and come first): the check after
    // `load` is what catches it, so the note follows within the guard's grace period.
    ["fail before the guard has arrived", [[chunk, abort], [(url) => url.pathname === "/guard.js", later(1_500, (route) => route.continue())]], false],
  ]) {
    const broken = await browser.newContext({ baseURL: BASE });
    const stranded = await broken.newPage();
    for (const [match, answer] of routes) await stranded.route(match, answer);
    await stranded.goto("/");
    const note = stranded.getByRole("alert").filter({ hasText: "didn't finish loading" });
    if (promptly) {
      if (!(await note.count())) fail(`a page whose scripts ${how} had no note once it had loaded`);
    } else {
      await note.waitFor({ timeout: 15_000 }).catch(() => fail(`a page whose scripts ${how} showed no note`));
    }
    await broken.close();
  }
} finally {
  await browser.close();
}

if (problems.length) fail(`${problems.length} problem(s), listed above`);
console.log("BROWSER WALK PASS");
