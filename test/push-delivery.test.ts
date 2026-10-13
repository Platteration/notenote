import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * Push delivery against real sockets: web-push builds and encrypts the request for real, and it
 * goes out through the real `publicRequest` to a stand-in endpoint on loopback.
 *
 * The stand-ins speak plain HTTP, because a test run has no certificate a client would trust; the
 * rows are written straight into the table, past the https-only check at registration, which is
 * the only thing that differs. The deadline, the unread reply and the pinned lookup are the same
 * code over either scheme. Loopback needs the operator's private-host opt-in, except in the
 * rebinding case, where the guard being on is the point.
 *
 * The resolver is stubbed so a name can answer publicly to one query and privately to the next.
 * The stand-ins' addresses are literals, which never reach it.
 */
const lookup = vi.hoisted(() =>
  vi.fn(async (_host: string, _options?: unknown) => [{ address: "127.0.0.1", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));

process.env.DATABASE_FILE = ":memory:";
process.env.SESSION_SECRET = "test-secret-for-push-delivery-tests";
const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const { signUp } = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const push = await import("@/lib/push");
const { PUSH_DEADLINE_MS } = push;

let userId: string;
beforeAll(async () => {
  userId = (await signUp({ email: "delivery@example.com", displayName: "D", password: "password123" })).id;
});

/** A browser's subscription keys, real enough for web-push to encrypt to. */
function device(endpoint: string) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  return { endpoint, keys };
}

const servers: Array<http.Server | net.Server> = [];
async function listen<S extends http.Server | net.Server>(server: S): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** What a run returned, or that it was still running when the time was up. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | "still running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still running">((resolve) => { timer = setTimeout(() => resolve("still running"), ms); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const row = () => push.subscriptionsFor(userId)[0];

beforeEach(() => {
  getDb().prepare("DELETE FROM push_subscriptions").run();
  lookup.mockClear();
  process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
});

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
  for (const server of servers.splice(0)) {
    if (server instanceof http.Server) server.closeAllConnections();
    server.close();
  }
});

describe("a delivery", () => {
  it("sends what web-push built: the encrypted payload and its VAPID headers, once", async () => {
    const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; bytes: number }> = [];
    const port = await listen(http.createServer((req, res) => {
      let bytes = 0;
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, bytes });
        res.writeHead(201);
        res.end();
      });
    }));
    push.saveSubscription(userId, device(`http://127.0.0.1:${port}/wpush/v2/abc`));

    expect(await push.notifyHourOpen(userId, "2026-10-13", 60)).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/wpush/v2/abc");
    expect(request?.headers.ttl).toBe("3000");
    expect(request?.headers["content-encoding"]).toBe("aes128gcm");
    expect(request?.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(Number(request?.headers["content-length"])).toBe(request?.bytes);
    expect(request?.bytes).toBeGreaterThan(0);
    expect(row()?.last_open_day).toBe("2026-10-13");
  });

  it("deletes a device the push service says is gone, and keeps one it failed", async () => {
    let status = 410;
    const port = await listen(http.createServer((req, res) => { req.resume(); res.writeHead(status); res.end(); }));
    push.saveSubscription(userId, device(`http://127.0.0.1:${port}/gone`));
    expect(await push.notifyHourOpen(userId, "2026-10-13", 60)).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(row()).toBeUndefined();

    status = 502;
    push.saveSubscription(userId, device(`http://127.0.0.1:${port}/flaky`));
    expect(await push.notifyHourOpen(userId, "2026-10-13", 60)).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(row()?.last_open_day).toBeNull();
  });
});

/**
 * The endpoint is a URL an account registered, so the reply is whatever that account's server
 * chooses to send. web-push read all of it into a string, and its timeout was the socket's idle
 * timeout, which a server that keeps sending never trips.
 */
describe("an endpoint that will not stop answering", () => {
  it("is not read: a reply that streams without end is closed once its status has arrived", async () => {
    let written = 0;
    let closedAt = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const port = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(201, { "content-type": "text/plain" });
      const pump = setInterval(() => { res.write(chunk); written += chunk.length; }, 5);
      res.on("close", () => { clearInterval(pump); closedAt = Date.now(); });
    }));
    push.saveSubscription(userId, device(`http://127.0.0.1:${port}/flood`));

    const started = Date.now();
    const outcome = await within(PUSH_DEADLINE_MS + 2_000, push.notifyHourOpen(userId, "2026-10-13", 60));
    // A 201 is a delivery, whatever follows it.
    expect(outcome).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(Date.now() - started).toBeLessThan(PUSH_DEADLINE_MS);
    await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0));
    // The connection was closed rather than drained: well under a second of the stream got out.
    expect(written).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);

  it("is cut off at the deadline when it sends a byte at a time, however short the gaps", async () => {
    // Under the ten seconds the socket would wait idle, so only a deadline ends this.
    const DRIP_MS = 2_000;
    const port = await listen(net.createServer((socket) => {
      socket.on("data", () => {});
      socket.on("error", () => {});
      const reply = "HTTP/1.1 201 Created\r\n\r\n";
      let sent = 0;
      const drip = setInterval(() => { if (sent < reply.length) socket.write(reply[sent++]!); }, DRIP_MS);
      socket.on("close", () => clearInterval(drip));
    }));
    push.saveSubscription(userId, device(`http://127.0.0.1:${port}/drip`));

    const started = Date.now();
    const outcome = await within(PUSH_DEADLINE_MS + 3_000, push.notifyHourOpen(userId, "2026-10-13", 60));
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(PUSH_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(PUSH_DEADLINE_MS + 2_000);
    // Tried again on the next run, not forgotten.
    expect(row()?.last_open_day).toBeNull();
  }, 30_000);
});

describe("an endpoint whose name rebinds", () => {
  it("opens no connection to the private address its name answers at send time", async () => {
    delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
    let connections = 0;
    const port = await listen(net.createServer((socket) => { connections++; socket.destroy(); }));
    push.saveSubscription(userId, device(`https://push.rebind.test:${port}/wpush/abc`));
    // The check made before sending gets a public answer; every later query gets 127.0.0.1.
    lookup.mockResolvedValueOnce([{ address: "203.0.113.7", family: 4 }]);

    expect(await push.notifyHourOpen(userId, "2026-10-13", 60)).toEqual({ sent: 0, removed: 0, failed: 1 });
    // The connection asked the resolver itself, got the private answer and refused it.
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith("push.rebind.test", { all: true, verbatim: true });
    expect(connections).toBe(0);
    expect(row()?.endpoint).toBe(`https://push.rebind.test:${port}/wpush/abc`);
  });
});
