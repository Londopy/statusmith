# Music mode

Music mode shows **what you're listening to** — "Listening to <track>", with the artist as the
state and a Spotify-style progress bar that tracks the real position in the song. It works the
same way [game mode](wiki:game-mode) does: Statusmith watches your machine and sets the presence
itself, so it doesn't matter whether the player has its own Discord integration.

Turn it on in the **Music mode** panel (right side). Statusmith reads Windows' own "now playing"
information (the same thing the volume flyout and lock screen use), so it picks up **any** player
that reports to the system — Spotify, the Tidal and Apple Music apps, a browser playing YouTube or
SoundCloud, foobar2000, and so on. Nothing to log into, no player-specific setup.

## Headline application: make one called "music"

The word after "Listening to" is always the name of one of *your* Discord applications — that's
how Rich Presence works. Games get their own headline because every game in Discord's list has
its own application; a song doesn't, so the headline can't be the track itself. The next best
thing reads naturally:

1. In the [Developer Portal](wiki:applications), **New Application** → name it **music** (or
   *Spotify*, *Tidal*, whatever you use). An icon is optional — the album cover fills the tile.
2. Add it in Statusmith (**Manage**), then pick it as the **headline application** here.

Now the card reads **Listening to music** → *Grenade* → *by Bruno Mars* → *Doo-Wops & Hooligans*,
with the album cover as the tile and a live progress bar. And the short status under your name in
member lists reads **Listening to Grenade** — Statusmith asks Discord to show the *song* there
instead of the application name.

When you turn music mode on, Statusmith picks an application named *music* / *Spotify* / *Tidal* /
*Apple Music* / *YouTube Music* automatically if you have one; otherwise it falls back to the
application selected in the top bar (unless that's a LARP). Faked-game applications aren't
offered, since those are for "Playing".

## Take over, or keep rotating

Music is its own source, just like [game mode](wiki:game-mode), with the same **While listening**
choice:

- **Take over the presence** (default): while a track plays it takes over your card; your status
  or rotation returns when the music stops.
- **Keep rotating (music joins the cycle)**: the current track becomes one stop in your
  [rotation](wiki:rotation), so your presets and what you're listening to cycle together. If
  rotation isn't running yet, a playing track starts it (or, with nothing else to cycle, shows on
  its own). The track drops out of the cycle when playback stops.

## What the card shows

- **Details** — the track title.
- **State** — the artist. Untick **State reads "by &lt;artist&gt;"** if you'd rather it show the
  bare artist name without the "by " prefix.
- **Album** — the album name as the tile's hover text; Discord's card shows it as a third line.
- **Cover art** — the OS only hands over a thumbnail *stream* and Discord needs a public image
  link, so Statusmith looks the cover up on iTunes' free search (one request per new track,
  cached, no account) and uses it as the large image. Obscure tracks may get no match, in which
  case the application's icon shows instead.
- **Progress bar** — when the player reports the track length, the card gets a *Listening +
  countdown* bar that fills as the song plays, and updates when you skip or seek.
- **Your status line** — in member lists and under your name, Discord shows "Listening to
  *&lt;song&gt;*" rather than the application name.

When playback stops, or you pause for a moment, whatever was up before — your status or the
[rotation](wiki:rotation) — comes back, exactly like a game closing.

## Music, games and your own status together

There's one presence, so Statusmith resolves the sources in order:

1. **A take-over game wins.** A game whose placement is *take over* beats everything, music
   included; the track picks back up when you quit.
2. **Then a take-over track.** With no take-over game, a playing track set to *take over* shows
   over your manual status or a running rotation.
3. **Keep-rotating sources ride along.** A game or track set to *keep rotating* is just one more
   stop in the cycle — the two can share the rotation with your presets.
4. **Then you.** With nothing detected, your own status (or the rotation) is what shows.

Whatever was live before a take-over kicked in is remembered and restored when it ends, so
game → music → nothing lands you right back on your own status.

## Notes

- **Windows only.** The "now playing" API this uses (`GlobalSystemMediaTransportControls`) is a
  Windows feature. On macOS and Linux the panel is present but the toggle does nothing; a
  cross-platform source may come later.
- **It reads, never controls.** Statusmith only *reads* what's playing — it never starts, pauses,
  or skips your music.
- **Cover look-ups** go to `itunes.apple.com` with the artist and title — the only thing music
  mode ever sends anywhere. Nothing else about your listening leaves the machine except the
  presence you see on your own card.
- **A browser counts** only if the tab is driving the system media controls (a little play/pause
  shows in the Windows volume flyout). Most video and music sites do; some embeds don't.
- Turning music mode **off** clears any track presence and hands control back to your presets.
