'use strict';

// カード枚数の保存則チェック（AI 同士で完走させ、ラウンド境界ごとに数える）。
// node tools/consistency-test.js [--full]
// 既定は高速版（2/3/4 人 × seed 1..8）。--full で seed 1..120 の全 sweep。
//
// ラウンドの途中で数えない理由は tools/zones.js のコメントを参照
// （慧音のコピーはラウンド中だけ taken に存在する仮想カード）。

const Engine = require('../engine.js');
const AI = require('../ai.js');
const Data = require('../data.js');
const Zones = require('./zones.js');

const GUARD = 5000;

// 1 ゲームを AI で完走させ、境界ごとの保存則違反を返す
function playAndCheck(incident, playerCount, seed) {
  return Zones.withSeed(seed, () => {
    const names = Array.from({ length: playerCount }, (_, i) => 'P' + i);
    const state = Engine.newGame(playerCount, names, { incident });
    if (!state) return { incident, playerCount, seed, violations: [], skipped: true };

    const initial = { ...state.initialCounts };
    const violations = [];
    const check = (tag) => {
      const diff = Zones.countDiff(state, initial);
      if (diff.length) violations.push({ tag, diff: diff.slice(0, 4) });
    };

    check('start');
    let guard = 0;
    let lastRound = state.round;
    while (state.phase !== 'over' && guard++ < GUARD) {
      if (state.phase === 'pick') {
        for (let pi = 0; pi < playerCount; pi++) {
          if (state.picks[pi] !== null) continue;
          const idxs = AI.pick(state, pi);
          if (!idxs.length) Engine.dispatch(state, { kind: 'skip', pi });
          else if (idxs.length === 2) Engine.dispatch(state, { kind: 'pick2', pi, idxs });
          else Engine.dispatch(state, { kind: 'pick', pi, idx: idxs[0] });
        }
      } else if (state.phase === 'select') {
        for (const pi of state.selectNeeded) {
          if (state.selections[pi] !== null) continue;
          Engine.dispatch(state, { kind: 'choose', pi, choice: AI.selectChoice(state, pi) || {} });
        }
      }
      if (state.round !== lastRound) {
        lastRound = state.round;
        check('round' + state.round);
      }
    }
    if (state.phase !== 'over') violations.push({ tag: 'abort', diff: [{ key: 'guard', expected: 0, actual: guard }] });
    check('end');
    return { incident, playerCount, seed, violations, skipped: false };
  });
}

// opts: { incidents, playerCounts, seeds }
function check(opts = {}) {
  const incidents = opts.incidents || Data.INCIDENT_IDS.slice();
  const playerCounts = opts.playerCounts || [2, 3, 4];
  const seeds = opts.seeds || [1, 2, 3, 4, 5, 6, 7, 8];
  const results = [];
  for (const incident of incidents) {
    for (const playerCount of playerCounts) {
      for (const seed of seeds) results.push(playAndCheck(incident, playerCount, seed));
    }
  }
  const violations = [];
  for (const r of results) {
    if (!r.violations.length) continue;
    for (const v of r.violations) {
      violations.push({ incident: r.incident, playerCount: r.playerCount, seed: r.seed, tag: v.tag, diff: v.diff });
    }
  }
  return { games: results.filter((r) => !r.skipped).length, results, violations };
}

function main() {
  const full = process.argv.includes('--full');
  const opts = full
    ? { seeds: Array.from({ length: 120 }, (_, i) => i + 1) }
    : {};
  const res = check(opts);
  const copies = res.violations.filter((v) => v.diff.some((d) => d.key === 'y_keine'));
  console.log(`保存則チェック: ${res.games} ゲーム / 違反 ${res.violations.length} 件` +
    (copies.length ? `（慧音コピー関連 ${copies.length} 件）` : ''));
  for (const v of res.violations.slice(0, 12)) {
    console.log(`  ${v.incident} ${v.playerCount}人 seed${v.seed} ${v.tag}: ` +
      v.diff.map((d) => `${d.key} 期待${d.expected} 実際${d.actual}`).join(' / '));
  }
  process.exit(res.violations.length ? 1 : 0);
}

module.exports = { check, playAndCheck };

if (require.main === module) main();
