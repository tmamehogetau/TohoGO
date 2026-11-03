'use strict';

// AI vs AI バランスシミュレーション。node tools/sim.js で実行。
//
// 指標は 2 つ。用途が違うので混同しないこと。
//
// 1. 卓平均差（相対指標）
//    「そのカードを取った人が、同じラウンドで他プレイヤーより何点上だったか」の平均。
//    + が大きい = 持っていると勝ちやすい、− が大きい = 持っていても勝てない。
//    ただし全員が同じ頻度で強いカードを引くため、カードの絶対的な強さは相殺される。
//    実際、点数を動かしても単調に動かない（4 点と 2 点で同じ値になるなど）。
//    条件付きカード・デザートは構造的に下振れするので、単独で弱いと判断しないこと。
//
// 2. 感度分析 --ablate（絶対指標）
//    指定カードの点数を step 点動かして再実行し、卓全体の平均合計点がいくつ動くかを見る。
//    こちらのほうが「このカードがゲームの点経済にどれだけ効いているか」を素直に表す。
//
// 使い方:
//   node tools/sim.js                          # 全異変 × 300 ゲーム
//   node tools/sim.js --games 1000             # ゲーム数指定
//   node tools/sim.js --incident scarlet       # 異変を 1 つに絞る
//   node tools/sim.js --seed 12345             # 乱数固定（既定 1）
//   node tools/sim.js --csv                    # CSV 出力（スプレッドシート用）
//   node tools/sim.js --ablate y_kaguya        # 輝夜の点数を 1 下げたときの影響を見る
//   node tools/sim.js --ablate y_kaguya --step -2

const Engine = require('../engine.js');
const AI = require('../ai.js');
const Data = require('../data.js');
const fs = require('fs');

// レポートは画面にも出すが、Windows のコンソール文字コードで化けることがあるため
// --out 指定時は UTF-8 ファイルにも同じ内容を書き出す
const OUTPUT_LINES = [];
function out(line) {
  OUTPUT_LINES.push(line);
  console.log(line);
}

// ---- 引数 ----
function parseArgs(argv) {
  const opts = { games: 300, incident: 'all', seed: 1, csv: false, top: 99, out: null, ablate: null, step: -1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') opts.games = Math.max(1, parseInt(argv[++i], 10) || 300);
    else if (a === '--incident') opts.incident = argv[++i] || 'all';
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10) || 1;
    else if (a === '--csv') opts.csv = true;
    else if (a === '--top') opts.top = Math.max(1, parseInt(argv[++i], 10) || 99);
    else if (a === '--out') opts.out = argv[++i] || null;
    else if (a === '--ablate') opts.ablate = argv[++i] || null;
    else if (a === '--step') opts.step = parseInt(argv[++i], 10) || -1;
    else if (a === '--by-card') opts.byCard = argv[++i] || null;
  }
  return opts;
}

// ---- 決定論的乱数（mulberry32）----
// AI は Math.random でタイブレークするため、実行中だけ差し替える
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyAcq() {
  return [new Map(), new Map(), new Map(), new Map()];
}

// 1 ゲームを AI 4 人で完走し、ラウンドごとの取得カードと得点を返す
function playGame(incident) {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident });
  const acq = [emptyAcq(), emptyAcq(), emptyAcq()]; // 3 ラウンド分
  const add = (pi, key) => {
    const m = acq[Math.min(s.round, 2)][pi];
    m.set(key, (m.get(key) || 0) + 1);
  };

  let guard = 0;
  while (s.phase !== 'over' && guard++ < 5000) {
    if (s.phase === 'select') {
      for (const pi of s.selectNeeded) {
        if (s.selections[pi] !== null) continue;
        const need = Engine.selectionNeeded(s, pi);
        const choice = AI.selectChoice(s, pi);
        // 山札確認で獲得するカードも「そのラウンドの取得」として数える
        if (need.peek && Number.isInteger(choice.pick)) {
          const inst = (s.peekCards[pi] || [])[choice.pick];
          if (inst) add(pi, inst.key);
        }
        Engine.dispatch(s, { kind: 'choose', pi, choice });
      }
    } else {
      for (let pi = 0; pi < 4; pi++) {
        if (s.picks[pi] !== null) continue;
        const hand = s.players[pi].hand;
        if (hand.length === 0) {
          Engine.dispatch(s, { kind: 'skip', pi });
          continue;
        }
        // ホットシート UI の AI と同じ方針（早飲みが使えるなら 2 枚取る）
        const use2 = s.players[pi].chopsticks > 0 && hand.length >= 2;
        const idxs = use2 ? AI.pick2(s, pi) : AI.pick(s, pi);
        for (const idx of idxs) add(pi, hand[idx].key);
        if (idxs.length === 2) Engine.dispatch(s, { kind: 'pick2', pi, idxs });
        else Engine.dispatch(s, { kind: 'pick', pi, idx: idxs[0] });
      }
    }
  }

  return {
    incident,
    rounds: acq,
    roundScores: s.players.map((p) => p.roundScores.slice()),
    totals: s.players.map((_, pi) => Engine.scorePlayer(s, pi)),
    cardMap: s.cardMap,
  };
}

