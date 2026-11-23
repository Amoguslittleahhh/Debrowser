# Debrowser for the terminal

A real, current Chromium in your terminal, with tabs and real key presses.
It drives `chrome-headless-shell` over the DevTools protocol (through a pipe,
so no port is opened) and draws each frame in the terminal:

| Terminal | How it draws |
|---|---|
| kitty, WezTerm, Ghostty | kitty graphics protocol: real pixels |
| Windows Terminal 1.22+, xterm (`-ti vt340`), foot, mlterm | sixel: real pixels, 252 colours |
| anything else, and inside tmux | half blocks: two coloured pixels per cell |

It has no dependencies beyond Node 22 and a Chromium.

## Run it

```sh
npx @puppeteer/browsers install chrome-headless-shell@stable   # once
node terminal/debrowser-tui.js wikipedia.org
```

It finds `chrome-headless-shell` in the Puppeteer or Playwright caches, or a
`chromium`/`google-chrome` on the PATH. `DEBROWSER_CHROME=/path/to/chrome`
picks one.

### On Windows

Use WSL. In PowerShell: `wsl --install`, restart, then in Ubuntu:

```sh
sudo apt install -y nodejs npm libnss3 libasound2t64 libgbm1
git clone -b claude/headless-debrowser https://github.com/Amoguslittleahhh/Debrowser
cd Debrowser && npx @puppeteer/browsers install chrome-headless-shell@stable
node terminal/debrowser-tui.js
```

Run it in **WezTerm** for the sharpest picture (kitty graphics), or in
**Windows Terminal 1.22 or newer** (sixel). Smaller fonts give more pixels.

## Keys

| | |
|---|---|
| Ctrl+L or F6 | address bar (starts selected: just type) |
| Ctrl+T / Ctrl+W | new tab / close tab |
| Alt+1..9, Ctrl+PgUp/PgDn | switch tab (or click it) |
| Alt+Left / Alt+Right | back / forward |
| F5 or Ctrl+R | reload |
| Alt+= / Alt+- / Alt+0 | zoom |
| Ctrl+Q | quit |

Every other key goes to the page with its real `key`, `code` and `keyCode`,
so site shortcuts and games work. The mouse clicks, drags, hovers and scrolls.
Pasting (bracketed paste) types the text into the page.

Options: `--mode=kitty|sixel|blocks`, `--zoom=1.25`, `--fps=15`,
`--cell=8x16` (if the terminal won't report its cell size), `--profile=DIR`
(keep cookies and logins; by default a throwaway profile is used).

## How it stays light

Chromium runs with begin-frame control, so it only renders when asked. The
front tab is asked up to 15 times a second while something changes and 4 times
a second otherwise; background tabs are not asked at all. The screencast sends
a picture only when it changed, and if the terminal falls behind only the
newest frame is kept.

## Limits

- Downloads, file pickers, printing and permission prompts are not supported.
  `alert`/`confirm`/`prompt` are answered automatically and shown in the
  status line.
- Background tabs do not draw, so anything that waits for animation frames
  pauses there until you switch back.
- Sixel is encoded in JavaScript, so a full-screen video costs about one CPU
  core in sixel mode. kitty graphics are much cheaper.
- Pages report `Chrome` rather than `HeadlessChrome` in their user agent: it is
  the same engine and version, and some sites refuse "headless" visitors.

`node terminal/test.js` runs the unit checks and, on Linux, an end-to-end run
in a pseudo-terminal.
