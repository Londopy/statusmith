/* Nexium runtime. Embedded into every generated translation unit.
 *
 * Design constraints (specification section 4.1):
 *   S1  no initialization: every function here works from any thread with no setup.
 *   S2  no process-global state: the only static is a thread-local panic boundary,
 *       which is per-thread and per-translation-unit.
 *   S3  panics do not cross an export boundary: nx_panic longjmps to the nearest
 *       boundary when one is installed, and aborts the process otherwise.
 */
#ifndef NX_RT_H
#define NX_RT_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include <errno.h>
#include <sys/stat.h>
#include <math.h>
#include <time.h>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <direct.h>
#else
#include <sys/time.h>
#include <unistd.h>
#include <poll.h>
#include <spawn.h>
#include <sys/wait.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
extern char** environ;
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#endif

#if defined(_MSC_VER) && !defined(__clang__)
#define NX_THREAD_LOCAL __declspec(thread)
#define NX_NORETURN __declspec(noreturn)
#else
#define NX_THREAD_LOCAL _Thread_local
#define NX_NORETURN _Noreturn
#endif
#define NX_INLINE static inline
#if defined(_WIN32) && defined(NX_BUILD_SHARED)
#define NX_EXPORT __declspec(dllexport)
#elif defined(NX_BUILD_SHARED)
#define NX_EXPORT __attribute__((visibility("default")))
#else
#define NX_EXPORT
#endif
#define NX_UNUSED(x) (void)(x)

typedef __int128 nx_i128;
typedef unsigned __int128 nx_u128;
#define NX_I128_MAX ((nx_i128)((((nx_u128)1) << 127) - 1))
#define NX_I128_MIN ((nx_i128)(-NX_I128_MAX - 1))

/* ------------------------------------------------------------------ slices */
typedef struct nx_sl_u8 { uint8_t* ptr; size_t len; } nx_sl_u8;
struct nx_arena;
/* Growable containers remember the arena they were created in (NULL = the
 * root allocator), so a container created outside a `using arena` block keeps
 * its storage on the heap even when it grows inside the block. */
typedef struct nx_string { uint8_t* ptr; size_t len; size_t cap; struct nx_arena* ar; } nx_string;
typedef struct nx_rawlist { void* ptr; size_t len; size_t cap; struct nx_arena* ar; } nx_rawlist;

NX_INLINE nx_sl_u8 nx_lit(const char* s, size_t n) { nx_sl_u8 r; r.ptr = (uint8_t*)s; r.len = n; return r; }

/* --------------------------------------------------------------- allocator */
typedef struct nx_alloc {
    void* (*alloc)(void* state, size_t size, size_t align);
    void* (*realloc)(void* state, void* p, size_t old_size, size_t new_size, size_t align);
    void (*free)(void* state, void* p, size_t size);
    void* state;
} nx_alloc;

typedef struct nx_ctx {
    nx_alloc alloc;
    /* the root (non-arena) allocator, and the innermost arena in scope */
    nx_alloc base;
    struct nx_arena* arena;
    uint64_t rng;
    bool rng_seeded;
    int argc;
    char** argv;
    FILE* out;
    FILE* err;
    /* leak tracking (only maintained when built with -DNX_LEAK_CHECK) */
    size_t live_allocs;
    size_t live_bytes;
    size_t total_allocs;
    size_t peak_bytes;
    /* os.args(): built once, owned by the context */
    nx_sl_u8* args_cache;
    size_t args_len;
} nx_ctx;

/* ------------------------------------------------------------------ panics */
typedef struct nx_boundary {
    jmp_buf jb;
    char msg[256];
    char loc[128];
} nx_boundary;

static NX_THREAD_LOCAL nx_boundary* nx_tls_boundary = NULL;
static NX_THREAD_LOCAL char nx_tls_last_panic[256];

NX_NORETURN NX_INLINE void nx_panic(const char* msg, const char* loc) {
    if (nx_tls_boundary) {
        nx_boundary* b = nx_tls_boundary;
        snprintf(b->msg, sizeof b->msg, "%s", msg);
        snprintf(b->loc, sizeof b->loc, "%s", loc ? loc : "");
        snprintf(nx_tls_last_panic, sizeof nx_tls_last_panic, "%s (at %s)", msg, loc ? loc : "?");
        longjmp(b->jb, 1);
    }
    fprintf(stderr, "panic: %s\n  at %s\n", msg, loc ? loc : "?");
    fflush(stderr);
    abort();
}

NX_NORETURN NX_INLINE void nx_panic_bounds(size_t i, size_t len, const char* loc) {
    char buf[128];
    snprintf(buf, sizeof buf, "index %zu out of bounds for length %zu", i, len);
    nx_panic(buf, loc);
}

/* pointer + offset that is defined for a null pointer: an empty slice has no
 * storage, and `NULL + 0` is undefined in C (UBSan traps it) */
#define nx_padd(p, n) ((n) ? (p) + (n) : (p))

NX_INLINE size_t nx_idx(size_t i, size_t len, const char* loc) {
    if (i >= len) nx_panic_bounds(i, len, loc);
    return i;
}

NX_INLINE void nx_slice_check(size_t start, size_t end, size_t len, const char* loc) {
    if (start > end || end > len) {
        char buf[128];
        snprintf(buf, sizeof buf, "slice %zu..%zu out of range for length %zu", start, end, len);
        nx_panic(buf, loc);
    }
}

NX_INLINE nx_i128 nx_cast_check(nx_i128 v, nx_i128 lo, nx_i128 hi, const char* loc) {
    if (v < lo || v > hi) nx_panic("value does not fit the target type", loc);
    return v;
}

NX_INLINE int64_t nx_f2i(double f, nx_i128 lo, nx_i128 hi, const char* loc) {
    if (!(f == f) || f < (double)lo || f > (double)hi) nx_panic("float to integer cast out of range", loc);
    return (int64_t)f;
}

/* ------------------------------------------------------- default allocator */
#ifdef NX_LEAK_CHECK
/* the tracking allocator keeps its counters in the context (no globals) */
NX_INLINE void nx_track(void* st, ptrdiff_t allocs, ptrdiff_t bytes) {
    struct nx_ctx* c = (struct nx_ctx*)st;
    if (!c) return;
    c->live_allocs = (size_t)((ptrdiff_t)c->live_allocs + allocs);
    c->live_bytes = (size_t)((ptrdiff_t)c->live_bytes + bytes);
    if (allocs > 0) c->total_allocs++;
    if (c->live_bytes > c->peak_bytes) c->peak_bytes = c->live_bytes;
}
#endif
NX_INLINE void* nx_malloc_alloc(void* st, size_t size, size_t align) {
    NX_UNUSED(st); NX_UNUSED(align);
    void* p = malloc(size ? size : 1);
    if (!p) nx_panic("out of memory", "allocator");
#ifdef NX_LEAK_CHECK
    nx_track(st, 1, (ptrdiff_t)size);
#endif
    return p;
}
NX_INLINE void* nx_malloc_realloc(void* st, void* p, size_t old_size, size_t new_size, size_t align) {
    NX_UNUSED(st); NX_UNUSED(old_size); NX_UNUSED(align);
    void* q = realloc(p, new_size ? new_size : 1);
    if (!q) nx_panic("out of memory", "allocator");
#ifdef NX_LEAK_CHECK
    nx_track(st, p ? 0 : 1, (ptrdiff_t)new_size - (ptrdiff_t)old_size);
#endif
    return q;
}
NX_INLINE void nx_malloc_free(void* st, void* p, size_t size) {
    NX_UNUSED(st); NX_UNUSED(size);
#ifdef NX_LEAK_CHECK
    if (p) nx_track(st, -1, -(ptrdiff_t)size);
#endif
    free(p);
}
NX_INLINE void nx_leak_report(struct nx_ctx* c) {
#ifdef NX_LEAK_CHECK
    fflush(stdout);
    if (c->live_allocs == 0) {
        fprintf(stderr, "leaks: none (%zu allocation(s), peak %zu bytes)\n", c->total_allocs, c->peak_bytes);
    } else {
        fprintf(stderr, "leaks: %zu allocation(s) still live at exit, %zu bytes (of %zu total, peak %zu bytes)\n", c->live_allocs, c->live_bytes, c->total_allocs, c->peak_bytes);
        fprintf(stderr, "       a live `ref class` cycle or a value moved into a container that was never released is the usual cause (spec 5.4: use `weak` at back edges)\n");
    }
#else
    NX_UNUSED(c);
#endif
}

NX_INLINE nx_ctx nx_default_ctx(int argc, char** argv) {
    nx_ctx c;
    c.alloc.alloc = nx_malloc_alloc;
    c.alloc.realloc = nx_malloc_realloc;
    c.alloc.free = nx_malloc_free;
    c.alloc.state = NULL;
    c.base = c.alloc;
    c.arena = NULL;
    c.rng = 0x9E3779B97F4A7C15ULL;
    c.rng_seeded = false;
    c.argc = argc;
    c.argv = argv;
    c.out = stdout;
    c.err = stderr;
    c.live_allocs = 0; c.live_bytes = 0; c.total_allocs = 0; c.peak_bytes = 0;
    c.args_cache = NULL; c.args_len = 0;
#if defined(_WIN32)
    /* byte-exact output on every platform: no CRLF translation */
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
#endif
    return c;
}
/* the architecture this program runs on; the driver chooses a CPU baseline by it */
NX_INLINE nx_sl_u8 nx_host_arch(void) {
#if defined(__x86_64__) || defined(_M_X64)
    return nx_lit("x86_64", 6);
#elif defined(__aarch64__) || defined(_M_ARM64)
    return nx_lit("aarch64", 7);
#elif defined(__i386__) || defined(_M_IX86)
    return nx_lit("x86", 3);
#elif defined(__arm__) || defined(_M_ARM)
    return nx_lit("arm", 3);
#elif defined(__riscv) && (__riscv_xlen == 64)
    return nx_lit("riscv64", 7);
#else
    return nx_lit("unknown", 7);
#endif
}
/* UTF-8 on the Windows console for the program's life (the console's own code
   page shows `é` as two symbols); the previous page comes back at exit */
#if defined(_WIN32)
static UINT nx_prev_console_cp = 0;
static void nx_console_restore(void) { if (nx_prev_console_cp) SetConsoleOutputCP(nx_prev_console_cp); }
#endif
NX_INLINE void nx_console_utf8(void) {
#if defined(_WIN32)
    UINT cur = GetConsoleOutputCP();
    if (cur != 0 && cur != 65001) { nx_prev_console_cp = cur; SetConsoleOutputCP(65001); atexit(nx_console_restore); }
#endif
}
/* the tracking allocator needs the context as its state; installed by entry points */
NX_INLINE void nx_ctx_track_self(nx_ctx* c) {
#ifdef NX_LEAK_CHECK
    c->alloc.state = c;
    c->base.state = c;
#else
    NX_UNUSED(c);
#endif
}

NX_INLINE void* nx_alloc_bytes(nx_ctx* c, size_t size, size_t align) { return c->alloc.alloc(c->alloc.state, size, align); }
/* A debug build fills storage with a fixed byte before freeing it, so a
 * view that outlived its storage (specification 5.6) reads garbage or
 * panics on its length instead of yielding the old contents by luck. */
