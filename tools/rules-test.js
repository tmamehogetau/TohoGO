'use strict';

// ルールテスト（異変パックシステム版）。node tools/rules-test.js で実行。
// パックは opts で固定し、毎ピック後に手札を上書きしてパスの影響を排除する。
// 手札は 1〜2 枚で設定し、全員の手札が尽くしたピックでラウンドを閉じる。

const assert = require('assert');
const Engine = require('../engine.js');
const { RULES, INCIDENTS, buildMainDeck, buildDessertPool } = require('../data.js');
const AI = require('../ai.js');
const Zones = require('./zones.js');
const Consistency = require('./consistency-test.js');

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

test('永遠亭: 追加カード指定で1種のみ組み込まれる', () => {
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

test('紅霧: フラン破棄の+2はラウンド末に集計される（取得中はスコアが動かない）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_remi', D], [D, D]], [0, 0]);
  setHands(s, [['k_fran', D], [D, D]]);
  pickAll(s, [0, 0]); // フラン取得 → 選択フェーズ
  const res = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 0 } });
  assert.ok(res.ok, res.error);
  settleSelection(s);
  assert.strictEqual(s.players[0].roundScores[0], 0, '取得中は加点されない');
  cycle(s, [[D], [D]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 4, 'フラン2点＋破棄2点がラウンド末に入る');
  const r = s.roundBanner.results.find((x) => x.pi === 0);
  assert.ok(r.extras.some((e) => e.label.includes('フラン') && e.pts === 2), '内訳にフラン（破棄）+2 が出る');
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

test('紅霧: 咲夜=同ピックで他プレイヤーも咲夜を出したら0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_sakuya', 'k_kozue'], ['k_sakuya', 'k_kozue']]);
  pickAll(s, [0, 0]); // 互いに咲夜を取得（同手番で咲夜が2枚）
  settleSelection(s); // 小悪魔の選択フェーズを解決
  setHands(s, [['k_kozue'], ['k_kozue']]);
  pickAll(s, [0, 0]); // ラウンド終了・集計
  settleSelection(s); // 小悪魔の選択を解決
  assert.strictEqual(s.players[0].roundScores[0], 0, '被ったので 0 点');
  assert.strictEqual(s.players[1].roundScores[0], 0, '被ったので 0 点');
});

test('紅霧: 咲夜=同手番で咲夜が1枚だけなら3点', () => {
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

test('紅霧: 咲夜=早飲みで同じ手番に2枚出したら0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  s.players[0].chopsticks = 1;
  setHands(s, [['k_sakuya', 'k_sakuya'], ['k_kozue', 'k_kozue']]);
  pickAll(s, [[0, 1], [0]]); // 早飲みで咲夜を2枚
  settleSelection(s); // 小悪魔の選択フェーズを解決
  setHands(s, [['k_kozue'], ['k_kozue']]);
  pickAll(s, [0, 0]); // ラウンド終了・集計
  settleSelection(s); // 小悪魔の選択を解決
  assert.strictEqual(s.players[0].roundScores[0], 0, '1枚だけではないので 0 点');
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

test('紅霧: フランをスキップ後の小悪魔選択に古い破棄キーが混ざっても +2 しない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  const F = 'k_meirin';
  setHands(s, [['k_meirin', F], [F, F]]);
  pickAll(s, [0, 0]); // 先に美鈴（破棄対象になるカード）を取る
  setHands(s, [['k_fran', F], [F, F]]);
  pickAll(s, [0, 0]); // フラン取得
  assert.strictEqual(s.phase, 'select');
  Engine.dispatch(s, { kind: 'choose', pi: 0, choice: {} }); // 破棄せずスキップ
  setHands(s, [['k_kozue', F], [F, F]]);
  pickAll(s, [0, 0]); // 小悪魔取得 → peek の選択フェーズ
  assert.strictEqual(s.phase, 'select');
  assert.strictEqual(s.players[0].roundScores[0], 0);
  // UI に古い discard モードが残った場合を想定し、discard と pick を同時に送る
  const r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { discard: 0, pick: 0 } });
  assert.ok(r.ok, r.error);
  // フランの +2 はラウンド末加算なので、roundScores をその場で見ても回帰は捕まらない。
  // 「破棄そのものが起きていない」ことを直接確かめる
  assert.strictEqual(s.players[0].taken.filter((i) => i.discarded).length, 0, '破棄は起きていない');
  assert.strictEqual(s.players[0].taken.filter((i) => i.franBonus).length, 0, 'フランの加点フラグも付かない');
  assert.strictEqual(s.phase, 'pick');
  // ラウンドを閉じても、内訳にフランの破棄加点（+2）が現れない
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  const row = s.roundBanner.results.find((x) => x.pi === 0);
  assert.ok(!row.extras.some((e) => e.key === 'k_fran'), '内訳にフランの破棄加点が無い');
  assert.strictEqual(s.players[0].roundScores[0], 3, '美鈴 1 点＋フラン 2 点のみ（破棄の +2 は入らない）');
});

