# Getting started

Statusmith puts a **Rich Presence** card on your Discord profile — the "Playing …" block with
two lines of text, images, a timer and buttons — and lets you switch between saved cards from
the tray. Five minutes from install to your first card:

## 1. Create a Discord application

The card's headline ("Playing **life**") is the *name of a Discord application* you own. Open
the [Developer Portal](https://discord.com/developers/applications), click **New Application**,
and name it whatever you want people to read after "Playing". You can make several — one per
headline — and switch between them per preset. See [Applications](wiki:applications).

## 2. Add it to Statusmith

Top bar → **Manage** → paste the **Application ID** from the app's *General Information* page.
The name fills in by itself. The first application adopts the starter presets.

## 3. Apply a preset

Pick a preset in the sidebar, edit the text if you like, hit **Apply** (`Ctrl+Enter`) or
double-click the preset. The pill in the top bar turns green with your Discord name, and the card
is live. Discord itself has to be running — Statusmith talks to the client on your machine, not
to Discord's servers, and it never sees your account token.

## 4. Make it yours

- [Presets](wiki:presets) — every field on the card and its limits.
- [Live variables](wiki:live-variables) — `{time}`, `{battery}`, `{random:a|b}`, and
  `{sh:…}` / `{nx:…}` for anything a command can print.
- [Timers](wiki:timers) — elapsed, countdown, the progress-bar trick.
- [Rotation](wiki:rotation) — cycle through presets from any application.
- [Tray and settings](wiki:tray-and-settings) — close-to-tray, start with the OS, idle pause.

If the card doesn't show up, [Troubleshooting](wiki:troubleshooting) covers the usual reasons —
the most common is a Discord privacy setting.