NX_INLINE void nx_free_bytes(nx_ctx* c, void* p, size_t size) {
    if (!p) return;
#ifdef NX_MODE_DEBUG
    memset(p, 0xDD, size);
#endif
    c->alloc.free(c->alloc.state, p, size);
}
NX_INLINE void nx_ctx_release(nx_ctx* c) {
    if (c->args_cache) { nx_free_bytes(c, c->args_cache, (c->args_len ? c->args_len : 1) * sizeof(nx_sl_u8)); c->args_cache = NULL; }
}
NX_INLINE nx_sl_u8* nx_args(nx_ctx* c, size_t* n) {
    if (!c->args_cache) {
        size_t k = c->argc > 0 ? (size_t)c->argc : 0;
        c->args_cache = (nx_sl_u8*)nx_alloc_bytes(c, (k ? k : 1) * sizeof(nx_sl_u8), 8);
        for (size_t i = 0; i < k; i++) { c->args_cache[i].ptr = (uint8_t*)c->argv[i]; c->args_cache[i].len = strlen(c->argv[i]); }
        c->args_len = k;
    }
    *n = c->args_len;
    return c->args_cache;
}

/* ----------------------------------------------------------------- arena */
/* A bump allocator over chunks taken from the parent context. `free` is a
 * no-op; everything is released when the `using arena { }` block ends. */
typedef struct nx_arena_chunk { struct nx_arena_chunk* next; size_t cap; size_t used; } nx_arena_chunk;
typedef struct nx_arena { nx_ctx* parent; nx_arena_chunk* head; void* last; size_t last_size; } nx_arena;

NX_INLINE void* nx_arena_alloc(void* st, size_t size, size_t align) {
    nx_arena* a = (nx_arena*)st;
    if (align < 16) align = 16;
    size_t need = (size + align - 1) / align * align;
    nx_arena_chunk* ch = a->head;
    if (!ch || ch->used + need > ch->cap) {
        size_t cap = need > 65536 - sizeof(nx_arena_chunk) ? need + sizeof(nx_arena_chunk) : 65536;
        nx_arena_chunk* n = (nx_arena_chunk*)nx_alloc_bytes(a->parent, cap, 16);
        n->next = ch; n->cap = cap; n->used = (sizeof(nx_arena_chunk) + 15) / 16 * 16;
        a->head = ch = n;
    }
    void* p = (uint8_t*)ch + ch->used;
    ch->used += need;
    a->last = p; a->last_size = need;
    return p;
}
NX_INLINE bool nx_arena_owns(const nx_arena* a, const void* p) {
    for (const nx_arena_chunk* ch = a->head; ch; ch = ch->next)
        if ((const uint8_t*)p >= (const uint8_t*)ch && (const uint8_t*)p < (const uint8_t*)ch + ch->cap) return true;
    return false;
}
NX_INLINE void* nx_arena_realloc(void* st, void* p, size_t old_size, size_t new_size, size_t align) {
    nx_arena* a = (nx_arena*)st;
    if (p && !nx_arena_owns(a, p)) return a->parent->alloc.realloc(a->parent->alloc.state, p, old_size, new_size, align);
    if (p && p == a->last) {
        nx_arena_chunk* ch = a->head;
        size_t need = (new_size + 15) / 16 * 16;
        if (ch->used - a->last_size + need <= ch->cap) { ch->used = ch->used - a->last_size + need; a->last_size = need; return p; }
    }
    void* q = nx_arena_alloc(st, new_size, align);
    if (p && old_size) memcpy(q, p, old_size < new_size ? old_size : new_size);
    return q;
}
NX_INLINE void nx_arena_free(void* st, void* p, size_t size) {
    nx_arena* a = (nx_arena*)st;
    if (p && !nx_arena_owns(a, p)) a->parent->alloc.free(a->parent->alloc.state, p, size);
}
NX_INLINE nx_ctx nx_arena_begin(nx_ctx* parent, nx_arena* a) {
    a->parent = parent; a->head = NULL; a->last = NULL; a->last_size = 0;
    nx_ctx sub = *parent;
    sub.alloc.alloc = nx_arena_alloc; sub.alloc.realloc = nx_arena_realloc; sub.alloc.free = nx_arena_free; sub.alloc.state = a;
    sub.arena = a;
    return sub;
}
/* Container storage goes to the container's own arena, or to the root allocator. */
NX_INLINE void* nx_cont_alloc(nx_ctx* c, nx_arena* ar, size_t size, size_t align) {
    return ar ? nx_arena_alloc(ar, size, align) : c->base.alloc(c->base.state, size, align);
}
NX_INLINE void* nx_cont_realloc(nx_ctx* c, nx_arena* ar, void* p, size_t old_size, size_t new_size, size_t align) {
    return ar ? nx_arena_realloc(ar, p, old_size, new_size, align) : c->base.realloc(c->base.state, p, old_size, new_size, align);
}
NX_INLINE void nx_cont_free(nx_ctx* c, nx_arena* ar, void* p, size_t size) {
    if (p && !ar) c->base.free(c->base.state, p, size);
}
NX_INLINE void nx_arena_end(nx_arena* a) {
    nx_arena_chunk* ch = a->head;
    while (ch) { nx_arena_chunk* n = ch->next; nx_free_bytes(a->parent, ch, ch->cap); ch = n; }
    a->head = NULL;
}

/* ------------------------------------------------------------ parallel for */
typedef void (*nx_par_fn)(nx_ctx*, void*, size_t, size_t);
typedef struct nx_par_task { nx_ctx ctx; nx_par_fn f; void* env; size_t begin; size_t end; bool panicked; char msg[256]; char loc[128]; } nx_par_task;

NX_INLINE void nx_par_run(nx_par_task* t) {
    nx_boundary b;
    nx_boundary* prev = nx_tls_boundary;
    nx_tls_boundary = &b;
    if (setjmp(b.jb)) {
        t->panicked = true;
        snprintf(t->msg, sizeof t->msg, "%s", b.msg);
        snprintf(t->loc, sizeof t->loc, "%s", b.loc);
    } else {
        t->f(&t->ctx, t->env, t->begin, t->end);
    }
    nx_tls_boundary = prev;
}
#if defined(_WIN32)
static DWORD WINAPI nx_par_thread(LPVOID p) { nx_par_run((nx_par_task*)p); return 0; }
NX_INLINE size_t nx_hw_threads(void) { SYSTEM_INFO si; GetSystemInfo(&si); return si.dwNumberOfProcessors ? si.dwNumberOfProcessors : 1; }
#else
#include <pthread.h>
static void* nx_par_thread(void* p) { nx_par_run((nx_par_task*)p); return NULL; }
NX_INLINE size_t nx_hw_threads(void) { long n = sysconf(_SC_NPROCESSORS_ONLN); return n > 0 ? (size_t)n : 1; }
#endif

/* Runs f over [0, n) split across worker threads. Each worker gets its own
 * context (no shared allocator state); a panic in any worker is re-raised in
 * the calling thread after every worker has finished. */
NX_INLINE void nx_parallel_for(nx_ctx* c, size_t n, nx_par_fn f, void* env, const char* loc) {
    if (n == 0) return;
    size_t workers = nx_hw_threads();
    if (workers > 64) workers = 64;
    if (workers > n) workers = n;
    if (workers <= 1) { f(c, env, 0, n); return; }
    nx_par_task tasks[64];
    size_t chunk = (n + workers - 1) / workers;
#if defined(_WIN32)
    HANDLE handles[64];
#else
    pthread_t handles[64];
#endif
    for (size_t w = 0; w < workers; w++) {
        tasks[w].ctx = *c;
        tasks[w].ctx.live_allocs = 0; tasks[w].ctx.live_bytes = 0; tasks[w].ctx.total_allocs = 0; tasks[w].ctx.peak_bytes = 0;
        nx_ctx_track_self(&tasks[w].ctx);
        tasks[w].ctx.rng ^= (uint64_t)(w + 1) * 0x9E3779B97F4A7C15ULL;
        tasks[w].f = f; tasks[w].env = env; tasks[w].panicked = false;
        tasks[w].begin = w * chunk;
        tasks[w].end = (w + 1) * chunk < n ? (w + 1) * chunk : n;
#if defined(_WIN32)
        handles[w] = CreateThread(NULL, 0, nx_par_thread, &tasks[w], 0, NULL);
        if (!handles[w]) nx_par_run(&tasks[w]);
#else
        if (pthread_create(&handles[w], NULL, nx_par_thread, &tasks[w]) != 0) { nx_par_run(&tasks[w]); handles[w] = 0; }
#endif
    }
    for (size_t w = 0; w < workers; w++) {
#if defined(_WIN32)
        if (handles[w]) { WaitForSingleObject(handles[w], INFINITE); CloseHandle(handles[w]); }
#else
        if (handles[w]) pthread_join(handles[w], NULL);
#endif
        c->live_allocs += tasks[w].ctx.live_allocs;
        c->live_bytes += tasks[w].ctx.live_bytes;
        c->total_allocs += tasks[w].ctx.total_allocs;
    }
    for (size_t w = 0; w < workers; w++) {
        if (tasks[w].panicked) {
            char buf[400];
            snprintf(buf, sizeof buf, "%s (in a parallel worker at %s)", tasks[w].msg, tasks[w].loc);
            nx_panic(buf, loc);
        }
    }
}

/* --------------------------------------------------------------- lists */
NX_INLINE void nx_list_grow(nx_ctx* c, nx_rawlist* l, size_t elem, size_t align, size_t min_cap) {
    size_t cap = l->cap ? l->cap * 2 : 4;
    if (cap < min_cap) cap = min_cap;
    l->ptr = nx_cont_realloc(c, l->ar, l->ptr, l->cap * elem, cap * elem, align);
    l->cap = cap;
}
NX_INLINE void nx_list_free(nx_ctx* c, nx_rawlist* l, size_t elem) {
    nx_cont_free(c, l->ar, l->ptr, l->cap * elem);
    l->ptr = NULL; l->len = 0; l->cap = 0;
}
NX_INLINE void nx_list_reserve(nx_ctx* c, nx_rawlist* l, size_t elem, size_t align, size_t extra) {
    if (l->len + extra > l->cap) nx_list_grow(c, l, elem, align, l->len + extra);
}
NX_INLINE nx_rawlist nx_list_clone_raw(nx_ctx* c, const nx_rawlist* l, size_t elem, size_t align) {
    nx_rawlist r; r.ptr = NULL; r.len = 0; r.cap = 0; r.ar = c->arena;
    if (l->len) {
        r.ptr = nx_cont_alloc(c, r.ar, l->len * elem, align);
        memcpy(r.ptr, l->ptr, l->len * elem);
        r.len = l->len; r.cap = l->len;
    }
    return r;
}

/* -------------------------------------------------------------- strings */
NX_INLINE void nx_str_reserve(nx_ctx* c, nx_string* s, size_t extra) {
    if (s->len + extra > s->cap) nx_list_grow(c, (nx_rawlist*)s, 1, 1, s->len + extra);
}
NX_INLINE void nx_str_append(nx_ctx* c, nx_string* s, const uint8_t* p, size_t n) {
    nx_str_reserve(c, s, n);
    if (n) memcpy(s->ptr + s->len, p, n);
    s->len += n;
}
NX_INLINE nx_string nx_str_from(nx_ctx* c, nx_sl_u8 src) {
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    nx_str_append(c, &s, src.ptr, src.len);
    return s;
}
NX_INLINE void nx_str_free(nx_ctx* c, nx_string* s) { nx_list_free(c, (nx_rawlist*)s, 1); }
NX_INLINE nx_sl_u8 nx_str_slice(nx_string s) { nx_sl_u8 r; r.ptr = s.ptr; r.len = s.len; return r; }
NX_INLINE size_t nx_utf8_encode(uint32_t cp, uint8_t* out) {
    if (cp < 0x80) { out[0] = (uint8_t)cp; return 1; }
    if (cp < 0x800) { out[0] = (uint8_t)(0xC0 | (cp >> 6)); out[1] = (uint8_t)(0x80 | (cp & 0x3F)); return 2; }
    if (cp < 0x10000) { out[0] = (uint8_t)(0xE0 | (cp >> 12)); out[1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F)); out[2] = (uint8_t)(0x80 | (cp & 0x3F)); return 3; }
    out[0] = (uint8_t)(0xF0 | (cp >> 18)); out[1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F)); out[2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F)); out[3] = (uint8_t)(0x80 | (cp & 0x3F)); return 4;
}
NX_INLINE void nx_str_append_char(nx_ctx* c, nx_string* s, uint32_t cp) {
    uint8_t buf[4];
    size_t n = nx_utf8_encode(cp, buf);
    nx_str_append(c, s, buf, n);
}

