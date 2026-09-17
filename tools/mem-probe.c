/*
 * mem-probe - per-process memory, measured honestly, on Windows and macOS.
 *
 * Why this exists
 * ---------------
 * Linux hands out a proportional figure for free: /proc/<pid>/smaps_rollup has
 * a Pss line, where every page shared between processes is divided by the
 * number of processes sharing it. Nothing else does.
 *
 * So off Linux this browser summed each process's working set, which counts a
 * shared page once per process that maps it - and the largest shared thing in a
 * Chromium browser is Chromium itself, mapped into every renderer. Measured at
 * 1.95x the proportional figure across five processes and rising with process
 * count: two open tabs could read as 1098 MB. The panel labelled that
 * "over-counts" rather than fixing it, because fixing it needs this.
 *
 * Protocol
 * --------
 * One line in, one line out, on stdin/stdout, as `mem-trim` does - a process
 * spawn per measurement would cost more than the measurement.
 *
 *   measure <pid>   ->  ok <pid> <proportional-bytes> <private-bytes>
 *                   ->  err <pid> <errno>
 *   caps            ->  caps <mechanism> <0|1>
 *
 * Every reply names what it answers, which is the correlation the driver needs
 * to drop a late reply to a request that already timed out.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MECHANISM_NONE "none"

#if defined(_WIN32)

#include <windows.h>
#include <psapi.h>
#define MECHANISM "QueryWorkingSet"

/*
 * Walk the working set a page at a time and divide each shared page by the
 * number of processes sharing it. That is the definition of PSS, computed the
 * only way Windows offers.
 *
 * Two honest caveats, both of which belong in the numbers this produces:
 *
 *   - ShareCount is three bits and saturates at 7. A page shared by more than
 *     seven processes reports 7, so its share is over-stated. A Chromium
 *     browser runs close to that many processes, so this is not hypothetical -
 *     the result is an over-estimate, just a far smaller one than counting each
 *     shared page in full.
 *   - This is the *working set*: resident pages only. Pages paged out to the
 *     compressor or the pagefile are not counted, which is correct for "what is
 *     in RAM" and different from Task Manager's commit-based columns.
 *
 * Also returns the private working set, which is what Task Manager's "Memory"
 * column shows, so the two can be compared rather than argued about.
 */
static int measure_pid(unsigned long pid, unsigned long long *pss,
                       unsigned long long *priv, unsigned long *err) {
  HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, (DWORD)pid);
  if (h == NULL) { *err = GetLastError(); return -1; }

  SYSTEM_INFO si;
  GetSystemInfo(&si);
  const unsigned long long page = si.dwPageSize;

  /* Grow until it fits. QueryWorkingSet reports ERROR_BAD_LENGTH and writes the
     required count into the first field, so this converges in one retry unless
     the process is allocating hard while we look. */
  SIZE_T entries = 65536;
  PSAPI_WORKING_SET_INFORMATION *ws = NULL;
  for (int attempt = 0; attempt < 8; attempt++) {
    SIZE_T bytes = sizeof(PSAPI_WORKING_SET_INFORMATION) + entries * sizeof(PSAPI_WORKING_SET_BLOCK);
    PSAPI_WORKING_SET_INFORMATION *grown = (PSAPI_WORKING_SET_INFORMATION *)realloc(ws, bytes);
    if (grown == NULL) { free(ws); CloseHandle(h); *err = ERROR_OUTOFMEMORY; return -1; }
    ws = grown;
    if (QueryWorkingSet(h, ws, (DWORD)bytes)) goto counted;
    if (GetLastError() != ERROR_BAD_LENGTH) { *err = GetLastError(); free(ws); CloseHandle(h); return -1; }
    entries = ws->NumberOfEntries + 16384;   /* headroom for growth since the ask */
  }
  *err = ERROR_BAD_LENGTH;
  free(ws);
  CloseHandle(h);
  return -1;

counted:
  *pss = 0;
  *priv = 0;
  for (ULONG_PTR i = 0; i < ws->NumberOfEntries; i++) {
    PSAPI_WORKING_SET_BLOCK b = ws->WorkingSetInfo[i];
    /* No validity bit to test: that is PSAPI_WORKING_SET_EX_BLOCK's, and
       QueryWorkingSet reports the working set, which is resident by
       definition. */
    if (b.Shared) {
      unsigned n = b.ShareCount ? b.ShareCount : 1;
      *pss += page / n;
    } else {
      *pss += page;
      *priv += page;
    }
  }
  free(ws);
  CloseHandle(h);
  return 0;
}

