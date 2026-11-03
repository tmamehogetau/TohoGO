'use strict';

// AI プレイヤー。ヒューリスティック評価 + 乱数タイブレーク。
// picks 配列形式（1 or 2 枚の idx 配列）を返す。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、let 宣言の衝突を防ぐ。

(function () {
  let DATA;
  if (typeof window !== 'undefined' && window.Data) DATA = window.Data;
  else DATA = require('./data.js');

  function engineOf() {
    if (typeof window !== 'undefined' && window.Engine) return window.Engine;
    return require('./engine.js');
  }

  const AI = (() => {
  const { RULES } = DATA;

  function countKey(p, key) {
    return p.taken.filter((k) => k === key).length;
  }

  function cardValue(state, pi, key) {
    const p = state.players[pi];
    switch (key) {
      case 'dish3': return p.pendingSpell > 0 ? 12 : 4;
      case 'dish2': return p.pendingSpell > 0 ? 10 : 3;
      case 'dish1': return p.pendingSpell > 0 ? 8 : 1.5;
      case 'spell': return p.pendingSpell === 0 ? 5 : 0;
      case 'sake':
        // 奇数枚持っていれば次でペア成立（高価値）
        return countKey(p, 'sake') % 2 === 1 ? 7 : 4;
      case 'chinmi':
        return countKey(p, 'chinmi') % 3 === 2 ? 9 : 4;
      case 'dumpling': {
        const d = countKey(p, 'dumpling');
        const next = RULES.DUMPLING_TABLE[Math.min(d + 1, 5) - 1];
        const cur = d > 0 ? RULES.DUMPLING_TABLE[Math.min(d, 5) - 1] : 0;
        return 3 + (next - cur) * 0.8;
      }
      case 'firework': {
        const my = countKey(p, 'firework');
        const othersMax = Math.max(
          ...state.players.filter((_, i) => i !== pi).map((q) => countKey(q, 'firework'))
        );
        return my >= othersMax ? 6 : 3;
      }
      case 'charm': return 3;
      case 'chopsticks': return 4.5;
      default: return 1;
    }
  }

  function rankedHand(state, pi) {
    const hand = state.players[pi].hand;
    return hand
      .map((key, idx) => ({ idx, value: cardValue(state, pi, key) + Math.random() * 0.5 }))
      .sort((a, b) => b.value - a.value);
  }

  function pick(state, pi) {
    const ranked = rankedHand(state, pi);
    if (ranked.length === 0) return []; // 手札なし → engine の skip アクションで待機
    return [ranked[0].idx];
  }

  function pick2(state, pi) {
    const ranked = rankedHand(state, pi);
    if (ranked.length < 2) return ranked.map((r) => r.idx); // 手札不足なら通常ピックにフォールバック
    return [ranked[0].idx, ranked[1].idx].sort((a, b) => a - b);
  }

  // 取得時選択の AI 解答: 小悪魔の山札確認（peek）がある場合は候補から即時点が高いカードを 1 枚選ぶ
  function selectChoice(state, pi) {
    const need = engineOf().selectionNeeded(state, pi);
    if (need.peek && state.peekCards && state.peekCards[pi]) {
      let best = 0;
      let bestPts = -1;
      state.peekCards[pi].forEach((inst, idx) => {
        const def = state.cardMap[inst.key];
        const pts = def && def.kind === 'instant' ? def.points : def ? 1 : 0;
        if (pts > bestPts) { bestPts = pts; best = idx; }
      });
      return { pick: best };
    }
    return {};
  }

  return { pick, pick2, cardValue, selectChoice };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  if (typeof window !== 'undefined') window.AI = AI;
})();
