#!/usr/bin/env python3
"""風神録（mountain）パックのカード絵マニフェストを作る。

- キャラごとの正史タグ（髪色・瞳色・衣装・小道具）を明示（tools/card-art/characters.md）
- 露出控えめ: ネガティブに露出系タグ、ポジティブに modest clothes / long skirt
- seeds: base + 0,1,2 の3案
使い方: python tools/card-art/build-mof.py [copies]
"""
import json
import os
import sys

COPIES = int(sys.argv[1]) if len(sys.argv) > 1 else 3
BASE_SEED = 9100

WF = r"C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\moss_sft_4step_t2i.api.json"
OUTDIR = r"C:\Users\kou-1\Projects\touhou-draft\.tmp\card-art-mof\raw"
DST = r"tools/card-art/runs-mof.json"

NEG = (
    "lowres, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, "
    "watermark, text, signature, worst quality, jpeg artifacts, "
    "static pose, stiff, expressionless, blank stare, front view, "
    "cleavage, panties, underwear, lingerie, navel, bare legs, thighs, short skirt, "
    "upskirt, revealing clothes, suggestive, spread legs, high kick, bare shoulders"
)

MOD = "modest clothes, fully clothed, long skirt, covered legs"

C = {
    "f_kanako": (
        f"masterpiece, best quality, 1girl, yasaka kanako, touhou, blue hair, long hair, poofy hair, "
        f"dark red eyes, red shirt, long white sleeves, round mirror on chest, black long skirt, "
        f"red flower print hem, large shimenawa, shide, {MOD}, raising one hand, commanding presence, "
        f"onbashira pillar behind, confident smile, from below, cowboy shot, shrine, mountain, clouds",
        9101),
    "f_suwako": (
        f"masterpiece, best quality, 1girl, moriya suwako, touhou, blonde hair, medium hair, grey eyes, "
        f"purplish blue dress, frog print, white large sleeves, white collar, "
        f"light brown wide-brimmed hat, frog eyes on hat, white kneehighs, {MOD}, crouching on the ground, "
        f"mischievous grin, frogs around her, cowboy shot, lake, sunlight, sparkles", 9102),
    "f_sanae": (
        f"masterpiece, best quality, 1girl, kochiya sanae, touhou, green hair, long hair, yellow eyes, "
        f"blue and white miko outfit, light blue polka dots, detached sleeves, "
        f"snake-shaped hair ornament, frog hair clip, gohei, {MOD}, invoking a miracle, wind, "
        f"determined smile, cowboy shot, shrine, blue sky, sparkles", 9103),
    "f_hina": (
        f"masterpiece, best quality, 1girl, kagiyama hina, touhou, aquamarine hair, medium hair, "
        f"aquamarine eyes, red frilly bows, red dress, white frills, large white kerchief, black boots, "
        f"{MOD}, spinning around, swirling purple curse aura, dizzy smile, dutch angle, cowboy shot, "
        f"forest, haze, dim light", 9104),
    "f_aya": (
        f"masterpiece, best quality, 1girl, shameimaru aya, touhou, black hair, semi-long hair, red eyes, "
        f"white blouse, black skirt, brown leaf print, black tokin, white feather puffs, hauchiwa fan, "
        f"camera, {MOD}, leaning forward to take a photo, smirk, from side, cowboy shot, "
        f"mountain, wind, sunlight", 9105),
    "f_nitori": (
        f"masterpiece, best quality, 1girl, kawashiro nitori, touhou, blue hair, blue eyes, "
        f"blue dress with many pockets, green hat, dark aquamarine backpack, golden key, "
        f"blue wellington boots, cattail, {MOD}, tinkering with a small gadget, shy smile, "
        f"from side, cowboy shot, river, water wheel, sunlight", 9106),
    "f_minoriko": (
        f"masterpiece, best quality, 1girl, aki minoriko, touhou, dark blonde hair, red eyes, "
        f"yellow blouse with poofy sleeves, red dress, black shoulder straps, red hat, "
        f"blue grape ornament, {MOD}, holding a sweet potato, cheerful smile, cowboy shot, "
        f"autumn field, rice ears, warm light", 9107),
    "f_shizuha": (
        f"masterpiece, best quality, 1girl, aki shizuha, touhou, short hair, gold hair, gold eyes, "
        f"long red dress, leaf pattern hem, white leaf ruffle, red autumn leaves in hair, "
        f"{MOD}, scattering maple leaves, gentle sad smile, cowboy shot, autumn forest, "
        f"falling leaves, orange light", 9108),
    "f_momiji": (
        f"masterpiece, best quality, 1girl, inubashiri momiji, touhou, white hair, short hair, red eyes, "
        f"wolf ears, red tokin, white long-sleeved shirt, large black skirt, red flame pattern, "
        f"scimitar sword, white round shield with red maple leaf, {MOD}, guarding stance, alert expression, "
        f"cowboy shot, waterfall, youkai mountain, daylight", 9109),
    "f_faith": (
        "masterpiece, best quality, scenery, no humans, moriya shrine, torii gate, stone steps, "
        "shimenawa rope, shide, ofuda talismans, offering box, autumn leaves, "
        "sunlight through trees, serene religious atmosphere, wide shot", 9110),
}

runs = []
for key, (prompt, seed) in C.items():
    for i in range(COPIES):
        runs.append({"name": f"{key}_{i + 1}", "seed": seed * 10 + i, "prompt": prompt})

manifest = {
    "outdir": OUTDIR,
    "workflow": WF,
    "width": 832,
    "height": 1216,
    "timeout_sec": 300,
    "negative": NEG,
    "runs": runs,
}
os.makedirs(os.path.dirname(DST), exist_ok=True)
with open(DST, "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(C)} chars x {COPIES} = {len(runs)} runs -> {DST}")
