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
  // 小悪魔の山札確認（peek）の候補を決定論化: 山札の上 4 枚を無害なダミーに差し替えてからピックする
  if (state.cardMap && state.cardMap['x_dummy']) {
    state.deck = [{ key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' }].concat(state.deck);
  }
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
      const choice = {};
      if (state.peekNeeded && state.peekNeeded[pi]) choice.pick = 0; // 山札確認は先頭の 1 枚を選択
      const r = Engine.dispatch(state, { kind: 'choose', pi, choice });
      assert.ok(r.ok, `choose 失敗: ${r.error}`);
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
  // 小悪魔の山札確認（peek）の候補を決定論化: 山札の上 4 枚を無害なダミーに差し替えてからピックする
  if (state.cardMap && state.cardMap['x_dummy']) {
    state.deck = [{ key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' }].concat(state.deck);
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
const DY4 = 'y_eirin'; // 永夜 4 人テスト用ダミー（即時 3 点）

// 小悪魔の山札確認（peek）は山札の上 4 枚に依存するため、テストでは候補を無害なダミーで固定する
// （x_dummy は即時 0 点・多数決/収集に影響しないテスト専用カード）
function fixPeek(state) {
  state.cardMap['x_dummy'] = { key: 'x_dummy', kind: 'instant', points: 0, name: 'テストダミー', icon: 'ダ', color: '#555555' };
  state.deck = [
    { key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' }, { key: 'x_dummy' },
  ].concat(state.deck);
}

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
  fixPeek(s);
  assert.strictEqual(s.intruderKey, 'y_reimu');
  const deckKeys = s.deck.map((i) => i.key);
  assert.ok(deckKeys.includes('y_reimu'));
  assert.ok(!deckKeys.includes('y_marisa'));
});

test('手札2-3人10枚/4-5人9枚・対応外人数はnull', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  fixPeek(s);
  assert.strictEqual(s.handSize, 10);
  assert.strictEqual(s.players[0].hand.length, 10);
  const s2 = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'scarlet' });
  fixPeek(s2);
  assert.strictEqual(s2.handSize, 9);
  assert.strictEqual(s2.players[0].hand.length, 9);
  assert.strictEqual(Engine.newGame(6, ['a']), null);
});

// ================= ラウンド進行・リサイクル =================

test('ラウンド終了時に取得カードが山札へ戻る（デザートは蓄積）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_cirno'], ['k_rumia']], [0, 0]); // p0 チルノ取得・p1 ルーミア取得・ラウンド終了
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.players[0].taken.length, 0);
  assert.strictEqual(s.players[0].desserts.filter((i) => i.key === 'k_cirno').length, 1);
  assert.strictEqual(s.phase, 'pick');
});

test('ラウンド 1 は左(-1)・ラウンド 2 は右(+1)・ラウンド 3 は左（DESIGN 4）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  assert.strictEqual(s.passDir, -1);
  cycle(s, [['k_remi'], ['k_remi']], [0, 0]);
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.passDir, 1);
  cycle(s, [['k_remi'], ['k_remi']], [0, 0]);
  assert.strictEqual(s.round, 2);
  assert.strictEqual(s.passDir, -1);
});

// ================= 紅霧メカニズム =================

test('紅霧: レミリア=即時3点×3枚=9点（純ポイント）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_remi', D], [D, D]], [0, 0]);
  cycle(s, [['k_remi', D], [D, D]], [0, 0]);
  cycle(s, [['k_remi'], [D]], [0, 0]); // 手札尽き → ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 9);
});

