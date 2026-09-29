#!/usr/bin/env python3
"""Print one version's release notes, exactly as they should appear on its
GitHub release page.

A release page describes the release it is on and nothing else. Publishing the
whole changelog means every download page repeats the notes for versions the
reader already has, burying the one thing they came for.

Lives in a file rather than inline in the workflow because two workflows need
it - the one that publishes a release and the one that republishes notes for a
release that already exists - and two copies of this would drift.

Usage:  release-notes.py [version]     # e.g. 1.1.0; omit for the newest

Around the version's own notes, when the workflow provides them (environment):

  header   one line, as Safari and Brave print theirs - the version, the
           commit it was built from, the date, and the Chromium it runs on
           (COMMIT, CHROMIUM) - so "which engine is this" is never a question
  footer   where it came from: the build that made the files (GITHUB_RUN_URL),
           what changed since the last release (COMPARE_URL), and the SHA-256
           of every file attached (CHECKSUMS, a `sha256sum` listing) - then
           the credit line

Each part is left out when its value is not there, so the script run by hand
prints just the notes and the credit, as it always did.
"""

import datetime
import os
import re
import sys

CHANGELOG = 'CHANGELOG.md'

# Credit both, side by side. A release's `author` is whoever's token created it,
# which is always github-actions[bot] because the workflow publishes with the
# built-in GITHUB_TOKEN; that field cannot be set to a person, so the credit
# goes in the body, which is the part anyone actually reads.
FOOTER = ('\n\n---\n\nReleased by **Amoguslittleahhh** (<amogus36311@gmail.com>) '
          'and **`github-actions[bot]`**.\n')


def section(text, version=None):
    """The body of one `## ` section, without its heading.

    Matched on a prefix, because a heading may carry a title after the version
    ("## 1.0.0 - first stable release") and an exact match would miss it.
    """
    if version:
        head = re.search(r'^## ' + re.escape(version) + r'(?:\s.*)?$', text, re.M)
        if not head:
            sys.exit(f'{CHANGELOG}: no section for version {version}')
    else:
        head = re.search(r'^## .*$', text, re.M)
        if not head:
            sys.exit(f'{CHANGELOG}: no version sections at all')

    rest = text[head.end():]
    nxt = re.search(r'^## ', rest, re.M)
    return (rest[:nxt.start()] if nxt else rest).strip('\n')


def header(version):
    """`2.0.0 (a1b2c3d) · 27 October 2026 · Chromium 152.0.7977.65`, from what is known."""
    parts = []
    commit = os.environ.get('COMMIT', '')[:7]
    if version:
        parts.append(f'**{version}**' + (f' ({commit})' if commit else ''))
    parts.append(datetime.date.today().strftime('%-d %B %Y'))
    chromium = os.environ.get('CHROMIUM', '').strip()
    if chromium:
        parts.append(f'Chromium {chromium}')
    return ' · '.join(parts) + '\n\n'


def provenance():
    """The build, the comparison, and the checksums, for whoever wants to verify."""
    lines = []
    run = os.environ.get('GITHUB_RUN_URL', '').strip()
    compare = os.environ.get('COMPARE_URL', '').strip()
    if run:
        lines.append(f'Built by [this workflow run]({run}) from the commit above.')
    if compare:
        lines.append(f'[Everything that changed since the last release]({compare}).')
    sums = os.environ.get('CHECKSUMS', '').strip()
    if sums and os.path.exists(sums):
        rows = []
        for line in open(sums, encoding='utf-8'):
            m = re.match(r'^([0-9a-f]{64})\s+\*?(?:.*/)?(\S.*)$', line.strip())
            if m:
                rows.append(f'| `{m.group(2)}` | `{m.group(1)}` |')
        if rows:
            lines.append('<details><summary>SHA-256 checksums</summary>\n\n| File | SHA-256 |\n|---|---|\n' +
                         '\n'.join(rows) + '\n\n</details>')
    return ('\n\n---\n\n' + '\n\n'.join(lines)) if lines else ''


def main():
    version = sys.argv[1].lstrip('v') if len(sys.argv) > 1 else None
    body = section(open(CHANGELOG, encoding='utf-8').read(), version)
    if not body.strip():
        # An empty body publishes a release that says nothing, which is a
        # packaging mistake worth failing on rather than shipping.
        sys.exit(f'{CHANGELOG}: notes for {version or "the newest version"} are empty')
    top = header(version) if os.environ.get('COMMIT') or os.environ.get('CHROMIUM') else ''
    sys.stdout.write(top + body + provenance() + FOOTER)


if __name__ == '__main__':
    main()
