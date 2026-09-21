# Changelog

All notable changes to Statusmith are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The section for a version is what appears
on its GitHub release page.

## [Unreleased]

### Added
- macOS (universal, Intel and Apple Silicon) and Linux (x86_64 and ARM64) builds, plus 32-bit
  and ARM64 Windows installers. Discord is found over its Unix socket on macOS and Linux,
  including the Flatpak and Snap sandbox paths.
- Rotation menu: click *Rotation* in the sidebar to see everything in the cycle across all
  applications, what is playing now and when the next switch is, tick presets in or out, and
  order them with the arrows.
- Release pages with a download table, SHA-256 checksums (`SHA256SUMS.txt`) and verification
  instructions; releases are published only once every platform has finished building.
- README badges and a per-platform download table.

### Changed
- CI actions moved to their Node 24 releases.
- `.nx` files are shown with Zig highlighting on GitHub until Linguist knows Nexium.

## [0.1.0] - 2026-09-20

First release.

### Added
- Rich Presence over Discord's local IPC pipe: details, state, large and small images with
  hover text, party size, two link buttons, and Playing / Listening / Watching / Competing.
- Presets grouped by Discord application; the top-bar menu picks the application and the
  sidebar shows its presets. Manage adds applications by ID and fetches their names.
- Live preview that mimics the Discord profile popout, with your avatar once connected.
- Live variables re-rendered every 15 seconds: `{time}` `{time12}` `{date}` `{day}` `{uptime}`
  `{battery}` `{random:a|b|c}`, plus `{sh:command}` and `{nx:file.nx}` which show the first line
  a shell command or a Nexium program prints.
- Timers: elapsed since apply, elapsed since launch, countdown with optional restart;
  Listening + countdown draws a progress bar.
- Rotation through chosen presets every N seconds.
- Tray icon with a per-application preset menu, start/stop rotation, clear and quit;
  close-to-tray; start with Windows (on by default at first run).
- Auto-reconnect when Discord restarts, restore the last presence on launch, pause the presence
  after N idle minutes.
- NSIS per-user installer with the license page; signed in-app updater that checks GitHub
  releases; export and import presets as JSON; keyboard shortcuts; README and license in-app.
- Nexium SDK: `nexium/discord_rpc.nx` speaks the protocol on its own, `nexium/presence.nx` sets
  a presence from the terminal, `examples/nexium/branch.nx` is a `{nx:…}` example.

[Unreleased]: https://github.com/Londopy/statusmith/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Londopy/statusmith/releases/tag/v0.1.0
