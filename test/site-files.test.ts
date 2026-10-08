import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The files a website serves beside its pages, from `public/`. The browser walk checks that the
 * built server answers each one with the right type and headers; this checks what they say.
 */

/** `Field: value` lines, comments and blank lines left out. */
function fields(text: string): Array<[string, string]> {
  return text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("/.well-known/security.txt", () => {
  const txt = fields(readFileSync("public/.well-known/security.txt", "utf8"));
  const one = (name: string) => {
    const found = txt.filter(([k]) => k === name);
    expect(found, `exactly one ${name}`).toHaveLength(1);
    return found[0]?.[1] ?? "";
  };

  it("sends reports where SECURITY.md says they go", () => {
    // SECURITY.md asks for GitHub's private vulnerability reporting, not a public issue.
    expect(readFileSync("SECURITY.md", "utf8")).toContain("Report a vulnerability");
    expect(one("Contact")).toBe("https://github.com/Platteration/notenote/security/advisories/new");
    expect(one("Policy")).toBe("https://github.com/Platteration/notenote/blob/main/SECURITY.md");
    expect(one("Preferred-Languages")).toBe("en");
  });

  it("has not expired, and does not claim to stay current for more than a year", () => {
    // RFC 9116 makes Expires required and recommends less than a year ahead. A file past its
    // date is to be treated as stale, so this fails once it lapses: renew it, a year at most.
    const expires = Date.parse(one("Expires"));
    expect(Number.isNaN(expires)).toBe(false);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThanOrEqual(366 * DAY_MS);
  });
});

describe("/robots.txt", () => {
  it("keeps every page out of search engines: past the sign-in form each one is somebody's own", () => {
    expect(fields(readFileSync("public/robots.txt", "utf8"))).toEqual([
      ["User-agent", "*"],
      ["Disallow", "/"],
    ]);
  });
});
