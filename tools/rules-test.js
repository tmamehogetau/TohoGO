'use strict';

// ルールテスト（異変パックシステム版）。node tools/rules-test.js で実行。
// パックは opts で固定し、毎ピック後に手札を上書きしてパスの影響を排除する。
// 手札は 1〜2 枚で設定し、全員の手札が尽くしたピックでラウンドを閉じる。

const assert = require('assert');
const Engine = require('../engine.js');
const { RULES, INCIDENTS, buildMainDeck, buildDessertPool } = require('../data.js');
const AI = require('../ai.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

function inst(key, icons) {
  return icons ? { key, icons } : { key };
}

function pickAll(state, choices) {
  choices.forEach((c, pi) => {
    const res = Array.isArray(c)
      ? Engine.dispatch(state, { kind: 'pick2', pi, idxs: c })
      : Engine.dispatch(state, { kind: 'pick', pi, idx: c });
    assert.ok(res.ok, `pick 失敗: ${res.error}`);
  });
}

function settleSelection(state) {
  if (state.phase !== 'select') return;
  for (const pi of state.selectNeeded) {
    if (state.selections[pi] === null) {
      Engine.dispatch(state, { kind: 'choose', pi, choice: {} });
    }
  }
}

// 1 ピック = [全員の手札, 全員の選択]。hands の要素は文字列 or {key, icons}
function cycle(state, hands, choices) {
  if (hands) {
    hands.forEach((keys, pi) => {
      state.players[pi].hand = keys.map((x) => (typeof x === 'string' ? inst(x) : { ...x }));
    });
  }
  pickAll(state, choices);
  settleSelection(state);
}

function setHands(state, hands) {
  hands.forEach((keys, pi) => {
    state.players[pi].hand = keys.map((x) => (typeof x === 'string' ? inst(x) : { ...x }));
  });
}

const D = 'k_kozue'; // 紅霧のダミー（効果のみ・即時点数なし・取得時選択は自動解決）
const DS = 's_yukari'; // 春雪のダミー（即時3点）
const DY = 'y_reisen'; // 永夜のダミー（即時1点・情報隠蔽フラグのみ）

// ================= デッキ構成 =================

test('紅霧: メイン54枚・デザートプール15枚', () => {
  const inc = INCIDENTS.scarlet;
  assert.strictEqual(buildMainDeck(inc).length, 54);
  assert.strictEqual(buildDessertPool(inc).length, 15);
});

test('春雪: メイン54枚・春のアイコン配分（1個4/2個5/3個3）', () => {
  const inc = INCIDENTS.spring;
  const deck = buildMainDeck(inc);
  assert.strictEqual(deck.length, 54);
  const spring = deck.filter((i) => i.key === 's_spring');
  assert.strictEqual(spring.filter((i) => i.icons === 1).length, 4);
  assert.strictEqual(spring.filter((i) => i.icons === 2).length, 5);
  assert.strictEqual(spring.filter((i) => i.icons === 3).length, 3);
});

test('永夜: 乱入者指定で1種のみ組み込まれる', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  assert.strictEqual(s.intruderKey, 'y_reimu');
  const deckKeys = s.deck.map((i) => i.key);
  assert.ok(deckKeys.includes('y_reimu'));
  assert.ok(!deckKeys.includes('y_marisa'));
});

test('手札2-3人10枚/4-5人9枚・対応外人数はnull', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  assert.strictEqual(s.handSize, 10);
  assert.strictEqual(s.players[0].hand.length, 10);
  const s2 = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'scarlet' });
  assert.strictEqual(s2.handSize, 9);
  assert.strictEqual(s2.players[0].hand.length, 9);
  assert.strictEqual(Engine.newGame(6, ['a']), null);
});

// ================= ラウンド進行・リサイクル =================

test('ラウンド終了時に取得カードが山札へ戻る（デザートは蓄積）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_cirno'], ['k_rumia']], [0, 0]); // p0 チルノ取得・p1 ルーミア取得・ラウンド終了
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.players[0].taken.length, 0);
  assert.strictEqual(s.players[0].desserts.filter((i) => i.key === 'k_cirno').length, 1);
  assert.strictEqual(s.phase, 'pick');
});

test('ラウンド2のパス方向は -1・ラウンド3は +1', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_remi'], ['k_remi']], [0, 0]);
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.passDir, -1);
  cycle(s, [['k_remi'], ['k_remi']], [0, 0]);
  assert.strictEqual(s.round, 2);
  assert.strictEqual(s.passDir, 1);
});

