#!/usr/bin/env python3
"""Bring one file's size and checksum in an electron-updater manifest up to date.

    update-manifest.py latest-linux.yml Debrowser-2.3.0-linux-x86_64.rpm

Signing an .rpm rewrites it after electron-builder has listed it in
latest-linux.yml, which would leave a stale sha512 and size there. This
rewrites that file's entry - and the top-level `path`/`sha512` when they name
it - line by line, so everything else stays exactly as electron-builder wrote
it. A manifest that does not mention the file is left alone.
"""

import base64
import hashlib
import os
import re
import sys


def sha512(path):
    h = hashlib.sha512()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode()


def update(manifest, name, digest, size):
    lines = manifest.split('\n')
    out = []
    in_entry = False
    top_level_is_it = any(re.fullmatch(rf'path: {re.escape(name)}', l) for l in lines)
    for line in lines:
        if re.match(r'  - url: ', line):
            in_entry = line == f'  - url: {name}'
        elif not line.startswith('    '):
            in_entry = False
        if in_entry and re.match(r'    sha512: ', line):
            line = f'    sha512: {digest}'
        elif in_entry and re.match(r'    size: ', line):
            line = f'    size: {size}'
        elif top_level_is_it and re.match(r'sha512: ', line):
            line = f'sha512: {digest}'
        out.append(line)
    return '\n'.join(out)


def main():
    manifest_path, file_path = sys.argv[1], sys.argv[2]
    if not os.path.exists(manifest_path):
        return
    name = os.path.basename(file_path)
    with open(manifest_path) as f:
        manifest = f.read()
    updated = update(manifest, name, sha512(file_path), os.path.getsize(file_path))
    with open(manifest_path, 'w') as f:
        f.write(updated)
    print(f'{manifest_path}: {name} updated' if updated != manifest else f'{manifest_path}: {name} unchanged')


if __name__ == '__main__':
    main()
