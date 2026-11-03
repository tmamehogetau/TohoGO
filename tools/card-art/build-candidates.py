#!/usr/bin/env python3
"""候補生成用マニフェストを作る（各キャラ複数シード × 露出控えめ）。

- キャラごとの正史タグ（髪色・瞳色・衣装・小道具）を明示
- 露出控えめ: ネガティブに露出系タグ、ポジティブに modest clothes / long skirt
- seeds: base + 0,1,2 の3案
使い方: python tools/card-art/build-candidates.py [copies]
"""
import json
import os
import sys

COPIES = int(sys.argv[1]) if len(sys.argv) > 1 else 3
BASE_SEED = 7000

WF = r"C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\moss_sft_4step_t2i.api.json"
OUTDIR = r"C:\Users\kou-1\Projects\touhou-draft\.tmp\card-art-cand\raw"
DST = r"tools/card-art/runs-cand.json"

NEG = (
    "lowres, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, "
    "watermark, text, signature, worst quality, jpeg artifacts, "
    "static pose, stiff, expressionless, blank stare, front view, "
    "cleavage, panties, underwear, lingerie, navel, bare legs, thighs, short skirt, "
    "upskirt, revealing clothes, suggestive, spread legs, high kick, bare shoulders"
)

MOD = "modest clothes, fully clothed, long skirt, covered legs"

