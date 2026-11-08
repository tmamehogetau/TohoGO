'use strict';

// 静的配信 + 対戦サーバー（Node 組み込み http + ws）。
// クライアントは静的ファイルを取得し、/ws でルームに参加して行動を送る。
// 状態はサーバーの engine が唯一の正で、クライアントには席ごとのビューだけ配る。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room, makeCode } = require('./room.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// ---- 静的配信の許可リスト ----
// プロジェクトの中身を丸ごと配らない。.git / .tmp / *.md / package*.json / node_modules は返さない。
const STATIC_FILES = new Set([
  '/index.html',
  '/style.css',
  '/data.js',
  '/engine.js',
  '/ai.js',
  '/game.js',
  '/net.js',
  '/favicon.ico',
]);
const ASSET_PREFIX = '/assets/';
const ASSET_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.svg', '.ico']);
const MAX_URL_LENGTH = 2048;

// URL パス → 配信する実ファイル。許可外は null（404 を返す）
function resolveStatic(urlPath) {
  if (!urlPath || urlPath.length > MAX_URL_LENGTH) return null;
  if (urlPath.includes('\0')) return null;
  if (STATIC_FILES.has(urlPath)) return path.join(__dirname, urlPath);
  if (!urlPath.startsWith(ASSET_PREFIX)) return null;
  if (!ASSET_EXT.has(path.extname(urlPath).toLowerCase())) return null;
  // path.normalize が先頭の .. を畳むので、assets 直下に収まっているか最後に必ず確認する
  const filePath = path.join(__dirname, path.normalize(urlPath));
  const assetsRoot = path.join(__dirname, 'assets') + path.sep;
  return filePath.startsWith(assetsRoot) ? filePath : null;
}

function handleRequest(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    // 不正な %xx でプロセスを落とさない（この 1 行が無いと 1 リクエストで全ルームが消える）
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

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

  const filePath = resolveStatic(urlPath);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
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
}

const server = http.createServer((req, res) => {
  // ハンドラ内の想定外例外でもプロセスを落とさない（N1 の再発防止）
  try {
    handleRequest(req, res);
  } catch (e) {
    console.error('request handler error:', e && e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});
server.on('error', (e) => console.error('server error:', e && e.message));

// ---------------- ルーム ----------------

const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS || 30 * 60 * 1000); // 開始前の放置ルーム
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 2 * 60 * 60 * 1000); // 進行中含む上限
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);

const rooms = new Map(); // code -> Room
const sessions = new Map(); // ws -> { code, seat }

// 上限に達したら「開始前・接続なし」のルームを先に回収する
function evictIdleRoom() {
  for (const [code, room] of rooms) {
    if (!room.started && room.sockets.size === 0) {
      rooms.delete(code);
      return true;
    }
  }
  return false;
}

// ルームは常にサーバーが発行する（クライアント指定のコードで空ルームを作らせない）
function createRoom() {
  if (rooms.size >= MAX_ROOMS && !evictIdleRoom()) return null;
  if (rooms.size >= MAX_ROOMS) return null;
  const code = makeCode(rooms);
  const room = new Room(code);
  room.onTimeout = () => onRoomTimeout(room);
  rooms.set(room.code, room);
  return room;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('error', (e) => console.error('ws server error:', e && e.message));

// 死活監視: 半切断（TCP は残っているが相手が居ない）を検出して切断扱いにする。
// ブラウザも ws クライアントも ping には自動で pong を返すので、返らない接続は死んでいる。
// これが無いと「接続中なのに無応答」の席がタイマー無制限モードで永遠に待たれる。
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30000);

wss.on('connection', (ws) => {
  ws.meta = { code: null, seat: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => console.error('ws error:', e && e.message));
  ws.on('message', (raw) => {
    // 1 通の不正メッセージでサーバーを落とさない
    try {
      handleMessage(ws, raw);
    } catch (e) {
      console.error('message handler error:', e && e.message);
      send(ws, { type: 'error', message: 'サーバー内部エラー' });
    }
  });
  ws.on('close', () => onDisconnect(ws));
});

// 死活監視の 1 周回。pong が返らなかった接続を落とす。
// clients を差し替えられるのはテストのため（偽クライアントで terminate 経路を確認する）。
function sweepHeartbeat(clients = wss.clients) {
  let terminated = 0;
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate(); // close ハンドラが切断扱いにする
      terminated += 1;
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
  return terminated;
}

const heartbeat = setInterval(() => sweepHeartbeat(), HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'JSON が不正です' }); }
  if (!msg || typeof msg.type !== 'string') return send(ws, { type: 'error', message: 'メッセージが不正です' });

  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
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
}

// 席に接続を紐づける（新規 join / 再接続 / ルーム作成の共通経路）
function attach(ws, room, result) {
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

function onCreate(ws, msg) {
  const room = createRoom();
  if (!room) {
    return send(ws, { type: 'error', message: 'いまはルームを作成できません。時間をおいて試してください' });
  }
  const result = room.join(msg.name, null);
  if (!result.ok) {
    // join に失敗したら空ルームを残さない（名前不正の連打で上限 200 を埋めさせない）
    rooms.delete(room.code);
    return send(ws, { type: 'error', message: result.error });
  }
  return attach(ws, room, result);
}

function onJoin(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  if (!code) return send(ws, { type: 'error', message: 'ルームコードを入力してください' });
  const room = rooms.get(code);
  // 存在しないコードは「作らない」（タイプミスで幽霊ルームが増えるのを防ぐ）
  if (!room) return send(ws, { type: 'error', message: 'そのルームは見つかりません。コードを確認してください' });

  const result = room.join(msg.name, msg.playerId);
  if (!result.ok) return send(ws, { type: 'error', message: result.error });
  return attach(ws, room, result);
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
    room.continueReady.clear(); // 閉じたバナーの「準備完了」を次のバナーへ持ち越さない
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
  if (room.autoTimer) { clearTimeout(room.autoTimer); room.autoTimer = null; }
  const delay = room.nextAutoPlayDelay();
  if (delay === null) return;
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (!rooms.has(room.code)) return;
    if (room.autoPlayDisconnected()) afterChange(room);
    else scheduleAutoPlay(room);
  }, Math.max(0, delay));
  if (room.autoTimer.unref) room.autoTimer.unref(); // 終了処理を引き延ばさない
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

// 放置ルームの掃除: 開始前は短め、進行中は長めの TTL で回収する
function sweepRooms(now = Date.now()) {
  let removed = 0;
  for (const [code, room] of rooms) {
    const ttl = room.started ? ROOM_TTL_MS : EMPTY_ROOM_TTL_MS;
    if (now - room.lastActivity > ttl) {
      for (const ws of room.sockets.values()) {
        try { ws.close(1000, 'expired'); } catch { /* noop */ }
      }
      rooms.delete(code);
      removed += 1;
    }
  }
  return removed;
}

setInterval(() => sweepRooms(), 60 * 1000).unref();

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`東方数紙業 server: http://localhost:${PORT}`);
});

module.exports = { server, wss, rooms, sweepRooms, sweepHeartbeat, createRoom, MAX_ROOMS, EMPTY_ROOM_TTL_MS, ROOM_TTL_MS, HEARTBEAT_MS };
