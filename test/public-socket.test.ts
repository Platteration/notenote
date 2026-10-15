import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { assertPublicUrl, publicSocketLookup } from "@/lib/net-guard";
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
