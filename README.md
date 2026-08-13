# Hangar

A minimal tabbed terminal host. Its entire job is to run shells — `claude`, `npm test`,
`git`, anything — in full-screen tabs with scrollback that doesn't lose your history.
No sidebars, no chat panel, no explorer, no status bar.

## Run

```
npm install
npm start
```

Requires Node (for `npm`) and a GPU-capable display. No Visual Studio toolchain needed —
`node-pty` ships N-API prebuilds that load straight into Electron.

There is no build step and no installer. The source you are reading is what runs.

The first launch asks two questions — where your projects live, and whether to keep backup
copies of them — and nothing is written anywhere until you answer. Both are changeable
afterwards from the **Settings** cog at the foot of the sidebar, which also holds the two
things this asks nothing about on a first run: whether your phone may connect, and whether
Hangar starts with Windows.

## On a Mac

`npm install && npm start` is the whole of it there too — `node-pty` ships `darwin-arm64`
and `darwin-x64` prebuilds alongside the Windows ones, so there is still no toolchain to
install. Tabs, the sidebar, scrollback, flow control, terminal naming and the usage bars
all work. Three differences are worth knowing, and each one is a deliberate branch in the
code rather than something that happens to work:

- **Backups run `rsync` instead of `robocopy`.** Same job, same exclusions, same
  destination layout — `rsync -a --delete` is what `robocopy /MIR` is, and both ship with
  their OS. The two are described once each as `ROBOCOPY` and `RSYNC` in `backup.js` and
  nothing else in the file knows which one it has. Their exit codes are not the same
  table and are not read as though they were: 1 is an ordinary "files were copied" under
  robocopy and a failure under rsync, and rsync's 24 — source files that vanished
  mid-copy, i.e. an editor writing a temp file — is forgiven rather than reported red.
  The one thing rsync cannot tell you is whether it had anything to do, so backups there
  say "backed up" where Windows would sometimes say "already up to date".
- **The usage bars read the keychain instead of a file.** Claude Code keeps the same
  credentials JSON in the login keychain on macOS rather than in `~/.claude/.credentials.json`,
  so `usage.js` falls back to `security find-generic-password -s "Claude Code-credentials" -w`
  when the file is absent. The first read puts a system prompt up asking to allow access —
  **Always Allow** answers it once and for good. Deny it, or have no item at all, and the
  bars simply never appear; it waits ten minutes before asking again, so a refusal is
  never a dialog every couple of minutes. The token is read in the main process and sent
  only to Anthropic, exactly as on Windows.
- **Terminals start as login shells.** An app launched from the Dock inherits launchd's
  bare `PATH`, not a terminal's, so `shell.js` passes `-l` on macOS — otherwise the
  profile that puts Homebrew, nvm and `claude` on `PATH` is never read and the first
  thing every tab says is "command not found". Terminal.app does the same.
- **`node-pty`'s spawn helper needs its executable bit back**, which the `postinstall` in
  `package.json` does. Every pty on macOS is spawned through a small helper binary that
  sets the controlling terminal — the shell is only `argv[2]` of it — and node-pty's npm
  tarball records that helper as `0644`, so a fresh install has one that cannot be run.
  Every failure inside that function comes back as the same bare string, `posix_spawnp
  failed.`, naming neither the helper, nor the errno, nor the shell, so the symptom is an
  app whose terminals simply do not open. The binary is fine — the arm64 one is ad-hoc
  signed and runs the moment it is allowed to. `tools/fix-spawn-helper.js` is a chmod with
  a long comment on it, and `main.js` checks the same bit when a spawn fails so a tree
  that skipped scripts still says what is wrong rather than repeating node-pty's string.

There is also a menu bar there, which there is not on Windows. macOS routes ⌘Q, ⌘W and
the clipboard through it, so an app with no menu cannot be quit from the keyboard or paste
into its own text fields. Only those roles are in it — no reload, no dev tools, and no
zoom, since ⌘= and ⌘- are the terminal font size and a menu accelerator would take them
before the renderer saw them. ⌘⇧C/⌘⇧V and right-click copy and paste in the terminal, the
same as on Windows.

The two PowerShell scripts in `tools/` (`npm run shortcut`, `npm run exe`) are Windows
taskbar plumbing and do nothing useful on a Mac. The Dock is `npm run icon` followed by
`npm run app`:

```
npm run icon        # rasterise assets/icon.svg — the .png files are not committed
npm run app         # build Hangar.app from the Electron in node_modules
```