test('紅霧: フラン=即時2点・破棄しなければそのまま', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_fran', D], [D, D]], [0, 0]);
  cycle(s, [['k_fran'], [D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 4); // 2枚×2点
});

test('紅霧: フラン破棄で+2点・破棄カードは taken に残り判定から外れる', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s); // 小悪魔の peek 候補を無害なダミーに固定
  cycle(s, [['k_remi', D], [D, D]], [0, 0]); // レミリア3点取得・taken[0]
  setHands(s, [['k_fran', D], [D, D]]);
  pickAll(s, [0, 0]); // フラン取得 → 選択フェーズ（settleSelection は手動）
  assert.strictEqual(s.phase, 'select');
  // taken: [レミリア(idx0), ダミー(idx1), フラン(idx2)] — フラン自身は破棄できない
  const self = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 2 } });
  assert.ok(!self.ok, 'フラン自身を破棄しようとすると拒否される');
  // レミリアを破棄（点数はラウンド末集計で反映されるためこの時点では roundScores は変動しない）
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  // 手札が残っているのでラウンドは続行・破棄カードは taken に残る（UI で半透明「破棄」表示）
  assert.strictEqual(s.players[0].taken.length, 2);
  assert.strictEqual(s.players[0].taken[0].discarded, true);
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]); // ルーミア1枚取得（収集1点）
  cycle(s, [[D], [D]], [0, 0]); // ラウンド終了・即時点を一括集計
  // 破棄済みレミリアは集計から外れ（3点は計上されない）・フラン2+2・ルーミア収集1点 = 5
  assert.strictEqual(s.players[0].roundScores[0], 5);
  // ラウンド末に山札へ戻る（dealRound で手札に配られた後なら手札の中にいる）
  const backInDeck = s.deck.some((i) => i.key === 'k_remi');
  const backInHand = s.players.some((p) => p.hand.some((i) => i.key === 'k_remi'));
  assert.ok(backInDeck || backInHand, '破棄カードは山札（手札経由含む）に戻る');
});

test('紅霧: 破棄されたカードは収集判定から除外される', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]); // ルーミア1枚
  setHands(s, [['k_fran'], [D]]);
  pickAll(s, [0, 0]); // フラン取得・ルーミアを破棄
  assert.strictEqual(s.phase, 'select');
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  cycle(s, [[D], [D]], [0, 0]); // ラウンド終了・即時点を一括集計
  // 破棄されたルーミアは収集判定から除外 → 収集 0 点。フラン2+2 のみ
  assert.strictEqual(s.players[0].roundScores[0], 4);
});

test('紅霧: 咲夜=同ピックで他プレイヤーがレミリア/フランを出したら0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_sakuya', 'k_kozue'], ['k_remi', 'k_kozue']]);
  pickAll(s, [0, 0]); // 咲夜取得（同ピックで相手がレミリア）
  settleSelection(s); // 小悪魔の選択フェーズを解決
  setHands(s, [['k_kozue'], ['k_kozue']]);
  pickAll(s, [0, 0]); // ラウンド終了・集計
  settleSelection(s); // 小悪魔の選択を解決
  assert.strictEqual(s.players[0].roundScores[0], 0, '同席したので 0 点');
  assert.strictEqual(s.players[1].roundScores[0], 3, 'レミリアは 3 点');
});

test('紅霧: 咲夜=相手がレミリア/フランなしのピックなら3点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_sakuya', 'k_kozue'], ['k_kozue', 'k_kozue']]);
  pickAll(s, [0, 0]); // 咲夜取得（相手はダミーのみ）
  settleSelection(s); // 小悪魔の選択フェーズを解決
  setHands(s, [['k_kozue'], ['k_kozue']]);
  pickAll(s, [0, 0]); // ラウンド終了・集計
  settleSelection(s); // 小悪魔の選択を解決
  assert.strictEqual(s.players[0].roundScores[0], 3);
});

test('紅霧: 美鈴=同ラウンドに咲夜を獲得していたら+1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_meirin', D], [D, D]], [0, 0]); // 美鈴取得（咲夜なし → コンボ不発）
  cycle(s, [['k_sakuya', 'k_meirin'], [D, D]], [0, 0]); // 咲夜取得
  cycle(s, [['k_meirin'], [D]], [0, 0]); // 美鈴取得（ラウンド内に咲夜あり → コンボ発動）・ラウンド終了・集計
  assert.strictEqual(s.players[0].roundScores[0], 1 + 3 + 2);
});

test('紅霧: 美鈴コンボは獲得時判定（後から咲夜を取っても+1されない）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_meirin', D], [D, D]], [0, 0]); // 美鈴1点（取得時に咲夜なし → コンボ不発）
  cycle(s, [['k_sakuya', D], [D, D]], [0, 0]); // 咲夜を後から取得
  cycle(s, [[D], [D]], [0, 0]); // ラウンド終了・集計
  assert.strictEqual(s.players[0].roundScores[0], 1 + 3, '美鈴1+咲夜3（コンボは加算されない）');
});

