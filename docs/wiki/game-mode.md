# Game mode

Discord has its own game detection — when it sees a game running it shows "Playing <Game>". Game
mode lets **Statusmith** do that instead, so your presence is driven by one thing and you can add
a timer (and, later, custom details and buttons) to games Discord would only show plainly.

Turn it on in the **Game mode** panel (right side). Statusmith fetches Discord's own list of
detectable games — the same database Discord uses, tens of thousands of titles — watches your
running programs, and when a game from the list is running it sets the presence to that game,
using the game's real name and art. When you quit, whatever was up before (your status, or the
rotation) comes back.

## Turn off Discord's own detection

So a game doesn't show up **twice**, switch Discord's detection off and let Statusmith handle it:

1. Discord → **Settings** (gear, bottom-left).
2. **Activity Settings → Registered Games** (older builds: **Game Activity**).
3. Turn off **"Display current activity as a status message"**, or remove individual games from
   the list with the ✕. Removing a game stops Discord auto-detecting it while your Rich Presence
   still works.

Leave **Settings → Activity Privacy → "Share your detected activities with others"** *on* —
that's what lets other people see any presence at all, Statusmith's included.

Statusmith can't flip these for you (an app can't change Discord's settings), so this is the one
manual step.

## Keep rotating (game joins the cycle)

By default a detected game **takes over** the presence while it runs. Set **While in a game →
"Keep rotating"** and instead the game becomes one more stop in your [rotation](wiki:rotation):
your presets and the game you're actually on all show, round-robin. The game appears only while
it's running and drops out when you quit. In the rotation menu it's the row tagged **LIVE** at the
end of the cycle, with its own ×N weight.

## LARP a game

**LARP a game** — LARP just means *fake it* — lets you pick any title from Discord's list and
show "Playing <it>" — with the real art — whether or not it's running. It's a vanity status for
your own profile; it becomes a normal preset you can edit, apply, or delete. It doesn't run or
install anything, and only affects how *your* card looks to other people.

- **Show it now, or add it to rotation.** By default, picking a game shows it right away. Tick
  **"Add it to my rotation"** in the picker first, and instead it joins the [rotation](wiki:rotation)
  as one more stop (so your other statuses and the faked game cycle together) — the game does not
  take over on its own.
- **Stop faking it.** To drop the fake for now, hit **Clear presence** (top bar) or apply another
  preset. To remove it for good, select the faked game in the sidebar and hit **Delete** — that
  deletes the preset and takes the game back out of the Application menu.

## Notes

- **First enable** downloads the game list (~13 MB) once and caches it; **Refresh list** updates
  it (Discord adds games often). The match is by the program's executable name.
- **A game takes over** while it runs. Applying a preset by hand still works and stays until the
  game's state changes; rotation pauses during a game and resumes after.
- **Not every game is listed.** Discord's database misses some, especially very new or niche
  titles — those won't be detected (a per-game custom mapping is planned).
- **Timer**: "Add an elapsed timer" shows how long you've been in the game. Some Discord clients
  add their own timer to the compact card regardless; that's Discord, not Statusmith.
- Turning game mode **off** clears any game presence and hands control back to your presets.
