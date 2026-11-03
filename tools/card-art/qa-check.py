#!/usr/bin/env python3
"""カード絵の整合チェック（形式・サイズ・採用セットとの一致）。

- assets/cards/<key>.webp が 512x768 の WebP として読めるか
- data.js のカードキーを網羅しているか
- 採用セット（assets/cards-final）とバイト一致しているか

髪色などキャラ追従の判定は画像からの自動判定が不安定（帽子・背景が支配的）なので、
tools/card-art/characters.md の5点基準を目視で当てる運用にしている。

使い方: python tools/card-art/qa-check.py [dir] [--ref assets/cards-final]
"""
import hashlib
import os
import re
import sys
from PIL import Image

DIR = "assets/cards"
REF = "assets/cards-final"
args = sys.argv[1:]
if args:
    DIR = args[0]
if "--ref" in args:
    REF = args[args.index("--ref") + 1]

# data.js のカードキー
keys = set()
with open("data.js", encoding="utf-8") as f:
    for m in re.finditer(r"key:\s*'([a-z_]+)'", f.read()):
        keys.add(m.group(1))

files = sorted(f for f in os.listdir(DIR) if f.endswith(".webp"))
have = {f[:-5] for f in files}
problems = []
total = 0

for f in files:
    p = os.path.join(DIR, f)
    try:
        im = Image.open(p)
        im.load()
    except Exception as e:  # noqa: BLE001
        problems.append(f"{f}: 読み込み失敗 {e}")
        continue
    if im.size != (512, 768):
        problems.append(f"{f}: サイズ {im.size}")
    total += os.path.getsize(p)

missing = sorted(keys - have)
extra = sorted(have - keys)
if missing:
    problems.append("未配置: " + ", ".join(missing))
if extra:
    problems.append("余剰: " + ", ".join(extra))

ref_diff = []
if os.path.isdir(REF):
    for f in files:
        a = os.path.join(DIR, f)
        b = os.path.join(REF, f)
        if not os.path.exists(b):
            ref_diff.append(f"{f}: 採用セットに無い")
            continue
        ha = hashlib.sha256(open(a, "rb").read()).hexdigest()
        hb = hashlib.sha256(open(b, "rb").read()).hexdigest()
        if ha != hb:
            ref_diff.append(f"{f}: 採用セットと不一致")

print(f"cards={len(files)} keys={len(keys)} total={total // 1024}KB dir={DIR}")
if problems:
    print("PROBLEMS:")
    for p in problems:
        print("  !! " + p)
else:
    print("形式・キー網羅: OK")
if os.path.isdir(REF):
    if ref_diff:
        print(f"採用セット({REF})との不一致:")
        for d in ref_diff:
            print("  !! " + d)
    else:
        print(f"採用セット({REF})とバイト一致: OK")
if problems or ref_diff:
    sys.exit(1)
