# Presets

A preset is one card. Everything you type saves as you type; **Apply** sends it to Discord.

## The card, top to bottom

| Field | On the card | Limits |
|---|---|---|
| Activity type | the prefix: *Playing*, *Listening to*, *Watching*, *Competing in* | — |
| Details | first line under the headline | 2–128 characters |
| State | second line | 2–128 characters |
| Party size | appended to state as "(2 of 4)" | 0 = off |
| Large image | the tile; hover shows its text | `https://` link or an Art Assets key |
| Small image | the round badge on the tile's corner | same |
| Timer | "12:34 elapsed", "05:00 left", or a progress bar | see [Timers](wiki:timers) |
| Buttons | up to two links under the card | label ≤ 32 chars, `https://` URL |

Discord's rules, which the editor enforces or warns about: a line must be at least two
characters (a one-character line is dropped with a warning), text is cut at 128, and the
**buttons are shown to other people, never on your own profile view** — that isn't a bug.

With Playing, the headline is the application's name and the first bold line; with the other
three types the headline is "Listening to *app*" and Details becomes the bold line.

## Working with presets

- **Follow live** (under the preview, next to "Live: …") is a toggle: while it's on, the editor
  stays on whatever is on your profile — as rotation moves to the next preset, so does the editor.
  Picking a different preset by hand, or making a new one, switches it off. While a detected game
  or track is live there's no preset to show, so the editor just waits for the next one; it won't
  pull you away while you're typing in a field.
- **+ New** creates a preset under the current application; the name field is focused.
- **Duplicate** (`Ctrl+D`) copies the selected preset next to it.
- **Delete** removes it (`Delete` key when you're not typing in a field).
- `Ctrl+↑` / `Ctrl+↓` reorder within the application.
- The green dot marks the preset that is live right now.
- Double-click a preset to apply it; single-click just opens it in the editor.

## Images

Paste any image URL (`https://…png/jpg/gif/webp`) — Discord fetches it, no upload needed. Or use
a key from the application's Art Assets; keys appear as suggestions once the application is
added, and the preview resolves them to the real image. With no large image, Discord shows the
application's icon.

## Sharing

About → **Export presets** writes every application and preset to a JSON file; **Import** merges
one in, keeping your existing presets and renaming clashes. The same data lives in
`store.json` in the data folder (Settings → *Open data folder*) if you'd rather edit it by hand.