// ================= 紅霧メカニズム =================

test('紅霧: レミリア=即時3点×3枚=9点（純ポイント）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_remi', D], [D, D]], [0, 0]);
  cycle(s, [['k_remi', D], [D, D]], [0, 0]);
  cycle(s, [['k_remi'], [D]], [0, 0]); // 手札尽き → ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 9);
});

test('紅霧: フラン=即時2点・破棄しなければそのまま', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_fran', D], [D, D]], [0, 0]);
  cycle(s, [['k_fran'], [D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 4); // 2枚×2点
});

test('紅霧: フラン破棄で+2点・対象は山札の下へ', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_remi', D], [D, D]], [0, 0]); // レミリア3点取得・taken[0]
  setHands(s, [['k_fran'], [D]]);
  pickAll(s, [0, 0]); // フラン取得 → 選択フェーズ（settleSelection は手動）
  assert.strictEqual(s.phase, 'select');
  // taken: [レミリア(idx0), フラン(idx1)] → レミリアを破棄 → フラン2点+2点
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  assert.strictEqual(s.players[0].roundScores[0], 4); // 3点は取り消され、フラン2+2
  assert.ok(s.deck.some((i) => i.key === 'k_remi'), '破棄カードはラウンド末に山札へ戻る');
});

test('紅霧: 咲夜=同ピックで他プレイヤーがレミリア/フランを出したら0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_sakuya', D], ['k_remi', D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 0);
  assert.strictEqual(s.players[1].roundScores[0], 3);
});

test('紅霧: 咲夜=相手がレミリア/フランなしのピックなら3点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_sakuya', D], [D, D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 3);
});

test('紅霧: 美鈴=同ラウンドに咲夜を獲得していたら+1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_meirin', D], [D, D]], [0, 0]); // 美鈴1点（咲夜なし）
  assert.strictEqual(s.players[0].roundScores[0], 1);
  cycle(s, [['k_sakuya', 'k_meirin'], [D, D]], [0, 0]); // 咲夜取得
  cycle(s, [['k_meirin'], [D]], [0, 0]); // 美鈴取得（ラウンド内に咲夜あり → 2点）・ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 1 + 3 + 2);
});

test('紅霧: パチュリー=種類数−3（最低0・チルノ含む）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_patch', 'k_remi', D], [D, D]], [0, 0]); // patch+remi 取得（2種）
  cycle(s, [['k_rumia', 'k_cirno', D], [D, D]], [0, 0]); // rumia+cirno 取得（+2種）
  cycle(s, [['k_remi'], [D]], [0, 0]); // ラウンド終了
  // 種類数: patch/remi/rumia/cirno = 4種 → 4−3 = 1点 + レミリア3点
  assert.strictEqual(s.players[0].roundScores[0], 3 + 1);
});

test('紅霧: ルーミア=収集 3枚=6点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]);
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]);
  cycle(s, [['k_rumia'], [D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

test('紅霧: 大妖精=今ラウンドのチルノ1枚ごとに1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  cycle(s, [['k_daiyousei', D, D], [D, D]], [0, 0]); // 大妖精取得
  cycle(s, [['k_cirno', D], [D, D]], [0, 0]); // チルノ1枚取得
  cycle(s, [['k_cirno'], [D]], [0, 0]); // チルノ2枚目・ラウンド終了 → 2点
  assert.strictEqual(s.players[0].roundScores[0], 2);
});

test('紅霧: 妖精メイド=多数決 最多4/最少−4', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  cycle(s, [['k_maid', 'k_maid', 'k_maid'], ['k_maid', D], [D, D]], [0, 0, 0]);
  cycle(s, [['k_maid'], [D], [D]], [0, 0, 0]); // ラウンド終了
  // p0: 3枚 最多4点 / p1: 1枚 / p2: 0枚 最少−4（ダミー小悪魔は点数に影響なし）
  assert.strictEqual(s.players[0].roundScores[0], 4);
  assert.strictEqual(s.players[1].roundScores[0], 0);
  assert.strictEqual(s.players[2].roundScores[0], -4);
});

test('紅霧: チルノ=デザート蓄積・ゲーム末に最少 −9', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  s.players[0].desserts.push(inst('k_cirno'), inst('k_cirno'), inst('k_cirno'));
  for (let r = 0; r < 3; r++) {
    cycle(s, [['k_remi', D], [D, D]], [0, 0]);
    cycle(s, [['k_remi'], [D]], [0, 0]);
  }
  assert.strictEqual(s.phase, 'over');
  assert.strictEqual(Engine.scorePlayer(s, 0), 18); // レミリア3×2枚×3ラウンド = 18
  assert.strictEqual(Engine.charmBonus(s, 1), -9); // チルノ最少
});

