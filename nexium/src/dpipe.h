/* dpipe.h: the one platform-specific piece of the discord_rpc package.
 *
 * Discord's local IPC endpoint is a named pipe on Windows (\\.\pipe\discord-ipc-N) and a
 * Unix domain socket everywhere else ($XDG_RUNTIME_DIR/discord-ipc-N, the temp dirs, and the
 * Flatpak / Snap sandbox paths). This shim hides that behind four calls with plain C types
 * so lib.nx has no #ifdef of its own; `artifact link { c_sources = ["dpipe.c"] }` next to
 * lib.nx builds it for whoever depends on the package.
 */
#ifndef DPIPE_H
#define DPIPE_H

/* Connect to the first discord-ipc-N that answers. -1 when Discord isn't running. */
int dp_open(void);
/* Bytes read (0 = the other side closed, -1 = error). May return fewer than n. */
int dp_read(int h, void* buf, unsigned n);
/* Bytes written (-1 = error). May write fewer than n. */
int dp_write(int h, const void* buf, unsigned n);
void dp_close(int h);
/* This process id, for SET_ACTIVITY's `pid`. */
int dp_pid(void);

#endif
