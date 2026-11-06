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

    const PASS_DIRS = RULES.PASS_DIRS;

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

      // カードリファレンス用: このゲームに存在する全カードの構成枚数
      const initialCounts = {};
      for (const inst of deck) initialCounts[inst.key] = (initialCounts[inst.key] || 0) + 1;
      for (const inst of dessertPool) initialCounts[inst.key] = (initialCounts[inst.key] || 0) + 1;

      const players = [];
      for (let i = 0; i < playerCount; i++) {
        players.push({
          name: names[i] || `Player ${i + 1}`,
          hand: [],
          taken: [],   // インスタンス { key, icons?, flipped?, copied? }
          desserts: [], // デザート蓄積
          gameEndCounts: {}, // ゲーム末判定カード（霊夢・魔理沙）の通算取得数
          chopsticks: 0, // 早飲み（pick2）用。箸カードは未実装だが将来追加する可能性があるため経路は残す
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
        initialCounts,
        intruderKey: intruderDef ? intruderDef.key : null,
        round: 0,
        passDir: PASS_DIRS[0],
        picks: new Array(playerCount).fill(null),
        choices: new Array(playerCount).fill(null), // 取得時選択（select フェーズ用）
        phase: 'pick',
        lastPicks: [],
        pickSeq: 0, // ピック解決の連番（UI の「新しく取った」アニメ用）
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
        p.springBuff = 0;
        p.youmuPts = 0;
        p.youmuSpring = 0;
      }
      state.passDir = PASS_DIRS[state.round];
      state.picks = new Array(state.playerCount).fill(null);
      state.choices = new Array(state.playerCount).fill(null);
      state.phase = 'pick';
      state.hidden = false;
      state.hiddenOwner = null;
      state.peekNeeded = null;
      state.peekCards = null;
      state.roundStats = state.players.map(() => ({ springIcons: 0, dessertTaken: 0, intruderTaken: false }));
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

    // 表示用のカード名。アリスのように 1 枚のカードが複数の種類に分かれる場合は
    // カード名（アリス）＋ 種類名（蓬莱人形 など）を添える
    function cardName(def) {
      if (!def) return '';
      return def.variant ? `${def.name}（${def.variant}）` : def.name;
    }

    // リグルの 1 枚あたりの点数（未指定なら 1 点）
    function coopPointValue(def) {
      return def && typeof def.points === 'number' ? def.points : 1;
    }

    function resolvePicks(state) {
      const wasHidden = state.hidden; // このピックの前に幻覚がかかっていたか
      state.pickSeq = (state.pickSeq || 0) + 1;
      state.lastPicks = [];
      let hiddenActivated = null; // このピックでうどんげを出したプレイヤー
      const coopThisTurn = []; // この手番で同時に取得されたリグル（{ pi, inst }）
      const youmuThisTurn = []; // この手番で取得された妖夢
      const diffThisTurn = []; // この手番で取得された「他人の取得数で決まる」カード（レティ）
      for (let i = 0; i < state.playerCount; i++) {
        const idxs = [...state.picks[i]].sort((a, b) => b - a);
        const insts = idxs.map((idx) => state.players[i].hand.splice(idx, 1)[0]);
        insts.reverse();
        for (const inst of insts) {
          applyTake(state, i, inst);
          const def = state.cardMap[inst.key];
          if (def && def.kind === 'coop') coopThisTurn.push({ pi: i, inst });
          if (def && def.kind === 'springSteal') youmuThisTurn.push({ pi: i, inst });
          if (def && def.kind === 'othersDiff') diffThisTurn.push({ pi: i, inst });
        }
        state.lastPicks.push({ pi: i, keys: insts.map(instKey) });
        // うどんげは「出した番」に発動する（小悪魔の山札確認で獲得した場合は発動しない）
        if (insts.some((inst) => inst.key === 'y_reisen')) hiddenActivated = i;
      }
      // リグル: 同じ手番に「自分以外」が取得したリグル 1 枚につき points 点。
      // 1 人だけでは 0 点、2 人同時なら互いに 1 点ずつという譲り合いの賭けになる
      for (const { pi, inst } of coopThisTurn) {
        const others = coopThisTurn.filter((x) => x.pi !== pi).length;
        inst.coopPoints = others * coopPointValue(state.cardMap[inst.key]);
      }
      // othersDiff（レティ）: 同じ手番に「他の人」が取った枚数の差で決まる
      for (const { pi, inst } of diffThisTurn) {
        const def = state.cardMap[inst.key];
        let plus = 0;
        let minus = 0;
        for (const lp of state.lastPicks) {
          if (lp.pi === pi) continue;
          for (const k of lp.keys) {
            if (k === def.plusKey) plus++;
            if (k === def.minusKey) minus++;
          }
        }
        inst.diffPoints = (plus - minus) * (def.mult || 1);
        addLog(
          state,
          `${state.players[pi].name}: ${def.name}は他の人の${def.plusKey === inst.key ? '同種' : '取得'} ${plus} 枚・春 ${minus} 枚で ${inst.diffPoints >= 0 ? '+' : ''}${inst.diffPoints} 点`,
        );
      }
      // 妖夢: 手番終了時に一括判定（同じ手番の春も含めて数える）。
      // 同じ手番に妖夢が 2 枚以上出たら相殺（どちらも不発）
      if (youmuThisTurn.length >= 2) {
        for (const { inst } of youmuThisTurn) inst.springGain = 0;
        addLog(state, '妖夢同士がぶつかり、効果は相殺された');
      } else {
        for (const { pi, inst } of youmuThisTurn) {
          const def = state.cardMap[inst.key];
          const steal = def.steal || 1;
          const pointPer = def.pointPer || 1;
          const opponents = state.playerCount - 1;
          let holders = 0;
          for (let j = 0; j < state.playerCount; j++) {
            if (j === pi) continue;
            const loss = Math.min(steal, Math.max(0, state.roundStats[j].springIcons));
            if (loss > 0) {
              state.roundStats[j].springIcons -= loss;
              state.roundStats[pi].springIcons += loss;
              holders += 1;
            }
          }
          if (holders === 0) {
            inst.springGain = 0;
            addLog(state, `${state.players[pi].name}: 奪える春がなく、妖夢の効果は失敗に終わった`);
          } else {
            const springless = opponents - holders;
            inst.springGain = springless * pointPer;
            addLog(state, `${state.players[pi].name}: ${holders} 人から春を奪い、春を持たない ${springless} 人ぶんの ${inst.springGain} 点を得た`);
          }
        }
      }
      state.picks = new Array(state.playerCount).fill(null);

      // 幻覚の開始（免疫は「出した手番の 1 回ぶん」だけ。ラウンド内で別の人が出せば主も移る）
      if (hiddenActivated !== null) {
        state.hidden = true;
        state.hiddenOwner = hiddenActivated;
        addLog(state, `${state.players[hiddenActivated].name}: 幻覚で全員のピックが見えなくなった`);
      }
      // 「うどんげを出した番」に公開されるカードがすべてうどんげとして見える
      // （出した本人は影響を受けない。以降のピックは通常どおり公開・ラウンド末に判定で解除）
      if (hiddenActivated !== null) {
        for (const lp of state.lastPicks) {
          if (lp.pi === hiddenActivated) continue;
          const p = state.players[lp.pi];
          const keys = [...lp.keys];
          for (let i = p.taken.length - 1; i >= 0 && keys.length; i--) {
            const k = keys.indexOf(p.taken[i].key);
            if (k >= 0) {
              p.taken[i].hiddenTaken = true;
              // どの手番で隠されたか（この手番の出し主だけが見える＝免疫はその 1 回ぶん）
              p.taken[i].hiddenBy = hiddenActivated;
              keys.splice(k, 1);
            }
          }
        }
      }

      if (state.players.every((p) => p.hand.length === 0)) {
        beginSelectionPhase(state);
        if (state.phase !== 'select') endRound(state);
      } else {
        beginSelectionPhase(state);
        if (state.phase !== 'select') passHands(state);
      }
    }

    // 取得処理（デザートも手元に置く・即時点数・ラウンド統計）
    function applyTake(state, pi, inst) {
      const p = state.players[pi];
      const def = state.cardMap[inst.key];
      const stats = state.roundStats[pi];

      // デザート枠も他のカードと同様に taken に置かれる（ラウンド終了時にデザート置き場へ送られる）
      if (inst.key === state.dessert.key) {
        stats.dessertTaken++;
      }

      p.taken.push(inst);

      // 春アイコンの記録（幽々子・レティ・妖夢の判定に使用）
      if (inst.icons) stats.springIcons += inst.icons;

      // 乱入者の取得記録（輝夜・永琳のペナルティ判定に使用）
      if (state.intruderKey && inst.key === state.intruderKey) stats.intruderTaken = true;

      // ゲーム末判定カード（霊夢・魔理沙）はラウンドをまたいで数える。
      // taken はラウンド末に山札へ戻るため、ここで通算を記録しておく
      if (def.gameEnd) {
        p.gameEndCounts[inst.key] = (p.gameEndCounts[inst.key] || 0) + 1;
      }

      // 妖夢（springBoost）: このカードを取ると「次の春カード」に効果が付く。
      // 次に春を取ったとき、そのアイコン数ぶんの春と点を追加で得る（同ラウンド内で消費）。
      if (def.kind === 'springBoost') {
        p.springBuff = (p.springBuff || 0) + 1;
        addLog(state, `${p.name}: 妖夢が次の春に備えた`);
      } else if (inst.key === 's_spring' && (p.springBuff || 0) > 0) {
        p.springBuff -= 1;
        const icons = inst.icons || 1;
        p.youmuSpring = (p.youmuSpring || 0) + icons;
        stats.springIcons += icons;
        p.youmuPts = (p.youmuPts || 0) + icons;
        inst.youmuBoost = icons;
        addLog(state, `${p.name}: 妖夢の加護で春${icons}個と +${icons} 点`);
      }


      // 即時点数はラウンド末に一括集計する（ここでは加点しない）。
      // コンボ（美鈴・藍・橙）の発動だけは取得順依存のため、取得時にフラグを記録する。
      if (def.kind === 'instant') {
        if (def.comboKeys && def.comboKeys.length) {
          const owned = new Set(p.taken.map((i2) => i2.key));
          if (def.comboKeys.every((k) => owned.has(k))) {
            inst.instantCombo = true;
            addLog(state, `${p.name}: ${def.name}は${def.comboKeys.map((k) => (state.cardMap[k] ? state.cardMap[k].name : k)).join('・')}と連携した（ラウンド末に+${def.comboBonus}点）`);
          }
        }
      }
    }

    // 咲夜の同時ピック判定は resolvePicks の全員分取得後に判定する
    function applySamePickConditions(state) {
      for (const lp of state.lastPicks) {
        const pi = lp.pi;
        const p = state.players[pi];
        for (const inst of p.taken) {
          const def = state.cardMap[inst.key];
          if (!def || def.kind !== 'instant' || (!def.absentKeys && !def.zeroIfTaken && !def.pointsIfPicked)) continue;
          if (inst.absentChecked) continue;
          inst.absentChecked = true;
          const others = state.lastPicks.filter((x) => x.pi !== pi).flatMap((x) => x.keys);
          const allKeys = state.lastPicks.flatMap((x) => x.keys);
          let blocked = def.absentKeys ? others.some((k) => def.absentKeys.includes(k)) : false;
          // zeroIfTaken: 同じ手番に誰か（自分含む）が指定カードを取ったら 0 点
          if (def.zeroIfTaken && allKeys.includes(def.zeroIfTaken)) blocked = true;
          if (blocked) {
            // 点数はラウンド末集計で 0 点として計上される
            inst.absentBlocked = true;
            addLog(state, `${p.name}: ${def.name}は条件を満たしたため 0 点`);
          }
          // pointsIfPicked: 同じ手番に誰か（自分含む）が指定カードを取っていれば加点
          if (def.pointsIfPicked && allKeys.includes(def.pointsIfPicked.key)) {
            const bonus = def.pointsIfPicked.bonus || 1;
            inst.turnBonus = (inst.turnBonus || 0) + bonus;
            addLog(state, `${p.name}: ${def.name}は同じ手番の${cardName(state.cardMap[def.pointsIfPicked.key])}に合わせて +${bonus} 点`);
          }
        }
      }
    }

    // 即時点数のラウンド末一括集計（破棄/裏返し/咲夜同席/コンボ/乱入者ペナルティをここで反映）
    function settleInstantScores(state) {
      for (let i = 0; i < state.playerCount; i++) {
        const p = state.players[i];
        let pts = 0;
        for (const inst of p.taken) {
          const def = state.cardMap[inst.key];
          inst.roundPts = 0; // リザルト内訳用: このカードがこのラウンドで稼いだ点
          if (!def) continue;
          if (inst.flipped || inst.discarded) continue; // 破棄・裏返しは点数計上から外れる
          // リグル: 取得した手番に同時取得された枚数ぶんの点（取得時に確定済み）
          if (def.kind === 'coop') {
            inst.roundPts = inst.coopPoints || 0;
            pts += inst.roundPts;
            continue;
          }
          // 妖夢: 同じ手番に春を取った人数ぶんの点（取得時に確定済み）
          if (def.kind === 'springSteal') {
            inst.roundPts = inst.springGain || 0;
            pts += inst.roundPts;
            continue;
          }
          if (def.kind === 'othersDiff') {
            inst.roundPts = inst.diffPoints || 0;
            pts += inst.roundPts;
            continue;
          }
          if (def.kind !== 'instant') continue;
          inst.roundPts = inst.absentBlocked ? 0 : def.points; // 咲夜の同席判定
          // 同じ手番の条件（永琳: 誰かが同じ手番に輝夜を取っていれば加点）
          inst.roundPts += inst.turnBonus || 0;
          inst.roundPts += inst.extraPts || 0; // 取得時に確定した追加点
          if (inst.instantCombo && def.comboBonus) inst.roundPts += def.comboBonus; // 取得時コンボ（美鈴・藍・橙）
          pts += inst.roundPts;
        }
        // 乱入者ペナルティ（輝夜・永琳）: ラウンド内に乱入者を取得していたら、
        // 所持している乱入者影響カード 1 枚ごとに -1（取得順は問わない）
        if (state.roundStats[i].intruderTaken) {
          for (const inst of p.taken) {
            const def = state.cardMap[inst.key];
            if (!def || def.kind !== 'instant' || !def.intruderPenalty) continue;
            if (inst.flipped || inst.discarded) continue;
            inst.roundPts -= def.intruderPenalty;
            pts -= def.intruderPenalty;
          }
        }
        // フランの破棄ボーナスはラウンド末にまとめて加算する
        pts += p.taken.reduce((a, inst) => a + (inst.franBonus || 0), 0);
        p.roundScores[state.round] += pts;
      }
    }

    // ---------------- 取得時選択フェーズ ----------------
    // フラン（破棄オプション）・ミスティア（裏返し）・慧音（コピー）

    function selectionNeeded(state, pi) {
      const p = state.players[pi];
      const need = { discard: false, flip: false, copy: false, peek: false, swap: false };
      for (const inst of p.taken) {
        const def = state.cardMap[inst.key];
        if (!def || inst.selectionDone) continue;
        if (def.kind === 'instant' && def.discardBonus) need.discard = true;
        if (def.kind === 'instant' && def.swap) need.swap = true;
        if (def.kind === 'flip') need.flip = true;
        if (def.kind === 'copy') need.copy = true;
        if (def.kind === 'deckPeek') need.peek = true;
      }
      return need;
    }

    function beginSelectionPhase(state) {
      applySamePickConditions(state);
      const needed = [];
      state.peekNeeded = state.peekNeeded || new Array(state.playerCount).fill(false);
      state.peekCards = state.peekCards || new Array(state.playerCount).fill(null);
      for (let i = 0; i < state.playerCount; i++) {
        const need = selectionNeeded(state, i);
        if (need.peek) {
          // 小悪魔の山札確認: 山札の上 N 枚（def.peek）を候補として取り出す
          // （解決時に peekNeeded は false に戻るため、同ラウンドに別枚の小悪魔を取っても再発動する）
          state.peekNeeded[i] = true;
          const peekDef = Object.values(state.cardMap).find((d) => d.kind === 'deckPeek');
          const n = (peekDef && peekDef.peek) || 4;
          state.peekCards[i] = state.deck.splice(0, Math.min(n, state.deck.length));
        }
        if (need.discard || need.flip || need.copy || need.peek || need.swap) needed.push(i);
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
      // ミスティア: { flip: [idx] } — taken 内の idx 1 枚（0 可・最大 1 枚）
      // 慧音: { copy: idx|null } — taken 内の idx（ラウンド中に取得した他のカード・慧音自身は対象外）
      const p = state.players[pi];
      const need = selectionNeeded(state, pi);
      const map = state.cardMap;
      // デザートも破棄/裏返し/コピーの対象に含める（デザートリスクの回避手段になる）

      if (need.discard && c.discard !== null && c.discard !== undefined) {
        const idx = c.discard;
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効な破棄対象');
        if (p.taken[idx].discarded) return err('すでに破棄されたカードは選べない');
        // 効果カード自身は対象外（フラン自身を破棄して自己完結することを防ぐ）
        if (map[p.taken[idx].key] && map[p.taken[idx].key].discardBonus) return err('フラン自身は破棄できない');
      }
      if (need.flip && Array.isArray(c.flip)) {
        // 任意枚数・0 可（重複不可）
        if (new Set(c.flip).size !== c.flip.length) return err('裏返し対象が重複している');
        for (const idx of c.flip) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効な裏返し対象');
          if (p.taken[idx].discarded) return err('破棄されたカードは裏返せない');
          // 効果カード自身は対象外（ミスティアを歌で裏返すのは変なので）
          if (map[p.taken[idx].key] && map[p.taken[idx].key].kind === 'flip') return err('ミスティア自身は裏返せない');
        }
      }
      if (need.copy && c.copy !== null && c.copy !== undefined) {
        const idx = c.copy;
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.taken.length) return err('無効なコピー対象');
        if (p.taken[idx].discarded) return err('破棄されたカードはコピーできない');
        // 効果カード自身は対象外（慧音が慧音をコピーする循環を防ぐ）
        // デザートもコピー可（copied デザートはそのラウンドの取得として判定に参加し、ラウンド末に山札へ戻る）
        if (map[p.taken[idx].key] && map[p.taken[idx].key].kind === 'copy') return err('慧音自身はコピーできない');
      }
      if (need.peek && c.pick !== null && c.pick !== undefined) {
        // 小悪魔の山札確認: 候補 4 枚の中から 1 枚を選ぶ（未指定 = 効果を使わない）
        if (!Number.isInteger(c.pick) || c.pick < 0 || c.pick >= (state.peekCards[pi] || []).length) {
          return err('山札から獲得するカードを選んでください');
        }
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
        // そのプレイヤーに本当に必要な選択だけを適用する。
        // （UI に古いモードが残っていて不要な discard が送られても +2 しない）
        const need = selectionNeeded(state, i);

        // フラン破棄: 破棄するカードは taken から削除せず discarded フラグを立てる
        // （ラウンド末集計で点数計上されない・UI には半透明の「破棄」で残る。ラウンド末に山札へ戻る）
        if (need.discard && c.discard !== null && c.discard !== undefined && Number.isInteger(c.discard)) {
          const inst = p.taken[c.discard];
          if (inst && !inst.discarded) {
            const franBonus = map['k_fran'] ? map['k_fran'].discardBonus : 2;
            const idef = map[inst.key];
            inst.discarded = true;
            // 加算はラウンド末にまとめる（取得中に roundScores が動かないように）
            inst.franBonus = franBonus;
            addLog(state, `${p.name}: フランが${cardName(idef) || inst.key}を破棄した（+${franBonus}点）`);
          }
        }

        // 永琳の調合（交換）: 手元のカード1枚を山札の下へ戻し、山札の上から1枚引く。
        // swapBonus があれば交換時に加点する（現行は 0 点＝交換そのものは点にならない）
        if (need.swap && c.swap !== null && c.swap !== undefined && Number.isInteger(c.swap)) {
          const target = p.taken[c.swap];
          const tdef = target ? map[target.key] : null;
          const source = [...p.taken].reverse().find((x) => {
            const d = map[x.key];
            return d && d.swap && !x.selectionDone && !x.discarded;
          });
          if (target && tdef && source && source !== target && !target.discarded && tdef.key !== state.dessert.key) {
            p.taken.splice(c.swap, 1);
            state.deck.push(target); // 戻したカードは山札の下へ
            if (state.deck.length) {
              const drawn = state.deck.shift(); // 山札の上から1枚
              applyTake(state, i, drawn);
              const ddef = map[drawn.key];
              const bonus = map[source.key].swapBonus || 0;
              if (bonus) source.extraPts = (source.extraPts || 0) + bonus;
              addLog(
                state,
                `${p.name}: 薬師の調合で${cardName(tdef)}を山札へ戻し、${cardName(ddef) || drawn.key}を引いた${bonus ? `（+${bonus}点）` : ''}`,
              );
            }
          }
        }

        // ミスティア裏返し: 裏返されたカードは「2 点のみの効果を持つカード」になり、
        // 点数はラウンド末判定（endRoundIndividual の flippedPts×2）で一括加算される
        if (need.flip && Array.isArray(c.flip) && c.flip.length) {
          const flipPoints = 2;
          let flippedN = 0;
          for (const idx of c.flip) {
            const inst = p.taken[idx];
            const idef = map[inst.key];
            if (!idef) continue;
            if (idef.kind === 'flip') continue; // ミスティア自身は対象外
            inst.flipped = true;
            flippedN++;
          }
          if (flippedN) addLog(state, `${p.name}: 夜雀の歌で${flippedN}枚の価値が変わった（判定時に各${flipPoints}点）`);
        }

        // 慧音コピー
        if (need.copy && c.copy !== null && c.copy !== undefined && Number.isInteger(c.copy)) {
          const inst = p.taken[c.copy];
          const idef = map[inst.key];
          if (idef && idef.kind !== 'copy') {
            p.taken.push({ key: inst.key, icons: inst.icons, copied: true });
            addLog(state, `${p.name}: 白沢の知恵で${cardName(idef)}の効果を模した`);
          }
        }

        // 小悪魔の山札確認: 選んだ 1 枚を獲得（applyTake を通して統計・コンボ判定を反映）し、
        // 残りは山札の下へ戻す。選択待ちフラグは解除する
        if (need.peek && state.peekNeeded && state.peekNeeded[i]) {
          const candidates = state.peekCards[i] || [];
          const chosen = Number.isInteger(c.pick) ? candidates[c.pick] : null;
          if (chosen) {
            applyTake(state, i, chosen);
            // リグルを山札確認で得た場合は手番ではないので、同時取得はいない = 0 点
            const cdef = map[chosen.key];
            if (cdef && cdef.kind === 'coop') chosen.coopPoints = 0;
            // 小悪魔のタイルに「獲得したカード」を重ねて表示するための目印
            chosen.peekedGain = true;
            const peeker = [...p.taken]
              .reverse()
              .find((x) => x !== chosen && (map[x.key] || {}).kind === 'deckPeek' && !x.peekedBy);
            if (peeker) peeker.peekedBy = { key: chosen.key, icons: chosen.icons || 1 };
          }
          // 選ばなかったカード（スキップ時は全部）は失われないよう山札の下へ戻す
          for (const inst of candidates) {
            if (inst !== chosen) state.deck.push(inst);
          }
          state.peekCards[i] = null;
          state.peekNeeded[i] = false;
        }

        // 選択済みフラグ（次ラウンドで再選択しないよう taken をマーク）
        for (const inst of p.taken) {
          const idef = map[inst.key];
          if (idef && (idef.discardBonus || idef.swap || idef.kind === 'flip' || idef.kind === 'copy' || idef.kind === 'deckPeek')) inst.selectionDone = true;
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
        if (i.key === key && !i.flipped && !i.discarded) n += i.icons || 1;
      }
      return n;
    }

    // レティ等「春アイコンを減らすカード」による減少量（2 枚ペアごと）
    function lettyPairReduction(state, p) {
      let cut = 0;
      const done = new Set();
      for (const inst of p.taken) {
        if (inst.flipped || inst.discarded) continue;
        const def = state.cardMap[inst.key];
        if (!def || !def.reduceSpringIconsPerPair || done.has(def.key)) continue;
        done.add(def.key);
        cut += Math.floor(countKey(p, def.key) / 2) * def.reduceSpringIconsPerPair;
      }
      return cut;
    }

    // 春アイコンの実効値（ラウンド末の順位判定用）
    function springIconTotal(state, p) {
      return Math.max(0, countKey(p, 's_spring') + (p.youmuSpring || 0) - lettyPairReduction(state, p));
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

      // 即時点数のラウンド末一括集計（先頭で行い、バナーの点数内訳に含める）
      const roundStart = state.players.map((p) => p.roundScores[state.round] || 0);
      settleInstantScores(state);

      // 全体判定（多数決系・共闘・幽々子）
      const detail = state.players.map(() => []);
      const scores = endRoundGlobal(state, detail);
      // 個別判定（収集・ペア・セット・豆腐・種類数・相反・連動・コンボ・裏返し）
      for (let i = 0; i < n; i++) {
        scores[i] += endRoundIndividual(state, i, detail[i]);
      }

      for (let i = 0; i < n; i++) {
        const p = state.players[i];
        p.roundScores[state.round] += scores[i];
        // ラウンド点 = 即時点 + 全体判定 + 個別判定（バナーの内訳合計と一致させる）
        results.push({ pi: i, name: p.name, points: p.roundScores[state.round] - roundStart[i] });
      }
      addLog(state, `ラウンド${state.round + 1}終了`);

      // 妹紅（dessertRound）は各ラウンド終了時に判定
      applyDessertRound(state, results);

      // バナー用の内訳（獲得カードと配点・カード以外の判定）
      for (let i = 0; i < n; i++) {
        const p = state.players[i];
        const r = results[i];
        r.cards = p.taken.map((inst) => ({
          key: inst.key,
          icons: inst.icons || 1,
          flipped: !!inst.flipped,
          discarded: !!inst.discarded,
          copied: !!inst.copied,
          pts: inst.roundPts || 0,
        }));
        const fran = p.taken.reduce((a, inst) => a + (inst.franBonus || 0), 0);
        if (fran) detail[i].push({ key: 'k_fran', label: 'フラン（破棄）', pts: fran });
        r.extras = detail[i];
      }

      // デザート置き場への移動と山札リサイクル:
      // 手元のデザートはデザート置き場へ、それ以外は山札に戻してシャッフル
      // 破棄/裏返し/コピーされたデザートは判定から外れているため山札へ戻る（置き場には行かない）
      for (let i = 0; i < n; i++) {
        const p = state.players[i];
        const kept = p.taken.filter((inst) => inst.key === state.dessert.key && !inst.discarded && !inst.flipped && !inst.copied);
        if (kept.length) p.desserts.push(...kept);
        const recycled = p.taken.filter((inst) => inst.key !== state.dessert.key || inst.discarded || inst.flipped || inst.copied);
        for (const inst of recycled) {
          delete inst.flipped;
          delete inst.discarded;
          delete inst.hiddenTaken; // 幻覚はラウンド末判定で解除＝公開される
          delete inst.absentChecked;
          delete inst.absentBlocked;
          delete inst.instantCombo;
          delete inst.selectionDone;
          delete inst.copied;
        }
        state.deck.push(...recycled);
        p.taken = [];
      }
      shuffle(state.deck);

      const banner = { round: state.round, results: results.map((r) => ({ ...r })) };
      if (state.round === RULES.ROUNDS - 1) {
        // 最終ラウンドも結果を出し、閉じたあとに最終結果を表示する
        state.phase = 'over';
        state.roundBanner = banner;
        addLog(state, '宴会が幕を閉じた');
      } else {
        state.roundBanner = banner;
        state.round++;
        dealRound(state);
      }
    }

    // 全体判定（多数決系）→ 各プレイヤーの点数配列
    function endRoundGlobal(state, detail) {
      const n = state.playerCount;
      const scores = new Array(n).fill(0);
      // 判定ごとの加減点を差分で拾って内訳に積む
      const award = (key, label, fn) => {
        const before = scores.slice();
        fn();
        for (let i = 0; i < n; i++) {
          const d = scores[i] - before[i];
          if (d !== 0) detail[i].push({ key, label, pts: d });
        }
      };
      // パック内の maki 定義（春・兎）を検索
      const makiDefs = Object.values(state.cardMap).filter((d) => d.kind === 'maki');
      for (const def of makiDefs) {
        award(def.key, `${def.name}（順位）`, () => {
          const counts = state.players.map((p) => (def.key === 's_spring' ? springIconTotal(state, p) : countKey(p, def.key)));
          const max = Math.max(...counts);
          if (max === 0) return;
          const topIdx = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
          if (n === 2) {
            // 1位 4 点 / 同点は各 2 点（2 位ボーナスなし・DESIGN 2-4）
            if (topIdx.length === 1) scores[topIdx[0]] += RULES.MAKI_2P.first;
            else topIdx.forEach((i) => { scores[i] += RULES.MAKI_2P.tie; });
          } else if (topIdx.length === 1) {
            scores[topIdx[0]] += RULES.MAKI_POINTS.first;
            const restMax = Math.max(...counts.map((c, i) => (i === topIdx[0] ? -1 : c)));
            if (restMax > 0) {
              const secondIdx = counts.map((c, i) => (c === restMax ? i : -1)).filter((i) => i >= 0);
              if (secondIdx.length === 1) scores[secondIdx[0]] += RULES.MAKI_POINTS.second;
            }
          } else {
            topIdx.forEach((i) => { scores[i] += RULES.MAKI_POINTS.first; });
          }
        });
      }
      // temaki（妖精メイド・紅霧）: 最多と最少は独立に判定（同点はフル得点・スシGOのマキ同点ルール準拠）
      const temakiDefs = Object.values(state.cardMap).filter((d) => d.kind === 'temaki');
      for (const def of temakiDefs) {
        const counts = state.players.map((p) => countKey(p, def.key));
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        if (max === 0 || max === min) continue;
        award(def.key, `${def.name}（最多）`, () => {
          counts.forEach((c, i) => { if (c === max) scores[i] += def.most; });
        });
        award(def.key, `${def.name}（最少）`, () => {
          counts.forEach((c, i) => { if (c === min) scores[i] += def.least; });
        });
      }
      // springMost（幽々子）: 春アイコンが最多のラウンドだけ、所持 1 枚ごとに加点
      // 妖夢の奪取は roundStats に反映済み。ラウンド末にレティのぶんだけ減らして判定する
      const springEffective = state.players.map((p, i) => Math.max(0, state.roundStats[i].springIcons - lettyPairReduction(state, p)));
      const springMax = Math.max(...springEffective);
      if (springMax > 0) {
        award('s_yuyuko', '幽々子（春最多）', () => {
          state.players.forEach((p, i) => {
            const yuyukoCount = p.taken.filter((inst) => inst.key === 's_yuyuko' && !inst.flipped).length;
            if (yuyukoCount > 0 && springEffective[i] === springMax) scores[i] += 4 * yuyukoCount;
          });
        });
      }
      return scores;
    }

    // 個別判定（収集・ペア・セット・豆腐・種類数・相反・連動・コンボ・裏返し）
    function endRoundIndividual(state, pi, detail) {
      const p = state.players[pi];
      let pts = 0;
      // 裏返しカード（ミスティア）は 2 点のみ・他の判定から除外（破棄カードは加点対象外）
      let flippedPts = 0;
      for (const inst of p.taken) {
        if (inst.flipped && !inst.discarded) {
          flippedPts++;
          inst.roundPts = (inst.roundPts || 0) + 2;
        }
      }
      pts += flippedPts * 2;

      // 各カード種別の判定（instant は即時点+取得時コンボで完結するため対象外）
      const seenKinds = {};
      for (const inst of p.taken) {
        if (inst.flipped || inst.discarded) continue;
        const def = state.cardMap[inst.key];
        if (!def) continue;
        if (['pair', 'pairCond', 'set3', 'collect', 'tofu', 'kindCount', 'letty', 'roundComboCount', 'aliceSet'].includes(def.kind)) {
          seenKinds[def.key] = true;
        }
      }
      const seenGroups = new Set();
      for (const key of Object.keys(seenKinds)) {
        const def = state.cardMap[key];
        const n = countKey(p, key);
        if (n === 0) continue;
        let kindPts = 0;
        let kindLabel = null;
        switch (def.kind) {
          case 'collect': {
            const idx = Math.min(n, def.table.length) - 1;
            kindPts = def.table[idx];
            break;
          }
          case 'pair': {
            kindPts = Math.floor(n / 2) * def.points;
            break;
          }
          case 'pairCond': {
            // 2 枚ごとに points（春アイコンを減らす効果は springIconTotal 側で処理）
            kindPts = Math.floor(n / 2) * def.points;
            break;
          }
          case 'set3': {
            kindPts = Math.floor(n / 3) * def.points;
            break;
          }
          case 'tofu': {
            const idx = n >= def.table.length ? def.table.length - 1 : n - 1;
            kindPts = def.table[idx];
            break;
          }
          case 'kindCount': {
            // 種類数（チルノ含む・同種は 1 種）− offset。破棄・裏返しは対象外
            const kinds = new Set();
            for (const inst of p.taken) {
              if (inst.flipped || inst.discarded) continue;
              kinds.add(inst.key);
            }
            // デザートも含める（手元のデザート）
            for (const inst of p.desserts) kinds.add(inst.key);
            kindPts = Math.max(0, kinds.size + def.offset);
            break;
          }
          case 'letty': {
            const own = countKey(p, def.ownKey);
            const spring = state.roundStats[pi].springIcons;
            kindPts = Math.max(0, (own - spring) * def.mult);
            break;
          }
          case 'aliceSet': {
            // 同じ group の種類数で得点（グループにつき 1 回だけ判定）
            const group = def.group || def.key;
            if (seenGroups.has(group)) break;
            seenGroups.add(group);
            const types = new Set();
            for (const inst of p.taken) {
              if (inst.flipped || inst.discarded) continue;
              const d = state.cardMap[inst.key];
              if (d && d.kind === 'aliceSet' && (d.group || d.key) === group) types.add(inst.key);
            }
            const tbl = def.table || [0, 1, 4, 9, 16];
            kindPts = tbl[types.size] || 0;
            kindLabel = `${def.groupLabel || def.name}（${types.size}種）`;
            break;
          }
          case 'roundComboCount': {
            // そのラウンドに取ったデザート。破棄・裏返し・コピーは判定から外れる
            // （フランで破棄したチルノを大妖精が数えてしまう不具合の修正）
            const target = def.targetKey || state.dessert.key;
            const cnt = p.taken.filter(
              (inst) => inst.key === target && !inst.discarded && !inst.flipped && !inst.copied
            ).length;
            kindPts = cnt * def.per;
            break;
          }
          default:
            break;
        }
        if (kindPts !== 0) {
          pts += kindPts;
          detail.push({
            key,
            label: kindLabel || (def.kind === 'roundComboCount' ? `${def.name}（デザート${n}枚）` : `${def.name}（${n}枚）`),
            pts: kindPts,
          });
        }
      }
      // 妖夢の加護: 次の春で得た追加点（ラウンド末にまとめて計上）
      if (p.youmuPts) {
        pts += p.youmuPts;
        detail.push({ key: 's_youmu', label: '妖夢（次の春）', pts: p.youmuPts });
      }
      return pts;
    }

    // 妹紅（dessertRound）: ラウンド終了時にペナルティ
    //   - 既定: そのラウンドに取った枚数ぶん（roundPenalty）
    //   - roundPenaltyCumulative: 前ラウンドまでの蓄積＋今ラウンドの取得分の累計ぶん
    // ゲーム末の最多加点は gameEndScore 側（endMost / endMostPer）
    // 破棄/裏返し/コピーされたデザートは判定から外れる
    function applyDessertRound(state, results) {
      const def = state.dessert;
      if (def.kind !== 'dessertRound' || !def.roundPenalty) return;
      for (let i = 0; i < state.players.length; i++) {
        const p = state.players[i];
        const takenNow = p.taken.filter((inst) => inst.key === def.key && !inst.discarded && !inst.flipped && !inst.copied).length;
        const n = def.roundPenaltyCumulative
          ? p.desserts.filter((inst) => inst.key === def.key).length + takenNow
          : takenNow;
        if (!n) continue;
        const pts = def.roundPenalty * n;
        // 内訳用: このラウンドに取ったデザート 1 枚ごとに罰則点を付ける
        for (const inst of p.taken) {
          if (inst.key !== def.key || inst.discarded || inst.flipped || inst.copied) continue;
          inst.roundPts = (inst.roundPts || 0) + def.roundPenalty;
        }
        p.roundScores[state.round] += pts;
        const r = results.find((x) => x.pi === i);
        if (r) r.points += pts;
        addLog(state, `${p.name}: 妹紅の炎に焼かれた（${pts >= 0 ? '+' : ''}${pts}点）`);
      }
    }

    // ---------------- ゲーム末判定 ----------------

    // ゲーム末ボーナスの内訳（リザルト表示用）
    function gameEndBreakdown(state, pi) {
      const p = state.players[pi];
      const out = [];
      // デザート判定（種別ごと）
      const leastDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertLeast');
      for (const def of leastDefs) {
        const counts = state.players.map((q) => q.desserts.filter((i) => i.key === def.key).length);
        const min = Math.min(...counts);
        const minIdx = counts.map((c, i) => (c === min ? i : -1)).filter((i) => i >= 0);
        if (minIdx.includes(pi)) out.push({ key: def.key, label: `${def.name}（最少）`, pts: def.least });
      }
      const iceDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertIce');
      for (const def of iceDefs) {
        const cnt = p.desserts.filter((i) => i.key === def.key).length;
        const v = Math.floor(cnt / def.per) * def.points;
        if (v) out.push({ key: def.key, label: `${def.name}（${cnt}枚）`, pts: v });
      }
      const roundDessertDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertRound');
      for (const def of roundDessertDefs) {
        if (def.endMost === undefined && def.endMostPer === undefined) continue;
        const counts = state.players.map((q) => q.desserts.filter((i) => i.key === def.key).length);
        const max = Math.max(...counts);
        if (max === 0) continue;
        const cnt = counts[pi];
        if (cnt !== max) continue;
        const v = def.endMost !== undefined ? def.endMost : def.endMostPer * cnt;
        if (v) out.push({ key: def.key, label: `${def.name}（最多${cnt}枚）`, pts: v });
      }
      const mostLeastDefs = Object.values(state.cardMap).filter((d) => d.kind === 'dessertMostLeast');
      for (const def of mostLeastDefs) {
        const counts = state.players.map((q) => q.desserts.filter((i) => i.key === def.key).length);
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        if (max === min) continue; // 全員同数なら判定しない
        const cnt = counts[pi];
        if (cnt === max && def.most) out.push({ key: def.key, label: `${def.name}（最多${cnt}枚）`, pts: def.most });
        if (cnt === min && def.least) out.push({ key: def.key, label: `${def.name}（最少${cnt}枚）`, pts: def.least });
      }
      // ゲーム末判定（霊夢・魔理沙）
      for (const def of Object.values(state.cardMap)) {
        if (!def.gameEnd) continue;
        const cnt = p.gameEndCounts[def.key] || 0;
        if (def.gameEndTotalAtLeast && cnt >= def.gameEndTotalAtLeast.count) {
          out.push({ key: def.key, label: `${def.name}（通算${cnt}枚）`, pts: def.gameEndTotalAtLeast.points });
        }
        if (def.gameEndMost) {
          const counts = state.players.map((q) => q.gameEndCounts[def.key] || 0);
          const max = Math.max(...counts);
          if (max > 0 && cnt === max) {
            out.push({ key: def.key, label: `${def.name}（最多）`, pts: def.gameEndMost.points });
          }
        }
      }
      return out;
    }

    function gameEndScore(state, pi) {
      return gameEndBreakdown(state, pi).reduce((a, b) => a + b.pts, 0);
    }

    function scorePlayer(state, pi) {
      const p = state.players[pi];
      let total = p.roundScores.reduce((a, b) => a + b, 0);
      if (state.phase === 'over') total += gameEndScore(state, pi);
      return total;
    }

    // ゲーム末の順位（同点タイブレーキ込み）。
    //   1) 合計点が高い方が上位
    //   2) 合計点が同じなら、デザートの合計枚数が多い方が上位
    //   3) それも同じなら同率（同じ順位・勝者を分け合う）
    // 順位は競技方式（1,1,3,4）。winner は 1 位の全員に立つ。
    // UI 表示・sim / ai-check の勝率集計はすべてこの関数を唯一の定義元にする。
    function finalRanking(state) {
      const rows = state.players.map((p, pi) => ({
        pi,
        name: p.name,
        total: scorePlayer(state, pi),
        desserts: p.desserts.length,
      }));
      rows.sort((a, b) => b.total - a.total || b.desserts - a.desserts || a.pi - b.pi);
      let prev = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (prev && prev.total === r.total && prev.desserts === r.desserts) r.rank = prev.rank;
        else r.rank = i + 1;
        r.winner = r.rank === 1;
        prev = r;
      }
      return rows;
    }

    function charmBonus(state, pi) {
      return gameEndScore(state, pi);
    }

    function roundBreakdown(state, pi) {
      const p = state.players[pi];
      const out = {};
      for (const inst of p.taken) {
        if (inst.flipped || inst.discarded) continue;
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
      finalRanking,
      gameEndBreakdown,
      charmBonus,
      roundBreakdown,
      countKey,
      countKeys,
      selectionNeeded,
      PASS_DIRS,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof window !== 'undefined') window.Engine = Engine;
})();



