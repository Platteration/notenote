#!/usr/bin/env node
/**
 * The third part of `npm run test:e2e`: sign in with Google and the shop, in Chromium, against a
 * built server that has both turned on and is run with a fake Google and a fake Stripe in its own
 * process (`scripts/e2e-upstreams.mjs`; scripts/e2e.sh starts it). Google's consent page and
 * Stripe's Checkout page, which a visitor reaches by navigation, are stood in for here with
 * `page.route`, and Stripe's signed webhook is posted from here as Stripe would post it.
 *
 * It walks: the controls hidden when `/api/config` answers 404, and drawn when it says they are
 * on; sign-up with Google (a new account keyed by Google's `sub`, with no password); Support this
 * app (one press of Buy at a time, Checkout, back before the webhook, the webhook, the thank-you,
 * the badge); a replayed webhook; sign out; a password account linking Google from Settings and
 * then signing in with it; a Google account whose address belongs to an account here that never
 * linked it, which signs in to nothing; a callback nobody started; and deleting the Google
 * account's account.
 *
 * Throughout it fails, as scripts/browser-walk.mjs does, on any Content-Security-Policy
 * violation, uncaught exception or console error, any response from the site without the
 * README's headers, and any request that leaves the site other than the navigations to Google's
 * consent page and Stripe's Checkout, which it counts.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { ENV, consentCode, stripeSignature } from "./e2e-fakes.mjs";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;

function step(text) {
  console.log(`-> ${text}`);
}
const problems = [];
function problem(text) {
  problems.push(text);
  console.error(`   PROBLEM: ${text}`);
}
function fail(text) {
  console.error(`INTEGRATIONS WALK FAIL: ${text}`);
  process.exit(1);
}

/** The README's headers block, for plain http (no HSTS, no upgrade), as browser-walk.mjs reads it. */
function documentedHeaders() {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = /<!-- headers:begin -->\s*```text\n([\s\S]*?)```\s*<!-- headers:end -->/.exec(readme);
  if (!block) fail("README.md has no headers block");
  const headers = new Map();
  for (const line of block[1].split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(": ");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 2));
  }
  headers.delete("strict-transport-security");
  headers.set("content-security-policy", headers.get("content-security-policy").split("; ").filter((d) => d !== "upgrade-insecure-requests").join("; "));
  return headers;
}
const EXPECTED = documentedHeaders();

function checkHeaders(response, skip = () => false) {
  const url = response.url();
  if (!url.startsWith(`${ORIGIN}/`) || skip(new URL(url))) return;
  const got = response.headers();
  for (const [name, value] of EXPECTED) {
    const actual = got[name];
    if (actual === undefined) problem(`${response.status()} ${url} has no ${name}`);
    else if (name === "content-security-policy") {
      if (actual.replace(/'nonce-[A-Za-z0-9+/=]+'/, "'nonce-{nonce}'") !== value) problem(`${url}: the policy is not the documented one: ${actual}`);
    } else if (actual !== value) problem(`${url}: ${name} is "${actual}", the README says "${value}"`);
  }
  const path = new URL(url).pathname;
  if ((path.startsWith("/api/") || response.request().resourceType() === "document") && !/\bno-store\b/.test(got["cache-control"] ?? "")) {
    problem(`${path}: a page or API response is cached as "${got["cache-control"]}"`);
  }
}

/** The navigations that leave the site on purpose, in order, as "google" and "stripe". */
const outside = [];

/** `stubbed` names the addresses this walk answers itself, whose headers are its own. */
function watch(page, label, { expect404 = false, stubbed = () => false } = {}) {
  page.on("pageerror", (err) => problem(`${label}: uncaught ${err.name}: ${err.message}`));
  page.on("console", (msg) => {
    if (expect404 && msg.text().includes("status of 404")) return;
    if (msg.type() === "error" || /Content Security Policy|Permissions-Policy|Refused to/i.test(msg.text())) problem(`${label}: console ${msg.type()}: ${msg.text()}`);
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!/^(https?|wss?):$/.test(url.protocol) || url.origin === ORIGIN) return;
    const allowed =
      req.isNavigationRequest() && ((url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth") || (url.origin === "https://checkout.stripe.com" && url.pathname.startsWith("/c/pay/")));
    if (!allowed) problem(`${label}: a request left the site: ${req.method()} ${req.url()}`);
  });
  page.on("response", (res) => checkHeaders(res, stubbed));
}

async function reportViolations(context, label) {
  await context.exposeBinding("__cspViolation", (_source, v) => problem(`${label}: CSP violation: ${v.directive} blocked ${v.blocked || "(inline)"} on ${v.document}`));
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, document: e.documentURI });
    });
  });
}

