#!/usr/bin/env python3
"""Open a .intunewin the way the Intune Management Extension would, and fail
loudly if it does not come apart.

Packaging can report success and produce a file that no device can install, and
the failure is quiet: the bundle is a zip whose payload is encrypted, so nothing
short of decrypting it tells you whether the installer is in there. A build step
that checks the file exists - or even that it is a plausible size - would have
published a correctly named, empty bundle.

So this does what the device does: verify the HMAC over the payload, decrypt it
with the keys in Detection.xml, and open the inner zip to confirm the setup file
named by the metadata is actually inside it.

Checked against a bundle produced by Microsoft's own Win32 Content Prep Tool
before being trusted to judge one, which is the only reason its PASS means
anything.

Usage:  verify-intunewin.py <bundle.intunewin> [...]
"""

import base64
import hashlib
import hmac
import io
import os
import re
import subprocess
import sys
import tempfile
import zipfile

CONTENTS = 'IntuneWinPackage/Contents/IntunePackage.intunewin'
METADATA = 'IntuneWinPackage/Metadata/Detection.xml'

# The payload is prefixed with the MAC and the IV, then AES-256-CBC ciphertext.
MAC_LEN = 32
IV_LEN = 16


class Report:
    """Collects checks so every failure is reported, not just the first."""

    def __init__(self):
        self.failed = False

    def check(self, ok, label, detail=''):
        if not ok:
            self.failed = True
        print(f'  {"OK  " if ok else "FAIL"}  {label}{"  " + detail if detail else ""}')
        return ok

    def note(self, label, detail=''):
        print(f'  ....  {label}{"  " + detail if detail else ""}')


def field(xml, tag):
    m = re.search(r'<%s>(.*?)</%s>' % (tag, tag), xml, re.S)
    return m.group(1).strip() if m else None


def decrypt(ciphertext, key, iv):
    """AES-256-CBC through openssl.

    Not a Python AES: the payload is ~100MB, and a pure-Python block cipher
    would take minutes. `-nopad` because the padding is checked here rather
    than trusted to openssl, so a malformed one is a named failure instead of
    an opaque error.
    """
    ct_path = pt_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(ciphertext)
            ct_path = f.name
        pt_path = ct_path + '.plain'
        r = subprocess.run(
            ['openssl', 'enc', '-d', '-aes-256-cbc', '-nopad',
             '-K', key.hex(), '-iv', iv.hex(), '-in', ct_path, '-out', pt_path],
            capture_output=True)
        if r.returncode != 0:
            return None, r.stderr.decode('utf-8', 'replace').strip()[:200]
        with open(pt_path, 'rb') as f:
            return f.read(), None
    finally:
        for p in (ct_path, pt_path):
            if p and os.path.exists(p):
                os.unlink(p)


def verify(path):
    print(f'=== {os.path.basename(path)} ===')
    r = Report()

    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as err:
        r.check(False, 'the bundle is a zip', str(err))
        return False

    names = z.namelist()
    for required in (CONTENTS, METADATA):
        r.check(required in names, f'contains {required}')
    if r.failed:
        return False

    xml = z.read(METADATA).decode('utf-8', 'replace')
    setup = field(xml, 'SetupFile')
    r.check(bool(setup), 'Detection.xml names a SetupFile', setup or '')

    try:
        enc_key = base64.b64decode(field(xml, 'EncryptionKey') or '')
        mac_key = base64.b64decode(field(xml, 'MacKey') or '')
        iv = base64.b64decode(field(xml, 'InitializationVector') or '')
        mac = base64.b64decode(field(xml, 'Mac') or '')
    except Exception as err:
        r.check(False, 'Detection.xml key material is base64', str(err))
        return False

    r.check(len(enc_key) == 32, 'EncryptionKey is 32 bytes (AES-256)', f'{len(enc_key)}')
    r.check(len(mac_key) == 32, 'MacKey is 32 bytes', f'{len(mac_key)}')
    r.check(len(iv) == IV_LEN, f'InitializationVector is {IV_LEN} bytes', f'{len(iv)}')
    if r.failed:
        return False

    blob = z.read(CONTENTS)
    r.check(len(blob) > MAC_LEN + IV_LEN,
            'the payload is larger than its own header',
            f'{len(blob)} bytes')
    if r.failed:
        return False

    stored_mac, blob_iv, ciphertext = blob[:MAC_LEN], blob[MAC_LEN:MAC_LEN + IV_LEN], blob[MAC_LEN + IV_LEN:]
    r.check(stored_mac == mac, 'the payload MAC matches Detection.xml')
    r.check(blob_iv == iv, 'the payload IV matches Detection.xml')

    calculated = hmac.new(mac_key, blob[MAC_LEN:], hashlib.sha256).digest()
    if not r.check(hmac.compare_digest(calculated, stored_mac),
                   'HMAC-SHA256 over IV+ciphertext'):
        return False

    if not r.check(len(ciphertext) % 16 == 0,
                   'the ciphertext is a whole number of AES blocks',
                   f'{len(ciphertext)} bytes'):
        return False

    plain, err = decrypt(ciphertext, enc_key, iv)
    if not r.check(plain is not None, 'the payload decrypts', err or ''):
        return False

    pad = plain[-1]
    if not r.check(1 <= pad <= 16 and all(b == pad for b in plain[-pad:]),
                   'PKCS7 padding is well formed'):
        return False
    plain = plain[:-pad]

    digest = field(xml, 'FileDigest')
    if digest:
        got = base64.b64encode(hashlib.sha256(plain).digest()).decode()
        r.check(got == digest, 'FileDigest matches the decrypted payload')

    size = field(xml, 'UnencryptedContentSize')
    if size and size.isdigit():
        r.check(int(size) == len(plain), 'UnencryptedContentSize is honest',
                f'says {size}, is {len(plain)}')

    try:
        inner = zipfile.ZipFile(io.BytesIO(plain))
        members = inner.namelist()
    except zipfile.BadZipFile as err:
        r.check(False, 'the decrypted payload is a zip', str(err))
        return False

    r.check(len(members) > 0, 'the inner zip has members', f'{len(members)}')
    for m in members[:10]:
        r.note(m, f'{inner.getinfo(m).file_size} bytes')

    # The whole point: the thing the install command will run has to be in there.
    r.check(any(m.split('/')[-1] == setup for m in members),
            f'the inner zip contains {setup}')

    return not r.failed


def main(argv):
    if not argv:
        print(__doc__.strip().splitlines()[-1])
        return 2
    results = [(p, verify(p)) for p in argv]
    print()
    for p, ok in results:
        print(f'{"PASS" if ok else "FAIL"}  {p}')
    return 0 if all(ok for _, ok in results) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
