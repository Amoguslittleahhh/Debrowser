# Contributing

Thanks for looking. Bug reports, fixes and small features are all welcome.

## Reporting a bug

Open an issue with the **Bug** template. The one thing it asks for that saves
the most time is the output of **Copy version info** (in the menu, or the
command bar): the Debrowser and Chromium versions, your system and design.

Security problems do not go in issues - see [SECURITY.md](SECURITY.md).

## Running from source

```
npm ci
npm start
```

Before sending a change, run what CI runs:

```
npm run lint
npm run smoke:headless     # the smoke suite, in a virtual display
npm run test:incognito     # private windows leave nothing behind
```

## Sending a change

- One change per pull request, with the reason in its description.
- Commit titles start with the area in brackets - `[Tabs]`, `[Address bar]`,
  `[Private]`, `[Downloads]`, `[Memory]`, `[Passwords]`, `[Build]`, `[Docs]` -
  and a `Fixes #n` line in the body closes the issue it fixes.
- Add a line under `## Unreleased` in `CHANGELOG.md`, in the right `###`
  section, saying what a user will notice. One line, not wrapped; see
  `CLAUDE.md` for why.
- Code wraps at about 80 columns and matches the file around it.
- A new page or IPC message goes in the preload allowlist and `PAGE_POLICY`.
- Private windows must not write anything new to disk.

Issues labelled `good first issue` are small and self-contained.

## Releases

A stable release comes about every four weeks and is cut by the owner. Between
them, a point release is made only for security, lost data or crashes.
