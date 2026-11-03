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

  // ゲーム末ボーナス（霊夢の通算ノルマ・魔理沙の通算最多）を狙う価値。
  // 閾値に近いほど次に取る 1 枚の価値が上がる（遠いとほぼ 0）
  function gameEndBonusValue(state, pi, def) {
    if (!def || !def.gameEnd) return 0;
    const p = state.players[pi];
    const total = (p.gameEndCounts && p.gameEndCounts[def.key]) || 0;
    let value = 0;
    if (def.gameEndTotalAtLeast) {
      const need = def.gameEndTotalAtLeast.count - total;
      if (need > 0 && need <= 3) value += def.gameEndTotalAtLeast.points / need;
    }
    if (def.gameEndMost) {
      // 「最多」ボーナスは最終ラウンドまで温存する（序盤から追うと過剰に集めてしまう）
      const isFinalRound = state.round >= DATA.RULES.ROUNDS - 1;
      const othersMax = Math.max(0, ...state.players
        .filter((_, i) => i !== pi)
        .map((q) => (q.gameEndCounts && q.gameEndCounts[def.key]) || 0));
      if (isFinalRound && total + 1 >= othersMax) value += def.gameEndMost.points / 3;
    }
    return value;
  }

  // 手札 1 枚を取ったときの「今ラウンドの得点」増分の見積もり。
  // engine.js のラウンド末・ゲーム末判定と同じ式をなぞり、増えるぶんだけを返す近似。
  // 条件系（同席・乱入者・ペナルティ）は「今の自分の場」で満たしているかで価値を変える。
  function baseCardValue(state, pi, card) {
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
        // 最多 +most / 最少 least。ただし実測では狙うと負けるので、他の札より低く見る
        const othersMax = Math.max(0, ...others.map((j) => countKey(state.players[j], key)));
        if (mine > othersMax) return 0.4;
        return mine === 0 && othersMax > 0 ? 1.4 : 1.1;
      }
      case 'maki': {
        // 最多 6 点 / 2 位 3 点は 1 ラウンドに 1 回だけ。実測では即時 1 枚に負ける
        return 0.6 * icons;
      }
      case 'collect': {
        const at = (k) => (k <= 0 ? 0 : def.table[Math.min(k, def.table.length) - 1]);
        return Math.max(0.2, at(mine + 1) - at(mine));
      }
      case 'pair': {
        // 揃うまで得点にならない。あと 1 枚なら現実味があるが、2 枚必要なら宝くじに近い
        const need = mine % 2 === 1 ? 1 : 2;
        return def.points * (need === 1 ? 0.7 : 0.3);
      }
      case 'set3': {
        const need = 3 - (mine % 3);
        return def.points * (need === 1 ? 0.8 : need === 2 ? 0.4 : 0.2);
      }
      case 'springMost': {
        const othersMax = Math.max(0, ...others.map((j) => state.roundStats[j].springIcons));
        return stats.springIcons > othersMax ? def.most * 0.45 : def.most * 0.18;
      }
      case 'springSteal': {
        const stolen = others.reduce((acc, j) => (state.roundStats[j].springIcons > 0 ? acc + def.steal : acc), 0);
        return 0.5 + stolen * 0.4;
      }
      case 'roundComboCount':
        return def.per * 0.7;
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
        return own > stats.springIcons ? def.mult * 0.5 : 0.2;
      }
      case 'coop': {
        // 自分以外が同じ手番に取った枚数ぶんの点。他人の選択は読めないので、
        // パック内のリグルの密度から「他の人が同時に取る枚数」を期待値で近似する
        const others = state.playerCount - 1;
        const expectedOthers = others * ((def.count || 1) / Math.max(1, packCardCount(state)));
        return (typeof def.points === 'number' ? def.points : 1) * expectedOthers;
      }
      case 'flip':
        return 0.7; // 腐ったカードを 2 点に変換できるが、変換に 1 手使うので実際は軽い
      case 'copy':
        return 1.7; // 一番強いカードの効果を複製（実測では取りすぎると負ける）
      case 'deckPeek':
        return 1.7 + (def.peek || 4) * 0.07;
      case 'dessertLeast':
        // 最少になると減点。同点最少が複数いると全員に飛ぶので、1 枚持つ価値は高い
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

  // ラウンド点の見積もりにゲーム末ボーナスを足した総合評価
  function cardValue(state, pi, card) {
    const key = typeof card === 'string' ? card : card.key;
    return baseCardValue(state, pi, card) + gameEndBonusValue(state, pi, state.cardMap[key]);
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

  // そのカード 1 枚が「今のまま」生むラウンド点。破棄/裏返しで失う分を見るのに使う。
  // 収集・ペア・種類数などは他のカードとの兼ね合いで決まるため null（触らない）
  function ownValue(state, pi, inst) {
    const def = state.cardMap[inst.key];
    if (!def) return null;
    if (def.kind === 'instant') {
      if (inst.absentBlocked) return 0;
      let v = def.points;
      if (inst.instantCombo && def.comboBonus) v += def.comboBonus;
      const stats = state.roundStats[pi];
      if (def.intruderPenalty && stats && stats.intruderTaken) v -= def.intruderPenalty;
      return v;
    }
    if (def.kind === 'coop') return inst.coopPoints || 0;
    return null;
  }

  // 慧音がコピーしたときの見返り。即時・リグルは実点、それ以外は取得したときの増分で近似
  function copyTargetValue(state, pi, inst) {
    const own = ownValue(state, pi, inst);
    return own === null ? cardValue(state, pi, inst) : own;
  }

  // 取得時選択の AI 解答。山札確認（小悪魔）・コピー（慧音）・裏返し（ミスティア）・破棄（フラン）
  // はいずれも「使わない」が既定なので、使ったほうが得なときだけ選ぶ
  function selectChoice(state, pi) {
    const need = engineOf().selectionNeeded(state, pi);
    const p = state.players[pi];
    const choice = {};

    if (need.peek && state.peekCards && state.peekCards[pi]) {
      let best = -1;
      let bestValue = -Infinity;
      state.peekCards[pi].forEach((inst, idx) => {
        const value = cardValue(state, pi, inst);
        if (value > bestValue) { bestValue = value; best = idx; }
      });
      if (best >= 0) choice.pick = best;
    }

    if (need.copy) {
      // 一番価値の高いカードの効果をコピーする（慧音自身は対象外）
      let best = -1;
      let bestValue = 0.5;
      p.taken.forEach((inst, idx) => {
        const def = state.cardMap[inst.key];
        if (!def || def.kind === 'copy' || inst.discarded || inst.flipped) return;
        const value = copyTargetValue(state, pi, inst);
        if (value > bestValue) { bestValue = value; best = idx; }
      });
      if (best >= 0) choice.copy = best;
    }

    if (need.flip) {
      // 裏返すと 2 点になるので、2 点未満のカードだけ裏返す
      const targets = [];
      p.taken.forEach((inst, idx) => {
        const def = state.cardMap[inst.key];
        if (!def || def.kind === 'flip' || inst.discarded || inst.flipped) return;
        const value = ownValue(state, pi, inst);
        if (value !== null && value < 2) targets.push(idx);
      });
      if (targets.length) choice.flip = targets;
    }

    if (need.discard) {
      // 破棄すると +2 点なので、2 点未満のカードを 1 枚選ぶ（フラン自身は対象外）
      let best = -1;
      let bestValue = 2;
      p.taken.forEach((inst, idx) => {
        const def = state.cardMap[inst.key];
        if (!def || def.discardBonus || inst.discarded) return;
        const value = ownValue(state, pi, inst);
        if (value !== null && value < bestValue) { bestValue = value; best = idx; }
      });
      if (best >= 0) choice.discard = best;
    }

    return choice;
  }

  return { pick, pick2, cardValue, selectChoice };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  if (typeof window !== 'undefined') window.AI = AI;
})();
