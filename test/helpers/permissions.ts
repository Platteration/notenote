import { expect } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** Assert the real filesystem policy, not chmod's unsupported Windows mode bits. */
export function expectOwnerOnly(file: string): void {
  if (process.platform !== "win32") {
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:DAILY_SCROLL_TEST_PERMISSION_PATH
$acl = if ([System.IO.Directory]::Exists($target)) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
@{ protected = $acl.AreAccessRulesProtected; rules = @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString() } }); current = $sid } | ConvertTo-Json -Depth 4 -Compress
`;
  const actual = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, DAILY_SCROLL_TEST_PERMISSION_PATH: file }, windowsHide: true, timeout: 10_000, encoding: "utf8" }));
  expect(actual.protected).toBe(true);
  expect(actual.rules).toEqual([{ sid: actual.current, type: "Allow", rights: "FullControl" }]);
}

/** A restart closes the native handle before abandoning the cached JavaScript reference. */
export function closeTestDatabase(): void {
  globalThis.__dailyScrollDb?.close();
  globalThis.__dailyScrollDb = undefined;
}
