'use strict';

// 対戦のフルゲーム・エンドツーエンドテスト。node tools/ws-game-test.js
//
// 3 クライアントで 3 ラウンドを完走し、以下をサーバー経由で検証する:
//   - 各クライアントが自分の手札だけを見ている（他人の手札が漏れない）
//   - ラウンド結果バナーが出て、「次へ」で閉じる
//   - 途中で切断した席が猶予後に AI 代行されて進行が止まらない
//   - 同じ playerId で再接続すると元の席に戻り、そのまま最後まで打てる
//   - 最後までエラーが返らない（重複ピック・不明な行動などが無い）

process.env.PORT = process.env.PORT || '3117';
// 退席 → AI 代行までの猶予を短くしてテストする
process.env.DISCONNECT_GRACE_MS = process.env.DISCONNECT_GRACE_MS || '400';

const { WebSocket } = require('ws');
const srv = require('../server.js');

const PORT = Number(process.env.PORT);
const URL = 'ws://localhost:' + PORT + '/ws';
const TICK_MS = 15;

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
  console.log('  ok -', msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(TICK_MS);
  }
  throw new Error('timeout waiting for: ' + label);
}

// 1 クライアント。state が届くたびに「自分に必要な行動」を 1 つだけ送る
function makeClient(name) {
  const ws = new WebSocket(URL);
  const c = {
    name,
    ws,
    seat: null,
    playerId: null,
    view: null,
    joined: null,
    errors: [],
    banners: new Set(),
    continued: new Set(),
    continueTimes: new Map(),
    gameover: 0,
    handLeak: false,
    pendingPickSeq: null,
    pendingSelectKey: null,
  };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'joined') {
      c.seat = m.seat;
      c.playerId = m.playerId;
      c.joined = m;
    } else if (m.type === 'state') {
      c.view = m.view;
      checkPrivacy(c);
      act(c);
    } else if (m.type === 'error') {
      c.errors.push(m.message);
    } else if (m.type === 'gameover') {
      c.gameover += 1;
    }
  });

  c.open = () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  c.send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  c.close = () => { try { ws.close(); } catch { /* noop */ } };
  return c;
}

// 他人の手札は常に空配列 + 枚数だけが届く（view の契約）
function checkPrivacy(c) {
  const v = c.view;
  if (!v || !Array.isArray(v.players)) return;
  for (let i = 1; i < v.players.length; i++) {
    if ((v.players[i].hand || []).length !== 0) c.handLeak = true;
  }
}

function act(c) {
  const v = c.view;
  if (!v) return;

  // ラウンド結果バナー: 記録して「次へ」。取りこぼしに備えて 500ms 経過していたら送り直す
  // （continueAfterRound は Set 加算なので再送しても安全）
  if (v.roundBanner) {
    const r = v.roundBanner.round;
    c.banners.add(r);
    if (v.phase !== 'over') {
      const last = c.continueTimes.get(r) || 0;
      if (Date.now() - last > 500) {
        c.continueTimes.set(r, Date.now());
        c.continued.add(r);
        c.send({ type: 'continue' });
      }
    }
    return;
  }
  if (v.phase === 'over') return;

  // 取得時選択: 自分が対象なら 1 回だけ答える（山札確認は先頭を取る）。
  // 小悪魔の連鎖などで同じ手番のうちに選択フェーズが開き直るので、何回目か（selectSeq）までキーに含める
  if (v.phase === 'select') {
    if (!Array.isArray(v.selectNeeded) || !v.selectNeeded.includes(0)) return;
    const key = `${v.round}:${v.pickSeq}:select:${v.selectSeq || 0}`;
    if (c.pendingSelectKey === key) return;
    c.pendingSelectKey = key;
    const choice = {};
    if (Array.isArray(v.peekNeeded) && v.peekNeeded[0] && v.peekCards && Array.isArray(v.peekCards[0]) && v.peekCards[0].length) {
      choice.pick = 0;
    }
    c.send({ type: 'action', action: { kind: 'choose', choice } });
    return;
  }

  // ピック: 同じ手番で二重に送らない（他人の行動による state でも再送しない）
  if (v.phase !== 'pick' || v.picks[0] !== false) return;
  if (c.pendingPickSeq === v.pickSeq) return;
  c.pendingPickSeq = v.pickSeq;
  const hand = (v.players[0] && v.players[0].hand) || [];
  if (!hand.length) c.send({ type: 'action', action: { kind: 'skip' } });
  else c.send({ type: 'action', action: { kind: 'pick', idx: 0 } });
}

