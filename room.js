'use strict';

// 対戦用ルーム管理（サーバー権威）。
// 1 ルーム = 1 ゲーム。エンジンはサーバーで回し、クライアントには
// 「自分の席を 0 番に回転させた state」を返す（UI が席0前提のため）。
// 隠すもの: 他人の手札・山札の中身・継続カードプールの中身・未公開のピック/選択・peek 候補。

const crypto = require('crypto');
const Engine = require('./engine.js');
const AI = require('./ai.js');
const Data = require('./data.js');

const MAX_PLAYERS = 5;
// 退席してから AI が代行するまでの猶予（既定 2 分）
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 120000);
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
    if (!inst.hiddenTaken) return inst;
    // 免疫は「その手番で鈴仙を出した本人」だけ。別の手番で出した人は後から影響を受ける
    if (seat === inst.hiddenBy) return inst;
    // icons を持たせると春・玉兎のバッジで中身がバレるので、うどんげとして最小限だけ返す
    return { key: 'y_reisen', hiddenTaken: true, masked: true };
  };

  const players = order.map((oi) => {
    const p = state.players[oi];
    const s = room.seats[oi];
    // 自分に見えていない（＝他の手番で隠された）追加カードの通算は差し引く
    const maskView = (i) => i.hiddenTaken && seat !== i.hiddenBy;
    const hiddenGE = {};
    for (const i of p.taken) {
      if (!maskView(i)) continue;
      if ((state.cardMap[i.key] || {}).gameEnd) hiddenGE[i.key] = (hiddenGE[i.key] || 0) + 1;
    }
    const gameEndCounts = Object.fromEntries(
      Object.entries(p.gameEndCounts || {}).map(([k, v]) => [k, Math.max(0, v - (hiddenGE[k] || 0))]),
    );
    return {
      name: p.name,
      hand: oi === seat ? p.hand.slice() : [],
      handCount: p.hand.length,
      taken: p.taken.map(maskInst),
      desserts: p.desserts,
      gameEndCounts,
      chopsticks: p.chopsticks,
      // UI が取得時の選択（文の追加取得・にとりの調査）を描画するために必要
      scoopPending: p.scoopPending || 0,
      nitoriReady: !!p.nitoriReady,
      sanaePending: p.sanaePending || 0,
      roundScores: p.roundScores,
      connected: !!(s && s.connected),
      disconnectedAt: (s && s.disconnectedAt) || null,
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
    hidden: state.hidden,
    hiddenOwner: state.hiddenOwner === undefined || state.hiddenOwner === null ? null : rot(state.hiddenOwner),
    // 自分に見えていないカードの寄与は差し引く（バッジの数から中身がバレないように）
    roundStats: order.map((oi) => {
      const st = state.roundStats[oi];
      const p = state.players[oi];
      let hiddenIcons = 0;
      let hiddenDessert = 0;
      for (const i of p.taken) {
        if (!i.hiddenTaken || seat === i.hiddenBy) continue;
        hiddenIcons += i.icons || 0;
        if (i.key === state.dessert.key) hiddenDessert += 1;
      }
      return {
        ...st,
        springIcons: Math.max(0, st.springIcons - hiddenIcons),
        dessertTaken: Math.max(0, st.dessertTaken - hiddenDessert),
      };
    }),
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
    disconnectGraceMs: DISCONNECT_GRACE_MS,
    roomCode: room.code,
    deadline: room.deadline || null,
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
    this.settings = { timerSeconds: 60, incident: '' }; // 取得時間（0=無制限）/ ステージ（''=おまかせ）
    this.deadline = null; // 現在の手番の制限時刻（epoch ms）
    this.timerHandle = null;
    this.turnKey = null; // 手番の識別子（同じ手番ではタイマーを延長しない）
    this.onTimeout = null; // サーバーが差し込む（時間切れ時の処理）
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
      settings: { ...this.settings },
      deadline: this.deadline,
      players: this.seats.map((s, i) => ({ seat: i, name: s.name, connected: s.connected, isHost: s.isHost, isAI: !!s.isAI })),
    };
  }

  // 人数調整用の AI 席（ホストのみ・開始前のみ）
  addAi(seat) {
    this.touch();
    const host = this.seats[seat];
    if (!host || !host.isHost) return { ok: false, error: 'ルームマスターのみ AI を追加できます' };
    if (this.started) return { ok: false, error: 'ゲーム開始後は変更できません' };
    if (this.seats.length >= MAX_PLAYERS) return { ok: false, error: 'これ以上は追加できません' };
    const pool = ['霊夢', '魔理沙', '妖夢', '咲夜', 'レミリア', '紫', '幽々子', '輝夜', '永琳', 'てゐ',
      '早苗', '神奈子', '諏訪子', '萃香', '文', 'にとり', '椛', '雛', '穣子', '静葉'];
    const used = new Set(this.seats.map((s) => s.name));
    const picked = pool.find((n) => !used.has('AI・' + n));
    const name = 'AI・' + (picked || 'プレイヤー');
    this.seats.push({ id: 'ai-' + crypto.randomUUID(), name, connected: true, isHost: false, isAI: true });
    return { ok: true };
  }

  removeAi(seat) {
    this.touch();
    const host = this.seats[seat];
    if (!host || !host.isHost) return { ok: false, error: 'ルームマスターのみ AI を削除できます' };
    if (this.started) return { ok: false, error: 'ゲーム開始後は変更できません' };
    let idx = -1;
    for (let i = this.seats.length - 1; i >= 0; i--) {
      if (this.seats[i].isAI) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: 'AI がいません' };
    const humans = this.seats.filter((s) => !s.isAI).length;
    if (humans < 1) return { ok: false, error: '人間の席がありません' };
    if (this.seats.length - 1 < MIN_PLAYERS) return { ok: false, error: `${MIN_PLAYERS}人未満にはできません` };
    this.seats.splice(idx, 1);
    return { ok: true, removedSeat: idx };
  }

  // ルーム設定（ホストのみ・ゲーム開始前のみ）
  setSettings(seat, settings) {
    this.touch();
    const s = this.seats[seat];
    if (!s || !s.isHost) return { ok: false, error: 'ルームマスターのみ変更できます' };
    if (this.started) return { ok: false, error: 'ゲーム開始後は変更できません' };
    const next = { ...this.settings };
    if (settings && settings.timerSeconds !== undefined) {
      const t = Number(settings.timerSeconds);
      if (![0, 30, 60].includes(t)) return { ok: false, error: '取得時間は 30秒 / 60秒 / 無制限 から選んでください' };
      next.timerSeconds = t;
    }
    if (settings && settings.incident !== undefined) {
      const inc = String(settings.incident || '');
      if (inc !== '' && !Data.INCIDENT_IDS.includes(inc)) return { ok: false, error: 'ステージの指定が不正です' };
      next.incident = inc;
    }
    this.settings = next;
    return { ok: true };
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
        this.seats[seat].disconnectedAt = null;
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
    // 切断中の席はゲーム開始後と同じく AI が代行する（幽霊席で開始できなくならないように）
    const connected = this.seats.filter((x) => x.connected || x.isAI).length;
    if (connected < MIN_PLAYERS) return { ok: false, error: `${MIN_PLAYERS}人以上で開始できます` };
    const names = this.seats.map((x) => x.name);
    const opts = this.settings.incident ? { incident: this.settings.incident } : {};
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

    if (this.state.phase !== 'pick') return { ok: false, error: 'いまは取得のフェーズではありません' };
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
    s.disconnectedAt = Date.now();
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

  // 指定した席のうち行動待ちの人を AI で埋める
  autoPlaySeats(predicate) {
    if (!this.state) return false;
    let acted = false;
    for (let seat = 0; seat < this.seats.length; seat++) {
      if (predicate && !predicate(seat)) continue;
      if (!this.needsAction(seat)) continue;
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

  // 切断中・AI の席を AI で埋める（ゲーム停止を防ぐ）
  autoPlayDisconnected() {
    const now = Date.now();
    return this.autoPlaySeats((seat) => {
      const s = this.seats[seat];
      if (s.isAI) return true;
      if (s.connected) return false;
      return now - (s.disconnectedAt || 0) >= DISCONNECT_GRACE_MS;
    });
  }

  // 退席した席が AI 代行に切り替わるまでの残りミリ秒（該当なしは null）
  nextAutoPlayDelay() {
    if (!this.state) return null;
    let soonest = null;
    for (let i = 0; i < this.seats.length; i++) {
      if (!this.needsAction(i)) continue;
      const s = this.seats[i];
      if (s.isAI) return 250;
      if (s.connected) continue;
      const left = Math.max(0, (s.disconnectedAt || 0) + DISCONNECT_GRACE_MS - Date.now());
      soonest = soonest === null ? left : Math.min(soonest, left);
    }
    return soonest;
  }

  // 時間切れ: 接続中も含めて全員代行
  autoPlayAll() {
    return this.autoPlaySeats(() => true);
  }

  // 手番タイマー。roundBanner は 10 秒で自動的に閉じる。
  // 同じ手番の途中で誰かが行動しても延長しない（ターン開始時に1回だけセット）。
  armTimer() {
    if (!this.started || !this.state) { this.clearTimer(); this.turnKey = null; return; }
    if (this.state.phase === 'over') { this.clearTimer(); return; }
    const key = `${this.state.round}:${this.state.pickSeq || 0}:${this.state.phase}:${this.state.roundBanner ? 'B' : 'P'}`;
    if (this.turnKey === key && this.deadline) return; // 同じ手番では延長しない
    this.turnKey = key;
    if (this.timerHandle) { clearTimeout(this.timerHandle); this.timerHandle = null; }
    this.deadline = null;
    const banner = !!this.state.roundBanner;
    const sec = banner ? 10 : this.settings.timerSeconds;
    if (!sec) return;
    this.deadline = Date.now() + sec * 1000;
    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      this.deadline = null;
      if (this.onTimeout) this.onTimeout();
    }, sec * 1000);
    if (this.timerHandle.unref) this.timerHandle.unref();
  }

  clearTimer() {
    if (this.timerHandle) { clearTimeout(this.timerHandle); this.timerHandle = null; }
    this.deadline = null;
    this.turnKey = null;
  }
}

function stateIncludesSelection(state, seat) {
  return !!(state.selectNeeded && state.selectNeeded.includes(seat));
}

module.exports = { Room, viewFor, makeCode, MAX_PLAYERS, MIN_PLAYERS, DISCONNECT_GRACE_MS };



