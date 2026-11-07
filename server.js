'use strict';

// 静的配信 + 対戦サーバー（Node 組み込み http + ws）。
// クライアントは静的ファイルを取得し、/ws でルームに参加して行動を送る。
// 状態はサーバーの engine が唯一の正で、クライアントには席ごとのビューだけ配る。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // Render などのヘルスチェック用
  if (urlPath === '/healthz' || urlPath === '/keepalive') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end('ok');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, path.normalize(urlPath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (fsErr, data) => {
    if (fsErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------- ルーム ----------------

const rooms = new Map(); // code -> Room
const sessions = new Map(); // ws -> { code, seat }

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.meta = { code: null, seat: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'JSON が不正です' }); }
    if (!msg || typeof msg.type !== 'string') return send(ws, { type: 'error', message: 'メッセージが不正です' });

    switch (msg.type) {
      case 'join': return onJoin(ws, msg);
      case 'start': return onStart(ws, msg);
      case 'setSettings': return onSetSettings(ws, msg);
      case 'addAi': return onAddAi(ws);
      case 'removeAi': return onRemoveAi(ws);
      case 'action': return onAction(ws, msg);
      case 'continue': return onContinue(ws);
      case 'leave': return onLeave(ws);
      case 'ping': return send(ws, { type: 'pong' });
      case 'heartbeat': return;
      default: return send(ws, { type: 'error', message: '未対応のコマンドです' });
    }
  });
  ws.on('close', () => onDisconnect(ws));
});

function onJoin(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  if (!code) return send(ws, { type: 'error', message: 'ルームコードを入力してください' });
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code);
    room.onTimeout = () => onRoomTimeout(room);
    rooms.set(room.code, room);
  }
  const result = room.join(msg.name, msg.playerId);
  if (!result.ok) return send(ws, { type: 'error', message: result.error });

  // 同じ席に古い接続が残っていれば切る（再接続・二重タブ対策）
  const old = room.sockets.get(result.seat);
  if (old && old !== ws) {
    sessions.delete(old);
    try { old.close(1000, 'replaced'); } catch { /* noop */ }
  }
  room.sockets.set(result.seat, ws);
  sessions.set(ws, { code: room.code, seat: result.seat });
  ws.meta = { code: room.code, seat: result.seat };

  send(ws, {
    type: 'joined',
    roomCode: room.code,
    seat: result.seat,
    playerId: result.playerId,
    isHost: result.isHost,
    reconnected: !!result.reconnected,
  });
  broadcastLobby(room);
  if (room.started) broadcastState(room);
}

function onStart(ws, msg) {
  const { room, seat } = ctx(ws);
  if (!room) return send(ws, { type: 'error', message: '先に join してください' });
  const res = room.start(seat);
  if (!res.ok) return send(ws, { type: 'error', message: res.error });
  room.armTimer(); // 配信前にデッドラインを確定させる
  broadcastLobby(room);
  broadcastState(room);
  scheduleAutoPlay(room); // 開始時点で切断している席は AI に任せる
}

// ホストが AI 席を追加（人数調整）
function onAddAi(ws) {
  const { room, seat } = ctx(ws);
  if (!room) return send(ws, { type: 'error', message: '先に join してください' });
  const res = room.addAi(seat);
  if (!res.ok) return send(ws, { type: 'error', message: res.error });
  broadcastLobby(room);
}

// ホストが AI 席を削除（末尾の AI から）
function onRemoveAi(ws) {
  const { room, seat } = ctx(ws);
  if (!room) return send(ws, { type: 'error', message: '先に join してください' });
  // 席がずれるので、削除前の playerId -> ws 対応を控える
  const byId = new Map();
  for (const [oldSeat, sock] of room.sockets) {
    const s = room.seats[oldSeat];
    if (s) byId.set(s.id, sock);
  }
  const res = room.removeAi(seat);
  if (!res.ok) return send(ws, { type: 'error', message: res.error });
  // 席番号を詰め直し、ソケットとセッションを張り替える
  room.sockets.clear();
  room.seats.forEach((s, i) => {
    const sock = byId.get(s.id);
    if (!sock) return;
    room.sockets.set(i, sock);
    sock.meta = { code: room.code, seat: i };
    sessions.set(sock, { code: room.code, seat: i });
  });
  broadcastLobby(room);
}