// ================= 春雪メカニズム =================

test('春雪: 春=マキ準拠多数決（アイコン合計で順位）', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'spring' });
  cycle(s, [
    [inst('s_spring', 2), DS],
    [inst('s_spring', 2), DS],
    [inst('s_spring', 1), DS],
  ], [0, 0, 0]);
  cycle(s, [[inst('s_spring', 3)], [DS], [DS]], [0, 0, 0]); // ラウンド終了
  // p0: 5 / p1: 2 / p2: 1 → 1位 6点・2位 3点。p1/p2 はダミー紫の+3点も持つ
  assert.strictEqual(s.players[0].roundScores[0], 6);
  assert.strictEqual(s.players[1].roundScores[0], 6);
  assert.strictEqual(s.players[2].roundScores[0], 3);
});

test('春雪: 幽々子=ラウンド内の春最多なら4点（幽々子取得が必須・春多数決も併走）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  cycle(s, [['s_yuyuko', inst('s_spring', 3)], [inst('s_spring', 1), DS]], [0, 0]); // p0 幽々子・p1 春1
  cycle(s, [[inst('s_spring', 3)], [DS]], [0, 0]); // p0 春3取得・ラウンド終了
  // p0 春3 / p1 春1 → 幽々子4点 + 春1位6点 = 10点。p1: 春2位3点 = 3点
  assert.strictEqual(s.players[0].roundScores[0], 10);
  assert.strictEqual(s.players[1].roundScores[0], 3); // 幽々子なしは春最多でも0点
});

test('春雪: 妖夢=他プレイヤー全員の春を1個ずつ引き自分に足す', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'spring' });
  cycle(s, [
    [inst('s_spring', 1), DS],
    [inst('s_spring', 2), DS],
    [inst('s_spring', 3), DS],
  ], [0, 0, 0]); // 春を全員取得（p0 1/p1 2/p2 3）
  cycle(s, [['s_youmu'], [DS], [DS]], [0, 0, 0]); // 妖夢取得・ラウンド終了
  // 妖夢取得時: p1 から1・p2 から1 引いて p0 に+2
  // ※ roundStats は dealRound でリセットされるため、判定時スナップショット lastRoundStats を参照
  assert.strictEqual(s.lastRoundStats[0].springIcons, 3);
  assert.strictEqual(s.lastRoundStats[1].springIcons, 1);
  assert.strictEqual(s.lastRoundStats[2].springIcons, 2);
});

test('春雪: レティ=(レティ枚数−春枚数)×2・最低0', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  cycle(s, [['s_letty', 's_letty'], [DS, DS]], [0, 0]); // レティ2枚取得
  cycle(s, [['s_letty', DS], [DS]], [0, 0]); // レティ3枚目・p1 が紫1枚取得
  cycle(s, [['s_letty'], [DS]], [0, 0]); // 手札尽き・ラウンド終了
  // p0: レティ3 − 春0 = 3 ×2 = 6点（最低0）。p1: レティ0 − 春0 = 0点 + 紫2枚×3点 = 6点
  assert.strictEqual(s.players[0].roundScores[0], 6);
  assert.strictEqual(s.players[1].roundScores[0], 9); // 紫2枚×3点
});

test('春雪: 藍・橙=紫を含む主従コンボ（循環・ラウンド末判定）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  cycle(s, [['s_yukari', DS], [DS, DS]], [0, 0]); // 紫3点
  cycle(s, [['s_ran', DS], [DS, DS]], [0, 0]); // 藍2点
  cycle(s, [['s_chen'], [DS]], [0, 0]); // 橙取得・ラウンド終了
  // ラウンド末時点で紫+藍+橙が揃う → 循環コンボ発動: 紫3 + 藍(2+1)=3 + 橙(1+1)=2 = 8点
  assert.strictEqual(s.players[0].roundScores[0], 8);
});

