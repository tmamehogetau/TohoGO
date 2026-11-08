'use strict';

// ルーム管理の単体テスト（ws を使わない）。node tools/room-test.js
// 対象: ホストの移譲・claim、view の契約（真偽値・残り時間）、開始条件、ラウンド送り。

const assert = require('assert');
const { Room, DISCONNECT_GRACE_MS } = require('../room.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (e) {
    console.error('  FAIL - ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

function twoHumans(code) {
  const r = new Room(code || 'R1');
  const a = r.join('A', null);
  const b = r.join('B', null);
  return { r, a, b };
}

// ---------------- ホストの移譲 ----------------

test('ホスト切断: AI 席にはホストを渡さない', () => {
  const r = new Room('H1');
  r.join('A', null);
  r.addAi(0);
  r.disconnect(0);
  assert.ok(!r.seats.some((s) => s.isHost && s.isAI), 'AI がホストにならない');
  // 人間の接続席が無いので、フラグは切断した人間の席に残る（戻ってきたら復帰できる）
  assert.strictEqual(r.seats[0].isHost, true);
});

test('ホスト切断: 接続中の人間がいれば、その人へ移る', () => {
  const { r } = twoHumans('H2');
  r.disconnect(0);
  assert.strictEqual(r.seats[0].isHost, false);
  assert.strictEqual(r.seats[1].isHost, true);
});

test('ホスト切断: 同じ playerId で戻るとホストが戻る', () => {
  const r = new Room('H3');
  const a = r.join('A', null);
  r.addAi(0);
  r.disconnect(0);
  const back = r.join('A', a.playerId);
  assert.ok(back.ok, back.error);
  assert.strictEqual(back.isHost, true, '再接続でホストに戻る');
});

test('ホスト切断: 名前を変えて入り直してもホストを claim して開始できる', () => {
  const r = new Room('H4');
  const a = r.join('A', null);
  r.addAi(0);
  r.disconnect(0);
  // playerId を失った（別ブラウザ・localStorage 削除・名前変更）想定で新規参加
  const c = r.join('A2', null);
  assert.ok(c.ok, c.error);
  assert.strictEqual(c.isHost, true, '接続中の人間がホストを引き継ぐ');
  assert.strictEqual(r.start(c.seat).ok, true, 'ホスト不在でルームが死なない');
  assert.ok(a.playerId);
});

test('ホスト不在のまま人間が複数入っても、ホストは 1 人だけ', () => {
  const r = new Room('H5');
  r.join('A', null);
  r.disconnect(0);
  r.join('B', null);
  r.join('C', null);
  assert.strictEqual(r.seats.filter((s) => s.isHost).length, 1, 'ホストは常に 1 人');
  assert.strictEqual(r.seats.find((s) => s.isHost).name, 'B', '最初に接続した人間が持つ');
});

// ---------------- 開始条件 ----------------

test('start: ホスト以外と人数不足を弾く', () => {
  const { r } = twoHumans('S1');
  assert.strictEqual(r.start(1).ok, false, 'ゲストは開始できない');
  assert.strictEqual(r.start(0).ok, true);
  assert.strictEqual(r.start(0).ok, false, '二重開始できない');
});

test('start: 切断中の席は AI 代行で埋まるので開始できる', () => {
  const r = new Room('S2');
  r.join('A', null);
  r.addAi(0);
  r.join('B', null);
  r.disconnect(1);
  assert.strictEqual(r.seats.filter((x) => x.connected).length, 2, 'A と AI が接続扱い');
  assert.strictEqual(r.start(0).ok, true);
});

// ---------------- view の契約 ----------------

test('view: picks / choices / selections は真偽値（オブジェクトを漏らさない）', () => {
  const { r } = twoHumans('V1');
  r.start(0);
  const v = r.view(0);
  assert.ok(v.picks.every((x) => typeof x === 'boolean'), 'picks は真偽値');
  assert.ok(v.choices.every((x) => typeof x === 'boolean'), 'choices は真偽値');
  assert.strictEqual(v.selections, null, '選択フェーズ外は null');
  r.act(0, { kind: 'pick', idx: 0 });
  const v2 = r.view(0);
  assert.strictEqual(v2.picks[0], true, '打った席は true');
  assert.strictEqual(v2.picks[1], false, 'まだの席は false');
});

test('view: 手番の残り時間はサーバーがミリ秒で渡す', () => {
  const { r } = twoHumans('V2');
  r.setSettings(0, { timerSeconds: 30 });
  r.start(0);
  r.armTimer();
  const v = r.view(0);
  assert.ok(typeof v.deadlineRemainMs === 'number', 'deadlineRemainMs が数値');
  assert.ok(v.deadlineRemainMs > 0 && v.deadlineRemainMs <= 30000, `範囲内 (${v.deadlineRemainMs})`);
  r.clearTimer();
  assert.strictEqual(r.view(0).deadlineRemainMs, null, 'タイマー無しは null');
});

test('view: 無制限モードでも deadline は null（残り時間を出さない）', () => {
  const { r } = twoHumans('V3');
  r.setSettings(0, { timerSeconds: 0 });
  r.start(0);
  r.armTimer();
  assert.strictEqual(r.view(0).deadlineRemainMs, null);
});

test('view: 退席猶予の残り時間もサーバーが渡す', () => {
  const { r } = twoHumans('V4');
  r.start(0);
  r.disconnect(1);
  const p = r.view(0).players[1];
  assert.strictEqual(p.connected, false);
  assert.ok(typeof p.disconnectRemainMs === 'number', 'disconnectRemainMs が数値');
  assert.ok(p.disconnectRemainMs > 0 && p.disconnectRemainMs <= DISCONNECT_GRACE_MS);
  // 猶予を過ぎた状態を作る
  r.seats[1].disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1000;
  assert.strictEqual(r.view(0).players[1].disconnectRemainMs, 0, '超過後は 0（負にしない）');
});

// ---------------- 進行 ----------------

test('AI 席があっても、人間の「次へ」でラウンドが閉じる', () => {
  const r = new Room('P1');
  r.join('A', null);
  r.addAi(0);
  r.start(0);
  r.state.roundBanner = { round: 0, results: [] };
  r.continueAfterRound(0);
  assert.strictEqual(r.state.roundBanner, null);
});

test('切断席は猶予後に AI が代行する（接続中の人間は対象外）', () => {
  const { r } = twoHumans('P2');
  r.start(0);
  assert.strictEqual(r.needsAction(0), true);
  r.disconnect(1);
  const delay = r.nextAutoPlayDelay();
  assert.ok(typeof delay === 'number' && delay >= 0, '切断席ぶんの待ち時間が返る');
  r.seats[1].disconnectedAt = Date.now() - DISCONNECT_GRACE_MS - 1;
  assert.strictEqual(r.autoPlayDisconnected(), true, '猶予後は代行する');
});

console.log(`\
${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
