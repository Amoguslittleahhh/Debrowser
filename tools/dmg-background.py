#!/usr/bin/env python3
"""
The macOS disk image's background: build/dmg-background.png and its @2x.

Drawn from the Ledger palette (src/renderer/theme.css, light), so the first
window of Debrowser a Mac user sees is in the browser's own style rather than
Finder's blank white. The layout matches `dmg.contents` in
electron-builder.yml: the app at (170, 190), Applications at (430, 190), in a
600 x 400 window. Light, because Finder draws the icons' labels in black on a
light-appearance Mac, and a dark background would hide them.

    python3 tools/dmg-background.py [path/to/Carlito-Bold.ttf]

Needs Pillow. The font is Carlito, metric-compatible with Calibri, which is the
browser's own UI face on Windows; any bold sans will do.
"""

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BG = (247, 248, 245)        # --bg-raised
WELL = (228, 232, 225)      # --bg
BORDER = (205, 211, 203)    # --border
TEXT = (28, 35, 32)         # --text
DIM = (95, 106, 100)        # --text-dim
ACCENT = (47, 133, 123)     # the default accent

APP = (170, 190)
APPS = (430, 190)


def font(size, wanted):
    for path in [wanted] + glob.glob('/usr/share/fonts/**/Carlito-Bold.ttf', recursive=True) + \
            glob.glob(os.path.expanduser('~/.local/share/fonts/Carlito-Bold.ttf')):
        if path and os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw(scale, font_path):
    s = lambda v: round(v * scale)
    im = Image.new('RGB', (s(600), s(400)), BG)
    d = ImageDraw.Draw(im)

    # A well under each icon, so the two read as "from here, to there".
    for cx, cy in (APP, APPS):
        d.rounded_rectangle((s(cx - 78), s(cy - 74), s(cx + 78), s(cy + 82)), radius=s(18),
                            fill=WELL, outline=BORDER, width=max(1, s(1)))

    # The arrow between them, in the accent: the only colour on the page.
    y = s(APP[1] - 6)
    x0, x1 = s(APP[0] + 96), s(APPS[0] - 96)
    d.line((x0, y, x1 - s(10), y), fill=ACCENT, width=s(4))
    d.polygon([(x1, y), (x1 - s(16), y - s(10)), (x1 - s(16), y + s(10))], fill=ACCENT)

    title = font(s(22), font_path)
    body = font(s(14), font_path)
    d.text((s(300), s(52)), 'Install Debrowser', font=title, fill=TEXT, anchor='mm')
    d.text((s(300), s(338)), 'Drag Debrowser into Applications, then open it from there.',
           font=body, fill=DIM, anchor='mm')
    return im


if __name__ == '__main__':
    wanted = sys.argv[1] if len(sys.argv) > 1 else ''
    out = os.path.join(ROOT, 'build')
    draw(1, wanted).save(os.path.join(out, 'dmg-background.png'))
    draw(2, wanted).save(os.path.join(out, 'dmg-background@2x.png'))
    print('wrote build/dmg-background.png and build/dmg-background@2x.png')