test('紅霧: パチュリー=種類数−3（最低0・チルノ含む）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_patch', 'k_remi', D], [D, D]], [0, 0]); // patch+remi 取得（2種）
  cycle(s, [['k_rumia', 'k_cirno', D], [D, D]], [0, 0]); // rumia+cirno 取得（+2種）
  cycle(s, [['k_remi'], [D]], [0, 0]); // ラウンド終了
  // 種類数: patch/remi/rumia/cirno = 4種 → 4−3 = 1点 + レミリア3点
  assert.strictEqual(s.players[0].roundScores[0], 3 + 1);
});

test('紅霧: 小悪魔=山札 4 枚を見て 1 枚獲得・残りは山札の下へ', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  // p1 は peek を発動しないカードにする（山札の増減を p0 の分だけで検証するため）
  setHands(s, [['k_kozue', 'k_kozue'], ['k_remi', 'k_remi']]);
  pickAll(s, [0, 0]); // 小悪魔取得 → 選択フェーズ（解決はしない）
  assert.strictEqual(s.phase, 'select');
  assert.ok(s.peekNeeded[0], '山札確認が必要');
  assert.strictEqual(s.peekCards[0].length, 4, '山札の上 4 枚が候補');
  const deckBefore = s.deck.length; // 候補は既に山札から取り出されている
  const chosen = s.peekCards[0][0];
  const rest = s.peekCards[0].filter((_, i) => i !== 0).map((i) => i.key).sort();
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { pick: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s); // p1 の選択も解決 → applySelections 発火
  assert.strictEqual(s.peekCards[0], null, '候補は消費される');
  // 選んだカードは手元に獲得・残り 3 枚は山札の下へ
  assert.ok(s.players[0].taken.some((i) => i.key === chosen.key), '選んだカードを獲得');
  assert.strictEqual(s.deck.length, deckBefore + 3, '残り 3 枚が山札に戻る');
  const tail = s.deck.slice(-3).map((i) => i.key).sort();
  assert.deepStrictEqual(tail, rest, '残りは山札の下に積まれる');
});

test('紅霧: 小悪魔=山札確認をスキップしても候補 4 枚は失われない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_kozue', 'k_kozue'], ['k_remi', 'k_remi']]);
  pickAll(s, [0, 0]); // 小悪魔取得 → 選択フェーズ
  assert.strictEqual(s.phase, 'select');
  const deckBefore = s.deck.length; // 候補 4 枚は山札から抜けている
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: {} }); // 効果を使わない
  assert.ok(res.ok, res.error);
  assert.strictEqual(s.deck.length, deckBefore + 4, '候補 4 枚が山札へ戻る');
  assert.strictEqual(s.players[0].taken.filter((i) => i.key !== 'k_kozue').length, 0, '何も獲得しない');
});

test('紅霧: ルーミア=収集 3枚=6点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]);
  cycle(s, [['k_rumia', D], [D, D]], [0, 0]);
  cycle(s, [['k_rumia'], [D]], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

test('紅霧: 大妖精=今ラウンドのチルノ1枚ごとに1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_daiyousei', D, D], [D, D]], [0, 0]); // 大妖精取得
  cycle(s, [['k_cirno', D], [D, D]], [0, 0]); // チルノ1枚取得
  cycle(s, [['k_cirno'], [D]], [0, 0]); // チルノ2枚目・ラウンド終了 → 2点
  assert.strictEqual(s.players[0].roundScores[0], 2);
});

test('紅霧: 妖精メイド=多数決 最多4/最少−4', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_maid', 'k_maid', 'k_maid'], ['k_maid', D], [D, D]], [0, 0, 0]);
  cycle(s, [['k_maid'], [D], [D]], [0, 0, 0]); // ラウンド終了
  // p0: 3枚 最多4点 / p1: 1枚 / p2: 0枚 最少−4（ダミー小悪魔は点数に影響なし）
  assert.strictEqual(s.players[0].roundScores[0], 4);
  assert.strictEqual(s.players[1].roundScores[0], 0);
  assert.strictEqual(s.players[2].roundScores[0], -4);
});

test('紅霧: チルノ=デザート蓄積・ゲーム末に最少 −9', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
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
  fixPeek(s);
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

test('春雪: 春=2人配点（1位4点・同点は各2点・DESIGN 2-4）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [[inst('s_spring', 2), DS], [inst('s_spring', 1), DS]], [0, 0]);
  cycle(s, [[inst('s_spring', 1)], [DS]], [0, 0]); // ラウンド終了
  // p0: 3 / p1: 1 → 一意の1位 = 4点（2位ボーナスなし）。p1 はダミー紫の+3点も持つ
  assert.strictEqual(s.players[0].roundScores[0], 4);
  assert.strictEqual(s.players[1].roundScores[0], 3);
});

