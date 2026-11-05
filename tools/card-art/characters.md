# カード絵のキャラ追従チェック表

生成した絵が「そのキャラに見えるか」を判定するための基準。
正史の特徴は Touhou Wiki / Danbooru のキャラクターページと、Danbooru のタグ統計
（`rating:g` の高評価投稿から頻出タグを集計、2026-11-03 取得）を突き合わせて作った。
生成プロンプトの根拠もここに揃えている（実体は `tools/card-art/build-candidates.py`）。

判定は「①髪色・髪型 ②瞳色 ③衣装の形と色 ④固有の小道具・部位 ⑤露出が控えめか」の5点。
5点すべて合えば追従OK、3点以下はリロール。

| key | 正史の特徴 | 判定に使うタグ | 備考 |
|---|---|---|---|
| k_remi | 青い短髪・赤目・紅いドレス・白いモブキャップ・蝙蝠羽・幼い体つき | `remilia_scarlet blue_hair short_hair red_eyes red_dress mob_cap bat_wings` | 帽子の赤リボンも必須 |
| k_fran | 金髪サイドテール・赤目・紅いドレス・白モブキャップ・結晶羽 | `flandre_scarlet blonde_hair side_ponytail crystal_wings red_dress mob_cap` | 羽は虹色の結晶。手持ちは**曲がった時計の針のような杖（レーヴァテイン）**が正史。巨大な炎の剣はスペルカード演出（2026-11-04 再考） |
| k_meirin | 赤髪の長い三つ編み・青目・緑のチャイナドレス・星付き帽子 | `hong_meiling red_hair braid blue_eyes green_china_dress hat star` | 脚が出やすいのでロング丈で |
| k_sakuya | 銀髪・青目・青いメイド服・白エプロン・ヘッドドレス・ナイフ | `izayoi_sakuya silver_hair blue_eyes maid blue_dress apron maid_headdress knives` | ナイフを指で挟む構図だと指が刃物化するので、**手は空手（empty hands / open palms / five fingers）＋ナイフは宙に浮かせる**。ネガに knife fingers / blade fingers（2026-11-04 修正） |
| k_patch | 紫の長髪・紫目・紫のドレス・モブキャップ・三日月飾り・本 | `patchouli_knowledge purple_hair purple_dress mob_cap crescent book` | 病弱な雰囲気 |
| k_rumia | 金髪・赤目・黒いワンピース・赤リボン・闇 | `rumia blonde_hair red_eyes black_dress red_ribbon darkness` | 2026-11-04 に**両腕を真横に広げた原作ポーズ**へ変更 |
| k_daiyousei | 緑髪・青いドレス・白い袖・妖精の羽 | `daiyousei green_hair blue_dress fairy_wings` | チルノと並べると効果が伝わる。**大妖精を手前大きく・チルノを奥小さく**の構図（2026-11-04） |
| k_maid | 緑髪の妖精・メイド服・エプロン | `fairy_(touhou) green_hair maid_headdress apron` | 固有キャラではない |
| k_kozue | 赤髪の短髪・黒いドレス・蝙蝠羽・白い襟 | `koakuma red_hair black_dress bat_wings white_collar` | |
| k_cirno | 青髪・青リボン・青いドレス・白シャツ・氷の羽 | `cirno blue_hair blue_dress ice_wings white_shirt` | 2026-11-04 に**両腕を真横に広げた原作ポーズ**へ変更 |
| s_yukari | 金の長髪・紫のドレス・赤リボンのモブキャップ・和傘・スキマ | `yakumo_yukari blonde_hair purple_dress mob_cap parasol gap` | |
| s_ran | 金の長髪・狐耳・九尾・青白い服・モブキャップ・御札 | `yakumo_ran blonde_hair fox_ears nine_tails tabard mob_cap ofuda` | |
| s_chen | 茶髪の短髪・猫耳・二本尾（先端は白）・**赤いノースリーブのワンピース＋白い長袖＋白い蝶ネクタイ・緑のフリル帽** | `chen brown_hair cat_ears two_tails green_mob_cap red_sleeveless_dress white_sleeves white_bowtie` | THBWiki の外貌で確認。前回は緑ドレス＋赤リボンで色が逆だった |
| s_spring | （人物なし）桜のトンネル・石段・神社 | `cherry_blossoms scenery no_humans` | 風景カード |
| s_yuyuko | 桃髪の短髪・青い着物（三角文様）・扇 | `saigyouji_yuyuko pink_hair blue_kimono triangle_pattern fan` | |
| s_youmu | 銀髪の短髪・緑の服＋白シャツ・刀・半霊 | `konpaku_youmu silver_hair green_dress katana half_phantom` | |
| s_alice_hourai | アリス本人は共通（金髪の短髪・青いドレス＋白エプロン・赤カチューシャ）。抱いている**人形＝長い黒髪＋赤いチャイナ服＋金の刺繍** | `alice_margatroid blonde_hair blue_dress white_pinafore hairband doll black_hair red_chinese_dress` | 蓬莱＝中国風の姫人形で他3種と一番シルエットが違う（2026-11-05 追加） |
| s_alice_shanghai | アリス本人＋**自分にそっくりな小さな人形**（金髪・青いドレス・白エプロン） | `alice_margatroid blonde_hair blue_dress white_pinafore hairband mini_me_doll twin_doll` | 上海＝アリスの相棒人形。ミニ自分なので「同じキャラ2人」に見えないよう、人形は手のひらサイズで明示（2026-11-05 追加） |
| s_alice_orleans | アリス本人＋**茶髪の三つ編み＋白いボンネット＋紺のメイド服（白襟）の人形** | `alice_margatroid blonde_hair blue_dress white_pinafore hairband maid_doll brown_braid bonnet navy_dress` | オルレアン＝メイド風の人形（2026-11-05 追加） |
| s_alice_french | アリス本人＋**金の縦ロール＋淡いピンクのフリルドレス＋レースのボンネットの陶器人形** | `alice_margatroid blonde_hair blue_dress white_pinafore hairband porcelain_doll ringlets pink_frilled_dress lace_bonnet` | 仏蘭西＝アンティークな陶器人形。アリスと髪色が同じなので**巻き毛＋ピンク**で必ず差をつける（2026-11-05 追加） |
| s_prism | 三姉妹で髪も服も別：**ルナサ＝金髪＋黒帽（赤い三日月）＋白シャツ黒ベスト黒スカート＋バイオリン** / **メルラン＝淡い紫髪＋白帽＋白服（黒縁・大丸ボタン2つ）＋トランペット** / **リリカ＝淡い茶髪＋赤い円錐帽（緑の星）＋赤服（黒縁）＋キーボード** | `lunasa blonde_hair black_hat black_vest violin` / `merlin pale_purple_hair white_hat white_dress trumpet` / `lyrica light_brown_hair red_conical_hat red_dress keyboard` | THBWiki の外貌＋touhouwiki で確認。前回は3人とも金髪・赤水玉で潰れ、楽器も混線（全員トランペット等）。**担当楽器を各人に明示**（ルナサ＝バイオリン／メルラン＝トランペット／リリカ＝キーボード）（2026-11-04 修正） |
| s_letty | 青の長髪・青いドレス・白いマントと白い帽子・冬 | `letty_whiterock blue_hair blue_dress white_cape white_hat` | |
| s_lily | 金髪の短髪・白いドレス・羽・春告げ | `lily_white blonde_hair white_dress wings` | 白飛び注意 |
| y_kaguya | 黒の超長髪（姫カット）・赤目・桃の着物＋赤いスカート＋赤い帯・広袖 | `houraisan_kaguya black_hair very_long_hair hime_cut pink_kimono red_skirt red_sash wide_sleeves` | 東方キャラでも屈指の露出の少なさ。前回は赤い着物＋緑で外していた |
| y_eirin | 銀の超長髪・赤目・赤青の服・ナースキャップ・弓 | `yagokoro_eirin silver_hair red_eyes red_and_blue_dress nurse_cap bow` | |
| y_reisen | 紫の長髪・赤目・兎耳・白シャツ＋赤ネクタイ・青スカート | `reisen_udongein_inaba purple_hair rabbit_ears red_eyes red_necktie` | |
| y_tewi | 茶髪の短髪・赤目・兎耳・桃のワンピース・団子 | `inaba_tewi brown_hair rabbit_ears pink_dress dango` | |
| y_mystia | 桃髪の短髪・鳥の羽・茶色の帽子・**茶色のジャンパースカート＋白エプロン** | `mystia_lorelei pink_hair bird_wings hat brown_dress white_apron` | 夜雀＝屋台の灯り。当初「青いドレス」と書いていたが調査で茶色が正しいと判明（LostWord の公式説明「brown jumper dress」「white and brown clothing」） |
| y_keine | 青の長髪・赤目・トキン帽・青い服＋白エプロン。**通常形態に角は無い**（角と緑髪は白澤形態のみ） | `kamishirasawa_keine blue_hair tokin_hat blue_dress white_apron no_horn` | ネガティブに `horn` を入れる（2026-11-03 指摘対応） |
| y_riggle | 青緑の短髪・青目・触角・**白い半袖シャツ＋黒い裏地赤のマント（虫の翅形）＋青い膝丈ショーツ** | `wriggle_nightbug teal_hair antennae white_shirt black_cape red_lining blue_shorts` | The Codex の記述で確定。「緑のドレス＋白マント」は誤りだった（赤く見えていたのはマントの裏地） |
| y_rabbit | 月の兎は**兎そのもの**（人型ではない）・白い毛・長い耳・餅つき | `no_humans, rabbit, white_fur, long_ears, pounding_mochi, mortar, full_moon` | 2026-11-03 指摘対応。人型の兎娘で描かれていた→兎に変更。実写調になったため nime style, cel shading を追加（2026-11-04） |
| y_reimu | 茶の長髪・赤目・赤白の巫女服・分離袖・髪の筒・御札 | `hakurei_reimu brown_hair red_eyes miko detached_sleeves hair_tubes ofuda` | |
| y_marisa | 金の長髪・黄目・黒い魔女服＋白エプロン・黒帽子・箒 | `kirisame_marisa blonde_hair yellow_eyes witch_hat black_dress broom` | |
| y_moko | 白の超長髪・赤目・赤いズボン＋白シャツ・炎 | `fujiwara_no_mokou white_hair red_eyes red_pants white_shirt fire` | |