`npm run icon` alone gets you the icon on the Dock tile of a *running* Hangar, which is all
`app.dock.setIcon` in `main.js` can reach. Everything else about the app — the icon before
you click it, the one a Dock pin keeps, and the name in ⌘-tab — comes from the application
bundle that was launched, and launching `electron .` means the bundle is Electron's. That
is the same fact about Windows that `Hangar.exe` exists for, so `tools/make-app.sh` is the
same answer: it copies `Electron.app`, renames the executable, sets the four `Info.plist`
keys that name an app, drops in an `.icns`, and leaves a three-line pointer at this
checkout in `Contents/Resources/app`, which is the first place Electron looks. `ditto`,
`PlistBuddy`, `iconutil` and `codesign` all ship with macOS, so there is still nothing to
install and still no build — the source here is what runs, and the bundle only launches it.

The copy lands beside Electron in `node_modules`, where `npm install` will eventually wipe
it; `npm run app -- /Applications` puts it somewhere that survives, still pointing back
here. Either way, drag it to the Dock and pin that. Re-run it after an Electron upgrade so
the runtime in the bundle matches the one `node-pty` was installed against.

Re-signing at the end is not optional dressing: editing a bundle invalidates its signature,
and Apple Silicon kills a binary whose signature does not check out without saying why.
Ad-hoc (`codesign -s -`) is what Electron's own prebuilt dist carries.

## What it touches on your machine

Hangar spawns shells and copies folders, so several of the things it does look, out of
context, like the things you would scan a download for. They are listed here so you can
check each one against the code rather than take it on trust. Every path below is one
file; none of it is minified or bundled.

**Network.** One outbound URL in the entire app: `https://api.anthropic.com/api/oauth/usage`,
in `usage.js`, for the usage bars. No telemetry, no update check, no analytics.

Inbound is the other half, and it is off until you turn it on. With **Settings → Phone**
ticked, Hangar listens on port 7433 of your local network so the Android app can reach it
(`server.js`), and answers discovery probes on UDP 7434 (`discovery.js`). Both stop the
moment the box is unticked. Neither is reachable from the internet: a connection from any
address that is not private is dropped before it is upgraded, and a socket that has not
paired may send nothing but a pairing code. See *Hangar on your phone* for what pairing is
and what a paired phone can do — which is everything you can do sitting at the machine, so
it is worth reading before ticking the box.

**Your Claude credentials.** That request needs a token, and it reads the one Claude Code
already keeps at `~/.claude/.credentials.json` (`readToken` in `usage.js`) — or, on macOS
where Claude Code stores it in the login keychain instead, by asking `security` for that
one item (`readKeychainToken`, which spawns nothing on any other platform). It is read in
the main process, fresh per poll, sent only to Anthropic in an `Authorization` header, and
never handed to the renderer — the renderer receives two percentages and a reset time.
Nothing is written back to that file. Delete `usage.js` and the feature simply hides
itself. If you have no credentials file, the bars never appear and no request is made.

**Files it writes.** Four places, all of them yours, and only one of them off by default:

- The backup folder you chose, if you turned backups on at all — a mirror of each project
  (`backup.js`). It shells out to `robocopy /MIR`, or to `rsync -a --delete` off Windows,
  which makes the destination match the source and therefore **deletes files in the
  destination**. `prepare()` refuses any path that is not a plain project name resolving
  inside the backup root, and the setup screen refuses a backup folder that sits inside
  the projects folder, which between them keep the mirror from being pointed at anything
  you care about. It only ever writes outward and never reads the copy back.
- `%APPDATA%\hangar\config.json` — the answers from the settings screen.
- `%APPDATA%\hangar\window-state.json` — the window position, and nothing else.
- `%APPDATA%\hangar\devices.json` — the phones you have paired: a name, a date, and the
  key each one holds. Written only when you pair one, deleted when you remove one, and
  never sent anywhere. Deleting the file unpairs every phone.

On macOS those last three are `~/Library/Application Support/Hangar/` instead.

Creating a project makes an empty folder in the projects root. That is every write.

**Processes it starts.** A pty per terminal, running your shell or `claude`
(`sessions.js`), plus `robocopy` or `rsync` for backups, and on macOS `security` to read
the usage token. Nothing installs a service and nothing runs elevated.

**At login.** Nothing, unless you tick *Start Hangar when Windows starts*, which writes a
per-user startup entry through Electron's own API — the same list Task Manager's Startup
tab shows and can disable. Unticking the box removes it. See *Starting with Windows*.