test('春雪: 春=2人同点は各2点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [[inst('s_spring', 2), DS], [inst('s_spring', 2), DS]], [0, 0]);
  cycle(s, [[DS], [DS]], [0, 0]); // ラウンド終了
  // 2/2 で同点 → 各 2 点。ダミー紫の+3点も加算
  assert.strictEqual(s.players[0].roundScores[0], 2 + 3);
  assert.strictEqual(s.players[1].roundScores[0], 2 + 3);
});

test('春雪: 幽々子=ラウンド内の春最多なら4点（幽々子取得が必須・春多数決も併走）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_yuyuko', inst('s_spring', 3)], [inst('s_spring', 1), DS]], [0, 0]); // p0 幽々子・p1 春1
  cycle(s, [[inst('s_spring', 3)], [DS]], [0, 0]); // p0 春3取得・ラウンド終了
  // 2人配点: p0 春3（1位4点）→ 幽々子4 + 春4 = 8点。p1: 春2位ボーナスなし・ダミー紫3点
  assert.strictEqual(s.players[0].roundScores[0], 8);
  assert.strictEqual(s.players[1].roundScores[0], 3); // 幽々子なしは春最多でも0点（紫の即時3点のみ）
});

test('春雪: 妖夢=他プレイヤー全員の春を1個ずつ引き自分に足す', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'spring' });
  fixPeek(s);
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
  fixPeek(s);
  cycle(s, [['s_letty', 's_letty'], [DS, DS]], [0, 0]); // レティ2枚取得
  cycle(s, [['s_letty', DS], [DS]], [0, 0]); // レティ3枚目・p1 が紫1枚取得
  cycle(s, [['s_letty'], [DS]], [0, 0]); // 手札尽き・ラウンド終了
  // p0: レティ3 − 春0 = 3 ×2 = 6点（最低0）。p1: レティ0 − 春0 = 0点 + 紫2枚×3点 = 6点
  assert.strictEqual(s.players[0].roundScores[0], 6);
  assert.strictEqual(s.players[1].roundScores[0], 9); // 紫2枚×3点
});

test('春雪: 藍・橙=紫を含む主従コンボ（獲得時判定・最後に揃えた1枚だけ発動）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_yukari', DS], [DS, DS]], [0, 0]); // 紫3点
  cycle(s, [['s_ran', DS], [DS, DS]], [0, 0]); // 藍2点（取得時に橙なし → コンボ不発）
  cycle(s, [['s_chen'], [DS]], [0, 0]); // 橙取得（取得時に紫+藍あり → 発動）・ラウンド終了
  // 紫3 + 藍2 + 橙(1+1)=2 = 7点
  assert.strictEqual(s.players[0].roundScores[0], 7);
});

test('春雪: 紅霧と同じく逆順（紫→橙→藍）では藍のみ発動', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_yukari', DS], [DS, DS]], [0, 0]); // 紫3点
  cycle(s, [['s_chen', DS], [DS, DS]], [0, 0]); // 橙1点（取得時に藍なし → 不発）
  cycle(s, [['s_ran'], [DS]], [0, 0]); // 藍取得（取得時に紫+橙あり → 発動）・ラウンド終了
  // 紫3 + 橙1 + 藍(2+1)=3 = 7点
  assert.strictEqual(s.players[0].roundScores[0], 7);
});

test('春雪: アリス=ペア2枚5点・三姉妹=3枚セット10点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
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
  fixPeek(s);
  for (let i = 0; i < 5; i++) s.players[0].desserts.push(inst('s_lily'));
  for (let r = 0; r < 3; r++) {
    cycle(s, [['s_yukari', DS], [DS, DS]], [0, 0]);
    cycle(s, [['s_yukari'], [DS]], [0, 0]);
  }
  assert.strictEqual(s.phase, 'over');
  assert.strictEqual(Engine.charmBonus(s, 0), 12); // 5枚 → 4枚ごとに12点
  assert.strictEqual(Engine.charmBonus(s, 1), 0);
});