(async () => {
  const clients = [];
  const dump = () => {
    for (const cl of clients) {
      const v = cl.view || {};
      console.error(`  [${cl.name}] seat=${cl.seat} round=${v.round} phase=${v.phase} ` +
        `banner=${v.roundBanner ? v.roundBanner.round : null} pickSeq=${v.pickSeq} ` +
        `picks=${JSON.stringify(v.picks)} continued=${[...cl.continued].join(',')} ` +
        `errors=${JSON.stringify(cl.errors)}`);
    }
  };
  try {
    await run(clients);
  } catch (e) {
    console.error('WS GAME FAIL:', e.message);
    dump();
    process.exit(1);
  }
})();

async function run(clients) {
  const a = makeClient('A');
  const b = makeClient('B');
  const c = makeClient('C');
  clients.push(a, b, c);
  await Promise.all([a.open(), b.open(), c.open()]);
  // state の取りこぼしに備えて、定期的にも「必要な行動」を確認する（各行動は冪等にガード済み）
  const ticker = setInterval(() => { for (const cl of clients) act(cl); }, 250);

  a.send({ type: 'create', name: 'A' });
  await waitFor(() => a.joined, 4000, 'room created');
  const CODE = a.joined.roomCode;

  b.send({ type: 'join', code: CODE, name: 'B' });
  c.send({ type: 'join', code: CODE, name: 'C' });
  await waitFor(() => b.joined && c.joined, 4000, 'two guests joined');
  assert(a.seat === 0 && b.seat === 1 && c.seat === 2, '3 人が席 0/1/2 に入る');

  a.send({ type: 'setSettings', settings: { timerSeconds: 0, incident: 'scarlet' } });
  a.send({ type: 'start' });
  await waitFor(() => a.view && a.view.phase === 'pick', 4000, 'game started');
  assert(a.view.playerCount === 3 && b.view.playerCount === 3, '3 人で開始');
  assert(a.view.deck.length === 0 && a.view.deckCount > 0, '山札の中身は配られない');

  // ラウンド 1 を完了まで打つ（バナーが出たら全員クリック）
  await waitFor(() => a.banners.has(0) && b.banners.has(0) && c.banners.has(0), 20000, 'round 1 banner');
  assert(a.banners.has(0), 'ラウンド結果バナーが全員に出る');
  // 「round 1 かつバナー無し」は一瞬しか続かない（そのまま次のラウンドが進行する）ので、
  // 「ラウンド 0 のバナーが消えた」という単調な条件で待つ
  await waitFor(() => !!a.view && (!a.view.roundBanner || a.view.roundBanner.round > 0), 15000, 'round 0 banner cleared');
  assert(true, 'バナーの「次へ」で次のラウンドが始まる');

  // 切断 → 猶予後に AI が代行して進行が止まらない
  const seqBefore = a.view.pickSeq;
  c.close();
  await sleep(900); // DISCONNECT_GRACE_MS(400ms) を超える
  await waitFor(() => a.view.pickSeq > seqBefore, 15000, 'progress without C');
  assert(true, '切断した席は AI 代行で進む（進行が止まらない）');

  // 同じ playerId で再接続 → 元の席に戻る
  const c2 = makeClient('C');
  clients.push(c2);
  await c2.open();
  c2.send({ type: 'join', code: CODE, name: 'C', playerId: c.playerId });
  await waitFor(() => c2.joined, 4000, 'reconnect');
  assert(c2.joined.reconnected === true && c2.joined.seat === 2, '再接続で元の席（2）に戻る');
  await waitFor(() => c2.view, 4000, 'state after reconnect');
  assert(Array.isArray(c2.view.players[0].hand), '再接続直後に自分の手札が届く');

  // 最後まで打ち切る
  await waitFor(() => a.view.phase === 'over' && b.view.phase === 'over' && c2.view.phase === 'over', 60000, 'game over');
  assert(true, '3 ラウンドを完走して終局する');
  assert(a.banners.has(2) && b.banners.has(2) && c2.banners.has(2), '最終ラウンドのバナーも出る');
  assert(a.gameover >= 1 && b.gameover >= 1 && c2.gameover >= 1, 'gameover が全員に届く');

  // 点数が破綻していない（ルールテストと同じ下限）
  const totals = [0, 1, 2].map((pi) => a.view.players[pi].roundScores.reduce((x, y) => x + y, 0));
  assert(totals.every((t) => Number.isFinite(t) && t > -100), '合計点が破綻していない: ' + totals.join(' / '));

  // エラー・秘匿漏れが無い
  for (const cl of [a, b, c2]) {
    assert(cl.errors.length === 0, `${cl.name} にエラーが返らない` + (cl.errors.length ? ': ' + cl.errors.join(' / ') : ''));
    assert(cl.handLeak === false, `${cl.name} から他人の手札が見えない`);
  }

  for (const cl of [a, b, c2]) cl.close();
  assert(srv.rooms.has(CODE), 'ルームは終局後も残る（再接続できる）');

  clearInterval(ticker);
  console.log('WS GAME OK');
  process.exit(0);
}
