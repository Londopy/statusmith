# Troubleshooting

## The pill says "Discord isn't running"

Statusmith connects to the Discord client on this machine, so the app has to be open (the
browser version doesn't count — it has no local pipe). On Linux, Discord installed as a Flatpak
or Snap is found through its sandbox socket paths automatically; if you run it some other
sandboxed way, make sure `discord-ipc-0` is reachable under `$XDG_RUNTIME_DIR`.

## "Discord refused the handshake: Invalid Client ID"

The Application ID isn't one Discord knows. Copy it again from the application's *General
Information* page — it's the 17–20 digit number, not the public key. Statusmith stops retrying
until you change it.

## The pill is green but nobody sees the card

Discord has a privacy switch for this. In Discord: **Settings → Activity Privacy** (older
builds: *Activity Status*) → turn on **Share your detected activities with others** (and
*Display current activity as a status message*). Per-server overrides exist under a server's
privacy settings too. Also check that your status isn't **Invisible** — Discord hides all
activity when you are.

## The card shows but a line is missing

Discord requires at least two characters per line; a one-character Details or State is dropped
(Statusmith warns when it does that). Lines are cut at 128 characters, buttons at 32.

## I can't see my own buttons

Discord never shows Rich Presence buttons on your own profile view — only to other people.
Ask a friend, or use a second account.

## The card lags behind my edits

Discord applies about one update per 15 seconds per application and drops the rest, which is
also why live variables refresh at that rate. Wait a moment, or apply again.

## Rotation stopped by itself

Applying a preset by hand stops rotation on purpose. It also stops if fewer than two presets
are left in the cycle. Start it again from the sidebar, the rotation menu, or the tray.

## Update failed

*Install and restart* downloads the installer from GitHub and checks its signature; a failed
download (no network, GitHub down) is reported and nothing changes. Try *Check for updates*
again later, or download the installer from the releases page — installing over the top keeps
your presets.

## macOS says the app is damaged or from an unidentified developer

The macOS build isn't notarized. Right-click the app → **Open** once, or run
`xattr -dr com.apple.quarantine /Applications/Statusmith.app`.

## Something else

Presets, applications and settings are one JSON file in the data folder (Settings → *Open data
folder*). Renaming it gives you a clean first-run state without losing the old one. Bug reports
are welcome on the GitHub repository — include your platform and what the pill says.
