#!/usr/bin/env python3
"""Builds lib/glyphs.json: the letters the map camera can write (room names
and the status line), as small pictures. Run once; the result is shipped.

Shapes come from Liberation Sans Bold (SIL Open Font License 1.1).
Usage: python3 tools/make-glyphs.py /path/to/LiberationSans-Bold.ttf
"""
import base64, json, sys, zlib
from PIL import Image, ImageDraw, ImageFont

SIZE = 32
ranges = [(0x20, 0x7E), (0xA0, 0xFF), (0x100, 0x17F), (0x386, 0x3CE), (0x400, 0x45F), (0x490, 0x491),
          (0x5D0, 0x5EA), (0x5BE, 0x5BE), (0x5F3, 0x5F4), (0x2013, 0x2014), (0x2018, 0x201A), (0x201C, 0x201E),
          (0x2022, 0x2022), (0x2026, 0x2026), (0x20AC, 0x20AC)]
font = ImageFont.truetype(sys.argv[1], SIZE)
ascent, descent = font.getmetrics()
cmap = None
try:
    from fontTools.ttLib import TTFont
    cmap = TTFont(sys.argv[1]).getBestCmap()
except Exception:
    pass

glyphs, x, y, row, W = [], 1, 1, 0, 512
cells = []
for lo, hi in ranges:
    for cp in range(lo, hi + 1):
        if cmap is not None and cp not in cmap:
            continue
        ch = chr(cp)
        adv = font.getlength(ch)
        box = font.getbbox(ch)  # relative to the pen position, y from the top of the line
        if not box or box[2] <= box[0] or box[3] <= box[1]:
            glyphs.append([cp, 0, 0, 0, 0, 0, 0, round(adv * 16)])
            continue
        w, h = box[2] - box[0], box[3] - box[1]
        if x + w + 1 > W:
            x, y, row = 1, y + row + 1, 0
        cells.append((ch, x - box[0], y - box[1]))
        glyphs.append([cp, x, y, w, h, box[0], box[1], round(adv * 16)])
        x += w + 1
        row = max(row, h)
H = y + row + 1
atlas = Image.new("L", (W, H), 0)
draw = ImageDraw.Draw(atlas)
for ch, px, py in cells:
    draw.text((px, py), ch, font=font, fill=255)
out = {
    "font": "Liberation Sans Bold (SIL Open Font License 1.1)",
    "size": SIZE, "ascent": ascent, "descent": descent, "width": W, "height": H,
    "glyphs": ";".join(",".join(str(v) for v in g) for g in glyphs),
    "alpha": base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(),
}
json.dump(out, open("lib/glyphs.json", "w"), separators=(",", ":"))
atlas.save("/tmp/atlas.png")
print(len(glyphs), "glyphs", W, "x", H)
