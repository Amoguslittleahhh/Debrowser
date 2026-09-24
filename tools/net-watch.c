/*
 * net-watch: which sockets does a set of processes hold, and where do they go?
 *
 * The egress tripwire for incognito. Every request incognito makes is meant to
 * go to exactly one place - the local Tor proxy - and the browser enforces that
 * with its own settings. This helper checks the result from outside the
 * browser, by asking the operating system which connections the browser's
 * processes actually have open. A connection to anywhere else means something
 * went around the proxy, and the browser closes the window.
 *
 * It is a tripwire, not a wall. It polls, so a connection that opens and closes
 * between two polls is not seen; the wall is the OS-level kill switch where
 * there is one (a network namespace on Linux, a firewall rule on Windows), and
 * on macOS, where there is none without root, this is the only runtime check.
 *
 * Protocol, one line each way, spawned once and kept (like mem-probe):
 *
 *   caps
 *     -> caps <platform> <0|1> <what it can see>
 *   check <id> <allowed ports, comma-separated> <pids, comma-separated>
 *     -> ok <id> <unreadable> <n> [<pid>/<proto>/<local>-><remote> ...]
 *   usage
 *     -> usage <microseconds of CPU this helper has used>
 *
 * `usage` exists so the browser can hold the tripwire to a budget - under 1% of
 * one core - by measuring what it costs rather than assuming it is cheap.
 *
 * Only violations are listed. A socket is fine when it is not connected to
 * anything (listening, or an unconnected UDP socket), or when it is on loopback
 * *and* one of its two ports is an allowed one - the proxy port, the Tor
 * control port. Loopback alone is not enough: measured, a Chromium session
 * with no proxy of its own quietly used the environment's proxy on a different
 * loopback port, and "any loopback is safe" would have passed it.
 *
 * `unreadable` counts processes whose sockets could not be listed at all -
 * reported, never treated as clean, so a helper that can see nothing does not
 * read as a browser that is doing nothing.
 *
 *   Linux    /proc/<pid>/fd socket inodes, matched against that process's own
 *            view of /proc/<pid>/net/{tcp,tcp6,udp,udp6}. TCP and UDP.
 *   Windows  GetExtendedTcpTable with owning pids. TCP only: the UDP table has
 *            no remote address, so a UDP send cannot be attributed to a
 *            destination - which is why incognito disables QUIC and non-proxied
 *            WebRTC rather than relying on this to catch them.
 *   macOS    proc_pidinfo(PROC_PIDLISTFDS) + PROC_PIDFDSOCKETINFO. TCP and UDP.
 *
 * None of these needs elevation for the user's own processes.
 *
 * A second job, unrelated to sockets but needing the same thing - a small
 * native process that outlives a moment the browser cannot see past:
 *
 *   net-watch --reap <pid> <dir>
 *
 * waits for process <pid> to end and then deletes <dir>. Incognito starts one
 * at launch, pointed at its own session directory, because Chromium writes its
 * shutdown state after the browser's own exit handlers have run - nothing
 * inside the process can delete what is written after it stops running code.
 * It refuses any directory that is not an incognito session directory, so it
 * cannot be pointed at anything else.
 */

#if defined(__linux__)
#define _XOPEN_SOURCE 700
#define _DEFAULT_SOURCE
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#define MAX_PIDS 256
/* Tor's port pool (24) and its control port, with room to spare: a list cut
   short would trip on a legitimate port, so it must never be the limit. */
#define MAX_ALLOW 64
#define MAX_REPORT 32
#define LINE_MAX_LEN 8192

static unsigned long pids[MAX_PIDS];
static int npids;
static unsigned allow[MAX_ALLOW];
static int nallow;

static char report[MAX_REPORT][160];
static int nreport;
static int nviolations;

static int allowed_port(unsigned port) {
    for (int i = 0; i < nallow; i++) if (allow[i] == port) return 1;
    return 0;
}

/* Record one socket. `loopback` and `connected` are decided by the backend,
   which is the only place that knows how its platform spells an address. */
