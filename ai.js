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

  // 手元の枚数。engine.countKey と同じくアイコン合計で数える（マキ・ペアの判定と揃える）
  function countKey(p, key) {
    let n = 0;
    for (const inst of p.taken) {
      if (inst.key !== key || inst.flipped || inst.discarded) continue;
      n += inst.icons || 1;
    }
    return n;
  }

  // デザート置き場も含めた所持数（デザート系はラウンド末に置き場へ移るため）
  function dessertCount(state, pi, key) {
    const p = state.players[pi];
    const inTaken = p.taken.filter((i) => i.key === key && !i.discarded && !i.flipped).length;
    return inTaken + p.desserts.filter((i) => i.key === key).length;
  }

  // メインデッキの総枚数（デザートは別プールなので除く）。他人の同時取得の期待値に使う
  function packCardCount(state) {
    let n = 0;
    for (const d of Object.values(state.cardMap)) {
      if (d.pool) continue;
      if (d.iconCounts) n += Object.values(d.iconCounts).reduce((a, b) => a + b, 0);
      else n += d.count || 1;
    }
    return n;
  }

  // 手札 1 枚を取ったときの「今ラウンドの得点」増分の見積もり。
  // engine.js のラウンド末・ゲーム末判定と同じ式をなぞり、増えるぶんだけを返す近似。
  // 条件系（同席・乱入者・ペナルティ）は「今の自分の場」で満たしているかで価値を変える。
  function cardValue(state, pi, card) {
    const key = typeof card === 'string' ? card : card.key;
    const def = state.cardMap[key];
    if (!def) return 1;
    const p = state.players[pi];
    const stats = (state.roundStats && state.roundStats[pi]) || { springIcons: 0, dessertTaken: 0, intruderTaken: false };
    const others = state.players.map((_, i) => i).filter((i) => i !== pi);
    const mine = countKey(p, key);
    const icons = (typeof card === 'object' && card.icons) || 1;

    switch (def.kind) {
      case 'instant': {
        let value = def.points;
        // 乱入者ペナルティ: 既に取っていれば確定減点、まだなら確率ぶんだけ割り引く
        if (def.intruderPenalty) {
          value -= stats.intruderTaken ? def.intruderPenalty : def.intruderPenalty * 0.4;
        }
        // 同席条件（咲夜）: 誰かが条件カードを取っていれば、このラウンドは 0 点
        if (def.absentKeys) {
          const blocked = others.some((j) => def.absentKeys.some((k) => countKey(state.players[j], k) > 0));
          value = blocked ? 0.2 : value * 0.85;
        }
        // 取得時コンボ（美鈴・藍・橙）: 相方が既に手元なら加点される
        if (def.comboKeys && def.comboKeys.some((k) => countKey(p, k) > 0)) value += def.comboBonus || 0;
        return value;
      }
      case 'temaki': {
        // 最多 +most / 最少 least。既に最多なら維持、そうでなければ取りに行く
        const othersMax = Math.max(0, ...others.map((j) => countKey(state.players[j], key)));
        if (mine > othersMax) return 1.2;
        return mine === 0 && othersMax > 0 ? 4.0 : 3.2;
      }
      case 'maki': {
        // 最多 6 点 / 2 位 3 点を 4 人で分け合う想定 → 1 アイコンあたり 1.8 点前後
        return 1.8 * icons;
      }
      case 'collect': {
        const at = (k) => (k <= 0 ? 0 : def.table[Math.min(k, def.table.length) - 1]);
        return Math.max(0.2, at(mine + 1) - at(mine));
      }
      case 'pair':
        return mine % 2 === 1 ? def.points : def.points / 2;
      case 'set3':
        return mine % 3 === 2 ? def.points : def.points / 3;
      case 'springMost': {
        const othersMax = Math.max(0, ...others.map((j) => state.roundStats[j].springIcons));
        return stats.springIcons > othersMax ? def.most * 0.9 : def.most * 0.35;
      }
      case 'springSteal': {
        const stolen = others.reduce((acc, j) => (state.roundStats[j].springIcons > 0 ? acc + def.steal : acc), 0);
        return 0.8 + stolen * 0.7;
      }
      case 'roundComboCount':
        return def.per * 1.2;
      case 'tofu': {
        const at = (k) => (k <= 0 ? 0 : def.table[Math.min(k, def.table.length) - 1]);
        return at(mine + 1) - at(mine); // 3 枚目は負になるので取らなくなる
      }
      case 'kindCount': {
        const isNew = !p.taken.some((i) => i.key === key && !i.flipped && !i.discarded);
        return isNew ? 1.1 : 0.2;
      }
      case 'letty': {
        const own = countKey(p, def.ownKey);
        return own > stats.springIcons ? def.mult : 0.4;
      }
      case 'coop': {
        // 自分以外が同じ手番に取った枚数ぶんの点。他人の選択は読めないので、
        // パック内のリグルの密度から「他の人が同時に取る枚数」を期待値で近似する
        const others = state.playerCount - 1;
        const expectedOthers = others * ((def.count || 1) / Math.max(1, packCardCount(state)));
        return (typeof def.points === 'number' ? def.points : 1) * expectedOthers;
      }
      case 'flip':
        return 2.6; // 腐ったカードを 2 点に変換できる
      case 'copy':
        return 2.8; // 一番強いカードの効果を複製
      case 'deckPeek':
        return 2.4 + (def.peek || 4) * 0.1;
      case 'collectByTwo': {
        const next = mine + 1;
        return def.per2 / 2 + (next % 2 === 0 && next >= 4 ? def.bonusAt4 * 0.6 : 0);
      }
      case 'parity':
        return (def.per2Even + def.per2Odd) / 4;
      case 'dessertLeast':
        // 最少になると減点。1 枚持つだけで回避できるので初動の価値が高い
        return dessertCount(state, pi, key) === 0 ? Math.min(4.5, Math.abs(def.least) / 2) : 1.2;
      case 'dessertIce':
        return def.points / def.per;
      case 'dessertRound': {
        const isFinal = state.round === RULES.ROUNDS - 1;
        return isFinal ? -1 : def.roundMost / 2 + 1;
      }
      default:
        return 1.5;
    }
  }

  function rankedHand(state, pi) {
    const hand = state.players[pi].hand;
    return hand
      .map((card, idx) => ({ idx, value: cardValue(state, pi, card) + Math.random() * 0.5 }))
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

  // 取得時選択の AI 解答: 小悪魔の山札確認（peek）は候補の中で一番価値が高いカードを取る
  function selectChoice(state, pi) {
    const need = engineOf().selectionNeeded(state, pi);
    if (need.peek && state.peekCards && state.peekCards[pi]) {
      let best = -1;
      let bestValue = -Infinity;
      state.peekCards[pi].forEach((inst, idx) => {
        const value = cardValue(state, pi, inst);
        if (value > bestValue) { bestValue = value; best = idx; }
      });
      if (best >= 0) return { pick: best };
    }
    return {};
  }

  return { pick, pick2, cardValue, selectChoice };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  if (typeof window !== 'undefined') window.AI = AI;
})();
