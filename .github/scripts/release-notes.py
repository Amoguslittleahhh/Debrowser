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
"""

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


def main():
    version = sys.argv[1].lstrip('v') if len(sys.argv) > 1 else None
    body = section(open(CHANGELOG, encoding='utf-8').read(), version)
    if not body.strip():
        # An empty body publishes a release that says nothing, which is a
        # packaging mistake worth failing on rather than shipping.
        sys.exit(f'{CHANGELOG}: notes for {version or "the newest version"} are empty')
    sys.stdout.write(body + FOOTER)


if __name__ == '__main__':
    main()