static void consider(unsigned long pid, const char *proto,
                     const char *laddr, unsigned lport,
                     const char *raddr, unsigned rport,
                     int loopback, int connected) {
    if (!connected) return;
    if (loopback && (allowed_port(lport) || allowed_port(rport))) return;
    nviolations++;
    if (nreport < MAX_REPORT) {
        snprintf(report[nreport++], sizeof(report[0]), "%lu/%s/%s:%u->%s:%u",
                 pid, proto, laddr, lport, raddr, rport);
    }
}

static int parse_list(const char *s, unsigned long *out, int max) {
    int n = 0;
    while (*s && n < max) {
        char *end;
        unsigned long v = strtoul(s, &end, 10);
        if (end == s) break;
        out[n++] = v;
        s = end;
        if (*s == ',') s++;
        else break;
    }
    return n;
}

#if defined(_WIN32)
/* ------------------------------------------------------------------ */
/* Windows                                                              */
/* ------------------------------------------------------------------ */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#define PLATFORM_NAME "windows"
#define CAN_SEE "tcp"

static int watched(DWORD pid) {
    for (int i = 0; i < npids; i++) if (pids[i] == pid) return 1;
    return 0;
}

static void *table(ULONG family) {
    DWORD size = 0;
    void *buf = NULL;
    /* The table can grow between the size query and the read; try a few times. */
    for (int attempt = 0; attempt < 4; attempt++) {
        DWORD rc = GetExtendedTcpTable(buf, &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
        if (rc == NO_ERROR) return buf;
        if (rc != ERROR_INSUFFICIENT_BUFFER) break;
        free(buf);
        buf = malloc(size);
        if (!buf) return NULL;
    }
    free(buf);
    return NULL;
}

static int scan(void) {
    char l[64], r[64];
    MIB_TCPTABLE_OWNER_PID *t4 = table(AF_INET);
    if (t4) {
        for (DWORD i = 0; i < t4->dwNumEntries; i++) {
            MIB_TCPROW_OWNER_PID *row = &t4->table[i];
            if (!watched(row->dwOwningPid) || row->dwState == MIB_TCP_STATE_LISTEN) continue;
            struct in_addr la, ra;
            la.s_addr = row->dwLocalAddr;
            ra.s_addr = row->dwRemoteAddr;
            inet_ntop(AF_INET, &la, l, sizeof l);
            inet_ntop(AF_INET, &ra, r, sizeof r);
            unsigned lport = ntohs((u_short)row->dwLocalPort);
            unsigned rport = ntohs((u_short)row->dwRemotePort);
            int loop = (ntohl(row->dwRemoteAddr) >> 24) == 127;
            consider(row->dwOwningPid, "tcp", l, lport, r, rport, loop,
                     row->dwRemoteAddr != 0 && rport != 0);
        }
        free(t4);
    }
    MIB_TCP6TABLE_OWNER_PID *t6 = table(AF_INET6);
    if (t6) {
        static const unsigned char any[16] = {0};
        static const unsigned char one[16] = {0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
        for (DWORD i = 0; i < t6->dwNumEntries; i++) {
            MIB_TCP6ROW_OWNER_PID *row = &t6->table[i];
            if (!watched(row->dwOwningPid) || row->dwState == MIB_TCP_STATE_LISTEN) continue;
            inet_ntop(AF_INET6, row->ucLocalAddr, l, sizeof l);
            inet_ntop(AF_INET6, row->ucRemoteAddr, r, sizeof r);
            unsigned lport = ntohs((u_short)row->dwLocalPort);
            unsigned rport = ntohs((u_short)row->dwRemotePort);
            const unsigned char *ra = row->ucRemoteAddr;
            int mapped_loop = memcmp(ra, any, 10) == 0 && ra[10] == 0xff && ra[11] == 0xff && ra[12] == 127;
            int loop = memcmp(ra, one, 16) == 0 || mapped_loop;
            consider(row->dwOwningPid, "tcp6", l, lport, r, rport, loop,
                     memcmp(ra, any, 16) != 0 && rport != 0);
        }
        free(t6);
    }
    /* Windows reports every process's connections in one table; there is no
       per-process permission to fail. */
    return 0;
}

static int self_test(void) {
    void *t = table(AF_INET);
    if (!t) return 0;
    free(t);
    return 1;
}

#elif defined(__APPLE__)
/* ------------------------------------------------------------------ */
/* macOS                                                                */
/* ------------------------------------------------------------------ */
#include <libproc.h>
#include <sys/proc_info.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#define PLATFORM_NAME "darwin"
#define CAN_SEE "tcp+udp"

static void one_socket(unsigned long pid, const struct socket_fdinfo *si) {
    const struct in_sockinfo *in;
    const char *proto;
    if (si->psi.soi_kind == SOCKINFO_TCP) {
        if (si->psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN) return;
        in = &si->psi.soi_proto.pri_tcp.tcpsi_ini;
        proto = "tcp";
    } else if (si->psi.soi_kind == SOCKINFO_IN) {
        in = &si->psi.soi_proto.pri_in;
        proto = "udp";
    } else {
        return;                         /* a Unix socket: not the network */
    }

    char l[64], r[64];
    unsigned lport = ntohs((unsigned short)in->insi_lport);
    unsigned rport = ntohs((unsigned short)in->insi_fport);
    int loop, connected;
    if (in->insi_vflag & INI_IPV4) {
        struct in_addr la = in->insi_laddr.ina_46.i46a_addr4;
        struct in_addr ra = in->insi_faddr.ina_46.i46a_addr4;
        inet_ntop(AF_INET, &la, l, sizeof l);
        inet_ntop(AF_INET, &ra, r, sizeof r);
        loop = (ntohl(ra.s_addr) >> 24) == 127;
        connected = ra.s_addr != 0 && rport != 0;
    } else if (in->insi_vflag & INI_IPV6) {
        inet_ntop(AF_INET6, &in->insi_laddr.ina_6, l, sizeof l);
        inet_ntop(AF_INET6, &in->insi_faddr.ina_6, r, sizeof r);
        loop = IN6_IS_ADDR_LOOPBACK(&in->insi_faddr.ina_6) ||
               (IN6_IS_ADDR_V4MAPPED(&in->insi_faddr.ina_6) &&
                in->insi_faddr.ina_6.s6_addr[12] == 127);
        connected = !IN6_IS_ADDR_UNSPECIFIED(&in->insi_faddr.ina_6) && rport != 0;
    } else {
        return;
    }
    consider(pid, proto, l, lport, r, rport, loop, connected);
}

static int scan(void) {
    int unreadable = 0;
    for (int i = 0; i < npids; i++) {
        pid_t pid = (pid_t)pids[i];
        int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
        if (bytes <= 0) {
            if (errno != ESRCH) unreadable++;
            continue;
        }
        /* Headroom: descriptors can be opened between the two calls. */
        struct proc_fdinfo *fds = malloc((size_t)bytes + 64 * sizeof(struct proc_fdinfo));
        if (!fds) { unreadable++; continue; }
        bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, bytes + 64 * (int)sizeof(struct proc_fdinfo));
        if (bytes <= 0) { free(fds); unreadable++; continue; }
        int n = bytes / (int)sizeof(struct proc_fdinfo);
        for (int k = 0; k < n; k++) {
            if (fds[k].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
            struct socket_fdinfo si;
            int got = proc_pidfdinfo(pid, fds[k].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof si);
            if (got != (int)sizeof si) continue;   /* closed in the meantime */
            one_socket(pids[i], &si);
        }
        free(fds);
    }
    return unreadable;
}

static int self_test(void) {
    return proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0) > 0;
}

#else
/* ------------------------------------------------------------------ */
/* Linux                                                                */
/* ------------------------------------------------------------------ */
#include <dirent.h>
#include <unistd.h>
#include <arpa/inet.h>
#define PLATFORM_NAME "linux"
#define CAN_SEE "tcp+udp"

#define MAX_INODES 4096
static unsigned long inodes[MAX_INODES];
static int ninodes;

static int cmp_ul(const void *a, const void *b) {
    unsigned long x = *(const unsigned long *)a, y = *(const unsigned long *)b;
    return x < y ? -1 : x > y;
}

/* 1 = read, 0 = process gone, -1 = not allowed to look. */
static int collect_inodes(unsigned long pid) {
    char dir[64];
    snprintf(dir, sizeof dir, "/proc/%lu/fd", pid);
    DIR *d = opendir(dir);
    if (!d) return errno == ENOENT ? 0 : -1;
    ninodes = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && ninodes < MAX_INODES) {
        if (e->d_name[0] == '.') continue;
        char link[96], target[64];
        snprintf(link, sizeof link, "%s/%s", dir, e->d_name);
        ssize_t n = readlink(link, target, sizeof target - 1);
        if (n <= 0) continue;
        target[n] = '\0';
        unsigned long ino;
        if (sscanf(target, "socket:[%lu]", &ino) == 1) inodes[ninodes++] = ino;
    }
    closedir(d);
    qsort(inodes, (size_t)ninodes, sizeof(inodes[0]), cmp_ul);
    return 1;
}

