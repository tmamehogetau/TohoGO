'use strict';

// 対戦用ルーム管理（サーバー権威）。
// 1 ルーム = 1 ゲーム。エンジンはサーバーで回し、クライアントには
// 「自分の席を 0 番に回転させた state」を返す（UI が席0前提のため）。
// 隠すもの: 他人の手札・山札の中身・デザートプールの中身・未公開のピック/選択・peek 候補。

const crypto = require('crypto');
const Engine = require('./engine.js');
const AI = require('./ai.js');

const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(rooms) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// 自分の席を 0 番に回転させた state を作る。
// 配列（players / picks / lastPicks / roundBanner.results / roundStats）をすべて同じ規則で回す。
function viewFor(room, seat) {
  const state = room.state;
  const n = state.playerCount;
  const rot = (i) => (i - seat + n) % n;
  const order = Array.from({ length: n }, (_, i) => (seat + i) % n);
  // うどんげの幻覚中は、幻覚を出した本人以外には本物のカードを見せない
  const hideForViewer = !!state.hidden && seat !== state.hiddenOwner;
  const maskInst = (inst) => {
    if (!hideForViewer || !inst.hiddenTaken) return inst;
    return { key: 'y_reisen', icons: 1, hiddenTaken: true };
  };

  const players = order.map((oi) => {
    const p = state.players[oi];
    const s = room.seats[oi];
    return {
      name: p.name,
      hand: oi === seat ? p.hand.slice() : [],
      handCount: p.hand.length,
      taken: p.taken.map(maskInst),
      desserts: p.desserts,
      gameEndCounts: p.gameEndCounts,
      chopsticks: p.chopsticks,
      roundScores: p.roundScores,
      connected: !!(s && s.connected),
      seat: oi,
    };
  });

  const view = {
    playerCount: n,
    handSize: state.handSize,
    players,
    dessert: state.dessert,
    incidentId: state.incidentId,
    incidentName: state.incidentName,
    incidentSubtitle: state.incidentSubtitle,
    incidentTheme: state.incidentTheme,
    cardMap: state.cardMap,
    initialCounts: state.initialCounts,
    intruderKey: state.intruderKey,
    round: state.round,
    passDir: state.passDir,
    phase: state.phase,
    lastPicks: state.lastPicks.map((lp) => ({
      pi: rot(lp.pi),
      keys: hideForViewer && lp.pi !== state.hiddenOwner ? lp.keys.map(() => 'y_reisen') : lp.keys,
    })),
    pickSeq: state.pickSeq || 0,
    roundBanner: state.roundBanner
      ? {
          round: state.roundBanner.round,
          results: state.roundBanner.results.map((r) => ({ ...r, pi: rot(r.pi) })),
        }
      : null,
    log: state.log,
    hidden: state.hidden,
    hiddenOwner: state.hiddenOwner === undefined || state.hiddenOwner === null ? null : rot(state.hiddenOwner),
    roundStats: order.map((oi) => state.roundStats[oi]),
    // 未公開情報はフラグだけ返す
    picks: order.map((oi) => state.picks[oi] !== null),
    choices: order.map((oi) => !!(state.choices && state.choices[oi] !== null)),
    selections: state.selections ? order.map((oi) => state.selections[oi] !== null) : null,
    selectNeeded: state.selectNeeded
      ? (state.selectNeeded.includes(seat) && state.selections && state.selections[seat] === null ? [0] : [])
      : null,
    // 山札・プールは枚数のみ
    deck: [],
    deckCount: state.deck.length,
    dessertPool: [],
    dessertPoolCount: state.dessertPool.length,
    // 山札確認（小悪魔）は自分の候補だけ
    peekNeeded: state.peekNeeded ? [!!state.peekNeeded[seat]] : null,
    peekCards: state.peekCards ? [state.peekCards[seat] || null] : null,
    mySeat: 0,
    roomCode: room.code,
  };
  return view;
}

