# Architecture

## Scope: what "from scratch" means here

Debrowser is a browser application written from scratch — process model, tab
lifecycle, session handling, UI, and the resource governor that is the point of
the project. It uses Chromium (via Electron) for the web platform: HTML parsing,
CSS, layout, JavaScript, networking, sandboxing.

That line is deliberate. The requirement driving this project is that *real
websites run properly and smoothly* while using as little memory as possible. A
hand-written rendering engine would fail the first half of that on the first
site anyone opened, and every browser that is not Chrome, Firefox or Safari
makes the same call.

## Process model

```
browser process (Electron main)
├── chrome renderer         the tab strip + toolbar, our own HTML/CSS/JS
├── panel renderer          the task manager; created on open, destroyed on close
├── tab renderer × N        one per *site* by default, capped at maxLiveTabs
├── GPU process
└── utility processes       network, storage, audio
```

The browser UI is its own renderer. That costs one process and earns it: the
tab strip stays responsive when a page hangs, and no page can reach the
chrome's DOM. It is never throttled, because a throttled tab strip is a browser
that feels broken.

Tab views are `WebContentsView`s parented to a `BaseWindow`. Only the active
one is visible; the rest are detached from layout but keep their renderers,
until the governor decides otherwise.

## The governor

`src/main/governor/index.js` runs one pass every 2 seconds:

1. **Sample** — `app.getAppMetrics()` gives RSS and CPU per process.
2. **Attribute** — split each process's memory across the tabs sharing it.
3. **Assess pressure** — total resident vs budget → none / moderate / high / critical.
4. **Update boost** — engage or decay the animation boost on the active tab.
5. **Run the idle ladder** — demote tabs by how long they have been hidden.
6. **Enforce the live-renderer cap** — discard least-recently-used past N live.
7. **Enforce the budget** — demote the least valuable tabs until under target.

### Why a count-based cap, not just a budget

The budget is sized to the host, so on a 16 GB machine it sits near 6 GB.
Thirty tabs at ~100 MB each never reach it: the budget is satisfied, every
policy correctly concludes there is nothing to do, and the user watches their
memory climb anyway. A budget answers "are we using too much in total", which
is the wrong question for someone whose tab count varies by an order of
magnitude.

The cap answers the right one. Because candidates are ordered
least-recently-used, the tabs being moved between stay live while the long tail
costs nothing — which is why the cap is allowed to override the grace period
that otherwise protects a recently-left tab, but never overrides audio,
unsubmitted input, or a pinned tab.

Two supporting mechanisms matter for bursts specifically. **Load admission**
caps simultaneous loads, because peak memory is a loading-time phenomenon and a
burst otherwise spikes far above where it settles. And a tab that has **never
been visible** is exempt from the grace period entirely — it has nothing on
screen to lose, and without that carve-out twenty background links produced
twenty renderers that were all immune from reclaim for a full minute.

### What "memory" means here

Proportional set size, not RSS, and the distinction is worth a factor of three.

`getAppMetrics().memory.workingSetSize` is resident set size, which counts every
resident page including those shared with other processes. The largest mapping
in a Chromium browser is the executable itself, mapped into every renderer, so
summing RSS across processes counts it once per renderer. Six tabs of a trivial
page measured 810 MB summed RSS against 247 MB summed PSS.

This project reported the RSS figures for some time, which overstated both its
footprint and its savings. `src/main/memory.js` now reads
`/proc/<pid>/smaps_rollup` for PSS on Linux and falls back to RSS elsewhere,
labelling which it used. The budget is compared against the PSS figure, which
also means the budget now means what it says rather than triggering reclaim
three times too early.

A smoke check asserts the proportional total is well below the naive RSS sum,
because this is an easy fix to undo by accident and the only symptom is numbers
that look large.

### Memory attribution across shared processes

Memory is owned by *processes*; policy applies to *tabs*; the mapping is not
one-to-one. Chromium coalesces same-site tabs into a shared renderer, and
one-renderer-per-site is enabled by default, so this is the common case rather
than the exception.

`metrics.js` resolves this by measuring RSS per process and splitting it across
that process's tabs in proportion to their JS heap sizes, which *are* per-tab
and readable over CDP, over a flat per-tab base for DOM and compositor overhead
a heap figure does not capture. Totals are always summed over unique PIDs, so a
shared process is never double-counted against the budget.

Heap sampling only runs for tabs that actually share a process. Elsewhere the
process figure *is* the tab figure, and asking is not free — enabling the
Performance domain instantiates instrumentation inside the renderer.

