# Rotation

Rotation cycles through a set of presets, applying the next one every N seconds. The set can
mix presets from different [applications](wiki:applications) — the headline changes along with
the card.

## The rotation menu

Click **Rotation ▸** in the sidebar. The menu shows:

- **Now** — which preset is live and how long until the next switch.
- **In the cycle, in order** — the presets that take turns, top to bottom. Untick one to drop
  it; ▲ ▼ move it earlier or later.
- **Available** — every other preset, grouped by application. Tick one to add it to the end.
- The interval and the Start/Stop button, same as the sidebar.

The ↻ icon next to each preset in the sidebar toggles the same membership.

### Live stops

When [game mode](wiki:game-mode) or [music mode](wiki:music-mode) is set to **keep rotating**,
the game you're in or the track you're on shows at the end of the cycle as a row tagged **LIVE**:
"🎮 ROBLOX · detected game", "🎧 Grenade — Bruno Mars · now playing". They come and go on their
own — there's no tick box, the panel's *While in a game* / *While listening* choice is what puts
them here — and they always ride at the end, but the **×N** weight works exactly like a preset's.
The sidebar count includes them: "16 presets + 2 live".

## Rules

- At least two presets to start; if the cycle shrinks below two while running, it stops.
- The interval floor is 15 seconds (Discord's own update rate). 60 is a good default; a
  minute-scale rotation with `{random}` and `{time}` inside the presets gives a card that
  never looks the same twice.
- Applying a preset by hand — the Apply button, `Ctrl+Enter`, a double-click, or the tray menu —
  **stops rotation**, since you clearly wanted that one. Start it again from the menu, the
  sidebar, or the tray.
- Rotation resumes on launch if it was running when Statusmith closed.
- While the presence is paused for idle (see [Tray and settings](wiki:tray-and-settings)), the
  cycle waits too.

The tray menu has *Start rotation* / *Stop rotation* so you can toggle it without opening the
window.