test('デザート=ラウンド中は taken に置かれ、ラウンド末にデザート置き場へ送られる', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_cirno', D], [D, D]]);
  pickAll(s, [0, 0]); // チルノ取得
  settleSelection(s); // 小悪魔の選択フェーズを解決
  assert.strictEqual(s.players[0].taken.filter((i) => i.key === 'k_cirno').length, 1, 'ラウンド中は他のカード同様手元に置かれる');
  assert.strictEqual(s.players[0].desserts.length, 0, 'ラウンド中は置き場にいない');
  cycle(s, [[D], [D]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].taken.length, 0, 'ラウンド末に手元から消える');
  assert.strictEqual(s.players[0].desserts.filter((i) => i.key === 'k_cirno').length, 1, 'デザート置き場へ送られる');
});

test('デザート=効果の対象に含まれる（破棄/裏返しで判定から外れ、置き場には行かない）', () => {
  // 紅霧: チルノ取得後にフラン取得 → チルノ（デザート）を破棄して −9 リスク回避
  const s1 = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s1);
  fixPeek(s1);
  cycle(s1, [['k_cirno', 'k_cirno'], [D, D]], [0, 0]); // チルノ1枚（taken にいる）
  setHands(s1, [['k_fran', D], [D, D]]);
  pickAll(s1, [0, 0]); // フラン取得 → 選択フェーズ
  assert.strictEqual(s1.phase, 'select');
  // taken: [チルノ(idx0)=デザート, フラン(idx1)] → チルノを破棄できる
  const r1 = Engine.dispatch(s1, { kind: 'choose', pi: 0, choice: { discard: 0 } });
  assert.ok(r1.ok, r1.error);
  settleSelection(s1); // 他のプレイヤーの選択も解決 → applySelections 発火
  assert.strictEqual(s1.players[0].taken[0].discarded, true, 'デザートが破棄フラグ付きで残る');
  assert.strictEqual(s1.players[0].desserts.length, 0, '破棄されたデザートは置き場にいかない');
  cycle(s1, [[D], [D]], [0, 0]); // ラウンド終了
  const back1 = s1.deck.some((i) => i.key === 'k_cirno') ||
    s1.players.some((p) => p.hand.some((i) => i.key === 'k_cirno'));
  assert.ok(back1, '破棄デザートは山札へ戻る');

  // 永夜: 妹紅取得後にミスティア取得 → 妹紅（デザート）を裏返して 2 点化
  const s2 = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s2);
  cycle(s2, [['y_moko', 'y_moko'], [DY, DY]], [0, 0]); // 妹紅1枚
  setHands(s2, [['y_mystia', 'y_reimu'], ['y_reimu', 'y_reimu']]);
  pickAll(s2, [0, 0]); // ミスティア取得 → 選択フェーズ
  assert.strictEqual(s2.phase, 'select');
  // taken: [妹紅(idx0)=デザート, ミスティア(idx1)]
  const r2 = Engine.dispatch(s2, { kind: 'choose', pi: 0, choice: { flip: [0] } });
  assert.ok(r2.ok, r2.error);
  settleSelection(s2); // 他のプレイヤーの選択も解決 → applySelections 発火
  assert.strictEqual(s2.players[0].taken[0].flipped, true, 'デザートが裏返しフラグ付き');
  cycle(s2, [['y_reimu'], ['y_reimu']], [0, 0]); // ラウンド終了
  assert.strictEqual(s2.players[0].roundScores[0], 2, '裏返したデザートは 2 点のみ・妹紅判定からは外れる');
  assert.strictEqual(s2.players[0].desserts.length, 0, '裏返されたデザートは置き場にいかない');
});

