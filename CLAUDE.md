# Working agreements

## Attribution

Every commit, and every pull request body, credits **both** accounts. Claude
wrote the code; the work is the repository owner's. Trailers, in this order:

```
Co-Authored-By: Amoguslittleahhh <198297163+Amoguslittleahhh@users.noreply.github.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the session URL>
```

The GitHub `users.noreply` address is used deliberately rather than the owner's
real one. It links the commit to the account exactly the same way, but git
history on a public repository is permanent and readable by anyone, and a
personal address written into it cannot be taken back out without rewriting
every commit after it. It also avoids GitHub rejecting the push outright
(`GH007`) if "Keep my email addresses private" is ever switched on.

Releases already record the account that triggered them, so they need nothing
extra; the release itself is published by `github-actions[bot]` and that cannot
be changed from a Claude Code session.
