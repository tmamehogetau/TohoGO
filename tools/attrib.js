'use strict';

// 異変パックの「得点の出どころ」を測る。node tools/attrib.js で実行。
//
// やり方: カード 1 種類の得点ロジックを 0 にして同じシードで再実行し、
// パック平均（1 人あたり・3 ラウンド合計）が何点下がるかを見る。
// つまり出てくる数字は「そのカード全枚数を合わせた寄与」で、1 枚ぶんではない。
//
// 1 枚あたりの寄与は 枚数 で割れば出るが、それは点が枚数に比例するカード
// （instant）だけで意味がある。マキ・手巻き・共闘・収集・豆腐などは
// 枚数や順位で段階的に変わるので、割り算した値は参考にしないこと。
//
// 使い方:
//   node tools/attrib.js                  # 全異変
//   node tools/attrib.js --games 1500
//   node tools/attrib.js --incident eternal --out .tmp/attrib.txt
//   node tools/attrib.js --seed 7

const Data = require('../data.js');
const sim = require('./sim.js');
const fs = require('fs');

const OUTPUT_LINES = [];
function out(line) {
  OUTPUT_LINES.push(line);
  console.log(line);
}

function parseArgs(argv) {
  const opts = { games: 700, incident: 'all', seed: 1, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') opts.games = Math.max(1, parseInt(argv[++i], 10) || 700);
    else if (a === '--incident') opts.incident = argv[++i] || 'all';
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10) || 1;
    else if (a === '--out') opts.out = argv[++i] || null;
  }
  return opts;
}

// 点が枚数に比例する種類だけ「1 枚あたり」を出せる
const LINEAR_KINDS = ['instant'];

function findDef(incident, key) {
  const all = [...incident.main, ...(incident.dessert ? [incident.dessert] : []), ...(incident.intruders || [])];
  return all.find((d) => d.key === key);
}

function cardCount(def) {
  if (def.iconCounts) return Object.values(def.iconCounts).reduce((a, b) => a + b, 0);
  if (def.pool) return def.pool;
  return def.count || 1;
}

function avgTotal(incident, opts) {
  const res = sim.runWithSeed(opts.seed, () => sim.run([incident.id], opts.games));
  return sim.mean(res.totalsByIncident.get(incident.id).scoreSamples.flat());
}

// key, 表示名, 得点ロジックを無効化する関数。null はマキ配点（RULES 側）を消す。
const TARGETS = {
  scarlet: [
    ['k_sakuya', '十六夜咲夜 3点', (d) => { d.points = 0; }],
    ['k_remi', 'レミリア 3点', (d) => { d.points = 0; }],
    ['k_fran', 'フランドール 2点', (d) => { d.points = 0; }],
    ['k_meirin', '紅美鈴 1点', (d) => { d.points = 0; }],
    ['k_rumia', 'ルーミア 収集', (d) => { d.table = [0, 0, 0, 0, 0]; }],
    ['k_maid', '妖精メイド 最多/最少', (d) => { d.most = 0; d.least = 0; }],
    ['k_daiyousei', '大妖精 デザート毎', (d) => { d.per = 0; }],
    ['k_patch', 'パチュリー 種類数', (d) => { d.offset = -99; }],
    ['k_cirno', 'チルノ 最少に減点', (d) => { d.least = 0; }],
  ],
  spring: [
    ['s_yukari', '八雲紫 3点', (d) => { d.points = 0; }],
    ['s_ran', '八雲藍 2点', (d) => { d.points = 0; }],
    ['s_chen', '橙 1点', (d) => { d.points = 0; }],
    ['group:alice', 'アリス 人形の種類数', (d) => { d.table = [0, 0, 0, 0, 0]; }],
    ['s_prism', 'プリズム 3枚10点', (d) => { d.points = 0; }],
    ['s_yuyuko', '幽々子 春最多4点', (d) => { d.most = 0; }],
    ['s_youmu', '妖夢 春を奪う', (d) => { d.steal = 0; }],
    ['s_letty', 'レティ 2枚毎6点/春-1', (d) => { d.points = 0; d.reduceSpringIconsPerPair = 0; }],
    ['s_lily', 'リリーホワイト 4枚12点', (d) => { d.points = 0; }],
    ['__maki', '春 マキ配点', null],
  ],
  eternal: [
    ['y_kaguya', '蓬莱山輝夜 3点', (d) => { d.points = 0; }],
    ['y_eirin', '八意永琳 3点', (d) => { d.points = 0; }],
    ['y_reisen', '鈴仙 1点', (d) => { d.points = 0; }],
    ['y_tewi', 'てゐ 2枚6点', (d) => { d.table = [0, 0, 0]; }],
    ['y_moko', '妹紅 -1/最多×2', (d) => { d.roundPenalty = 0; d.endMostPer = 0; }],
    ['y_riggle', 'リグル 同時取得', (d) => { d.points = 0; }],
    ['y_reimu', '霊夢 3枚ごと9点+通算9枚', (d) => { d.points = 0; d.gameEndTotalAtLeast = null; }],
    ['y_marisa', '魔理沙 2枚ごと4点+通算最多', (d) => { d.points = 0; d.gameEndMost = null; }],
    ['__maki', '玉兎 マキ配点', null],
  ],
};