test('永夜: うどんげ=出した番のピックだけうどんげ表示（次のピックは通常公開）', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  // p0 がうどんげ取得（幻覚開始）・他はダミー
  cycle(s, [['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.hidden, true);
  assert.strictEqual(s.hiddenOwner, 0);
  const r1 = s.players.map((p) => p.taken.map((i) => Boolean(i.hiddenTaken)));
  assert.strictEqual(r1[0][0], false, '出した本人の取得は見える');
  assert.strictEqual(r1[1][0], true, '出した番の他プレイヤーの取得はうどんげ表示');
  assert.strictEqual(r1[2][0], true, '出した番の他プレイヤーの取得はうどんげ表示');
  assert.strictEqual(r1[3][0], true, '出した番の他プレイヤーの取得はうどんげ表示');
  // 次のピックは通常公開（マークは付かない）
  cycle(s, [['y_tewi', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.players[1].taken.filter((i) => i.hiddenTaken).length, 1, '2 枚目以降はマークされない');
  cycle(s, [['y_tewi'], ['y_reimu'], ['y_reimu'], ['y_reimu']], [0, 0, 0, 0]); // ラウンド終了
  // 判定で公開される（マーク解除）・次ラウンドで幻覚はリセット
  const allVisible = s.players.every((p) => p.taken.every((i) => !i.hiddenTaken));
  assert.ok(allVisible, 'ラウンド末でマーク解除');
  assert.strictEqual(s.hidden, false);
});

test('永夜: うどんげ=出した番のみ効果あり・次ラウンドは通常公開', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.hidden, true);
  cycle(s, [['y_tewi', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  cycle(s, [['y_tewi'], ['y_reimu'], ['y_reimu'], ['y_reimu']], [0, 0, 0, 0]); // R1 終了
  assert.strictEqual(s.round, 1);
  assert.strictEqual(s.hidden, false, '次ラウンドで幻覚リセット');
  cycle(s, [['y_tewi', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.players[1].taken.filter((i) => i.hiddenTaken).length, 0, '幻覚なしの取得は公開');
});

// ================= 永夜メカニズム =================

test('永夜: 輝夜=即時4点・乱入者を取得したラウンドは−2', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 輝夜(4点)×2枚 = 8点
  assert.strictEqual(s.players[0].roundScores[0], 8);
  cycle(s, [['y_reimu', DY], [DY, DY]], [0, 0]); // 乱入者霊夢取得
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得（乱入者ありラウンド）
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 輝夜(4−2)×2枚 = 4点
  assert.strictEqual(s.players[0].roundScores[1], 4);
  assert.strictEqual(Engine.scorePlayer(s, 0), 12); // 霊夢1枚は0点
});

test('永夜: てゐ=1枚2点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', 'y_tewi'], [DY, DY]], [0, 0]); // てゐ1枚
  cycle(s, [['y_mystia'], [DY]], [0, 0]); // ラウンド終了（ミスティアは0点）
  assert.strictEqual(s.players[0].roundScores[0], 2);
});

test('永夜: てゐ=4枚でも0点（2枚の6点には戻らない）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  for (let i = 0; i < 4; i++) cycle(s, [['y_tewi', 'y_tewi'], [DY, DY]], [0, 0]); // てゐ4枚
  cycle(s, [['y_mystia'], [DY]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 0, '4枚は0点（3枚以上はすべて0）');
});

test('永夜: てゐ=2枚を裏返すと1枚扱いの2点＋裏返し2点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', 'y_tewi'], [DY, DY]], [0, 0]); // てゐ1枚
  setHands(s, [['y_tewi', 'y_tewi'], [DY, DY]]);
  pickAll(s, [0, 0]); // てゐ2枚目（この時点なら 6 点）
  setHands(s, [['y_mystia', 'y_reimu'], [DY, DY]]);
  pickAll(s, [0, 0]); // ミスティア取得 → 選択フェーズ
  assert.strictEqual(s.phase, 'select');
  const r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [0] } }); // てゐ1枚を裏返す
  assert.ok(r.ok, r.error);
  settleSelection(s);
  cycle(s, [['y_reimu'], [DY]], [0, 0]); // ラウンド終了
  // 裏返したてゐは収集判定から外れる → 残り1枚 = 2点。裏返したカードは 2 点
  assert.strictEqual(s.players[0].roundScores[0], 4);
});

test('永夜: てゐ=2枚6点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]);
  cycle(s, [['y_tewi'], [DY]], [0, 0]); // 2枚 → 6点
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

test('永夜: てゐ=3枚以上0点（ジレンマ）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]); // てゐ1枚
  cycle(s, [['y_tewi', 'y_tewi', DY], [DY, DY]], [0, 0]); // てゐ2枚目
  cycle(s, [['y_tewi'], [DY]], [0, 0]); // てゐ3枚目・ラウンド終了 → 0点
  assert.strictEqual(s.players[0].roundScores[0], 0);
});

test('永夜: リグル=1人だけなら0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_riggle', DY], [DY, DY]], [0, 0]); // p0 だけリグル
  cycle(s, [['y_mystia'], [DY]], [0, 0]); // ラウンド終了（ミスティアは 0 点）
  assert.strictEqual(s.players[0].roundScores[0], 0);
});

test('永夜: リグル=同時取得2人なら互いに1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_riggle', DY], ['y_riggle', DY]], [0, 0]); // 2人同時
  cycle(s, [['y_mystia'], ['y_mystia']], [0, 0]); // ラウンド終了（どちらも 0 点）
  assert.strictEqual(s.players[0].roundScores[0], 1);
  assert.strictEqual(s.players[1].roundScores[0], 1);
});