test('紅霧: 大妖精=同じ手番にチルノを取った人数ぶん +1点', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_daiyousei', 'x_dummy'], ['k_cirno', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy'], ['x_dummy']], [0, 0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 1, '同じ手番でチルノを取った B の1人ぶん');
});

test('紅霧: 大妖精=別の手番のチルノは数えない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['x_dummy', 'k_daiyousei'], ['k_cirno', 'x_dummy']], [0, 0]); // この手番は B だけチルノ
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  // 手番1で A はダミー、手番2で A が大妖精 → 同じ手番にチルノを取った人はいない
  assert.strictEqual(s.players[0].roundScores[0], 0);
});

test('紅霧: 大妖精=同じ手番の大妖精も数える（互いに+1）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_daiyousei', 'x_dummy'], ['k_daiyousei', 'x_dummy']], [0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 1);
  assert.strictEqual(s.players[1].roundScores[0], 1);
});

test('紅霧: 大妖精=自分だけでは0点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_daiyousei', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 0);
});

test('紅霧: 大妖精=同じ手番に2人がチルノなら+2', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  fixPeek(s);
  cycle(s, [['k_daiyousei', 'x_dummy'], ['k_cirno', 'x_dummy'], ['k_cirno', 'x_dummy']], [0, 0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy'], ['x_dummy']], [0, 0, 0]);
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

test('紅霧: 妖精メイド=最多が同点なら等分（4÷人数）', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  cycle(s, [['k_maid', 'k_maid'], ['k_maid', 'k_maid'], [D, D]], [0, 0, 0]);
  cycle(s, [['k_maid'], ['k_maid'], [D]], [0, 0, 0]); // ラウンド終了
  // p0: 2枚 / p1: 2枚 最多同点 → 4÷2 = 2点ずつ、p2: 0枚 最少 −4
  assert.strictEqual(s.players[0].roundScores[0], 2);
  assert.strictEqual(s.players[1].roundScores[0], 2);
  assert.strictEqual(s.players[2].roundScores[0], -4);
});

test('紅霧: チルノ=最少が同点なら等分（−9÷人数・端数切り捨て）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s);
  fixPeek(s);
  s.players[0].desserts.push(inst('k_cirno'));
  s.players[1].desserts.push(inst('k_cirno'));
  for (let r = 0; r < 3; r++) {
    cycle(s, [['k_remi', D], [D, D]], [0, 0]);
    cycle(s, [['k_remi'], [D]], [0, 0]);
  }
  assert.strictEqual(s.phase, 'over');
  assert.strictEqual(Engine.charmBonus(s, 0), -4); // −9÷2 = −4.5 → −4
  assert.strictEqual(Engine.charmBonus(s, 1), -4);
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

test('春雪: 春=3人で同点なら等分（6÷3 = 2点ずつ）', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [
    [inst('s_spring', 2), DS],
    [inst('s_spring', 2), DS],
    [inst('s_spring', 2), DS],
  ], [0, 0, 0]);
  cycle(s, [[DS], [DS], [DS]], [0, 0, 0]); // ラウンド終了
  // 全員 2 アイコンで同点1位 → 6÷3 = 2点ずつ（+ ダミー紫の3点）
  [0, 1, 2].forEach((pi) => assert.strictEqual(s.players[pi].roundScores[0], 3 + 2));
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

test('春雪: 幽々子=所持1枚ごとに4点（春が最多のラウンドのみ）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_yuyuko', inst('s_spring', 3)], [inst('s_spring', 1), DS]], [0, 0]);
  cycle(s, [['s_yuyuko', 's_yuyuko'], [DS, DS]], [0, 0]); // 幽々子2枚目
  cycle(s, [[inst('s_spring', 3)], [DS]], [0, 0]); // p0 春3取得・ラウンド終了
  // p0: 幽々子2枚 × 4 = 8 + 春1位4 = 12点
  assert.strictEqual(s.players[0].roundScores[0], 12);
});

test('春雪: 妖夢=次に取った春のアイコン数ぶん春と点を得る', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_youmu', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 妖夢取得（バフ1）
  cycle(s, [[inst('s_spring', 3), 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 3アイコンの春 → 加護+3春/+3点
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]); // ラウンド終了
  assert.strictEqual(s.lastRoundStats[0].springIcons, 6, '春3 + 加護3 = 6');
  assert.strictEqual(s.players[0].roundScores[0], 3 + 4, '加護3点＋春マキ最多4点（2人戦の配点）');
});