**The one thing that runs by itself.** `npm install` runs the `postinstall` in
`package.json`, which is `tools/fix-spawn-helper.js` — on macOS only, it adds the
executable bit to `node_modules/node-pty/prebuilds/*/spawn-helper`, which npm extracted
without one and which nothing can open a terminal without. One `chmod` on one file inside
`node_modules`, nothing outside it, and an immediate exit on every other platform.

**The launcher scripts are optional.** `npm run shortcut` and `npm run exe` in `tools/` do
the most alarming-looking things in the repo — `make-exe.ps1` copies `electron.exe` and
rewrites the icon resources in the copy, and `install-shortcut.ps1` edits taskbar pin
`.lnk` files and restarts Explorer. `npm run app` is the Mac's version of the same idea and
looks much the same from outside: it copies `Electron.app`, edits the copy's `Info.plist`
and re-signs it ad-hoc. All three are cosmetic, all three are commented scripts you can
read end to end, and the app runs fine without ever invoking any of them. See *Why there is
a Hangar.exe* below for why they exist. Each writes in exactly one place — beside Electron
in `node_modules`, plus the Desktop and Start Menu for the Windows shortcut, and
`/Applications` for the Mac bundle if you ask for it there.

**Dependencies.** Eight, in `package.json`: `@xterm/*` (the terminal widget VS Code uses),
`node-pty` (the pty binding Windows Terminal and VS Code use), `ws` (the WebSocket server
the phone connects to — pure JavaScript, no dependencies of its own), and Electron itself.
Pinned by `package-lock.json`. The Android app has its own `mobile/package.json` and its
own `node_modules`, so nothing Capacitor needs is installed for a desktop-only checkout. Scanning this repo does not cover those — `npm install` fetches
them from npm at install time, the same trust surface as any Node project. `npm ci` will
install exactly the locked versions.

## Desktop shortcut

```
npm run shortcut
```

Drops `Hangar.lnk` on the Desktop and in the Start Menu — double-click to launch, no
terminal in the way. It points at this source tree rather than at a packaged build, so
whatever is checked out here is what launches; nothing to rebuild after an edit.

The icon is `assets/icon.svg`. `npm run icon` re-rasterises it into `assets/icon-*.png`
and packs `assets/icon.ico` (16 through 256px), rendering the SVG through Electron itself
so there is no image toolchain to install.

### Why there is a Hangar.exe

Windows reads a taskbar button's icon out of the **running executable**. It ignores the
window icon Electron sets from `icon:`, and it ignores the shortcut's icon too — so
launching the stock `electron.exe` puts an Electron atom on the taskbar no matter what
the app or the shortcut says.

So `npm run exe` (which `npm run shortcut` runs for you) copies `electron.exe` to
`Hangar.exe` beside it and rewrites that copy's icon resources, and the shortcuts point
there. The copy stays inside `node_modules\electron\dist`, which is what keeps this
packaging-free — every DLL Electron needs is already sitting there, and the app path
still arrives as `argv`. It uses the in-box Win32 resource APIs rather than `rcedit`, for
the same reason `tools/make-icon.js` packs its own `.ico`: nothing extra to install.
`npm install` and Electron upgrades wipe the copy — rerun either script.

Taskbar **pins** are separate `.lnk` files, and a window groups under whichever pin
matches it, so a pin made back when Hangar launched through `electron.exe` keeps showing
the Electron icon. `npm run shortcut` repoints those too and restarts Explorer, which is
the only way it rereads them. It repoints rather than deletes even duplicates: the pin
order lives in a registry blob that merely references these files, so deleting one leaves
a slot Explorer can't resolve — a blank page on the taskbar that survives restarts. Unpin
spares by right-clicking them.

## Why it doesn't drop output

Two things Cursor's embedded terminal gets wrong:

- **Scrollback** is 100,000 lines here. Cursor defaults to roughly 1,000, which is why a
  long test run scrolls your earlier history into the void.
- **Flow control**: when output arrives faster than the renderer can paint it, Hangar
  pauses the pty (`HIGH_WATER` in `renderer/renderer.js`) and resumes once the backlog
  drains. Without this, a burst of output overruns the buffer and characters vanish
  mid-word.

### Scrollback and full-screen TUIs

Scrollback catches everything a program *prints*. It cannot catch what a full-screen TUI
draws, and `claude` is one: it switches to the alternate screen buffer at startup and
repaints inside it, so its conversation never scrolls and never enters scrollback. No
terminal can scroll back through a running `claude` session — the earlier lines were never
sent as scrolled-off text. Claude Code keeps that history itself: `/resume`,
`claude --continue`, and the transcripts under `~/.claude/projects`.

