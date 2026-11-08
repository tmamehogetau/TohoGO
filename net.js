'use strict';

// 対戦クライアント。サーバーに join し、行動を送り、届いたビューを App に渡す。
// ルームごとに playerId を localStorage に保存し、切断時は同じ id で自動再接続する。

(function () {
  let ws = null; // 現在のソケット
  let queue = []; // 未接続のあいだに送るメッセージ
  let identity = null; // { code, name, playerId }
  let pendingHello = null; // 接続直後に送る join / create
  let reconnectTimer = null;
  let attempts = 0; // 再接続の試行回数（指数バックオフ用）

  const idKey = (code, name) => `touhou:${code}:${encodeURIComponent(name)}:playerId`;
  const BACKOFF_BASE = 500;
  const BACKOFF_MAX = 15000;

  function isOpen() { return !!ws && ws.readyState === 1; }

  // localStorage はプライベートモード等で例外を投げることがある（無くても動かす）
  function storeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* noop */ }
  }

  function appFn(name, arg) {
    if (window.App && typeof App[name] === 'function') App[name](arg);
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // 接続中・接続済み
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;

    sock.onopen = () => {
      attempts = 0;
      if (pendingHello) {
        const hello = pendingHello;
        pendingHello = null;
        sock.send(JSON.stringify(hello));
      }
      const pending = queue;
      queue = [];
      for (const s of pending) sock.send(s);
      appFn('onConnected');
    };

    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      route(m);
    };

    // エラーは onclose 側で拾う（ここで握らないと未処理例外になる）
    sock.onerror = () => {};

    sock.onclose = () => {
      // 古いソケットの close が新しい接続を潰さないよう、自分が現行のときだけ外す
      if (ws === sock) ws = null;
      appFn('onDisconnect');
      if (identity && identity.code) {
        pendingHello = makeJoinMessage();
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const wait = Math.min(BACKOFF_MAX, BACKOFF_BASE * Math.pow(2, attempts));
    // 同時刻に大量の再接続が来ないよう少しだけ散らす
    const delay = wait + Math.floor(Math.random() * 250);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      if (pendingHello && !isOpen() && !reconnectTimer) scheduleReconnect();
    }, delay);
  }

  // ソケットが開いていれば即送り、開いていなければ接続してから送る
  function hello(m) {
    if (isOpen()) {
      ws.send(JSON.stringify(m));
      return;
    }
    pendingHello = m;
    connect();
  }

  function send(m) {
    const s = JSON.stringify(m);
    if (isOpen()) ws.send(s);
    else queue.push(s);
  }

  function makeJoinMessage() {
    return {
      type: 'join',
      code: identity.code,
      name: identity.name,
      playerId: identity.playerId || undefined,
    };
  }

  function sameIdentity(next) {
    return !!identity && identity.code === next.code && identity.name === next.name;
  }

  // ルームを作る（コードはサーバーが発行する）
  function create(name) {
    const n = String(name || '').trim();
    if (!n) return;
    identity = { code: null, name: n, playerId: null };
    queue = [];
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    attempts = 0;
    hello({ type: 'create', name: n });
    appFn('onStatus', 'ルームを作成しています…');
  }

  function join(code, name) {
    const c = String(code || '').trim().toUpperCase();
    const n = String(name || '').trim();
    if (!c || !n) return;
    // 同じブラウザの別タブでも席がぶつからないよう、ルーム×名前ごとに id を保存する
    const playerId = storeGet(idKey(c, n)) || null;
    const next = { code: c, name: n, playerId };
    // 同じ席へ入り直すときは、送信待ちの古い行動を捨てる（別ルームの行動が再生されないように）
    if (!sameIdentity(next)) queue = [];
    identity = next;
    hello(makeJoinMessage());
    if (playerId) appFn('onStatus', '再接続しています…');
    else appFn('onStatus', '参加しています…');
  }

  function route(m) {
    switch (m.type) {
      case 'joined':
        if (identity) {
          identity.code = m.roomCode;
          identity.playerId = m.playerId;
          storeSet(idKey(m.roomCode, identity.name), m.playerId);
        }
        appFn('onJoined', m);
        break;
      case 'lobby':
        appFn('onLobby', m);
        break;
      case 'state':
        appFn('onState', m.view);
        break;
      case 'gameover':
        appFn('onGameOver');
        break;
      case 'error':
        appFn('onError', m.message);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  function leave() {
    if (isOpen()) send({ type: 'leave' });
    identity = null;
    pendingHello = null;
    queue = [];
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    attempts = 0;
    const sock = ws;
    ws = null; // 先に外す: この close で再接続予約が走らないようにする
    if (sock) { try { sock.close(); } catch { /* noop */ } }
  }

  window.Net = {
    join,
    create,
    start() { send({ type: 'start' }); },
    setSettings(settings) { send({ type: 'setSettings', settings }); },
    addAi() { send({ type: 'addAi' }); },
    removeAi() { send({ type: 'removeAi' }); },
    action(action) { send({ type: 'action', action }); },
    continueRound() { send({ type: 'continue' }); },
    leave,
    isConnected: isOpen,
  };
})();
