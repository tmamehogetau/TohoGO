#!/usr/bin/env python3
"""UI 用の画像（背景・ステージ紋章）のマニフェストを作る。

- ui_bg: ゲーム画面の背景（暗めの幻想郷の風景）
- stage_*: ステージ選択に使う円形の紋章（文字なし）
使い方: python tools/card-art/build-ui.py [copies]
"""
import json
import os
import sys

COPIES = int(sys.argv[1]) if len(sys.argv) > 1 else 2
BASE_SEED = 9300

WF = r"C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\moss_sft_4step_t2i.api.json"
OUTDIR = r"C:\Users\kou-1\Projects\touhou-draft\.tmp\ui-art\raw"
DST = r"tools/card-art/runs-ui.json"

NEG = (
    "lowres, text, letters, watermark, signature, logo, worst quality, jpeg artifacts, "
    "photorealistic, 3d render, cluttered, busy, high contrast, blown highlights"
)

C = {
    "ui_bg": (
        "masterpiece, best quality, scenery, no humans, gensokyo, japanese shrine on a mountain, "
        "torii gate, stone steps, autumn leaves, night sky, full moon, stars, thin mist, "
        "distant mountains, dark muted color palette, low saturation, painterly, wide shot, "
        "cinematic soft light, calm atmosphere, negative space at the top",
        9301, 1216, 832),
    "stage_red": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold line art on deep purple background, symmetrical, flat design, clean lines, centered, "
        "western mansion silhouette, bat wings, clock face, small red accent",
        9302, 832, 832),
    "stage_hakugyoku": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold line art on deep purple background, symmetrical, flat design, clean lines, centered, "
        "cherry blossom branch, torii gate, drifting petals, small pink accent",
        9303, 832, 832),
    "stage_eientei": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold line art on deep purple background, symmetrical, flat design, clean lines, centered, "
        "full moon, bamboo leaves, rabbit silhouette, small silver accent",
        9304, 832, 832),
    "stage_moriya": (
        "masterpiece, best quality, no humans, circular emblem, japanese kamon crest, "
        "gold line art on deep purple background, symmetrical, flat design, clean lines, centered, "
        "torii gate, mountain peak, coiled snake and frog motifs, small green accent",
        9305, 832, 832),
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