## 露出の方針

- ポジティブに `modest clothes, fully clothed, long skirt, covered legs` を必ず入れる
- ネガティブに `cleavage, panties, underwear, lingerie, navel, bare legs, thighs, short skirt, upskirt, revealing clothes, suggestive, high kick, bare shoulders`
- カードは 92×138 で表示されるので、脚より「顔＋小道具＋エフェクト」を優先する

## 生成と判定の手順

1. `build-candidates.py` でキャラごと 3 案（シード違い）を生成
2. 3 案を横並びのシートにして、上の5点で判定
3. 5点中3点以下のキャラだけ、タグを直して再生成
4. 採用案を `assets/cards/` に入れて差し替え（先輩のOK後）

## 検証ログ（2026-11-03）

- 生成: 111枚（31キャラ×3案＝93 ＋ パチュリー/リリー/ミスティア/リグル/リグル再 の作り直し18）
- 判定: 31キャラすべて5点。作り直しの内訳は
  - パチュリー … 床に意味不明な文字が焼き込まれていた（魔法陣タグが原因）→ タグを外して解消
  - リリー … 白飛びで実寸の輪郭が消える → 背景を夕方の花畑にして解消
  - ミスティア … プロンプトの衣装色が誤り（青→正しくは茶）→ 修正して解消
  - リグル … 緑キュロット＋白マントと誤記 → 正史は「白シャツ＋黒地に赤裏地のマント＋青い膝丈ショーツ」→ 修正して解消
