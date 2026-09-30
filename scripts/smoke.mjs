import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.BASE ?? "http://localhost:3000";
const email = `smoke-${randomUUID()}@example.com`;
const password = "smoke-password-123";
function client() {
  let cookie = "";
  return async (path, method = "GET", body, expected = 200) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(35_000),
      redirect: "manual",
    });
    const setCookie = res.headers.getSetCookie().find((value) => value.startsWith("ds_session="));
    if (setCookie) cookie = setCookie.split(";")[0];
    const value = await res.json();
    assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
}
const api = client();
const otherDevice = client();
const hhmm = (time) => new Date(time).toISOString().slice(11, 16);
let created = false;
try {
  await api("/api/feed", "GET", undefined, 401);
  await api("/api/auth/signup", "POST", { email, displayName: "Smoke test", password, timezone: "UTC" }, 201);
  created = true;
  // Set an explicitly closed window, so this test also works at the default opening time.
  await api("/api/settings", "PUT", { windowStart: hhmm(Date.now() - 2 * 3_600_000), timezone: "UTC" });
  await api("/api/feed", "GET", undefined, 423);
  console.log("PASS: private feed and locked window");

  await api("/api/settings", "PUT", { windowStart: hhmm(Date.now()), feedSize: 20 });
  assert.equal((await api("/api/feed")).items.length, 0);
  for (const provider of ["youtube", "reddit"]) await api(`/api/connect/${provider}`, "POST");
  const [feed, concurrent] = await Promise.all([api("/api/feed"), api("/api/feed")]);
  assert.equal(feed.status, "open");
  assert.ok(feed.items.length > 0);
  assert.equal(new Set(feed.items.map((item) => item.provider)).size, 2);
  assert.ok(feed.items.every((item) => item.durationSeconds <= 90 && item.demo));
  assert.deepEqual(feed.items, concurrent.items);
  console.log(`PASS: empty-feed recovery, ${feed.items.length} balanced demo clips, stable concurrent requests`);

  const item = feed.items[0];
  await api("/api/feed/seen", "POST", { keys: [item.key, "youtube:invented"] });
  assert.ok((await api("/api/feed")).seenKeys.includes(item.key));
  await api("/api/saved", "POST", { key: item.key });
  assert.equal((await api("/api/saved")).saved.length, 1);
  await api("/api/saved", "POST", { key: "youtube:not-mine" }, 400);
  await api("/api/muted", "POST", { provider: item.provider, creatorHandle: item.creatorHandle });
  assert.ok((await api("/api/feed")).mutedCreators.includes(`${item.provider}:${item.creatorHandle.toLowerCase()}`));
  await api(`/api/muted?provider=${item.provider}&creatorHandle=${encodeURIComponent(item.creatorHandle)}`, "DELETE");
  assert.equal((await api("/api/muted")).muted.length, 0);
  console.log("PASS: watch history, save validation, mute persistence, unmute");

  await api("/api/settings", "PUT", { prefs: { theme: "wire", reduceMotion: true } });
  assert.equal((await api("/api/settings")).settings.prefs.theme, "wire");
  await api("/api/settings", "PUT", { windowStart: "99:99" }, 400);
  await api("/api/settings", "PUT", { windowStart: hhmm(Date.now() - 2 * 3_600_000) });
  await api("/api/feed", "GET", undefined, 423);
  assert.equal((await api("/api/saved")).saved.length, 1);
  const exported = await api("/api/account/export");
  assert.equal(exported.account.email, email);
  assert.equal(exported.scrollVisits.length, 1);
  assert.ok(!JSON.stringify(exported).includes("password_hash"));
  await api(`/api/saved?key=${encodeURIComponent(item.key)}`, "DELETE");
  assert.equal((await api("/api/saved")).saved.length, 0);
  console.log("PASS: settings, closed-hour shelf, data export, unsave");

  await otherDevice("/api/auth/login", "POST", { email, password });
  assert.equal((await api("/api/account/sessions")).sessions, 2);
  await api("/api/account/password", "POST", { currentPassword: password, newPassword: "changed-password-123" });
  await otherDevice("/api/feed", "GET", undefined, 401);
  assert.equal((await api("/api/account/sessions")).sessions, 1);
  await api("/api/auth/logout", "POST");
  await api("/api/auth/login", "POST", { email, password: "changed-password-123" });
  await api("/api/connect/youtube", "DELETE");
  assert.equal((await api("/api/connections")).connections.find((c) => c.provider === "youtube").connected, false);
  console.log("PASS: password change, session revocation, logout/login, disconnect");

  const attacker = client();
  let throttled = false;
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `unknown-${email}`, password: "wrong" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) { throttled = true; break; }
  }
  assert.ok(throttled);
  await attacker("/api/feed", "GET", undefined, 401);
  console.log("PASS: sign-in throttling");
} finally {
  if (created) {
    await api("/api/account", "DELETE", { confirm: email });
    await api("/api/feed", "GET", undefined, 401);
    console.log("PASS: test account deleted; session invalidated");
  }
}
console.log("SMOKE PASS");