test('春雪: 妖夢の加護は春を取らなければ発生しない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_youmu', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]); // 春を取らずにラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 0, '加護は 0 点のまま');
});
test('春雪: 藍・橙のコンボはラウンド末判定（取得順に依存しない）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_ran', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 藍から
  cycle(s, [['s_chen', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 橙
  cycle(s, [['s_yukari', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 紫を最後
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 3 + 2 + 1 + 1 + 1, '藍+1・橙+1（順序不問）');
});

test('春雪: 藍・橙のコンボはラウンド末に揃っていないと発動しない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'spring' });
  fixPeek(s);
  cycle(s, [['s_ran', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['s_yukari', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]); // 橙を取らない
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  assert.strictEqual(s.players[0].roundScores[0], 3 + 2, '橙がいないので藍のコンボは不発');
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

test('永夜: 幻覚で隠したカードには hiddenBy（出し主の席）が記録される', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  // p0 がうどんげ（幻覚開始）・同じ手番で p1 が玉兎2個を取得
  cycle(s, [['y_reisen', 'y_tewi'], [{ key: 'y_rabbit', icons: 2 }, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  const hidden = s.players[1].taken.find((i) => i.hiddenTaken);
  assert.ok(hidden, '他のプレイヤーの取得は隠される');
  assert.strictEqual(hidden.hiddenBy, 0, '出し主の席が記録される');
  assert.ok(!s.players[0].taken[0].hiddenTaken, '出した本人の取得は隠されない');
});

test('永夜: 幻覚の免疫は出した手番だけ（後の手番で出した人は前の出し主も隠す）', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  // 1手目: p0 がうどんげ
  cycle(s, [['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  // 2手目: p1 もうどんげ（同じラウンド）
  cycle(s, [['y_tewi', 'y_tewi'], ['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  const p0hidden = s.players[0].taken.filter((i) => i.hiddenTaken);
  assert.ok(p0hidden.length > 0, '前の手番の出し主も隠される');
  assert.ok(p0hidden.every((i) => i.hiddenBy === 1), '隠したのは 2 手目の出し主');
  assert.strictEqual(s.hiddenOwner, 1, '幻覚の主は最後に出した人');
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

test('永夜: うどんげは2ラウンド目以降も幻覚が発動する', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.hidden, true, '1回目は発動');
  assert.strictEqual(s.hiddenOwner, 0);
  cycle(s, [['y_tewi', 'y_tewi'], [DY4, DY4], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  cycle(s, [['y_tewi'], ['y_reimu'], ['y_reimu'], ['y_reimu']], [0, 0, 0, 0]); // R1 終了
  assert.strictEqual(s.hidden, false, 'ラウンド末で解除');
  // R2: 別のプレイヤーがうどんげを取る
  cycle(s, [['y_tewi', 'y_tewi'], ['y_reisen', 'y_tewi'], [DY4, DY4], [DY4, DY4]], [0, 0, 0, 0]);
  assert.strictEqual(s.hidden, true, '2回目も幻覚が発動する');
  assert.strictEqual(s.hiddenOwner, 1, '2回目は出した本人が幻覚の主');
});

test('リザルト: 獲得カード＋判定の内訳がラウンド点と一致する', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'spring', intruder: 'y_reimu' });
  fixPeek(s);
  // 2枚 → 2枚 → 1枚 で 1 ラウンド流す
  const h = ['s_yukari', 's_yukari'];
  cycle(s, [h, h, h, h], [0, 0, 0, 0]);
  cycle(s, [h, h, h, h], [0, 0, 0, 0]);
  cycle(s, [['s_yukari'], ['s_yukari'], ['s_yukari'], ['s_yukari']], [0, 0, 0, 0]);
  assert.ok(s.roundBanner, 'ラウンド結果が出る');
  for (const r of s.roundBanner.results) {
    const cards = r.cards.reduce((a, c) => a + c.pts, 0);
    const extras = r.extras.reduce((a, e) => a + e.pts, 0);
    if (cards + extras !== r.points) {
      console.log('DEBUG', JSON.stringify({ name: r.name, points: r.points, cards: r.cards, extras: r.extras }));
    }
    assert.strictEqual(cards + extras, r.points, `${r.name}: 内訳の合計が点数と一致`);
  }
});

// ================= 永夜メカニズム =================

test('永遠亭: 輝夜=即時3点（追加カードのペナルティなし）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 輝夜(3点)×2枚 = 6点
  assert.strictEqual(s.players[0].roundScores[0], 6);
  cycle(s, [['y_reimu', DY], [DY, DY]], [0, 0]); // 霊夢を取得
  cycle(s, [['y_kaguya', DY], [DY, DY]], [0, 0]); // 輝夜1枚取得（霊夢ありラウンド）
  cycle(s, [['y_kaguya'], [DY]], [0, 0]); // 輝夜2枚目・ラウンド終了 → 減点なしで 3×2枚 = 6点
  assert.strictEqual(s.players[0].roundScores[1], 6);
  assert.strictEqual(Engine.scorePlayer(s, 0), 12); // 霊夢1枚は0点
});

test('永夜: 永琳=2点（同じ手番に輝夜がいなければ）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_eirin', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  pickAll(s, [0, 0]); // 残りの手札を消化してラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 2);
});

test('永夜: 永琳=同じ手番に他の人が輝夜を取ると+1点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_eirin', 'x_dummy'], ['y_kaguya', 'x_dummy']], [0, 0]); // 同じ手番に B が輝夜
  pickAll(s, [0, 0]); // 残りの手札を消化してラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 3, '永琳2点＋同時手番1点');
  assert.strictEqual(s.players[1].roundScores[0], 3, '相手の輝夜は3点');
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

test('永夜: 霊夢=ペアの点数はゲーム通算で増える（4→5点）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  // R1: 2枚=1ペア目4点 / R2: 2枚=2ペア目5点
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_reimu'], [DY]], [0, 0]);
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_reimu'], [DY]], [0, 0]);
  cycle(s, [['y_mystia'], [DY]], [0, 0]);
  const roundTotal = s.players[0].roundScores.reduce((a, b) => a + b, 0);
  assert.strictEqual(roundTotal, 9, '1ペア目4点＋2ペア目5点');
  assert.strictEqual(Engine.scorePlayer(s, 0) - roundTotal, 0, 'ゲーム末の追加点はない');
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

test('永夜: 霊夢=2枚で1ペア4点（1枚では0点）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_reimu'], [DY]], [0, 0]); // 2枚でラウンド終了 → 1ペア目4点
  assert.strictEqual(s.players[0].roundScores[0], 4);
  cycle(s, [['y_reimu', 'y_reimu'], [DY, DY]], [0, 0]);
  cycle(s, [['y_mystia'], [DY]], [0, 0]); // 1枚だけ → 0点
  assert.strictEqual(s.players[0].roundScores[1], 0);
});

test('永夜: 魔理沙=ラウンド末に 0/2/8/13/21 点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_marisa' });
  fixPeek(s);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_marisa'], [DY]], [0, 0]); // 3枚 → 8点
  assert.strictEqual(s.players[0].roundScores[0], 8);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_marisa', 'y_marisa'], [DY, DY]], [0, 0]);
  cycle(s, [['y_mystia'], [DY]], [0, 0]); // 2枚 → 2点
  assert.strictEqual(s.players[0].roundScores[1], 2);
});

test('永夜: 魔理沙=ゲーム末の通算ボーナスは無い', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_marisa' });
  fixPeek(s);
  s.players[0].gameEndCounts['y_marisa'] = 7; // 通算を積んでも加点されない
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 0);
});

test('永夜: 霊夢=ゲーム末ボーナスは無い（崖の廃止）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  s.players[0].gameEndCounts['y_reimu'] = 7;
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 0);
});

