import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError, requestJson, safeReturnPath } from "@/lib/client-api";

afterEach(() => vi.unstubAllGlobals());

describe("client requests", () => {
  it("surfaces an actionable network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(requestJson("/api/settings")).rejects.toThrow(/Check your connection/);
  });
  it("preserves the server's validation message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Unknown timezone" }, { status: 400 })));
    await expect(requestJson("/api/settings")).rejects.toThrow("Unknown timezone");
  });
  it("handles an HTML proxy failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })));
    await expect(requestJson("/api/settings")).rejects.toThrow(/Please try again/);
  });
  it("tells a caller the status and body, so it can ask before retrying a refused change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Confirm first", needsConfirm: true }, { status: 409 })));
    const err = await requestJson("/api/saved?key=x", { method: "DELETE" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toBeInstanceOf(Error);
    expect((err as RequestError).status).toBe(409);
    expect((err as RequestError).body).toEqual({ error: "Confirm first", needsConfirm: true });
    expect((err as RequestError).message).toBe("Confirm first");
  });
  it("returns successful JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ saved: true })));
    expect(await requestJson("/api/saved")).toEqual({ saved: true });
  });
});

describe("sign-in destinations", () => {
  it.each(["//evil.test", "/\\evil.test", "/%5cevil.test", "/%2fevil.test", "javascript:alert(1)", "/%invalid"])("rejects %s", (value) => {
    expect(safeReturnPath(value, "/feed")).toBe("/feed");
  });
  it("keeps local paths and queries", () => {
    expect(safeReturnPath("/connect?form=bluesky", "/feed")).toBe("/connect?form=bluesky");
  });
});
