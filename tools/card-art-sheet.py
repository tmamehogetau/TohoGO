#!/usr/bin/env python3
"""カード原画のコンタクトシートを作る（確認用）。

使い方: python tools/card-art-sheet.py <src_dir> <out_path> [cols] [thumb_w]
- src_dir 内の png/webp を名前順に並べ、ファイル名ラベル付きで 1 枚にまとめる
- 出力は PNG（一覧確認用。カード本体には使わない）
"""
import os
import sys
from PIL import Image, ImageDraw

src = sys.argv[1] if len(sys.argv) > 1 else ".tmp/card-art-moss/raw"
out = sys.argv[2] if len(sys.argv) > 2 else ".tmp/card-art-moss/sheet.png"
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6
tw = int(sys.argv[4]) if len(sys.argv) > 4 else 220

files = sorted(
    f for f in os.listdir(src)
    if f.lower().endswith((".png", ".webp", ".jpg", ".jpeg"))
)
if not files:
    print(f"no images in {src}")
    sys.exit(1)

th = int(tw * 3 / 2)  # 2:3
pad = 8
label_h = 18
rows = (len(files) + cols - 1) // cols
W = cols * (tw + pad) + pad
H = rows * (th + label_h + pad) + pad

sheet = Image.new("RGB", (W, H), (18, 16, 22))
draw = ImageDraw.Draw(sheet)

for i, f in enumerate(files):
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
    im = im.resize((tw, th), Image.LANCZOS)
    x = pad + (i % cols) * (tw + pad)
    y = pad + (i // cols) * (th + label_h + pad)
    sheet.paste(im, (x, y))
    draw.text((x + 2, y + th + 3), os.path.splitext(f)[0], fill=(230, 220, 210))

os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
sheet.save(out, "PNG")
print(f"{len(files)} images -> {out} ({W}x{H})")
