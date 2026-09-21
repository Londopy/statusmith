#!/usr/bin/env python3
"""Assemble a GitHub release page for Statusmith.

    python scripts/release_notes.py v0.2.0 assets/ --prev v0.1.0 --out body.md --sums SHA256SUMS.txt

`assets/` holds every file uploaded to the release. The script writes SHA256SUMS.txt (sha256sum
format, so `sha256sum -c` works) and a Markdown body: a one-paragraph introduction, the version's
section from CHANGELOG.md, a download table that names the platform for each file, the checksums,
how to verify, and the compare link. CI runs it after all platforms have built; it also works by
hand against `gh release download`.
"""
import argparse
import hashlib
import os
import re
import sys

REPO = "Londopy/statusmith"
INTRO = (
    "**Statusmith** is a tray app for writing your own Discord Rich Presence — the \"Playing …\" card — "
    "with presets grouped by application, live variables, timers, rotation, and a signed in-app updater. "
    "It talks to the Discord client already running on your machine over its local pipe and never sees "
    "your account token. See the [README](https://github.com/{repo}#readme) for setup."
)

# (regex on the file name, platform label, notes)
KINDS = [
    (r"_x64-setup\.exe$", "Windows 10/11, 64-bit", "installer"),
    (r"_x86-setup\.exe$", "Windows, 32-bit", "installer"),
    (r"_arm64-setup\.exe$", "Windows on ARM", "installer"),
    (r"_universal\.dmg$", "macOS 10.15+, Intel and Apple Silicon", "universal app; not notarized — first open via right-click → Open"),
    (r"_(x64|aarch64|x86_64)\.dmg$", "macOS 10.15+", "app; not notarized — first open via right-click → Open"),
    (r"_amd64\.AppImage$", "Linux x86_64", "AppImage; what the in-app updater replaces"),
    (r"_aarch64\.AppImage$", "Linux ARM64", "AppImage; what the in-app updater replaces"),
    (r"_amd64\.deb$", "Linux x86_64 (Debian/Ubuntu)", "package"),
    (r"_arm64\.deb$", "Linux ARM64 (Debian/Ubuntu)", "package"),
    (r"\.rpm$", "Linux (Fedora/openSUSE)", "package"),
    (r"\.app\.tar\.gz$", "macOS", "updater archive; the app downloads this itself"),
]
HIDDEN = {"latest.json", "SHA256SUMS.txt"}   # in the sums, not in the table


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def kind_of(name):
    for pattern, label, note in KINDS:
        if re.search(pattern, name):
            return label, note
    return "Other", ""


def changelog_section(path, version):
    """The body of `## [version]` from a Keep-a-Changelog file, or None."""
    if not os.path.exists(path):
        return None
    text = open(path, encoding="utf-8").read()
    m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
    if not m:
        return None
    body = m.group(1)
    # drop the link-reference definitions that end a Keep-a-Changelog file
    body = re.sub(r"^\[[^\]]+\]:\s+\S+\s*$", "", body, flags=re.M).strip()
    # promote "### Added" to bold labels so the release page has fewer heading levels
    body = re.sub(r"^### (.+)$", r"**\1**", body, flags=re.M)
    return body or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tag")
    ap.add_argument("assets")
    ap.add_argument("--prev", default="")
    ap.add_argument("--changelog", default="CHANGELOG.md")
    ap.add_argument("--out", default="body.md")
    ap.add_argument("--sums", default="SHA256SUMS.txt")
    ap.add_argument("--repo", default=REPO)
    a = ap.parse_args()
    version = a.tag[1:] if a.tag.startswith("v") else a.tag

    files = sorted(f for f in os.listdir(a.assets) if os.path.isfile(os.path.join(a.assets, f)) and f != "SHA256SUMS.txt")
    if not files:
        sys.exit(f"no assets in {a.assets}")
    sums = [(sha256(os.path.join(a.assets, f)), f) for f in files]
    with open(a.sums, "w", encoding="utf-8", newline="\n") as out:
        for digest, name in sums:
            out.write(f"{digest}  {name}\n")

    rows = []
    for f in files:
        if f in HIDDEN or f.endswith(".sig"):
            continue
        label, note = kind_of(f)
        size = human(os.path.getsize(os.path.join(a.assets, f)))
        url = f"https://github.com/{a.repo}/releases/download/{a.tag}/{f}"
        rows.append(f"| [{f}]({url}) | {label} | {size} | {note} |")

    notes = changelog_section(a.changelog, version)
    parts = [INTRO.format(repo=a.repo), ""]
    parts += [f"## What's new in {version}", "", notes or f"See the commits since the previous release.", ""]
    parts += ["## Downloads", "", "| File | For | Size | Notes |", "|---|---|---|---|", *rows, ""]
    parts += [
        "Already have Statusmith installed? It offers this version in-app (*Install and restart*); "
        "the update is verified against the signing key in the app before it runs. "
        "`latest.json` and the `.sig` files are what the updater reads — you don't need them.",
        "",
        "## Verify a download",
        "",
        "`SHA256SUMS.txt` lists the SHA-256 of every file above. With the file next to it:",
        "",
        "```bash",
        "sha256sum -c SHA256SUMS.txt --ignore-missing      # Linux",
        "shasum -a 256 -c SHA256SUMS.txt --ignore-missing  # macOS",
        "certutil -hashfile Statusmith_" + version + "_x64-setup.exe SHA256   # Windows: compare by eye",
        "```",
        "",
        "<details><summary>Checksums</summary>",
        "",
        "```",
        *[f"{d}  {n}" for d, n in sums if n not in HIDDEN],
        "```",
        "",
        "</details>",
        "",
    ]
    if a.prev:
        parts.append(f"**Full changelog**: https://github.com/{a.repo}/compare/{a.prev}...{a.tag}")
    else:
        parts.append(f"**Full changelog**: https://github.com/{a.repo}/commits/{a.tag}")
    with open(a.out, "w", encoding="utf-8", newline="\n") as out:
        out.write("\n".join(parts) + "\n")
    print(f"wrote {a.out} ({len(rows)} downloads) and {a.sums} ({len(sums)} files)")


if __name__ == "__main__":
    main()