NX_INLINE bool nx_sl_eq(nx_sl_u8 a, nx_sl_u8 b) { return a.len == b.len && (a.len == 0 || memcmp(a.ptr, b.ptr, a.len) == 0); }
NX_INLINE int nx_sl_cmp(nx_sl_u8 a, nx_sl_u8 b) {
    size_t n = a.len < b.len ? a.len : b.len;
    int r = n ? memcmp(a.ptr, b.ptr, n) : 0;
    if (r) return r;
    return a.len < b.len ? -1 : (a.len > b.len ? 1 : 0);
}
NX_INLINE bool nx_sl_starts_with(nx_sl_u8 a, nx_sl_u8 p) { return a.len >= p.len && memcmp(a.ptr, p.ptr, p.len) == 0; }
NX_INLINE bool nx_sl_ends_with(nx_sl_u8 a, nx_sl_u8 p) { return a.len >= p.len && (p.len == 0 || memcmp(a.ptr + a.len - p.len, p.ptr, p.len) == 0); }
NX_INLINE bool nx_sl_find(nx_sl_u8 a, nx_sl_u8 n, size_t* out) {
    if (n.len == 0) { *out = 0; return true; }
    if (a.len < n.len) return false;
    for (size_t i = 0; i + n.len <= a.len; i++) {
        if (a.ptr[i] == n.ptr[0] && memcmp(a.ptr + i, n.ptr, n.len) == 0) { *out = i; return true; }
    }
    return false;
}
NX_INLINE nx_sl_u8 nx_sl_trim(nx_sl_u8 a) {
    size_t s = 0, e = a.len;
    while (s < e && (a.ptr[s] == ' ' || a.ptr[s] == '\t' || a.ptr[s] == '\n' || a.ptr[s] == '\r')) s++;
    while (e > s && (a.ptr[e - 1] == ' ' || a.ptr[e - 1] == '\t' || a.ptr[e - 1] == '\n' || a.ptr[e - 1] == '\r')) e--;
    nx_sl_u8 r; r.ptr = nx_padd(a.ptr, s); r.len = e - s; return r;
}
NX_INLINE bool nx_sl_eq_ignore_case(nx_sl_u8 a, nx_sl_u8 b) {
    if (a.len != b.len) return false;
    for (size_t i = 0; i < a.len; i++) {
        uint8_t x = a.ptr[i], y = b.ptr[i];
        if (x >= 'A' && x <= 'Z') x += 32;
        if (y >= 'A' && y <= 'Z') y += 32;
        if (x != y) return false;
    }
    return true;
}
/* parse a decimal/hex integer; returns 0 ok, 1 invalid, 2 overflow */
NX_INLINE int nx_parse_int(nx_sl_u8 s, nx_i128 lo, nx_i128 hi, nx_i128* out) {
    size_t i = 0; bool neg = false;
    s = nx_sl_trim(s);
    if (s.len == 0) return 1;
    if (s.ptr[0] == '-') { neg = true; i = 1; } else if (s.ptr[0] == '+') { i = 1; }
    if (i >= s.len) return 1;
    nx_i128 v = 0; int base = 10;
    if (i + 1 < s.len && s.ptr[i] == '0' && (s.ptr[i + 1] == 'x' || s.ptr[i + 1] == 'X')) { base = 16; i += 2; }
    for (; i < s.len; i++) {
        uint8_t ch = s.ptr[i]; int d;
        if (ch == '_') continue;
        if (ch >= '0' && ch <= '9') d = ch - '0';
        else if (base == 16 && ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
        else if (base == 16 && ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
        else return 1;
        /* overflow of the accumulator itself: the range check below cannot see it */
        if (v > (NX_I128_MAX - d) / base) return 2;
        v = v * base + d;
    }
    if (neg) v = -v;
    if (v < lo || v > hi) return 2;
    *out = v;
    return 0;
}
NX_INLINE bool nx_parse_float(nx_sl_u8 s, double* out) {
    char buf[64];
    s = nx_sl_trim(s);
    if (s.len == 0 || s.len >= sizeof buf) return false;
    memcpy(buf, s.ptr, s.len); buf[s.len] = 0;
    char* end = NULL;
    double v = strtod(buf, &end);
    if (end != buf + s.len) return false;
    *out = v;
    return true;
}

/* -------------------------------------------------------------- formatting */
typedef struct nx_sink { nx_ctx* ctx; nx_string* str; FILE* f; char buf[512]; size_t n; } nx_sink;
NX_INLINE nx_sink nx_sink_file(nx_ctx* c, FILE* f) { nx_sink s; s.ctx = c; s.str = NULL; s.f = f; s.n = 0; return s; }
NX_INLINE nx_sink nx_sink_str(nx_ctx* c, nx_string* str) { nx_sink s; s.ctx = c; s.str = str; s.f = NULL; s.n = 0; return s; }
NX_INLINE void nx_sink_flush(nx_sink* s) { if (s->f && s->n) { fwrite(s->buf, 1, s->n, s->f); s->n = 0; } if (s->f) fflush(s->f); }
NX_INLINE void nx_w(nx_sink* s, const uint8_t* p, size_t n) {
    if (s->str) { nx_str_append(s->ctx, s->str, p, n); return; }
    if (n > sizeof s->buf) { nx_sink_flush(s); fwrite(p, 1, n, s->f); return; }
    if (s->n + n > sizeof s->buf) { fwrite(s->buf, 1, s->n, s->f); s->n = 0; }
    memcpy(s->buf + s->n, p, n); s->n += n;
}
NX_INLINE void nx_w_cstr(nx_sink* s, const char* p) { nx_w(s, (const uint8_t*)p, strlen(p)); }
NX_INLINE void nx_w_sl(nx_sink* s, nx_sl_u8 v) { nx_w(s, v.ptr, v.len); }
NX_INLINE void nx_w_pad(nx_sink* s, const char* txt, size_t len, int width, bool left) {
    if (width > 0 && (size_t)width > len && !left) { for (size_t i = len; i < (size_t)width; i++) nx_w(s, (const uint8_t*)" ", 1); }
    nx_w(s, (const uint8_t*)txt, len);
    if (width > 0 && (size_t)width > len && left) { for (size_t i = len; i < (size_t)width; i++) nx_w(s, (const uint8_t*)" ", 1); }
}
/* base: 10, 16 (lower), 17 (upper), 2, 8 */
NX_INLINE void nx_w_int(nx_sink* s, nx_i128 v, int base, int width, bool left) {
    char buf[140]; size_t i = sizeof buf; bool neg = v < 0;
    nx_u128 u = neg ? (nx_u128)(-(v + 1)) + 1 : (nx_u128)v;
    int b = base == 17 ? 16 : base;
    const char* digits = base == 17 ? "0123456789ABCDEF" : "0123456789abcdef";
    if (u == 0) buf[--i] = '0';
    while (u) { buf[--i] = digits[u % b]; u /= b; }
    if (neg) buf[--i] = '-';
    nx_w_pad(s, buf + i, sizeof buf - i, width, left);
}
NX_INLINE void nx_w_float(nx_sink* s, double v, int prec, bool exp, int width, bool left) {
    char buf[64];
    if (v != v) { snprintf(buf, sizeof buf, "nan"); }
    else if (isinf(v)) { snprintf(buf, sizeof buf, v > 0 ? "inf" : "-inf"); }
    else if (exp) { snprintf(buf, sizeof buf, "%.*e", prec < 0 ? 6 : prec, v); }
    else if (prec >= 0) { snprintf(buf, sizeof buf, "%.*f", prec, v); }
    else if (v == floor(v) && fabs(v) < 1e16) { snprintf(buf, sizeof buf, "%.1f", v); }
    else { /* the shortest text that reads back as the same value */
        int p = 1;
        for (; p <= 17; p++) { snprintf(buf, sizeof buf, "%.*g", p, v); if (strtod(buf, NULL) == v) break; }
    }
    nx_w_pad(s, buf, strlen(buf), width, left);
}
NX_INLINE void nx_w_bool(nx_sink* s, bool b) { nx_w_cstr(s, b ? "true" : "false"); }
NX_INLINE void nx_w_char(nx_sink* s, uint32_t cp) { uint8_t buf[4]; size_t n = nx_utf8_encode(cp, buf); nx_w(s, buf, n); }

/* --------------------------------------------------------------- maps */
/* Open addressing with linear probing. Keys and values are stored as raw bytes.
 * key_kind: 0 = inline bytes, 1 = nx_sl_u8 (content hashed, storage borrowed),
 *           2 = nx_string (content hashed, owned by the map). */
typedef struct nx_map {
    uint8_t* keys; uint8_t* vals; uint8_t* state;
    size_t cap; size_t len; size_t ksize; size_t vsize; int key_kind;
    nx_arena* ar;
} nx_map;

NX_INLINE uint64_t nx_hash_bytes(const uint8_t* p, size_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    h ^= h >> 32;
    return h;
}
NX_INLINE nx_sl_u8 nx_map_key_bytes(const nx_map* m, const void* key) {
    nx_sl_u8 r;
    if (m->key_kind == 0) { r.ptr = (uint8_t*)key; r.len = m->ksize; }
    else { const nx_sl_u8* s = (const nx_sl_u8*)key; r.ptr = s->ptr; r.len = s->len; }
    return r;
}
NX_INLINE nx_map nx_map_new(nx_ctx* c, size_t ksize, size_t vsize, int key_kind) {
    nx_map m; memset(&m, 0, sizeof m); m.ksize = ksize; m.vsize = vsize; m.key_kind = key_kind; m.ar = c->arena; return m;
}
NX_INLINE bool nx_map_lookup(const nx_map* m, const void* key, size_t* slot) {
    if (m->cap == 0) return false;
    nx_sl_u8 kb = nx_map_key_bytes(m, key);
    uint64_t h = nx_hash_bytes(kb.ptr, kb.len);
    size_t i = (size_t)(h % m->cap);
    for (size_t n = 0; n < m->cap; n++) {
        uint8_t st = m->state[i];
        if (st == 0) { *slot = i; return false; }
        if (st == 1) {
            nx_sl_u8 ob = nx_map_key_bytes(m, m->keys + i * m->ksize);
            if (nx_sl_eq(ob, kb)) { *slot = i; return true; }
        }
        i = (i + 1) % m->cap;
    }
    *slot = m->cap;
    return false;
}
NX_INLINE void nx_map_rehash(nx_ctx* c, nx_map* m, size_t new_cap);
NX_INLINE void nx_map_insert_raw(nx_ctx* c, nx_map* m, const void* key, const void* val) {
    if ((m->len + 1) * 4 >= m->cap * 3) nx_map_rehash(c, m, m->cap ? m->cap * 2 : 8);
    size_t slot;
    if (nx_map_lookup(m, key, &slot)) {
        memcpy(m->vals + slot * m->vsize, val, m->vsize);
        return;
    }
    if (slot >= m->cap) { nx_map_rehash(c, m, m->cap * 2); nx_map_lookup(m, key, &slot); }
    memcpy(m->keys + slot * m->ksize, key, m->ksize);
    memcpy(m->vals + slot * m->vsize, val, m->vsize);
    m->state[slot] = 1;
    m->len++;
}
NX_INLINE void nx_map_rehash(nx_ctx* c, nx_map* m, size_t new_cap) {
    nx_map n = nx_map_new(c, m->ksize, m->vsize, m->key_kind);
    n.cap = new_cap;
    n.ar = m->ar;
    n.keys = (uint8_t*)nx_cont_alloc(c, n.ar, new_cap * m->ksize, 16);
    n.vals = (uint8_t*)nx_cont_alloc(c, n.ar, new_cap * (m->vsize ? m->vsize : 1), 16);
    n.state = (uint8_t*)nx_cont_alloc(c, n.ar, new_cap, 1);
    memset(n.state, 0, new_cap);
    for (size_t i = 0; i < m->cap; i++) {
        if (m->state[i] == 1) nx_map_insert_raw(c, &n, m->keys + i * m->ksize, m->vals + i * m->vsize);
    }
    nx_cont_free(c, m->ar, m->keys, m->cap * m->ksize);
    nx_cont_free(c, m->ar, m->vals, m->cap * (m->vsize ? m->vsize : 1));
    nx_cont_free(c, m->ar, m->state, m->cap);
    *m = n;
}
/* returns pointer to the existing value slot, or NULL */
NX_INLINE void* nx_map_get(const nx_map* m, const void* key) {
    size_t slot;
    if (nx_map_lookup(m, key, &slot)) return m->vals + slot * m->vsize;
    return NULL;
}
/* returns true if an existing entry was replaced (the old key/value are returned in old_key/old_val for dropping) */
NX_INLINE bool nx_map_put(nx_ctx* c, nx_map* m, const void* key, const void* val, void* old_key, void* old_val) {
    size_t slot;
    if (nx_map_lookup(m, key, &slot)) {
        if (old_key) memcpy(old_key, m->keys + slot * m->ksize, m->ksize);
        if (old_val) memcpy(old_val, m->vals + slot * m->vsize, m->vsize);
        memcpy(m->keys + slot * m->ksize, key, m->ksize);
        memcpy(m->vals + slot * m->vsize, val, m->vsize);
        return true;
    }
    nx_map_insert_raw(c, m, key, val);
    return false;
}
NX_INLINE bool nx_map_remove(nx_map* m, const void* key, void* old_key, void* old_val) {
    size_t slot;
    if (!nx_map_lookup(m, key, &slot)) return false;
    if (old_key) memcpy(old_key, m->keys + slot * m->ksize, m->ksize);
    if (old_val) memcpy(old_val, m->vals + slot * m->vsize, m->vsize);
    m->state[slot] = 2; /* tombstone */
    m->len--;
    return true;
}
NX_INLINE void nx_map_free_storage(nx_ctx* c, nx_map* m) {
    nx_cont_free(c, m->ar, m->keys, m->cap * m->ksize);
    nx_cont_free(c, m->ar, m->vals, m->cap * (m->vsize ? m->vsize : 1));
    nx_cont_free(c, m->ar, m->state, m->cap);
    m->keys = NULL; m->vals = NULL; m->state = NULL; m->cap = 0; m->len = 0;
}
/* iterate: start with i = 0; returns false when done */
NX_INLINE bool nx_map_next(const nx_map* m, size_t* i, void** key, void** val) {
    while (*i < m->cap) {
        size_t k = (*i)++;
        if (m->state[k] == 1) { *key = m->keys + k * m->ksize; *val = m->vals + k * m->vsize; return true; }
    }
    return false;
}
NX_INLINE nx_map nx_map_clone_raw(nx_ctx* c, const nx_map* m) {
    nx_map n = nx_map_new(c, m->ksize, m->vsize, m->key_kind);
    if (m->cap) {
        n.cap = m->cap;
        n.keys = (uint8_t*)nx_cont_alloc(c, n.ar, m->cap * m->ksize, 16);
        n.vals = (uint8_t*)nx_cont_alloc(c, n.ar, m->cap * (m->vsize ? m->vsize : 1), 16);
        n.state = (uint8_t*)nx_cont_alloc(c, n.ar, m->cap, 1);
        memcpy(n.keys, m->keys, m->cap * m->ksize);
        memcpy(n.vals, m->vals, m->cap * (m->vsize ? m->vsize : 1));
        memcpy(n.state, m->state, m->cap);
        n.len = m->len;
    }
    return n;
}

/* ------------------------------------------------------ reference counting */
typedef struct nx_obj_header { size_t rc; size_t weak; } nx_obj_header;
NX_INLINE void* nx_retain(void* p) { if (p) ((nx_obj_header*)p)->rc++; return p; }
NX_INLINE void* nx_weak_new(void* p) { if (p) ((nx_obj_header*)p)->weak++; return p; }
/* returns true when the object is alive (and retains it) */
NX_INLINE bool nx_weak_upgrade(void* p) { if (p && ((nx_obj_header*)p)->rc > 0) { ((nx_obj_header*)p)->rc++; return true; } return false; }

/* --------------------------------------------------------------- binary */
NX_INLINE uint64_t nx_bits_read(const uint8_t* p, size_t bit, size_t n) {
    uint64_t v = 0;
    /* fast path: byte aligned */
    if ((bit & 7) == 0 && (n & 7) == 0) {
        const uint8_t* q = p + bit / 8;
        for (size_t i = 0; i < n / 8; i++) v = (v << 8) | q[i];
        return v;
    }
    for (size_t i = 0; i < n; i++) {
        size_t b = bit + i;
        v = (v << 1) | ((p[b >> 3] >> (7 - (b & 7))) & 1);
    }
    return v;
}
NX_INLINE void nx_bits_write(uint8_t* p, size_t bit, size_t n, uint64_t v) {
    if ((bit & 7) == 0 && (n & 7) == 0) {
        uint8_t* q = p + bit / 8;
        for (size_t i = 0; i < n / 8; i++) q[i] = (uint8_t)(v >> ((n / 8 - 1 - i) * 8));
        return;
    }
    for (size_t i = 0; i < n; i++) {
        size_t b = bit + i;
        uint8_t bitv = (uint8_t)((v >> (n - 1 - i)) & 1);
        if (bitv) p[b >> 3] |= (uint8_t)(0x80 >> (b & 7));
        else p[b >> 3] &= (uint8_t)~(0x80 >> (b & 7));
    }
}
NX_INLINE uint64_t nx_bswap(uint64_t v, size_t nbytes) {
    uint64_t r = 0;
    for (size_t i = 0; i < nbytes; i++) r |= ((v >> (i * 8)) & 0xff) << ((nbytes - 1 - i) * 8);
    return r;
}
NX_INLINE bool nx_is_little_endian(void) { uint16_t x = 1; return *(uint8_t*)&x == 1; }
NX_INLINE int64_t nx_sign_extend(uint64_t v, size_t n) {
    if (n >= 64) return (int64_t)v;
    uint64_t m = 1ULL << (n - 1);
    return (int64_t)((v ^ m) - m);
}

/* ------------------------------------------------------------------ misc */
NX_INLINE int64_t nx_time_now_ms(void) {
#if defined(_WIN32)
    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (int64_t)(t / 10000) - 11644473600000LL;
#else
    struct timeval tv; gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
#endif
}
/* minutes east of UTC of local time at the given instant (0 when unknown) */
NX_INLINE int64_t nx_time_utc_offset_min(int64_t epoch_ms) {
    time_t t = (time_t)(epoch_ms / 1000);
    struct tm loc, utc;
#if defined(_WIN32)
    if (localtime_s(&loc, &t) != 0 || gmtime_s(&utc, &t) != 0) return 0;
#else
    if (!localtime_r(&t, &loc) || !gmtime_r(&t, &utc)) return 0;
#endif
    int64_t lmin = ((int64_t)loc.tm_yday * 1440) + loc.tm_hour * 60 + loc.tm_min;
    int64_t umin = ((int64_t)utc.tm_yday * 1440) + utc.tm_hour * 60 + utc.tm_min;
    int64_t diff = lmin - umin;
    if (loc.tm_year != utc.tm_year) diff += loc.tm_year > utc.tm_year ? 365 * 1440 : -365 * 1440;
    return diff;
}
NX_INLINE uint64_t nx_time_monotonic_ns(void) {
#if defined(_WIN32)
    LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c);
    return (uint64_t)((double)c.QuadPart * 1e9 / (double)f.QuadPart);
#else
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
}
NX_INLINE void nx_sleep_ms(uint64_t ms) {
#if defined(_WIN32)
    Sleep((DWORD)ms);
#else
    usleep((useconds_t)(ms * 1000));
#endif
}
NX_INLINE uint64_t nx_rng_next(nx_ctx* c) {
    if (!c->rng_seeded) { c->rng ^= (uint64_t)nx_time_monotonic_ns(); c->rng_seeded = true; }
    /* splitmix64 */
    c->rng += 0x9E3779B97F4A7C15ULL;
    uint64_t z = c->rng;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}
NX_INLINE int64_t nx_random_int(nx_ctx* c, int64_t lo, int64_t hi, const char* loc) {
    if (hi < lo) nx_panic("random.int: upper bound is below the lower bound", loc);
    uint64_t span = (uint64_t)(hi - lo) + 1;
    if (span == 0) return (int64_t)nx_rng_next(c);
    return lo + (int64_t)(nx_rng_next(c) % span);
}
NX_INLINE double nx_random_float(nx_ctx* c) { return (double)(nx_rng_next(c) >> 11) * (1.0 / 9007199254740992.0); }

/* process.run: spawn argv[0] with the given arguments (searching PATH), wait,
 * and return its exit code. False when the process could not be started. */
NX_INLINE bool nx_run(nx_ctx* c, const nx_sl_u8* argv, size_t argc, int* code) {
    if (argc == 0) return false;
    fflush(stdout); fflush(stderr);
#if defined(_WIN32)
    /* build a command line CommandLineToArgvW can take apart again */
    nx_string cmd; cmd.ptr = NULL; cmd.len = 0; cmd.cap = 0; cmd.ar = NULL;
    /* CreateProcess reads the program from the command line and wants backslashes there */
    char prog[4096];
    for (size_t i = 0; i < argc; i++) {
        if (i) nx_str_append(c, &cmd, (const uint8_t*)" ", 1);
        nx_sl_u8 a = argv[i];
        if (i == 0 && a.len < sizeof prog) {
            for (size_t j = 0; j < a.len; j++) prog[j] = a.ptr[j] == '/' ? '\\' : (char)a.ptr[j];
            a.ptr = (uint8_t*)prog;
        }
        bool quote = a.len == 0;
        for (size_t j = 0; j < a.len && !quote; j++) quote = a.ptr[j] == ' ' || a.ptr[j] == '\t' || a.ptr[j] == '"';
        if (quote) nx_str_append(c, &cmd, (const uint8_t*)"\"", 1);
        size_t bs = 0;
        for (size_t j = 0; j < a.len; j++) {
            uint8_t ch = a.ptr[j];
            if (ch == '\\') { bs++; continue; }
            if (ch == '"') { for (size_t k = 0; k < bs * 2 + 1; k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1); bs = 0; nx_str_append(c, &cmd, &ch, 1); continue; }
            for (size_t k = 0; k < bs; k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1);
            bs = 0;
            nx_str_append(c, &cmd, &ch, 1);
        }
        for (size_t k = 0; k < bs * (quote ? 2 : 1); k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1);
        if (quote) nx_str_append(c, &cmd, (const uint8_t*)"\"", 1);
    }
    nx_str_append(c, &cmd, (const uint8_t*)"", 1); /* NUL */
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si); si.cb = sizeof si; memset(&pi, 0, sizeof pi);
    BOOL ok = CreateProcessA(NULL, (char*)cmd.ptr, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi);
    nx_str_free(c, &cmd);
    if (!ok) return false;
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD ec = 1;
    GetExitCodeProcess(pi.hProcess, &ec);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    *code = (int)ec;
    return true;
#else
    char** av = (char**)nx_alloc_bytes(c, (argc + 1) * sizeof(char*), 8);
    for (size_t i = 0; i < argc; i++) {
        av[i] = (char*)nx_alloc_bytes(c, argv[i].len + 1, 1);
        memcpy(av[i], argv[i].ptr, argv[i].len); av[i][argv[i].len] = 0;
    }
    av[argc] = NULL;
    pid_t pid = 0;
    int rc = posix_spawnp(&pid, av[0], NULL, NULL, av, environ);
    for (size_t i = 0; i < argc; i++) nx_free_bytes(c, av[i], argv[i].len + 1);
    nx_free_bytes(c, av, (argc + 1) * sizeof(char*));
    if (rc != 0) return false;
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return false;
    *code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
    return true;
#endif
}
NX_INLINE bool nx_cpath(nx_sl_u8 path, char* buf, size_t cap) {
    if (path.len >= cap) return false;
    memcpy(buf, path.ptr, path.len); buf[path.len] = 0;
    return true;
}
/* Run a program with its stdin fed from `input`, in `cwd` when given, and
   its stdout and stderr captured. The captured text is kept for
   nx_last_stdout / nx_last_stderr to hand over; each thread has its own. */
