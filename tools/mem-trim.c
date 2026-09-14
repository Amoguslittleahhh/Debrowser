/*
 * mem-trim - push a renderer's cold pages into the OS memory compressor.
 *
 * A hidden tab holds its full working set for as long as it stays alive. The
 * governor's answer to that is usually to discard the renderer outright, but a
 * tab holding unsubmitted input or live in-page state cannot be discarded
 * without losing it, so those tabs sit at FROZEN holding everything. This helper
 * is the lever that works on them: it asks the kernel to reclaim the renderer's
 * cold anonymous pages, which zram or zswap then holds compressed. The process
 * stays alive, its state is untouched, and the pages fault back in on resume.
 *
 * Measured on this project's fixtures (docs/MEASUREMENTS.md, M4b/M4c): net
 * system reclaim runs at roughly 29-49% of a renderer's private memory, rising
 * with size - 10.9MB from a 37MB tab, 146MB from a 303MB one - at a resume cost
 * of 4-12ms. "Net" is deliberate: pages leaving the process reappear as zram's
 * own allocation at about 2:1, so the per-process figure alone overstates the
 * saving by roughly double.
 *
 * Linux only. Windows would use SetProcessWorkingSetSizeEx(h, -1, -1) to hand
 * pages to MemCompression, and macOS has no public API to force its compressor
 * at all. Neither is implemented here, because neither can be executed on the
 * machine this was written on, and a plausible-looking call nobody has run is
 * worse than an honest refusal - see trimCapability() in src/main/platform.js.
 *
 * TWO THINGS THIS MUST GET RIGHT, both learned by getting them wrong:
 *
 *   1. Read smaps, not maps. A renderer reserves an enormous amount of address
 *      space it never touches - V8's heap cages measured 1446.7 GiB in a single
 *      renderer here - and process_madvise returns at most 0x7FFFF000 bytes per
 *      call. Feeding it those reservations burns the whole per-call budget on
 *      untouched ranges and never reaches a resident page. An earlier version
 *      did exactly that: the syscall returned success every time, having covered
 *      0 of 281 MiB actually resident, and the feature measured as worthless.
 *      smaps carries each region's Rss, so only regions with resident pages are
 *      advised.
 *
 *   2. Batch under the per-call cap. Even with reservations excluded, a large
 *      renderer's resident anonymous memory can exceed 0x7FFFF000 in one call.
 *
 * WHAT IS DELIBERATELY LEFT BEHIND. Measured against a live renderer holding a
 * 120MB fixture heap: 227 MiB private resident, of which this advises 148 MiB
 * and skips 79 MiB. All 79 MiB is private *file-backed* - the Chromium binary's
 * own dirtied pages and mapped resources - and none of it is a named anonymous
 * region ([anon:...] appeared 0 times in that renderer's smaps, so the named-
 * anon exclusion this filter appears to make is not one it ever performs in
 * practice). Skipping it is correct: clean file pages are reclaimable by the
 * kernel without a compressor at all, so advising them spends the per-call
 * budget to duplicate work the page cache already does. The number is recorded
 * here because "the helper skips a third of private memory" reads like a bug
 * until you know what the third is.
 *
 * Permissions: process_madvise(2) with MADV_PAGEOUT against another process
 * needs ptrace-read access (same uid suffices) AND CAP_SYS_NICE. A desktop
 * launch has the first and not the second, so this needs a one-time
 *
 *     sudo setcap cap_sys_nice+ep tools/mem-trim
 *
 * exactly as page merging needs a one-time root action. Without it every trim
 * returns EPERM, which the caller reports as "unavailable" rather than failing.
 * And with no swap or zram configured the kernel has nowhere to put dirty
 * anonymous pages, so the call succeeds and reclaims nothing - which is why
 * compressionStatus() in src/main/memory.js reports the two conditions apart.
 *
 * Build:  cc -O2 -Wall -o tools/mem-trim tools/mem-trim.c   (npm run build:memtrim)
 * Use:    a line protocol on stdin, one long-lived process owned by platform.js.
 *           trim <pid>   ->  ok <pid> <bytes-advised>
 *                        ->  err <pid> <errno>
 *           caps         ->  caps linux <0|1 can-trim>
 *         Spawned once at startup rather than per trim: a process spawn on every
 *         tier transition would cost more than the trim it performs saves.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <signal.h>

#ifndef MADV_COLD
#define MADV_COLD 20
#endif
#ifndef MADV_PAGEOUT
#define MADV_PAGEOUT 21
#endif

/* iovec slots per call. IOV_MAX is 1024 on Linux. */
#define MAX_IOV 1024
/* Maximum bytes one process_madvise call will report, so batches stay under it. */
#define CALL_CAP 0x7ffff000ULL

static int pidfd_open_compat(pid_t pid) {
    return (int)syscall(SYS_pidfd_open, pid, 0);
}

static ssize_t process_madvise_compat(int pidfd, const struct iovec *iov,
                                      size_t n, int advice, unsigned int flags) {
    return syscall(SYS_process_madvise, pidfd, iov, n, advice, flags);
}

/*
 * Advise every resident, private, anonymous region of `pid` with MADV_PAGEOUT.
 * Returns bytes advised, or -1 with *err set.
 */