// ---- 集計 ----
// 指標: ラウンド内の席平均との差（同一ラウンド内で他プレイヤーより何点上回ったか）。
// 単純な「取得時 vs 未取得時」だと、枚数の多い穴埋めカードが
// 「他に取るものが無いから取られた」ぶん下振れするため、ラウンド内比較で補正する。
function newCardStat() {
  return { withN: 0, withSum: 0, deltaSum: 0, withoutN: 0, withoutSum: 0, roundSamples: 0 };
}

function run(incidents, games) {
  const byIncident = new Map(); // incident -> Map(key -> stat)
  const totalsByIncident = new Map(); // incident -> { scoreSamples, wins }

  for (const incident of incidents) {
    const inc = Data.incidentById(incident);
    // 分母を全カードで揃えるため、異変パックのカードキーを先に列挙する
    const allKeys = [...inc.main, ...(inc.dessert ? [inc.dessert] : []), ...(inc.intruders || [])].map((d) => d.key);
    const cardStats = new Map(allKeys.map((k) => [k, newCardStat()]));
    const scoreSamples = [0, 0, 0, 0].map(() => []);
    const wins = [0, 0, 0, 0];

    for (let g = 0; g < games; g++) {
      const game = playGame(incident);
      game.totals.forEach((t, pi) => scoreSamples[pi].push(t));
      const best = Math.max(...game.totals);
      const winners = game.totals.filter((x) => x === best).length;
      game.totals.forEach((t, pi) => { if (t === best) wins[pi] += 1 / winners; });

      for (let r = 0; r < game.rounds.length; r++) {
        const roundScores = game.roundScores.map((arr) => arr[r]);
        const roundMean = mean(roundScores);
        for (let pi = 0; pi < 4; pi++) {
          const score = roundScores[pi];
          const owned = game.rounds[r][pi];
          for (const key of allKeys) {
            const st = cardStats.get(key);
            st.roundSamples += 1;
            if (owned.has(key)) {
              st.withN += 1;
              st.withSum += score;
              st.deltaSum += score - roundMean;
            } else {
              st.withoutN += 1;
              st.withoutSum += score;
            }
          }
        }
      }
    }

    byIncident.set(incident, cardStats);
    totalsByIncident.set(incident, { scoreSamples, wins });
  }

  return { byIncident, totalsByIncident };
}

// ---- 出力 ----
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

