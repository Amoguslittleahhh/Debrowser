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

**The findings, the method, and what each result changed in the browser are in
the [branch README](../README.md).** It is kept as the single copy so the
analysis cannot drift from the table above; each file also carries its own
result in its header comment.
