import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * DNS rebinding against a redirect hop.
 *
 * The network guard resolves a name and checks the answer; the connection then resolves the
 * same name again on its own. A name whose authoritative server answers with a public address
 * to the first query and a private one to the second (a TTL of zero does it, and public
 * rebinding services hand such names out) passes the check and connects somewhere else.
 *
 * Here the guard's resolver is stubbed with that first, public answer, and the connection
 * resolves `localhost` through the system as it always does, which gives the second answer:
 * 127.0.0.1, where a stand-in for an internal service is listening.
 */
const lookup = vi.hoisted(() => vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]));
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));

const { BlockedHostError } = await import("@/lib/net-guard");
const { getJson } = await import("@/lib/providers/http");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

/** Listening on every local address, so `localhost` reaches it whichever family it resolves to. */
async function serve(handler: Handler): Promise<{ port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { port: (server.address() as AddressInfo).port };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  lookup.mockClear();
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
});

describe("a redirect to a name that rebinds", () => {
  it("is not followed over plain http, so the internal service never sees a request", async () => {
    let hits = 0;
    const internal = await serve((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ feed: [], admin: "deleted everything" }));
    });
    // The user's PDS: the first hop, which the caller vetted, answers with a redirect.
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${internal.port}/admin/purge?all=1` });
      res.end();
    });

    const err = await getJson("Bluesky", `http://127.0.0.1:${pds.port}/xrpc/app.bsky.feed.getTimeline`).catch(
      (e: unknown) => e,
    );

    // The stubbed resolver really was the one the guard asked, and it said "public".
    expect(lookup).toHaveBeenCalledWith("localhost", { all: true });
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(hits).toBe(0);
  });

  it("is still followed over https, where the certificate is what pins the name", async () => {
    // Nothing listens on this https port; the point is that the hop is attempted rather than
    // refused by the plain-http rule, so the rule cannot have been written as "no redirects".
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: "https://localhost:1/xrpc/x" });
      res.end();
    });
    const err = await getJson("Bluesky", `http://127.0.0.1:${pds.port}/xrpc/x`).catch((e: unknown) => e);
    expect(lookup).toHaveBeenCalledWith("localhost", { all: true });
    expect(err).not.toBeInstanceOf(BlockedHostError);
  });

  it("follows plain http as before where the operator has turned the guard off", async () => {
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
    const internal = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ moved: true }));
    });
    const pds = await serve((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${internal.port}/final` });
      res.end();
    });
    await expect(getJson("Bluesky", `http://127.0.0.1:${pds.port}/xrpc/x`)).resolves.toEqual({ moved: true });
  });
});