CPU needs the same treatment, and getting it wrong was a real regression.
Sharing a process's CPU out proportionally says every tab in a shared renderer
is equally busy, so a single busy tab made the governor freeze its quiet
neighbours — and freezing costs memory. Per-tab CPU now comes from the
per-document `TaskDuration` metric, differenced over wall time. The honest
limit: that covers a page's main thread, not its Web Workers, so worker-driven
CPU in a *shared* renderer is not attributable to one tab and does not trigger
a freeze. The conservative failure mode was chosen deliberately — leave it
alone rather than freeze the wrong page.

### Victim selection

Under pressure, tabs are ranked worst-first by:

```
score = rssMB × log1p(idleMinutes)
```

Multiplying by idle time rather than sorting by it means a 400 MB tab left five
minutes ago is reclaimed before a 40 MB tab left an hour ago. That ends the
pressure in one action instead of ten, and one interruption is cheaper for the
user than ten.

Under pressure the ladder also skips `FROZEN` entirely when a tab may be
discarded outright — freezing costs memory rather than saving it, so stepping
through it on the way to a discard is pure loss.

### Discard and restore

Discarding destroys the `WebContentsView` and its process. The `Tab` object
survives, holding:

- full navigation history (via `webContents.navigationHistory`), so back and
  forward still work;
- scroll offset;
- unsubmitted form input, excluding password and payment fields.

The snapshot is taken **on every step down the ladder**, while the page can
still answer, not at discard time. Two reasons: a frozen page cannot reply, and
by discard time a tab usually is frozen; and a tab opened in the background is
realised straight into `WARM`, so keying the snapshot off the `ACTIVE → WARM`
transition meant background tabs — the ones most likely to be discarded — were
never snapshotted at all. That bug silently disabled the unsubmitted-input
protection for exactly the wrong set of tabs.

Restore is lazy: a discarded tab costs nothing until it is clicked.

## Page merging, and why it is not a default

`tools/ksm-launch.c` calls `prctl(PR_SET_MEMORY_MERGE)` and execs the browser.
The flag is inherited across fork and exec, so the whole renderer pool enters the
kernel's same-page-merging scope without patching Chromium — which matters,
because KSM is otherwise opted into per-region with `madvise(MADV_MERGEABLE)`,
and there is no way to call that inside someone else's renderer.

This is the reachable form of Mesh's idea. Mesh merges pages *within* a process
using the allocator's knowledge of which object slots are occupied, so it can
combine pages that are merely non-overlapping. From outside Chromium that is
unavailable. KSM merges *across* processes on byte equality instead, which for a
pool of renderers running identical code over similar structures catches much of
the same waste: measured at −12% of total footprint and −28% of per-tab private
memory, corroborated by KSM's own `general_profit` accounting.

It is off by default, and warns on every launch when on, because deduplication is
a well-known timing side channel. A write to a merged page takes a
copy-on-write fault and is measurably slower, so code in one page can test
whether particular content exists elsewhere in memory — and KSM merges
system-wide, so "elsewhere" includes other applications. A browser executes
untrusted code from the network as its normal mode of operation, which is the
worst possible host for that class of attack. The analogous channel is
demonstrated for memory compression in arXiv:2111.08404.

Two independent conditions have to hold for merging to happen, and the browser
reports them separately (`pageMergingStatus` in `src/main/memory.js`) because the
failure modes are indistinguishable otherwise: the process tree must carry the
`mg` VmFlag, and the kernel scanner must be running system-wide, which needs
root. If a user asks for merging and only the first holds, the browser says so
rather than silently running unmerged.

## Failure modes found by building it

These are the non-obvious constraints this design is shaped around. Each was
found by measurement or by a crash, and each is documented at the code that
depends on it.

**A frozen renderer must never be sent IPC.** Delivering any message to a
frozen page segfaults its renderer. `Tab#sendToPage` is the single gate that
makes this impossible to do by accident.

**Presentation order matters.** A frozen page cannot run script, service a
resize, or repaint. Showing it before unfreezing gives a stale frame and
resumes a compositor for a stopped document. `TabManager#activate` is async
specifically so the tab can be promoted to `ACTIVE` *while still off screen*,
and only then made visible.

**A frozen page still answers CDP, and stays frozen after detach.** So the
debugger session is closed once a tab is frozen, rather than held open across
the long tail of tabs that spend most of their life in that state.