static NX_THREAD_LOCAL nx_string nx_cap_out, nx_cap_err;
NX_INLINE void nx_cap_reset(nx_ctx* c) {
    nx_str_free(c, &nx_cap_out); nx_str_free(c, &nx_cap_err);
    nx_cap_out.ptr = NULL; nx_cap_out.len = 0; nx_cap_out.cap = 0; nx_cap_out.ar = c->arena;
    nx_cap_err.ptr = NULL; nx_cap_err.len = 0; nx_cap_err.cap = 0; nx_cap_err.ar = c->arena;
}
NX_INLINE nx_string nx_last_stdout(nx_ctx* c) {
    nx_string s = nx_cap_out;
    nx_cap_out.ptr = NULL; nx_cap_out.len = 0; nx_cap_out.cap = 0; nx_cap_out.ar = c->arena;
    return s;
}
NX_INLINE nx_string nx_last_stderr(nx_ctx* c) {
    nx_string s = nx_cap_err;
    nx_cap_err.ptr = NULL; nx_cap_err.len = 0; nx_cap_err.cap = 0; nx_cap_err.ar = c->arena;
    return s;
}
#if defined(_WIN32)
NX_INLINE void nx_win_drain(nx_ctx* c, HANDLE h, nx_string* out) {
    char buf[65536]; DWORD n;
    while (ReadFile(h, buf, sizeof buf, &n, NULL) && n > 0) nx_str_append(c, out, (const uint8_t*)buf, n);
}
/* stderr is drained on a helper thread while this one drains stdout, so a child
   that fills one pipe before finishing the other cannot stall */