/* An address as /proc prints it: IPv4 is one little-endian 32-bit word, IPv6 is
   four of them. Converted into network order for inet_ntop. */
static int decode(const char *hex, int v6, unsigned char out[16]) {
    int words = v6 ? 4 : 1;
    for (int w = 0; w < words; w++) {
        unsigned int word;
        if (sscanf(hex + w * 8, "%8x", &word) != 1) return 0;
        memcpy(out + w * 4, &word, 4);  /* host order already matches /proc's */
    }
    return 1;
}

/* One row of a socket table, kept so the tables are read once per check. */
struct row {
    unsigned long inode;
    const char *proto;
    int v6, tcp;
    unsigned state, lport, rport;
    unsigned char laddr[16], raddr[16];
};

#define MAX_ROWS 16384
static struct row rows[MAX_ROWS];
static int nrows;

static int cmp_row(const void *a, const void *b) {
    unsigned long x = ((const struct row *)a)->inode, y = ((const struct row *)b)->inode;
    return x < y ? -1 : x > y;
}

/*
 * Read one of the netns's socket tables into `rows`.
 *
 * Read once per check, not once per process: every process in the browser
 * shares one network namespace and so one set of tables, and reading all four
 * per process was most of what the tripwire cost - measured at 1.7 ms of CPU
 * per check for four processes, enough to push it past its 1% budget and back
 * off to checking every two seconds.
 */
