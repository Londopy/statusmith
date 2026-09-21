# Applications

A Discord *application* is what Discord shows after "Playing". Statusmith organises everything
around them: the top-bar menu picks an application, and the sidebar lists only its presets.

## Why more than one

Each application is one headline. `life` reads as *Playing life*; an application named
`the rewrite` reads as *Competing in the rewrite* when a preset uses the Competing type. The
headline is the one line you can't type into a preset — so make an application per headline
you want, and choose which one a preset uses in the editor's **Application** field.

Discord allows dozens of applications per account. They cost nothing and need no setup beyond
a name.

## Adding one

1. [Developer Portal](https://discord.com/developers/applications) → **New Application** → name it.
2. Statusmith → **Manage** (top bar) → paste the **Application ID** (a 17–20 digit number from
   *General Information*) → **Add**. The name is fetched from Discord; you can override it in
   the Manage list — the override is only for Statusmith's own labels, the card still shows
   Discord's name.

## Icons and images

- **App Icon** (Developer Portal → General Information) is what Discord draws as the card's tile
  when a preset has no large image. Uploading one replaces the grey "?" tile. `app-icons/make_icons.py`
  in the repository generates flat icons if you want a starting point.
- **Art Assets** (Developer Portal → Rich Presence) are named images you can reference by *key*
  in a preset's image fields. Once the application is added, its keys are offered as suggestions.
  Any `https://` image link works too, without uploading anything.

## Moving and removing

- Change a preset's application in the editor; the view follows it to the new application.
- **Remove** in Manage refuses while presets still use the application — move or delete them
  first, so nothing is silently orphaned.
- The Manage list shows how many presets each application has.

Switching to a preset that uses a different application reconnects Statusmith to Discord under
that application's ID. That takes about a second, during which the card is briefly empty; in
[rotation](wiki:rotation) at normal intervals you'll never notice.
