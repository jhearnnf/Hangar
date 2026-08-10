#!/bin/sh
# Wraps Electron in a Hangar.app, so the Dock has something of ours to launch.
#
#   npm run app                 # beside Electron, in node_modules
#   npm run app -- /Applications
#
# The Dock takes an icon, and a name, from the application bundle it launched.
# It ignores the window icon Electron sets from `icon:`, and `app.dock.setIcon`
# only reaches the tile of an app that is already running — so a Dock item made
# from the stock Electron.app is an Electron atom called Electron before the
# click and, once the pin is made, forever after. The only thing that changes it
# is a bundle carrying the icon and the name itself. This is make-exe.ps1's
# problem exactly, one platform over.
#
# So: copy Electron.app, rename its executable, rewrite the four Info.plist keys
# that name an app, drop an .icns beside them, and leave a three-line pointer at
# this checkout in Contents/Resources/app - which is the first place Electron
# looks for an app to run, ahead of the default one it would otherwise show. The
# source here is still what runs; the bundle is a launcher, not a build.
#
# Nothing outside macOS is needed to do any of it: ditto, PlistBuddy, iconutil
# and codesign all ship with the OS, the same way make-exe.ps1 uses the resource
# APIs already in Windows rather than rcedit.
#
# `npm install` and Electron upgrades wipe a copy made in node_modules - run
# this again. A copy made in /Applications survives both, and keeps working
# because it points back here, but rerun it after an Electron upgrade so the
# runtime in the bundle matches the one node-pty was installed against.

set -e

case "$(uname -s)" in
  Darwin) ;;
  *) echo "make-app.sh builds a macOS bundle - on Windows the equivalent is 'npm run exe'." >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
dist="$root/node_modules/electron/dist"
src="$dist/Electron.app"

target=${1:-$dist}
dest="$target/Hangar.app"

[ -d "$src" ] || { echo "Electron not found at $src - run 'npm install' first." >&2; exit 1; }
[ -d "$target" ] || { echo "No such folder: $target" >&2; exit 1; }

# The pointer below is JavaScript, and quoting a path into it safely is not
# worth the guesswork. Refuse the two characters that would need it.
case "$root" in
  *\'*|*\\*) echo "This checkout's path contains a quote or a backslash: $root" >&2; exit 1 ;;
esac

# rm -rf on a path built from an argument, so make sure of what it is first.
case "$dest" in
  */Hangar.app) ;;
  *) echo "Refusing to write $dest" >&2; exit 1 ;;
esac

# ------------------------------------------------------------------ the icon
#
# icns entry names are fixed, and each one has to be the size its name claims,
# so the mapping is written out rather than looped. @2x is the retina copy of
# the size below it: the Dock draws 128 on a non-retina display and reads
# icon_128x128@2x for the same slot on a retina one.

icons="$root/assets"
for size in 16 32 64 128 256 512 1024; do
  [ -f "$icons/icon-$size.png" ] || {
    echo "Missing $icons/icon-$size.png - run 'npm run icon' first." >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
iconset="$work/hangar.iconset"
mkdir -p "$iconset"

cp "$icons/icon-16.png"   "$iconset/icon_16x16.png"
cp "$icons/icon-32.png"   "$iconset/icon_16x16@2x.png"
cp "$icons/icon-32.png"   "$iconset/icon_32x32.png"
cp "$icons/icon-64.png"   "$iconset/icon_32x32@2x.png"
cp "$icons/icon-128.png"  "$iconset/icon_128x128.png"
cp "$icons/icon-256.png"  "$iconset/icon_128x128@2x.png"
cp "$icons/icon-256.png"  "$iconset/icon_256x256.png"
cp "$icons/icon-512.png"  "$iconset/icon_256x256@2x.png"
cp "$icons/icon-512.png"  "$iconset/icon_512x512.png"
cp "$icons/icon-1024.png" "$iconset/icon_512x512@2x.png"

iconutil -c icns "$iconset" -o "$work/hangar.icns"

# ---------------------------------------------------------------- the bundle

rm -rf "$dest"
# ditto rather than cp -R: it keeps the symlinks inside the frameworks as
# symlinks, and a framework whose Versions/Current has been copied into a real
# directory is a framework that no longer loads.
ditto "$src" "$dest"

mv "$dest/Contents/MacOS/Electron" "$dest/Contents/MacOS/Hangar"
cp "$work/hangar.icns" "$dest/Contents/Resources/hangar.icns"

plist="$dest/Contents/Info.plist"
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist" >/dev/null
}

set_key CFBundleExecutable  Hangar
set_key CFBundleName        Hangar
set_key CFBundleDisplayName Hangar
set_key CFBundleIconFile    hangar
# The same id main.js gives Windows for the taskbar. Nothing here depends on it,
# but two apps sharing com.github.Electron is how the Dock ends up treating
# Hangar and any other stock-Electron app as one thing.
set_key CFBundleIdentifier  com.jameshangar.hangar

# Electron looks in Contents/Resources for app.asar, then app, then falls back
# to the default app it ships. A package.json naming a main file is the whole
# interface, and that main file only has to hand over to this checkout's:
# require resolves node-pty and the rest from the node_modules beside it, and
# __dirname inside it is this folder, which is what every path in main.js is
# relative to.
mkdir -p "$dest/Contents/Resources/app"
cat > "$dest/Contents/Resources/app/package.json" <<'EOF'
{ "name": "hangar", "main": "main.js" }
EOF
cat > "$dest/Contents/Resources/app/main.js" <<EOF
// Hangar runs from its checkout; this bundle only launches it.
require('$root/main.js');
EOF

# Editing a bundle invalidates its signature, and macOS on Apple Silicon will
# not launch a Mach-O whose signature does not check out - it is killed on
# sight with nothing said about why. Ad-hoc (-s -) is what Electron's own
# prebuilt dist carries, so this puts back what was there.
codesign --force --deep --sign - "$dest" >/dev/null 2>&1 || {
  echo "codesign failed - the bundle will not launch. Is the Xcode command line tools' codesign on PATH?" >&2
  exit 1
}

# Finder caches an icon against the bundle's mtime.
touch "$dest"

echo "Built $dest"
echo "Drag it to the Dock. If the old icon lingers there, 'killall Dock'."