test('永夜: 魔理沙=通算枚数が最多でも加点なし（旧+9の撤去）', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'eternal', intruder: 'y_marisa' });
  fixPeek(s);
  s.players[0].gameEndCounts['y_marisa'] = 4;
  s.players[1].gameEndCounts['y_marisa'] = 1;
  s.phase = 'over';
  assert.strictEqual(Engine.charmBonus(s, 0), 0);
  assert.strictEqual(Engine.charmBonus(s, 1), 0);
});

test('永夜: 妹紅=ラウンド中のペナルティは無い', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  cycle(s, [['y_moko', DY], [DY, DY]], [0, 0]); // 席0だけ妹紅1枚、席1は鈴仙
  cycle(s, [[DY], [DY]], [0, 0]); // ラウンド終了
  assert.strictEqual(s.players[0].roundScores[0], 1, '鈴仙1点のみ（妹紅のラウンド罰は無い）');
  assert.strictEqual(s.players[1].roundScores[0], 2, '鈴仙2点');
});

// ゲーム終了状態を直接作って妹紅のゲーム末判定だけを見る
function eternalOver(dessertsPerPlayer) {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'eternal', intruder: 'y_reimu' });
  fixPeek(s);
  s.phase = 'over';
  s.players.forEach((p, i) => {
    p.roundScores = [10, 10, 10];
    p.desserts = [];
    for (let k = 0; k < dessertsPerPlayer[i]; k++) p.desserts.push(inst('y_moko'));
  });
  return s;
}

test('永夜: 妹紅=ゲーム末に最多 +6・最少 −6', () => {
  const s = eternalOver([3, 2, 1, 0]);
  assert.deepStrictEqual([0, 1, 2, 3].map((pi) => Engine.scorePlayer(s, pi) - 30), [6, 0, 0, -6]);
});

test('永夜: 妹紅=最多同点は等分（+6÷人数）・最少同点も等分（−6÷人数）', () => {
  const s = eternalOver([2, 2, 0, 1]);
  assert.deepStrictEqual([0, 1, 2, 3].map((pi) => Engine.scorePlayer(s, pi) - 30), [3, 3, -6, 0]);
});

test('永夜: 妹紅=3人で最多同点なら +2 ずつ', () => {
  const s = eternalOver([3, 3, 3, 0]);
  assert.deepStrictEqual([0, 1, 2, 3].map((pi) => Engine.scorePlayer(s, pi) - 30), [2, 2, 2, -6]);
});