static void load_table(unsigned long pid, const char *name, const char *proto, int v6, int tcp) {
    char file[64];
    snprintf(file, sizeof file, "/proc/%lu/net/%s", pid, name);
    FILE *f = fopen(file, "r");
    if (!f) return;
    char line[512];
    if (!fgets(line, sizeof line, f)) { fclose(f); return; }   /* header */
    while (fgets(line, sizeof line, f) && nrows < MAX_ROWS) {
        char la[40], ra[40];
        struct row *r = &rows[nrows];
        if (sscanf(line, " %*d: %39[0-9A-Fa-f]:%x %39[0-9A-Fa-f]:%x %x %*s %*s %*s %*u %*u %lu",
                   la, &r->lport, ra, &r->rport, &r->state, &r->inode) != 6) continue;
        if (r->inode == 0) continue;
        memset(r->laddr, 0, 16);
        memset(r->raddr, 0, 16);
        if (!decode(la, v6, r->laddr) || !decode(ra, v6, r->raddr)) continue;
        r->proto = proto;
        r->v6 = v6;
        r->tcp = tcp;
        nrows++;
    }
    fclose(f);
}

static void judge_row(unsigned long pid, const struct row *r) {
    if (r->tcp && r->state == 0x0A) return;                    /* LISTEN */
    char l[64], rr[64];
    inet_ntop(r->v6 ? AF_INET6 : AF_INET, r->laddr, l, sizeof l);
    inet_ntop(r->v6 ? AF_INET6 : AF_INET, r->raddr, rr, sizeof rr);
    int loop, connected;
    if (r->v6) {
        static const unsigned char any[16] = {0};
        static const unsigned char one[16] = {0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
        int mapped = memcmp(r->raddr, any, 10) == 0 && r->raddr[10] == 0xff && r->raddr[11] == 0xff;
        loop = memcmp(r->raddr, one, 16) == 0 || (mapped && r->raddr[12] == 127);
        connected = memcmp(r->raddr, any, 16) != 0 && r->rport != 0;
    } else {
        loop = r->raddr[0] == 127;
        connected = (r->raddr[0] | r->raddr[1] | r->raddr[2] | r->raddr[3]) != 0 && r->rport != 0;
    }
    consider(pid, r->proto, l, r->lport, rr, r->rport, loop, connected);
}

static int scan(void) {
    int unreadable = 0;
    nrows = 0;
    int loaded = 0;
    for (int i = 0; i < npids; i++) {
        int got = collect_inodes(pids[i]);
        if (got < 0) { unreadable++; continue; }
        if (got == 0 || ninodes == 0) continue;
        if (!loaded) {
            /* The first live process's view of the namespace stands for all. */
            load_table(pids[i], "tcp", "tcp", 0, 1);
            load_table(pids[i], "tcp6", "tcp6", 1, 1);
            load_table(pids[i], "udp", "udp", 0, 0);
            load_table(pids[i], "udp6", "udp6", 1, 0);
            qsort(rows, (size_t)nrows, sizeof(rows[0]), cmp_row);
            loaded = 1;
        }
        /* Walk this process's socket inodes against the sorted rows. */
        for (int k = 0; k < ninodes; k++) {
            struct row key;
            key.inode = inodes[k];
            struct row *hit = bsearch(&key, rows, (size_t)nrows, sizeof(rows[0]), cmp_row);
            if (!hit) continue;
            /* Several rows can share an inode only across tables; walk back to the first. */
            while (hit > rows && (hit - 1)->inode == key.inode) hit--;
            for (; hit < rows + nrows && hit->inode == key.inode; hit++) judge_row(pids[i], hit);
        }
    }
    return unreadable;
}

static int self_test(void) {
    char dir[64];
    snprintf(dir, sizeof dir, "/proc/%d/fd", (int)getpid());
    DIR *d = opendir(dir);
    if (!d) return 0;
    closedir(d);
    FILE *f = fopen("/proc/self/net/tcp", "r");
    if (!f) return 0;
    fclose(f);
    return 1;
}
#endif

/* CPU time this process has used, in microseconds. */
#if defined(_WIN32)
static unsigned long long cpu_us(void) {
    FILETIME c, e, k, u;
    if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
    ULARGE_INTEGER kk, uu;
    kk.LowPart = k.dwLowDateTime; kk.HighPart = k.dwHighDateTime;
    uu.LowPart = u.dwLowDateTime; uu.HighPart = u.dwHighDateTime;
    return (kk.QuadPart + uu.QuadPart) / 10;       /* 100ns ticks */
}
#else
#include <sys/resource.h>
static unsigned long long cpu_us(void) {
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
    return (unsigned long long)(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000000ULL
         + (unsigned long long)(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec);
}
#endif


/* ------------------------------------------------------------------ */
/* Reaper                                                               */
/* ------------------------------------------------------------------ */

/* Only ever an incognito session directory: .../debrowser-incognito-<who>/s-<pid> */
static int safe_target(const char *dir) {
    const char *last = strrchr(dir, '/');
#if defined(_WIN32)
    const char *back = strrchr(dir, '\\');
    if (!last || (back && back > last)) last = back;
#endif
    if (!last || strncmp(last + 1, "s-", 2) != 0) return 0;
    const char *hit = strstr(dir, "debrowser-incognito");
    return hit != NULL && hit < last;
}

#if defined(_WIN32)
static void remove_tree(const char *dir) {
    char pattern[MAX_PATH * 2];
    snprintf(pattern, sizeof pattern, "%s\\*", dir);
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!strcmp(fd.cFileName, ".") || !strcmp(fd.cFileName, "..")) continue;
            char child[MAX_PATH * 2];
            snprintf(child, sizeof child, "%s\\%s", dir, fd.cFileName);
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
                /* Never follow a link out of the directory; remove the link itself. */
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryA(child);
                else DeleteFileA(child);
            } else if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                remove_tree(child);
            } else {
                SetFileAttributesA(child, FILE_ATTRIBUTE_NORMAL);
                DeleteFileA(child);
            }
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
    RemoveDirectoryA(dir);
}

