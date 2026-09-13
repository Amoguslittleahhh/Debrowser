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
├── tab renderer × N        one per tab, or one per site in economy profile
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
6. **Enforce the budget** — demote the least valuable tabs until under target.

### Memory attribution across shared processes

Memory is owned by *processes*; policy applies to *tabs*; the mapping is not
one-to-one. Chromium coalesces same-site tabs into a shared renderer, and the
economy profile forces far more of that.

`metrics.js` resolves this by measuring RSS per process and splitting it across
that process's tabs in proportion to their JS heap sizes, which *are* per-tab
and readable over CDP, over a flat per-tab base for DOM and compositor overhead
a heap figure does not capture. Totals are always summed over unique PIDs, so a
shared process is never double-counted against the budget.

Heap sampling only runs for tabs that actually share a process. Elsewhere the
process figure *is* the tab figure, and asking is not free — enabling the
Performance domain instantiates instrumentation inside the renderer.

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
