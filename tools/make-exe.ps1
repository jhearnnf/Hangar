# Stamps a copy of electron.exe with Hangar's icon.
#
#   npm run exe
#
# Windows takes a taskbar button's icon from the executable's own resources. It
# ignores the window icon Electron sets from the `icon:` option, and it ignores
# the .lnk's IconLocation too - so launching the stock electron.exe always gives
# you an Electron atom on the taskbar no matter what the app or the shortcut
# says. The only thing that changes it is an .exe carrying the icon itself.
#
# So: copy electron.exe to Hangar.exe beside it and rewrite its icon resources
# in place. The copy stays inside node_modules\electron\dist, which is what
# makes this work without packaging - all the DLLs and resources Electron needs
# are already sitting there, and the app path still arrives as argv.
#
# The resource rewrite uses the in-box Win32 resource APIs rather than rcedit,
# for the same reason tools/make-icon.js packs its own .ico: nothing extra to
# install. Editing resources invalidates Electron's Authenticode signature,
# which nothing here depends on.
#
# `npm install` or an Electron upgrade wipes the copy - just run this again.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'node_modules\electron\dist'
$src  = Join-Path $dist 'electron.exe'
$dest = Join-Path $dist 'Hangar.exe'
$icon = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $src))  { throw "Electron not found at $src - run 'npm install' first." }
if (-not (Test-Path $icon)) { throw "Icon not found at $icon - run 'npm run icon' first." }

# A running copy can't be overwritten, and the error you get is unhelpful.
$running = Get-Process -Name 'Hangar' -ErrorAction SilentlyContinue
if ($running) { throw 'Hangar.exe is running - close Hangar and try again.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Hangar {
  public static class Resources {
    const int RT_ICON = 3;
    const int RT_GROUP_ICON = 14;
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    // en-US. The originals are deleted first, so nothing is left to clash.
    const ushort LANG = 1033;

    delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc cb, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc cb, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr handle, bool discard);

    class Entry { public int Type; public int Id; public string Name; public ushort Lang; }

    static bool IsIntResource(IntPtr p) { return ((ulong)p.ToInt64() >> 16) == 0; }

    /// Every icon resource already in the file, so it can be cleared out. A
    /// leftover group with a lower id than ours would keep winning otherwise.
    static List<Entry> ExistingIcons(string exe) {
      var found = new List<Entry>();
      IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
      if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

      try {
        foreach (int type in new int[] { RT_ICON, RT_GROUP_ICON }) {
          int captured = type;
          EnumNameProc onName = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
            bool numeric = IsIntResource(n);
            int id = numeric ? (int)n.ToInt64() : 0;
            // The string a name pointer points at is only valid in here.
            string name = numeric ? null : Marshal.PtrToStringUni(n);
            EnumLangProc onLang = delegate(IntPtr m2, IntPtr t2, IntPtr n2, ushort lang, IntPtr p2) {
              found.Add(new Entry { Type = captured, Id = id, Name = name, Lang = lang });
              return true;
            };
            EnumResourceLanguages(m, t, n, onLang, IntPtr.Zero);
            GC.KeepAlive(onLang);
            return true;
          };
          // Fails harmlessly when the file has no resources of this type.
          EnumResourceNames(module, (IntPtr)type, onName, IntPtr.Zero);
          GC.KeepAlive(onName);
        }
      } finally {
        FreeLibrary(module);
      }
      return found;
    }

    public static int SetIcon(string exe, string icoPath) {
      var doomed = ExistingIcons(exe);

      byte[] ico = File.ReadAllBytes(icoPath);
      if (ico.Length < 6 || BitConverter.ToUInt16(ico, 2) != 1) throw new Exception("not an .ico");
      int count = BitConverter.ToUInt16(ico, 4);
      if (count == 0) throw new Exception("icon has no images");

      // GRPICONDIR: the .ico header, then 14-byte entries that swap the file
      // offset for the resource id of the matching RT_ICON.
      var group = new byte[6 + 14 * count];
      Buffer.BlockCopy(ico, 0, group, 0, 6);
      var images = new byte[count][];

      for (int i = 0; i < count; i++) {
        int src = 6 + 16 * i;
        int size = BitConverter.ToInt32(ico, src + 8);
        int offset = BitConverter.ToInt32(ico, src + 12);
        if (offset < 0 || size < 0 || offset + size > ico.Length) throw new Exception("icon entry out of range");

        images[i] = new byte[size];
        Buffer.BlockCopy(ico, offset, images[i], 0, size);

        int dst = 6 + 14 * i;
        Buffer.BlockCopy(ico, src, group, dst, 12);          // through dwBytesInRes
        BitConverter.GetBytes((ushort)(i + 1)).CopyTo(group, dst + 12);
      }

      IntPtr handle = BeginUpdateResource(exe, false);
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

      try {
        foreach (var e in doomed) {
          IntPtr name = e.Name == null ? (IntPtr)e.Id : Marshal.StringToHGlobalUni(e.Name);
          try {
            UpdateResource(handle, (IntPtr)e.Type, name, e.Lang, null, 0);
          } finally {
            if (e.Name != null) Marshal.FreeHGlobal(name);
          }
        }

        for (int i = 0; i < count; i++) {
          if (!UpdateResource(handle, (IntPtr)RT_ICON, (IntPtr)(i + 1), LANG, images[i], (uint)images[i].Length))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (!UpdateResource(handle, (IntPtr)RT_GROUP_ICON, (IntPtr)1, LANG, group, (uint)group.Length))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      } catch {
        EndUpdateResource(handle, true);
        throw;
      }

      if (!EndUpdateResource(handle, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return count;
    }
  }
}
'@

Copy-Item -Path $src -Destination $dest -Force
$written = [Hangar.Resources]::SetIcon($dest, $icon)

Write-Output "Wrote $written icon sizes into $dest"
