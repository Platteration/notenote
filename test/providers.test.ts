import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { enabledProviderIds, getProvider, PROVIDERS } from "@/lib/providers";
import { serviceFromScope } from "@/lib/providers/bluesky";
import { demoItems } from "@/lib/providers/demo";
import { detectPlatform, nativeUrl, PROVIDER_META, providerMeta, providerName } from "@/lib/providers/meta";
import { PROVIDER_IDS } from "@/lib/providers/types";
import { connectErrorText } from "@/components/ConnectionsPanel";

describe("provider registry", () => {
  it("registers every platform with metadata, a logo and a demo catalogue", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].id).toBe(id);
      expect(PROVIDER_META[id].logoPath.length).toBeGreaterThan(50);
      // Every platform needs a wireframe tint bright enough to read on black.
      const wire = PROVIDER_META[id].wireColor;
      expect(wire).toMatch(/^#[0-9a-f]{6}$/);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(wire.slice(i, i + 2), 16));
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(120);
      const items = demoItems(id, "user", Date.UTC(2026, 8, 6), 5);
      expect(items).toHaveLength(5);
      for (const it of items) expect(it.permalink).toMatch(/^https:\/\//);
    }
  });

  it("enables every platform by default and honours the ENABLED_PROVIDERS allow-list", () => {
    expect(enabledProviderIds({})).toEqual(PROVIDER_IDS);
    expect(enabledProviderIds({ ENABLED_PROVIDERS: "all" })).toEqual(PROVIDER_IDS);
    expect(enabledProviderIds({ ENABLED_PROVIDERS: "youtube, reddit ,nope" })).toEqual(["youtube", "reddit"]);
  });

  it("marks Snapchat as demo-only", () => {
    expect(PROVIDERS.snapchat.demoOnly).toBe(true);
  });

  it("connects Bluesky with an app password form and reads its service host from scope", async () => {
    expect(PROVIDERS.bluesky.credentialConnect?.fields.map((f) => f.name)).toEqual(["identifier", "password", "service"]);
    expect(serviceFromScope("service=https://pds.example.org")).toBe("https://pds.example.org");
    expect(serviceFromScope(null)).toBe("https://bsky.social");
    await expect(PROVIDERS.bluesky.credentialConnect!.authenticate({ identifier: "", password: "" })).rejects.toThrow(/required/);
  });
});

describe("native deep links", () => {
  const base = { permalink: "https://example.com/x", creatorHandle: "h" };

  it("detects mobile platforms from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("other");
  });

  it("builds app schemes per platform", () => {
    expect(nativeUrl({ ...base, provider: "youtube", externalId: "abc" }, "ios")).toBe("youtube://www.youtube.com/shorts/abc");
    expect(nativeUrl({ ...base, provider: "youtube", externalId: "abc" }, "android")).toBe("vnd.youtube://abc");
    expect(nativeUrl({ ...base, provider: "twitter", externalId: "1" }, "ios")).toBe("twitter://status?id=1");
    expect(nativeUrl({ ...base, provider: "instagram", externalId: "9" }, "android")).toBe("instagram://media?id=9");
    expect(nativeUrl({ ...base, provider: "tiktok", externalId: "7" }, "ios")).toBe("snssdk1233://aweme/detail/7");
    expect(nativeUrl({ ...base, provider: "pinterest", externalId: "5" }, "ios")).toBe("pinterest://pin/5");
    expect(
      nativeUrl({ ...base, provider: "reddit", externalId: "r", permalink: "https://www.reddit.com/r/aww/comments/r/t/" }, "ios"),
    ).toBe("reddit://r/aww/comments/r/t/");
  });

  it("falls back to the permalink where no reliable scheme exists", () => {
    expect(nativeUrl({ ...base, provider: "threads", externalId: "1" }, "ios")).toBeNull();
    expect(nativeUrl({ ...base, provider: "snapchat", externalId: "1" }, "android")).toBeNull();
  });
});

/**
 * Every table here is an object literal, so a bare index answers with whatever
 * `Object.prototype` has under that name. The ids reaching these lookups come from a URL
 * segment, a stored row and a query parameter, and one of them — the `?error=` on the
 * Connections page — was reachable: `/connect?error=__proto__` put `Object.prototype` where a
 * sentence should be and took the whole panel down.
 */
describe("names that exist on every object", () => {
  // Derived from the prototype itself, so anything added to it is covered here too.
  const inherited = Object.getOwnPropertyNames(Object.prototype).filter((n) => n !== "__proto__").concat("__proto__");

  it("are not providers", () => {
    for (const name of inherited) expect(getProvider(name)).toBeNull();
  });

  /**
   * The case above passes even against a bare `PROVIDERS[id]`, because the enabled-id filter
   * after the lookup rescues it: a function off `Object.prototype` has no `.id`, so
   * `enabledProviderIds().includes(undefined)` is false whatever the lookup returned. That is a
   * second line of defence, not the fix, and this is what the fix itself is for — a value
   * reachable through the prototype that *would* survive the filter.
   */
  it("cannot be planted on the prototype and answered as a provider", () => {
    const prototype = Object.prototype as unknown as Record<string, unknown>;
    prototype.notaprovider = { ...PROVIDERS.tiktok, id: "tiktok" };
    try {
      expect(getProvider("notaprovider")).toBeNull();
      expect(providerMeta("notaprovider")).toBeNull();
    } finally {
      delete prototype.notaprovider;
    }
  });

  it("have no platform metadata", () => {
    for (const name of inherited) {
      expect(providerMeta(name)).toBeNull();
      // providerName falls back to the id it was given, and that id is a string.
      expect(providerName(name)).toBe(name);
    }
  });

  it("get the app's own sentence on the Connections page, not an object", () => {
    for (const name of inherited) {
      expect(connectErrorText(name)).toBe("Something went wrong.");
      // The callback prefixes a provider id: `?error=yt-__proto__` reaches the same lookup.
      expect(connectErrorText(`yt-${name}`)).toBe("Something went wrong.");
    }
    // A real one still reads as itself.
    expect(connectErrorText("denied")).toMatch(/cancelled/i);
  });
});

/**
 * The rule, not one instance of it: every read of these tables goes through the own-property
 * helpers in `lib/providers`. `ScrollView` was left indexing `PROVIDER_META` directly three
 * lines from a call to the function that closes it, where nothing here reached it — harmless
 * only because the two fields it read are not on `Object.prototype`, which is not a property
 * the next person to add `meta.name` there would keep.
 */
describe("the platform tables", () => {
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it("are only indexed where the own-property lookup lives", () => {
    const owner = path.join("src", "lib", "providers", "meta.ts");
    const offenders = sources("src")
      .filter((file) => file !== owner)
      .filter((file) => /PROVIDER_META\s*\[/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
