#!/usr/bin/env python3
"""候補（<key>_1..N）をキャラごと横並びにした判定シートを作る。

使い方: python tools/card-art-candidates-sheet.py <src_dir> <out_dir> [chars_per_sheet] [thumb_w]
- 1シート = chars_per_sheet キャラ × 候補数
- ファイル名は <key>_<n>.png 前提
"""
import os
import re
import sys
from PIL import Image, ImageDraw

src = sys.argv[1] if len(sys.argv) > 1 else ".tmp/card-art-cand/raw"
out_dir = sys.argv[2] if len(sys.argv) > 2 else ".tmp/card-art-cand/sheets"
per = int(sys.argv[3]) if len(sys.argv) > 3 else 5
tw = int(sys.argv[4]) if len(sys.argv) > 4 else 210

os.makedirs(out_dir, exist_ok=True)

groups = {}
for f in sorted(os.listdir(src)):
    m = re.match(r"^(.+)_(\d+)\.(png|webp)$", f, re.I)
    if not m:
        continue
    groups.setdefault(m.group(1), []).append((int(m.group(2)), f))

keys = sorted(groups)
cols_max = max(len(v) for v in groups.values())
th = int(tw * 3 / 2)
pad, label_h = 8, 16

sheets = []
for start in range(0, len(keys), per):
    chunk = keys[start:start + per]
    rows = len(chunk)
    W = cols_max * (tw + pad) + 100 + pad
    H = rows * (th + label_h + pad) + pad
    sheet = Image.new("RGB", (W, H), (18, 16, 22))
    d = ImageDraw.Draw(sheet)
    for r, key in enumerate(chunk):
        y = pad + r * (th + label_h + pad)
        d.text((6, y + th // 2), key, fill=(240, 230, 210))
        for c, (idx, fname) in enumerate(sorted(groups[key])):
            x = 100 + c * (tw + pad)
            im = Image.open(os.path.join(src, fname)).convert("RGB")
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
            sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
            d.text((x + 2, y + th + 1), f"{key}_{idx}", fill=(220, 210, 200))
    path = os.path.join(out_dir, f"sheet-{start // per + 1}.png")
    sheet.save(path, "PNG")
    sheets.append(path)
    print(f"{path} {W}x{H} ({len(chunk)} chars)")
print(f"total {len(keys)} chars, {sum(len(v) for v in groups.values())} images")
