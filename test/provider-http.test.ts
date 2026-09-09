import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { BlockedHostError } = await import("@/lib/net-guard");
const { MAX_RESPONSE_BYTES, ProviderResponseTooLargeError, getJson } = await import("@/lib/providers/http");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

async function serve(handler: Handler): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
});

describe("redirects are checked, not followed blindly", () => {
  it("refuses a hop to cloud metadata", async () => {
    // The exploit: the guard vets the host the user typed, so a PDS they control answers the
    // very first call with a 302 and the server walks into the private network on its behalf.
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
      res.end();
    });
    await expect(getJson("Bluesky", `${pds.origin}/xrpc/com.atproto.server.createSession`)).rejects.toThrow(BlockedHostError);
  });

  it("never opens the connection the redirect asked for", async () => {
    let hits = 0;
    const internal = await serve((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: "admin-panel" }));
    });
    const pds = await serve((_req, res) => {
      res.writeHead(307, { location: `${internal.origin}/admin` });
      res.end();
    });
    await expect(getJson("Bluesky", `${pds.origin}/xrpc/x`)).rejects.toThrow(/private or reserved address/);
    // A refusal that still made the request would leak through timing alone.
    expect(hits).toBe(0);
  });

  it("does not leak the redirected-to body into the error message", async () => {
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/nothing" });
      res.end();
    });
    const err = await getJson("Bluesky", `${pds.origin}/xrpc/x`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as Error).message).not.toMatch(/nothing/);
  });

  it("refuses a scheme that is not http or https", async () => {
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    await expect(getJson("Bluesky", `${pds.origin}/x`)).rejects.toThrow(BlockedHostError);
  });
});

describe("redirects that are allowed", () => {
  // The operator opt-out that already exists turns the address check off, which is the only
  // way to exercise the following logic against a loopback test server.
  const allowPrivate = () => {
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
  };

  it("follows a permitted hop and returns the destination's JSON", async () => {
    allowPrivate();
    const target = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ moved: true }));
    });
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/final` });
      res.end();
    });
    await expect(getJson("Test", `${first.origin}/start`)).resolves.toEqual({ moved: true });
  });

  it("drops the bearer token when a redirect leaves the origin it was issued for", async () => {
    allowPrivate();
    let seenAuth: string | undefined;
    const target = await serve((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const first = await serve((_req, res) => {
      res.writeHead(307, { location: `${target.origin}/elsewhere` });
      res.end();
    });
    await getJson("Test", `${first.origin}/x`, { headers: { Authorization: "Bearer secret-token" } });
    expect(seenAuth).toBeUndefined();
  });

  it("turns a 302'd POST into a GET without its body, as a browser would", async () => {
    allowPrivate();
    let seen: { method?: string; body: string } = { body: "" };
    const target = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { method: req.method, body };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/after` });
      res.end();
    });
    await getJson("Test", `${first.origin}/x`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"a\":1}" });
    expect(seen.method).toBe("GET");
    expect(seen.body).toBe("");
  });

  it("gives up rather than walking a redirect loop", async () => {
    allowPrivate();
    const server = await serve((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    await expect(getJson("Test", `${server.origin}/start`)).rejects.toThrow(/redirected more than/);
  });
});

describe("response size", () => {
  it("refuses a body past the cap instead of buffering whatever arrives", async () => {
    // A hostile destination can stream for the whole request deadline; res.text() would hold
    // all of it. The cap is read from the module so this cannot drift out of step with it.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const pump = () => {
        while (res.write(chunk)) {
          /* until the socket pushes back */
        }
      };
      res.on("drain", pump);
      pump();
    });
    await expect(getJson("Bluesky", `${server.origin}/flood`)).rejects.toThrow(ProviderResponseTooLargeError);
  });

  it("still reads an ordinary reply that fits", async () => {
    const filler = "x".repeat(1000);
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ filler }));
    });
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(filler.length);
    await expect(getJson("Test", `${server.origin}/ok`)).resolves.toEqual({ filler });
  });
});
