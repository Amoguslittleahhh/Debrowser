# Debrowser Legacy (.hta)

The residency architecture, on an engine from 2013, in one file.

```
mshta.exe debrowser.hta
```

## Run the probe first

```
mshta.exe probe.hta
```

`probe.hta` answers whether a **WebView2** engine can exist inside an HTA on
your machine, which decides whether this can ever render the modern web. It
installs nothing and changes nothing: it reads registry keys, tries to compile
one trivial C# class, and reports.

It ends in one of three verdicts:

- **GO** — WebView2 runtime present, `WebView2Loader.dll` found, and C# compiles
  here. The modern engine is worth building.
- **MAYBE** — runtime and compiler present but no loader DLL. Interop might
  still work through the registered COM class; needs one small spike first.
- **STOP** — the WebView2 engine cannot be built on this machine, and the honest
  answer is MSHTML only.

The reason this exists rather than being reasoned about: `WebView2Loader.dll` is
distributed *with applications*, not with the Evergreen Runtime, so whether it
is present at all is a property of your machine and not something that can be
settled from a spec.

The report is also written to `%TEMP%\debrowser-legacy\probe-report.txt`, which
is easier to send than copying out of a textarea — and a report that has been
retyped or truncated is worse than none, since its exact contents decide what
gets built next.

### How far this has been verified

Wine cannot run it: Wine implements `mshtml` through Gecko but its `mshta.exe`
is a stub that prints `mshta.exe is a stub!` and exits, so `.hta` files do not
run there at all. That was tried and abandoned.

Run `node legacy/verdict-test.js` to check that yourself; it extracts the script
straight out of `probe.hta`, so it always tests the file that ships rather than a
copy of it.

What *was* verified, by executing the probe's own script with stubs: the JScript
parses and is ES5-clean, the markup is balanced, the generated PowerShell renders
with balanced braces, parens and quotes, and the GO / MAYBE / STOP verdict logic
returns the right answer for all five combinations of runtime present or absent,
loader found or not, and `Add-Type` working or blocked.

None of that touches Windows. It means the probe is not broken; it does not mean
the answer is known.

## Read this first

**It is unsandboxed.** An HTA runs with your full user privileges, and MSHTML no
longer receives security updates for web content. Browsing arbitrary sites this
way is not safe. `mshta.exe` is also blocked by default in many managed
environments, so it may simply refuse to start. On old Windows, Firefox ESR or a
maintained Chromium fork are better choices for real browsing.

**It is untested.** This was written on Linux, where there is no `mshta.exe` to
run it against. It lives outside `src/` precisely so that being wrong costs
nothing that works: it either runs on your machine or it does not, and it cannot
affect the Electron browser either way. The embedded script was checked for
IE11-parseable syntax (no `let`, `const`, arrows, template literals or classes)
and nothing more.

## What ports, and what does not

Almost nothing of the real browser transfers. There is no Node, no Chromium, no
DevTools protocol, and no multi-process model — `mshta.exe` puts every frame in
one process. So per-tab memory measurement, freezing, hibernation, the
square-root heap rule, process priority and page merging are all unavailable, not
merely unimplemented.

What does port is the thing that actually produced the wins: **residency**.

| | Electron build | here |
|---|---|---|
| live-tab cap, LRU released | yes | **yes** |
| restore from saved state | history, scroll, form input | URL and title only |
| placeholder while restoring | page thumbnail | title + URL card |
| idle timer releases frames | yes | **yes** |
| per-tab memory | PSS per renderer | whole process only, via WMI |
| freeze / hibernate / heap limit | yes | impossible |

The Electron build reached 8.1 MB per open tab at 45 tabs, and it got there by
holding fewer renderers resident rather than by making them smaller. That idea
needs no Chromium, which is why it is the one worth porting.

## Measuring it

The one capability this environment has that Electron does not: an HTA can ask
the OS about itself. The status bar reads the process working set through WMI
and divides by open tabs, so the claim is checkable rather than asserted — open
twenty tabs and watch the per-tab figure fall as the cap holds the live count
flat.

Two caveats. It sums every `mshta.exe`, because an HTA cannot easily learn its
own pid, so another HTA running will be counted too. And working set is not PSS:
it counts shared pages in full, which is the same overstatement the Electron
build had to correct. Treat it as a trend, not a number to quote.

## Limits worth knowing

- Cross-origin frames cannot be read, so a tab's title only updates for sites
  that permit it, and scroll position is never restored. Same-origin policy
  applies inside an HTA exactly as it does in a page.
- Restoring a parked tab reloads it. There is no back/forward cache and no way
  to preserve in-page state, so anything typed into a parked tab is gone.
- Back and forward act on the frame's own history and fail silently
  cross-origin.
- MSHTML in `IE=edge` mode is roughly IE11: ES5, partial flexbox, no `fetch`, no
  `Promise`. Most of the modern web will not render correctly, and some of it
  will not render at all.
