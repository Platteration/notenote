import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Restrict app data to the server identity; chmod cannot express this on Windows. */
export function restrictOwnerOnly(target: string, mode: 0o600 | 0o700): void {
  if (process.platform !== "win32") {
    fs.chmodSync(target, mode);
    return;
  }
  // The path is data, never interpolated into PowerShell source. A fresh protected DACL
  // removes both inherited and explicit grants to other accounts. Children inherit it.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:DAILY_SCROLL_PERMISSION_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ([System.IO.Directory]::Exists($target)) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
}
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if ([System.IO.Directory]::Exists($target)) { [System.IO.Directory]::SetAccessControl($target, $acl) } else { [System.IO.File]::SetAccessControl($target, $acl) }
`;
  execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, DAILY_SCROLL_PERMISSION_PATH: path.resolve(target) }, windowsHide: true, timeout: 10_000, stdio: "pipe" });
}