**No CDP call may block the UI.** Tab activation awaits an unfreeze, so every
command carries a 2-second ceiling; on timeout the caller falls back exactly as
it would for any other failure.

**`--no-sandbox` cannot be set from JavaScript.** Chromium reads it during
pre-sandbox startup, before any app code runs, so it has to be on the process
command line.

## Animation boost

`boost.js`. Demand for the active tab is fused from:

- the in-page probe (CSS animations, Web Animations, media playback, scrolling);
- renderer CPU, which catches script-driven `rAF` loops the probe cannot see
  from its isolated world;
- `webContents` audible state, which is authoritative and cheap.

"Heavy" means *producing frames right now*, not *producing many*. A single
spinner needs its frames on time as much as a full-screen canvas does, and what
a boost buys — normal priority, and no stalling work anywhere in the browser —
is worth the same to it.

On engage: the tab goes to normal-or-better priority, every other renderer
steps down a notch, and the governor stops doing anything that stalls a
renderer. On decay: priority is restored immediately, and the other renderers
are released.

Priority is advisory. Lowering a process below nice 0 needs privileges a
desktop app will not have on Linux or macOS, so the strategy is inverted:
background renderers are niced *up*, which needs no privileges anywhere, and
the foreground tab wins by everyone else standing aside. On Windows the same
call maps to priority classes and works directly.

## The in-page probe

`src/preload/probe-preload.js` runs in every tab, in an isolated world, and is
written to cost nothing:

- one shared 500 ms interval, which Chromium throttles to roughly once a minute
  once the tab is hidden, and which stops entirely when the tab is frozen;
- it transmits only when the reported tier *changes*, so a settled page sends
  nothing at all;
- all listeners are passive, and nothing on `window` or the DOM is modified;
- `getAnimations()` scanning stops early once enough running animations have
  been seen to classify the tab.

Reports are recorded from any tab, not only the visible one — the probe
transmits on change, so dropping a report would leave the page believing the
browser knows a state it never received. Filtering to the active tab happens in
the boost controller, not in the transport.

## Testing

`npm run smoke` drives the real browser headlessly through 21 checks: the idle
ladder, freezing a background CPU burner, the animation boost engaging and
decaying, every protection, and a discard/restore round trip. It asserts on
measured memory and CPU, not on internal state alone, because every claim this
project makes is empirical.

`npm run bench` runs the same workload with and without the governor and prints
the difference, broken down by process type — because a governor that saves
memory in every renderer can still lose overall by spending it in the browser
process, and only the breakdown makes that visible. It is what caught the
90 MB regression from forced garbage collection.

Both the benchmark and the smoke suite serve their fixtures over HTTP on
distinct hostnames (`t1.test`, `t2.test`, … via `--host-resolver-rules`) rather
than using `file://` URLs. This is not cosmetic. Every `file://` page is the
same site to Chromium, so with one-renderer-per-site enabled they collapse into
a couple of processes — which both overstates the saving and means no tab owns
its renderer, making per-tab CPU an estimate and per-tab memory a share of
somebody else's. Distinct origins are what real browsing looks like to the
process model, and the only configuration in which the assertions mean what
they say.


## Memory compression as a side channel

The `HIBERNATED` tier hands a renderer's cold pages to the kernel's compressor.
That is a weaker exposure than the page merging in `tools/ksm-launch.c`, and the
difference is worth stating because the two are easy to lump together.

KSM finds byte-identical pages **across** processes and collapses them onto one
physical copy. That is a genuine cross-site channel: a write to a merged page
takes a measurably different time, so code in one page can test whether specific
content exists in another process's memory. It is why page merging is opt-in here
and prints a warning on every launch.

A compression store does not deduplicate across processes. What leaks instead is
how well *your own* memory compressed - the store's size and the latency of
faulting a page back both depend on the data's compressibility. That is a real
signal (arXiv:2111.08404 studies compression side channels specifically), but it
is a signal about memory the observer already had, not a probe into another
site's address space.

Two things keep it narrow here. The tier only ever trims a renderer that is
already frozen and hidden, so no script is running in it to take a measurement;
and under `process-per-site` a renderer holds one site's pages, so what compressed
well is that site's own data.

This is why hibernation is on by default where available while page merging is
not, and the reasoning belongs written down rather than re-derived the next time
someone compares them.

## Private windows

