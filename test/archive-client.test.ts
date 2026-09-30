import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOVE_QUESTION, removeFromArchive } from "@/lib/archive-client";

afterEach(() => vi.unstubAllGlobals());

/** A fetch that answers each call in turn and records the URLs it was asked for. */
function answers(...responses: Response[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }),
  );
  return urls;
}
const ok = () => Response.json({ ok: true });
const needsConfirm = () => Response.json({ error: "Confirm first", needsConfirm: true }, { status: 409 });

describe("removing a clip from the archive", () => {
  it("removes a plain clip straight away, without asking", async () => {
    const urls = answers(ok());
    const ask = vi.fn(() => true);
    expect(await removeFromArchive("youtube:a", false, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(urls).toEqual(["/api/saved?key=youtube%3Aa"]);
  });

  it("asks first about a clip it knows is annotated, and sends the confirmation", async () => {
    const urls = answers(ok());
    const ask = vi.fn(() => true);
    expect(await removeFromArchive("youtube:a", true, ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith(REMOVE_QUESTION);
    expect(urls).toEqual(["/api/saved?key=youtube%3Aa&confirm=1"]);
  });

  it("keeps an annotated clip when the answer is no, without touching the server", async () => {
    const urls = answers();
    expect(await removeFromArchive("youtube:a", true, () => false)).toBe(false);
    expect(urls).toEqual([]);
  });

  it("asks when the server says the clip was annotated elsewhere, then confirms", async () => {
    const urls = answers(needsConfirm(), ok());
    const ask = vi.fn(() => true);
    expect(await removeFromArchive("youtube:a", false, ask)).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    expect(urls).toEqual(["/api/saved?key=youtube%3Aa", "/api/saved?key=youtube%3Aa&confirm=1"]);
  });

  it("keeps it when the server asked and the answer is no", async () => {
    const urls = answers(needsConfirm());
    expect(await removeFromArchive("youtube:a", false, () => false)).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it("passes any other failure through for the page to show", async () => {
    answers(Response.json({ error: "Something went wrong" }, { status: 500 }));
    await expect(removeFromArchive("youtube:a", false, () => true)).rejects.toThrow("Something went wrong");
  });
});
