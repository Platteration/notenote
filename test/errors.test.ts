import { describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "test-secret-for-error-tests";

const { MAX_REQUEST_BYTES, CrossSiteError, errorResponse, readJson } = await import("@/lib/api");
const { UserFacingError } = await import("@/lib/errors");
const { UnauthorizedError } = await import("@/lib/session");
const { ProviderHttpError } = await import("@/lib/providers/http");

const body = async (res: Response) => (await res.json()) as { error?: string };

describe("what an error tells the client", () => {
  it("shows a message written for the person using the app", async () => {
    const res = errorResponse(new UserFacingError("Password must be at least 8 characters"));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("Password must be at least 8 characters");
  });

  it("lets an error name its own status, and otherwise takes the caller's", async () => {
    expect(errorResponse(new UserFacingError("Request body is too large", 413)).status).toBe(413);
    // How a wrong password stays a 401 rather than becoming a 400.
    expect(errorResponse(new UserFacingError("Email or password is incorrect"), 401).status).toBe(401);
    expect(errorResponse(new UnauthorizedError()).status).toBe(401);
    expect(errorResponse(new CrossSiteError()).status).toBe(403);
  });

  it("does not hand back anything from inside the server", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const internal = [
      // A concurrent duplicate signup.
      new Error("UNIQUE constraint failed: users.email"),
      // decrypt() on a rotated or wrong key.
      new Error("Unsupported state or unable to authenticate data"),
      // A platform's HTTP error, which carries part of the upstream body.
      new ProviderHttpError("Bluesky", 500, '{"error":"InternalServerError","message":"upstream: 10.0.0.7 refused"}'),
      "not even an error",
    ];

    for (const err of internal) {
      const res = errorResponse(err, 401);
      expect(res.status).toBe(500);
      const payload = await body(res);
      expect(payload.error).toBe("Something went wrong");
      // Nothing recognisable from the original reaches the client.
      expect(JSON.stringify(payload)).not.toMatch(/constraint|authenticate|10\.0\.0\.7|upstream/i);
    }

    // The detail is not lost, it is logged.
    expect(logged).toHaveBeenCalledTimes(internal.length);
    logged.mockRestore();
  });
});

describe("how much body is read", () => {
  const url = "https://scroll.example/api/settings";
  const json = { "content-type": "application/json" };

  it("accepts an ordinary request", async () => {
    const req = new Request(url, { method: "POST", headers: json, body: JSON.stringify({ feedSize: 20 }) });
    await expect(readJson(req)).resolves.toEqual({ feedSize: 20 });
  });

  it("refuses a body that declares itself too large before reading it", async () => {
    const req = new Request(url, {
      method: "POST",
      headers: { ...json, "content-length": String(MAX_REQUEST_BYTES + 1) },
      body: JSON.stringify({ feedSize: 20 }),
    });
    await expect(readJson(req)).rejects.toThrow(/too large/);
  });

  it("stops a body that declares nothing and keeps coming", async () => {
    // Chunked transfer encoding: there is no Content-Length to check, which is exactly what an
    // unbounded upload looks like. The count has to happen as the bytes arrive.
    let pulled = 0;
    const chunk = new Uint8Array(8 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const req = new Request(url, {
      method: "POST",
      headers: json,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.get("content-length")).toBeNull();

    await expect(readJson(req)).rejects.toThrow(/too large/);
    // Derived from the cap rather than from the reader: it gave up shortly after the limit
    // instead of buffering whatever the client cared to send.
    expect(pulled * chunk.byteLength).toBeLessThan(MAX_REQUEST_BYTES * 2);
  });

  it("still insists on JSON, and on it parsing", async () => {
    await expect(readJson(new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))).rejects.toThrow(
      /must be JSON/,
    );
    await expect(readJson(new Request(url, { method: "POST", headers: json, body: "not json" }))).rejects.toThrow(/must be JSON/);
  });
});