What Hangar does guarantee is that a TUI can't *destroy* the history around it. `main.js`
spawns ptys against the newer ConPTY bundled with node-pty, because the one built into
Windows 10 swallows the alternate screen buffer — `claude` then paints over the normal
buffer and takes a screenful of real scrollback with it. With the alt screen passed
through, everything printed before `claude` started is still there when it exits.

## Settings

The cog at the foot of the sidebar — and the one at the right-hand end of the tab strip,
which is what you see when the sidebar is hidden, since settings must not be reachable only
from a panel you can hide. Four groups behind it:

| Group | What is in it |
| --- | --- |
| **Projects** | The folder your projects live in |
| **Backups** | Whether to keep backup copies of them, and where |
| **Phone** | Whether a phone may connect, on which port, and which phones may |
| **Startup** | Whether to start with Windows, and whether to start into the tray |

A first run is the exception: it shows the first two on their own with no tab strip,
because until someone has said where their projects are, nothing else means anything. All
of it is saved to `config.json` in Electron's `userData` — per-machine preference, not
something to carry around in the repo, which is the same reasoning that puts
`window-state.json` there.

Everything takes effect on **Save** rather than at the next launch: the startup entry is
written, the server comes up or goes down, and the tray icon appears or disappears. A
settings screen that needed a restart to mean anything would be a settings screen nobody
believed.

`HANGAR_PROJECTS_ROOT` and `HANGAR_BACKUP_ROOT` still work and still win, field by field,
over whatever was saved. They are the escape hatch for a machine where the saved answer is
wrong and the UI is not reachable, and they are how the tests point everything at a temp
folder. A field the environment has taken over is shown in the setup screen as locked
rather than as something editable that would not take effect. Setting `HANGAR_BACKUP_ROOT`
turns backups on as well as relocating them, since otherwise it would do nothing at all on
a machine that had them off.

The order is env var, then saved answer, then default — resolved per field in `config.js`,
so one variable never discards the rest. A config file that cannot be read, or that is
missing the projects root, counts as a first run and asks again rather than quietly
running on defaults nobody chose.

## Hangar on your phone

The Android app in `mobile/` is a second window onto the same Hangar. It lists the same
projects, shows the same terminals — the ones already running, not copies of them — and
types into them. The PC does all the work; the phone is a viewer with a keyboard attached.
Same house only: the phone talks straight to the PC over your router, and there is no
account, no cloud and no outbound connection anywhere in it.

### The terminals moved

This is the change underneath everything else. A terminal used to belong to the window: the
window created it, held its scrollback, and killed it on close. That works for exactly one
screen, so terminals now live in the main process (`sessions.js`) and the window is one
viewer of them among others. Three things follow, and the first two are improvements to the
desktop app whether or not you ever install the phone one:

- A terminal survives the window being closed to the tray.
- A terminal opened on the phone appears in the sidebar, with its name and its coloured
  dot, and one opened at the desk appears on the phone.
- Naming and stage detection moved with it. They happen once, in the main process, so the
  two screens cannot end up calling one terminal two different things.

Each terminal keeps the last 512KB of what it printed. A viewer attaches with the sequence
number it last saw and is sent only what came after it, which is the whole of the resume
protocol — it is what makes unlocking your phone show a live terminal rather than a blank
one. What no replay can reconstruct is a full-screen TUI's current screen, because that was
painted into a buffer rather than printed: so on attach, a session on the alternate screen
gets its width nudged a column out and back, which is how tmux asks a program to redraw
itself and works on `claude` too.

### Turning it on

**Settings → Phone**, tick *Let my phone connect*, Save. Then *Show a code* and type the six
characters into the phone once.

Three things do the security, and all three are in `server.js`:

- **Off unless switched on.** No setting, no listener, no port.
- **Local addresses only.** A connection from anything that is not a private address is
  dropped before the socket is upgraded — a forwarded port cannot turn this into something
  the internet can reach.
- **Paired or nothing.** An unpaired socket may send exactly one kind of message, a pairing
  code, and is closed after thirty seconds if it does not. The code lasts five minutes and
  one use, is spent whether the attempt succeeded or not, and dies after five wrong tries.
  What the phone gets back is a 32-byte key it keeps; the code is never needed again.
  Settings lists every phone holding one, with a Remove button.

A paired phone can open terminals and type into them, which is the same as sitting at the
keyboard. That is the point of it, and it is why pairing needs someone at the PC.

