# Working agreements

## Attribution

Every commit, and every pull request body, credits **both** accounts. Claude
wrote the code; the work is the repository owner's. Trailers, in this order:

```
Co-Authored-By: Amoguslittleahhh <amogus36311@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the session URL>
```

`amogus36311@gmail.com` is the address the repository was created under, chosen
by the owner over the GitHub `users.noreply` alias. Two things follow from that
and are worth knowing rather than rediscovering:

- The address must be added and verified on the GitHub account for the commit
  to link to it. An unverified address still records the name, but GitHub shows
  no avatar and counts no contribution.
- Public git history is permanent, so this address is readable by anyone who
  clones the repository, and removing it later would mean rewriting every commit
  after the one that introduced it. If "Keep my email addresses private" is ever
  switched on for this account, pushes carrying it are rejected with `GH007`.

## The new tab page layout is frozen

The owner has said the new tab page must never change: the mark and
"debrowser" wordmark above the search field, the field with its "Enter ↵"
hint, the most-used sites row when there are any, and the "Continue with these
tabs" card - kept even when empty, saying "The pages you visit will be here to
come back to." with See more under it.

Do not edit `src/renderer/newtab.html`, `newtab.css` or `newtab.js` - not for a
redesign, a wording pass, a greeting, or a cleanup - unless the owner asks for
that specific change to the new tab page in so many words. A broader request
("make it feel human", "improve the design") does not cover it. Shared files
the page loads (`theme.css`, `theme.js`) may change only in ways that leave
this page looking the same.

## Releases

Release only when the owner says to. Fixes, however urgent, go under
`## Unreleased` in `CHANGELOG.md` and wait there, so a release carries a batch
rather than one small fix each.

Every release credits the owner and the bot side by side, in the body:

```
Released by **Amoguslittleahhh** (<amogus36311@gmail.com>) and **`github-actions[bot]`**.
```

It goes in the body because a release's `author` is whoever's token created it,
and that is always `github-actions[bot]` — the workflow publishes with the
built-in `GITHUB_TOKEN`. The field is not settable to a person, and a Claude
Code session's token is refused outright when it tries to create or edit a
release, so the body is the only place the credit can live.

Appended by `.github/scripts/release-notes.py`, which the "Build the release
body" step in `.github/workflows/release.yml` runs (as does
`release-notes.yml`), so it cannot be forgotten on a release.

The release body is that version's notes and nothing else — the script takes the
`## ` section of `CHANGELOG.md` for the version in `package.json` and drops its
heading, so rename `## Unreleased` to the version before releasing. Publishing the
whole changelog means every download page repeats the notes for versions the
reader already has, burying the one thing they came to read.

### Sections, header and footer

A version's notes are sorted under `### ` headings, in this order and only when
non-empty: `New`, `Improved`, `Fixed`, `Security`, `Known issues`, `In Labs`,
`Leaving next release`, `Corrections`. Each item is a bold headline saying what
the user sees, then plain sentences. An item for one system starts with
`Windows:`, `macOS:` or `Linux:`. No emojis, apologies or donation asks.

Do not write a header or footer by hand. `release-notes.py` adds both from the
environment the release workflow sets:

- the header: version, short commit, date and Chromium version, one line;
- the footer: the workflow run and compare links, the SHA-256 of each file
  (also uploaded as `SHA256SUMS.txt`), and the credit line above.

Run locally without those variables and it prints the notes and credit alone.

### Betas and staged rollouts

A beta is a release run with `beta: true`: published as a prerelease, offered
only to the Beta update channel, and never marked Latest. `rollout` (1-100)
offers a release to that share of installs at first; raise it by editing
`stagingPercentage` in the release's `latest*.yml`, or remove the line to
offer it to everyone.

### Do not hard-wrap changelog prose

One paragraph or bullet is one line, however long. The rest of this repository
wraps at about 80 columns, and `CHANGELOG.md` is the exception, because it is
not only a file — it is the release body, rendered by GitHub, which reflows it
to the reader's width.

Wrapping it there buys nothing and breaks things: a wrap that lands inside a
hyphenated compound renders with a stray hyphen and a space, which is exactly
what happened to "double-click-to-maximise" on the 1.1.0 page and had to be
fixed by hand after publishing.

Entries above 1.1.0 are left wrapped. They are already published, and rewrapping
them would change released notes to no benefit.
