# Puts a double-clickable Hangar shortcut on the Desktop and in the Start Menu.
#
#   npm run shortcut
#
# The shortcut runs Hangar.exe - the icon-stamped copy of the Electron binary
# that tools/make-exe.ps1 leaves in node_modules - against this source tree. No
# packaging step, so edits to the source show up the next time you launch, and
# it is a GUI-subsystem binary, so double-clicking opens the app with no console
# window behind it.
#
# Pointing at Hangar.exe rather than electron.exe is what fixes the taskbar:
# Windows reads a taskbar button's icon out of the running executable and
# ignores both the window icon and this shortcut's IconLocation.
#
# Both shortcuts are also stamped with an AppUserModelID matching the one
# main.js passes to app.setAppUserModelId, which is what ties a running window
# to its pinned button instead of leaving a second, loose one behind.

$ErrorActionPreference = 'Stop'

# Must match app.setAppUserModelId in main.js.
$appId = 'com.jameshangar.hangar'

$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\Hangar.exe'
$icon = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $icon)) {
  throw "Icon not found at $icon - run 'npm run icon' first."
}

# Rebuilt every time: npm install and Electron upgrades both wipe the copy.
& (Join-Path $PSScriptRoot 'make-exe.ps1')

if (-not (Test-Path $exe)) {
  throw "Expected $exe to exist after make-exe.ps1."
}

# WScript.Shell writes a .lnk but has no way to set shell properties on it, so
# the AppUserModelID goes on afterwards through IPropertyStore. CShellLink hands
# that interface out directly - no need to touch IShellLink at all.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Hangar {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
    public PropertyKey(Guid id, uint p) { fmtid = id; pid = p; }
  }

  // Real PROPVARIANT is 24 bytes on x64; the vt lives at 0 and the union at 8
  // on both architectures. Oversizing is harmless, undersizing is not.
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
    int SetValue(ref PropertyKey key, ref PropVariant value);
    int Commit();
  }

  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistFile {
    int GetClassID(out Guid classId);
    int IsDirty();
    int Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
    int Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
    int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
    int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class ShellLink { }

  public static class AppId {
    // PKEY_AppUserModel_ID
    static readonly Guid Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    const uint PropertyId = 5;
    const uint StgmReadWrite = 0x00000012;
    const ushort VtLpwstr = 31;

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    public static void Stamp(string linkPath, string appId) {
      object link = new ShellLink();
      ((IPersistFile)link).Load(linkPath, StgmReadWrite);

      IPropertyStore store = (IPropertyStore)link;
      PropertyKey key = new PropertyKey(Format, PropertyId);
      PropVariant value = new PropVariant();
      value.vt = VtLpwstr;
      value.pointer = Marshal.StringToCoTaskMemUni(appId);

      try {
        Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
        Marshal.ThrowExceptionForHR(store.Commit());
      } finally {
        // SetValue copies the string, so the one we allocated is ours to free.
        PropVariantClear(ref value);
      }

      Marshal.ThrowExceptionForHR(((IPersistFile)link).Save(linkPath, true));
      Marshal.ReleaseComObject(link);
    }
  }
}
'@

$shell = New-Object -ComObject WScript.Shell

function Write-HangarShortcut([string]$Path) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath       = $exe
  $shortcut.Arguments        = '"' + $root + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation     = $icon
  $shortcut.Description      = 'Hangar - a minimal tabbed terminal host'
  $shortcut.WindowStyle      = 1
  $shortcut.Save()

  [Hangar.AppId]::Stamp($Path, $appId)
}

$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hangar.lnk'
$programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hangar.lnk'
Write-HangarShortcut $desktop
Write-Output "Created $desktop"
Write-HangarShortcut $programs
Write-Output "Created $programs"

# ------------------------------------------------------------- taskbar pins
#
# A pin is its own .lnk, so pinning Hangar back when it still launched through
# electron.exe left a pin targeting the bare binary - and a running window
# groups under whichever pin matches, which is what put an Electron atom on the
# taskbar however the app itself was launched. Repoint every pin aimed at this
# project so they all match what we now install.
#
# Repoint rather than delete, even for duplicates. The taskbar's pin order lives
# in the Taskband registry blob and only references these files: delete one and
# Explorer keeps the slot but can no longer resolve it, leaving a permanent
# blank page on the taskbar that survives restarts. Unpinning has to go through
# the shell, so a spare is left for you to right-click and unpin.

$oldExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'

if (Test-Path $pinDir) {
  $pins = @()
  foreach ($lnk in @(Get-ChildItem (Join-Path $pinDir '*.lnk') -ErrorAction SilentlyContinue)) {
    $target = $shell.CreateShortcut($lnk.FullName).TargetPath
    if ($target -eq $oldExe -or $target -eq $exe) { $pins += $lnk }
  }

  foreach ($pin in $pins) {
    Write-HangarShortcut $pin.FullName
    Write-Output "Repointed pinned $($pin.Name)"
  }

  if ($pins.Count -gt 0) {
    # Explorer only reads pins at startup, so the taskbar keeps showing the old
    # icon until it is restarted. It comes back on its own.
    Write-Output 'Restarting Explorer so the taskbar picks up the new pins...'
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
  }

  if ($pins.Count -gt 1) {
    Write-Output ''
    Write-Output "$($pins.Count) taskbar pins point at Hangar. They all work now; right-click"
    Write-Output 'the spare and choose Unpin from taskbar if you only want one.'
  }
}

