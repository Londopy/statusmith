/* dpipe.c: see dpipe.h. Windows: the named pipe through the C runtime's unbuffered
 * descriptor calls (a FILE* cannot switch from reading to writing without a seek, and
 * pipes cannot seek). Elsewhere: a Unix domain socket. */
#include "dpipe.h"
#include <stdio.h>

#ifdef _WIN32

#include <fcntl.h>
#include <io.h>
#include <process.h>

int dp_open(void) {
    char path[64];
    for (int i = 0; i < 10; i++) {
        snprintf(path, sizeof path, "\\\\.\\pipe\\discord-ipc-%d", i);
        int fd = _open(path, _O_RDWR | _O_BINARY);
        if (fd >= 0) return fd;
    }
    return -1;
}
int dp_read(int h, void* buf, unsigned n) { return _read(h, buf, n); }
int dp_write(int h, const void* buf, unsigned n) { return _write(h, buf, n); }
void dp_close(int h) { _close(h); }
int dp_pid(void) { return _getpid(); }

#else

#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* Try discord-ipc-0..9 under dir/sub; -1 when none accepts. */
static int try_dir(const char* dir, const char* sub) {
    for (int i = 0; i < 10; i++) {
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof addr);
        addr.sun_family = AF_UNIX;
        int len = sub[0]
            ? snprintf(addr.sun_path, sizeof addr.sun_path, "%s/%s/discord-ipc-%d", dir, sub, i)
            : snprintf(addr.sun_path, sizeof addr.sun_path, "%s/discord-ipc-%d", dir, i);
        if (len <= 0 || (size_t)len >= sizeof addr.sun_path) continue;
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return -1;
        if (connect(fd, (struct sockaddr*)&addr, sizeof addr) == 0) return fd;
        close(fd);
    }
    return -1;
}

int dp_open(void) {
    static const char* const vars[] = { "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP" };
    static const char* const subs[] = { "", "app/com.discordapp.Discord", "snap.discord", "snap.discord-canary" };
    for (size_t v = 0; v <= sizeof vars / sizeof vars[0]; v++) {
        const char* dir = v < sizeof vars / sizeof vars[0] ? getenv(vars[v]) : "/tmp";
        if (!dir || !dir[0]) continue;
        for (size_t s = 0; s < sizeof subs / sizeof subs[0]; s++) {
            int fd = try_dir(dir, subs[s]);
            if (fd >= 0) return fd;
        }
    }
    return -1;
}
int dp_read(int h, void* buf, unsigned n) { return (int)read(h, buf, n); }
int dp_write(int h, const void* buf, unsigned n) { return (int)write(h, buf, n); }
void dp_close(int h) { close(h); }
int dp_pid(void) { return (int)getpid(); }

#endif
