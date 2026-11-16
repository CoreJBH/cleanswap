#!/usr/bin/env python3
"""Turn the supplied app icon into crisp favicon / touch-icon PNGs.

Crops to the symbol (the source has a wide dark margin), squares it, rounds the
corners and writes assets/icon-64.png + assets/icon-180.png. build.py inlines
both as base64 data URIs.
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'icon-clean-1.png')
OUT = os.path.join(ROOT, 'assets')
MARGIN = 0.10          # share of the final square kept free around the symbol
CORNER = 0.225         # corner radius as a share of the side


def symbol_bbox(im):
    """Bounding box of pixels clearly brighter than the dark backdrop."""
    px = im.convert('RGB')
    w, h = px.size
    left, top, right, bottom = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px.getpixel((x, y))
            if g > 70 and g > r + 20:          # mint-ish
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
    if right <= left or bottom <= top:
        return (0, 0, w, h)
    return (left, top, right + 1, bottom + 1)


def rounded(im, radius_share=CORNER):
    w, h = im.size
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], int(w * radius_share), fill=255)
    out = im.convert('RGBA')
    out.putalpha(mask)
    return out


def build(size):
    src = Image.open(SRC)
    x0, y0, x1, y1 = symbol_bbox(src)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) * (1 + 2 * MARGIN)
    half = side / 2
    box = (int(cx - half), int(cy - half), int(cx + half), int(cy + half))
    crop = src.crop(box).convert('RGB').resize((size, size), Image.LANCZOS)
    return rounded(crop)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (64, 180):
        img = build(size)
        path = os.path.join(OUT, 'icon-%d.png' % size)
        img.save(path, optimize=True)
        kb = os.path.getsize(path) / 1024
        print('wrote %s (%.1f KB)' % (path, kb))
        if kb > 14:
            q = img.quantize(colors=64, method=Image.FASTOCTREE)
            q.save(path, optimize=True)
            print('  requantised to %.1f KB' % (os.path.getsize(path) / 1024))


if __name__ == '__main__':
    main()
