# Nexium

[Nexium](https://github.com/Londopy/nexium) is a compiled language whose compiler is written in
itself. Statusmith uses it in two ways.

## `{nx:…}` — a Nexium program as a live variable

Put `{nx:C:\path\to\script.nx -- args}` in Details or State. Statusmith runs `nx run` on it every
15 seconds while the preset is live and shows the first line it prints. Any program that prints
one line qualifies; it doesn't need to know Discord exists.

`examples/nexium/branch.nx` in the repository is the template:

```nexium
import std.process

fn main() -> !void {
    let a = os.args()
    let repo = if a.len > 1 { a[1] } else { "." }
    let opts = process.Options{ .stdin = "", .cwd = repo }
    let branch_argv = ["git", "branch", "--show-current"]
    let branch = try process.run_with(branch_argv[..], opts)
    println("{}", .{branch.text()})
}
```

Needs `nx` on your PATH — it's installed with Nexium.

## The Nexium SDK — presence without Statusmith

`nexium/` is a Nexium package, `discord_rpc` (`nexium/src/lib.nx`): the same Rich Presence
protocol Statusmith uses, in about 200 lines of Nexium with no dependency on the app. Take it
into any project with

```bash
nx add discord_rpc --git https://github.com/Londopy/statusmith --tag sdk-v0.2.0 --dir nexium   # needs Nexium 1.0.3+
```

and any Nexium program can put a card on your profile:

```nexium
import discord_rpc

var client = try discord_rpc.connect("1234567890123456789")   // your Application ID
var a = discord_rpc.activity()
a.details = String.from("writing the compiler in itself")
a.start_ms = time.now()
let headline = try client.set_activity(&a)                   // "Playing <headline>"
// ... the card stays up while the connection is open
client.close()
```

`nexium/examples/presence.nx` wraps it as a command (a program with a path dependency on the
package beside it):

```bash
nx run nexium/examples/presence.nx -- --app 1234567890123456789 --type watching --details "the build" --elapsed --hold 600
```

Options: `--details --state --type --large --large-text --small --small-text --elapsed
--countdown MIN --button Label=URL --hold SECONDS` (without `--hold`, it waits for Enter).

The SDK runs on Windows, macOS and Linux. The only platform-specific piece is
`nexium/src/dpipe.c`, a small C shim the package links for whoever depends on it: the named
pipe through the C runtime's unbuffered `_open/_read/_write` on Windows (a `FILE*` can't switch
from reading to writing without a seek), a Unix domain socket elsewhere, including Discord's
Flatpak and Snap sandbox paths. `lib.nx` itself has no platform code.
