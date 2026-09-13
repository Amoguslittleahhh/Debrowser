/*
 * ksm-launch - mark a process tree as eligible for kernel same-page merging,
 * then exec the real program.
 *
 * This is the applicable form of the page-merging idea from Mesh (Powers,
 * Tench, Berger & McGregor, arXiv:1902.04738) for a browser built on Chromium.
 *
 * Mesh merges pages *within* one process: it finds pairs of spans whose
 * occupied object slots do not overlap and maps them onto one physical page,
 * which needs the allocator's knowledge of object layout. That is not reachable
 * from outside Chromium - it would mean replacing PartitionAlloc.
 *
 * What *is* reachable is the same saving from the other direction. A browser
 * runs many renderers executing identical code over similar structures, so a
 * large number of their anonymous pages are byte-identical rather than merely
 * complementary. Linux already merges those: KSM scans anonymous memory and
 * collapses identical pages to one physical copy, copy-on-write. Mesh exploits
 * non-overlap inside a heap; KSM exploits equality across processes. For a
 * process pool they attack the same waste.
 *
 * Getting Chromium's renderers into KSM's scope is the only hard part. KSM only
 * considers memory a process has opted in, traditionally per-region via
 * madvise(MADV_MERGEABLE), which we cannot call inside someone else's renderer.
 * Since Linux 6.4 prctl(PR_SET_MEMORY_MERGE) marks an entire process, and the
 * flag is *inherited across fork and exec* - so setting it here, before exec'ing
 * Electron, puts the browser process and every renderer it spawns in scope
 * without patching Chromium at all.
 *
 * Build:  cc -O2 -o tools/ksm-launch tools/ksm-launch.c
 * Use:    tools/ksm-launch npx electron .
 *
 * Requires KSM to be running system-wide (root: echo 1 > /sys/kernel/mm/ksm/run).
 * See the security note in docs/ARCHITECTURE.md before enabling it: page
 * deduplication is a known cross-process side channel, and a browser runs
 * untrusted code by design.
 */

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/prctl.h>

#ifndef PR_SET_MEMORY_MERGE
#define PR_SET_MEMORY_MERGE 67
#endif
#ifndef PR_GET_MEMORY_MERGE
#define PR_GET_MEMORY_MERGE 68
#endif

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
        return 2;
    }

    if (prctl(PR_SET_MEMORY_MERGE, 1, 0, 0, 0) != 0) {
        /* Not fatal: without this the browser simply runs unmerged, which is
         * the normal configuration. Say so rather than failing the launch. */
        fprintf(stderr, "ksm-launch: PR_SET_MEMORY_MERGE failed (%s); "
                        "continuing without page merging\n", strerror(errno));
    } else {
        int state = prctl(PR_GET_MEMORY_MERGE, 0, 0, 0, 0);
        fprintf(stderr, "ksm-launch: process tree marked mergeable "
                        "(PR_GET_MEMORY_MERGE=%d)\n", state);
    }

    execvp(argv[1], &argv[1]);
    fprintf(stderr, "ksm-launch: exec %s failed: %s\n", argv[1], strerror(errno));
    return 127;
}