typedef struct { nx_ctx* c; HANDLE h; nx_string* out; } nx_win_drain_job;
static DWORD WINAPI nx_win_drain_thread(LPVOID p) {
    nx_win_drain_job* j = (nx_win_drain_job*)p;
    nx_win_drain(j->c, j->h, j->out);
    return 0;
}
#endif
NX_INLINE bool nx_run_capture(nx_ctx* c, const nx_sl_u8* argv, size_t argc, nx_sl_u8 input, nx_sl_u8 cwd, int* code) {
    if (argc == 0) return false;
    fflush(stdout); fflush(stderr);
    nx_cap_reset(c);
    char dir[4096];
    const char* cwdp = NULL;
    if (cwd.len > 0) { if (!nx_cpath(cwd, dir, sizeof dir)) return false; cwdp = dir; }
#if defined(_WIN32)
    nx_string cmd; cmd.ptr = NULL; cmd.len = 0; cmd.cap = 0; cmd.ar = NULL;
    /* CreateProcess reads the program from the command line and wants backslashes there */
    char prog[4096];
    for (size_t i = 0; i < argc; i++) {
        if (i) nx_str_append(c, &cmd, (const uint8_t*)" ", 1);
        nx_sl_u8 a = argv[i];
        if (i == 0 && a.len < sizeof prog) {
            for (size_t j = 0; j < a.len; j++) prog[j] = a.ptr[j] == '/' ? '\\' : (char)a.ptr[j];
            a.ptr = (uint8_t*)prog;
        }
        bool quote = a.len == 0;
        for (size_t j = 0; j < a.len && !quote; j++) quote = a.ptr[j] == ' ' || a.ptr[j] == '\t' || a.ptr[j] == '"';
        if (quote) nx_str_append(c, &cmd, (const uint8_t*)"\"", 1);
        size_t bs = 0;
        for (size_t j = 0; j < a.len; j++) {
            uint8_t ch = a.ptr[j];
            if (ch == '\\') { bs++; continue; }
            if (ch == '"') { for (size_t k = 0; k < bs * 2 + 1; k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1); bs = 0; nx_str_append(c, &cmd, &ch, 1); continue; }
            for (size_t k = 0; k < bs; k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1);
            bs = 0;
            nx_str_append(c, &cmd, &ch, 1);
        }
        for (size_t k = 0; k < bs * (quote ? 2 : 1); k++) nx_str_append(c, &cmd, (const uint8_t*)"\\", 1);
        if (quote) nx_str_append(c, &cmd, (const uint8_t*)"\"", 1);
    }
    nx_str_append(c, &cmd, (const uint8_t*)"", 1);
    SECURITY_ATTRIBUTES sa; sa.nLength = sizeof sa; sa.bInheritHandle = TRUE; sa.lpSecurityDescriptor = NULL;
    HANDLE in_r = NULL, in_w = NULL, out_r = NULL, out_w = NULL, err_r = NULL, err_w = NULL;
    if (!CreatePipe(&in_r, &in_w, &sa, 1 << 20) || !CreatePipe(&out_r, &out_w, &sa, 1 << 20) || !CreatePipe(&err_r, &err_w, &sa, 1 << 20)) { nx_str_free(c, &cmd); return false; }
    SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si); si.cb = sizeof si; memset(&pi, 0, sizeof pi);
    si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = in_r; si.hStdOutput = out_w; si.hStdError = err_w;
    BOOL ok = CreateProcessA(NULL, (char*)cmd.ptr, NULL, NULL, TRUE, 0, NULL, cwdp, &si, &pi);
    nx_str_free(c, &cmd);
    CloseHandle(in_r); CloseHandle(out_w); CloseHandle(err_w);
    if (!ok) { CloseHandle(in_w); CloseHandle(out_r); CloseHandle(err_r); return false; }
    if (input.len > 0) { DWORD w; WriteFile(in_w, input.ptr, (DWORD)input.len, &w, NULL); }
    CloseHandle(in_w);
    nx_string err_buf; err_buf.ptr = NULL; err_buf.len = 0; err_buf.cap = 0; err_buf.ar = c->arena;
    nx_win_drain_job job; job.c = c; job.h = err_r; job.out = &err_buf;
    HANDLE drain = CreateThread(NULL, 0, nx_win_drain_thread, &job, 0, NULL);
    nx_win_drain(c, out_r, &nx_cap_out);
    if (drain) { WaitForSingleObject(drain, INFINITE); CloseHandle(drain); } else nx_win_drain(c, err_r, &err_buf);
    nx_cap_err = err_buf;
    CloseHandle(out_r); CloseHandle(err_r);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD ec = 1;
    GetExitCodeProcess(pi.hProcess, &ec);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    *code = (int)ec;
    return true;
#else
    char** av = (char**)nx_alloc_bytes(c, (argc + 1) * sizeof(char*), 8);
    for (size_t i = 0; i < argc; i++) {
        av[i] = (char*)nx_alloc_bytes(c, argv[i].len + 1, 1);
        memcpy(av[i], argv[i].ptr, argv[i].len); av[i][argv[i].len] = 0;
    }
    av[argc] = NULL;
    int inp[2], outp[2], errp[2];
    if (pipe(inp) != 0 || pipe(outp) != 0 || pipe(errp) != 0) return false;
    pid_t pid = fork();
    if (pid < 0) return false;
    if (pid == 0) {
        dup2(inp[0], 0); dup2(outp[1], 1); dup2(errp[1], 2);
        close(inp[0]); close(inp[1]); close(outp[0]); close(outp[1]); close(errp[0]); close(errp[1]);
        if (cwdp && chdir(cwdp) != 0) _exit(126);
        execvp(av[0], av);
        _exit(127);
    }
    close(inp[0]); close(outp[1]); close(errp[1]);
    for (size_t i = 0; i < argc; i++) nx_free_bytes(c, av[i], argv[i].len + 1);
    nx_free_bytes(c, av, (argc + 1) * sizeof(char*));
    if (input.len > 0) { size_t off = 0; while (off < input.len) { ssize_t w = write(inp[1], input.ptr + off, input.len - off); if (w <= 0) break; off += (size_t)w; } }
    close(inp[1]);
    /* both pipes are drained as the child fills them, so a child that fills one
       before finishing the other cannot stall */
    char buf[65536]; ssize_t n;
    struct pollfd pfd[2];
    pfd[0].fd = outp[0]; pfd[0].events = POLLIN;
    pfd[1].fd = errp[0]; pfd[1].events = POLLIN;
    int open_fds = 2;
    while (open_fds > 0) {
        if (poll(pfd, 2, -1) < 0) { if (errno == EINTR) continue; break; }
        for (int i = 0; i < 2; i++) {
            if (pfd[i].fd < 0 || !(pfd[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            n = read(pfd[i].fd, buf, sizeof buf);
            if (n > 0) nx_str_append(c, i == 0 ? &nx_cap_out : &nx_cap_err, (const uint8_t*)buf, (size_t)n);
            else if (n == 0 || errno != EINTR) { pfd[i].fd = -1; open_fds--; }
        }
    }
    close(outp[0]); close(errp[0]);
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return false;
    *code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
    return true;
#endif
}
NX_INLINE bool nx_read_file(nx_ctx* c, nx_sl_u8 path, nx_string* out) {
    char p[4096];
    if (path.len >= sizeof p) return false;
    memcpy(p, path.ptr, path.len); p[path.len] = 0;
    FILE* f = fopen(p, "rb");
    if (!f) return false;
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    uint8_t buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) nx_str_append(c, &s, buf, n);
    fclose(f);
    *out = s;
    return true;
}
NX_INLINE bool nx_write_file(nx_sl_u8 path, nx_sl_u8 data) {
    char p[4096];
    if (path.len >= sizeof p) return false;
    memcpy(p, path.ptr, path.len); p[path.len] = 0;
    FILE* f = fopen(p, "wb");
    if (!f) return false;
    size_t w = data.len ? fwrite(data.ptr, 1, data.len, f) : 0;
    fclose(f);
    return w == data.len;
}
NX_INLINE bool nx_append_file(nx_sl_u8 path, nx_sl_u8 data) {
    char p[4096];
    if (path.len >= sizeof p) return false;
    memcpy(p, path.ptr, path.len); p[path.len] = 0;
    FILE* f = fopen(p, "ab");
    if (!f) return false;
    size_t w = data.len ? fwrite(data.ptr, 1, data.len, f) : 0;
    fclose(f);
    return w == data.len;
}

/* ------------------------------------------------------------- file system */
/* Results: 0 ok, 1 not found, 2 any other failure. */
NX_INLINE int32_t nx_fs_errcode(void) { return errno == ENOENT ? 1 : 2; }
/* 0 = nothing there, 1 = file (or anything not a directory), 2 = directory */
NX_INLINE int32_t nx_fs_kind(nx_sl_u8 path) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 0;
#if defined(_WIN32)
    DWORD a = GetFileAttributesA(p);
    if (a == INVALID_FILE_ATTRIBUTES) return 0;
    return (a & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
#else
    struct stat st;
    if (stat(p, &st) != 0) return 0;
    return S_ISDIR(st.st_mode) ? 2 : 1;
#endif
}
NX_INLINE int32_t nx_fs_stat(nx_sl_u8 path, int64_t* size, int64_t* mtime_ms) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 2;
#if defined(_WIN32)
    struct _stat64 st;
    if (_stat64(p, &st) != 0) return nx_fs_errcode();
#else
    struct stat st;
    if (stat(p, &st) != 0) return nx_fs_errcode();
#endif
    *size = (int64_t)st.st_size;
    *mtime_ms = (int64_t)st.st_mtime * 1000;
    return 0;
}
NX_INLINE int32_t nx_fs_mkdir(nx_sl_u8 path) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 2;
#if defined(_WIN32)
    if (_mkdir(p) == 0 || errno == EEXIST) return 0;
