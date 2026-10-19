/** Secure only a newly-created staging directory; never change its parent/TEMP ACL. */
import { spawn } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

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
`

export async function makePrivateDirectory(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o700)
    return
  }
  // Windows chmod cannot remove inherited ACL grants. Use the OS-supplied
  // Windows PowerShell, with no profile, no shell interpolation and no pipes.
  const executable = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: 'ignore',
      env: { ...process.env, MIZAR_PRIVATE_UPLOAD_DIRECTORY: path },
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Private upload ACL setup timed out')) }, 15_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('Cannot secure private upload directory ACL'))
    })
  })
}
