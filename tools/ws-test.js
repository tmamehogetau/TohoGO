'use strict';

// 対戦サーバーのヘッドレス・スモークテスト。
// node tools/ws-test.js
// 2 クライアントで join → start → 同時ピック → 解決 → 再接続 を検証する。

process.env.PORT = process.env.PORT || '3115';
const { WebSocket } = require('ws');
require('../server.js');

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

  // ロビーで切断した席があっても開始でき、その席は AI が代行する
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
    players: [mkPlayer('A', [{ key: 'k_remi', hiddenTaken: true }]), mkPlayer('B', [])],
    dessert: { key: 'k_cirno' }, incidentId: 'scarlet', incidentName: 'x', incidentSubtitle: 'x', incidentTheme: 'x',
    cardMap: {}, initialCounts: {}, intruderKey: null, round: 0, passDir: 1, phase: 'pick',
    lastPicks: [{ pi: 0, keys: ['k_remi'] }, { pi: 1, keys: ['k_maid'] }],
    roundBanner: null, log: [], hidden: true, hiddenOwner: 1,
    roundStats: [{}, {}], picks: [null, null], choices: [null, null],
    selections: null, selectNeeded: null, deck: [], dessertPool: [], peekNeeded: null, peekCards: null,
  };
  const fakeRoom = { code: 'X', seats: [{ connected: true }, { connected: true }], state: fakeState };
  const v0 = viewFor(fakeRoom, 0); // seat0 = 幻覚をかけられた側
  const v1 = viewFor(fakeRoom, 1); // seat1 = うどんげを出した本人
  assert(v0.players[0].taken[0].key === 'y_reisen', 'hidden card masked for non-owner');
  assert(v0.lastPicks[0].keys[0] === 'y_reisen', 'lastPicks masked for non-owner');
  assert(v1.players[1].taken[0].key === 'k_remi', 'hidden card visible to owner');

  console.log('WS SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('WS SMOKE FAIL:', e.message);
  process.exit(1);
});

