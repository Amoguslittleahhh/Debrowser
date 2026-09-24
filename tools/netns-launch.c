/*
 * netns-launch: start the private browser where it cannot reach the network,
 * with Tor outside and a single door between them.
 *
 * This is incognito's kill switch on Linux, and it is enforced by the kernel
 * rather than by the browser's own settings. The browser process - and every
 * process Chromium starts from it - runs in a fresh network namespace that has
 * nothing in it but a loopback interface. There is no route anywhere. A
 * request that ignores the proxy settings, from any code path anyone forgot,
 * fails with "network unreachable" instead of reaching the internet. That is
 * GrapheneOS's per-app network permission, applied to one browser.
 *
 * Tor has to reach the internet, so it is started first, in the original
 * namespace, and listens on Unix sockets in the private profile directory.
 * A Unix socket is a file: it can be reached from inside the namespace, where
 * nothing with an address can. The browser relays its SOCKS traffic onto that
 * socket (src/main/incognito/relay.js), because Chromium cannot speak SOCKS
 * over a Unix socket itself.
 *
 *   netns-launch <root> <tor> <torrc-template> -- <browser> [args...]
 *
 *   <root>            the private profile root; must be ours and private
 *   <tor>             the Tor binary
 *   <torrc-template>  a file whose "@DIR@" is replaced with this run's Tor
 *                     directory and "@PID@" with the browser's pid (Tor's
 *                     owning process: Tor exits when the browser does);
 *                     read and then deleted
 *
 * Steps, in order:
 *
 *   1. Make <root>/s-<pid>/tor, where <pid> is this process's id - which is
 *      also the browser's, because the browser is exec'd in place. Write the
 *      torrc there, and start Tor from it, here, in the namespace that has
 *      the network.
 *   2. unshare(CLONE_NEWUSER | CLONE_NEWNET) - no root needed - and map this
 *      user's uid and gid onto themselves. Onto themselves, not onto root:
 *      mapped to root, Electron refuses to run its sandbox, and the renderers
 *      would lose theirs (measured; see docs/MEASUREMENTS.md).
 *   3. Bring `lo` up. The new namespace's loopback starts down, and the relay
 *      and Chromium talk over it.
 *   4. RLIMIT_CORE to 0, inherited by every process from here: a crash cannot
 *      write a private window's memory to a core file.
 *   5. exec the browser, with DEBROWSER_KILL_SWITCH saying what happened.
 *
 * If the kernel refuses the namespace - Ubuntu's AppArmor does, by default,
 * for unprivileged users - Tor is stopped and the browser is exec'd with
 * DEBROWSER_KILL_SWITCH=unavailable:<reason>. It then runs Tor itself and says,
 * in its panel, that only the tripwire stands behind its proxy settings. The
 * .deb installs an AppArmor profile that allows this (packaging/apparmor).
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int write_file(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = write(fd, text, strlen(text));
    close(fd);
    return n == (ssize_t)strlen(text) ? 0 : -1;
}

/* The private root must be a directory we own with nobody else able to look
   in - the same rule the browser applies (src/main/incognito/mode.js). */
static int private_dir(const char *dir) {
    struct stat st;
    if (lstat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) return 0;
    return st.st_uid == getuid() && (st.st_mode & 077) == 0;
}

/* Read the template, replace every "@DIR@", write the torrc. */
static int write_torrc(const char *template_path, const char *dir, const char *out) {
    FILE *in = fopen(template_path, "r");
    if (!in) return -1;
    static char buf[65536];
    size_t len = fread(buf, 1, sizeof buf - 1, in);
    fclose(in);
    buf[len] = '\0';
    unlink(template_path);                    /* it may carry bridge lines */

    FILE *f = fopen(out, "w");
    if (!f) return -1;
    fchmod(fileno(f), 0600);
    char pid[32];
    snprintf(pid, sizeof pid, "%d", (int)getpid());
    for (char *p = buf; *p; ) {
        char *d = strstr(p, "@DIR@"), *q = strstr(p, "@PID@");
        char *hit = d && (!q || d < q) ? d : q;
        if (!hit) { fputs(p, f); break; }
        fwrite(p, 1, (size_t)(hit - p), f);
        fputs(hit == d ? dir : pid, f);
        p = hit + 5;
    }
    fclose(f);
    return 0;
}

static pid_t start_tor(const char *tor, const char *torrc, const char *dir) {
    pid_t pid = fork();
    if (pid != 0) return pid;
    /* Tor's log goes to a file the browser follows for bootstrap progress; its
       own libraries sit beside it in the bundle. */
    char log[4096], libdir[4096];
    snprintf(log, sizeof log, "%s/tor.log", dir);
    int fd = open(log, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); }
    snprintf(libdir, sizeof libdir, "%s", tor);
    char *slash = strrchr(libdir, '/');
    if (slash) { *slash = '\0'; setenv("LD_LIBRARY_PATH", libdir, 1); if (chdir(libdir) != 0) { /* not fatal */ } }
    execl(tor, tor, "-f", torrc, (char *)NULL);
    /* Said where the browser will look for Tor's progress. */
    fprintf(stderr, "[err] netns-launch could not start Tor (%s): %s\n", tor, strerror(errno));
    _exit(127);
}