static int reap(unsigned long pid, const char *dir) {
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
    if (h) { WaitForSingleObject(h, INFINITE); CloseHandle(h); }
    /* Files can stay locked for a moment after a process ends; retry. */
    for (int attempt = 0; attempt < 20; attempt++) {
        Sleep(attempt ? 250 : 300);
        remove_tree(dir);
        if (GetFileAttributesA(dir) == INVALID_FILE_ATTRIBUTES) break;
    }
    /* The profile root too, if this run was the last thing in it - as on
       Linux. RemoveDirectory refuses a directory that is not empty, which is
       the check. */
    char parent[MAX_PATH * 2];
    snprintf(parent, sizeof parent, "%s", dir);
    char *cut = strrchr(parent, '\\');
    char *slash = strrchr(parent, '/');
    if (!cut || (slash && slash > cut)) cut = slash;
    if (cut) { *cut = '\0'; RemoveDirectoryA(parent); }
    return 0;
}
#else
#include <ftw.h>
#include <signal.h>
#include <unistd.h>
#include <libgen.h>

static int remove_one(const char *p, const struct stat *st, int flag, struct FTW *ftw) {
    (void)st; (void)flag; (void)ftw;
    remove(p);
    return 0;
}

static int reap(unsigned long pid, const char *dir) {
    /* Our parent is normally the process to wait for; when it ends we are
       reparented, which cannot be confused with pid reuse the way kill(pid, 0)
       can. */
    pid_t parent = getppid();
    for (;;) {
        if ((unsigned long)parent == pid) {
            if (getppid() != parent) break;
        } else if (kill((pid_t)pid, 0) != 0 && errno == ESRCH) {
            break;
        }
        usleep(250000);
    }
    usleep(300000);
    /* FTW_PHYS: never follow a symlink out of the directory. */
    nftw(dir, remove_one, 16, FTW_DEPTH | FTW_PHYS);
    /* The profile root too, if this run was the last thing in it. */
    char copy[4096];
    snprintf(copy, sizeof copy, "%s", dir);
    rmdir(dirname(copy));
    return 0;
}
#endif

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "--reap") == 0) {
        if (!safe_target(argv[3])) {
            fprintf(stderr, "net-watch: refusing to reap %s\n", argv[3]);
            return 2;
        }
        return reap(strtoul(argv[2], NULL, 10), argv[3]);
    }

    /* Unbuffered: see the note in mem-probe.c on why _IOLBF is wrong on Windows. */
    setvbuf(stdout, NULL, _IONBF, 0);