function pad(s, n) {
  const str = String(s);
  const width = [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

function fmt(n, digits = 2) {
  return (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
}

function printIncident(incident, cardStats, totals, games, top) {
  const inc = Data.incidentById(incident);
  out('');
  out(`=== ${inc.name}（${inc.subtitle}） ${games} ゲーム ===`);

  const scores = totals.scoreSamples;
  out(`合計点: 平均 ${fmt(mean(scores.flat()), 1)} / 席別 ${scores.map((s) => fmt(mean(s), 1)).join(' / ')}`);
  out(`標準偏差: 席別 ${scores.map((s) => fmt(sd(s), 1)).join(' / ')}`);
  out(`勝率: ${totals.wins.map((w) => fmt((w / games) * 100, 1) + '%').join(' / ')}`);

  const rows = [];
  for (const [key, st] of cardStats) {
    if (!key || key === 'allKeys') continue;
    const def = inc.main.find((d) => d.key === key) || (inc.dessert && inc.dessert.key === key ? inc.dessert : null) || (inc.intruders || []).find((d) => d.key === key);
    const withMean = st.withN ? st.withSum / st.withN : 0;
    const withoutMean = st.withoutN ? st.withoutSum / st.withoutN : 0;
    rows.push({
      key,
      name: def ? def.name : key,
      kind: def ? def.kind : '?',
      count: def ? def.count || 1 : 0,
      acquireRate: st.withN + st.withoutN ? st.withN / (st.withN + st.withoutN) : 0,
      withMean,
      withoutMean,
      // 同一ラウンド内の席平均との差 = そのカードを取った人が卓平均より何点上だったか
      delta: st.withN ? st.deltaSum / st.withN : 0,
      samples: st.withN,
    });
  }
  rows.sort((a, b) => b.delta - a.delta);

  out('');
  out(`${pad('カード', 16)}${pad('種類', 12)}${pad('枚', 5)}${pad('取得率', 9)}${pad('取得時', 8)}${pad('卓平均差', 10)}`);
  for (const r of rows.slice(0, top)) {
    out(
      `${pad(r.name, 16)}${pad(r.kind, 12)}${pad(r.count, 5)}${pad(fmt(r.acquireRate * 100, 1) + '%', 9)}` +
      `${pad(fmt(r.withMean, 2), 8)}${pad((r.delta >= 0 ? '+' : '') + fmt(r.delta, 2), 10)}`
    );
  }
  return rows;
}

function printCsv(allRows) {
  out('incident,key,name,kind,count,acquire_rate,with_mean,delta,samples');
  for (const { incident, rows } of allRows) {
    for (const r of rows) {
      out([incident, r.key, r.name, r.kind, r.count, fmt(r.acquireRate, 4), fmt(r.withMean, 3), fmt(r.delta, 3), r.samples].join(','));
    }
  }
}

function findCardDef(key) {
  for (const id of Data.INCIDENT_IDS) {
    const inc = Data.incidentById(id);
    const all = [...inc.main, ...(inc.dessert ? [inc.dessert] : []), ...(inc.intruders || [])];
    const def = all.find((d) => d.key === key);
    if (def) return { incident: id, def };
  }
  return null;
}

// 指定カードを「何枚持ったか」ごとに、ラウンド点の卓平均との差と勝率を見る。
// 取るほど勝てるカード（dominant）と、取るほど損になるカード（sucker）を切り分けられる。
function runByCard(args, key) {
  const found = findCardDef(key);
  if (!found) {
    out(`所持枚数分析: 未知のカード ${key}`);
    return;
  }
  const { incident, def } = found;
  if (args.incident !== 'all' && args.incident !== incident) {
    out(`所持枚数分析: ${def.name} は ${args.incident} に含まれていない（${incident} のカード）`);
    return;
  }

  const games = runWithSeed(args.seed, () => {
    const gs = [];
    for (let i = 0; i < args.games; i++) gs.push(playGame(incident));
    return gs;
  });

  const perRound = new Map();
  let roundTotal = 0;
  for (const g of games) {
    for (let r = 0; r < g.roundScores[0].length; r++) {
      const rs = g.roundScores.map((a) => a[r]);
      const m = mean(rs);
      for (let pi = 0; pi < rs.length; pi++) {
        const c = g.rounds[r][pi].get(key) || 0;
        const b = perRound.get(c) || { n: 0, devSum: 0, scoreSum: 0 };
        b.n += 1;
        b.devSum += rs[pi] - m;
        b.scoreSum += rs[pi];
        perRound.set(c, b);
        roundTotal += 1;
      }
    }
  }

  out('');
  out(`--- 所持枚数分析: ${def.name}（${incident}・${args.games} ゲーム） ---`);
  out(`${pad('ラウンド内の枚数', 18)}${pad('割合', 9)}${pad('ラウンド点', 12)}${pad('卓平均との差', 13)}`);
  for (const c of [...perRound.keys()].sort((a, b) => a - b)) {
    const b = perRound.get(c);
    out(`${pad(c, 18)}${pad(fmt((b.n / roundTotal) * 100, 1) + '%', 9)}${pad(fmt(b.scoreSum / b.n, 2), 12)}${pad((b.devSum / b.n >= 0 ? '+' : '') + fmt(b.devSum / b.n, 2), 13)}`);
  }

  const byGame = new Map();
  for (const g of games) {
    const totals = g.rounds.reduce((acc, round) => round.map((m, pi) => acc[pi] + (m.get(key) || 0)), [0, 0, 0, 0]);
    const best = Math.max(...g.totals);
    const winners = g.totals.filter((t) => t === best).length;
    for (let pi = 0; pi < g.totals.length; pi++) {
      const b = byGame.get(totals[pi]) || { n: 0, win: 0, scoreSum: 0 };
      b.n += 1;
      b.scoreSum += g.totals[pi];
      if (g.totals[pi] === best) b.win += 1 / winners;
      byGame.set(totals[pi], b);
    }
  }
  out('');
  out(`${pad('ゲーム通算の枚数', 18)}${pad('人数', 8)}${pad('勝率', 10)}${pad('平均合計点', 12)}`);
  for (const c of [...byGame.keys()].sort((a, b) => a - b)) {
    const b = byGame.get(c);
    out(`${pad(c, 18)}${pad(b.n, 8)}${pad(fmt((b.win / b.n) * 100, 1) + '%', 10)}${pad(fmt(b.scoreSum / b.n, 2), 12)}`);
  }

  // ゲーム末ボーナス（通算条件）の達成状況
  const cond = def.gameEndTotalAtLeast
    ? { type: 'totalAtLeast', count: def.gameEndTotalAtLeast.count, points: def.gameEndTotalAtLeast.points }
    : def.gameEndMost
      ? { type: 'most', points: def.gameEndMost.points }
      : null;
  if (!cond) return;

  let metN = 0, metWin = 0, metScore = 0;
  let unmetN = 0, unmetWin = 0, unmetScore = 0;
  const rounds = games[0].rounds.length;
  const needBuckets = new Map();
  for (const g of games) {
    const totals = g.rounds.reduce((acc, round) => round.map((m, pi) => acc[pi] + (m.get(key) || 0)), [0, 0, 0, 0]);
    const best = Math.max(...g.totals);
    const winners = g.totals.filter((t) => t === best).length;
    const maxCopies = Math.max(...totals);
    for (let pi = 0; pi < g.totals.length; pi++) {
      const met = cond.type === 'totalAtLeast'
        ? totals[pi] >= cond.count
        : maxCopies > 0 && totals[pi] === maxCopies;
      const win = g.totals[pi] === best ? 1 / winners : 0;
      if (met) { metN += 1; metWin += win; metScore += g.totals[pi]; }
      else { unmetN += 1; unmetWin += win; unmetScore += g.totals[pi]; }

      if (cond.type === 'totalAtLeast') {
        let before = 0;
        for (let r = 0; r < rounds - 1; r++) before += g.rounds[r][pi].get(key) || 0;
        const need = Math.max(0, cond.count - before);
        const b = needBuckets.get(need) || { n: 0, win: 0, met: 0 };
        b.n += 1;
        if (g.totals[pi] === best) b.win += 1 / winners;
        if (met) b.met += 1;
        needBuckets.set(need, b);
      }
    }
  }

  const condLabel = cond.type === 'totalAtLeast'
    ? `通算 ${cond.count} 枚以上で +${cond.points}`
    : `通算の枚数が最多で +${cond.points}`;
  out('');
  out(`--- ゲーム末ボーナス（${condLabel}）の達成状況 ---`);
  out(`  ${pad('達成', 8)}${pad(String(metN) + ' 人', 12)}${pad(fmt((metN / (metN + unmetN)) * 100, 1) + '%', 10)}${pad('勝率 ' + fmt((metWin / Math.max(1, metN)) * 100, 1) + '%', 14)}平均 ${fmt(metScore / Math.max(1, metN), 2)}`);
  out(`  ${pad('未達', 8)}${pad(String(unmetN) + ' 人', 12)}${pad(fmt((unmetN / (metN + unmetN)) * 100, 1) + '%', 10)}${pad('勝率 ' + fmt((unmetWin / Math.max(1, unmetN)) * 100, 1) + '%', 14)}平均 ${fmt(unmetScore / Math.max(1, unmetN), 2)}`);

  if (cond.type === 'totalAtLeast') {
    out('');
    out(`  ${pad('最終R開始時の残り必要', 22)}${pad('人数', 8)}${pad('達成率', 10)}${pad('勝率', 10)}`);
    for (const k of [...needBuckets.keys()].sort((a, b) => a - b)) {
      const b = needBuckets.get(k);
      out(`  ${pad(k === 0 ? '0（達成済み）' : k, 22)}${pad(b.n, 8)}${pad(fmt((b.met / b.n) * 100, 1) + '%', 10)}${pad(fmt((b.win / b.n) * 100, 1) + '%', 10)}`);
    }
  }
}

// 乱数を固定して 1 回ぶん実行する（感度分析で基準と変更後を同じ条件で比べるため）
function runWithSeed(seed, fn) {
  const origRandom = Math.random;
  Math.random = makeRng(seed);
  try {
    return fn();
  } finally {
    Math.random = origRandom;
  }
}

function avgScore(totals) {
  return mean(totals.scoreSamples.flat());
}

// 指定カードの点数を step 点動かして再実行し、卓全体の平均合計点の変化を出す。
// 卓平均差が相対指標で単調でないのに対し、こちらは点経済への寄与を素直に測れる。
function runAblation(args, incidents, baseTotals) {
  const found = findCardDef(args.ablate);
  if (!found) {
    out(`感度分析: 未知のカード ${args.ablate}`);
    return;
  }
  const { incident, def } = found;
  if (!incidents.includes(incident)) {
    out(`感度分析: ${def.name} は --incident で選んだ異変に含まれていない`);
    return;
  }
  const original = def.points;
  if (typeof original !== 'number') {
    out(`感度分析: ${def.name} はポイント制のカードではない（kind: ${def.kind}）`);
    return;
  }

  def.points = original + args.step;
  let changed;
  try {
    changed = runWithSeed(args.seed, () => run([incident], args.games));
  } finally {
    def.points = original;
  }

  const before = avgScore(baseTotals.get(incident));
  const after = avgScore(changed.totalsByIncident.get(incident));
  out('');
  out(`--- 感度分析: ${def.name}（${def.key}） ---`);
  out(`  ${original} 点 → ${original + args.step} 点: 卓平均合計 ${fmt(before, 2)} → ${fmt(after, 2)}`);
  out(`  点数 1 点あたりの重み ${fmt((after - before) / args.step, 2)}（枚数と取られやすさ込みの効き方）`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const incidents = args.incident === 'all' ? Data.INCIDENT_IDS.slice() : [args.incident];
  for (const id of incidents) {
    if (!Data.INCIDENT_IDS.includes(id)) {
      console.error(`未知の異変: ${id}（${Data.INCIDENT_IDS.join(' / ')}）`);
      process.exit(1);
    }
  }

  const result = runWithSeed(args.seed, () => run(incidents, args.games));

  const allRows = [];
  for (const incident of incidents) {
    const rows = printIncident(
      incident,
      result.byIncident.get(incident),
      result.totalsByIncident.get(incident),
      args.games,
      args.top
    );
    allRows.push({ incident, rows });
  }

  if (args.csv) printCsv(allRows);

  // 全異変を通した「偏りが大きいカード」の警告
  out('');
  out('--- 設計チェック（卓平均差の絶対値が大きいカード・相対指標）---');
  const flagged = [];
  for (const { incident, rows } of allRows) {
    for (const r of rows) flagged.push({ incident, ...r });
  }
  flagged.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const r of flagged.slice(0, 6)) {
    const tag = r.delta > 0 ? '持ちが強い' : '持ちが弱い';
    out(`  ${tag}: ${r.incident} / ${r.name}（${r.kind}・${r.count}枚） 卓平均差 ${r.delta >= 0 ? '+' : ''}${fmt(r.delta, 2)} 取得率 ${fmt(r.acquireRate * 100, 1)}%`);
  }

  if (args.ablate) runAblation(args, incidents, result.totalsByIncident);
  if (args.byCard) runByCard(args, args.byCard);

  if (args.out) {
    fs.writeFileSync(args.out, OUTPUT_LINES.join('\n') + '\n', 'utf8');
    console.log(`レポートを書き出した: ${args.out}`);
  }
}

// スクリプトから再利用できるように公開（require されたときは main を走らせない）
module.exports = { run, playGame, runWithSeed, mean, fmt, parseArgs };

if (require.main === module) main();