class Room {
  constructor(code) {
    this.code = code;
    this.seats = []; // [{ id, name, connected, isHost }] 添字 = 席番号
    this.sockets = new Map(); // seat -> ws
    this.state = null;
    this.started = false;
    this.continueReady = new Set();
    this.lastActivity = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  lobby() {
    return {
      type: 'lobby',
      roomCode: this.code,
      started: this.started,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.seats.map((s, i) => ({ seat: i, name: s.name, connected: s.connected, isHost: s.isHost })),
    };
  }

  // 戻り値: { ok:true, seat, playerId, isHost, reconnected } / { ok:false, error }
  join(name, playerId) {
    this.touch();
    const trimmed = String(name || '').trim().slice(0, 12);
    if (!trimmed) return { ok: false, error: '名前を入力してください' };

    if (playerId) {
      const seat = this.seats.findIndex((s) => s.id === playerId);
      if (seat >= 0) {
        if (this.seats.some((s, i) => i !== seat && s.connected && s.name === trimmed)) {
          return { ok: false, error: 'その名前は既に使われています' };
        }
        this.seats[seat].connected = true;
        this.seats[seat].name = trimmed;
        return { ok: true, seat, playerId, isHost: this.seats[seat].isHost, reconnected: true };
      }
    }

    if (this.started) return { ok: false, error: 'ゲーム開始後は新規参加できません' };
    if (this.seats.length >= MAX_PLAYERS) return { ok: false, error: 'ルームが満員です' };
    if (this.seats.some((s) => s.name === trimmed)) return { ok: false, error: 'その名前は既に使われています' };

    const id = crypto.randomUUID();
    const isHost = this.seats.length === 0;
    this.seats.push({ id, name: trimmed, connected: true, isHost });
    return { ok: true, seat: this.seats.length - 1, playerId: id, isHost, reconnected: false };
  }

  start(seat, incident) {
    this.touch();
    if (this.started) return { ok: false, error: 'すでに開始しています' };
    const s = this.seats[seat];
    if (!s || !s.isHost) return { ok: false, error: 'ホストのみ開始できます' };
    if (this.seats.length < MIN_PLAYERS) return { ok: false, error: `${MIN_PLAYERS}人以上で開始できます` };
    if (this.seats.some((x) => !x.connected)) return { ok: false, error: '全員の接続を待っています' };
    const names = this.seats.map((x) => x.name);
    const opts = incident ? { incident } : {};
    this.state = Engine.newGame(names.length, names, opts);
    if (!this.state) return { ok: false, error: 'ゲーム作成に失敗しました' };
    this.started = true;
    return { ok: true };
  }

  // 自分の席の行動を適用。pi はサーバー側の席番号（クライアントは送らない）
  act(seat, action) {
    this.touch();
    if (!this.state) return { ok: false, error: 'ゲームが始まっていません' };
    if (this.state.phase === 'over') return { ok: false, error: 'ゲームは終了しています' };
    if (!action || typeof action !== 'object') return { ok: false, error: '行動が不正です' };

    if (this.state.phase === 'select') {
      if (action.kind !== 'choose') return { ok: false, error: 'いまは取得時選択のフェーズです' };
      if (!stateIncludesSelection(this.state, seat)) return { ok: false, error: '選択の必要がありません' };
      const res = Engine.dispatch(this.state, { kind: 'choose', pi: seat, choice: action.choice || {} });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }

    if (this.state.phase !== 'pick') return { ok: false, error: 'いまはピックのフェーズではありません' };
    if (this.state.picks[seat] !== null) return { ok: false, error: 'すでに選択済みです' };

    let engineAction;
    if (action.kind === 'pick2') engineAction = { kind: 'pick2', pi: seat, idxs: action.idxs };
    else if (action.kind === 'pick') engineAction = { kind: 'pick', pi: seat, idx: action.idx };
    else if (action.kind === 'skip') engineAction = { kind: 'skip', pi: seat };
    else return { ok: false, error: '未対応の行動です' };

    const res = Engine.dispatch(this.state, engineAction);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  // ラウンド結果バナーの「次へ」。接続中の全員が押したら閉じる
  continueAfterRound(seat) {
    this.touch();
    if (!this.state || !this.state.roundBanner) return { ok: false, error: 'ラウンド結果がありません' };
    this.continueReady.add(seat);
    const connected = this.seats.map((s, i) => (s.connected ? i : -1)).filter((i) => i >= 0);
    if (connected.every((i) => this.continueReady.has(i))) {
      this.state.roundBanner = null;
      this.continueReady.clear();
    }
    return { ok: true };
  }

  disconnect(seat) {
    const s = this.seats[seat];
    if (!s) return;
    s.connected = false;
    this.touch();
    // ホスト切断時は接続中の次の人へ移譲
    if (s.isHost) {
      const next = this.seats.find((x) => x.connected);
      if (next) { s.isHost = false; next.isHost = true; }
    }
  }

  view(seat) {
    return this.state ? viewFor(this, seat) : null;
  }

  needsAction(seat) {
    if (!this.state) return false;
    if (this.state.phase === 'pick') return this.state.picks[seat] === null;
    if (this.state.phase === 'select') return stateIncludesSelection(this.state, seat) && this.state.selections[seat] === null;
    return false;
  }

  // 切断中の席を AI で埋める（ゲーム停止を防ぐ）
  autoPlayDisconnected() {
    if (!this.state) return false;
    let acted = false;
    for (let seat = 0; seat < this.seats.length; seat++) {
      const s = this.seats[seat];
      if (s.connected || !this.needsAction(seat)) continue;
      if (this.state.phase === 'select') {
        Engine.dispatch(this.state, { kind: 'choose', pi: seat, choice: AI.selectChoice(this.state, seat) });
        acted = true;
      } else if (this.state.phase === 'pick') {
        const use2 = this.state.players[seat].chopsticks > 0 && this.state.players[seat].hand.length >= 2;
        const idxs = use2 ? AI.pick2(this.state, seat) : AI.pick(this.state, seat);
        if (idxs.length === 0) Engine.dispatch(this.state, { kind: 'skip', pi: seat });
        else if (idxs.length === 2) Engine.dispatch(this.state, { kind: 'pick2', pi: seat, idxs });
        else Engine.dispatch(this.state, { kind: 'pick', pi: seat, idx: idxs[0] });
        acted = true;
      }
    }
    return acted;
  }
}

function stateIncludesSelection(state, seat) {
  return !!(state.selectNeeded && state.selectNeeded.includes(seat));
}

module.exports = { Room, viewFor, makeCode, MAX_PLAYERS, MIN_PLAYERS };