/**
 * Google, as far as a browser sees it. The consent page answers at once for whoever `who()` says
 * is signed in at Google, sending the browser back to the redirect URI with a code the fake token
 * endpoint will exchange; the request it answers is checked first. Playwright does not route a
 * request a redirect makes (measured: Chromium went to the real accounts.google.com), so the
 * site's own 302 from the start of a sign-in is handed to the browser as a Refresh to the same
 * address, its sign-in cookie included, and that navigation is routed.
 */
async function standInForGoogle(context, who) {
  await context.route((url) => url.origin === ORIGIN && url.pathname === "/api/auth/google/start", async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const location = res.headers().location ?? "";
    if (res.status() !== 302 || !location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")) fail(`the sign-in start answered ${res.status()} ${location}`);
    const headers = { ...res.headers(), refresh: `0;url=${location}` };
    delete headers.location;
    await route.fulfill({ status: 200, headers, body: "" });
  });
  await context.route("https://accounts.google.com/**", async (route) => {
    outside.push("google");
    const url = new URL(route.request().url());
    const p = url.searchParams;
    const expected = {
      response_type: "code",
      client_id: ENV.GOOGLE_SIGNIN_CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/auth/google/callback`,
      scope: "openid email",
      code_challenge_method: "S256",
    };
    for (const [name, value] of Object.entries(expected)) if (p.get(name) !== value) fail(`Google was asked ${name}=${p.get(name)}, not ${value}`);
    const code = consentCode({ ...who(), nonce: p.get("nonce"), challenge: p.get("code_challenge") });
    await route.fulfill({ status: 302, headers: { location: `${p.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(p.get("state"))}` } });
  });
}

/**
 * Stripe's Checkout page: the browser is sent there only with the address the site had Stripe
 * make, and comes straight back to the success address, before the webhook has said anything.
 * What Stripe recorded for the session (the fake writes it into the address) is kept for the
 * webhook the walk then posts.
 */
const checkouts = [];
async function standInForStripe(context) {
  await context.route("https://checkout.stripe.com/**", async (route) => {
    outside.push("stripe");
    const url = new URL(route.request().url());
    const session = JSON.parse(Buffer.from(url.searchParams.get("e2e") ?? "", "base64url").toString("utf8"));
    checkouts.push(session);
    await route.fulfill({ status: 302, headers: { location: session.success_url } });
  });
}

/**
 * Answer the next request to `path` from here, as a server gone wrong might: the page must not
 * follow an address that is not the one it expects. The headers are the documented ones, since
 * every response from the site is held to them.
 */
async function stubOnce(page, path, body) {
  const headers = Object.fromEntries([...EXPECTED].map(([name, value]) => [name, value.replace("'nonce-{nonce}'", "'nonce-stubbed'")]));
  await page.route((url) => url.pathname === path, (route) => route.fulfill({ status: 200, headers: { ...headers, "cache-control": "no-store", "content-type": "application/json" }, body: JSON.stringify(body) }), { times: 1 });
}

/** Stripe's signed webhook, posted to the site's own address as Stripe posts it. */
async function postWebhook(event) {
  const body = JSON.stringify(event);
  const res = await fetch(`${ORIGIN}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": stripeSignature(body) }, body });
  return { status: res.status, body: await res.json() };
}

const browser = await chromium.launch();
try {
  step("the account and shop controls are not drawn when /api/config answers 404");
  {
    const context = await browser.newContext({ baseURL: BASE, timezoneId: "UTC" });
    await reportViolations(context, "404");
    const page = await context.newPage();
    watch(page, "404", { expect404: true, stubbed: (url) => url.pathname === "/api/config" });
    await page.route((url) => url.pathname === "/api/config", (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Not found"}' }));
    const asked = page.waitForResponse((r) => r.url() === `${ORIGIN}/api/config`);
    await page.goto("/");
    await asked;
    await page.getByRole("button", { name: "Start my Daily Scroll" }).waitFor();
    await page.waitForTimeout(500);
    if (await page.getByRole("link", { name: "Sign in with Google" }).count()) fail("Sign in with Google was drawn with /api/config answering 404");
    await context.close();
  }

  const context = await browser.newContext({ baseURL: BASE, timezoneId: "Europe/Paris" });
  context.setDefaultTimeout(15_000);
  await reportViolations(context, "app");
  let googleUser = { sub: "e2e-sub-1001", email: "walk.google@example.com" };
  await standInForGoogle(context, () => googleUser);
  await standInForStripe(context);
  const page = await context.newPage();
  watch(page, "app");

  step("the configured server says so in /api/config, and the landing page draws Sign in with Google");
  const config = await (await page.request.get("/api/config")).json();
  if (!config.auth?.google || config.shop?.products?.[0]?.id !== "supporter" || config.shop.products[0].price?.unit_amount !== 300) {
    fail(`/api/config said ${JSON.stringify(config)}`);
  }
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Google" }).click();

  step("signing in with a new Google account makes an account with no password, and lands on Connections");
  await page.waitForURL(`${ORIGIN}/connect`);
  await page.locator(".nav-account", { hasText: googleUser.email }).waitFor();
  const meFirst = await (await page.request.get("/api/auth/me")).json();
  if (meFirst.user?.email !== googleUser.email || meFirst.entitlements?.length !== 0) fail(`/api/auth/me said ${JSON.stringify(meFirst)}`);
  const googleUserId = meFirst.user.id;
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.waitForURL("**/settings");
  await page.getByText(`Linked to the Google account ${googleUser.email}. You can sign in with it.`).waitFor();
  await page.getByText("This account signs in with Google. It has no password.").waitFor();
  if (await page.getByRole("button", { name: "Change password" }).count()) fail("an account with no password was offered Change password");
  const zone = await (await page.request.get("/api/settings")).json();
  if (zone.settings?.timezone !== "Europe/Paris") fail(`the account was made in ${zone.settings?.timezone}, not the browser's Europe/Paris`);

  step("Buy goes nowhere but Stripe's Checkout, whatever /api/checkout answers");
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Support this app" }) });
  const buy = card.getByRole("button", { name: /^Buy · €3\.00$/ });
  await stubOnce(page, "/api/checkout", { url: "https://checkout.stripe.com.evil.example/c/pay/cs_test_x" });
  await buy.click();
  await card.getByText("Checkout didn't start. Try again.").waitFor();
  if (new URL(page.url()).pathname !== "/settings" || outside.includes("stripe")) fail("Buy followed an address that is not Stripe's Checkout");

  step("Support this app: one Buy at a time, Checkout, back before the webhook, then the webhook, the thank-you and the badge");
  // The press is held at the site until the button has been seen disabled and pressed again: a
  // second press while the first is out must ask for no second Checkout (the kit's README, "For
  // the page"), since every press here makes a Checkout Session of its own.
  const presses = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/checkout") presses.push(request.method());
  });
  let release = () => {};
  const released = new Promise((resolve) => (release = resolve));
  await page.route((url) => url.pathname === "/api/checkout", async (route) => {
    await released;
    await route.continue();
  }, { times: 1 });
  await buy.click();
  const opening = card.getByRole("button", { name: "Opening Checkout…" });
  await opening.waitFor();
  if (!(await opening.isDisabled())) fail("Buy was not disabled while its press was out");
  await opening.click({ force: true });
  release();
  await page.waitForURL(`${ORIGIN}/settings`);
  await card.getByText("Confirming your payment with Stripe…").waitFor();
  if (presses.length !== 1 || checkouts.length !== 1) fail(`two presses of Buy asked /api/checkout ${presses.length} times and made ${checkouts.length} Checkout Sessions`);
  const [session] = checkouts;
  if (!session || session.metadata.app !== "notenote" || session.metadata.user !== googleUserId || session.client_reference_id !== googleUserId || session.metadata.product !== "supporter") {
    fail(`the Checkout Session was made with ${JSON.stringify(session)}`);
  }
  if (session.success_url !== `${ORIGIN}/settings?purchase=success` || session.cancel_url !== `${ORIGIN}/settings?purchase=cancelled`) fail(`Checkout returns to ${session.success_url}`);
  const event = {
    id: "evt_e2eWalkPaid1",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: session.id, object: "checkout.session", mode: "payment", payment_status: "paid", client_reference_id: session.client_reference_id, metadata: session.metadata, customer: "cus_e2e_1", payment_intent: "pi_e2e_1" } },
  };
  const delivered = await postWebhook(event);
  if (delivered.status !== 200) fail(`the webhook answered ${delivered.status} ${JSON.stringify(delivered.body)}`);
  await card.getByText("Thank you — Support this app is unlocked.").waitFor();
  await card.getByText("Owned").waitFor();
  await page.locator(".nav-badge", { hasText: "Supporter" }).waitFor();
  if (new URL(page.url()).search) fail(`the address kept ${page.url()}`);

  step("a replayed webhook changes nothing, and an unsigned one is refused");
  if ((await postWebhook(event)).status !== 200) fail("a replayed event was not acknowledged");
  const unsigned = await fetch(`${ORIGIN}/api/webhooks/stripe`, { method: "POST", body: JSON.stringify(event) });
  if (unsigned.status !== 400) fail(`an unsigned webhook answered ${unsigned.status}`);
  const meNow = await (await page.request.get("/api/auth/me")).json();
  if (JSON.stringify(meNow.entitlements) !== '["supporter"]') fail(`entitlements are ${JSON.stringify(meNow.entitlements)}`);
  if (await card.getByRole("button", { name: /^Buy/ }).count()) fail("Buy is still offered to a supporter");

  step("sign out");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${ORIGIN}/`);

  step("a password account links Google from Settings, and then signs in with it");
  const passwordEmail = `walk-link-${Date.now()}@example.com`;
  await page.getByLabel("Display name").fill("Linker");
  await page.getByLabel("Email").fill(passwordEmail);
  await page.getByLabel("Password").fill("walk-password-123");
  await page.getByRole("button", { name: "Start my Daily Scroll" }).click();
  await page.waitForURL("**/connect");
  await page.goto("/settings");
  googleUser = { sub: "e2e-sub-2002", email: "walk.linker.at.google@example.com" };
  // Link Google goes nowhere but Google's consent page, whatever the server answers.
  await stubOnce(page, "/api/account/google", { url: "https://accounts.google.com.evil.example/o/oauth2/v2/auth" });
  await page.getByRole("button", { name: "Link Google" }).click();
  await page.getByText("Linking Google didn't start. Try again.").waitFor();
  if (new URL(page.url()).pathname !== "/settings") fail("Link Google followed an address that is not Google's");
  await page.getByRole("button", { name: "Link Google" }).click();
  await page.waitForURL(`${ORIGIN}/settings`);
  await page.getByText("Google is linked. You can sign in with it as well as your password.").waitFor();
  await page.getByText(`Linked to the Google account ${googleUser.email}. You can sign in with it.`).waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL(`${ORIGIN}/feed`);
  await page.locator(".nav-account", { hasText: passwordEmail }).waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${ORIGIN}/`);

  step("a Google account whose address an unlinked account here holds signs in to nothing");
  const typedEmail = `walk-typed-${Date.now()}@example.com`;
  const typed = await page.request.post("/api/auth/signup", {
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    data: { email: typedEmail, displayName: "Typed", password: "walk-password-123" },
  });
  if (typed.status() !== 201) fail(`the password account could not be made: ${typed.status()}`);
  await page.request.post("/api/auth/logout", { headers: { Origin: ORIGIN } });
  googleUser = { sub: "e2e-sub-3003", email: typedEmail };
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await page.getByText("An account here already uses that Google account's email address.", { exact: false }).waitFor();
  if ((await (await page.request.get("/api/auth/me")).json()).user !== null) fail("a Google account was signed in to an account by its address");
  await page.reload();
  if (await page.getByText("An account here already uses", { exact: false }).count()) fail("the notice came back on a reload");

  step("a callback nobody started is refused, once, and the address is put back");
  await page.goto("/api/auth/google/callback?code=forged&state=forged");
  await page.waitForURL(`${ORIGIN}/`);
  await page.getByText("Sign-in didn't complete.").waitFor();
  if (new URL(page.url()).search) fail(`the address kept ${page.url()}`);

  step("the Google account's account is deleted, its badge with it, from Settings");
  googleUser = { sub: "e2e-sub-1001", email: "walk.google@example.com" };
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL(`${ORIGIN}/feed`);
  await page.locator(".nav-badge", { hasText: "Supporter" }).waitFor();
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByText("Your supporter badge goes with it; the payment itself stays with Stripe.", { exact: false }).waitFor();
  await page.getByLabel("Confirm email").fill(googleUser.email);
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await page.waitForURL(`${ORIGIN}/`);
  if ((await (await page.request.get("/api/auth/me")).json()).user !== null) fail("still signed in after deleting the account");

  step("signing in with that Google account again makes a new account, holding nothing");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.waitForURL(`${ORIGIN}/connect`);
  const fresh = await (await page.request.get("/api/auth/me")).json();
  if (fresh.user?.id === googleUserId || fresh.entitlements?.length !== 0) fail(`after deletion the Google account found ${JSON.stringify(fresh)}`);
  if (await page.locator(".nav-badge").count()) fail("the badge outlived its account");

  const expectedOutside = ["google", "stripe", "google", "google", "google", "google", "google"];
  if (JSON.stringify(outside) !== JSON.stringify(expectedOutside)) fail(`the walk left the site for ${JSON.stringify(outside)}, not ${JSON.stringify(expectedOutside)}`);
  await context.close();
} finally {
  await browser.close();
}

if (problems.length) fail(`${problems.length} problem(s), listed above`);
console.log("INTEGRATIONS WALK PASS");
