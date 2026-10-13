import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { assertPublicUrl, BlockedHostError, publicSocketLookup } from "@/lib/net-guard";
import { publicRequest } from "@/lib/public-request";
import { getJson, MAX_RESPONSE_BYTES, ProviderResponseTooLargeError } from "@/lib/providers/http";

const servers: http.Server[] = [];
afterEach(() => {
  delete process.env.ALLOW_PRIVATE_PROVIDER_HOSTS;
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
});
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("outbound socket DNS", () => {
  it("validates the lookup the actual socket uses, after any earlier public check", async () => {
    let hits = 0;
    const port = await serve((_req, res) => { hits++; res.end("{}"); });
    let answers = 0;
    const resolver = async () => [{ address: ++answers === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    await resolver();
    await expect(publicRequest(`http://rebinding.invalid:${port}/admin`, {}, publicSocketLookup(resolver))).rejects.toThrow(/private or reserved/);
    expect(hits).toBe(0);
    expect(answers).toBe(2);
  });

  it("checks every DNS answer and literal address, including metadata", async () => {
    for (const address of ["10.0.0.1", "169.254.169.254", "::ffff:c0a8:101", "not-an-ip"]) {
      const lookup = publicSocketLookup(async () => [{ address: "93.184.216.34", family: 4 }, { address, family: 6 }]);
      await expect(new Promise((resolve, reject) => lookup("host.invalid", { all: true }, (err, value) => err ? reject(err) : resolve(value)))).rejects.toThrow(/private or reserved/);
    }
    expect(() => assertPublicUrl("https://[::ffff:7f00:1]/")).toThrow(/private or reserved/);
  });

  it("pins one resolution into the socket and preserves Host with the private-provider opt-in", async () => {
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
    let host: string | undefined;
    let answers = 0;
    const port = await serve((req, res) => { host = req.headers.host; res.end("{}"); });
    const response = await publicRequest(`http://does-not-resolve.invalid:${port}/`, {}, publicSocketLookup(async () => {
      answers++;
      return [{ address: "127.0.0.1", family: 4 }];
    }));
    expect(await response.json()).toEqual({});
    expect(answers).toBe(1);
    expect(host).toBe(`does-not-resolve.invalid:${port}`);
  });

  it("answers only addresses of the family the socket asks for", async () => {
    const v4 = { address: "93.184.216.34", family: 4 };
    const v6 = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };
    const ask = (answers: Array<{ address: string; family: number }>, options: { family?: number; all?: boolean }) =>
      new Promise((resolve, reject) =>
        publicSocketLookup(async () => answers)("host.invalid", options, (err, address, family) =>
          err ? reject(err) : resolve(options.all ? address : { address, family })));
    // The v4 answer first, so a lookup that ignored the family would hand it to a v6 socket.
    await expect(ask([v4, v6], { family: 6 })).resolves.toEqual(v6);
    await expect(ask([v6, v4], { family: 4, all: true })).resolves.toEqual([v4]);
    await expect(ask([v4, v6], {})).resolves.toEqual(v4);
    await expect(ask([v4], { family: 6 })).rejects.toThrow(/no address matched the requested family/);
  });

  it("refuses a private address literal at the first hop, with no check of the caller's in front", async () => {
    // A literal never reaches the socket's lookup, so getJson checks it itself; every provider
    // calls it with an address that is either hard-coded or checked, but getJson does not lean on that.
    let hits = 0;
    const port = await serve((_req, res) => { hits++; res.end("{}"); });
    const err = await getJson("Test", `http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(hits).toBe(0);
  });

  it("sends the target's own Host and asks for an uncompressed reply, whatever the caller set (hygiene)", async () => {
    // Not a defence against anything a user controls: no caller passes either header today. It
    // keeps the request what the URL says, and the reply countable as it arrives.
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
    let seen: http.IncomingHttpHeaders = {};
    const port = await serve((req, res) => { seen = req.headers; res.end("{}"); });
    await publicRequest(
      `http://127.0.0.1:${port}/`,
      { headers: { Host: "elsewhere.example", "Accept-Encoding": "gzip, br" } },
      publicSocketLookup(),
    );
    expect(seen.host).toBe(`127.0.0.1:${port}`);
    expect(seen["accept-encoding"]).toBe("identity");
  });

  it("cancels an aborted request and rejects rather than leaving an open socket", async () => {
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
    const port = await serve(() => {});
    await expect(publicRequest(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(25) }, publicSocketLookup())).rejects.toThrow(/aborted/i);
  });

  it("counts decoded bytes when a server ignores Accept-Encoding: identity", async () => {
    process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = "1";
    const packed = gzipSync(JSON.stringify({ data: "x".repeat(MAX_RESPONSE_BYTES) }));
    const port = await serve((_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(packed); });
    await expect(getJson("Test", `http://127.0.0.1:${port}/`)).rejects.toThrow(ProviderResponseTooLargeError);
  });
});