test('春雪: アリス=ペア2枚5点・三姉妹=3枚セット10点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  cycle(s, [['s_alice', DS], [DS, DS]], [0, 0]); // アリス1枚
  cycle(s, [['s_alice', DS], [DS, DS]], [0, 0]); // アリス2枚目（ペア5点）
  cycle(s, [['s_prism', DS], [DS, DS]], [0, 0]); // 三姉妹1枚
  cycle(s, [['s_prism', DS], [DS, DS]], [0, 0]); // 三姉妹2枚
  cycle(s, [['s_prism'], [DS]], [0, 0]); // 三姉妹3枚目・ラウンド終了
  // p0: ペア5 + セット10 = 15点。p1: ダミー紫5枚×3点 = 15点
  assert.strictEqual(s.players[0].roundScores[0], 15);
  assert.strictEqual(s.players[1].roundScores[0], 15);
});

test('春雪: リリーホワイト=デザート蓄積・ゲーム末に4枚ごとに12点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  for (let i = 0; i < 5; i++) s.players[0].desserts.push(inst('s_lily'));
  for (let r = 0; r < 3; r++) {
    cycle(s, [['s_yukari', DS], [DS, DS]], [0, 0]);
    cycle(s, [['s_yukari'], [DS]], [0, 0]);
  }
  assert.strictEqual(s.phase, 'over');
  assert.strictEqual(Engine.charmBonus(s, 0), 12); // 5枚 → 4枚ごとに12点
  assert.strictEqual(Engine.charmBonus(s, 1), 0);
});

// ================= 永夜メカニズム =================

test('永夜: 輝夜=即時4点・乱入者を取得したラウンドは−1', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 輝夜(4点)×2枚 = 8点
  assert.strictEqual(s.players[0].roundScores[0], 8);
  cycle(s, [['y_reimu', DY], [DY, DY]], [0, 0]); // 乱入者霊夢取得
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得（乱入者ありラウンド）
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 輝夜(4−1)×2枚 = 6点
  assert.strictEqual(s.players[0].roundScores[1], 6);
  assert.strictEqual(Engine.scorePlayer(s, 0), 14); // 霊夢1枚は0点
});

test('永夜: てゐ=2枚6点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]);
  cycle(s, [['y_tewi'], [DY]], [0, 0]); // 2枚 → 6点
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

test('永夜: てゐ=3枚以上0点（ジレンマ）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]); // てゐ1枚
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]); // てゐ2枚目
  cycle(s, [['y_tewi'], [DY]], [0, 0]); // てゐ3枚目・ラウンド終了 → 0点
  assert.strictEqual(s.players[0].roundScores[0], 0);
});

test('永夜: リグル=他プレイヤーのリグル出し回数×1点', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [
    [DY, DY],
    ['y_riggle', DY],
    ['y_riggle', DY],
  ], [0, 0, 0]);
  cycle(s, [[DY], [DY], [DY]], [0, 0, 0]); // ラウンド終了
  // リグル共闘: p0 2点・p1 1点・p2 1点 + ダミーうどんげ各2/1/1点
  assert.strictEqual(s.players[0].roundScores[0], 4);
  assert.strictEqual(s.players[1].roundScores[0], 2);
  assert.strictEqual(s.players[2].roundScores[0], 2);
});

test('永夜: 玉兎=兎アイコンマキ準拠多数決', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [
    [inst('y_rabbit', 3), inst('y_rabbit', 2), DY],
    [inst('y_rabbit', 1), DY],
  ], [0, 0]);
  cycle(s, [[DY], [DY]], [0, 0]); // ラウンド終了
  // p0: 5 / p1: 1 → 1位のみ 6点 + ダミーうどんげ1点
  assert.strictEqual(s.players[0].roundScores[0], 7);
  assert.strictEqual(s.players[1].roundScores[0], 1);
});

test('永夜: 霊夢=ゲーム末に2枚ごと4点・4枚以上で+2', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  s.players[0].taken.push(inst('y_reimu'), inst('y_reimu'), inst('y_reimu'), inst('y_reimu'), inst('y_reimu'));
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 10); // 5枚 = 4+4+2
});

test('永夜: 魔理沙=ゲーム末に偶数なら2枚ごと6点・奇数なら3点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_marisa' });
  s.players[0].taken.push(inst('y_marisa'), inst('y_marisa'), inst('y_marisa'));
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 3); // 3枚・奇数 → floor(3/2)=1組×3点
});