function pad(s, n) {
  const str = String(s);
  const width = [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const incidents = opts.incident === 'all' ? Data.INCIDENT_IDS.slice() : [opts.incident];
  for (const id of incidents) {
    if (!Data.INCIDENT_IDS.includes(id)) {
      console.error(`未知の異変: ${id}（${Data.INCIDENT_IDS.join(' / ')}）`);
      process.exit(1);
    }
  }

  for (const incidentId of incidents) {
    const incident = Data.incidentById(incidentId);
    const base = avgTotal(incident, opts);
    out('');
    out(`=== ${incident.name} ベース ${sim.fmt(base, 2)} 点/人（${opts.games} ゲーム） ===`);
    out(`${pad('カード', 24)}${pad('枚数', 6)}${pad('合計寄与', 10)}${pad('1枚あたり', 10)}`);
    const rows = [];
    for (const [key, label, patch] of TARGETS[incidentId] || []) {
      if (key === '__maki') {
        const snap = { ...Data.RULES.MAKI_POINTS };
        Data.RULES.MAKI_POINTS.first = 0;
        Data.RULES.MAKI_POINTS.second = 0;
        const v = avgTotal(incident, opts);
        Object.assign(Data.RULES.MAKI_POINTS, snap);
        rows.push({ label, count: null, contrib: base - v, linear: false });
        continue;
      }
      const groupId = key.startsWith('group:') ? key.slice(6) : null;
      if (groupId) {
        // アリスのように 4 種で 1 枚のカードのものは、グループ全種をまとめて 0 点にして測る
        const defs = incident.main.concat(incident.intruders || []).filter((d) => d.group === groupId);
        if (!defs.length) { rows.push({ label: `${label}（未定義）`, count: null, contrib: NaN, linear: false }); continue; }
        const snaps = defs.map((d) => JSON.parse(JSON.stringify(d)));
        for (const d of defs) patch(d);
        const v = avgTotal(incident, opts);
        defs.forEach((d, i) => Object.assign(d, snaps[i]));
        rows.push({ label, count: defs.reduce((s, d) => s + cardCount(d), 0), contrib: base - v, linear: false });
        continue;
      }
      const def = findDef(incident, key);
      if (!def) { rows.push({ label: `${label}（未定義）`, count: null, contrib: NaN, linear: false }); continue; }
      const snap = JSON.parse(JSON.stringify(def));
      patch(def);
      const v = avgTotal(incident, opts);
      Object.assign(def, snap);
      rows.push({
        label,
        count: cardCount(def),
        contrib: base - v,
        linear: LINEAR_KINDS.includes(def.kind),
      });
    }
    rows.sort((a, b) => b.contrib - a.contrib);
    for (const r of rows) {
      const per = r.count && r.linear ? sim.fmt(r.contrib / r.count, 2) : '—';
      out(`${pad(r.label, 24)}${pad(r.count == null ? '—' : r.count, 6)}${pad(sim.fmt(r.contrib, 2), 10)}${pad(per, 10)}`);
    }
  }
  out('');
  out('合計寄与は「そのカード全枚数を 0 点にしたときのパック平均の低下」。');
  out('1 枚あたりは点が枚数に比例するカード（instant）だけ算出。マキ・手巻き・共闘・収集などは — 表示。');
  out('1 枚ずつ抜いて測るため各値は独立ではなく、合計はパック平均に一致しない。');

  if (opts.out) {
    fs.writeFileSync(opts.out, OUTPUT_LINES.join('\n') + '\n', 'utf8');
    console.log(`レポートを書き出した: ${opts.out}`);
  }
}

main();