The phone normally finds the PC by itself: it broadcasts one UDP packet and Hangar answers
with its name and port (`discovery.js`, and the small Java plugin in the Android project,
which exists because a WebView has no UDP). Settings also shows the addresses to type by
hand when that fails. Pointing a phone browser at `http://<pc>:7433` serves the same client
and is the quickest way to find out whether the PC half is working.

### Over a mesh VPN, and away from home

If the machine is on Tailscale or something like it, Settings lists that address too, greyed
out and tagged `VPN`. It is worth telling apart from the others: it works from a phone on
the same mesh and from nowhere else, and it fails by going *silent* rather than by refusing
— which is how a firewall, the wrong wifi and a switched-off PC all fail too, so two
undistinguished addresses in a row is a coin toss nobody knows they are making. Discovery
never finds it, because no mesh carries a broadcast; type it in.

It is also the way out of a LAN that will not cooperate. A mesh address arrives on its own
interface, so a firewall rule scoped to the local subnet — including one written to keep
other devices on the router out — simply does not apply to it. And unlike the LAN route it
keeps working when you leave the house. The firewall button allows `100.64.0.0/10` alongside
the local subnet, but only on a machine that actually has a mesh interface: widening a rule
for a route that does not exist is exactly what a firewall rule should never do.

### When the phone says nothing happens

Two failures, told apart by how long they take (`client.js`), because they want opposite
fixes and a WebSocket reports both as the same bare close:

- **Refused, in milliseconds.** Something is at that address with nothing listening on the
  port. Hangar is not running, phone access is not ticked, or the port is wrong.
- **Silence.** The packets are being dropped rather than answered. Windows Firewall, a
  guest wifi that keeps devices apart, or the wrong address.

For the first of those the PC can usually say what is wrong itself, and `firewall.js` is
the part that does. Windows asks once, the first time Hangar listens, and answering that
prompt with the box for this kind of network unticked does not decline to add a rule — it
writes a **Block** one, permanently, and never asks again. After that everything looks
correct: the port listens, `netstat` agrees, and every packet is dropped. So Settings reads
Hangar's own rules back (`netsh` can list them without elevation) and says so, with a button
that asks Windows for permission to put it right.

It also looks for the nastier kind: an enabled inbound Block rule that names **no program**
at all. Windows lets a block beat any allowance beside it, however specific, so one
hand-written "block everything arriving from the network" rule outranks every allowance made
for the phone while never mentioning Hangar — nothing about the phone panel looks wrong, and
there is nothing to find unless you already know to look. Those are named and never touched:
somebody wrote that rule on purpose, and quietly removing it to make a terminal app work
would be an appalling thing to do.

### Building the APK

```
cd mobile
npm install
npm run icon        # launcher icons, rasterised from assets/icon.svg
npm run android     # sync www, then gradlew assembleDebug
```

Out comes `mobile/android/app/build/outputs/apk/debug/app-debug.apk`, which you sideload.
Debug-signed on purpose — this is a personal tool on your own network, not something going
near a store, and a debug build needs no keystore to look after. `android/local.properties`
and `gradle.properties` name the SDK and the JDK on this machine; both are per-machine, and
`local.properties` is gitignored.

`mobile/www` is the whole app and there is no bundler — the same rule as the desktop side.
`tools/sync-www.js` copies xterm out of the desktop's `node_modules` rather than installing
a second one, so the phone and the PC can never draw the same escape sequences two
different ways.

### The input problem

A phone keyboard is a bad terminal: no Esc, no Tab, no arrows, autocorrect fighting the
TUI, and every keystroke crossing wifi to a program that redraws on each one. So the normal
way to type is a compose box — write the whole prompt, send it in one go — with a strip
above it for the keys the keyboard lacks, including the 1/2/3 that answer Claude's
permission prompts. The ⋮ menu switches to raw typing for the times you need single keys.

A phone is also far narrower than a desktop terminal, and a terminal can only be one width,
so one viewer owns it: the PC by default, with the phone drawing the same grid at whatever
text size makes all of it fit. One tap in the ⋮ menu hands the width to the phone instead,
and the PC letterboxes until you hand it back. It goes back on its own when the phone
disconnects.

### Resuming from the phone

Holding a project down for half a second brings up the claude sessions it has already had —
the same list as the right-click menu in the PC's sidebar, in a bottom sheet, and answered
by the same reader on the PC. Tapping one opens a terminal running `claude --resume` on it.
A session that is already running is dimmed with a pulsing green **live** beside it; tapping
it says why rather than doing nothing, since there is no tooltip to hover on a phone.

