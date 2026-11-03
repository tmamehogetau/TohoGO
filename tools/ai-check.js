'use strict';

// AI の「標準らしさ」を検証する。node tools/ai-check.js で実行。
//
// 3 つの観点で見る。
//   1. 同型対戦    : 同じ AI 4 人で 25% 前後になるか（偏りがないか）
//   2. 摂動耐性    : 評価を ±10% ずらした相手に負けないか（簡単に搾れないか）
//   3. 異種混合    : 癖のある相手 3 人を相手に極端に弱くないか
//
// 数値は「席 0 の勝率」。4200 ゲーム（1400 × 3 異変）で標準誤差は約 0.7%。

const Engine = require('../engine.js');
const AI = require('../ai.js');
const Data = require('../data.js');
const sim = require('./sim.js');

const GAMES_PER_PACK = 1400;
const SEED = 1;

// 摂動の強さ（±10%）
const PERTURBATIONS = {
  '+10% 即時点': { instant: 1.1 },
  '-10% 即時点': { instant: 0.9 },
  '+10% ペア/セット': { pair: 1.1, set3: 1.1 },
  '-10% ペア/セット': { pair: 0.9, set3: 0.9 },
  '+10% 順位系': { maki: 1.1, temaki: 1.1 },
  '-10% 順位系': { maki: 0.9, temaki: 0.9 },
  '+10% デザート': { dessertLeast: 1.1, dessertIce: 1.1, dessertRound: 1.1 },
  '-10% デザート': { dessertLeast: 0.9, dessertIce: 0.9, dessertRound: 0.9 },
};

// 異種混合の相手（即時好き / セット好き / 順位＋デザート好き）
const STYLED_OPPONENTS = [
  { instant: 1.5 },
  { pair: 1.5, set3: 1.5 },
  { maki: 2, temaki: 2, dessertLeast: 2, dessertIce: 2, dessertRound: 2 },
];

function valueFor(state, pi, card, mult) {
  const def = state.cardMap[card.key];
  let v = AI.cardValue(state, pi, card);
  if (mult[def.kind] !== undefined) v *= mult[def.kind];
  return v;
}

function pickFor(s, pi, mult) {
  const hand = s.players[pi].hand;
  if (hand.length === 0) return { kind: 'skip', pi };
  const ranked = hand
    .map((card, idx) => ({ idx, value: valueFor(s, pi, card, mult) + Math.random() * 0.4 }))
    .sort((a, b) => b.value - a.value);
  if (s.players[pi].chopsticks > 0 && hand.length >= 2) {
    return { kind: 'pick2', pi, idxs: [ranked[0].idx, ranked[1].idx].sort((a, b) => a - b) };
  }
  return { kind: 'pick', pi, idx: ranked[0].idx };
}

function play(incident, seatMults) {
  const s = Engine.newGame(4, ['A', 'B', 'C', 'D'], { incident });
  let guard = 0;
  while (s.phase !== 'over' && guard++ < 5000) {
    if (s.phase === 'select') {
      for (const pi of s.selectNeeded) {
        if (s.selections[pi] !== null) continue;
        Engine.dispatch(s, { kind: 'choose', pi, choice: AI.selectChoice(s, pi) });
      }
    } else {
      for (let pi = 0; pi < 4; pi++) {
        if (s.picks[pi] !== null) continue;
        Engine.dispatch(s, pickFor(s, pi, seatMults[pi]));
      }
    }
  }
  return [0, 1, 2, 3].map((pi) => Engine.scorePlayer(s, pi));
}

// seat0 の勝率を返す。others は席 1..3 の重み（省略時は標準）。
function seat0WinRate(seat0Mult, others) {
  const seatMults = [seat0Mult, ...(others || [{}, {}, {}])];
  const results = sim.runWithSeed(SEED, () => {
    const out = [];
    for (const id of Data.INCIDENT_IDS) {
      for (let i = 0; i < GAMES_PER_PACK; i++) out.push(play(id, seatMults));
    }
    return out;
  });
  let win = 0;
  for (const r of results) {
    const best = Math.max(...r);
    const winners = r.filter((x) => x === best).length;
    if (r[0] === best) win += 1 / winners;
  }
  return (win / results.length) * 100;
}

let ng = 0;
function verdict(ok, label, value, range) {
  if (!ok) ng += 1;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label.padEnd(24)}${value.toFixed(1)}%   (目安 ${range})`);
}

console.log('=== 1. 同型対戦（偏りがないか） ===');
const mirror = seat0WinRate({});
verdict(Math.abs(mirror - 25) <= 3, '標準AI vs 標準AI', mirror, '25±3');

console.log('');
console.log('=== 2. 摂動耐性（±10% ずらした相手に負けないか） ===');
for (const [label, mult] of Object.entries(PERTURBATIONS)) {
  const win = seat0WinRate({}, [mult, {}, {}]);
  verdict(win >= 22, `相手 ${label}`, win, '22% 以上');
}

console.log('');
console.log('=== 3. 異種混合（癖のある相手3人） ===');
const hetero = seat0WinRate({}, STYLED_OPPONENTS);
verdict(hetero >= 18, '標準AI vs 3スタイル', hetero, '18% 以上');

console.log('');
console.log(ng === 0 ? '判定: 合格' : `判定: NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