test('永夜: リグル=3人同時なら互いに2点（自分の枚数は勘定に入れない）', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  s.players[0].chopsticks = 1;
  setHands(s, [['y_riggle', 'y_riggle', DY], ['y_riggle', DY], [DY, DY]]);
  pickAll(s, [[0, 1], 0, 0]); // p0 は早飲みで 2 枚、p1 は 1 枚
  settleSelection(s);
  cycle(s, [['y_mystia'], ['y_mystia'], ['y_mystia']], [0, 0, 0]); // ラウンド終了
  // p0 から見た他人のリグル = p1 の 1 枚 → 自分の 2 枚は各 1 点で合計 2 点
  assert.strictEqual(s.players[0].roundScores[0], 2, '自分の 2 枚 × 他人 1 枚');
  // p1 から見た他人のリグル = p0 の 2 枚 → 2 点
  assert.strictEqual(s.players[1].roundScores[0], 2, '他人の 2 枚');
});

test('永夜: リグル=裏返すと取得点が消えて2点になる', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_riggle', DY], [DY, DY]], [0, 0]); // リグル1枚（1人なので0点）
  setHands(s, [['y_mystia'], [DY]]);
  pickAll(s, [0, 0]);
  const r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [0] } }); // 自分のリグルを裏返す
  assert.ok(r.ok, r.error);
  settleSelection(s);
  cycle(s, [[DY], [DY]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 2, '裏返した 1 枚は 2 点');
});

test('永夜: 霊夢=ゲーム通算4枚で10点（ラウンドをまたいで数える）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  // R1: 霊夢2枚
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_reimu'], [DY]], [0, 0]);
  // R2: 霊夢2枚
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_reimu'], [DY]], [0, 0]);
  // R3: 霊夢なし
  cycle(s, [['y_mystia'], [DY]], [0, 0]);
  const roundTotal = s.players[0].roundScores.reduce((a, b) => a + b, 0);
  // 4 枚 = 2 組 × 4 点 + 4 枚ボーナス 2 点
  assert.strictEqual(Engine.scorePlayer(s, 0) - roundTotal, 10);
});

test('永夜: 魔理沙=ゲーム通算4枚（偶数）で12点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_marisa' });
  fixPeek(s);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_marisa'], [DY]], [0, 0]);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_marisa'], [DY]], [0, 0]);
  cycle(s, [['y_mystia'], [DY]], [0, 0]);
  const roundTotal = s.players[0].roundScores.reduce((a, b) => a + b, 0);
  // 4 枚は偶数 → 2 組 × 6 点
  assert.strictEqual(Engine.scorePlayer(s, 0) - roundTotal, 12);
});

test('永夜: 玉兎=兎アイコンマキ準拠多数決（2人配点 1位4点）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [
    [inst('y_rabbit', 3), inst('y_rabbit', 2), DY],
    [inst('y_rabbit', 1), DY],
  ], [0, 0]);
  cycle(s, [[DY], [DY]], [0, 0]); // ラウンド終了
  // p0: 5 / p1: 1 → 1位のみ 4点（2人配点・2位ボーナスなし）+ ダミーうどんげ1点
  assert.strictEqual(s.players[0].roundScores[0], 5);
  assert.strictEqual(s.players[1].roundScores[0], 1);
});

test('永夜: 霊夢=ゲーム末に2枚ごと4点・4枚以上で+2', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  s.players[0].gameEndCounts['y_reimu'] = 5; // ゲーム通算5枚
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 10); // 5枚 = 4+4+2
});

test('永夜: 魔理沙=ゲーム末に偶数なら2枚ごと6点・奇数なら3点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_marisa' });
  fixPeek(s);
  s.players[0].gameEndCounts['y_marisa'] = 3; // ゲーム通算3枚
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 3); // 3枚・奇数 → floor(3/2)=1組×3点
});

