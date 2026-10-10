import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { LookupFunction } from "node:net";

/**
 * A single HTTP(S) exchange. The supplied lookup validates the addresses returned to the
 * actual socket; the original URL still supplies Host and TLS certificate/server-name checks.
 * No connection pool or automatic redirect can reuse an unguarded destination.
 */
export async function publicRequest(url: string, init: RequestInit, lookup: LookupFunction): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Only HTTP(S) requests are supported");
  if (target.username || target.password) throw new Error("Credentials in request URLs are not supported");
  const headers = new Headers(init.headers);
  headers.delete("host");
  // Prefer an uncompressed reply, but decode a server that sends compression anyway so the
  // caller's counting reader measures decoded bytes just as it did with fetch.
  headers.set("accept-encoding", "identity");
  let body: string | Uint8Array | undefined;
  if (init.body != null) {
    if (typeof init.body === "string") body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    else if (ArrayBuffer.isView(init.body)) body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    else if (init.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else throw new Error("Unsupported outbound request body");
  }
  init.signal?.throwIfAborted();

  return new Promise<Response>((resolve, reject) => {
    const send = target.protocol === "https:" ? https.request : http.request;
    const req = send(target, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      lookup,
      agent: false,
      signal: init.signal ?? undefined,
    }, (res) => {
      const status = res.statusCode ?? 502;
      if (init.redirect === "error" && [301, 302, 303, 307, 308].includes(status)) {
        res.destroy();
        reject(new Error("Outbound redirects are not allowed"));
        return;
      }
      const replyHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) replyHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      let source: Readable = res;
      const encoding = replyHeaders.get("content-encoding")?.toLowerCase();
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
      if (decoder) {
        res.once("error", (err) => decoder.destroy(err));
        req.once("error", (err) => decoder.destroy(err));
        decoder.once("close", () => res.destroy());
        source = res.pipe(decoder);
        replyHeaders.delete("content-encoding");
        replyHeaders.delete("content-length");
      }
      const empty = init.method?.toUpperCase() === "HEAD" || [204, 205, 304].includes(status);
      if (empty) res.destroy();
      try {
        resolve(new Response(empty ? null : Readable.toWeb(source) as ReadableStream<Uint8Array>, {
          status,
          statusText: res.statusMessage,
          headers: replyHeaders,
        }));
      } catch (err) {
        source.destroy();
        res.destroy();
        reject(err);
      }
    });
    req.once("error", reject);
    req.end(body);
  });
}
