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

Releases already record the account that triggered them, so they need nothing
extra; the release itself is published by `github-actions[bot]` and that cannot
be changed from a Claude Code session.