#else
    if (mkdir(p, 0777) == 0 || errno == EEXIST) return 0;
#endif
    return nx_fs_errcode();
}
NX_INLINE int32_t nx_fs_remove_file(nx_sl_u8 path) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 2;
    return remove(p) == 0 ? 0 : nx_fs_errcode();
}
NX_INLINE int32_t nx_fs_remove_dir(nx_sl_u8 path) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 2;
#if defined(_WIN32)
    return _rmdir(p) == 0 ? 0 : nx_fs_errcode();
#else
    return rmdir(p) == 0 ? 0 : nx_fs_errcode();
#endif
}
NX_INLINE int32_t nx_fs_rename(nx_sl_u8 from, nx_sl_u8 to) {
    char p[4096], q[4096];
    if (!nx_cpath(from, p, sizeof p) || !nx_cpath(to, q, sizeof q)) return 2;
#if defined(_WIN32)
    if (MoveFileExA(p, q, MOVEFILE_REPLACE_EXISTING)) return 0;
    return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND ? 1 : 2;
#else
    return rename(p, q) == 0 ? 0 : nx_fs_errcode();
#endif
}
NX_INLINE void nx_fs_push_name(nx_ctx* c, nx_rawlist* l, const char* name) {
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return;
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    nx_str_append(c, &s, (const uint8_t*)name, strlen(name));
    if (l->len == l->cap) nx_list_grow(c, l, sizeof(nx_string), _Alignof(nx_string), l->len + 1);
    ((nx_string*)l->ptr)[l->len++] = s;
}
/* the entries of a directory, unsorted, without `.` and `..` */
NX_INLINE int32_t nx_fs_list_dir(nx_ctx* c, nx_sl_u8 path, nx_rawlist* out) {
    char p[4096];
    if (!nx_cpath(path, p, sizeof p)) return 2;
    nx_rawlist l; l.ptr = NULL; l.len = 0; l.cap = 0; l.ar = c->arena;
#if defined(_WIN32)
    char pat[4200];
    snprintf(pat, sizeof pat, "%s\\*", p);
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        DWORD e = GetLastError();
        return e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND ? 1 : 2;
    }
    do { nx_fs_push_name(c, &l, fd.cFileName); } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR* d = opendir(p);
    if (!d) return nx_fs_errcode();
    struct dirent* e;
    while ((e = readdir(d)) != NULL) nx_fs_push_name(c, &l, e->d_name);
    closedir(d);
#endif
    *out = l;
    return 0;
}
NX_INLINE bool nx_fs_cwd(nx_ctx* c, nx_string* out) {
    char buf[4096];
    size_t n;
#if defined(_WIN32)
    DWORD r = GetCurrentDirectoryA(sizeof buf, buf);
    if (r == 0 || r >= sizeof buf) return false;
    n = (size_t)r;
#else
    if (!getcwd(buf, sizeof buf)) return false;
    n = strlen(buf);
#endif
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    nx_str_append(c, &s, (const uint8_t*)buf, n);
    *out = s;
    return true;
}
/* the path of the running executable; empty when the platform will not say */
NX_INLINE nx_string nx_exe_path(nx_ctx* c) {
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    char buf[4096];
    size_t n = 0;
#if defined(_WIN32)
    DWORD r = GetModuleFileNameA(NULL, buf, (DWORD)sizeof buf);
    if (r == 0 || r >= sizeof buf) return s;
    n = (size_t)r;
#elif defined(__APPLE__)
    uint32_t size = (uint32_t)sizeof buf;
    if (_NSGetExecutablePath(buf, &size) != 0) return s;
    n = strlen(buf);
#else
    ssize_t r = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (r <= 0) return s;
    n = (size_t)r;
#endif
    nx_str_append(c, &s, (const uint8_t*)buf, n);
    return s;
}
NX_INLINE nx_string nx_fs_temp_dir(nx_ctx* c) {
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
#if defined(_WIN32)
    char buf[MAX_PATH + 2];
    DWORD n = GetTempPathA(sizeof buf, buf);
    if (n > 0 && n < sizeof buf) {
        if (buf[n - 1] == '\\' || buf[n - 1] == '/') n--;
        nx_str_append(c, &s, (const uint8_t*)buf, n);
    }
#else
    const char* t = getenv("TMPDIR");
    if (!t || !*t) t = "/tmp";
    size_t n = strlen(t);
    if (n > 1 && t[n - 1] == '/') n--;
    nx_str_append(c, &s, (const uint8_t*)t, n);
#endif
    return s;
}

/* ------------------------------------------------------------ file handles */
/* 1 = stdin, 2 = stdout, 3 = stderr; opened files get 4 and up. */
#define NX_MAX_FILES 64
static FILE* nx_files[NX_MAX_FILES];
NX_INLINE FILE* nx_fh(int64_t h) {
    if (h == 1) return stdin;
    if (h == 2) return stdout;
    if (h == 3) return stderr;
    if (h < 4 || h >= NX_MAX_FILES + 4) return NULL;
    return nx_files[h - 4];
}
/* a handle, or -1 when the path does not exist, -2 on any other failure */
NX_INLINE int64_t nx_file_open(nx_sl_u8 path, nx_sl_u8 mode) {
    char p[4096], m[8];
    if (!nx_cpath(path, p, sizeof p) || mode.len == 0 || mode.len > 3) return -2;
    memcpy(m, mode.ptr, mode.len); m[mode.len] = 'b'; m[mode.len + 1] = 0;
    FILE* f = fopen(p, m);
    if (!f) return errno == ENOENT ? -1 : -2;
    for (int i = 0; i < NX_MAX_FILES; i++) {
        if (!nx_files[i]) { nx_files[i] = f; return i + 4; }
    }
    fclose(f);
    return -2;
}
/* stdin is read at the descriptor level, so a pipe or a terminal hands over what it
   has instead of waiting for a full buffer the way fread does; every stdin reader in
   the runtime consumes from this one buffer */
static uint8_t nx_stdin_buf[65536];
static size_t nx_stdin_pos, nx_stdin_len;
NX_INLINE bool nx_stdin_fill(void) {
    if (nx_stdin_pos < nx_stdin_len) return true;
#if defined(_WIN32)
    int n = _read(0, nx_stdin_buf, (unsigned)sizeof nx_stdin_buf);
#else
    ssize_t n;
    do { n = read(0, nx_stdin_buf, sizeof nx_stdin_buf); } while (n < 0 && errno == EINTR);
#endif
    if (n <= 0) return false;
    nx_stdin_pos = 0; nx_stdin_len = (size_t)n;
    return true;
}
/* up to n bytes; an empty result means end of input */
NX_INLINE bool nx_file_read(nx_ctx* c, int64_t h, size_t n, nx_string* out) {
    FILE* f = nx_fh(h);
    if (!f) return false;
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    if (n > 0 && h == 1) {
        if (nx_stdin_fill()) {
            size_t have = nx_stdin_len - nx_stdin_pos;
            if (have > n) have = n;
            nx_list_grow(c, (nx_rawlist*)&s, 1, 1, have);
            memcpy(s.ptr, nx_stdin_buf + nx_stdin_pos, have);
            s.len = have;
            nx_stdin_pos += have;
        }
    } else if (n > 0) {
        nx_list_grow(c, (nx_rawlist*)&s, 1, 1, n);
        s.len = fread(s.ptr, 1, n, f);
        if (s.len == 0 && ferror(f)) return false;
    }
    *out = s;
    return true;
}
NX_INLINE bool nx_file_write(int64_t h, nx_sl_u8 data) {
    FILE* f = nx_fh(h);
    if (!f) return false;
    return data.len == 0 || fwrite(data.ptr, 1, data.len, f) == data.len;
}
NX_INLINE bool nx_file_flush(int64_t h) {
    FILE* f = nx_fh(h);
    return f && fflush(f) == 0;
}
NX_INLINE bool nx_file_close(int64_t h) {
    if (h >= 1 && h <= 3) return true;
    FILE* f = nx_fh(h);
    if (!f) return false;
    nx_files[h - 4] = NULL;
    return fclose(f) == 0;
}
/* set a variable in this process's environment (and its children's); an
   empty value removes it */
NX_INLINE void nx_set_env(nx_sl_u8 name, nx_sl_u8 value) {
    char n[256], v[4096];
    if (name.len == 0 || name.len >= sizeof n || value.len >= sizeof v) return;
    memcpy(n, name.ptr, name.len); n[name.len] = 0;
    memcpy(v, value.ptr, value.len); v[value.len] = 0;
#if defined(_WIN32)
    _putenv_s(n, v);
#else
    if (value.len == 0) unsetenv(n); else setenv(n, v, 1);
#endif
}
/* is the handle (1 stdin, 2 stdout, 3 stderr) a terminal? */
NX_INLINE bool nx_is_terminal(int64_t h) {
    int fd = h == 1 ? 0 : h == 2 ? 1 : h == 3 ? 2 : -1;
    if (fd < 0) return false;
#if defined(_WIN32)
    return _isatty(fd) != 0;
#else
    return isatty(fd) != 0;
#endif
}
/* every environment variable as "NAME=value" */
NX_INLINE void nx_environ(nx_ctx* c, nx_rawlist* out) {
    nx_rawlist l; l.ptr = NULL; l.len = 0; l.cap = 0; l.ar = c->arena;
#if defined(_WIN32)
    char* env = GetEnvironmentStringsA();
    if (env) {
        for (char* p = env; *p; p += strlen(p) + 1) {
            if (*p == '=') continue; /* per-drive working directories */
            nx_fs_push_name(c, &l, p);
        }
        FreeEnvironmentStringsA(env);
    }
#else
    for (char** e = environ; e && *e; e++) nx_fs_push_name(c, &l, *e);
#endif
    *out = l;
}

/* ------------------------------------------------------------------ sockets */
/* Handles are the OS socket numbers. Result codes: 0 ok, 1 not found (name
   lookup), 2 connection refused, 3 timed out, 4 any other failure. */