test('永夜: 妹紅=全員同数なら判定なし（0点）', () => {
  const s = eternalOver([2, 2, 2, 2]);
  assert.deepStrictEqual([0, 1, 2, 3].map((pi) => Engine.scorePlayer(s, pi) - 30), [0, 0, 0, 0]);
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

test('永遠亭で4人AI完走（霊夢・魔理沙の両方）', () => {
  fullRun('eternal', 'y_reimu');
  fullRun('eternal', 'y_marisa');
});

// ================= 同点タイブレーキ =================
// 合計点 → デザート合計枚数（多い方が上位） → それも同じなら同率1位。
// 順位は競技方式（1,1,3,4）。UI・sim・ai-check は Engine.finalRanking を唯一の定義元にする。

function tieState() {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'scarlet' });
  fixPeek(s);
  s.players.forEach((p) => { p.roundScores = [10, 0, 0]; p.desserts = []; });
  return s;
}

test('同点タイブレーキ: 合計点が同じならデザート枚数が多い方が上位', () => {
  const s = tieState();
  s.players[2].desserts = [inst('k_cirno'), inst('k_cirno')];
  const ranked = Engine.finalRanking(s);
  assert.strictEqual(ranked[0].pi, 2, 'デザート2枚の席が1位');
  assert.strictEqual(ranked[0].rank, 1);
  assert.deepStrictEqual(ranked.slice(1).map((r) => r.rank), [2, 2, 2], '残りは2位同率（競技方式）');
  assert.strictEqual(ranked.filter((r) => r.winner).length, 1);
});

test('同点タイブレーキ: 合計点もデザート枚数も同じなら同率1位', () => {
  const s = tieState();
  const ranked = Engine.finalRanking(s);
  assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 1, 1, 1]);
  assert.ok(ranked.every((r) => r.winner), '同率1位は全員が勝者');
});

test('同点タイブレーキ: デザート枚数より合計点が優先される', () => {
  const s = tieState();
  s.players[0].roundScores = [9, 0, 0];
  s.players[0].desserts = [inst('k_cirno'), inst('k_cirno'), inst('k_cirno')];
  const ranked = Engine.finalRanking(s);
  assert.strictEqual(ranked[0].rank, 1);
  assert.notStrictEqual(ranked[0].pi, 0, '合計点が低ければデザートが多くても1位にならない');
});

test('同点タイブレーキ: 順位は競技方式（1,1,3,4）で振る', () => {
  const s = tieState();
  s.players[0].desserts = [inst('k_cirno')];
  s.players[1].desserts = [inst('k_cirno')];
  s.players[2].roundScores = [9, 0, 0];
  s.players[3].roundScores = [8, 0, 0];
  const ranked = Engine.finalRanking(s);
  assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 1, 3, 4]);
  assert.deepStrictEqual(ranked.filter((r) => r.winner).map((r) => r.pi).sort(), [0, 1]);
});

// ================= UI API 契約 =================
// game.js が参照する Engine の関数は、Browser 実行時に未定義だと
// renderAll が途中で例外を投げ、以降の描画（スコア・バナー・ログ）が
// 全部欠落する（2026-11-03 の countKeys 未定義事故の再発防止）。

test('UI API 存在: game.js が使う Engine 関数がすべて公開されている', () => {
  for (const fn of ['newGame', 'dispatch', 'scorePlayer', 'finalRanking', 'countKey', 'countKeys']) {
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
  assert.strictEqual(s.initialCounts['y_reimu'], 8, '参加した追加カードのみ記録');
  assert.strictEqual(s.initialCounts['y_marisa'], undefined, '不参加の追加カードは記録されない');
});

// UI 契約: select フェーズ中、人間（seat 0）の選択は AI 側処理で {} 自動解決してはならない。
// （2026-11-03 事故: runAiSelections が人間のフラン破棄も {} で解決し、効果が発揮されないまま進行していた）
test('select フェーズ: 対象が無い取得時効果では選択フェーズに入らない', () => {
  // 慧音を最初に取る → コピー対象が無いので選択なし
  const s1 = Engine.newGame(2, ['A', 'B'], { incident: 'eternal' });
  fixPeek(s1);
  setHands(s1, [['y_keine'], [DY]]);
  pickAll(s1, [0, 0]);
  assert.strictEqual(s1.phase, 'pick', 'コピー対象が無ければ選択しない');

  // フランを最初に取る → 破棄対象が無いので選択なし
  const s2 = Engine.newGame(2, ['A', 'B'], { incident: 'scarlet' });
  fixPeek(s2);
  setHands(s2, [['k_fran'], [D]]);
  pickAll(s2, [0, 0]);
  assert.ok(!s2.selectNeeded || !s2.selectNeeded.includes(0), '破棄対象が無ければ選択しない（相手の小悪魔は別）');
});

test('select フェーズ: 人間の選択は AI 解決で埋められない', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'scarlet' });
  fixPeek(s);
  setHands(s, [['k_kozue'], [D], [D], [D]]);
  pickAll(s, [0, 0, 0, 0]);
  assert.strictEqual(s.phase, 'select', '小悪魔取得で select フェーズに入る');
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

// ================= 風神録メカニズム =================

const DM = 'f_suwako'; // 風神録のダミー（即時2点・条件なし）

