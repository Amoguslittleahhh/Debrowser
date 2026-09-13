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

Run one:

```bash
xvfb-run -a npx electron experiments/01-frozen-page-cdp.js --no-sandbox --disable-gpu
```

**The findings, the method, and what each result changed in the browser are in
the [branch README](../README.md).** It is kept as the single copy so the
analysis cannot drift from the table above; each file also carries its own
result in its header comment.