static long long trim_process(pid_t pid, int *err) {
    *err = 0;

    int pidfd = pidfd_open_compat(pid);
    if (pidfd < 0) { *err = errno; return -1; }

    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/smaps", pid);
    FILE *f = fopen(path, "r");
    if (!f) { *err = errno; close(pidfd); return -1; }

    struct iovec iov[MAX_IOV];
    size_t n = 0;
    unsigned long long advised = 0, batch = 0;
    unsigned long start = 0, end = 0;
    int eligible = 0;
    char line[512];

    while (fgets(line, sizeof(line), f)) {
        unsigned long s, e;
        char perms[8], rest[256];
        rest[0] = '\0';

        if (sscanf(line, "%lx-%lx %7s %*s %*s %*s %255[^\n]", &s, &e, perms, rest) >= 3
            && strchr(perms, 'p') != NULL) {
            /* A region header. Decide eligibility now; Rss follows below. */
            start = s; end = e;
            eligible = (perms[3] == 'p') && (e > s);
            if (eligible && rest[0] != '\0') {
                /* Private ANONYMOUS only. A named file mapping is reclaimable
                   without the compressor, and a shared one is not this
                   process's alone to evict. [heap] and thread stacks are
                   anonymous despite carrying a label. */
                char *q = rest;
                while (*q == ' ') q++;
                if (*q != '\0' && strcmp(q, "[heap]") != 0 && strncmp(q, "[stack", 6) != 0)
                    eligible = 0;
            }
            continue;
        }

        if (eligible && strncmp(line, "Rss:", 4) == 0) {
            unsigned long rss_kb = strtoul(line + 4, NULL, 10);
            eligible = 0;                       /* one Rss line per region */
            if (rss_kb == 0) continue;          /* reserved, never touched */

            unsigned long len = end - start;
            if (n == MAX_IOV || batch + len > CALL_CAP) {
                ssize_t r = process_madvise_compat(pidfd, iov, n, MADV_PAGEOUT, 0);
                if (r < 0) { *err = errno; fclose(f); close(pidfd); return -1; }
                advised += (unsigned long long)r;
                n = 0; batch = 0;
            }
            iov[n].iov_base = (void *)start;
            iov[n].iov_len = len;
            batch += len; n++;
        }
    }

    if (n > 0) {
        ssize_t r = process_madvise_compat(pidfd, iov, n, MADV_PAGEOUT, 0);
        if (r < 0) { *err = errno; fclose(f); close(pidfd); return -1; }
        advised += (unsigned long long)r;
    }

    fclose(f);
    close(pidfd);
    return (long long)advised;
}

/*
 * Can this build trim at all?
 *
 * Answered by trimming a *child*, not ourselves. Since Linux 6.13,
 * process_madvise on your own mm is permitted without CAP_SYS_NICE (the
 * capability check is skipped when the target mm is the caller's), so a
 * self-trim succeeds on any modern kernel and proves nothing about the case
 * that matters - advising another process's pages, which is every real trim
 * this helper performs. On such a host the old self-test reported "can trim"
 * with no capability held, and the browser then enabled hibernation, froze
 * tabs, and collected EPERM on every one of them.
 *
 * So: fork, have the child touch a page and wait, trim the child, reap it. Same
 * syscall, same permission path, a few hundred microseconds, and a real answer.
 */
static int self_test(void) {
    int ready[2];                      /* child -> parent: "my page exists" */
    if (pipe(ready) < 0) return 0;

    pid_t child = fork();
    if (child < 0) { close(ready[0]); close(ready[1]); return 0; }

    if (child == 0) {
        /* Child: hold one dirty anonymous page so there is something resident
           to advise, say so, then wait to be killed. */
        close(ready[0]);
        volatile char *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (page != MAP_FAILED) *page = 1;
        char b = 1;
        while (write(ready[1], &b, 1) < 0 && errno == EINTR) { }
        for (;;) pause();
    }

    close(ready[1]);

    /* Wait for the page to exist before advising it. Without this the child may
       not have touched anything yet, the advise loop finds no resident region,
       and the helper reports success having made no syscall at all - the same
       class of false positive as advising untouched reservations. */
    char b;
    ssize_t got;
    while ((got = read(ready[0], &b, 1)) < 0 && errno == EINTR) { }
    close(ready[0]);

    int err = 0;
    long long r = got == 1 ? trim_process(child, &err) : -1;

    kill(child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) { }

    /* Zero bytes advised means nothing was actually attempted; that is not a
       demonstration that trimming works. */
    return (r > 0 && err == 0) ? 1 : 0;
}

int main(void) {
    char line[128];

    /* Unbuffered both ways: the parent reads replies synchronously. */
    setvbuf(stdout, NULL, _IOLBF, 0);

    while (fgets(line, sizeof(line), stdin)) {
        if (strncmp(line, "caps", 4) == 0) {
            printf("caps linux %d\n", self_test());
            continue;
        }
        long pid = 0;
        if (sscanf(line, "trim %ld", &pid) == 1 && pid > 0) {
            int err = 0;
            long long advised = trim_process((pid_t)pid, &err);
            if (advised < 0) printf("err %ld %d\n", pid, err);
            else printf("ok %ld %lld\n", pid, advised);
            continue;
        }
        printf("err 0 %d\n", EINVAL);
    }
    return 0;
}