function onSetSettings(ws, msg) {
  const { room, seat } = ctx(ws);
  if (!room) return send(ws, { type: 'error', message: '先に join してください' });
  const res = room.setSettings(seat, msg.settings);
  if (!res.ok) return send(ws, { type: 'error', message: res.error });
  broadcastLobby(room);
}

// 手番タイマー切れ: ラウンド結果バナーなら閉じる、それ以外は全員 AI で代行
function onRoomTimeout(room) {
  if (!rooms.has(room.code)) return;
  if (room.state && room.state.roundBanner) {
    room.state.roundBanner = null;
  } else {
    room.autoPlayAll();
  }
  room.armTimer();
  if (room.state) broadcastState(room);
}

function onAction(ws, msg) {
  const { room, seat } = ctx(ws);
  if (!room) return send(ws, { type: 'error', message: '先に join してください' });
  const res = room.act(seat, msg.action);
  if (!res.ok) return send(ws, { type: 'error', message: res.error });
  afterChange(room);
}

function onContinue(ws) {
  const { room, seat } = ctx(ws);
  if (!room) return;
  room.continueAfterRound(seat);
  afterChange(room);
}

function onLeave(ws) {
  onDisconnect(ws);
  try { ws.close(1000, 'left'); } catch { /* noop */ }
}

function onDisconnect(ws) {
  const s = sessions.get(ws);
  sessions.delete(ws);
  if (!s) return;
  const room = rooms.get(s.code);
  if (!room) return;
  // この ws がまだ現役の席なら切断扱い（再接続で置き換え済みなら何もしない）
  if (room.sockets.get(s.seat) === ws) {
    room.sockets.delete(s.seat);
    room.disconnect(s.seat);
    broadcastLobby(room);
    if (room.state) {
      room.armTimer();
      broadcastState(room);
      scheduleAutoPlay(room);
    }
  }
}

function ctx(ws) {
  const s = sessions.get(ws);
  if (!s) return { room: null, seat: null };
  return { room: rooms.get(s.code) || null, seat: s.seat };
}

function afterChange(room) {
  room.armTimer(); // デッドラインを配信に含める
  broadcastState(room);
  scheduleAutoPlay(room);
}

// 退席・AI 席が行動待ちなら、必要なタイミングで AI に代行させる。
// 退席した人間には猶予（既定 2 分）があり、その間は再接続を待つ。
function scheduleAutoPlay(room) {
  if (!room.state) return;
  const delay = room.nextAutoPlayDelay();
  if (delay === null) {
    if (room.autoTimer) { clearTimeout(room.autoTimer); room.autoTimer = null; }
    return;
  }
  if (room.autoTimer) { clearTimeout(room.autoTimer); room.autoTimer = null; }
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (!rooms.has(room.code)) return;
    if (room.autoPlayDisconnected()) afterChange(room);
    else scheduleAutoPlay(room);
  }, Math.max(0, delay));
}

function broadcastLobby(room) {
  const msg = JSON.stringify(room.lobby());
  for (const ws of room.sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcastState(room) {
  if (!room.state) return;
  for (const [seat, ws] of room.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ type: 'state', view: room.view(seat) }));
    if (room.state.phase === 'over') {
      ws.send(JSON.stringify({ type: 'gameover' }));
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// 放置ルームの掃除（2時間）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 2 * 60 * 60 * 1000) {
      for (const ws of room.sockets.values()) {
        try { ws.close(1000, 'expired'); } catch { /* noop */ }
      }
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`東方数紙業 server: http://localhost:${PORT}`);
});

module.exports = { server, wss, rooms };


