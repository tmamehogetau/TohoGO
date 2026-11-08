'use strict';

// カードの所在を集計する共通実装（テスト・プローブ用）。
//
// 注意: 慧音のコピーは「ラウンド中だけ taken に存在する仮想カード」なので、
//       枚数の保存則はラウンド境界（配り直した直後）で検査すること。
//       ラウンドの途中で数えると、コピーが正当に存在するぶんだけ多く見える。

// state 内のすべてのカード実体（{ key } を持つオブジェクト）を列挙する
function zonesOf(state) {
  const out = [];
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const inst of arr) if (inst && inst.key) out.push(inst);
  };
  add(state.deck);
  add(state.dessertPool);
  if (Array.isArray(state.peekCards)) for (const cards of state.peekCards) add(cards);
  for (const p of state.players) {
    add(p.hand);
    add(p.taken);
    add(p.desserts);
  }
  return out;
}

// key ごとの枚数
function countAll(state) {
  const counts = {};
  for (const inst of zonesOf(state)) counts[inst.key] = (counts[inst.key] || 0) + 1;
  return counts;
}

// 初期構成との差分（空配列なら保存則が成立）
function countDiff(state, initialCounts) {
  const now = countAll(state);
  const keys = new Set([...Object.keys(initialCounts || {}), ...Object.keys(now)]);
  const out = [];
  for (const key of keys) {
    const expected = (initialCounts || {})[key] || 0;
    const actual = now[key] || 0;
    if (expected !== actual) out.push({ key, expected, actual });
  }
  return out;
}

// エンジンは seed 引数を持たないため、実行中だけ Math.random を差し替えて再現する
function withSeed(seed, fn) {
  const orig = Math.random;
  let a = (seed >>> 0) || 1;
  Math.random = () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

module.exports = { zonesOf, countAll, countDiff, withSeed };