#elif defined(__APPLE__)

#include <libproc.h>
#include <errno.h>
#include <sys/resource.h>
#define MECHANISM "proc_pid_rusage"

/*
 * phys_footprint: the number macOS itself charges a process, and what Activity
 * Monitor's Memory column shows.
 *
 * Not PSS, and it must not be described as though it were. It does not divide
 * shared dirty pages between the processes sharing them. What it *does* do is
 * exclude clean file-backed pages - which is where the double counting came
 * from, because the Chromium framework is exactly that: one clean, file-backed
 * mapping in every renderer. So it removes the dominant error without claiming
 * to be proportional.
 *
 * Deliberately proc_pid_rusage rather than task_info: this needs no task port,
 * so no root, no com.apple.security.cs.debugger entitlement, and nothing that
 * would break the moment the app is signed differently. One syscall, no walk of
 * the VM map.
 */
static int measure_pid(unsigned long pid, unsigned long long *pss,
                       unsigned long long *priv, unsigned long *err) {
  struct rusage_info_v4 ri;
  memset(&ri, 0, sizeof(ri));
  if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) {
    *err = (unsigned long)errno;
    return -1;
  }
  *pss = ri.ri_phys_footprint;
  /*
   * No private figure, and zero means exactly that.
   *
   * Repeating the footprint here would be worse than useless: the heap limiter
   * screens candidates on *private* bytes specifically because that is not a
   * proportional figure, and handing it a PSS-style number would silently
   * re-enable the screen the code documents as invalid. Zero is read as "not
   * measured" by the caller and leaves the field null.
   */
  *priv = 0;
  return 0;
}

#else

#define MECHANISM MECHANISM_NONE

/*
 * Not built for Linux, and not a stub that pretends.
 *
 * smaps_rollup already gives a real Pss line, read directly and more cheaply
 * than a round trip through a helper process could manage. A second path to the
 * same number would be one more thing to keep honest.
 */
static int measure_pid(unsigned long pid, unsigned long long *pss,
                       unsigned long long *priv, unsigned long *err) {
  (void)pid; (void)pss; (void)priv;
  *err = 0;
  return -1;
}

#endif

static int supported(void) {
  return strcmp(MECHANISM, MECHANISM_NONE) == 0 ? 0 : 1;
}

int main(void) {
  char line[256];

  /*
   * Unbuffered, not line-buffered.
   *
   * `setvbuf(stdout, NULL, _IOLBF, 0)` is the obvious thing to write and it is
   * wrong on Windows in two separate ways. MSVC requires size between 2 and
   * INT_MAX when the buffer is NULL, and an invalid parameter invokes the
   * invalid-parameter handler, which in a release build terminates the process
   * - so this helper started and died instantly, every time, and the driver
   * reported only "helper exited repeatedly". And MSVC documents _IOLBF as
   * behaving like full buffering on Win32 anyway, so surviving it would have
   * left every reply sitting in a buffer that never fills.
   *
   * _IONBF ignores the size argument and is valid everywhere. For a protocol
   * that writes one short line and waits, unbuffered is also what we want.
   */
  setvbuf(stdout, NULL, _IONBF, 0);

  while (fgets(line, sizeof(line), stdin) != NULL) {
    char *nl = strchr(line, '\n');
    if (nl) *nl = '\0';

    if (strcmp(line, "caps") == 0) {
      printf("caps %s %d\n", MECHANISM, supported());
      fflush(stdout);
      continue;
    }

    if (strncmp(line, "measure ", 8) == 0) {
      unsigned long pid = strtoul(line + 8, NULL, 10);
      if (pid == 0) { printf("err 0 22\n"); fflush(stdout); continue; }

      unsigned long long pss = 0, priv = 0;
      unsigned long err = 0;
      if (measure_pid(pid, &pss, &priv, &err) != 0) {
        printf("err %lu %lu\n", pid, err);
      } else {
        printf("ok %lu %llu %llu\n", pid, pss, priv);
      }
      fflush(stdout);
      continue;
    }

    /* Unknown verbs are answered, never ignored: a driver waiting on a reply
       that never comes is a stall, and a stall here is a stalled governor tick. */
    printf("err 0 22\n");
    fflush(stdout);
  }
  return 0;
}
