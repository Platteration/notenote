import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restrictOwnerOnly } from "@/lib/file-permissions";

// Model a writable volume that does not permit chmod/ACL changes. The existing storage
// tests continue to check real Windows ACLs and POSIX modes on supporting filesystems.
vi.mock("@/lib/file-permissions", () => ({ restrictOwnerOnly: vi.fn() }));

let dir: string;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(restrictOwnerOnly).mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-salt-permissions-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("SESSION_SECRET", "test-salt-permission-recovery-secret");
  vi.stubEnv("PREVIOUS_SESSION_SECRETS", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

function denyPermissions(mode?: 0o600 | 0o700) {
  vi.mocked(restrictOwnerOnly).mockImplementation((_file, attemptedMode) => {
    if (mode === undefined || attemptedMode === mode) {
      throw Object.assign(new Error("Permission changes are not supported"), { code: "EPERM" });
    }
  });
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("salt persistence on volumes without permission changes", () => {
  it.each([0o700, 0o600] as const)("warns and persists when mode %i cannot be applied", async (mode) => {
    const warn = denyPermissions(mode);
    const first = await import("@/lib/crypto");
    expect(first.tokenKeyState().saltCreated).toBe(true);
    const ciphertext = first.encrypt("a recoverable test token");
    expect(fs.readdirSync(dir)).toEqual(["token-key.salt"]);
    const persistedPath = mode === 0o700 ? dir : path.join(dir, "token-key.salt");
    expect(warn).toHaveBeenCalledWith(`Could not make ${persistedPath} owner-only; check its permissions by hand.`);

    vi.resetModules();
    const second = await import("@/lib/crypto");
    expect(second.tokenKeyState().saltCreated).toBe(false);
    expect(second.decrypt(ciphertext)).toBe("a recoverable test token");
  });

  it("still describes an existing bare salt without changing its value, and warns", async () => {
    const file = path.join(dir, "token-key.salt");
    const bare = Buffer.alloc(16, 7).toString("base64url");
    fs.writeFileSync(file, bare);
    const warn = denyPermissions();
    const first = await import("@/lib/crypto");
    expect(first.tokenKeyState().saltCreated).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toContain(`daily-scroll-token-key-salt-v1 ${bare} `);
    expect(fs.readdirSync(dir)).toEqual(["token-key.salt"]);
    expect(warn).toHaveBeenCalledWith(`Could not make ${file} owner-only; check its permissions by hand.`);
    const ciphertext = first.encrypt("an existing test token");
    vi.resetModules();
    expect((await import("@/lib/crypto")).decrypt(ciphertext)).toBe("an existing test token");
  });

  it("still refuses a new salt when the actual write fails", async () => {
    denyPermissions();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Write refused"), { code: "EACCES" });
    });
    const crypto = await import("@/lib/crypto");
    expect(() => crypto.tokenKeyState()).toThrow(/Could not write the token key salt.*EACCES/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("still refuses a new salt when it cannot publish the completed file", async () => {
    denyPermissions();
    vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Hard links unsupported"), { code: "ENOTSUP" });
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Rename refused"), { code: "EACCES" });
    });
    const crypto = await import("@/lib/crypto");
    expect(() => crypto.tokenKeyState()).toThrow(/Could not write the token key salt.*EACCES/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps a usable bare salt and warns when its optional rewrite cannot be written", async () => {
    const file = path.join(dir, "token-key.salt");
    const bare = Buffer.alloc(16, 9).toString("base64url");
    fs.writeFileSync(file, bare);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Write refused"), { code: "EACCES" });
    });
    const crypto = await import("@/lib/crypto");
    expect(crypto.tokenKeyState().saltCreated).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(bare);
    expect(fs.readdirSync(dir)).toEqual(["token-key.salt"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not describe the token key salt.*EACCES/));
    expect(crypto.decrypt(crypto.encrypt("still recoverable"))).toBe("still recoverable");
  });
});