The sheet goes up the moment the press registers, saying "Looking…" until the answer
crosses the wifi, and the reply carries the project path back with it — half a second is
long enough to have let go and pressed a different project, and the phone has to be able to
tell which answer it is looking at.

A hold is not a gesture anyone discovers, so the tap and the `+` still do what they always
did: tap opens the project's terminal, `+` offers a plain shell or a backup.

## Starting with Windows

**Settings → Startup**, two separate tick boxes:

- **Start Hangar when Windows starts** puts it in the ordinary per-user startup list — the
  one the Startup tab of Task Manager shows and can turn off. No service, no scheduled
  task, nothing elevated; unticking the box takes the entry straight back out. The entry is
  rewritten on every launch as well as on save, so one that points at a checkout which has
  since moved repairs itself rather than failing silently every morning. It points at
  `Hangar.exe` where `npm run exe` has made one, so the startup list says Hangar rather
  than Electron.
- **Start minimised to the tray** brings Hangar up with no window at all, just an icon by
  the clock, so the terminals and the phone connection are there without a window jumping in
  front of what you were doing. The flag that means this is written into the startup entry
  rather than read from the config, because "start minimised" has to mean *when Windows
  started it* — otherwise opening Hangar yourself would appear to do nothing.

With the tray icon on, closing the window hides it instead of quitting and the terminals
keep running; **Quit Hangar** in the tray menu is the way out. With it off, closing the
window is the end of Hangar exactly as it always was.

Hangar also takes a single-instance lock now. There was no way to end up with two before —
you launched it yourself, and a second one was a mistake you could see — but Windows
launching it at login means a double-click half an hour later would otherwise be a second
copy losing a fight over the port, silently. The second copy hands its launch to the first,
which shows itself.

## Projects sidebar

The sidebar lists every directory sitting inside the projects folder — by default the one
Hangar itself sits in, so its siblings are the list. The arrow expands a project to show its terminals; `+` or a
double-click on the name opens a terminal **in that project's directory running `claude`**,
hold shift for a plain shell. Only the arrow expands, so a double-click never has the row
folding away underneath it. Every project starts collapsed and is expanded by opening a
terminal in it, or by the arrow. `Ctrl+Shift+E`
hides the sidebar, and the top tab strip appears in its place — never both at once, since
they would be listing the same terminals twice.

### Picking up where you left off

Right-clicking a project lists the claude sessions it has already had, newest first, named
after the first thing you asked each one and dated by the last. Clicking one opens a
terminal running `claude --resume` on it, so the conversation carries on rather than
starting again.

None of that is Hangar's own record — it is claude's, read on the click out of two files it
keeps in `~/.claude`: `history.jsonl` for the prompts, and one file per running process in
`sessions/` for what is live right now. Nothing is written back, only the last couple of
megabytes of the history is read, and anything unrecognised in either file leaves the menu
empty rather than breaking the sidebar; both belong to Claude Code and neither is a promise
to us.

A session that is already open — in Hangar, in another window, anywhere on the machine —
is listed but greyed out, with a pulsing green **live** beside it. Opening it again would
put two claudes on one transcript, both appending. Close it and it becomes clickable.

The list skips the empty session ids that `/resume` leaves behind: typing `/resume` starts
a session, records that one word against it and immediately jumps somewhere else, so the
menu would otherwise be half full of rows that all said "/resume" and led to nothing.

