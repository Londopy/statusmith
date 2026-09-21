# Tray and settings

Statusmith is a tray app: closing the window hides it, the tray icon brings it back, and
**Quit** lives in the tray menu.

## The tray menu

- The first line shows whether Discord is connected and as whom.
- **Open Statusmith** — or left-click the icon.
- **Update to v…** — appears when a new release is available.
- **Apply preset ▸** — every preset, in a submenu per application.
- **Start / Stop rotation**, **Clear presence**, **Quit Statusmith**.

The icon's tooltip shows what's live right now.

## Settings

| Setting | What it does |
|---|---|
| Auto-reconnect when Discord restarts | polls every 10 s; when Discord comes back, the last card is re-applied with its timer intact |
| Restore last presence on launch | re-applies whatever was live when Statusmith last ran |
| Start with Windows (hidden in tray) | on by default at first run; the entry is refreshed with the current path on every launch, so updates never break it |
| Check for updates automatically | 15 s after launch and every 6 hours; see [Updates](wiki:updates) |
| Pause presence when idle for N min | clears the card after N minutes without keyboard or mouse input and restores it on the first input. Windows and macOS; Linux has no portable idle API, so it's a no-op there |

**Hide to tray** does what closing the window does. **Open data folder** shows `store.json`,
where every application, preset and setting lives as plain JSON — back it up, copy it to another
machine, or edit it while Statusmith is closed.

## Where the data is

| System | Folder |
|---|---|
| Windows | `%APPDATA%\Statusmith` |
| macOS | `~/Library/Application Support/Statusmith` |
| Linux | `$XDG_CONFIG_HOME/statusmith` (usually `~/.config/statusmith`) |

Uninstalling leaves the folder alone, so reinstalling brings everything back.
