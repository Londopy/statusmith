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