#if defined(_WIN32)
typedef SOCKET nx_sock;
#define NX_BAD_SOCK INVALID_SOCKET
#define nx_closesock closesocket
NX_INLINE void nx_net_init(void) {
    static int done = 0;
    if (!done) { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); done = 1; }
}
NX_INLINE int32_t nx_net_code(void) {
    int e = WSAGetLastError();
    if (e == WSAECONNREFUSED) return 2;
    if (e == WSAETIMEDOUT || e == WSAEWOULDBLOCK) return 3;
    return 4;
}
NX_INLINE void nx_net_blocking(nx_sock s, bool on) { u_long mode = on ? 0 : 1; ioctlsocket(s, FIONBIO, &mode); }
#else
typedef int nx_sock;
#define NX_BAD_SOCK (-1)
#define nx_closesock close
NX_INLINE void nx_net_init(void) {}
NX_INLINE int32_t nx_net_code(void) {
    if (errno == ECONNREFUSED) return 2;
    if (errno == ETIMEDOUT || errno == EAGAIN || errno == EWOULDBLOCK) return 3;
    return 4;
}
NX_INLINE void nx_net_blocking(nx_sock s, bool on) {
    int fl = fcntl(s, F_GETFL, 0);
    if (fl >= 0) fcntl(s, F_SETFL, on ? (fl & ~O_NONBLOCK) : (fl | O_NONBLOCK));
}
#endif
static char nx_net_peer_buf[128];

NX_INLINE struct addrinfo* nx_net_lookup(nx_sl_u8 host, uint16_t port, int socktype, bool passive) {
    char h[256], p[8];
    if (host.len >= sizeof h) return NULL;
    memcpy(h, host.ptr, host.len); h[host.len] = 0;
    snprintf(p, sizeof p, "%u", (unsigned)port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = socktype;
    if (passive) hints.ai_flags = AI_PASSIVE;
    struct addrinfo* res = NULL;
    nx_net_init();
    if (getaddrinfo(host.len ? h : NULL, p, &hints, &res) != 0) return NULL;
    return res;
}
NX_INLINE void nx_net_set_timeout(nx_sock s, int64_t ms) {
#if defined(_WIN32)
    DWORD t = (DWORD)(ms < 0 ? 0 : ms);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&t, sizeof t);
#else
    struct timeval tv;
    tv.tv_sec = (time_t)(ms < 0 ? 0 : ms / 1000);
    tv.tv_usec = (suseconds_t)(ms < 0 ? 0 : (ms % 1000) * 1000);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);
#endif
}
/* wait until the socket is readable (or writable); false on timeout. For a
   pending connect the exception set is watched too: Winsock reports a
   refused connection there rather than as writable. */
NX_INLINE bool nx_net_wait(nx_sock s, bool write, int64_t ms) {
    fd_set fds, exc;
    FD_ZERO(&fds);
    FD_SET(s, &fds);
    FD_ZERO(&exc);
    FD_SET(s, &exc);
    struct timeval tv;
    tv.tv_sec = (long)(ms / 1000);
    tv.tv_usec = (long)((ms % 1000) * 1000);
    int r = select((int)(s + 1), write ? NULL : &fds, write ? &fds : NULL, write ? &exc : NULL, ms > 0 ? &tv : NULL);
    return r > 0;
}
NX_INLINE int32_t nx_tcp_connect(nx_sl_u8 host, uint16_t port, int64_t timeout_ms, int64_t* out) {
    struct addrinfo* res = nx_net_lookup(host, port, SOCK_STREAM, false);
    if (!res) return 1;
    int32_t code = 4;
    for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
        nx_sock s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == NX_BAD_SOCK) continue;
        bool ok;
        if (timeout_ms > 0) {
            nx_net_blocking(s, false);
            int r = connect(s, ai->ai_addr, (int)ai->ai_addrlen);
            ok = r == 0;
            if (!ok) {
                if (nx_net_wait(s, true, timeout_ms)) {
                    int err = 0; socklen_t len = sizeof err;
                    getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&err, &len);
#if defined(_WIN32)
                    if (err == 0) { fd_set ex; FD_ZERO(&ex); FD_SET(s, &ex); struct timeval z = {0, 0}; if (select((int)(s + 1), NULL, NULL, &ex, &z) > 0) err = WSAECONNREFUSED; }
#endif
                    ok = err == 0;
                    if (!ok) {
#if defined(_WIN32)
                        WSASetLastError(err);
#else
                        errno = err;
#endif
                        code = nx_net_code();
                    }
                } else {
                    code = 3;
                }
            }
            nx_net_blocking(s, true);
        } else {
            ok = connect(s, ai->ai_addr, (int)ai->ai_addrlen) == 0;
            if (!ok) code = nx_net_code();
        }
        if (ok) {
            int one = 1;
            setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof one);
            *out = (int64_t)s;
            freeaddrinfo(res);
            return 0;
        }
        nx_closesock(s);
    }
    freeaddrinfo(res);
    return code;
}
NX_INLINE int32_t nx_tcp_listen(nx_sl_u8 host, uint16_t port, int64_t* out) {
    struct addrinfo* res = nx_net_lookup(host, port, SOCK_STREAM, true);
    if (!res) return 1;
    int32_t code = 4;
    for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
        nx_sock s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == NX_BAD_SOCK) continue;
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof one);
        if (bind(s, ai->ai_addr, (int)ai->ai_addrlen) == 0 && listen(s, 64) == 0) {
            *out = (int64_t)s;
            freeaddrinfo(res);
            return 0;
        }
        code = nx_net_code();
        nx_closesock(s);
    }
    freeaddrinfo(res);
    return code;
}
NX_INLINE int32_t nx_tcp_accept(int64_t l, int64_t timeout_ms, int64_t* out) {
    nx_sock ls = (nx_sock)l;
    if (timeout_ms > 0 && !nx_net_wait(ls, false, timeout_ms)) return 3;
    nx_sock s = accept(ls, NULL, NULL);
    if (s == NX_BAD_SOCK) return nx_net_code();
    int one = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof one);
    *out = (int64_t)s;
    return 0;
}
NX_INLINE int32_t nx_net_send(int64_t h, nx_sl_u8 data) {
    nx_sock s = (nx_sock)h;
    size_t sent = 0;
    while (sent < data.len) {
        int n = (int)send(s, (const char*)data.ptr + sent, (int)(data.len - sent), 0);
        if (n <= 0) return nx_net_code();
        sent += (size_t)n;
    }
    return 0;
}
NX_INLINE int32_t nx_net_recv(nx_ctx* c, int64_t h, size_t n, int64_t timeout_ms, nx_string* out) {
    nx_sock s = (nx_sock)h;
    if (timeout_ms > 0 && !nx_net_wait(s, false, timeout_ms)) return 3;
    nx_string str; str.ptr = NULL; str.len = 0; str.cap = 0; str.ar = c->arena;
    if (n == 0) { *out = str; return 0; }
    nx_list_grow(c, (nx_rawlist*)&str, 1, 1, n);
    int got = (int)recv(s, (char*)str.ptr, (int)n, 0);
    if (got < 0) return nx_net_code();
    str.len = (size_t)got;
    *out = str;
    return 0;
}
NX_INLINE int32_t nx_net_close(int64_t h) {
    return nx_closesock((nx_sock)h) == 0 ? 0 : 4;
}
NX_INLINE void nx_net_format_addr(struct sockaddr* sa, socklen_t len, char* buf, size_t cap) {
    char host[96], serv[16];
    if (getnameinfo(sa, len, host, sizeof host, serv, sizeof serv, NI_NUMERICHOST | NI_NUMERICSERV) != 0) { buf[0] = 0; return; }
    if (sa->sa_family == AF_INET6) snprintf(buf, cap, "[%s]:%s", host, serv);
    else snprintf(buf, cap, "%s:%s", host, serv);
}
NX_INLINE int32_t nx_net_name(nx_ctx* c, int64_t h, bool local, nx_string* out) {
    struct sockaddr_storage ss;
    socklen_t len = sizeof ss;
    int r = local ? getsockname((nx_sock)h, (struct sockaddr*)&ss, &len) : getpeername((nx_sock)h, (struct sockaddr*)&ss, &len);
    if (r != 0) return 4;
    char buf[128];
    nx_net_format_addr((struct sockaddr*)&ss, len, buf, sizeof buf);
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    nx_str_append(c, &s, (const uint8_t*)buf, strlen(buf));
    *out = s;
    return 0;
}
NX_INLINE int32_t nx_net_resolve(nx_ctx* c, nx_sl_u8 host, nx_rawlist* out) {
    struct addrinfo* res = nx_net_lookup(host, 0, SOCK_STREAM, false);
    if (!res) return 1;
    nx_rawlist l; l.ptr = NULL; l.len = 0; l.cap = 0; l.ar = c->arena;
    for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
        char hostbuf[96];
        if (getnameinfo(ai->ai_addr, (socklen_t)ai->ai_addrlen, hostbuf, sizeof hostbuf, NULL, 0, NI_NUMERICHOST) == 0) {
            bool dup = false;
            for (size_t i = 0; i < l.len; i++) {
                nx_string* e = &((nx_string*)l.ptr)[i];
                if (e->len == strlen(hostbuf) && memcmp(e->ptr, hostbuf, e->len) == 0) dup = true;
            }
            if (!dup) nx_fs_push_name(c, &l, hostbuf);
        }
    }
    freeaddrinfo(res);
    *out = l;
    return 0;
}
NX_INLINE int32_t nx_udp_bind(nx_sl_u8 host, uint16_t port, int64_t* out) {
    struct addrinfo* res = nx_net_lookup(host, port, SOCK_DGRAM, true);
    if (!res) return 1;
    int32_t code = 4;
    for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
        nx_sock s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == NX_BAD_SOCK) continue;
        if (bind(s, ai->ai_addr, (int)ai->ai_addrlen) == 0) {
            *out = (int64_t)s;
            freeaddrinfo(res);
            return 0;
        }
        code = nx_net_code();
        nx_closesock(s);
    }
    freeaddrinfo(res);
    return code;
}
NX_INLINE int32_t nx_udp_send_to(int64_t h, nx_sl_u8 host, uint16_t port, nx_sl_u8 data) {
    struct addrinfo* res = nx_net_lookup(host, port, SOCK_DGRAM, false);
    if (!res) return 1;
    int n = (int)sendto((nx_sock)h, (const char*)data.ptr, (int)data.len, 0, res->ai_addr, (int)res->ai_addrlen);
    freeaddrinfo(res);
    return n < 0 ? nx_net_code() : 0;
}
NX_INLINE int32_t nx_udp_recv_from(nx_ctx* c, int64_t h, size_t n, int64_t timeout_ms, nx_string* out) {
    nx_sock s = (nx_sock)h;
    if (timeout_ms > 0 && !nx_net_wait(s, false, timeout_ms)) return 3;
    nx_string str; str.ptr = NULL; str.len = 0; str.cap = 0; str.ar = c->arena;
    if (n == 0) n = 1;
    nx_list_grow(c, (nx_rawlist*)&str, 1, 1, n);
    struct sockaddr_storage ss;
    socklen_t len = sizeof ss;
    int got = (int)recvfrom(s, (char*)str.ptr, (int)n, 0, (struct sockaddr*)&ss, &len);
    if (got < 0) return nx_net_code();
    str.len = (size_t)got;
    nx_net_format_addr((struct sockaddr*)&ss, len, nx_net_peer_buf, sizeof nx_net_peer_buf);
    *out = str;
    return 0;
}
NX_INLINE nx_string nx_net_last_peer(nx_ctx* c) {
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    nx_str_append(c, &s, (const uint8_t*)nx_net_peer_buf, strlen(nx_net_peer_buf));
    return s;
}

/* ------------------------------------------------------------- threads */
/* A spawned thread runs a Nexium function value `fn(*mut X)` with its own
   context; a panic inside it is re-raised by the joiner. Handles are
   pointers to the task record, freed by join. */
