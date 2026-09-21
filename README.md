# Statusmith

[![Release](https://img.shields.io/github/v/release/Londopy/statusmith?label=release&color=5865f2)](https://github.com/Londopy/statusmith/releases/latest)
[![Build](https://github.com/Londopy/statusmith/actions/workflows/build.yml/badge.svg)](https://github.com/Londopy/statusmith/actions/workflows/build.yml)
[![Downloads](https://img.shields.io/github/downloads/Londopy/statusmith/total?color=23a559)](https://github.com/Londopy/statusmith/releases)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-informational)](#install)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app)
[![Nexium SDK](https://img.shields.io/badge/SDK-Nexium-8A2BE2)](#nexium-sdk)
[![License: MIT](https://img.shields.io/github/license/Londopy/statusmith)](LICENSE)

A tray app for writing your own Discord **Rich Presence** — the "Playing …" card with
details, state, images, timers, party size and buttons — and switching between saved presets
from the tray. Windows, macOS and Linux.

It talks to the Discord client already running on your machine over its local Rich Presence
pipe, exactly the way a game does. It never sees your account token.

![Statusmith](docs/screenshot.png)

## Features

- **Applications as headlines.** Each Discord application you create is one headline
  ("Playing *life*", "Listening to *lofi*", "Competing in *the rewrite*"). Pick the application
  in the top bar and you see just its presets.
- **Presets** with details, state, large/small image, hover text, party size and up to two link
  buttons. Edits save as you type; double-click a preset to apply it.
- **Live preview** that mimics the Discord profile popout, with your own avatar once connected.
- **Activity types**: Playing, Listening, Watching, Competing.
- **Live variables**, re-rendered every 15 seconds while a preset is applied:

  | Variable | Example |
  |---|---|
  | `{time}` `{time12}` | `14:05` / `2:05 PM` |
  | `{date}` `{day}` | `Sep 20` / `Saturday` |
  | `{uptime}` | time since Statusmith started, `2h 14m` |
  | `{boot}` `{awake}` | when the PC booted (`08:30`) / how long it's been up (`6h 40m`) |
  | `{battery}` | `87%` |
  | `{random:a\|b\|c}` | one of the options, re-rolled each refresh |
  | `{sh:command}` | first line a shell command prints, e.g. `{sh:git branch --show-current}` |
  | `{nx:file.nx}` | first line a [Nexium](https://github.com/Londopy/nexium) program prints — see `examples/nexium/` |

- **Timers**: elapsed since apply, elapsed since launch, or a countdown that can restart when it
  ends. *Listening + countdown* draws a Spotify-style progress bar.
- **Images**: paste any `https://` image link, or use asset keys from the application's
  *Rich Presence → Art Assets* (they're offered as suggestions).
- **Rotation**: cycle through chosen presets every N seconds, across applications. Click
  *Rotation* in the sidebar to see what's in the cycle, what's playing now, and to add, drop or
  reorder presets from any application.
- **Tray**: apply any preset from the menu (one submenu per application), start/stop rotation,
  clear, quit. Closing the window hides it.
- **Starts with Windows** (hidden in the tray) by default — turn it off in Settings.
- **Auto-reconnect** when Discord restarts and **restore last presence** on launch — the elapsed
  timer even survives a reboot.
- **Pause when idle**: optionally clear the presence after N minutes without input and bring it
  back on the first keypress.
- **Auto-update**: checks this repository's releases on launch and every six hours, and installs
  the signed update in place when you say so.
- **Export / import** presets as JSON, keyboard shortcuts (`Ctrl+Enter` apply, `Ctrl+N` new,
  `Ctrl+D` duplicate, `Ctrl+↑/↓` reorder, `Delete`), README and license readable in-app.
- **In-app wiki** (`F1`, the `?` button, or About → Wiki): searchable pages on every feature,
  troubleshooting included. The same pages are in [`docs/wiki/`](docs/wiki/).

## Install

Grab the build for your machine from the [latest release](https://github.com/Londopy/statusmith/releases/latest):

| System | Download | Notes |
|---|---|---|
| Windows 10/11, 64-bit | `Statusmith_<v>_x64-setup.exe` | per-user install, no admin prompt; shows the license, adds a Start Menu entry |
| Windows, 32-bit | `Statusmith_<v>_x86-setup.exe` | same installer for 32-bit Windows |
| Windows on ARM | `Statusmith_<v>_arm64-setup.exe` | Surface Pro X and friends |
| macOS 10.15+, Intel or Apple Silicon | `Statusmith_<v>_universal.dmg` | one universal app. It isn't notarized: the first time, right-click → Open, or run `xattr -dr com.apple.quarantine /Applications/Statusmith.app` |
| Linux x86_64 | `Statusmith_<v>_amd64.AppImage` or `.deb` | AppImage is what the in-app updater replaces; `.deb` for Debian/Ubuntu |
| Linux ARM64 | `Statusmith_<v>_aarch64.AppImage` or `_arm64.deb` | Raspberry Pi 5, ARM laptops |

There is no 32-bit macOS (Apple dropped it in 2019) and no current distro ships a 32-bit Linux
desktop, so those two aren't built.

Every release ships `SHA256SUMS.txt`; the release page shows how to check a download against it.

Statusmith opens with a short welcome and asks for your first Discord application (below).
Updates arrive inside the app: a banner offers *Install and restart* when a new release is out.
Every update is signed; the app only installs a build whose signature matches the key in
`src-tauri/tauri.conf.json`.

Platform notes: *pause when idle* works on Windows and macOS (Linux has no portable idle API, so
it's a no-op there). On Linux, Discord installed as a Flatpak or Snap is found through its sandbox
socket paths. `{sh:…}` runs through `cmd /C` on Windows and `sh -c` elsewhere.

## Setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click
   **New Application**. Its **name** is what appears after "Playing" (or "Listening to",
   "Watching", "Competing in"), so name it what you want people to read. Make several if you like.
2. Optional: upload an **App Icon** — Discord shows it as the card tile when a preset has no
   large image. `app-icons/make_icons.py` is a small generator for flat icons if you want a
   starting point.
3. In Statusmith, **Manage** (top bar) → paste the **Application ID** from General Information.
   The name fills in by itself.
4. Pick a preset, hit **Apply** (`Ctrl+Enter`). The pill turns green with your name when the
   client accepts it.

Details and state must be at least two characters (Discord's rule); the editor warns you.
Buttons are shown to *other* people, not on your own card — that's Discord, not a bug.

## Scripting a status

`{sh:…}` runs a command through `cmd /C` and uses the first line it prints; `{nx:…}` does the same
for a Nexium program via `nx run`. Results are cached per refresh, commands get eight seconds, and
nothing runs unless the preset is applied. They run as you, with your environment — treat a preset
you import from someone else like a script you'd run.

```text
details:  {sh:git -C C:\Users\me\Code\myproject branch --show-current}
state:    {nx:C:\Users\me\Code\statusmith\examples\nexium\branch.nx -- C:\Users\me\Code\myproject}
```

`examples/nexium/branch.nx` prints `main · 3 changed` for a repository; it's twenty lines and a
decent template for your own.

## Nexium SDK

`nexium/` is a Nexium package, `discord_rpc` (`nexium/src/lib.nx`): the same Rich Presence protocol written in
[Nexium](https://github.com/Londopy/nexium), with no dependency on Statusmith: open the pipe,
handshake, `set_activity`, `clear`, `close`, in about 200 lines. Any Nexium program can put a card
on your profile:

```nexium
import discord_rpc

var client = try discord_rpc.connect("1234567890123456789")   // your Application ID
var a = discord_rpc.activity()
a.details = String.from("writing the compiler in itself")
a.start_ms = time.now()
let headline = try client.set_activity(&a)                   // "Playing <headline>"
...
client.close()                                               // Discord clears the card
```

Any program takes it as a dependency; the SDK's tags are `sdk-v*`, apart from the app's:

```bash
nx add discord_rpc --git https://github.com/Londopy/statusmith --tag sdk-v0.2.0 --dir nexium   # needs Nexium 1.0.3+
```

`nexium/examples/presence.nx` is a command-line front end for it, a program with a path dependency on the package beside it:

```bash
nx run nexium/examples/presence.nx -- --app 1234567890123456789 --type watching --details "the build" --elapsed --hold 600
```

Options cover details, state, type, images, elapsed/countdown timers, two buttons and how long to
hold the presence (default: until Enter). The pipe is driven through the C runtime's unbuffered
`_open/_read/_write` on Windows and a Unix domain socket on macOS and Linux — the one
platform-specific piece is `nexium/src/dpipe.c`, a 60-line C shim the package links for
whoever depends on it, so `lib.nx` itself has no platform code.

## Is this allowed?

Yes. Rich Presence is a first-class Discord feature for third-party programs; the Developer Portal
exists so you can register them. Statusmith:

- talks only to your local Discord client over its IPC pipe — no requests to Discord's servers,
  and the client itself throttles presence updates to roughly one per 15 seconds;
- never has your token, so it cannot act as your account (the thing that actually gets people banned);
- makes two unauthenticated HTTP requests per application per launch (its public name and asset
  list), plus one request to GitHub for the update check, then nothing.

Nothing in the app can send presence faster than Discord's own guidance.

## Data

Presets, applications and settings live in `%APPDATA%\Statusmith\store.json` (there's an
*Open data folder* button in Settings). It's plain JSON — back it up, edit it, or use
*Export / Import presets* in the About panel to share a set.

## Build

Needs Rust (stable), Node 20+, and the Visual Studio C++ build tools.

```bash
npm install
npm run build      # loose exe   -> src-tauri\target\release\statusmith.exe
npm run bundle     # installer   -> src-tauri\target\release\bundle\nsis\Statusmith_<v>_x64-setup.exe
```

`npm run bundle` also writes the updater signature and therefore needs the signing key in
`TAURI_SIGNING_PRIVATE_KEY` (generate your own with `npx tauri signer generate` if you fork this
and replace `pubkey` in `tauri.conf.json`). `npm run dev` runs a debug build with devtools.

CI (`.github/workflows/build.yml`) builds the installer on every push and, on a `v*` tag, publishes
the release with `latest.json` for the updater.

## How it works

- `src-tauri/src/ipc.rs` — the Discord IPC protocol, no crate: frames are an 8-byte
  little-endian header (opcode, length) plus JSON. On Windows that's over
  `\\.\pipe\discord-ipc-N`, all I/O synchronous on one handle with reads gated by
  `PeekNamedPipe` (a blocking read on a duplicated handle deadlocks the writer). On macOS and
  Linux it's a Unix socket, `discord-ipc-N` under `$XDG_RUNTIME_DIR` or the temp dirs, including
  the Flatpak and Snap sandbox paths.
- `src-tauri/src/main.rs` — Tauri commands, the tray menu, close-to-tray, autostart,
  single-instance, the updater, idle detection, `{sh:}` execution.
- `ui/` — plain HTML/CSS/JS, no bundler: presets, template variables, rotation, reconnect logic,
  the preview card, a tiny Markdown renderer for the in-app README.

Platform-specific code is confined to the transport in `ipc.rs`, idle detection
(`GetLastInputInfo` / `CGEventSourceSecondsSinceLastEventType`), the shell used for `{sh:…}`, and
the "open this" helper (`rundll32` / `open` / `xdg-open`). CI builds Windows x64, x86 and ARM64,
a macOS universal binary, and Linux x86_64 and ARM64.

## License

MIT — see [LICENSE](LICENSE).