test('風神録: 鍵山雛=1枚なら−3点、2枚以上なら+7点', () => {
  const one = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  setHands(one, [['f_hina'], [DM]]);
  pickAll(one, [0, 0]); // ラウンド終了
  assert.strictEqual(one.players[0].roundScores[0], -3, '1枚は−3点');

  const two = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  setHands(two, [['f_hina', 'f_hina'], [DM, DM]]);
  pickAll(two, [0, 0]);
  setHands(two, [['f_hina'], [DM]]);
  pickAll(two, [0, 0]); // ラウンド終了
  assert.strictEqual(two.players[0].roundScores[0], 7, '2枚以上は+7点');
});

test('風神録: 秋静葉=穣子とのペア1組につき3点', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  setHands(s, [['f_shizuha', 'f_minoriko'], [DM, DM]]);
  pickAll(s, [0, 0]); // 静葉
  setHands(s, [['f_minoriko'], [DM]]);
  pickAll(s, [0, 0]); // ラウンド終了（静葉1・穣子1）
  // 静葉3点 + 穣子の収集1点
  assert.strictEqual(s.players[0].roundScores[0], 4);
});

test('風神録: 早苗=次に取った神奈子の点数が3倍', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  setHands(s, [['f_sanae', 'f_kanako'], [DM, DM]]);
  pickAll(s, [0, 0]); // 早苗
  setHands(s, [['f_kanako'], [DM]]);
  pickAll(s, [0, 0]); // ラウンド終了
  // 早苗1点 + 神奈子 3×3 = 9点
  assert.strictEqual(s.players[0].roundScores[0], 10);
});

test('風神録: 信仰=10個到達で即時8点（カードは残る）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  // 手札は毎手番パスで入れ替わるため、毎ターン配り直して同じ player0 に信仰を集めさせる
  const icons = [5, 5];
  for (const n of icons) {
    setHands(s, [[{ key: 'f_faith', icons: n }, DM], [DM, DM]]);
    pickAll(s, [0, 0]);
  }
  // 5+5 = 10 で1番目 → 8点。信仰はラウンド末に追加点なし
  assert.strictEqual(s.players[0].roundScores[0], 8);
  assert.strictEqual(s.players[0].taken.filter((x) => x.key === 'f_faith').length, 2, 'カードは捨てない');
});

test('風神録: 信仰=同手番で2人到達なら同点8点ずつ・次は3位2点', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'mountain' });
  fixPeek(s);
  const F = (n) => ({ key: 'f_faith', icons: n });
  setHands(s, [[F(5), 'x_dummy'], [F(5), 'x_dummy'], ['x_dummy', 'x_dummy']]);
  pickAll(s, [0, 0, 0]); // 5個ずつ
  setHands(s, [[F(5), 'x_dummy'], [F(5), 'x_dummy'], ['x_dummy', 'x_dummy']]);
  pickAll(s, [0, 0, 0]); // p0 と p1 が同じ手番で10個
  setHands(s, [['x_dummy', 'x_dummy'], ['x_dummy', 'x_dummy'], [F(10), 'x_dummy']]);
  pickAll(s, [0, 0, 0]); // p2 が後から10個（3位）
  assert.strictEqual(s.players[0].roundScores[0], 8, '同点1位');
  assert.strictEqual(s.players[1].roundScores[0], 8, '同点1位');
  assert.strictEqual(s.players[2].roundScores[0], 2, '2位はスキップされ3位の2点');
});

test('風神録: 信仰=ラウンド終了時に未到達でもアイコン上位が残りの順位点を得る', () => {
  const s = Engine.newGame(3, ['A', 'B', 'C'], { incident: 'mountain' });
  fixPeek(s);
  const F = (n) => ({ key: 'f_faith', icons: n });
  setHands(s, [[F(5), 'x_dummy'], [F(4), 'x_dummy'], ['x_dummy', 'x_dummy']]);
  pickAll(s, [0, 0, 0]);
  setHands(s, [['x_dummy'], ['x_dummy'], ['x_dummy']]);
  pickAll(s, [0, 0, 0]); // ラウンド終了（どちらも10個未満）
  assert.strictEqual(s.players[0].roundScores[0], 8, 'アイコン最多が1位');
  assert.strictEqual(s.players[1].roundScores[0], 5, '2番目が2位');
  assert.strictEqual(s.players[2].roundScores[0], 0, '信仰なしは0点');
});

test('風神録: ラウンド結果の内訳合計がラウンド点と一致する（信仰を含む）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  fixPeek(s);
  setHands(s, [[{ key: 'f_faith', icons: 5 }, 'x_dummy'], [DM, DM]]);
  pickAll(s, [0, 0]);
  setHands(s, [['x_dummy'], [DM]]);
  pickAll(s, [0, 0]); // ラウンド終了（信仰5個 → ラウンド終了時に順位点）
  const r = s.roundBanner.results[0];
  const cardSum = (r.cards || []).reduce((a, c) => a + (c.pts || 0), 0);
  const extraSum = (r.extras || []).reduce((a, e) => a + (e.pts || 0), 0);
  assert.strictEqual(cardSum + extraSum, r.points, 'カード＋内訳＝ラウンド点');
  assert.ok((r.extras || []).some((e) => e.key === 'f_faith'), '信仰の得点が内訳に出る');
});

