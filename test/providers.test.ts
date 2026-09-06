import { describe, expect, it } from "vitest";
import { enabledProviderIds, PROVIDERS } from "@/lib/providers";
import { serviceFromScope } from "@/lib/providers/bluesky";
import { demoItems } from "@/lib/providers/demo";
import { detectPlatform, nativeUrl, PROVIDER_META } from "@/lib/providers/meta";
import { PROVIDER_IDS } from "@/lib/providers/types";

describe("provider registry", () => {
  it("registers every platform with metadata, a logo and a demo catalogue", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].id).toBe(id);
      expect(PROVIDER_META[id].logoPath.length).toBeGreaterThan(50);
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