- フル解像度（512×768）で手・小道具まで確認したカード:
  k_kozue / k_meirin / k_fran / s_prism / s_youmu / s_lily / y_rabbit / y_kaguya / y_mystia / y_riggle
- 機械チェック（`qa-check.py`）: 31枚・31キー・全件512×768・採用セットとバイト一致・HTTP 200
- 髪色の自動判定は不採用: 帽子や背景（夜空・桜・スポットライト）が支配的で31枚中13枚が誤NGになったため

### 残っている既知の差分

- リグルは裸足（正史は靴の有無が資料で確認できない）
- プリズムリバーの衣装色は「姉が赤の水玉」で、正史の割り当て（紫/赤/青）とは完全一致しない

## 先輩レビューでの修正（2026-11-03 第2弾）

| カード | 指摘 | 対応 |
|---|---|---|
| 咲夜 | 指先がナイフになっている | `realistic hands, five fingers` を追加＋ネガに `knife fingers, blade fingers`。指でナイフを挟む構図に変更 |
| 橙 | 服と帽子の色が違う | 正史は**赤いノースリーブのワンピース＋白い長袖＋白い蝶ネクタイ＋緑のフリル帽**。前回は緑ドレス＋赤リボンで逆だった |
| プリズムリバー | メルラン以外の服と髪が違う | ルナサ＝金髪＋黒帽（赤い三日月）＋黒ベスト / メルラン＝淡い紫髪＋白帽＋白服（黒縁・大丸ボタン） / リリカ＝淡い茶髪＋赤い円錐帽（緑の星）＋赤服 に分離 |
| 慧音 | 通常形態に角は無い | プロンプトから `horn` を外し、ネガティブに `horn` を追加 |
| 玉兎 | 人間ではなく兎 | `no humans, rabbit, white fur, pounding mochi` に変更（人型の兎娘をやめた） |

再生成は各3案（咲夜/橙/プリズム/慧音/玉兎＝15枚＋橙の作り直し6枚）。採用は `assemble-final.py` の `PICK` に反映済み。

