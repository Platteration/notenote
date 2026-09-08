import { describe, expect, it } from "vitest";
import { assertPublicHost, BlockedHostError, expandIpv6, isPrivateAddress, privateHostsAllowed } from "@/lib/net-guard";

describe("private address detection", () => {
  it.each([
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4 loopback wearing IPv6"],
    ["::ffff:169.254.169.254", "metadata wearing IPv6"],
    ["::ffff:7f00:1", "the same loopback written in hex, as the URL parser rewrites it"],
    ["::ffff:a9fe:a9fe", "metadata in hex"],
    ["::ffff:0a00:0001", "10.0.0.1 in hex"],
    ["::7f00:1", "deprecated IPv4-compatible loopback"],
    ["fc00::1", "unique local, low end of the range"],
    ["fdff::1", "unique local, high end"],
    ["febf::1", "link local, top of the range"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["172.15.0.1"], ["172.32.0.1"], ["2606:4700::1111"]])(
    "allows the public address %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it("refuses anything that isn't an address rather than guessing", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("999.999.999.999")).toBe(true);
  });
});

describe("IPv6 expansion", () => {
  it("expands the compressed forms to eight groups", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("2606:4700::1111")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111]);
  });

  it("reads a trailing dotted quad as the last two groups", () => {
    expect(expandIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    // Which is the same address the URL parser hands back in hex.
    expect(expandIpv6("::ffff:7f00:1")).toEqual(expandIpv6("::ffff:127.0.0.1"));
  });

  it("returns null for anything that is not an IPv6 address", () => {
    expect(expandIpv6("127.0.0.1")).toBeNull();
    expect(expandIpv6("nonsense")).toBeNull();
  });
});

describe("host guard", () => {
  it("rejects a literal private address", async () => {
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(BlockedHostError);
    await expect(assertPublicHost("169.254.169.254")).rejects.toThrow(/private or reserved/);
    await expect(assertPublicHost("::1")).rejects.toThrow(BlockedHostError);
  });

  it("sees through the brackets around an IPv6 literal", async () => {
    // URL.hostname hands back "[::1]"; without unwrapping it that reads as a name to resolve.
    await expect(assertPublicHost("[::1]")).rejects.toThrow(/private or reserved/);
    await expect(assertPublicHost("[::ffff:127.0.0.1]")).rejects.toThrow(/private or reserved/);
    // The form a URL actually produces, which a dotted-quad regex would have missed.
    await expect(assertPublicHost("[::ffff:7f00:1]")).rejects.toThrow(/private or reserved/);
    await expect(assertPublicHost("[fd00::1]")).rejects.toThrow(/private or reserved/);
  });

  it("rejects a name that resolves to loopback", async () => {
    // localhost resolves to 127.0.0.1 and/or ::1 on every normal system.
    await expect(assertPublicHost("localhost")).rejects.toThrow(/private or reserved|could not be resolved/);
  });

  it("rejects a name that does not resolve", async () => {
    await expect(assertPublicHost("this-host-does-not-exist.invalid")).rejects.toThrow(/could not be resolved/);
  });

  it("rejects an empty host", async () => {
    await expect(assertPublicHost("")).rejects.toThrow(BlockedHostError);
  });

  it("is off by default and opts in only on an explicit flag", () => {
    expect(privateHostsAllowed({})).toBe(false);
    expect(privateHostsAllowed({ ALLOW_PRIVATE_PROVIDER_HOSTS: "0" })).toBe(false);
    expect(privateHostsAllowed({ ALLOW_PRIVATE_PROVIDER_HOSTS: "true" })).toBe(false);
    expect(privateHostsAllowed({ ALLOW_PRIVATE_PROVIDER_HOSTS: "1" })).toBe(true);
  });
});

describe("the Bluesky service host", () => {
  it("refuses to authenticate against an internal address", async () => {
    const { PROVIDERS } = await import("@/lib/providers");
    const connect = PROVIDERS.bluesky.credentialConnect!;
    for (const service of ["https://127.0.0.1:9999", "https://169.254.169.254", "https://localhost:8080"]) {
      await expect(connect.authenticate({ identifier: "a.test", password: "p", service })).rejects.toThrow(
        /Refusing to connect/,
      );
    }
  });

  it("still rejects a non-https service before it ever looks it up", async () => {
    const { PROVIDERS } = await import("@/lib/providers");
    await expect(
      PROVIDERS.bluesky.credentialConnect!.authenticate({ identifier: "a.test", password: "p", service: "http://bsky.social" }),
    ).rejects.toThrow(/must use https/);
  });
});
