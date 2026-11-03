#!/usr/bin/env python3
"""採用案を assets/cards-final/ へ WebP 化して集める。

- PICK: key -> 生成ファイル名（.tmp/card-art-cand*/raw/ 配下）
- 2:3 センタークロップ -> 512x768 -> WebP q84（カード表示用）
使い方: python tools/card-art/assemble-final.py
"""
import os
import sys
from PIL import Image

SRC_DIRS = [".tmp/card-art-cand/raw", ".tmp/card-art-cand2/raw", ".tmp/card-art-cand3/raw", ".tmp/card-art-cand4/raw", ".tmp/card-art-fix/raw", ".tmp/card-art-fix2/raw", ".tmp/card-art-fix3/raw", ".tmp/card-art-fix4/raw", ".tmp/card-art-fix5/raw", ".tmp/card-art-fix6/raw", ".tmp/card-art-fix7/raw"]
DST = "assets/cards-final"

PICK = {
    "k_remi": "k_remi_3",
    "k_fran": "k_fran_1",
    "k_meirin": "k_meirin_1",
    "k_sakuya": "k_sakuya_2",
    "k_patch": "k_patch_3",
    "k_rumia": "k_rumia_1",
    "k_daiyousei": "k_daiyousei_3",
    "k_maid": "k_maid_1",
    "k_kozue": "k_kozue_1",
    "k_cirno": "k_cirno_2",
    "s_yukari": "s_yukari_2",
    "s_ran": "s_ran_1",
    "s_chen": "s_chen_3",
    "s_spring": "s_spring_2",
    "s_yuyuko": "s_yuyuko_2",
    "s_youmu": "s_youmu_2",
    "s_alice": "s_alice_3",
    "s_prism": "s_prism_1",
    "s_letty": "s_letty_1",
    "s_lily": "s_lily_2",
    "y_kaguya": "y_kaguya_2",
    "y_eirin": "y_eirin_1",
    "y_reisen": "y_reisen_1",
    "y_tewi": "y_tewi_3",
    "y_mystia": "y_mystia_1",
    "y_keine": "y_keine_2",
    "y_riggle": "y_riggle_1",
    "y_rabbit": "y_rabbit_3",
    "y_reimu": "y_reimu_1",
    "y_marisa": "y_marisa_1",
    "y_moko": "y_moko_1",
}


def find(name):
    for d in reversed(SRC_DIRS):  # 後から生成した再試行を優先
        p = os.path.join(d, name + ".png")
        if os.path.exists(p):
            return p
    return None


os.makedirs(DST, exist_ok=True)
missing, total = [], 0
for key, name in PICK.items():
    src = find(name)
    if not src:
        missing.append(f"{key} ({name})")
        continue
    im = Image.open(src).convert("RGB")
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
    out = os.path.join(DST, key + ".webp")
    im.save(out, "WEBP", quality=84, method=6)
    kb = os.path.getsize(out) // 1024
    total += kb
    print(f"{key} <- {name} ({kb}KB)")

print(f"done: {len(PICK) - len(missing)} cards, {total}KB -> {DST}")
if missing:
    print("MISSING: " + ", ".join(missing))
    sys.exit(1)