#if defined(_WIN32)
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    static char line[LINE_MAX_LEN];
    while (fgets(line, sizeof line, stdin)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';

        if (strcmp(line, "caps") == 0) {
            printf("caps %s %d %s\n", PLATFORM_NAME, self_test(), CAN_SEE);
            fflush(stdout);
            continue;
        }

        if (strcmp(line, "usage") == 0) {
            printf("usage %llu\n", cpu_us());
            fflush(stdout);
            continue;
        }

        char id[32], ports[1024], list[LINE_MAX_LEN];
        if (sscanf(line, "check %31s %1023s %8191s", id, ports, list) == 3) {
            unsigned long tmp[MAX_ALLOW];
            nallow = strcmp(ports, "-") == 0 ? 0 : parse_list(ports, tmp, MAX_ALLOW);
            for (int i = 0; i < nallow; i++) allow[i] = (unsigned)tmp[i];
            npids = parse_list(list, pids, MAX_PIDS);
            nreport = 0;
            nviolations = 0;
            int unreadable = scan();
            printf("ok %s %d %d", id, unreadable, nviolations);
            for (int i = 0; i < nreport; i++) printf(" %s", report[i]);
            printf("\n");
            fflush(stdout);
            continue;
        }
        printf("err bad-request\n");
        fflush(stdout);
    }
    return 0;
}
