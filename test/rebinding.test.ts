import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * DNS rebinding: a name whose authoritative server answers with a public address to one query
 * and a private one to the next (a TTL of zero does it, and public rebinding services hand
 * such names out).
 *
 * A guard that resolves the name, checks the answer and then lets the connection resolve it
 * again is passed by such a name: the check sees the public answer and the connection goes to
 * the private one. So the connection's own lookup is the check (`publicSocketLookup`): it
 * resolves once, refuses an answer with a private address in it, and hands the socket the
 * addresses it checked, so there is no second answer to rebind to.
 *
 * The resolver is stubbed here. A name's first answer is set per case with a public address
 * (TEST-NET-3, which nothing routes), and every later answer is 127.0.0.1, where a stand-in for
 * an internal service is listening.
 */
const lookup = vi.hoisted(() =>
  vi.fn(async (_host: string, _options?: unknown) => [{ address: "127.0.0.1", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));

const { assertPublicHost, BlockedHostError } = await import("@/lib/net-guard");
const { getJson, ProviderTimeoutError } = await import("@/lib/providers/http");

/** An address that passes the guard and that no network routes: 203.0.113.0/24 (RFC 5737). */
const PUBLIC = [{ address: "203.0.113.7", family: 4 }];

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: Array<http.Server | net.Server> = [];

/** Listening on every local address, so 127.0.0.1 reaches it. */
async function serve(handler: Handler): Promise<{ port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { port: (server.address() as AddressInfo).port };
}

/**
 * The user's PDS: reached on loopback with the operator opt-out, which it then takes away, so the
 * hop it redirects to is judged with the guard on — as it would be for a PDS on the internet.
 */
async function redirectingPds(location: string): Promise<string> {
  const { port } = await serve((_req, res) => {
    delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
    res.writeHead(302, { location });
    res.end();
  });
  process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
  return `http://127.0.0.1:${port}/xrpc/app.bsky.feed.getTimeline`;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  lookup.mockClear();
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
});

describe("a name that rebinds", () => {
  it("cannot take a redirect to an internal service, whichever answer a check saw first", async () => {
    let hits = 0;
    const internal = await serve((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ feed: [], admin: "deleted everything" }));
    });
    // A check that resolves the name on its own gets the public answer and passes.
    lookup.mockResolvedValueOnce(PUBLIC);
    await expect(assertPublicHost("rebind.test")).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);

    const pds = await redirectingPds(`http://rebind.test:${internal.port}/admin/purge?all=1`);
    const err = await getJson("Bluesky", pds).catch((e: unknown) => e);

    // The connection asked the stubbed resolver itself, got the private answer, and refused it
    // rather than connecting.
    expect(lookup).toHaveBeenLastCalledWith("rebind.test", { all: true, verbatim: true });
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(hits).toBe(0);
  });

  it("cannot open a connection to an internal address as the host a user named", async () => {
    // The Bluesky host a user names is https and is checked before every use (checkedService in
    // bluesky.ts). A rebinding name passes that check; TLS would refuse the rebound connection at
    // the certificate, but only after it had been opened to the address and port the name chose.
    // No connection is opened at all now.
    let connections = 0;
    const internal = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    servers.push(internal);
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    const { port } = internal.address() as AddressInfo;

    lookup.mockResolvedValueOnce(PUBLIC);
    await expect(assertPublicHost("pds.rebind.test")).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);

    const err = await getJson("Bluesky", `https://pds.rebind.test:${port}/xrpc/com.atproto.server.createSession`).catch(
      (e: unknown) => e,
    );
    expect(lookup).toHaveBeenLastCalledWith("pds.rebind.test", { all: true, verbatim: true });
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(connections).toBe(0);
  });

  it.each(["http", "https"])("still lets a %s redirect through when its name answers publicly", async (scheme) => {
    // The refusal is about the address, not about redirects: a hop whose name resolves to a
    // public address is attempted. Nothing routes TEST-NET-3, so the attempt ends in the
    // deadline (or an unreachable network), never in the guard.
    const pds = await redirectingPds(`${scheme}://public.test:1/xrpc/x`);
    lookup.mockResolvedValueOnce(PUBLIC);
    const err = await getJson("Bluesky", pds, { signal: AbortSignal.timeout(300) }).catch((e: unknown) => e);
    expect(lookup).toHaveBeenLastCalledWith("public.test", { all: true, verbatim: true });
    expect(err).not.toBeInstanceOf(BlockedHostError);
    expect(err).toSatisfy(
      (e: unknown) => e instanceof ProviderTimeoutError || /ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/.test(String((e as Error).message ?? e)),
    );
  });

  it("follows plain http to a private address as before where the operator has turned the guard off", async () => {
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
    expect(lookup).toHaveBeenLastCalledWith("localhost", { all: true, verbatim: true });
  });
});
