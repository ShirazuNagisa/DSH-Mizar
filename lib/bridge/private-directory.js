/**
 * Secure a staging directory so only the current user can reach it.
 *
 * Ported from XEPX2's PR #2 (`src/attachments/private-directory.ts`), which
 * guarded its attachment staging area; this module uses it for the same job on
 * the `upload.*` staging roots. `mode: 0o700` is enough on POSIX, but Windows
 * ignores it: a fresh directory under the user profile inherits grants
 * (SYSTEM, Administrators, the user) that `chmod` cannot remove. The OS answer
 * is to reset the ACL to exactly one rule for the current SID — and to verify
 * the reset afterwards rather than trust it.
 *
 * The verification is the point. Writing bytes into a directory whose ACL did
 * not actually tighten would be silent exposure, so the script re-reads the
 * ACL and fails unless it sees the protection flag, exactly one rule, and that
 * rule naming the current user. Every failure path throws before the caller
 * writes a byte.
 *
 * The parent directory (the plugin's state home, never TEMP itself) is left
 * untouched, and no elevation is requested: if the current user cannot secure
 * its own directory, staging is refused, not de-scoped.
 *
 * @module dsh-mizar/bridge/private-directory
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// Current-user SID, not localized account-name parsing. The path is passed as
// data in the child environment, not interpolated into PowerShell source.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:MIZAR_PRIVATE_UPLOAD_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inheritance, $propagation, $allow)
$acl.AddAccessRule($rule)
$directory = [System.IO.DirectoryInfo]::new($path)
$directory.SetAccessControl($acl)
$check = $directory.GetAccessControl()
if (-not $check.AreAccessRulesProtected) { throw 'Private upload ACL was not protected' }
$rules = $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 1) { throw 'Private upload ACL has an unexpected rule count' }
foreach ($entry in $rules) {
  if ($entry.IdentityReference.Value -ne $sid.Value) {
    throw 'Private upload ACL contains an unexpected principal'
  }
}
`;
/**
 * Create (if needed) and secure one staging directory for the current user.
 *
 * The directory is created first when absent, because the ACL reset below is
 * what makes it private — creating it already-secured avoids a window in which
 * an inherited-ACL directory exists.
 *
 * @param path - the directory to create and secure.
 * @throws when the directory cannot be created or its ACL cannot be secured
 *   and verified; the caller must not write bytes into it afterwards.
 */
export async function makePrivateDirectory(path) {
    await mkdir(path, { recursive: true });
    if (process.platform !== 'win32') {
        await chmod(path, 0o700);
        return;
    }
    // Windows chmod cannot remove inherited ACL grants. Use the OS-supplied
    // Windows PowerShell, with no profile, no shell interpolation and no pipes.
    const executable = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64')], {
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, MIZAR_PRIVATE_UPLOAD_DIRECTORY: path },
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Private upload ACL setup timed out'));
        }, 15_000);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve();
            else
                reject(new Error('Cannot secure private upload directory ACL'));
        });
    });
}
