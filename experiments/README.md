# experiments/

| File | Isolates |
|---|---|
| `lib.js` | shared harness: settled memory sampling, page fixtures, CDP with a timeout |
| `01-frozen-page-cdp.js` | whether a frozen renderer answers CDP and unfreezes |
| `02-frozen-ipc-segfault.js` | which operation segfaults a renderer (`--mode=views\|freeze\|purge-then-ipc`) |
| `03-trim-levers.js` | what each trim lever reclaims (`--page=`) |
| `04-gc-instrumentation-cost.js` | what asking for a GC costs (`--page=heavy\|idle`) |
| `05-background-reclaim.js` | a hidden tab's memory over 60s (`--mode=none\|gc\|frozen`) |
| `06-cdp-session-cost.js` | the cost of holding a debugger session |
| `07-rss-vs-pss.js` | whether summed RSS is a truthful footprint (it is not) |
| `08-per-tab-flags.js` | which flags actually reduce what one tab costs (`--label=`, one config per launch) |
| `09-electron-process-census.js` | whether `getAppMetrics()` is the whole browser (it omits the zygotes) |
| `10-fixed-overhead.js` | fits `total = fixed + n x per_tab` over several tab counts |
| `11-fixed-overhead-levers.js` | whether collapsing the GPU/network/zygote processes saves anything |
| `12-whole-renderer-freeze.js` | whether freezing *every* page in a renderer purges it (`CASE=none\|one\|all`) |
| `13-renderer-trim.js` | what `MADV_PAGEOUT` returns to the system (`HEAP_MB=`, needs `PROBE=`) |
| `14-renderer-smaps-census.js` | where a renderer's resident memory actually lives, by mapping kind |
| `15-prefetch-value.js` | whether a hover head start shortens the wait (`DWELL=`, `REPS=`) |
| `16-park-hidden-views.js` | whether detaching a hidden view releases anything (`TABS=`) |
| `17-oopif-cost.js` | the marginal cost of one out-of-process iframe (`FRAMES=0\|6`) |
| `18-per-open-tab-cost.js` | what the Nth simultaneously-open *discarded* tab costs |
| `19-cache-sizing.js` | whether Chromium's caches are sized from host RAM (`TABS=`, `REPS=`) |

Run one:

```bash
xvfb-run -a npx electron experiments/01-frozen-page-cdp.js --no-sandbox --disable-gpu
```

Experiments 07 and 08 additionally need `*.test` to resolve locally, so each tab
gets its own site and owns its renderer:

```bash
xvfb-run -a npx electron experiments/07-rss-vs-pss.js --no-sandbox --disable-gpu \
  --host-resolver-rules="MAP *.test 127.0.0.1"
```

They read `/proc/<pid>/smaps_rollup`, so they are Linux-only and say so when run
elsewhere.

`13-renderer-trim.js` needs a built trim helper and somewhere to page into, and
refuses to print a figure without the latter - an earlier run of this
measurement was silently invalid because zram had reset between setup and
execution:

```bash
npm run build:memtrim
sudo setcap cap_sys_nice+ep tools/mem-trim        # process_madvise on another process
sudo swapon /dev/zram0                            # or any swap
PROBE=tools/mem-trim HEAP_MB=250 xvfb-run -a npx electron experiments/13-renderer-trim.js \
  --no-sandbox --disable-gpu
```

Every figure these produced is written up in `docs/MEASUREMENTS.md`. Experiments
09-19 are from the residency work; 01-08 predate it.

**The findings, the method, and what each result changed in the browser are in
the [branch README](../README.md).** It is kept as the single copy so the
analysis cannot drift from the table above; each file also carries its own
result in its header comment.
