# Live variables

Anything in braces inside Details, State or the image hover texts is replaced when the card is
sent — and re-sent every 15 seconds while the preset is applied, as long as the result changed.
Click a chip under the editor to insert one at the cursor.

| Variable | Example | Notes |
|---|---|---|
| `{time}` | `14:05` | 24-hour |
| `{time12}` | `2:05 PM` | |
| `{date}` | `Sep 20` | |
| `{day}` | `Saturday` | |
| `{uptime}` | `2h 14m` | since Statusmith started |
| `{battery}` | `87%` | `?%` on a desktop without a battery |
| `{random:a\|b\|c}` | one of `a`, `b`, `c` | re-rolled every refresh; use `\|` between options |
| `{sh:command}` | first line the command prints | see below |
| `{nx:file.nx}` | first line a Nexium program prints | see below |

Why 15 seconds: Discord accepts roughly one presence update per 15 seconds per application and
quietly drops faster ones, so Statusmith never tries. `{time}` therefore changes on the minute,
`{random}` every refresh.

## `{sh:…}` and `{nx:…}`

`{sh:git -C C:\Users\me\Code\myproject branch --show-current}` runs the command through the
system shell (`cmd /C` on Windows, `sh -c` elsewhere), without a console window, and shows the
**first line** it prints. `{nx:C:\path\to\script.nx -- args}` does the same with `nx run`, so a
[Nexium](https://github.com/Londopy/nexium) program can compute the line — the repository's
`examples/nexium/branch.nx` prints `main · 3 changed` for a repository.

Rules:

- The first render shows `…` until the command answers; results are cached per refresh window.
- A command gets eight seconds; a slow one shows `(error)`, and never blocks the app.
- Only the first line is used, cut to 128 characters.
- Nothing runs unless the preset is applied.

Commands run as you, with your environment. A preset you import from someone else can run
commands too — read it like you'd read a script before applying it.
