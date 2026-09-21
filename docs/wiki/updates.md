# Updates

Statusmith updates itself from the project's GitHub releases.

## How it works

- 15 seconds after launch, and every six hours after that, it fetches a small `latest.json`
  from the latest release. That is the only request the update check makes.
- If the version there is newer, a banner appears above the preview and the tray menu gains
  **Update to v…**. *What's new* shows the release notes; *Later* hides the banner for that
  version; *Install and restart* downloads the installer, verifies it and hands over to it.
- Every release is **signed**. The app carries the public key and refuses a download whose
  signature doesn't match, so a tampered file or a hijacked download can't install itself.
- The **About** panel shows your version, the result of the last check, and a
  *Check for updates* button.

Turn the automatic check off in Settings if you'd rather update by hand.

## What gets replaced

| System | Update path |
|---|---|
| Windows | the installer runs silently and relaunches the app |
| macOS | the `.app` is replaced in place and relaunched |
| Linux AppImage | the AppImage is replaced in place |
| Linux `.deb` | the package is installed through the package manager |

Presets and settings are never touched by an update; they live in the data folder
(see [Tray and settings](wiki:tray-and-settings)).

## Releases

Each release page lists every platform's download with its size, a `SHA256SUMS.txt` and how to
verify a file against it, and the changelog section for that version. Releases are published
only once every platform has finished building, so the updater never sees a half-finished one.