static int loopback_up(void) {
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof ifr);
    strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
    int rc = ioctl(s, SIOCGIFFLAGS, &ifr);
    if (rc == 0) {
        ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
        rc = ioctl(s, SIOCSIFFLAGS, &ifr);
    }
    close(s);
    return rc;
}

int main(int argc, char **argv) {
    int sep = 0;
    for (int i = 1; i < argc; i++) if (strcmp(argv[i], "--") == 0) { sep = i; break; }
    if (sep != 4 || sep + 1 >= argc) {
        fprintf(stderr, "usage: %s <root> <tor> <torrc-template> -- <browser> [args...]\n", argv[0]);
        return 2;
    }
    const char *root = argv[1], *template_path = argv[3];
    /* Absolute, because Tor is started from its own directory (for its
       libraries) and a relative path would no longer point at it. */
    static char tor[4096];
    if (!realpath(argv[2], tor)) {
        fprintf(stderr, "netns-launch: no Tor at %s: %s\n", argv[2], strerror(errno));
        return 3;
    }
    char **browser = &argv[sep + 1];

    if (!private_dir(root)) {
        fprintf(stderr, "netns-launch: %s is not a private directory owned by this user\n", root);
        return 3;
    }

    char dir[4096], torrc[4200];
    snprintf(dir, sizeof dir, "%s/s-%d", root, (int)getpid());
    mkdir(dir, 0700);
    snprintf(dir, sizeof dir, "%s/s-%d/tor", root, (int)getpid());
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
        fprintf(stderr, "netns-launch: cannot make %s: %s\n", dir, strerror(errno));
        return 3;
    }
    snprintf(torrc, sizeof torrc, "%s/torrc", dir);
    if (write_torrc(template_path, dir, torrc) != 0) {
        fprintf(stderr, "netns-launch: cannot write %s\n", torrc);
        return 3;
    }

    uid_t uid = getuid();
    gid_t gid = getgid();

    /* 1. Tor, outside. */
    pid_t tor_pid = start_tor(tor, torrc, dir);
    if (tor_pid < 0) {
        setenv("DEBROWSER_KILL_SWITCH", "unavailable:tor-did-not-start", 1);
        execv(browser[0], browser);
        return 127;
    }

    /* 2. The namespace. */
    char why[96] = "";
    if (unshare(CLONE_NEWUSER | CLONE_NEWNET) != 0) {
        snprintf(why, sizeof why, "unavailable:unshare-%s", strerror(errno));
    } else {
        char map[64];
        snprintf(map, sizeof map, "%u %u 1\n", (unsigned)uid, (unsigned)uid);
        write_file("/proc/self/setgroups", "deny\n");
        if (write_file("/proc/self/uid_map", map) != 0) snprintf(why, sizeof why, "unavailable:uid-map");
        snprintf(map, sizeof map, "%u %u 1\n", (unsigned)gid, (unsigned)gid);
        if (!why[0] && write_file("/proc/self/gid_map", map) != 0) snprintf(why, sizeof why, "unavailable:gid-map");
        /* 3. Loopback. */
        if (!why[0] && loopback_up() != 0) snprintf(why, sizeof why, "unavailable:loopback-%s", strerror(errno));
    }

    if (why[0]) {
        /* No wall. Tor started outside is not reachable the way the browser
           expects in this case, so it goes; the browser runs its own. */
        kill(tor_pid, SIGTERM);
        setenv("DEBROWSER_KILL_SWITCH", why, 1);
        execv(browser[0], browser);
        return 127;
    }

    /* 4. No core files, for this process and everything it starts. */
    struct rlimit none = { 0, 0 };
    setrlimit(RLIMIT_CORE, &none);

    /* 5. The browser, in place - same pid, so s-<pid> is its session directory. */
    char tor_pid_text[32];
    snprintf(tor_pid_text, sizeof tor_pid_text, "%d", (int)tor_pid);
    setenv("DEBROWSER_KILL_SWITCH", "namespace", 1);
    setenv("DEBROWSER_TOR_DIR", dir, 1);
    setenv("DEBROWSER_TOR_PID", tor_pid_text, 1);
    execv(browser[0], browser);
    fprintf(stderr, "netns-launch: exec %s: %s\n", browser[0], strerror(errno));
    kill(tor_pid, SIGTERM);
    return 127;
}