test('風神録: 早苗=枚数ぶん奇跡が起きる（1枚ずつ消費）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  fixPeek(s);
  cycle(s, [['f_sanae', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_sanae', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_kanako', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_kanako'], ['x_dummy']], [0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]); // ラウンド終了
  // 早苗2 + 神奈子9 + 神奈子9 = 20（3倍が重なって9倍にはならない）
  assert.strictEqual(s.players[0].roundScores[0], 20);
});

test('風神録: 早苗→早苗→神奈子→諏訪子で 1枚目が神奈子・2枚目が諏訪子を3倍', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  fixPeek(s);
  cycle(s, [['f_sanae', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_sanae', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_kanako', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['f_suwako', 'x_dummy'], ['x_dummy', 'x_dummy']], [0, 0]);
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  // 早苗1+早苗1 + 神奈子9 + 諏訪子6 = 17
  assert.strictEqual(s.players[0].roundScores[0], 17);
});

test('風神録: 犬走椛=0枚−3点／奇数0点／偶数+5点', () => {
  const mk = (n) => {
    const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
    for (let i = 0; i < n; i++) s.players[0].desserts.push(inst('f_momiji'));
    for (let r = 0; r < 3; r++) {
      setHands(s, [[DM, DM], [DM, DM]]);
      pickAll(s, [0, 0]);
      setHands(s, [[DM], [DM]]);
      pickAll(s, [0, 0]);
    }
    return Engine.gameEndBreakdown(s, 0).filter((x) => x.key === 'f_momiji').reduce((a, b) => a + b.pts, 0);
  };
  assert.strictEqual(mk(0), -3);
  assert.strictEqual(mk(1), 0);
  assert.strictEqual(mk(2), 5);
  assert.strictEqual(mk(3), 0);
});

test('風神録: 射命丸文=自身を山札の下へ戻し、山札の上から2枚取得する', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  s.deck = [{ key: 'f_kanako' }, { key: 'f_suwako' }, { key: 'f_sanae' }].concat(s.deck);
  setHands(s, [['f_aya', 'f_kanako', 'f_hina'], [DM, DM, DM]]);
  pickAll(s, [0, 0]); // 文を取る（選択フェーズは出ない）
  assert.strictEqual(s.phase, 'pick', '追加選択は不要');
  const taken = s.players[0].taken.map((x) => x.key);
  assert.deepStrictEqual(taken, ['f_kanako', 'f_suwako'], '山札の上2枚を取得');
  assert.strictEqual(s.players[0].taken.some((x) => x.key === 'f_aya'), false, '文は手元に残らない');
  assert.strictEqual(s.deck[s.deck.length - 1].key, 'f_aya', '文は山札の下へ');
  assert.strictEqual(s.players[0].hand.length, 2, '手札は減るだけ（補充しない）');
});

test('風神録: 射命丸文=山札から出た文は連鎖しない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  s.deck = [{ key: 'f_aya' }, { key: 'f_suwako' }].concat(s.deck);
  setHands(s, [['f_aya', 'f_kanako', 'f_hina'], [DM, DM, DM]]);
  pickAll(s, [0, 0]);
  const ayas = s.players[0].taken.filter((x) => x.key === 'f_aya').length;
  assert.strictEqual(ayas, 1, '山札から出た文は手元に残るだけ（効果なし）');
});


















// ================= 保存則・春指標（2026-11 レビュー対応） =================

test('春: 春アイコンは判定と表示で同一の指標を使う（全ラウンド）', () => {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident: 'spring' });
  fixPeek(s);
  const check = () => {
    for (let pi = 0; pi < 4; pi++) {
      const p = s.players[pi];
      // 表示用の roundStats.springIcons と、判定用の springIconTotal が同じ入力を指していること。
      // 破棄/裏返し/コピーされた春カードが生まれると、この等式が崩れてテストが落ちる（M5 の再発検知）
      assert.strictEqual(
        Engine.springIconTotal(s, p),
        Math.max(0, s.roundStats[pi].springIcons - Engine.lettyPairReduction(s, p)),
        `R${s.round + 1} 席${pi}: springIconTotal（判定用）が roundStats.springIcons（表示用）と一致`,
      );
    }
  };
  let guard = 0;
  while (s.phase !== 'over' && guard++ < 2000) {
    if (s.phase === 'select') {
      for (const pi of s.selectNeeded) {
        if (s.selections[pi] === null) Engine.dispatch(s, { kind: 'choose', pi, choice: AI.selectChoice(s, pi) });
      }
    } else {
      for (let pi = 0; pi < 4; pi++) aiDispatch(s, pi);
    }
    // 終局後は taken だけが空になり roundStats は最終ラウンドの値が残る（dealRound が来ない）ため対象外
    if (s.phase !== 'over') check();
  }
  assert.strictEqual(s.phase, 'over');
});

