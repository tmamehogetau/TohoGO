'use strict';

// ヘッドレス・ドラフトエンジン（異変パックシステム版）。
// state は plain object、全変更を dispatch に集約。
// 進行: ピック →（必要なら取得時選択）→ パス → ラウンド末判定 → 山札リサイクル → デザート混入 → 次ラウンド。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、let 宣言の衝突を防ぐ。

(function () {
  let DATA;
  if (typeof window !== 'undefined' && window.Data) DATA = window.Data;
  else DATA = require('./data.js');

  const Engine = (() => {
    const { RULES, INCIDENT_IDS, incidentById, buildCardMap, buildMainDeck, buildDessertPool } = DATA;

    const PASS_DIRS = [1, -1, 1];

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function ok() { return { ok: true }; }
    function err(msg) { return { ok: false, error: msg }; }

    function addLog(state, text) {
      state.log.push({ round: state.round, text });
    }

    // ---------------- ゲーム開始 ----------------

    function newGame(playerCount, names, opts) {
      const handSize = RULES.HAND_SIZES[playerCount];
      if (!handSize) return null;
      const opts_ = opts || {};

      // 異変抽選（テスト用に opts.incident で固定可）
      const incidentId = opts_.incident || INCIDENT_IDS[Math.floor(Math.random() * INCIDENT_IDS.length)];
      const incident = incidentById(incidentId);

      // 乱入者抽選（永夜のみ・テスト用に opts.intruder で固定可）
      let intruderDef = null;
      if (incident.intruders && incident.intruders.length) {
        if (opts_.intruder) {
          intruderDef = incident.intruders.find((d) => d.key === opts_.intruder) || null;
        } else {
          intruderDef = incident.intruders[Math.floor(Math.random() * incident.intruders.length)];
        }
      }

      const cardMap = buildCardMap(incident, intruderDef);
      const deck = buildMainDeck(incident, intruderDef);
      const dessertPool = buildDessertPool(incident);

      const players = [];
      for (let i = 0; i < playerCount; i++) {
        players.push({
          name: names[i] || `Player ${i + 1}`,
          hand: [],
          taken: [],   // インスタンス { key, icons?, flipped?, copied? }
          desserts: [], // デザート蓄積
          chopsticks: 0,
          roundScores: [0, 0, 0],
        });
      }

      const state = {
        playerCount,
        handSize,
        players,
        deck: shuffle(deck),
        dessertPool: shuffle(dessertPool),
        dessert: incident.dessert,
        incidentId: incident.id,
        incidentName: incident.name,
        incidentSubtitle: incident.subtitle,
        incidentTheme: incident.theme,
        cardMap,
        intruderKey: intruderDef ? intruderDef.key : null,
        round: 0,
        passDir: PASS_DIRS[0],
        picks: new Array(playerCount).fill(null),
        choices: new Array(playerCount).fill(null), // 取得時選択（select フェーズ用）
        phase: 'pick',
        lastPicks: [],
        roundBanner: null,
        log: [],
        hidden: false, // うどんげの情報隠蔽
      };
      addLog(state, `異変「${incident.name}」・${incident.subtitle} 開始！ ${playerCount}人・手札${handSize}枚`);
      if (intruderDef) addLog(state, `乱入者「${intruderDef.name}」が宴会に現れた…！`);
      dealRound(state);
      return state;
    }

    // ラウンド開始: デザート混入 → 配布 → 統計リセット
    function dealRound(state) {
      const mix = RULES.DESSERT_MIX[state.round] || 0;
      for (let i = 0; i < mix; i++) {
        if (state.dessertPool.length > 0) state.deck.push(state.dessertPool.pop());
      }
      shuffle(state.deck);
      for (const p of state.players) {
        p.taken = [];
        p.hand = state.deck.splice(0, state.handSize);
      }
      state.passDir = PASS_DIRS[state.round];
      state.picks = new Array(state.playerCount).fill(null);
      state.choices = new Array(state.playerCount).fill(null);
      state.phase = 'pick';
      state.hidden = false;
      state.hiddenOwner = null;
      state.roundStats = state.players.map(() => ({ springIcons: 0, dessertTaken: 0, intruderTaken: false }));
      state.coopCount = new Array(state.playerCount).fill(0);
    }

    function dispatch(state, action) {
      switch (action.kind) {
        case 'pick':
          return pick(state, action.pi, [action.idx]);
        case 'pick2':
          return pick(state, action.pi, action.idxs);
        case 'skip':
          return pick(state, action.pi, []);
        case 'choose':
          return choose(state, action.pi, action.choice);
        default:
          return err(`unknown action: ${action.kind}`);
      }
    }

    // ---------------- ピック ----------------

    function pick(state, pi, idxs) {
      if (state.phase !== 'pick') return err('ピックフェーズではない');
      const p = state.players[pi];
      if (!p) return err('プレイヤー不在');
      if (state.picks[pi] !== null) return err('すでに選択済み');
      if (!Array.isArray(idxs)) return err('選択なし');

      // 手札 0 枚のときは空ピックで待機（早飲みで枚数がズレるため。デッドロック回避）
      if (idxs.length === 0) {
        if (p.hand.length !== 0) return err('手札があるのに空ピック');
        state.picks[pi] = [];
        if (state.picks.every((x) => x !== null)) resolvePicks(state);
        return ok();
      }

      if (idxs.length === 2) {
        if (p.chopsticks <= 0) return err('早飲みを使えない');
        if (p.hand.length < 2) return err('手札が2枚未満');
        if (new Set(idxs).size !== 2) return err('2枚は別々のカードで選ぶ');
      } else if (idxs.length > 2) {
        return err('選択は最大2枚');
      }
      for (const idx of idxs) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.hand.length) return err('無効なカード番号');
      }
      if (idxs.length === 2) p.chopsticks -= 1;
      state.picks[pi] = [...idxs];
      if (state.picks.every((x) => x !== null)) resolvePicks(state);
      return ok();
    }

    function instKey(inst) { return inst.key; }

    function resolvePicks(state) {
      state.lastPicks = [];
      for (let i = 0; i < state.playerCount; i++) {
        const idxs = [...state.picks[i]].sort((a, b) => b - a);
        const insts = idxs.map((idx) => state.players[i].hand.splice(idx, 1)[0]);
        insts.reverse();
        for (const inst of insts) applyTake(state, i, inst);
        state.lastPicks.push({ pi: i, keys: insts.map(instKey) });
      }
      state.picks = new Array(state.playerCount).fill(null);

      if (state.players.every((p) => p.hand.length === 0)) {
        beginSelectionPhase(state);
        if (state.phase !== 'select') endRound(state);
      } else {
        beginSelectionPhase(state);
        if (state.phase !== 'select') passHands(state);
      }
    }

    // 取得処理（デザート蓄積・即時点数・ラウンド統計）
    function applyTake(state, pi, inst) {
      const p = state.players[pi];
      const def = state.cardMap[inst.key];
      const stats = state.roundStats[pi];

      // デザート枠は手元に蓄積（taken には入れない）
      if (inst.key === state.dessert.key) {
        p.desserts.push(inst);
        stats.dessertTaken++;
        return;
      }

      p.taken.push(inst);

      // リグル共闘カウント
      if (def.kind === 'coop') state.coopCount[pi]++;

      // 春アイコンの記録（幽々子・レティ・妖夢の判定に使用）
      if (inst.icons) stats.springIcons += inst.icons;

      // 乱入者の取得記録（輝夜・永琳のペナルティ判定に使用）
      if (state.intruderKey && inst.key === state.intruderKey) stats.intruderTaken = true;

      // うどんげの情報隠蔽
      if (def.hidden) {
        state.hidden = true;
        state.hiddenOwner = pi;
        addLog(state, `${p.name}: 幻覚で全員のピックが見えなくなった`);
      }

      // 妖夢の春吸収（即座に適用）
      if (def.kind === 'springSteal') {
        const steal = def.steal;
        for (let j = 0; j < state.playerCount; j++) {
          if (j === pi) continue;
          const loss = Math.min(steal, Math.max(0, state.roundStats[j].springIcons));
          state.roundStats[j].springIcons -= loss;
          stats.springIcons += loss;
        }
        addLog(state, `${p.name}: 庭師が春を剪定して自分の庭に集めた`);
      }

      // 即時点数（コンボはラウンド末判定で加算する: 藍⇔橙の循環コンボは取得順に依存するため）
      if (def.kind === 'instant') {
        let pts = def.points;
        // 乱入者ペナルティ（輝夜・永琳）
        if (def.intruderPenalty && stats.intruderTaken) pts -= def.intruderPenalty;
        p.roundScores[state.round] += pts;
        p.taken[p.taken.length - 1].instantScored = pts;
      }
    }

    // 咲夜の同時ピック判定は resolvePicks の全員分取得後に判定する
    function applySamePickConditions(state) {
      for (const lp of state.lastPicks) {
        const pi = lp.pi;
        const p = state.players[pi];
        for (const inst of p.taken) {
          const def = state.cardMap[inst.key];
          if (!def || def.kind !== 'instant' || !def.absentKeys) continue;
          if (inst.absentChecked) continue;
          inst.absentChecked = true;
          const others = state.lastPicks.filter((x) => x.pi !== pi).flatMap((x) => x.keys);
          const blocked = others.some((k) => def.absentKeys.includes(k));
          if (blocked) {
            p.roundScores[state.round] -= (inst.instantScored || 0);
            inst.instantScored = 0;
            addLog(state, `${p.name}: ${def.name}は主と同席のときは控えた（0点）`);
          }
        }
      }
    }

    // ---------------- 取得時選択フェーズ ----------------
    // フラン（破棄オプション）・ミスティア（裏返し）・慧音（コピー）

    function selectionNeeded(state, pi) {
      const p = state.players[pi];
      const need = { discard: false, flip: false, copy: false };
      for (const inst of p.taken) {
        const def = state.cardMap[inst.key];
        if (!def || inst.selectionDone) continue;
        if (def.kind === 'instant' && def.discardBonus) need.discard = true;
        if (def.kind === 'flip') need.flip = true;
        if (def.kind === 'copy') need.copy = true;
      }
      return need;
    }

    function beginSelectionPhase(state) {
      applySamePickConditions(state);
      const needed = [];
      for (let i = 0; i < state.playerCount; i++) {
        const need = selectionNeeded(state, i);
        if (need.discard || need.flip || need.copy) needed.push(i);
      }
      if (needed.length === 0) return;
      state.phase = 'select';
      state.selectNeeded = needed;
      state.selections = new Array(state.playerCount).fill(null);
      addLog(state, '取得時の選択を行う');
    }

    function choose(state, pi, choice) {
      if (state.phase !== 'select') return err('選択フェーズではない');
      if (!state.selectNeeded.includes(pi)) return err('選択の必要なし');
      if (state.selections[pi] !== null) return err('すでに選択済み');
      const c = choice || {};
      // フラン破棄: { discard: idx|null } — taken 内の idx（デザートは taken に入らないため対象外）
      // ミスティア: { flip: [idx...] } — taken 内の idx の配列（任意枚数・0 可）
      // 慧音: { copy: idx|null } — taken 内の idx（ラウンド中に取得した他のカード・慧音自身は対象外）
      const p = state.players[pi];
      const need = selectionNeeded(state, pi);

      if (need.discard && c.discard !== null && c.discard !== undefined) {
        const idx = c.discard;
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効な破棄対象');
      }
      if (need.flip && Array.isArray(c.flip)) {
        for (const idx of c.flip) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効な裏返し対象');
        }
        if (new Set(c.flip).size !== c.flip.length) return err('裏返し対象が重複している');
      }
      if (need.copy && c.copy !== null && c.copy !== undefined) {
        const idx = c.copy;
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効なコピー対象');
      }

      state.selections[pi] = c;
      if (state.selectNeeded.every((p2) => state.selections[p2] !== null)) {
        applySelections(state);
      }
      return ok();
    }

    function applySelections(state) {
      for (let i = 0; i < state.playerCount; i++) {
        if (!state.selectNeeded.includes(i)) continue;
        const c = state.selections[i];
        const p = state.players[i];
        const map = state.cardMap;

        // フラン破棄: フランを持つプレイヤーが、それまでに獲得したカード 1 枚を破棄する
        if (c.discard !== null && c.discard !== undefined && Number.isInteger(c.discard)) {
          const hasFran = p.taken.some((inst2) => inst2.key === 'k_fran');
          if (hasFran) {
            const franBonus = map['k_fran'] ? map['k_fran'].discardBonus : 2;
            const inst = p.taken[c.discard];
            // 破棄したカードの計上済み点数を取り消してから山札の下へ
            p.roundScores[state.round] -= (inst.instantScored || 0);
            inst.instantScored = 0;
            p.taken.splice(c.discard, 1);
            state.deck.push(inst); // 山札の下へ
            p.roundScores[state.round] += franBonus;
            addLog(state, `${p.name}: フランが${inst.key}を破棄した（+${franBonus}点）`);
          }
        }

        // ミスティア裏返し
        if (Array.isArray(c.flip) && c.flip.length) {
          const flipPoints = 2;
          let flippedN = 0;
          for (const idx of c.flip) {
            const inst = p.taken[idx];
            const idef = map[inst.key];
            if (!idef) continue;
            if (idef.kind === 'flip') continue; // ミスティア自身は対象外
            if (idef.kind === 'instant') {
              // 即時カードは計上済み点数を取り消して 2 点に変わる
              p.roundScores[state.round] -= (inst.instantScored || 0);
              inst.instantScored = 0;
            }
            inst.flipped = true;
            flippedN++;
          }
          p.roundScores[state.round] += flippedN * flipPoints;
          addLog(state, `${p.name}: 夜雀の歌で${flippedN}枚の価値が変わった（各${flipPoints}点）`);
        }

        // 慧音コピー
        if (c.copy !== null && c.copy !== undefined && Number.isInteger(c.copy)) {
          const inst = p.taken[c.copy];
          const idef = map[inst.key];
          if (idef && idef.kind !== 'copy') {
            p.taken.push({ key: inst.key, icons: inst.icons, copied: true });
            addLog(state, `${p.name}: 白沢の知恵で${idef.name}の効果を模した`);
          }
        }

        // 選択済みフラグ（次ラウンドで再選択しないよう taken をマーク）
        for (const inst of p.taken) {
          const idef = map[inst.key];
          if (idef && (idef.discardBonus || idef.kind === 'flip' || idef.kind === 'copy')) inst.selectionDone = true;
        }
      }
      state.phase = 'pick';
      state.selectNeeded = null;
      state.selections = null;
      passHands(state);
    }

    function passHands(state) {
      const n = state.playerCount;
      const hands = state.players.map((p) => p.hand);
      for (let i = 0; i < n; i++) {
        state.players[(i + state.passDir + n) % n].hand = hands[i];
      }
      if (state.phase === 'pick' && state.players.every((p) => p.hand.length === 0)) endRound(state);
    }

    // ---------------- ラウンド末判定 ----------------

    function countKey(p, key) {
      let n = 0;
      for (const i of p.taken) {
        if (i.key === key && !i.flipped) n += i.icons || 1;
      }
      return n;
    }

    // UI 用ユーティリティ: taken 内の key → 枚数マップ（裏返しカードも所持としては数える）
    function countKeys(taken) {
      const counts = {};
      for (const i of taken) {
        counts[i.key] = (counts[i.key] || 0) + (i.icons || 1);
      }
      return counts;
    }

    function endRound(state) {
      const n = state.playerCount;
      const results = [];

      // 判定時のラウンド統計スナップショット（テスト・UI 参照用。dealRound で roundStats はリセットされる）
      state.lastRoundStats = state.roundStats.map((s) => ({ ...s }));

      // 全体判定（多数決系・共闘・幽々子）
      const scores = endRoundGlobal(state);
      // 個別判定（収集・ペア・セット・豆腐・種類数・相反・連動・コンボ・裏返し）
      for (let i = 0; i < n; i++) {
        scores[i] += endRoundIndividual(state, i);
      }

      for (let i = 0; i < n; i++) {
        const p = state.players[i];
        p.roundScores[state.round] += scores[i];
        results.push({ pi: i, name: p.name, points: scores[i] });
      }
      addLog(state, `ラウンド${state.round + 1}終了`);

      // 妹紅（dessertRound）は各ラウンド終了時に判定
      applyDessertRound(state, results);

      // 山札リサイクル: デザート以外の取得カードを山札に戻してシャッフル
      // 戻す際に取得時フラグをクリアする（次ラウンドで誤動作しないように）
      for (let i = 0; i < n; i++) {
        const p = state.players[i];
        for (const inst of p.taken) {
          delete inst.flipped;
          delete inst.absentChecked;
          delete inst.instantScored;
          delete inst.selectionDone;
          delete inst.copied;
        }
        state.deck.push(...p.taken);
        p.taken = [];
      }
      shuffle(state.deck);

      if (state.round === RULES.ROUNDS - 1) {
        state.phase = 'over';
        addLog(state, '宴会が幕を閉じた');
      } else {
        state.roundBanner = { round: state.round, results: results.map((r) => ({ ...r })) };
        state.round++;
        dealRound(state);
      }
    }

    // 全体判定（多数決系）→ 各プレイヤーの点数配列
    function endRoundGlobal(state) {
      const n = state.playerCount;
      const scores = new Array(n).fill(0);
      // パック内の maki 定義（春・兎）を検索
      const makiDefs = Object.values(state.cardMap).filter((d) => d.kind === 'maki');
      for (const def of makiDefs) {
        const counts = state.players.map((p) => countKey(p, def.key));
        const max = Math.max(...counts);
        if (max === 0) continue;
        const topIdx = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
        if (n === 2) {
          if (topIdx.length === 1) scores[topIdx[0]] += RULES.MAKI_POINTS.first;
          else topIdx.forEach((i) => { scores[i] += Math.floor(RULES.MAKI_POINTS.first / 2); });
        } else {
          if (topIdx.length === 1) {
            scores[topIdx[0]] += RULES.MAKI_POINTS.first;
            const restMax = Math.max(...counts.map((c, i) => (i === topIdx[0] ? -1 : c)));
            if (restMax > 0) {
              const secondIdx = counts.map((c, i) => (c === restMax ? i : -1)).filter((i) => i >= 0);
              if (secondIdx.length === 1) scores[secondIdx[0]] += RULES.MAKI_POINTS.second;
            }
          } else {
            topIdx.forEach((i) => { scores[i] += RULES.MAKI_POINTS.first; });
          }
        }
      }
      // temaki（妖精メイド・紅霧）: 最多と最少は独立に判定（同点はフル得点・スシGOのマキ同点ルール準拠）
      const temakiDefs = Object.values(state.cardMap).filter((d) => d.kind === 'temaki');
      for (const def of temakiDefs) {
        const counts = state.players.map((p) => countKey(p, def.key));
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        if (max === 0 || max === min) continue;
        const topIdx = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
        topIdx.forEach((i) => { scores[i] += def.most; });
        const lowIdx = counts.map((c, i) => (c === min ? i : -1)).filter((i) => i >= 0);
        lowIdx.forEach((i) => { scores[i] += def.least; });
      }
      // springMost（幽々子）: 幽々子を取得しているプレイヤーが、そのラウンドで集めた春アイコンが最多なら +most
      const springMax = Math.max(...state.roundStats.map((s) => s.springIcons));
      if (springMax > 0) {
        state.roundStats.forEach((s, i) => {
          const hasYuyuko = state.players[i].taken.some((inst) => inst.key === 's_yuyuko' && !inst.flipped);
          if (hasYuyuko && s.springIcons === springMax) scores[i] += 4;
        });
      }
      // coop（リグル）: 他プレイヤーのリグル出し回数 × 1 点
      const totalCoop = state.coopCount.reduce((a, b) => a + b, 0);
      for (let i = 0; i < n; i++) {
        scores[i] += totalCoop - state.coopCount[i];
      }
      return scores;
    }

    // 個別判定（収集・ペア・セット・豆腐・種類数・相反・連動・コンボ・裏返し）
    function endRoundIndividual(state, pi) {
      const p = state.players[pi];
      let pts = 0;
      // 裏返しカード（ミスティア）は 2 点のみ・他の判定から除外
      let flippedPts = 0;
      for (const inst of p.taken) {
        if (inst.flipped) flippedPts++;
      }
      pts += flippedPts * 2;

      // 各カード種別の判定
      const seenKinds = {};
      for (const inst of p.taken) {
        if (inst.flipped) continue;
        const def = state.cardMap[inst.key];
        if (!def) continue;
        if (['pair', 'set3', 'collect', 'tofu', 'kindCount', 'letty', 'roundComboCount', 'instant'].includes(def.kind)) {
          seenKinds[def.key] = true;
        }
      }
      for (const key of Object.keys(seenKinds)) {
        const def = state.cardMap[key];
        const n = countKey(p, key);
        if (n === 0) continue;
        switch (def.kind) {
          case 'instant': {
            // ラウンド内コンボ（美鈴・藍・橙）はラウンド末時点の所持で判定（循環コンボ対応）
            if (def.comboKeys && def.comboKeys.length) {
              const owned = new Set();
              for (const inst of p.taken) {
                if (!inst.flipped) owned.add(inst.key);
              }
              if (def.comboKeys.every((k) => owned.has(k))) pts += def.comboBonus;
            }
            break;
          }
          case 'collect': {
            const idx = Math.min(n, def.table.length) - 1;
            pts += def.table[idx];
            break;
          }
          case 'pair': {
            pts += Math.floor(n / 2) * def.points;
            break;
          }
          case 'set3': {
            pts += Math.floor(n / 3) * def.points;
            break;
          }
          case 'tofu': {
            const idx = n >= def.table.length ? def.table.length - 1 : n - 1;
            pts += def.table[idx];
            break;
          }
          case 'kindCount': {
            // 種類数（チルノ含む・同種は 1 種）− offset
            const kinds = new Set();
            for (const inst of p.taken) {
              if (inst.flipped) continue;
              kinds.add(inst.key);
            }
            // デザートも含める（手元のデザート）
            for (const inst of p.desserts) kinds.add(inst.key);
            pts += Math.max(0, kinds.size + def.offset);
            break;
          }
          case 'letty': {
            const own = countKey(p, def.ownKey);
            const spring = state.roundStats[pi].springIcons;
            pts += Math.max(0, (own - spring) * def.mult);
            break;
          }
          case 'roundComboCount': {
            pts += state.roundStats[pi].dessertTaken * def.per;
            break;
          }
        }
      }
      return pts;
    }

    // 妹紅（dessertRound）: 各ラウンド終了時に手元の枚数最多なら加点/減点
    function applyDessertRound(state, results) {
      const def = state.dessert;
      if (def.kind !== 'dessertRound') return;
      const counts = state.players.map((p) => p.desserts.filter((i) => i.key === def.key).length);
      const max = Math.max(...counts);
      if (max === 0) return;
      const topIdx = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
      const isFinal = state.round === RULES.ROUNDS - 1;
      for (const i of topIdx) {
        const pts = isFinal ? def.finalLeast : def.roundMost;
        state.players[i].roundScores[state.round] += pts;
        const r = results.find((x) => x.pi === i);
        if (r) r.points += pts;
        addLog(state, `${state.players[i].name}: 妹紅の炎が${isFinal ? '暴走した（' : '燃え上がった（'}${pts >= 0 ? '+' : ''}${pts}点）`);
      }
    }

    // ---------------- ゲーム末判定 ----------------

    function gameEndScore(state, pi) {
      const p = state.players[pi];
      let pts = 0;
      // デザート判定（種別ごと）
      // dessertLeast（チルノ）: 全員のデザート枚数最少に −least
      const leastDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertLeast');
      for (const def of leastDefs) {
        const counts = state.players.map((q) => q.desserts.filter((i) => i.key === def.key).length);
        const min = Math.min(...counts);
        const minIdx = counts.map((c, i) => (c === min ? i : -1)).filter((i) => i >= 0);
        if (minIdx.includes(pi)) pts += def.least;
      }
      // dessertIce（リリーホワイト）: 4 枚ごとに points
      const iceDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertIce');
      for (const def of iceDefs) {
        const cnt = p.desserts.filter((i) => i.key === def.key).length;
        pts += Math.floor(cnt / def.per) * def.points;
      }
      // ゲーム末判定（霊夢・魔理沙）: key ごとに 1 回だけ判定する
      const gameEndKeys = new Set();
      for (const inst of p.desserts.concat(p.taken)) {
        const idef = state.cardMap[inst.key];
        if (idef && idef.gameEnd) gameEndKeys.add(inst.key);
      }
      for (const key of gameEndKeys) {
        const def = state.cardMap[key];
        const cnt = p.taken.filter((i) => i.key === key && !i.flipped).length;
        if (def.kind === 'collectByTwo') {
          pts += Math.floor(cnt / 2) * def.per2 + (cnt >= 4 ? def.bonusAt4 : 0);
        }
        if (def.kind === 'parity') {
          pts += Math.floor(cnt / 2) * (cnt % 2 === 0 ? def.per2Even : def.per2Odd);
        }
      }
      return pts;
    }

    function scorePlayer(state, pi) {
      const p = state.players[pi];
      let total = p.roundScores.reduce((a, b) => a + b, 0);
      if (state.phase === 'over') total += gameEndScore(state, pi);
      return total;
    }

    function charmBonus(state, pi) {
      return gameEndScore(state, pi);
    }

    function roundBreakdown(state, pi) {
      const p = state.players[pi];
      const out = {};
      for (const inst of p.taken) {
        if (inst.flipped) continue;
        const def = state.cardMap[inst.key];
        if (!def) continue;
        if (['collect', 'pair', 'set3', 'tofu', 'kindCount', 'letty'].includes(def.kind)) {
          out[def.key] = (out[def.key] || 0) + (inst.icons || 1);
        }
      }
      return out;
    }

    return {
      newGame,
      dispatch,
      scorePlayer,
      charmBonus,
      roundBreakdown,
      countKey,
      countKeys,
      PASS_DIRS,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof window !== 'undefined') window.Engine = Engine;
})();
