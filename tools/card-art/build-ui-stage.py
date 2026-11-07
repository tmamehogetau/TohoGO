#!/usr/bin/env python3
"""ステージ固有の背景と紋章を作るマニフェスト（配色をステージごとに変える）。

- bg_<id>: 各ステージの背景（明るめ）
- emblem_<id>: 各ステージの紋章（配色を分けて視認性を上げる）
使い方: python tools/card-art/build-ui-stage.py [copies]
"""
import json
import os
import sys

COPIES = int(sys.argv[1]) if len(sys.argv) > 1 else 2
BASE_SEED = 9400

WF = r"C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\moss_sft_4step_t2i.api.json"
OUTDIR = r"C:\Users\kou-1\Projects\touhou-draft\.tmp\ui-stage\raw"
DST = r"tools/card-art/runs-ui-stage.json"

NEG = (
    "lowres, text, letters, watermark, signature, logo, worst quality, jpeg artifacts, "
    "photorealistic, 3d render, cluttered, high contrast, blown highlights, too dark, underexposed"
)

C = {
    "bg_scarlet": (
        "masterpiece, best quality, scenery, no humans, scarlet devil mansion, gothic mansion, "
        "red moon, night sky, bats, rose garden, crimson mist, glowing windows, "
        "dark red and black palette, painterly, wide shot, cinematic lighting, clear silhouette",
        9401, 1216, 832),
    "bg_spring": (
        "masterpiece, best quality, scenery, no humans, japanese mansion in the netherworld, "
        "cherry blossom trees, falling petals, stone stairs, torii gate, "
        "pale pink and lavender sky, soft light, painterly, wide shot, luminous",
        9402, 1216, 832),
    "bg_eternal": (
        "masterpiece, best quality, scenery, no humans, moon palace, bamboo forest, full moon, "
        "night sky, mist, paper lanterns, silver blue palette, painterly, wide shot, serene",
        9403, 1216, 832),
    "bg_mountain": (
        "masterpiece, best quality, scenery, no humans, mountain shrine, torii gate, lake, "
        "autumn leaves, stone steps, sacred pillars, green and teal palette, sunlight, "
        "painterly, wide shot, fresh atmosphere",
        9404, 1216, 832),
    "emblem_scarlet": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold line art on deep crimson background, symmetrical, flat design, clean lines, centered, "
        "mansion silhouette, bat wings, clock face",
        9405, 832, 832),
    "emblem_spring": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "pink and white line art on deep plum background, symmetrical, flat design, clean lines, centered, "
        "cherry blossom branch, torii gate, petals",
        9406, 832, 832),
    "emblem_eternal": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "silver and pale blue line art on deep indigo background, symmetrical, flat design, clean lines, centered, "
        "full moon, bamboo leaves, rabbit silhouette",
        9407, 832, 832),
    "emblem_mountain": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold and green line art on deep forest green background, symmetrical, flat design, clean lines, centered, "
        "torii gate, mountain peak, snake and frog motifs",
        9408, 832, 832),
}

runs = []
for key, (prompt, seed, w, h) in C.items():
    for i in range(COPIES):
        runs.append({"name": f"{key}_{i + 1}", "seed": seed * 10 + i, "prompt": prompt, "width": w, "height": h})

manifest = {
    "outdir": OUTDIR,
    "workflow": WF,
    "width": 832,
    "height": 832,
    "timeout_sec": 300,
    "negative": NEG,
    "runs": runs,
}
os.makedirs(os.path.dirname(DST), exist_ok=True)
with open(DST, "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(C)} components x {COPIES} = {len(runs)} runs -> {DST}")