test('保存則: 全異変・全人数でラウンド境界のカード枚数が変わらない', () => {
  const res = Consistency.check({ playerCounts: [2, 3, 4], seeds: [1, 2, 3] });
  const detail = res.violations
    .slice(0, 3)
    .map((v) => `${v.incident} ${v.playerCount}人 seed${v.seed} ${v.tag}: `
      + v.diff.map((d) => `${d.key} 期待${d.expected} 実際${d.actual}`).join(' / '))
    .join(' | ');
  assert.strictEqual(res.violations.length, 0, `保存則違反 ${res.violations.length} 件: ${detail}`);
  assert.ok(res.games >= 36, `検査したゲーム数 ${res.games}`);
});

test('永夜: 慧音のコピーはラウンド中だけ存在し、ラウンド末に消える（山札が膨らまない）', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal' });
  fixPeek(s);
  setHands(s, [['y_kaguya', DY], [DY, DY]]);
  pickAll(s, [0, 0]); // 先に輝夜を取る（コピー対象ができる）
  setHands(s, [['y_keine', DY], [DY, DY]]);
  pickAll(s, [0, 0]); // 慧音 → コピーの選択フェーズ
  assert.strictEqual(s.phase, 'select');
  const beforeCopy = Zones.countAll(s).y_kaguya; // コピー前の実枚数（setHands の注入分もここで吸収）
  const idx = s.players[0].taken.findIndex((i) => i.key === 'y_kaguya');
  const r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { copy: idx } });
  assert.ok(r.ok, r.error);
  const copies = s.players[0].taken.filter((i) => i.copied);
  assert.strictEqual(copies.length, 1, 'コピーが 1 枚できている');
  assert.strictEqual(copies[0].key, 'y_kaguya');
  assert.strictEqual(Zones.countAll(s).y_kaguya, beforeCopy + 1, 'ラウンド中は判定用に 1 枚多い');
  // ラウンドを閉じる
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  assert.strictEqual(s.players[0].taken.length, 0);
  assert.strictEqual(Zones.countAll(s).y_kaguya, beforeCopy, 'ラウンド末にコピーは消える（山札へ戻らない）');
});

test('永夜: 裏返したカードをコピーすると 2 点だけのカードになる', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'eternal' });
  fixPeek(s);
  setHands(s, [['y_kaguya', DY], [DY, DY]]);
  pickAll(s, [0, 0]); // 輝夜（即時 3 点）を取る
  setHands(s, [['y_mystia', DY], [DY, DY]]);
  pickAll(s, [0, 0]); // ミスティア → 裏返しの選択
  assert.strictEqual(s.phase, 'select');
  const ki = s.players[0].taken.findIndex((i) => i.key === 'y_kaguya');
  let r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { flip: [ki] } });
  assert.ok(r.ok, r.error);
  assert.strictEqual(s.players[0].taken[ki].flipped, true, '輝夜が裏返っている');

  setHands(s, [['y_keine', DY], [DY, DY]]);
  pickAll(s, [0, 0]); // 慧音 → コピーの選択
  assert.strictEqual(s.phase, 'select');
  r = Engine.dispatch(s, { kind: 'choose', pi: 0, choice: { copy: ki } });
  assert.ok(r.ok, r.error);
  const copy = s.players[0].taken.find((i) => i.copied);
  assert.ok(copy, 'コピーが 1 枚できている');
  assert.strictEqual(copy.key, 'y_kaguya');
  assert.strictEqual(copy.flipped, true, '裏返したカードのコピーは裏返しになる');

  // ラウンド末: 裏返し 2 枚（輝夜＋コピー）× 2 点だけ。輝夜の 3 点も、コピーで 3 点を稼ぐこともない
  cycle(s, [['x_dummy'], ['x_dummy']], [0, 0]);
  assert.strictEqual(s.players[0].taken.length, 0, 'ラウンド末にコピーは消える');
  assert.strictEqual(s.players[0].roundScores[0], 4, '裏返しコピーは 2 点だけ（実カードの価値は乗らない）');
});

test('風神録: にとりが破棄されていたら名前指定は出ない', () => {
  const s = Engine.newGame(2, ['A', 'B'], { incident: 'mountain' });
  fixPeek(s);
  setHands(s, [['f_nitori', 'x_dummy'], ['x_dummy', 'x_dummy']]);
  pickAll(s, [0, 0]);
  const ni = s.players[0].taken.find((i) => i.key === 'f_nitori');
  assert.ok(ni, 'にとりを取得');
  // 通常は次の取得後に名前指定が出る
  s.players[0].nitoriReady = true;
  assert.strictEqual(Engine.selectionNeeded(s, 0).swapNamed, true);
  // 破棄されていたら出さない（フラン破棄との組み合わせは将来の異変追加で起こり得る）
  ni.discarded = true;
  s.players[0].nitoriReady = true;
  assert.strictEqual(Engine.selectionNeeded(s, 0).swapNamed, false, '破棄済みのにとりでは発動しない');
  assert.strictEqual(s.players[0].nitoriReady, false, '使えないフラグは落とす');
});

test('風神録で4人AI完走（にとりの名前指定＝Math.random を含む現役経路）', () => {
  fullRun('mountain', null);
});

console.log(`\
${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
