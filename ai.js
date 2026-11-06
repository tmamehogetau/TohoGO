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
  // 理想重視モード（開発用）: DRAFT_AI_IDEAL=1 で全席、DRAFT_AI_IDEAL_SEAT=<席番号> でその席だけ
  function idealMode(pi) {
    const seat = process.env.DRAFT_AI_IDEAL_SEAT;
    if (seat !== undefined && seat !== '' && String(pi) === String(seat)) return true;
    return process.env.DRAFT_AI_IDEAL === '1';
  }

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
        // 同じ手番の条件（永琳: 誰かが輝夜を出していれば加点）。確率は控えめに 0.5 で見積もる
        if (def.pointsIfPicked) {
          value += (def.pointsIfPicked.bonus || 1) * 0.5;
        }
        // 乱入者ペナルティ: 既に取っていれば確定減点、まだなら確率ぶんだけ割り引く
        if (def.intruderPenalty) {
          value -= stats.intruderTaken ? def.intruderPenalty : def.intruderPenalty * 0.4;
        }
        // 同席条件（咲夜）: 誰かが条件カードを取っていれば、このラウンドは 0 点
        if (def.absentKeys) {
          const blocked = others.some((j) => def.absentKeys.some((k) => countKey(state.players[j], k) > 0));
          value = blocked ? 0.2 : value * 0.85;
        }
        // zeroIfTaken（レティ）: 同じ手番に条件カードを取られると 0 点。期待値を割り引く
        if (def.zeroIfTaken) value *= 0.5;
        // 取得時コンボ（美鈴・藍・橙）: 相方が既に手元なら加点される
        if (def.comboKeys) {
          const held = def.comboKeys.filter((k) => countKey(p, k) > 0).length;
          // ラウンド末コンボ（藍・橙）は揃うほど加点、取得時コンボ（美鈴）は揃ったときだけ
          if (def.comboAtEnd) value += (def.comboBonus || 0) * (held / def.comboKeys.length);
          else if (held === def.comboKeys.length) value += def.comboBonus || 0;
        }
        return value;
      }
      case 'othersDiff': {
        // 他人の取得数で決まるので、平均的には小さめ（自分1枚では点にならない）
        return 1.2;
      }
      case 'temaki': {
        // 最多 +most / 最少 least。ただし実測では狙うと負けるので、他の札より低く見る
        const othersMax = Math.max(0, ...others.map((j) => countKey(state.players[j], key)));
        if (mine > othersMax) return 0.4;
        return mine === 0 && othersMax > 0 ? 1.4 : 1.1;
      }
      case 'maki': {
        // 最多 6 点 / 2 位 3 点は 1 ラウンドに 1 回だけ。実測では即時 1 枚に負ける
        // 妖夢の加護が残っていれば、次の春はアイコン数ぶんの点と春が付くので強めに見る
        const buff = (p.springBuff || 0) > 0 ? 1.2 : 0;
        return 0.6 * icons + buff;
      }
      case 'collect': {
        const at = (k) => (k <= 0 ? 0 : def.table[Math.min(k, def.table.length) - 1]);
        // 理想重視モード（DSH_AI_IDEAL=1）: 完成まで取り切れたと仮定した「残りの平均ゲイン」で評価する。
        // 現実モードは次の 1 枚の限界だけを見るので、1 枚目が 0 点の札（魔理沙など）を避ける。
        if (idealMode(pi)) {
          const remain = Math.max(1, def.table.length - mine);
          return Math.max(0.2, (at(def.table.length) - at(mine)) / remain);
        }
        const step = (k) => Math.max(0, at(k + 1) - at(k));
        let v = Math.max(0.2, step(mine));
        // 先読みモード（DRAFT_AI_LOOKAHEAD=1）: 2枚先の限界を半額で足す。閾値の白黒を避ける
        if (process.env.DRAFT_AI_LOOKAHEAD === '1' || policyOf(pi) === 'adaptive') v = Math.max(0.2, step(mine) + 0.5 * step(mine + 1));
        // 妨害モード（DRAFT_AI_BLOCK=1）: 相手が完成に近いほど「取って潰す」価値を足す。
        // 重み 0.4 = 相手の損の4割ぶんを自分の得に換算（損して得取る思考の近似）
        if (process.env.DRAFT_AI_BLOCK === '1') {
          let oppMax = 0;
          for (let j = 0; j < state.players.length; j++) {
            if (j === pi) continue;
            const n = countKey(state.players[j], key);
            if (n > oppMax) oppMax = n;
          }
          if (oppMax > 0) v += 0.4 * step(oppMax);
        }
        return v;
      }
      case 'pairCond': {
        const need = mine % 2 === 1 ? 1 : 2;
        return def.points * (need === 1 ? 0.7 : 0.3);
      }
      case 'aliceSet': {
        const group = def.group || def.key;
        const types = new Set();
        for (const inst of p.taken) {
          if (inst.flipped || inst.discarded) continue;
          const d = state.cardMap[inst.key];
          if (d && d.kind === 'aliceSet' && (d.group || d.key) === group) types.add(inst.key);
        }
        const tbl = def.table || [0, 1, 4, 9, 16];
        const next = types.has(key) ? types.size : types.size + 1;
        return Math.max(0, (tbl[next] || 0) - (tbl[types.size] || 0));
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
      case 'springBoost':
        // 次の春でアイコン数ぶんの春と点。春がまだ手元/山に残っていそうなら強め
        return p.taken.some((i) => i.key === 's_spring') ? 2.4 : 1.6;
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
      case 'dessertMostLeast': {
        // ゲーム末に最多 +most / 最少 −least。序盤は様子見、終盤は最少脱出を優先
        const mine = dessertCount(state, pi, key);
        const others = state.players.map((q, i) => (i === pi ? mine : dessertCount(state, i, key)));
        const othersMax = Math.max(...state.players.map((q, i) => (i === pi ? -1 : dessertCount(state, i, key))));
        const othersMin = Math.min(...state.players.map((q, i) => (i === pi ? 99 : dessertCount(state, i, key))));
        const isFinal = state.round >= RULES.ROUNDS - 1;
        let v = 0.25;
        if (mine + 1 >= othersMax) v += 0.9; // 最多を狙える
        if (mine <= othersMin) v += isFinal ? 1.6 : 0.6; // 最少だと終盤に刺さる
        return v;
      }
      case 'dessertRound': {
        // ラウンド内は 1 枚ごとに -1。ゲーム末は最多に「固定 endMost」または「枚数 × endMostPer」
        const mine = dessertCount(state, pi, key);
        const others = Math.max(...state.players.map((q, i) => (i === pi ? -1 : dessertCount(state, i, key))));
        const inRace = mine + 1 >= others;
        if (def.roundPenaltyCumulative && def.roundPenalty) {
          // 累計ペナルティ: このカードは以後のラウンド末すべてで課税される（R1で取ると3回・R3で1回）
          const remaining = RULES.ROUNDS - state.round;
          const upside = inRace ? (def.endMostPer || 2) : 0;
          return def.roundPenalty * remaining + upside;
        }
        if (def.endMost !== undefined) {
          // 固定加点: 最多を取る価値が一跳びで大きいので、届く位置なら強く狙う
          return inRace ? 2.2 : 0.4;
        }
        if (def.endMostPer) {
          // 枚数比例: 最多グループに入れば 1 枚あたり +2 - 1 = 純 +1。届かない位置なら -1 の損
          return inRace ? 1.1 : 0.3;
        }
        return 1.5;
      }
      default:
        return 1.5;
    }
  }

  // 好みプロファイル（style）。標準は重みなし。
  // 「春プラン」= 春・幽々子・妖夢を優先し、春と逆向きのレティは避ける
  const STYLES = {
    standard: {},
    spring: { maki: 3, springMost: 3, springSteal: 3, letty: 0.2 },
    set: { pair: 2.5, set3: 2.5 },
    instant: { instant: 1.6 },
  };

  // ラウンド点の見積もりにゲーム末ボーナスを足した総合評価（style で重み付け）
  function cardValue(state, pi, card, style) {
    const key = typeof card === 'string' ? card : card.key;
    const def = state.cardMap[key];
    const base = baseCardValue(state, pi, card) + gameEndBonusValue(state, pi, def);
    const weights = STYLES[style] || STYLES.standard;
    const mult = def ? weights[def.kind] : undefined;
    return mult === undefined ? base : base * mult;
  }

  // 性格（検証用）: DRAFT_AI_POLICY_SEATS="0:greedy,1:adaptive,2:denial"
  //   greedy   = 自分の点だけを最大化（相手を見ない）
  //   adaptive = 状況適応（完成確率の先読み＋軽い妨害）
  //   denial   = 相手の得を潰すことを重視しつつ勝ちを狙う
  function policyOf(pi) {
    const s = process.env.DRAFT_AI_POLICY_SEATS;
    if (!s) return null;
    for (const part of s.split(',')) {
      const bits = part.split(':');
      if (Number(bits[0]) === pi) return bits[1];
    }
    return null;
  }

  // 相手がこのカードを取ったときに得する点（妨害価値の近似）
  function opponentGain(state, pi, key) {
    const def = state.cardMap[key];
    if (!def) return 0;
    let best = 0;
    for (let j = 0; j < state.players.length; j++) {
      if (j === pi) continue;
      const n = countKey(state.players[j], key);
      let g = 0;
      if (def.kind === 'collect') {
        const at = (k) => (k <= 0 ? 0 : def.table[Math.min(k, def.table.length) - 1]);
        g = Math.max(0, at(n + 1) - at(n));
      } else if (def.kind === 'pair') {
        g = (n + 1) % 2 === 0 ? def.points : 0;
      } else if (def.kind === 'set3') {
        g = (n + 1) % 3 === 0 ? def.points : 0;
      } else if (def.kind === 'instant') {
        g = def.points || 0;
      }
      if (g > best) best = g;
    }
    return best;
  }

  function rankedHand(state, pi, style) {
    const hand = state.players[pi].hand;
    const pol = policyOf(pi);
    return hand
      .map((card, idx) => {
        let value = cardValue(state, pi, card, style);
        const key = typeof card === 'string' ? card : card.key;
        if (pol === 'denial') {
          // 妨害は「相手の次の一段が大きいとき」だけ。小さい得のために picks を捨てない
          const og = opponentGain(state, pi, key);
          const min = Number(process.env.DRAFT_AI_DENIAL_MIN || 4);
          if (og >= min) value += 0.45 * og;
        } else if (pol === 'adaptive') value += 0.15 * opponentGain(state, pi, key);
        return { idx, value: value + Math.random() * 0.5 };
      })
      .sort((a, b) => b.value - a.value);
  }

  function pick(state, pi, style) {
    const ranked = rankedHand(state, pi, style);
    if (ranked.length === 0) return []; // 手札なし → engine の skip アクションで待機
    return [ranked[0].idx];
  }

  function pick2(state, pi, style) {
    const ranked = rankedHand(state, pi, style);
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
  function selectChoice(state, pi, style) {
    const need = engineOf().selectionNeeded(state, pi);
    const p = state.players[pi];
    const choice = {};

    if (need.peek && state.peekCards && state.peekCards[pi]) {
      let best = -1;
      let bestValue = -Infinity;
      state.peekCards[pi].forEach((inst, idx) => {
        const value = cardValue(state, pi, inst, style);
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

    if (need.swap) {
      // 交換で山札の平均的な札が来るので、明らかに弱い札だけ交換する（交換そのものは 0 点）。
      // 一番弱い札を 1 枚選んで交換する（永琳自身とデザートは対象外）
      const dessertKey = state.dessert && state.dessert.key;
      let best = -1;
      let bestValue = Infinity;
      p.taken.forEach((inst, idx) => {
        const def = state.cardMap[inst.key];
        if (!def || def.swap || inst.discarded) return;
        if (def.key === dessertKey) return;
        const value = ownValue(state, pi, inst);
        const v = value === null ? 0 : value;
        if (v < bestValue) { bestValue = v; best = idx; }
      });
      if (best >= 0 && bestValue < 2) choice.swap = best;
    }

    return choice;
  }

  return { pick, pick2, cardValue, selectChoice, STYLES };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  if (typeof window !== 'undefined') window.AI = AI;
})();








