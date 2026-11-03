'use strict';

// 対戦クライアント。サーバーに join し、行動を送り、届いたビューを App に渡す。
// ルームごとに playerId を localStorage に保存し、切断時は同じ id で自動再接続する。

(function () {
  let ws = null;
  let queue = [];
  let identity = null; // { code, name, playerId }
  let pendingJoin = null;
  let reconnectTimer = null;

  const idKey = (code, name) => `touhou:${code}:${encodeURIComponent(name)}:playerId`;

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      if (pendingJoin) {
        ws.send(JSON.stringify(pendingJoin));
        pendingJoin = null;
      }
      for (const s of queue) ws.send(s);
      queue = [];
      if (window.App && App.onConnected) App.onConnected();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      route(m);
    };
    ws.onclose = () => {
      ws = null;
      if (window.App && App.onDisconnect) App.onDisconnect();
      if (identity) {
        pendingJoin = makeJoinMessage();
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  function send(m) {
    const s = JSON.stringify(m);
    if (ws && ws.readyState === 1) ws.send(s);
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

  function join(code, name) {
    const c = String(code || '').trim().toUpperCase();
    const n = String(name || '').trim();
    if (!c || !n) return;
    // 同じブラウザの別タブでも席がぶつからないよう、ルーム×名前ごとに id を保存する
    const playerId = localStorage.getItem(idKey(c, n)) || null;
    identity = { code: c, name: n, playerId };
    pendingJoin = makeJoinMessage();
    connect();
    if (identity.playerId) {
      if (window.App && App.onStatus) App.onStatus('再接続しています…');
    }
  }

  function route(m) {
    switch (m.type) {
      case 'joined':
        identity.playerId = m.playerId;
        localStorage.setItem(idKey(m.roomCode, identity.name), m.playerId);
        localStorage.setItem('touhou:lastRoom', m.roomCode);
        if (window.App && App.onJoined) App.onJoined(m);
        break;
      case 'lobby':
        if (window.App && App.onLobby) App.onLobby(m);
        break;
      case 'state':
        if (window.App && App.onState) App.onState(m.view);
        break;
      case 'gameover':
        if (window.App && App.onGameOver) App.onGameOver();
        break;
      case 'error':
        if (window.App && App.onError) App.onError(m.message);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  function leave() {
    if (ws && ws.readyState === 1) send({ type: 'leave' });
    identity = null;
    pendingJoin = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch { /* noop */ } }
    ws = null;
  }

  window.Net = {
    join,
    start() { send({ type: 'start' }); },
    setSettings(settings) { send({ type: 'setSettings', settings }); },
    action(action) { send({ type: 'action', action }); },
    continueRound() { send({ type: 'continue' }); },
    leave,
    isConnected: () => !!(ws && ws.readyState === 1),
  };
})();
