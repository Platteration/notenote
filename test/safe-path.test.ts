import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/safe-path";

/**
 * The redirect target after a sign-in. The app generates `?next=/connect` links itself
 * (`/api/connect/:provider/start`, the OAuth callback, the connect page), so a crafted `next`
 * on the genuine sign-in page is a credible link to send someone — which is exactly why
 * "starts with a slash" was not enough of a test.
 */
describe("post-sign-in redirect target", () => {
  it("keeps an ordinary in-app path, with its query and fragment", () => {
    expect(safeNextPath("/feed", "/fallback")).toBe("/feed");
    expect(safeNextPath("/connect?form=bluesky", "/fallback")).toBe("/connect?form=bluesky");
    expect(safeNextPath("/settings#push", "/fallback")).toBe("/settings#push");
  });

  it("refuses a value that resolves to another origin", () => {
    // Checked against the URL parser rather than against the guard's own rules: each of these
    // really does leave the origin, which is what makes them worth refusing.
    for (const hostile of ["//evil.example", "/\\evil.example", "/\t/evil.example", "//evil.example/path"]) {
      expect(new URL(hostile, "https://scroll.example").origin).not.toBe("https://scroll.example");
      expect(safeNextPath(hostile, "/fallback")).toBe("/fallback");
    }
  });

  it("refuses a path that keeps this origin but resolves to one starting with two slashes", () => {
    // Dot segments (literal or percent-encoded) and a backslash collapse into `//` only once
    // resolved, so the leading-slash test never sees them and the origin survives. What comes
    // back is read again by the router as an address relative to the page, and `//evil.example`
    // read that way is another host: each of these sent a sign-up to http://evil.example/.
    for (const hostile of ["/.//evil.example", "/.//evil.example/", "/x/..//evil.example", "/%2e//evil.example", "/..//evil.example", "/x/..\\/evil.example"]) {
      const resolved = new URL(hostile, "https://scroll.example");
      expect(resolved.origin).toBe("https://scroll.example");
      expect(new URL(resolved.pathname, "https://scroll.example").origin).not.toBe("https://scroll.example");
      expect(safeNextPath(hostile, "/fallback")).toBe("/fallback");
    }
    // A doubled slash later in the path is still a path on this site.
    expect(safeNextPath("/saved//archive", "/fallback")).toBe("/saved//archive");
    expect(safeNextPath("/x/../feed", "/fallback")).toBe("/feed");
  });

  it("refuses anything that is not a path on this site", () => {
    expect(safeNextPath("https://evil.example/", "/fallback")).toBe("/fallback");
    expect(safeNextPath("javascript:alert(1)", "/fallback")).toBe("/fallback");
    expect(safeNextPath("feed", "/fallback")).toBe("/fallback");
    expect(safeNextPath("", "/fallback")).toBe("/fallback");
    expect(safeNextPath(null, "/fallback")).toBe("/fallback");
  });

  it("returns the parsed path, so what was checked is what gets used", () => {
    // A stripped character cannot reappear in the value the router is handed.
    expect(safeNextPath("/fe\ted", "/fallback")).toBe("/feed");
  });
});