# key: (prompt, seed)
C = {
    "k_remi": (
        f"masterpiece, best quality, 1girl, remilia scarlet, touhou, short blue hair, red eyes, "
        f"bat wings spread, red long dress, white mob cap, red ribbon, frilled dress, ascot, "
        f"{MOD}, reaching hand toward viewer, cape flowing, smug grin, from below, low angle, cowboy shot, "
        f"red mist, swarm of bats, full moon, dramatic lighting", 7001),
    "k_fran": (
        f"masterpiece, best quality, 1girl, flandre scarlet, touhou, blonde hair, side ponytail, red eyes, "
        f"crystal wings, red long dress, white mob cap, red ribbon, frilled dress, {MOD}, "
        f"holding a staff overhead, wide grin, open mouth, dutch angle, cowboy shot, "
        f"dark mansion, shattered crystals, crimson light", 7002),
    "k_meirin": (
        f"masterpiece, best quality, 1girl, hong meiling, touhou, red hair, long braid, blue eyes, "
        f"green china dress, long skirt, hat, star, {MOD}, fighting stance, energy aura, wind, "
        f"from side, cowboy shot, gate, sunset, confident grin", 7003),
    "k_sakuya": (
        f"masterpiece, best quality, 1girl, sakuya izayoi, touhou, silver hair, blue eyes, "
        f"blue maid dress, white apron, maid headdress, {MOD}, throwing knives, hand in foreground, "
        f"calm smile, dutch angle, cowboy shot, clock, shattered glass, cold light", 7004),
    "k_patch": (
        f"masterpiece, best quality, 1girl, patchouli knowledge, touhou, purple hair, long hair, "
        f"purple dress, mob cap, crescent hair ornament, book, {MOD}, sitting on a floating book, "
        f"reading, magic circle below, calm smile, from below, cowboy shot, library, glowing runes", 7005),
    "k_rumia": (
        f"masterpiece, best quality, 1girl, rumia, touhou, blonde hair, red eyes, black dress, "
        f"red ribbon, {MOD}, sphere of darkness in outstretched hand, hair floating up, grin, "
        f"from below, cowboy shot, night road, forest, moonlight", 7006),
    "k_daiyousei": (
        f"masterpiece, best quality, 2girls, daiyousei, cirno, touhou, green hair, blue dress, "
        f"white sleeves, fairy wings, blue hair, ice wings, {MOD}, flying side by side toward viewer, "
        f"holding hands, laughing, cowboy shot, lake, sunlight, sparkles", 7007),
    "k_maid": (
        f"masterpiece, best quality, 1girl, fairy (touhou), touhou, green hair, blue eyes, "
        f"maid outfit, white apron, maid headdress, {MOD}, carrying a tray, walking fast, motion, "
        f"cheerful smile, from side, cowboy shot, banquet hall, candles", 7008),
    "k_kozue": (
        f"masterpiece, best quality, 1girl, koakuma, touhou, red hair, short hair, red eyes, "
        f"black dress, bat wings, white collar, {MOD}, leaning forward over a bookshelf, peeking, "
        f"books floating around, sly smile, from below, cowboy shot, library, candlelight", 7009),
    "k_cirno": (
        f"masterpiece, best quality, 1girl, cirno, touhou, blue hair, blue ribbon, blue eyes, "
        f"blue dress, white shirt, ice wings, {MOD}, dashing toward viewer, arm outstretched, "
        f"ice shards flying, big grin, low angle, cowboy shot, frozen lake, snowstorm, cold blue light", 7010),
    "s_yukari": (
        f"masterpiece, best quality, 1girl, yukari yakumo, touhou, blonde hair, long hair, purple eyes, "
        f"purple dress, mob cap, red ribbon, parasol, {MOD}, half body coming out of a gap, arm extended, "
        f"elegant smile, from side, cowboy shot, gap with eyes and ribbons, butterflies, twilight", 7011),
    "s_ran": (
        f"masterpiece, best quality, 1girl, ran yakumo, touhou, blonde hair, fox ears, nine tails, "
        f"blue and white dress, tabard, mob cap, {MOD}, running with ofuda, wind, from side, cowboy shot, "
        f"shrine, autumn leaves, confident smile", 7012),
    "s_chen": (
        f"masterpiece, best quality, 1girl, chen, touhou, brown hair, short hair, cat ears, two tails, "
        f"green dress, green hat, red ribbon, {MOD}, pouncing with claws, playful grin, low angle, "
        f"cowboy shot, bamboo, sunlight, motion", 7013),
    "s_spring": (
        "masterpiece, best quality, no humans, scenery, cherry blossom tunnel, petals falling, "
        "stone stairs, shrine, sunlight, spring, wide shot, depth of field", 7014),
    "s_yuyuko": (
        f"masterpiece, best quality, 1girl, yuyuko saigyouji, touhou, pink hair, short hair, red eyes, "
        f"blue kimono, triangle pattern, wide sleeves, {MOD}, looking back over shoulder, folding fan, "
        f"gentle smile, from behind, cowboy shot, cherry blossoms, petals swirling, soft light", 7015),
    "s_youmu": (
        f"masterpiece, best quality, 1girl, youmu konpaku, touhou, silver hair, short hair, blue eyes, "
        f"green dress, white shirt, {MOD}, katana slash across the frame, motion lines, determined expression, "
        f"from side, cowboy shot, cherry blossoms cut, petals, sharp light", 7016),
    "s_alice": (
        f"masterpiece, best quality, 1girl, alice margatroid, touhou, blonde hair, short hair, blue eyes, "
        f"blue dress, white pinafore, red hairband, {MOD}, holding puppet strings, dolls flying around, "
        f"magic threads, calm smile, from below, cowboy shot, workshop, window light", 7017),
    "s_prism": (
        f"masterpiece, best quality, 3girls, lunasa prismriver, merlin prismriver, lyrica prismriver, touhou, "
        f"blonde hair, polka dot dress, long skirt, violin, trumpet, keyboard, {MOD}, performing on stage, "
        f"from below, cowboy shot, spotlights, colorful lights, sound waves", 7018),
    "s_letty": (
        f"masterpiece, best quality, 1girl, letty whiterock, touhou, blue hair, long hair, blue eyes, "
        f"blue dress, white cape, white hat, {MOD}, blizzard sweeping, hair and cape flowing, calm smile, "
        f"from side, cowboy shot, ice crystals, winter night, cold wind", 7019),
    "s_lily": (
        f"masterpiece, best quality, 1girl, lily white, touhou, blonde hair, short hair, white dress, "
        f"wings, {MOD}, flying toward viewer, scattering flower petals, big smile, low angle, cowboy shot, "
        f"flower field, spring, bright light", 7020),
    "y_kaguya": (
        f"masterpiece, best quality, 1girl, houraisan kaguya, touhou, black hair, very long hair, hime cut, "
        f"red eyes, pink kimono, red skirt, red sash, wide sleeves, frills, japanese clothes, {MOD}, "
        f"sitting on a veranda, folding fan, elegant smile, from side, cowboy shot, full moon, night, "
        f"moon palace, bamboo", 7021),
    "y_eirin": (
        f"masterpiece, best quality, 1girl, yagokoro eirin, touhou, silver hair, very long hair, red eyes, "
        f"red and blue dress, nurse cap, detached sleeves, {MOD}, drawing a bow, arrow of light, calm smile, "
        f"from side, cowboy shot, full moon, night, medicine bottles floating", 7022),
    "y_reisen": (
        f"masterpiece, best quality, 1girl, reisen udongein inaba, touhou, purple hair, long hair, rabbit ears, "
        f"red eyes, white shirt, red necktie, blue skirt, {MOD}, finger to temple, waves of illusion, "
        f"glowing eyes, from below, cowboy shot, full moon, bamboo forest, night", 7023),
    "y_tewi": (
        f"masterpiece, best quality, 1girl, inaba tewi, touhou, brown hair, short hair, red eyes, rabbit ears, "
        f"pink dress, white collar, {MOD}, sitting on a rock, eating dango, grin, cowboy shot, "
        f"bamboo forest, fireflies, night, warm light", 7024),
    "y_mystia": (
        f"masterpiece, best quality, 1girl, mystia lorelei, touhou, pink hair, short hair, bird wings, "
        f"brown hat, blue dress, white apron, {MOD}, singing, open mouth, sound waves, from below, "
        f"cowboy shot, night, lantern, food stall, festival, warm light", 7025),
    "y_keine": (
        f"masterpiece, best quality, 1girl, kamishirasawa keine, touhou, blue hair, long hair, red eyes, "
        f"horn, tokin hat, blue dress, white apron, {MOD}, running with scrolls, motion, from side, "
        f"cowboy shot, school hallway, sunlight, determined smile", 7026),
    "y_riggle": (
        f"masterpiece, best quality, 1girl, wriggle nightbug, touhou, green hair, short hair, antennae, "
        f"insect wings, green dress, white cape, {MOD}, arms spread wide, surrounded by fireflies, "
        f"confident smile, from below, cowboy shot, night, meadow, glowing bugs", 7027),
    "y_rabbit": (
        f"masterpiece, best quality, 1girl, moon rabbit, touhou, white hair, long hair, rabbit ears, red eyes, "
        f"white kimono, {MOD}, swinging a mallet down, pounding mochi, mortar, from side, cowboy shot, "
        f"full moon, moon palace, night, motion", 7028),
    "y_reimu": (
        f"masterpiece, best quality, 1girl, hakurei reimu, touhou, brown hair, long hair, red eyes, "
        f"red and white shrine maiden outfit, detached sleeves, hair tubes, red ribbon, {MOD}, "
        f"ofuda flying toward viewer, gohei, serious expression, low angle, cowboy shot, "
        f"shrine gate, night, full moon", 7029),
    "y_marisa": (
        f"masterpiece, best quality, 1girl, kirisame marisa, touhou, blonde hair, long hair, yellow eyes, "
        f"black witch dress, white apron, black hat, white ribbon, {MOD}, riding broom, leaning forward, "
        f"grin, from side, cowboy shot, night sky, stars, sparkles, motion blur", 7030),
    "y_moko": (
        f"masterpiece, best quality, 1girl, fujiwara no mokou, touhou, white hair, very long hair, red eyes, "
        f"red pants, white shirt, suspenders, {MOD}, flaming fist toward viewer, fire, fierce grin, "
        f"from below, low angle, cowboy shot, burning bamboo forest, embers, dramatic orange light", 7031),
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
