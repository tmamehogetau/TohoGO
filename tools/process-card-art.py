#!/usr/bin/env python3
"""生成したカード原画（.tmp/card-art/raw/*.png）をカード用 WebP に変換する。

- 2:3 にセンタークロップ → 512x768 → WebP q84
- 出力: assets/cards/<key>.webp
使い方: python tools/process-card-art.py [src_dir] [dst_dir]
"""
import os
import sys
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else ".tmp/card-art/raw"
dst = sys.argv[2] if len(sys.argv) > 2 else "assets/cards"
os.makedirs(dst, exist_ok=True)

files = sorted(f for f in os.listdir(src) if f.lower().endswith(".png"))
if not files:
    print(f"no PNG in {src}")
    sys.exit(1)

total = 0
for f in files:
    key = os.path.splitext(f)[0]
    im = Image.open(os.path.join(src, f)).convert("RGB")
    w, h = im.size
    ratio = 2 / 3
    if w / h > ratio:
        nw = int(h * ratio)
        off = (w - nw) // 2
        im = im.crop((off, 0, off + nw, h))
    else:
        nh = int(w / ratio)
        off = (h - nh) // 2
        im = im.crop((0, off, w, off + nh))
    im = im.resize((512, 768), Image.LANCZOS)
    out = os.path.join(dst, key + ".webp")
    im.save(out, "WEBP", quality=84, method=6)
    kb = os.path.getsize(out) // 1024
    total += kb
    print(f"{key}: {kb}KB")

print(f"done: {len(files)} cards, {total}KB total -> {dst}")