typedef struct nx_thread_task {
    nx_ctx ctx;
    void* fnp;
    void* env;
    void* arg;
    bool panicked;
    bool started;
    char msg[256];
    char loc[256];
#if defined(_WIN32)
    HANDLE h;
#else
    pthread_t h;
#endif
} nx_thread_task;
static void nx_thread_run(nx_thread_task* t) {
    nx_boundary b;
    nx_boundary* prev = nx_tls_boundary;
    nx_tls_boundary = &b;
    if (setjmp(b.jb)) {
        t->panicked = true;
        snprintf(t->msg, sizeof t->msg, "%s", b.msg);
        snprintf(t->loc, sizeof t->loc, "%s", b.loc);
    } else {
        ((void (*)(nx_ctx*, void*, void*))t->fnp)(&t->ctx, t->env, t->arg);
    }
    nx_tls_boundary = prev;
}
#if defined(_WIN32)
static DWORD WINAPI nx_thread_entry(LPVOID p) { nx_thread_run((nx_thread_task*)p); return 0; }
#else
static void* nx_thread_entry(void* p) { nx_thread_run((nx_thread_task*)p); return NULL; }
#endif
NX_INLINE int64_t nx_thread_start(nx_ctx* c, void* fnp, void* env, void* arg) {
    nx_thread_task* t = (nx_thread_task*)malloc(sizeof *t);
    if (!t) nx_panic("out of memory starting a thread", "thread.start");
    t->ctx = *c;
    t->ctx.live_allocs = 0; t->ctx.live_bytes = 0; t->ctx.total_allocs = 0; t->ctx.peak_bytes = 0;
    nx_ctx_track_self(&t->ctx);
    t->ctx.rng ^= (uint64_t)(uintptr_t)t * 0x9E3779B97F4A7C15ULL;
    t->fnp = fnp; t->env = env; t->arg = arg;
    t->panicked = false; t->started = true;
#if defined(_WIN32)
    t->h = CreateThread(NULL, 0, nx_thread_entry, t, 0, NULL);
    if (!t->h) { t->started = false; nx_thread_run(t); }
#else
    if (pthread_create(&t->h, NULL, nx_thread_entry, t) != 0) { t->started = false; nx_thread_run(t); }
#endif
    return (int64_t)(intptr_t)t;
}
NX_INLINE void nx_thread_join(int64_t h, const char* loc) {
    nx_thread_task* t = (nx_thread_task*)(intptr_t)h;
    if (!t) return;
    if (t->started) {
#if defined(_WIN32)
        WaitForSingleObject(t->h, INFINITE);
        CloseHandle(t->h);
#else
        pthread_join(t->h, NULL);
#endif
    }
    bool panicked = t->panicked;
    char msg[512];
    snprintf(msg, sizeof msg, "in a thread: %s (at %s)", t->msg, t->loc);
    free(t);
    if (panicked) nx_panic(msg, loc);
}
/* mutexes and condition variables, as heap handles */
#if defined(_WIN32)
NX_INLINE int64_t nx_mutex_new(void) { CRITICAL_SECTION* m = (CRITICAL_SECTION*)malloc(sizeof *m); InitializeCriticalSection(m); return (int64_t)(intptr_t)m; }
NX_INLINE void nx_mutex_lock(int64_t m) { EnterCriticalSection((CRITICAL_SECTION*)(intptr_t)m); }
NX_INLINE void nx_mutex_unlock(int64_t m) { LeaveCriticalSection((CRITICAL_SECTION*)(intptr_t)m); }
NX_INLINE void nx_mutex_free(int64_t m) { DeleteCriticalSection((CRITICAL_SECTION*)(intptr_t)m); free((void*)(intptr_t)m); }
NX_INLINE int64_t nx_cond_new(void) { CONDITION_VARIABLE* cv = (CONDITION_VARIABLE*)malloc(sizeof *cv); InitializeConditionVariable(cv); return (int64_t)(intptr_t)cv; }
NX_INLINE void nx_cond_wait(int64_t cv, int64_t m) { SleepConditionVariableCS((CONDITION_VARIABLE*)(intptr_t)cv, (CRITICAL_SECTION*)(intptr_t)m, INFINITE); }
NX_INLINE void nx_cond_signal(int64_t cv) { WakeConditionVariable((CONDITION_VARIABLE*)(intptr_t)cv); }
NX_INLINE void nx_cond_broadcast(int64_t cv) { WakeAllConditionVariable((CONDITION_VARIABLE*)(intptr_t)cv); }
NX_INLINE void nx_cond_free(int64_t cv) { free((void*)(intptr_t)cv); }
#else
NX_INLINE int64_t nx_mutex_new(void) { pthread_mutex_t* m = (pthread_mutex_t*)malloc(sizeof *m); pthread_mutex_init(m, NULL); return (int64_t)(intptr_t)m; }
NX_INLINE void nx_mutex_lock(int64_t m) { pthread_mutex_lock((pthread_mutex_t*)(intptr_t)m); }
NX_INLINE void nx_mutex_unlock(int64_t m) { pthread_mutex_unlock((pthread_mutex_t*)(intptr_t)m); }
NX_INLINE void nx_mutex_free(int64_t m) { pthread_mutex_destroy((pthread_mutex_t*)(intptr_t)m); free((void*)(intptr_t)m); }
NX_INLINE int64_t nx_cond_new(void) { pthread_cond_t* cv = (pthread_cond_t*)malloc(sizeof *cv); pthread_cond_init(cv, NULL); return (int64_t)(intptr_t)cv; }
NX_INLINE void nx_cond_wait(int64_t cv, int64_t m) { pthread_cond_wait((pthread_cond_t*)(intptr_t)cv, (pthread_mutex_t*)(intptr_t)m); }
NX_INLINE void nx_cond_signal(int64_t cv) { pthread_cond_signal((pthread_cond_t*)(intptr_t)cv); }
NX_INLINE void nx_cond_broadcast(int64_t cv) { pthread_cond_broadcast((pthread_cond_t*)(intptr_t)cv); }
NX_INLINE void nx_cond_free(int64_t cv) { pthread_cond_destroy((pthread_cond_t*)(intptr_t)cv); free((void*)(intptr_t)cv); }
#endif

NX_INLINE bool nx_read_line(nx_ctx* c, nx_string* out) {
    nx_string s; s.ptr = NULL; s.len = 0; s.cap = 0; s.ar = c->arena;
    bool any = false;
    while (nx_stdin_fill()) {
        uint8_t b = nx_stdin_buf[nx_stdin_pos++];
#if defined(_WIN32)
        /* a console in binary mode passes Ctrl-Z through; keep it as end of input */
        if (b == 0x1A && !any) return false;
#endif
        any = true;
        if (b == '\n') break;
        nx_str_append(c, &s, &b, 1);
    }
    if (!any) return false;
    if (s.len && s.ptr[s.len - 1] == '\r') s.len--;
    *out = s;
    return true;
}

/* ----------------------------------------------------- checked arithmetic */
#define NX_INT_OPS(N, T, UT, MIN, MAX) \
    NX_INLINE T nx_add_##N(T a, T b, const char* loc) { T r; if (__builtin_add_overflow(a, b, &r)) nx_panic("integer overflow in `+`", loc); return r; } \
    NX_INLINE T nx_sub_##N(T a, T b, const char* loc) { T r; if (__builtin_sub_overflow(a, b, &r)) nx_panic("integer overflow in `-`", loc); return r; } \
    NX_INLINE T nx_mul_##N(T a, T b, const char* loc) { T r; if (__builtin_mul_overflow(a, b, &r)) nx_panic("integer overflow in `*`", loc); return r; } \
    NX_INLINE T nx_div_##N(T a, T b, const char* loc) { if (b == 0) nx_panic("division by zero", loc); if ((T)(MIN) < 0 && a == (T)(MIN) && b == (T)-1) nx_panic("integer overflow in `/`", loc); return a / b; } \
    NX_INLINE T nx_rem_##N(T a, T b, const char* loc) { if (b == 0) nx_panic("remainder by zero", loc); if ((T)(MIN) < 0 && a == (T)(MIN) && b == (T)-1) return 0; return a % b; } \
    NX_INLINE T nx_neg_##N(T a, const char* loc) { if ((T)(MIN) < 0 && a == (T)(MIN)) nx_panic("integer overflow in negation", loc); return (T)(-a); } \
    NX_INLINE T nx_addw_##N(T a, T b) { return (T)((UT)a + (UT)b); } \
    NX_INLINE T nx_subw_##N(T a, T b) { return (T)((UT)a - (UT)b); } \
    NX_INLINE T nx_mulw_##N(T a, T b) { return (T)((UT)a * (UT)b); } \
    NX_INLINE T nx_adds_##N(T a, T b) { T r; if (__builtin_add_overflow(a, b, &r)) return (b > 0) ? (T)(MAX) : (T)(MIN); return r; } \
    NX_INLINE T nx_subs_##N(T a, T b) { T r; if (__builtin_sub_overflow(a, b, &r)) return (b > 0) ? (T)(MIN) : (T)(MAX); return r; } \
    NX_INLINE T nx_muls_##N(T a, T b) { T r; if (__builtin_mul_overflow(a, b, &r)) return ((a < 0) != (b < 0)) ? (T)(MIN) : (T)(MAX); return r; } \
    NX_INLINE T nx_shl_##N(T a, uint32_t b, const char* loc) { if (b >= sizeof(T) * 8) nx_panic("shift amount exceeds the bit width", loc); return (T)((UT)a << b); } \
    NX_INLINE T nx_shr_##N(T a, uint32_t b, const char* loc) { if (b >= sizeof(T) * 8) nx_panic("shift amount exceeds the bit width", loc); return (T)(a >> b); } \
    NX_INLINE T nx_abs_##N(T a, const char* loc) { if ((T)(MIN) < 0 && a == (T)(MIN)) nx_panic("integer overflow in abs", loc); return a < 0 ? (T)(-a) : a; }

NX_INT_OPS(i8, int8_t, uint8_t, INT8_MIN, INT8_MAX)
NX_INT_OPS(i16, int16_t, uint16_t, INT16_MIN, INT16_MAX)
NX_INT_OPS(i32, int32_t, uint32_t, INT32_MIN, INT32_MAX)
NX_INT_OPS(i64, int64_t, uint64_t, INT64_MIN, INT64_MAX)
NX_INT_OPS(u8, uint8_t, uint8_t, 0, UINT8_MAX)
NX_INT_OPS(u16, uint16_t, uint16_t, 0, UINT16_MAX)
NX_INT_OPS(u32, uint32_t, uint32_t, 0, UINT32_MAX)
NX_INT_OPS(u64, uint64_t, uint64_t, 0, UINT64_MAX)
NX_INT_OPS(isize, intptr_t, uintptr_t, INTPTR_MIN, INTPTR_MAX)
NX_INT_OPS(usize, size_t, size_t, 0, SIZE_MAX)
NX_INT_OPS(i128, nx_i128, nx_u128, NX_I128_MIN, NX_I128_MAX)
NX_INT_OPS(u128, nx_u128, nx_u128, 0, (~(nx_u128)0))

/* Generated locals are named `<name>_<n>`. macOS's <mach/.../thread_status.h>
 * (reached through the system headers above) defines object-like macros of
 * that shape (`#define ts_32 uts.ts_32`), which would rewrite a local such as
 * `ts_32`; the generated code never needs them. */
#undef ts_32
#undef ts_64
#undef es_32
#undef es_64
#undef fs_32
#undef fs_64
#undef ds_32
#undef ds_64
#undef ns_32
#undef ns_64
#undef ss_32
#undef ss_64
#undef cs_32
#undef cs_64

#endif /* NX_RT_H */
