#!/usr/bin/env python3
"""Generate Android launcher icons from the app artwork (icon-clean-1.png).

For every density bucket it writes
  res/mipmap-<bucket>/ic_launcher.png          legacy rounded-square icon
  res/mipmap-<bucket>/ic_launcher_round.png    legacy round icon
  res/drawable-<bucket>/ic_launcher_foreground.png
                                               adaptive-icon foreground (108dp safe zone)
The adaptive icon itself lives in res/mipmap-anydpi-v26 and uses the colour
resource `ic_launcher_background` (#040e09).

Run: python3 tools/make-launcher-icons.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'icon-clean-1.png')
OUT = os.path.join(ROOT, 'assets', 'icon-512.png')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

BUCKETS = {
    'mdpi': (48, 108),
    'hdpi': (72, 162),
    'xhdpi': (96, 216),
    'xxhdpi': (144, 324),
    'xxxhdpi': (192, 432),
}
MARGIN = 0.10
CORNER = 0.225
BACKGROUND = (4, 14, 9, 255)


def symbol_square(size, bg_fill=True):
    """Crop the artwork to its symbol and return a square `size`px image."""
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    left, top, right, bottom = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = im.getpixel((x, y))
            if g > 70 and g > r + 20:
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
    if right <= left or bottom <= top:
        left, top, right, bottom = 0, 0, w, h
    cx, cy = (left + right) / 2, (top + bottom) / 2
    side = max(right - left, bottom - top) * (1 + 2 * MARGIN)
    box = (int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2))
    return im.crop(box).resize((size, size), Image.LANCZOS).convert('RGBA')


def rounded(im, radius_share):
    w, h = im.size
    mask = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1],
                                           int(w * 4 * radius_share), fill=255)
    out = im.copy()
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    return out


def circle(im):
    w, h = im.size
    mask = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, w * 4 - 1, h * 4 - 1], fill=255)
    out = im.copy()
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    return out


def main():
    if not os.path.exists(OUT):
        symbol_square(512).save(OUT, optimize=True)
        print('wrote', OUT)

    base = symbol_square(512)
    for bucket, (legacy, fg) in BUCKETS.items():
        mip = os.path.join(RES, 'mipmap-%s' % bucket)
        drw = os.path.join(RES, 'drawable-%s' % bucket)
        os.makedirs(mip, exist_ok=True)
        os.makedirs(drw, exist_ok=True)

        big = symbol_square(legacy * 4)
        rounded(big, CORNER).resize((legacy, legacy), Image.LANCZOS).save(
            os.path.join(mip, 'ic_launcher.png'), optimize=True)
        circle(big).resize((legacy, legacy), Image.LANCZOS).save(
            os.path.join(mip, 'ic_launcher_round.png'), optimize=True)

        # adaptive foreground: symbol inside the 66dp safe zone of a 108dp canvas
        canvas = Image.new('RGBA', (fg, fg), (0, 0, 0, 0))
        inner = int(fg * 0.60)
        sym = base.resize((inner, inner), Image.LANCZOS)
        off = (fg - inner) // 2
        canvas.alpha_composite(sym, (off, off))
        canvas.save(os.path.join(drw, 'ic_launcher_foreground.png'), optimize=True)
        print('bucket', bucket, 'ok')


if __name__ == '__main__':
    main()