An ordinary private window protects you from the next person at your
computer: it writes no history. Every request still leaves in the open, and
the router and the ISP read which sites you visit from DNS, from the TLS
handshake's server name, and from the addresses you connect to. Debrowser's
private windows are built against that observer instead, with GrapheneOS's
habit of enforcing a rule in more than one place and checking that it holds.

### Threat model

| Adversary | What they learn | How |
|---|---|---|
| Your router, your ISP | That you are online, when, and how much. Not which sites, not what you do on them. By default not that it is Tor either, by protocol - bridges; a bridge of your own also hides it from lists of known bridges. | Every request goes through the bundled Tor, behind obfs4, WebTunnel or Snowflake bridges |
| A website | A Tor exit address, and a fingerprint shared by every private window on the same OS | Tor; the fingerprint layer; a circuit per tab |
| A malicious exit relay | Nothing it can change or read unnoticed on HTTPS; plain HTTP only when you allowed it for that site | HTTPS-only, with an explanation page; certificate errors are fatal |
| Someone at this computer afterwards | Nothing from the window: no history, cookies, cache or crash dumps. Tor's guard, sealed by the OS keystore, unless you turn that off. Files you chose to download. | A per-run profile in a private temp directory, deleted on exit and swept after a crash |

Out of reach, and said so on the connection page: malware running as you can
read the process (only the OS can prevent that); anything you sign in to
knows who you are; traffic timing can still hint at a site - camouflage
lowers the odds, not to zero. Where someone's safety depends on it, the answer
is Tor Browser or Tails.

### How the pieces fit

```
normal browser ──Ctrl+Shift+N──► netns-launch (Linux) / Debrowser-Incognito.exe (Windows)
                                   │
          ┌────────────────────────┴───────────────────────────┐
          │ Tor  (outside the namespace; unix sockets on Linux) │
          └────────────────────────▲───────────────────────────┘
                                   │ 24 SOCKS ports = 24 isolated circuits
   private browser process ────────┘  (only loopback exists in its namespace)
   ├── a partition per tab, each on its own port
   ├── the icon circuit, the decoy circuit
   ├── net-watch: the tripwire, and the reaper that deletes the profile after exit
   └── renderers: V8 without its optimising compilers (Balanced), sandboxed
```

It is a second process, because the switches that matter - the proxy, the
resolver rules, the JavaScript flags - are process-wide, and because the two
kinds of window then share no memory. `src/main/incognito/` holds it:

- `mode.js` - the private profile, the switches, and the per-session proxy.
- `tor.js`, `bridges.js`, `torstate.js` - running Tor, reaching it through
  bridges, and keeping its guard sealed between sessions.
- `relay.js`, `tools/netns-launch.c` - the Linux kill switch: the browser in a
  network namespace with nothing but loopback, Tor outside it, and a relay
  from a loopback port to Tor's Unix socket. On Windows the installer adds a
  firewall rule for a hard-linked copy of the executable instead.
- `tripwire.js`, `tools/net-watch.c` - every socket every private process
  holds, checked four times a second against the proxy ports; one that goes
  anywhere else closes the window. The only runtime protection on macOS.
- `policy.js` - no loopback or LAN destinations, HTTPS or an explanation,
  Onion-Location, and the block-page classifier.
- `circuits.js` - a partition and a SOCKS port per tab, new circuit, and
  moving a blocked tab to another exit.
- `fingerprint.js` - the user agent, time zone, language, cores and screen
  every private window reports, applied through the DevTools protocol before a
  tab loads anything, and the self-check that reads them back.
- `sanitise.js` - image metadata stripped from uploads; flat, picture-only
  safe copies of PDFs.
- `camouflage.js` - the opt-in decoy loads.

### Enforced twice, and checked

No rule rests on one mechanism. The proxy is set on the command line and on
every session; the resolver refuses every local lookup, so a request that
somehow went direct could not even resolve a name; on Linux and Windows the OS
refuses a direct connection outright; and the tripwire watches for one anyway.
The fingerprint overrides are re-applied when the debugger carrying them is
replaced, and a tab that cannot have them stops rather than loading without
them.

`test/incognito-leak.js` holds all of it to account on every CI run, against a
stand-in for Tor that records which port every name arrived on: every request
by name through the proxy and nothing else, a netlog with no direct socket, a
canary that must be caught, the OS wall refusing a direct connection, a
circuit per tab, the fingerprint read from pages and workers, uploads without
GPS, a PDF without its script, and a profile that is gone after exit. The
measurements behind each decision are in docs/MEASUREMENTS.md.