test('永夜: 妹紅=デザートラウンド別判定（R1/R2最多+3・R3最多−6）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
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

test('永夜: ミスティア=取得時にカードを任意枚数裏返して2点化', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', 'y_tewi'], ['y_reimu', 'y_reimu']], [0, 0]); // てゐ1枚（手札1残る）
  setHands(s, [['y_mystia', 'y_tewi'], ['y_reimu', 'y_reimu']]);
  pickAll(s, [0, 0]); // ミスティア取得（手札1残る）→ 選択フェーズ
  assert.strictEqual(s.phase, 'select');
  // taken: [てゐ(idx0), ミスティア(idx1)] — ミスティア自身（idx1）は裏返せない
  const self = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [0, 1] } });
  assert.ok(!self.ok, 'ミスティア自身を裏返そうとすると拒否される');
  // てゐ1枚を裏返す → 裏返し2点
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [0] } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  cycle(s, [['y_tewi'], ['y_reimu']], [0, 0]); // てゐ1枚追加（手札2→1）
  cycle(s, [['y_reimu'], ['y_reimu']], [0, 0]); // ラウンド終了
  // 裏返し2点 + てゐ1枚の豆腐2点 = 4点（裏返されたてゐは豆腐判定から外れる）
  assert.strictEqual(s.players[0].roundScores[0], 4);
});

test('永夜: 慧音=ラウンド中取得カードの効果をコピー（自身は対象外）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_tewi', DY], [DY, DY]], [0, 0]); // R1 pick1: てゐ1枚
  setHands(s, [['y_keine'], [DY]]);
  pickAll(s, [0, 0]); // R1 pick2: 慧音取得 → 選択フェーズ（settleSelection は手動）
  assert.strictEqual(s.phase, 'select');
  // taken: [てゐ(idx0), 慧音(idx1)] — 慧音自身はコピーできない
  const self = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { copy: 1 } });
  assert.ok(!self.ok, '慧音自身をコピーしようとすると拒否される');
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { copy: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  // copy で てゐ2枚扱い → 豆腐 6点・ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 6);
});

// ================= うどんげ情報隠蔽 =================

test('永夜: うどんげ=出したラウンド終了時まで非公開フラグ', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
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
  fixPeek(s);
  let guard = 0;
  while (s.phase !== 'over' && guard++ < 2000) {
    if (s.phase === 'select') {
      // 取得時選択（フラン破棄・ミスティア・慧音・小悪魔の山札確認）を AI が解答
      for (const pi of s.selectNeeded) {
        if (s.selections[pi] === null) Engine.dispatch(s, { kind: 'choose', pi, choice: AI.selectChoice(s, pi) });
      }
    } else {
      for (let pi = 0; pi < 4; pi++) aiDispatch(s, pi);
    }
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
  fixPeek(s);
  s.players[0].taken = [inst(D, 2), inst(D), inst('k_sakuya')];
  const counts = Engine.countKeys(s.players[0].taken);
  assert.strictEqual(counts[D], 3, 'icons 合算される');
  assert.strictEqual(counts['k_sakuya'], 1, 'icons なしは 1 として数える');
});

test('initialCounts: 全異変でカードリファレンス用の構成枚数が記録される', () => {
  for (const inc of ['scarlet', 'spring', 'eternal']) {
    const s = Engine.newGame(2, ['A', 'B'], { incident: inc });
  fixPeek(s);
    const total = Object.values(s.initialCounts).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 54 + 15, `${inc} の構成合計はメイン54+デザート15`);
  }
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  assert.strictEqual(s.initialCounts['y_reimu'], 8, '乱入者は参加分のみ記録');
  assert.strictEqual(s.initialCounts['y_marisa'], undefined, '不参加の乱入者は記録されない');
});

// UI 契約: select フェーズ中、人間（seat 0）の選択は AI 側処理で {} 自動解決してはならない。
// （2026-11-03 事故: runAiSelections が人間のフラン破棄も {} で解決し、効果が発揮されないまま進行していた）
test('select フェーズ: 人間の選択は AI 解決で埋められない', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_fran'], [D], [D], [D]]);
  pickAll(s, [0, 0, 0, 0]);
  assert.strictEqual(s.phase, 'select', 'フラン取得で select フェーズに入る');
  assert.ok(s.selectNeeded.includes(0), '人間が選択対象に含まれる');
  // game.js の runAiSelections と同じ処理（pi === 0 を除外）
  for (const pi of s.selectNeeded) {
    if (pi !== 0 && s.selections[pi] === null) {
      Engine.dispatch(s, { kind: 'choose', pi, choice: {} });
    }
  }
  assert.strictEqual(s.selections[0], null, '人間の選択は null のまま残る');
  assert.strictEqual(s.phase, 'select', '人間が選ぶまで select のまま');
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
