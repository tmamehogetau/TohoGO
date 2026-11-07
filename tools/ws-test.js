'use strict';

// 対戦サーバーのヘッドレス・スモークテスト。
// node tools/ws-test.js
// 2 クライアントで join → start → 同時ピック → 解決 → 再接続 を検証する。

process.env.PORT = process.env.PORT || '3115';
const { WebSocket } = require('ws');
const srv = require('../server.js');

const PORT = Number(process.env.PORT);

function connect() {
  const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
  const buf = [];
  const waiters = [];
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
    }
    buf.push(m);
  });
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    drain: () => { buf.length = 0; },
    next: (match) => {
      const idx = buf.findIndex(match);
      if (idx >= 0) return Promise.resolve(buf.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timeout waiting for message'));
        }, 5000);
        waiters.push(w);
      });
    },
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
  console.log('  ok -', msg);
}

const isState = (m) => m.type === 'state';

(async () => {
  const a = connect();
  await a.open();
  a.send({ type: 'join', code: 'TEST', name: 'A' });
  const j1 = await a.next((m) => m.type === 'joined');
  assert(j1.seat === 0 && j1.isHost, 'host got seat 0');
  assert(j1.roomCode === 'TEST', 'room code kept as requested');

  const b = connect();
  await b.open();
  b.send({ type: 'join', code: 'TEST', name: 'B' });
  const j2 = await b.next((m) => m.type === 'joined');
  assert(j2.seat === 1 && !j2.isHost, 'guest got seat 1');

  a.send({ type: 'start', incident: 'scarlet' });
  const sa = (await a.next(isState)).view;
  const sb = (await b.next(isState)).view;

  assert(sa.players[0].name === 'A' && sa.players[0].hand.length === 10, 'A sees own 10 cards（2人=10枚）');
  assert(sa.players[1].hand.length === 0 && sa.players[1].handCount === 10, 'B hand hidden from A');
  assert(sb.players[0].name === 'B' && sb.players[0].hand.length === 10, 'B view rotated (self = index 0)');
  assert(sb.players[1].hand.length === 0, 'A hand hidden from B');
  assert(sa.deck.length === 0 && sa.deckCount > 0, 'deck contents hidden');
  assert(!sa.choices.some((c) => typeof c === 'object' && c !== null), 'choices not leaked');

  a.drain(); b.drain();
  a.send({ type: 'action', action: { kind: 'pick', idx: 0 } });
  const pa = (await a.next(isState)).view;
  assert(pa.picks[0] === true, 'A pick marked submitted');
  assert(pa.picks[1] === false, 'B pick still pending');

  const errP = a.next((m) => m.type === 'error');
  a.send({ type: 'action', action: { kind: 'pick', idx: 1 } });
  const err = await errP;
  assert(/選択済み/.test(err.message), 'duplicate pick rejected: ' + err.message);

  a.drain(); b.drain();
  b.send({ type: 'action', action: { kind: 'pick', idx: 0 } });
  const ra = (await a.next((m) => isState(m) && m.view.lastPicks.length === 2)).view;
  assert(ra.lastPicks.length === 2, 'both picks revealed after resolution');
  assert(ra.players[0].hand.length === 9, 'A hand went from 10 to 9');
  assert(ra.pickSeq === 1, 'pickSeq advances on resolution (UI animation trigger)');

  // 再接続: B が切れて、同じ playerId で入り直す
  b.ws.close();
  await new Promise((r) => setTimeout(r, 150));
  const b2 = connect();
  await b2.open();
  b2.send({ type: 'join', code: 'TEST', name: 'B', playerId: j2.playerId });
  const j3 = await b2.next((m) => m.type === 'joined');
  assert(j3.seat === 1 && j3.reconnected === true, 'reconnect restores seat 1');
  const sb2 = (await b2.next(isState)).view;
  assert(sb2.players[1].handCount === 9, 'reconnected client gets current state');

  // ルーム設定（異変・取得時間）と手番タイマー
  const s1 = connect();
  await s1.open();
  s1.send({ type: 'join', code: 'SET1', name: 'H' });
  await s1.next((m) => m.type === 'joined');
  const s2 = connect();
  await s2.open();
  s2.send({ type: 'join', code: 'SET1', name: 'G' });
  await s2.next((m) => m.type === 'joined');

  s1.send({ type: 'setSettings', settings: { timerSeconds: 30, incident: 'scarlet' } });
  const lb = await s1.next((m) => m.type === 'lobby' && m.settings && m.settings.timerSeconds === 30);
  assert(lb && lb.settings.incident === 'scarlet', 'host can set timer + incident');

  s1.send({ type: 'setSettings', settings: { timerSeconds: 45 } });
  const eTimer = await s1.next((m) => m.type === 'error');
  assert(/30秒/.test(eTimer.message), 'invalid timer rejected: ' + eTimer.message);

  s2.send({ type: 'setSettings', settings: { timerSeconds: 0 } });
  const eGuest = await s2.next((m) => m.type === 'error');
  assert(/マスター/.test(eGuest.message), 'guest cannot change settings');

  s1.drain(); s2.drain();
  s1.send({ type: 'start' });
  const st = (await s1.next(isState)).view;
  assert(st.incidentId === 'scarlet', 'start uses room incident setting');

  const room = srv.rooms.get('SET1');
  room.clearTimer();
  room.settings.timerSeconds = 1;
  room.armTimer();
  const auto = await s1.next((m) => isState(m) && m.view.pickSeq >= 1);
  assert(!!auto, 'pick timer auto-plays when expired');


  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = connect();
  await h.open();
  h.send({ type: 'join', code: 'GHOST', name: 'H' });
  await h.next((m) => m.type === 'joined');
  const g1 = connect();
  await g1.open();
  g1.send({ type: 'join', code: 'GHOST', name: 'G1' });
  await g1.next((m) => m.type === 'joined');
  const g2 = connect();
  await g2.open();
  g2.send({ type: 'join', code: 'GHOST', name: 'G2' });
  await g2.next((m) => m.type === 'joined');
  g2.ws.close();
  await delay(200);
  h.send({ type: 'start', incident: 'scarlet' });
  const sh = (await h.next(isState)).view;
  assert(sh.playerCount === 3, 'ghost seat is included and game starts');
  const sp = await h.next((m) => isState(m) && m.view.picks[2] === true);
  assert(!!sp, 'disconnected seat auto-plays (AI代行)');

  // うどんげの幻覚: 幻覚中は本人以外のビューから本物のカードが消える（単体）
  const { viewFor } = require('../room.js');
  const mkPlayer = (name, taken) => ({
    name, hand: [], taken, desserts: [], gameEndCounts: {}, chopsticks: 0, roundScores: [0, 0, 0],
  });
  const fakeState = {
    playerCount: 2, handSize: 10,
    players: [
      mkPlayer('A', [{ key: 's_spring', icons: 2, hiddenTaken: true, hiddenBy: 1 }]),
      mkPlayer('B', []),
    ],
    dessert: { key: 'k_cirno' }, incidentId: 'spring', incidentName: 'x', incidentSubtitle: 'x', incidentTheme: 'x',
    cardMap: {}, initialCounts: {}, intruderKey: null, round: 0, passDir: 1, phase: 'pick',
    lastPicks: [{ pi: 0, keys: ['s_spring'] }, { pi: 1, keys: ['k_maid'] }],
    roundBanner: null, log: [], hidden: true, hiddenOwner: 1,
    roundStats: [
      { springIcons: 5, dessertTaken: 1 },
      { springIcons: 1, dessertTaken: 0 },
    ],
    picks: [null, null], choices: [null, null],
    selections: null, selectNeeded: null, deck: [], dessertPool: [], peekNeeded: null, peekCards: null,
  };
  const fakeRoom = { code: 'X', seats: [{ connected: true }, { connected: true }], state: fakeState };
  const v0 = viewFor(fakeRoom, 0); // seat0 = 幻覚をかけられた側
  const v1 = viewFor(fakeRoom, 1); // seat1 = うどんげを出した本人
  assert(v0.players[0].taken[0].key === 'y_reisen', 'hidden card masked for non-owner');
  assert(v0.lastPicks[0].keys[0] === 'y_reisen', 'lastPicks masked for non-owner');
  assert(v1.players[1].taken[0].key === 's_spring', 'hidden card visible to the player who played it');
  // うどんげの上にアイコン・点数が出ると中身がバレるので、マスク時は icons を持たせない
  assert(v0.players[0].taken[0].icons === undefined, 'masked card has no icon count');
  assert(v0.players[0].taken[0].masked === true, 'masked card is flagged as masked');
  // 幻覚中は隠した分を差し引いた集計だけを見せる
  assert(v0.roundStats[0].springIcons === 3, 'hidden spring icons deducted for non-owner');
  assert(v0.roundStats[0].dessertTaken === 1, 'visible dessert count kept');
  assert(v1.roundStats[1].springIcons === 5, 'the player who played it keeps the real count');
  // 免疫は出した手番だけ: 別の手番で隠されたカードは、前の出し主からも見えない
  fakeState.players[1].taken.push({ key: 'k_maid', hiddenTaken: true, hiddenBy: 0 });
  const v1b = viewFor(fakeRoom, 1);
  assert(v1b.players[0].taken[0].key === 'y_reisen', 'immune only for the hand it was played');

  // ラウンド結果の内訳（獲得カードと配点）が view に載り、席順に回転する
  fakeState.roundBanner = {
    round: 0,
    results: [
      { pi: 0, name: 'A', points: 5, cards: [{ key: 'k_remi', icons: 1, pts: 5 }], extras: [] },
      { pi: 1, name: 'B', points: 0, cards: [], extras: [] },
    ],
  };
  const vb = viewFor(fakeRoom, 1);
  assert(vb.roundBanner.results[0].name === 'A', 'round banner keeps entries');
  assert(vb.roundBanner.results[0].pi === 1, 'round banner seat rotated for viewer');
  assert(vb.roundBanner.results[0].cards[0].key === 'k_remi', 'round banner keeps card breakdown');

  console.log('WS SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('WS SMOKE FAIL:', e.message);
  process.exit(1);
});


