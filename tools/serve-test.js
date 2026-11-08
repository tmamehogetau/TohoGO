'use strict';

// 静的配信とサーバー堅牢性の回帰テスト。
// node tools/serve-test.js
// 見るもの: 不正 URL でプロセスが落ちないこと／配信が許可リスト内に限定されること／
// 放置ルームの回収とルーム数上限が効いていること。

process.env.PORT = process.env.PORT || '3116';
const http = require('http');
const srv = require('../server.js');

const PORT = Number(process.env.PORT);

function get(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    req.on('error', (e) => resolve({ status: 0, type: '', body: '', error: e.code || e.message }));
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
  console.log('  ok -', msg);
}

(async () => {
  // ---- ヘルスチェック ----
  const hz = await get('/healthz');
  assert(hz.status === 200 && hz.body === 'ok', 'healthz responds 200');

  // ---- N1: 不正な percent-encoding で落ちない ----
  // Node の http.request はパスを再エンコードせずに送るので、これがそのまま攻撃入力になる
  // （PowerShell の Invoke-WebRequest は %25 に変換するため再現できない。
  //   将来 Node が挙動を変えた場合は raw socket の "GET /% HTTP/1.0" で確認する）
  const bad = await get('/%');
  assert(bad.status === 400, 'malformed percent-encoding returns 400 (got ' + bad.status + ')');
  const badUtf = await get('/%E0%A4%A');
  assert(badUtf.status === 400, 'invalid utf-8 percent-encoding returns 400 (got ' + badUtf.status + ')');

  const afterBad = await get('/healthz');
  assert(afterBad.status === 200, 'server stays alive after malformed URL');

  // ---- 配信の許可リスト ----
  const denied = [
    '/.git/config',
    '/.git/HEAD',
    '/server.js',
    '/room.js',
    '/package.json',
    '/package-lock.json',
    '/README.md',
    '/HANDOVER.md',
    '/DESIGN.md',
    '/.tmp/probe2.js',
    '/node_modules/ws/index.js',
    '/assets/../server.js',
    '/assets/%2e%2e/server.js',
    '/assets/cards/../../server.js',
  ];
  for (const p of denied) {
    const r = await get(p);
    assert(r.status === 404, 'denied: ' + p + ' (got ' + r.status + ')');
  }

  const allowed = [
    ['/', 'text/html'],
    ['/style.css', 'text/css'],
    ['/game.js', 'text/javascript'],
    ['/engine.js', 'text/javascript'],
    ['/net.js', 'text/javascript'],
    ['/assets/cards/f_aya.webp', 'image/webp'],
  ];
  for (const [p, type] of allowed) {
    const r = await get(p);
    assert(r.status === 200 && r.type.includes(type), 'allowed: ' + p + ' (' + r.status + ' ' + r.type + ')');
  }

  // ---- 放置ルームの回収 ----
  srv.rooms.clear();
  const idle = { code: 'IDLE', started: false, lastActivity: 0, sockets: new Map() };
  const live = { code: 'LIVE', started: true, lastActivity: Date.now(), sockets: new Map() };
  srv.rooms.set('IDLE', idle);
  srv.rooms.set('LIVE', live);
  const removed = srv.sweepRooms(Date.now());
  assert(removed === 1 && !srv.rooms.has('IDLE'), 'idle room is reclaimed');
  assert(srv.rooms.has('LIVE'), 'active room is kept');

  // ---- ルーム数上限 ----
  srv.rooms.clear();
  for (let i = 0; i < srv.MAX_ROOMS; i++) {
    const code = 'R' + String(i).padStart(3, '0');
    srv.rooms.set(code, { code, started: true, lastActivity: Date.now(), sockets: new Map() });
  }
  const blocked = srv.createRoom();
  assert(blocked === null, 'room creation is refused when every room is in use');
  // 1 つを「開始前・接続なし」に変えると、そこが回収されて作成できる
  const first = srv.rooms.get('R000');
  first.started = false;
  const created = srv.createRoom();
  assert(!!created && srv.rooms.size === srv.MAX_ROOMS, 'idle room is evicted to make space');
  assert(!srv.rooms.has('R000'), 'evicted room is gone');

  srv.rooms.clear();
  console.log('SERVE SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('SERVE SMOKE FAIL:', e.message);
  process.exit(1);
});