test('永夜: 妹紅=デザートラウンド別判定（R1/R2最多+3・R3最多−6）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  for (let i = 0; i < 5; i++) s.players[0].desserts.push(inst('y_moko'));
  for (let r = 0; r < 3; r++) {
    cycle(s, [[DY, DY], [DY, DY]], [0, 0]);
    cycle(s, [[DY], [DY]], [0, 0]);
  }
  assert.strictEqual(s.phase, 'over');
  const rs = s.players[0].roundScores;
  assert.strictEqual(rs[0], 5);  // 妹紅最多3点+うどんげ2点
  assert.strictEqual(rs[1], 5);
  assert.strictEqual(rs[2], -4); // 妹紅最多−6点+うどんげ2点
});

test('永夜: ミスティア=取得時にカードを裏返して2点化', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]); // てゐ2枚（本来6点）
  setHands(s, [['y_mystia'], [DY]]);
  pickAll(s, [0, 0]); // ミスティア取得 → 選択フェーズ
  assert.strictEqual(s.phase, 'select');
  // てゐ2枚（taken idx0, idx1）を裏返す → 裏返し2枚×2点 = 4点（てゐの収集判定からは外れる）
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [0, 1] } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  cycle(s, [[DY], [DY]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 4);
});

test('永夜: 慧音=ラウンド中取得カードの効果をコピー', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_tewi', DY], [DY, DY]], [0, 0]); // R1 pick1: てゐ1枚
  setHands(s, [['y_keine'], [DY]]);
  pickAll(s, [0, 0]); // R1 pick2: 慧音取得 → 選択フェーズ（settleSelection は手動）
  assert.strictEqual(s.phase, 'select');
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { copy: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  // copy で てゐ2枚扱い → 豆腐 6点・ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

// ================= うどんげ情報隠蔽 =================

test('永夜: うどんげ=出したラウンド終了時まで非公開フラグ', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  cycle(s, [['y_reisen', DY], [DY, DY]], [0, 0]);
  assert.strictEqual(s.hidden, true);
  cycle(s, [['y_reisen'], [DY]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.hidden, false);
});

// ================= AI 完走 =================

function aiDispatch(s, pi) {
  if (s.phase === 'select') {
    for (const p2 of s.selectNeeded) {
      if (s.selections[p2] === null) {
        Engine.dispatch(s, { kind: 'choose', pi: p2, choice: {} });
      }
    }
    return { ok: true };
  }
  if (s.picks[pi] !== null) return { ok: true };
  const use2 = s.players[pi].chopsticks > 0 && s.players[pi].hand.length >= 2;
  const idxs = use2 ? AI.pick2(s, pi) : AI.pick(s, pi);
  if (idxs.length === 0) return Engine.dispatch(s, { kind: 'skip', pi });
  if (idxs.length === 2) return Engine.dispatch(s, { kind: 'pick2', pi, idxs });
  return Engine.dispatch(s, { kind: 'pick', pi, idx: idxs[0] });
}

function fullRun(incident, intruder) {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident, intruder });
  let guard = 0;
  while (s.phase !== 'over' && guard++ < 2000) {
    for (let pi = 0; pi < 4; pi++) aiDispatch(s, pi);
  }
  assert.strictEqual(s.phase, 'over');
  assert.ok([0, 1, 2, 3].every((pi) => Engine.scorePlayer(s, pi) >= -15), '合計点が異常な負値');
  return s;
}

test('紅霧で4人AI完走', () => {
  fullRun('scarlet', null);
});

test('春雪で4人AI完走', () => {
  fullRun('spring', null);
});

test('永夜で4人AI完走（両乱入者）', () => {
  fullRun('eternal', 'y_reimu');
  fullRun('eternal', 'y_marisa');
});

// ================= UI API 契約 =================
// game.js が参照する Engine の関数は、Browser 実行時に未定義だと
// renderAll が途中で例外を投げ、以降の描画（スコア・バナー・ログ）が
// 全部欠落する（2026-11-03 の countKeys 未定義事故の再発防止）。

test('UI API 存在: game.js が使う Engine 関数がすべて公開されている', () => {
  for (const fn of ['newGame', 'dispatch', 'scorePlayer', 'countKey', 'countKeys']) {
    assert.strictEqual(typeof Engine[fn], 'function', `Engine.${fn} が未定義`);
  }
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  s.players[0].taken = [inst(D, 2), inst(D), inst('k_sakuya')];
  const counts = Engine.countKeys(s.players[0].taken);
  assert.strictEqual(counts[D], 3, 'icons 合算される');
  assert.strictEqual(counts['k_sakuya'], 1, 'icons なしは 1 として数える');
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
