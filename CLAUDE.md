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

## Releases

Every release credits the owner and the bot side by side, in the body:

```
Released by **Amoguslittleahhh** (<amogus36311@gmail.com>) and **`github-actions[bot]`**.
```

It goes in the body because a release's `author` is whoever's token created it,
and that is always `github-actions[bot]` — the workflow publishes with the
built-in `GITHUB_TOKEN`. The field is not settable to a person, and a Claude
Code session's token is refused outright when it tries to create or edit a
release, so the body is the only place the credit can live.

Appended by the "Extract this version's notes" step in
`.github/workflows/release.yml`, so it cannot be forgotten on a release.

The release body is that version's notes and nothing else — the step takes the
first `## ` section of `CHANGELOG.md` and drops its heading. Publishing the
whole changelog means every download page repeats the notes for versions the
reader already has, burying the one thing they came to read.
