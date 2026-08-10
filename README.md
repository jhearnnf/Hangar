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
afterwards from **Settings** at the foot of the sidebar.

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
in `usage.js`, for the usage bars. Nothing else phones anywhere — `grep -rn "http" *.js
renderer/*.js` is the whole audit. No telemetry, no update check, no analytics.

**Your Claude credentials.** That request needs a token, and it reads the one Claude Code
already keeps at `~/.claude/.credentials.json` (`readToken` in `usage.js`) — or, on macOS
where Claude Code stores it in the login keychain instead, by asking `security` for that
one item (`readKeychainToken`, which spawns nothing on any other platform). It is read in
the main process, fresh per poll, sent only to Anthropic in an `Authorization` header, and
never handed to the renderer — the renderer receives two percentages and a reset time.
Nothing is written back to that file. Delete `usage.js` and the feature simply hides
itself. If you have no credentials file, the bars never appear and no request is made.

**Files it writes.** Three places, all of them yours, and only one of them off by default:

- The backup folder you chose, if you turned backups on at all — a mirror of each project
  (`backup.js`). It shells out to `robocopy /MIR`, or to `rsync -a --delete` off Windows,
  which makes the destination match the source and therefore **deletes files in the
  destination**. `prepare()` refuses any path that is not a plain project name resolving
  inside the backup root, and the setup screen refuses a backup folder that sits inside
  the projects folder, which between them keep the mirror from being pointed at anything
  you care about. It only ever writes outward and never reads the copy back.
- `%APPDATA%\hangar\config.json` — the two answers from the setup screen.
- `%APPDATA%\hangar\window-state.json` — the window position, and nothing else.

On macOS those last two are `~/Library/Application Support/Hangar/` instead.

Creating a project makes an empty folder in the projects root. That is every write.

**Processes it starts.** A pty per tab, running your shell or `claude` (`main.js`), plus
`robocopy` or `rsync` for backups, and on macOS `security` to read the usage token.
Nothing runs at login, nothing installs a service, nothing runs elevated.

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

**Dependencies.** Seven, in `package.json`: `@xterm/*` (the terminal widget VS Code uses),
`node-pty` (the pty binding Windows Terminal and VS Code use), and Electron itself. Pinned
by `package-lock.json`. Scanning this repo does not cover those — `npm install` fetches
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

Two answers, asked on the first launch and editable afterwards from **Settings** at the
foot of the sidebar: the folder your projects live in, and whether to keep backup copies of
them and where. They are saved to `config.json` in Electron's `userData` — per-machine
preference, not something to carry around in the repo, which is the same reasoning that
puts `window-state.json` there.

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

## Projects sidebar

The sidebar lists every directory sitting inside the projects folder — by default the one
Hangar itself sits in, so its siblings are the list. The arrow expands a project to show its terminals; `+` or a
double-click on the name opens a terminal **in that project's directory running `claude`**,
hold shift for a plain shell. Only the arrow expands, so a double-click never has the row
folding away underneath it. Every project starts collapsed — terminals die with the window,
so a project reopened expanded would only ever be an empty list. `Ctrl+Shift+E`
hides the sidebar, and the top tab strip appears in its place — never both at once, since
they would be listing the same terminals twice.

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
| `main.js` | Electron main: window, and one `node-pty` per tab |
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
| `tools/make-exe.ps1` | Stamps the icon into a `Hangar.exe` copy of the Electron binary |
| `tools/make-app.sh` | The same for the Dock — builds `Hangar.app` around this checkout |
| `tools/install-shortcut.ps1` | Creates the shortcuts and repairs taskbar pins |

`npm test` runs the suite (vitest).

Set `HANGAR_DEBUG=1` to forward renderer console output to the terminal you launched from.