The phone has the same list behind a long press — see [Resuming from the
phone](#resuming-from-the-phone). One reader on the PC answers both.

A terminal that cannot start says so in the tab it would have been. A shell that fails to
spawn, and one that exits within a second and a half of starting — a shell that isn't
there, a login profile that bails, a `claude` that dies on startup — both used to leave
nothing behind at all: the spawn error went nowhere and the exit closed the tab again
within milliseconds, so opening a terminal was indistinguishable from clicking on nothing.
Now the tab stays, carrying the shell that was tried, the arguments it was tried with, the
directory it was tried in, and the exit code. `Ctrl+Shift+W` closes it. Exiting a shell
you have actually been using still closes its tab, as it always did — nobody types `exit`
inside a second and a half.

## New projects

Double-clicking the **PROJECTS** header opens a modal over the whole window — nothing
behind it takes a click or a keystroke until it is dealt with, including the shortcuts,
which return early rather than acting on a window whose state you cannot see. `Esc`, the
Cancel button, or a click on the backdrop dismisses it; `Enter` creates. Creating makes an
empty folder in the projects root and rebuilds the tree from a fresh listing, so what
appears is what is really on disk.

`project-name.js` holds the rules for what the folder may be called, and both sides run
them: the modal on every keystroke, to keep the button and the message under the field
honest, and `main.js` again before it calls `mkdir`, because that is the side that touches
the disk. Beyond what Windows itself refuses (`<>:"/\|?*`, control characters, a trailing
dot, the device names) it also turns down anything the sidebar would then filter out —
a leading dot, or `node_modules` and the rest of `PROJECT_IGNORE` — since a project that
is created and never appears reads as the button having done nothing. Names already taken
are refused case-insensitively, the way the filesystem underneath sees them.

## Terminal names and colours

Terminals rename themselves after whatever you asked for, from two sources.

The good one is the program itself. Claude Code publishes its session summary as the
terminal title — the same line it shows in its own header, and what `/rename` rewrites —
and ConPTY turns that into an OSC sequence xterm hands us. `nameFromTitle` drops the
spinner frame it is prefixed with (`✳`, `⠂`, `⠐`) and ignores titles that only name the
program, like "Claude Code" or "Windows PowerShell". A shell that titles itself after its
working directory is cut down to the last segment. Once a real title arrives it owns the
tab.

Until then — a plain shell, or claude before it has summarised anything — the name is
guessed from what you typed. Keystrokes are folded into submitted lines
(`createInputCapture`), then stripped of stopwords, with file paths and camelCase
identifiers scored above prose (`nameFromPrompt`) — so "can you fix the login redirect"
becomes **fix login redirect**. Slash commands and bare menu numbers are ignored rather
than named after.

Set `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` and the guess is all you get.

The coloured dot tracks which stage the work is in:

| Colour | Stage | Detected by |
| --- | --- | --- |
| 🔴 red | Planning | a prompt was just submitted, or read-only tool calls — `Read(`, `Grep(`, `Task(` |
| 🟠 orange | Implementing | mutating tool calls — `Edit(`, `Write(`, `MultiEdit(` |
| 🟡 yellow | Testing | a test runner — `npm test`, `vitest`, `pytest`, `cargo test`, … |
| 🟢 green | Ready / finished | three seconds of silence |

This is pattern matching over terminal output, not a real integration, so treat it as a
strong hint rather than gospel. Whichever signal appears *latest* wins, because a TUI
appends its newest activity at the bottom. All of it lives in one editable table —
`SIGNALS` in `renderer/classify.js` — so retuning it is a one-line change, and
`test/classify.test.js` covers the behaviour.

## Backups

Off unless you turn them on, since they are the one thing here that writes outside your
projects folder.

Projects live on the local disk rather than inside a sync folder, because a directory a
coding agent is actively writing into is a bad thing to hand a file-sync client: `.git`
gets uploaded as loose files in arbitrary order and can arrive corrupt, `node_modules`
buries the indexer, and a file the client has open mid-upload fails the write that was
trying to land on it.

So instead of syncing live, Hangar mirrors each project into `<backup folder>/<project>` at
the moments nothing is happening:

- A project goes green (or its last terminal closes) and **stays that way for 60 seconds**.
  Green alone is only three seconds of silence, which happens constantly between tool
  calls — any further output restarts the countdown.
- Only projects written to since their last backup are copied.
- On quit, anything still waiting is copied detached, so closing the window stays instant.

Which is why the default the setup screen offers is a folder *inside* Dropbox where there
is one: the copy happens at a quiet moment, and Dropbox then syncs a tree nothing is
writing to. Any other folder works the same — an external drive, a network share, a second
disk. There is nothing Dropbox-specific in `backup.js`.

The copy itself is `robocopy /MIR` on Windows and `rsync -a --delete` elsewhere, excluding
`node_modules`, `.git`, build output and caches (`EXCLUDE_DIRS` in `backup.js`). The badge
on the project row says where the copy stands — a green tick once it is safely up, blue
arrows while it is not (turning while the copy actually runs), a red mark if it failed. Hover it for the reason. Projects
untouched this session carry no badge at all, and with backups off no row carries one.

**This is a restore-from backup, not a sync.** It only ever writes outward, and mirroring
makes the destination match the source exactly — anything edited in the backup copy is gone
on the next run, and anything sitting in it that is not in your projects folder gets
deleted. Point it at a folder that holds nothing else; the setup screen refuses one inside
the projects folder, which would otherwise copy a tree into itself without bound. Because
`.git` is excluded you get the project as it last stood, with no history.

## Claude usage bars

Above the hint line at the foot of the sidebar sit two thin bars: how much of the rolling
5-hour window and of the week you have used, with a countdown to the next reset. They turn
amber past 75% and red past 90%.

Running one of them out is different in kind from filling it up: until that window resets,
no project here can be worked on. So at 100% the project list itself gently pulses a red
mist, and the note underneath names the window that went — `5h limit reached · resets in
2h 41m`. Whichever project you were about to reach for is already under the glow, which a
full bar at the foot of the sidebar cannot say. It holds through a failed poll, and stops
moving (without going away) if the machine asks for reduced motion.

The figures come from the same endpoint Claude Code's own `/usage` screen reads, using the
OAuth token Claude Code already keeps in `~/.claude/.credentials.json`. That file is read
in the main process only, fresh on each poll — the renderer is handed two percentages and a
reset time, never the token. Point it elsewhere with `HANGAR_CLAUDE_CREDENTIALS`.

Polled at most once every two minutes, because the endpoint rate-limits. When a poll fails
the last good figures stay on screen with an `as of HH:MM` note rather than blinking out,
so a busy endpoint never looks like zero usage.

**The endpoint is private and undocumented.** Its response carries internal codenames next
to the real fields, which is a fair sign its shape is nobody's promise to us, so `usage.js`
treats anything it cannot read as "no bars" and hides the whole block. A future Claude Code
release is allowed to break this feature; it is not allowed to break Hangar. The bars are
also absent for anyone not signed in with a subscription — API-key, Bedrock and Vertex
setups have no credentials file to read.

Being part of the sidebar, they hide with it on `Ctrl+Shift+E`.

## Keys

Windows Terminal conventions, so plain `Ctrl+C`, `Ctrl+W`, `Ctrl+T` etc. always reach the
shell rather than being stolen by the app.

| Key | Action |
| --- | --- |
| `Ctrl+Shift+T` | New terminal in the current project |
| `Ctrl+Shift+W` | Close terminal |
| `Ctrl+Shift+E` | Show / hide the projects sidebar |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+1` … `Alt+9` | Jump to tab |
| `Ctrl+Shift+F` | Find in scrollback |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Shift+K` | Clear scrollback |
| `Ctrl+Shift+B` | Zen — hide sidebar and tab bar both |
| `F11` | Real full screen |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size |
| `Shift+Enter` | Newline in the terminal, rather than submitting |

Right-click copies the selection if there is one, otherwise pastes. Middle-click a tab to
close it.

`Shift+Enter` is worth a word. A terminal sends a bare carriage return for both it and a
plain `Enter`, so nothing on the far end can tell them apart and a multi-line prompt is
impossible to type. Hangar sends `ESC`+`CR` instead — the same sequence Claude Code's own
`/terminal-setup` teaches other terminals to send for this, and one a shell reads as a
meta-return it has nothing to do with.

## Layout

| File | Role |
| --- | --- |
| `main.js` | Electron main: window, tray, startup entry, and the wiring between the rest |
| `sessions.js` | Every running terminal — the ptys, their scrollback, names and stages |
| `server.js` | The local server a phone talks to |
| `devices.js` | Pairing codes and the keys paired phones hold — pure, tested |
| `discovery.js` | Answering "any Hangars out there?", and which addresses to offer |
| `startup.js` | What the Windows startup entry should point at — pure, tested |
| `mobile/` | The Android app: `www/` is the client, `android/` is the Capacitor shell |
| `shell.js` | Shell selection, argv building, project scanning — all pure, all tested |
| `window-state.js` | Where the window was last time — pure geometry, tested |
| `config.js` | The setup screen's answers — resolution order and path guards, tested |
| `backup.js` | The project mirror — path guards, robocopy and rsync argv, tested |
| `preload.js` | `contextBridge` surface — pty IPC plus Electron clipboard |
| `renderer/classify.js` | Naming and stage detection — pure, tested, no DOM |
| `renderer/renderer.js` | Sidebar, tabs, xterm instances, flow control, shortcuts |
| `renderer/style.css` | The whole UI, such as it is |
| `assets/icon.svg` | Icon source — everything else in `assets/` is generated from it |
| `tools/make-icon.js` | Rasterises the icon and packs the `.ico` |
| `tools/fix-spawn-helper.js` | The `postinstall` chmod that makes ptys work on macOS |
| `tools/make-exe.ps1` | Stamps the icon into a `Hangar.exe` copy of the Electron binary |
| `tools/make-app.sh` | The same for the Dock — builds `Hangar.app` around this checkout |
| `tools/install-shortcut.ps1` | Creates the shortcuts and repairs taskbar pins |

`npm test` runs the suite (vitest).

Set `HANGAR_DEBUG=1` to forward renderer console output to the terminal you launched from.
