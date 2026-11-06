'use strict';

// ホットシート UI。seat0 = 人間、seat1..3 = AI。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  let STATE = null;
  let CHOPSTICKS_MODE = false;
  let CHOP_SELECTED = []; // pick2 モード中の選択 idx
  let PICK_SELECTED = null; // 通常ピックで選択中の idx（決定ボタンで確定）
  let SEL_MODE = null;    // 取得時選択: 'discard' | 'flip' | 'copy' | 'peek' | null
  let SEL_SELECTED = [];  // flip モード中の選択 idx
  let STAGED_CHOICE = null; // 段階選択中の確定済み choice（全モード揃ったら choose で送る）

  const $ = (id) => document.getElementById(id);

  let ONLINE = false; // 対戦モード（サーバー権威）
  let MY_SEAT = 0;

  // 自分の行動。対戦中はサーバーへ送り、ホットシート中はエンジンへ直接適用する
  function actHuman(action) {
    if (ONLINE) {
      Net.action(action);
      // 連打・再送を防ぐため、送信済みの表示にする（サーバーの state で上書きされる）
      if (action.kind === 'choose' && STATE) {
        STATE.selectNeeded = []; // 自分の選択は送信済み。古い選択UIの再表示を防ぐ
        if (Array.isArray(STATE.selections)) STATE.selections[0] = true;
      } else if (STATE && STATE.picks) {
        STATE.picks[0] = true;
      }
      return { ok: true };
    }
    return Engine.dispatch(STATE, { ...action, pi: 0 });
  }

  // ロビー: 最初はモード選択だけ。選んだら2択を隠し、「← 戻る」で戻る
  function showMode(mode) {
    $('mode-select').classList.add('hidden');
    $('solo-panel').classList.toggle('hidden', mode !== 'solo');
    $('mp-entry').classList.toggle('hidden', mode !== 'online');
    if (mode === 'online') $('input-code').focus();
  }

  function showModeSelect() {
    $('mode-select').classList.remove('hidden');
    $('solo-panel').classList.add('hidden');
    $('mp-entry').classList.add('hidden');
  }

  function buildSoloIncidentOptions() {
    const sel = $('solo-incident');
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'おまかせ（ランダム）';
    sel.appendChild(auto);
    for (const id of Data.INCIDENT_IDS) {
      const inc = Data.incidentById(id);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = inc.name;
      sel.appendChild(o);
    }
  }

  function startGame() {
    const name = $('input-name').value.trim() || '幹事';
    const incident = $('solo-incident').value;
    const opts = incident ? { incident } : {};
    ONLINE = false;
    STATE = Engine.newGame(4, [name, '萃香', '魔理沙', 'にとり'], opts);
    CHOPSTICKS_MODE = false;
    CHOP_SELECTED = [];
    PICK_SELECTED = null;
    SEL_MODE = null;
    SEL_SELECTED = [];
    FINAL_CLOSED = false;
    DEAL_ANIM = true; // 初回配りアニメ
    HAND_SIG = '';
    HAND_COUNT = null;
    STAGED_CHOICE = null;
    $('lobby').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderAll();
  }

  // ゲーム終了後にロビー（モード選択）へ戻る
  function backToLobby() {
    if (ONLINE) {
      try { Net.leave(); } catch (e) { /* 切断済みでも続行 */ }
    }
    ONLINE = false;
    STATE = null;
    FINAL_CLOSED = false;
    $('app').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    showModeSelect();
  }

  // カード定義は state.cardMap から引く（異変ごとにキャラが変わるため）
  function defOf(key) {
    return STATE.cardMap[key];
  }
  function nameOf(key) {
    const d = STATE.cardMap[key];
    return d ? d.name : key;
  }

  // 表示用のカード名。アリスのように 1 枚のカードが複数の種類に分かれる場合は
  // 「アリス（蓬莱人形）」のようにカード名＋種類名で見分けられるようにする
  function cardLabel(def) {
    if (!def) return '';
    return def.variant ? `${def.name}（${def.variant}）` : def.name;
  }

  // ゲーム末ボーナス（霊夢の通算ノルマ・魔理沙の通算最多）の説明文
  function gameEndBonusText(def) {
    const parts = [];
    if (def.gameEndTotalAtLeast) {
      parts.push(`／ゲーム通算 ${def.gameEndTotalAtLeast.count} 枚以上で +${def.gameEndTotalAtLeast.points} 点`);
    }
    if (def.gameEndMost) {
      parts.push(`／ゲーム通算の枚数が最多なら +${def.gameEndMost.points} 点`);
    }
    return parts.join('');
  }

  // kind から説明テキストを生成（実パラメータを数字で見せる・全文はツールチップと一覧で使う）
  function descOf(def) {
    const MAKI = Data.RULES.MAKI_POINTS;
    switch (def.kind) {
      case 'instant': {
        const parts = [`${def.points} 点`];
        if (def.absentKeys) parts.push(`誰かが同時に${def.absentKeys.map(nameOf).join('か')}を取ると 0 点`);
        if (def.comboKeys) parts.push(`取った瞬間に${def.comboKeys.map(nameOf).join('・')}も手元なら +${def.comboBonus}`);
        if (def.discardBonus) parts.push(`取得時・手元 1 枚を山札へ戻し +${def.discardBonus} 点`);
        if (def.intruderPenalty) parts.push(`自分が乱入者を取ったラウンドは所持 1 枚ごとに -${def.intruderPenalty} 点`);
        if (def.zeroIfTaken) parts.push(`同じ手番に${nameOf(def.zeroIfTaken)}を取った人がいると 0 点`);
        if (def.pointsIfKey) parts.push(`同じラウンドに${nameOf(def.pointsIfKey.key)}を取っていれば ${def.pointsIfKey.points} 点`);
        if (def.swap) parts.push('取得時・手元のカード1枚を山札と交換できる（山札の上から1枚引く）');
        if (def.hidden) {
          parts.push('取った番・他の全員の取得は「うどんげ」に見える');
          parts.push('免疫はその番の自分だけ。他の人が出した番では自分も影響を受ける');
        }
        return parts.join('／');
      }
      case 'othersDiff': return `ラウンド末・(同じ手番に他の人が取った${nameOf(def.plusKey)}の枚数 − ${nameOf(def.minusKey)}の枚数) × ${def.mult} 点`;
      case 'pairCond': return `ラウンド末・2 枚ごとに ${def.points} 点／2 枚ごとに自分の${nameOf('s_spring')}アイコン合計 -${def.reduceSpringIconsPerPair}（春の順位判定が下がる）`;
      case 'maki': return `このアイコンの合計を競う・最多 ${MAKI.first} 点／2 位 ${MAKI.second} 点`;
      case 'temaki': return `この枚数を競う・最多 +${def.most}／最少 ${def.least} 点`;
      case 'springMost': return `ラウンド末・春の獲得数が全員最多なら、所持 1 枚ごとに +${def.most} 点（このカードの所持が条件）`;
      case 'springSteal': return `取った瞬間・他の全員から春を ${def.steal} 個ずつ奪う。春を持っていない相手 1 人につき +${def.pointPer} 点（誰からも奪えないと失敗）`;
      case 'pair': return `2 枚で 1 ペア = ${def.points} 点${gameEndBonusText(def)}`;
      case 'aliceSet': {
        const tbl = def.table || [0, 1, 4, 9, 16];
        return `集めた${def.name}の種類数で得点／1種 ${tbl[1]} 点・2種 ${tbl[2]} 点・3種 ${tbl[3]} 点・4種 ${tbl[4]} 点`;
      }
      case 'set3': return `3 枚で 1 セット = ${def.points} 点${gameEndBonusText(def)}`;
      case 'collect': return `1/2/3/4/5+ 枚で ${def.table.join('/')} 点`;
      case 'roundComboCount': return `このラウンドに自分がデザートを取るたび +${def.per} 点`;
      case 'tofu': return `1 枚 ${def.table[0]} 点・2 枚 ${def.table[1]} 点・3 枚以上 ${def.table[def.table.length - 1]} 点`;
      case 'kindCount': return `ラウンド末・「取ったカードの種類数 ${def.offset >= 0 ? '+' : ''}${def.offset}」点`;
      case 'letty': return `ラウンド末・(自分の冬の枚数 − 自分の春の個数) × ${def.mult} 点`;
      case 'coop': return `取得した手番に、自分以外が同じ手番で取得したリグル 1 枚につき +${def.points} 点（1 人だけなら 0 点）`;
      case 'flip': return `取得時・手元のカードを任意枚数裏返せる（判定から外れ 1 枚 ${def.flipPoints} 点・ミスティア自身は対象外）`;
      case 'copy': return `取得時・手元の他のカード 1 枚の効果をコピー`;
      case 'deckPeek': return `取得時・山札の上 ${def.peek} 枚を見て 1 枚獲得（残りは山札の下へ・使わなくてもよい）`;
      case 'collectByTwo': return `ゲーム末・2 枚ごとに ${def.per2} 点・4 枚以上で +${def.bonusAt4}`;
      case 'parity': return `ゲーム末・偶数枚なら 2 枚ごとに ${def.per2Even} 点／奇数なら ${def.per2Odd} 点`;
      case 'dessertLeast': return `ゲーム末・このデザートの枚数が最少なら ${def.least} 点`;
      case 'dessertIce': return `ゲーム末・${def.per} 枚ごとに +${def.points} 点`;
      case 'dessertRound': return `ラウンド末・そのラウンドに取った 1 枚ごとに ${def.roundPenalty} 点／ゲーム末・最多なら 所持枚数 × ${def.endMostPer} 点`;
      default: return '';
    }
  }

  // カード面用の極短テキスト（詳細は右の拡大表示とカード一覧で読む）
  function tinyDesc(def) {
    switch (def.kind) {
      case 'instant': return `${def.points}点${def.hidden ? '＋幻覚' : ''}${def.comboKeys ? '＋コンボ' : ''}${def.swap ? '＋交換' : ''}`;
      case 'othersDiff': return `(他${nameOf(def.plusKey)}−他${nameOf(def.minusKey)})×${def.mult}`;
      case 'pairCond': return `2枚毎${def.points}点／春-${def.reduceSpringIconsPerPair || 1}個`;
      case 'maki': return '最多+6／2位+3';
      case 'temaki': return `最多+${def.most}／最少${def.least}`;
      case 'springMost': return `春の最多で+${def.most}×枚`;
      case 'springSteal': return `春を${def.steal}個ずつ強奪`;
      case 'pair': return `2枚で${def.points}点`;
      case 'aliceSet': return '種類数で1/4/9/16点';
      case 'set3': return `3枚で${def.points}点`;
      case 'collect': return `枚数で加点`;
      case 'roundComboCount': return `デザート毎+${def.per}`;
      case 'tofu': return `${def.table.join('/')}点`;
      case 'kindCount': return `種類数${def.offset >= 0 ? '+' : ''}${def.offset}`;
      case 'letty': return `(冬−春)×${def.mult}`;
      case 'coop': return `同手番1枚+${def.points}`;
      case 'flip': return '任意枚を裏返す';
      case 'copy': return '効果をコピー';
      case 'deckPeek': return `山札${def.peek}枚見て1枚`;
      case 'collectByTwo': return `2枚毎+${def.per2}`;
      case 'parity': return '偶数/奇数で加点';
      case 'dessertLeast': return `最少で${def.least}`;
      case 'dessertIce': return `${def.per}枚毎+${def.points}`;
      case 'dessertRound': return `取得毎${def.roundPenalty}／最多×${def.endMostPer}`;
      default: return '';
    }
  }

  // ---- 数アイコン（春＝桜 / 玉兎＝兎） ----
  const COUNT_ICON_SVG = {
    spring: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(72 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(144 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(216 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(288 12 12)"/></g><circle cx="12" cy="12" r="2.1" fill="#f6d67a"/></svg>',
    rabbit: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="8.6" cy="6" rx="2.1" ry="5"/><ellipse cx="15.4" cy="6" rx="2.1" ry="5"/><circle cx="12" cy="15.4" r="6.1"/></g><circle cx="9.9" cy="14.4" r="0.9" fill="#2a2532"/><circle cx="14.1" cy="14.4" r="0.9" fill="#2a2532"/><circle cx="12" cy="17.1" r="0.8" fill="#c98ba8"/></svg>',
  };
  function countIconKind(def) {
    if (!def) return null;
    if (def.key === 's_spring') return 'spring';
    if (def.key === 'y_rabbit') return 'rabbit';
    return null;
  }
  // カード面の右上に出すアイコン数バッジ（春・玉兎だけ）
  function countBadge(def, icons) {
    const kind = countIconKind(def);
    if (!kind || !icons) return '';
    const n = Math.max(1, Math.min(3, Number(icons)));
    return `<span class="card-count" title="アイコン ${icons} 個">${COUNT_ICON_SVG[kind].repeat(n)}</span>`;
  }


  // ---- 人間の入力 ----

  // クリックは選択のトグルのみ。確定は決定ボタン（confirmPick）で行う（ミスクリック防止）
  function onHandClick(idx) {
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0]) return;
    const p = STATE.players[0];

    if (CHOPSTICKS_MODE && p.chopsticks > 0) {
      if (CHOP_SELECTED.includes(idx)) {
        CHOP_SELECTED = CHOP_SELECTED.filter((i) => i !== idx);
        renderAll();
        return;
      }
      if (CHOP_SELECTED.length >= 2) return;
      CHOP_SELECTED.push(idx);
      renderAll();
      return;
    }

    if (PICK_SELECTED === idx) PICK_SELECTED = null;
    else PICK_SELECTED = idx;
    renderAll();
  }

  // 決定ボタン: 選択したカードで確定してエンジンに送る
  function confirmPick() {
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0]) return;
    const p = STATE.players[0];

    if (CHOPSTICKS_MODE && p.chopsticks > 0) {
      if (CHOP_SELECTED.length !== 2) return;
      CHOP_SELECTED.forEach((i) => flyFromIdx(i));
      actHuman({ kind: 'pick2', idxs: [...CHOP_SELECTED].sort((a, b) => a - b) });
      CHOP_SELECTED = [];
      afterHumanPick();
      return;
    }

    if (PICK_SELECTED === null) return;
    flyFromIdx(PICK_SELECTED);
    const res = actHuman({ kind: 'pick', idx: PICK_SELECTED });
    if (!res.ok) { FLY_FROMS.pop(); alert(res.error); return; }
    PICK_SELECTED = null;
    afterHumanPick();
  }

  function toggleChopsticks() {
    // 早飲み（箸）用の UI 経路。箸カードは未実装だが将来追加する可能性があるため残す
    const p = STATE.players[0];
    if (p.chopsticks <= 0) return;
    CHOPSTICKS_MODE = !CHOPSTICKS_MODE;
    CHOP_SELECTED = [];
    renderAll();
  }

  function runAiPicks() {
    if (ONLINE) return; // 対戦中はサーバーが全席を解決する
    for (let i = 1; i < STATE.playerCount; i++) {
      if (STATE.picks[i] !== null) continue;
      const use2 = STATE.players[i].chopsticks > 0 && STATE.players[i].hand.length >= 2;
      const idxs = use2 ? AI.pick2(STATE, i) : AI.pick(STATE, i);
      if (idxs.length === 0) Engine.dispatch(STATE, { kind: 'skip', pi: i });
      else if (idxs.length === 2) Engine.dispatch(STATE, { kind: 'pick2', pi: i, idxs });
      else Engine.dispatch(STATE, { kind: 'pick', pi: i, idx: idxs[0] });
    }
  }

  // 早飲みで枚数がズレて人間の手札が先に尽きた場合、自動で空ピックして進行を止めない
  function autoSkipIfEmpty() {
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0]) return;
    if (STATE.players[0].hand.length !== 0) return;
    const res = actHuman({ kind: 'skip' });
    if (res.ok) runAiPicks();
  }

  function runAiSelections() {
    if (ONLINE) return; // 対戦中はサーバーが全席を解決する
    if (STATE.phase !== 'select') return;
    for (const pi of STATE.selectNeeded) {
      if (pi === 0) continue; // 人間の選択は select UI に委ねる（{} で自動解決しない）
      if (STATE.selections[pi] === null) {
        Engine.dispatch(STATE, { kind: 'choose', pi, choice: AI.selectChoice(STATE, pi) });
      }
    }
  }

  function afterHumanPick() {
    if (ONLINE) {
      CHOPSTICKS_MODE = false;
      CHOP_SELECTED = [];
      PICK_SELECTED = null;
      renderAll();
      return;
    }
    runAiPicks();
    runAiSelections();
    CHOPSTICKS_MODE = false;
    LAST_FLOW_DIR = STATE.passDir; // パス方向を記録（flow アニメの来る方向に使う）
    renderAll();
    flyNewCards();
  }

  // ---- 取得時選択（select フェーズ）の入力 ----

  function humanSelectNeeded() {
    // エンジンの selectionNeeded と同じ判定を UI 側で行う
    const p = STATE.players[0];
    const need = { discard: false, flip: false, copy: false, peek: false, swap: false };
    for (const inst of p.taken) {
      const def = defOf(inst.key);
      if (!def || inst.selectionDone) continue;
      if (def.kind === 'instant' && def.discardBonus) need.discard = true;
      if (def.kind === 'instant' && def.swap) need.swap = true;
      if (def.kind === 'flip') need.flip = true;
      if (def.kind === 'copy') need.copy = true;
      if (def.kind === 'deckPeek') need.peek = true;
    }
    return need;
  }

  function enterSelectMode() {
    const need = humanSelectNeeded();
    // 蓄積済み choice に含まれていないモードを優先順に選ぶ
    const order = ['discard', 'copy', 'swap', 'flip', 'peek'];
    SEL_MODE = order.find((m) => need[m] && !modeStaged(m)) || null;
    SEL_SELECTED = [];
    return SEL_MODE;
  }

  // 段階選択で既に確定済みのモードか
  function modeStaged(mode) {
    if (!STAGED_CHOICE) return false;
    if (mode === 'flip') return Array.isArray(STAGED_CHOICE.flip);
    return STAGED_CHOICE[CHOICE_KEY[mode]] !== undefined;
  }

  function onTakenClick(idx) {
    if (!STATE || STATE.phase !== 'select') return;
    if (!SEL_MODE) return;
    if (SEL_MODE === 'peek') {
      // 小悪魔の山札確認: 候補から単一選択（全部選択可）
      SEL_SELECTED = [idx];
      renderAll();
      return;
    }
    // 対象外カード（効果カード自身・破棄済み）は選択不可
    const inst = STATE.players[0].taken[idx];
    if (!inst || !selectTargetable(inst, SEL_MODE)) return;
    if (SEL_MODE === 'flip') {
      // ミスティアは任意枚数・トグル選択（決定ボタンで確定）
      if (SEL_SELECTED.includes(idx)) SEL_SELECTED = SEL_SELECTED.filter((i) => i !== idx);
      else SEL_SELECTED.push(idx);
      renderAll();
      return;
    }
    // discard / copy: 単一選択のトグル（確定は決定ボタン）
    if (SEL_SELECTED.includes(idx)) SEL_SELECTED = [];
    else SEL_SELECTED = [idx];
    renderAll();
  }

  // select モードごとの選択対象判定（効果カード自身・破棄済みは対象外）
  // デザートは破棄/裏返し/コピーの対象に含まれる（デザートリスクの回避手段になる）
  function selectTargetable(inst, mode) {
    const def = defOf(inst.key);
    if (!def || inst.discarded) return false;
    if (mode === 'discard') return !def.discardBonus; // フラン自身は破棄できない
    if (mode === 'flip') return def.kind !== 'flip'; // ミスティア自身は裏返せない
    if (mode === 'copy') return def.kind !== 'copy'; // 慧音自身はコピーできない
    if (mode === 'swap') return !def.swap && def.key !== STATE.dessert.key; // 永琳自身とデザートは交換できない
    return false;
  }

  // 選択モード → choice オブジェクトのキー（小悪魔の山札確認だけ pick になる）
  const CHOICE_KEY = { discard: 'discard', copy: 'copy', swap: 'swap', flip: 'flip', peek: 'pick' };

  // select フェーズの決定ボタン: 現在のモードを確定して choice に積む。
  // 他に未選択の必要があれば次のモードへ移り、すべて揃ったら choose で一括送信する
  function confirmSelect() {
    if (!STATE || STATE.phase !== 'select') return;
    const choice = { ...(STAGED_CHOICE || {}) };
    if (SEL_MODE === 'discard') {
      if (SEL_SELECTED.length !== 1) return;
      choice.discard = SEL_SELECTED[0];
    } else if (SEL_MODE === 'copy') {
      if (SEL_SELECTED.length !== 1) return;
      choice.copy = SEL_SELECTED[0];
    } else if (SEL_MODE === 'swap') {
      if (SEL_SELECTED.length !== 1) return;
      choice.swap = SEL_SELECTED[0];
    } else if (SEL_MODE === 'flip') {
      choice.flip = [...SEL_SELECTED]; // 0 枚可
    } else if (SEL_MODE === 'peek') {
      if (SEL_SELECTED.length !== 1) return;
      choice.pick = SEL_SELECTED[0];
    } else {
      return;
    }

    // 残りの必要モードがあれば次へ進む
    const need = humanSelectNeeded();
    const order = ['discard', 'copy', 'swap', 'flip', 'peek'];
    const next = order.find((m) => need[m] && (m === 'flip' ? !Array.isArray(choice.flip) : choice[CHOICE_KEY[m]] === undefined));
    if (next) {
      STAGED_CHOICE = choice;
      SEL_MODE = next;
      SEL_SELECTED = [];
      renderAll();
      return;
    }

    STAGED_CHOICE = null;
    SEL_MODE = null;
    SEL_SELECTED = [];
    actHuman({ kind: 'choose', choice });
    runAiSelections();
    renderAll();
  }

  function skipSelection() {
    if (!STATE || STATE.phase !== 'select') return;
    // 段階選択: 現在のモードをスキップして次の必要モードへ（すべてスキップなら choose {} で解決）
    const choice = { ...(STAGED_CHOICE || {}) };
    if (SEL_MODE === 'flip') choice.flip = [];
    // discard/copy/peek は choice に含めない = 「使わない」扱い（エンジンは未指定を許容）
    const need = humanSelectNeeded();
    const order = ['discard', 'copy', 'swap', 'flip', 'peek'];
    const next = order.find((m) => need[m] && (m === 'flip' ? !Array.isArray(choice.flip) : choice[CHOICE_KEY[m]] === undefined) && m !== SEL_MODE);
    if (next) {
      STAGED_CHOICE = choice;
      SEL_MODE = next;
      SEL_SELECTED = [];
      renderAll();
      return;
    }
    STAGED_CHOICE = null;
    SEL_MODE = null;
    SEL_SELECTED = [];
    actHuman({ kind: 'choose', choice });
    runAiSelections();
    renderAll();
  }

  // ---- 描画 ----

  function cardEl(key, icons, extra, inst, roundPts) {
    const def = defOf(key);
    const el = document.createElement('div');
    el.className = `card${extra ? ' ' + extra : ''}`;
    el.style.background = def.color; // 画像が無いときのフォールバック
    el.innerHTML = `
      <img class="card-art" src="assets/cards/${key}.webp" alt="" loading="lazy" onerror="this.remove(); this.parentElement.classList.add('no-art')">
      <div class="card-scrim"></div>
      <div class="card-glyph">${def.icon}</div>
      ${countBadge(def, icons)}
      <div class="card-body">
        <div class="card-name"><span class="card-title">${def.name}</span>${def.variant ? `<span class="card-var">${def.variant}</span>` : ''}</div>
        <div class="card-desc">${tinyDesc(def)}</div>
      </div>`;
    // ホバーで右パネルに拡大表示する
    el.addEventListener('mouseenter', () => {
      PREVIEW = { key, icons, inst };
      renderPreview();
    });
    el.addEventListener('mouseleave', () => {
      if (PREVIEW && PREVIEW.key === key) { PREVIEW = null; renderPreview(); }
    });
    // 効果の影響状態をカードに直接示す（破棄=半透明+ラベル・裏返し=暗く+2点ラベル）
    if (inst) {
      if (inst.discarded) {
        el.classList.add('discarded');
        el.insertAdjacentHTML('beforeend', '<div class="card-tag tag-discard">破棄</div>');
      }
      if (inst.flipped) {
        el.classList.add('flipped');
        el.insertAdjacentHTML('beforeend', '<div class="card-tag tag-flip">2点</div>');
      }
    }
    // 獲得時に点数が確定するカード（即時系）は、ラウンド末集計待ちでも点数をカードに表示する
    if (roundPts !== null && roundPts !== undefined) {
      el.insertAdjacentHTML('beforeend', `<div class="card-tag tag-pts">${roundPts}点</div>`);
    }
    el.title = inst && inst.copied
      ? `慧音のコピー・${cardLabel(def)}：${descOf(def)}`
      : `${cardLabel(def)}：${descOf(def)}`;
    return el;
  }

  // 取得行に表示する「確定済み点数」（即時系カードのみ・破棄/裏返しはタグが代わりに表示される）
  function roundPtsOf(inst, pi) {
    const def = defOf(inst.key);
    if (!def || inst.flipped || inst.discarded) return null;
    if (def.kind === 'coop') return inst.coopPoints || null; // リグルは取得した手番で確定
    if (def.kind !== 'instant') return null;
    let pts = def.points;
    if (inst.instantCombo && def.comboBonus) pts += def.comboBonus; // 美鈴・藍・橙の取得時コンボ
    if (def.absentBlocked) pts = 0; // 咲夜の同席判定
    if (def.pointsIfKey && STATE.players[pi]) {
      const hasKey = STATE.players[pi].taken.some((i) => i.key === def.pointsIfKey.key && !i.flipped && !i.discarded);
      if (hasKey) pts = def.pointsIfKey.points;
    }
    if (def.intruderPenalty && STATE.roundStats && STATE.roundStats[pi] && STATE.roundStats[pi].intruderTaken) {
      pts -= def.intruderPenalty; // 輝夜・永琳の乱入者ペナルティ
    }
    if (inst.extraPts) pts += inst.extraPts; // 永琳の調合など、取得時に確定した追加点
    return pts;
  }

  function renderHand() {
    const handEl = $('hand');
    handEl.innerHTML = '';
    const p = STATE.players[0];
    const myTurn = STATE.phase === 'pick' && !STATE.picks[0];
    const selectTurn = STATE.phase === 'select' && STATE.selectNeeded.includes(0);

    // 手札変化の検出: DEAL_ANIM 中 or 枚数増=配り・それ以外の内容変化=パス流れ込み
    // （render はピック+パス解決後の最終状態を描くため、枚数減でもパスで手札が入れ替わっている）
    const sig = p.hand.map((c) => c.key + (c.icons || '')).join('|');
    let anim = null;
    if (DEAL_ANIM && p.hand.length > 0) anim = 'deal';
    else if (HAND_COUNT !== null && sig !== HAND_SIG && p.hand.length > 0) anim = 'flow';
    HAND_SIG = sig;
    HAND_COUNT = p.hand.length;
    DEAL_ANIM = false;

    const statusEl = $('hand-status');
    if (STATE.phase === 'over') {
      statusEl.textContent = '宴会終了！';
    } else if (STATE.phase === 'select') {
      statusEl.textContent = selectStatusText(selectTurn);
    } else if (STATE.picks[0]) {
      statusEl.textContent = '他の幹事の選択を待っている…';
    } else if (CHOPSTICKS_MODE) {
      statusEl.textContent = `早飲みモード：2枚選んでね（${CHOP_SELECTED.length}/2 枚選択）`;
    } else if (PICK_SELECTED !== null && p.hand[PICK_SELECTED]) {
      statusEl.textContent = `「${cardLabel(defOf(p.hand[PICK_SELECTED].key))}」を選択中。決定ボタンで確定`;
    } else if (STATE.hidden) {
      statusEl.textContent = STATE.hiddenOwner === 0
        ? '幻覚をかけている：出した番の全員のピックがうどんげに見えている'
        : '幻覚がかかっている：出した番のピックがうどんげに見えている';
    } else {
      statusEl.textContent = '手札から 1 枚選んで決定ボタンを押してね';
    }

    const chopBtn = $('btn-chopsticks');
    chopBtn.classList.toggle('hidden', !(myTurn && p.chopsticks > 0));
    chopBtn.classList.toggle('active', CHOPSTICKS_MODE);

    const confirmBtn = $('btn-confirm-pick');
    const canConfirm = myTurn && (CHOPSTICKS_MODE ? CHOP_SELECTED.length === 2 : PICK_SELECTED !== null);
    confirmBtn.classList.toggle('hidden', !canConfirm);

    p.hand.forEach((card, idx) => {
      const el = cardEl(card.key, card.icons);
      const selected = CHOP_SELECTED.includes(idx) || PICK_SELECTED === idx;
      if (selected) el.classList.add('selected');
      // 配り・流れ込みアニメ（deal は枚数分ずらして1枚ずつ配られる演出）
      if (anim === 'deal') {
        el.classList.add('deal');
        el.style.setProperty('--deal-i', idx);
      } else if (anim === 'flow') {
        el.classList.add('flow', LAST_FLOW_DIR === 1 ? 'from-left' : 'from-right');
      }
      if (myTurn) {
        el.classList.add('clickable');
        el.addEventListener('click', () => onHandClick(idx));
      } else {
        el.classList.add('disabled');
      }
      handEl.appendChild(el);
    });
  }

  function selectStatusText(selectTurn) {
    const need = humanSelectNeeded();
    if (!selectTurn) return '他の幹事の選択を待っている…';
    if (SEL_MODE === 'flip') return `裏返すカードを選んでね（${SEL_SELECTED.length} 枚選択・任意枚数）`;
    if (SEL_MODE === 'discard') return SEL_SELECTED.length === 1
      ? '破棄するカードを選択中。決定ボタンで確定'
      : '破棄するカードを 1 枚選んでね';
    if (SEL_MODE === 'copy') return SEL_SELECTED.length === 1
      ? 'コピーするカードを選択中。決定ボタンで確定'
      : 'コピーするカードを 1 枚選んでね';
    if (SEL_MODE === 'swap') return SEL_SELECTED.length === 1
      ? '山札と交換するカードを選択中。決定ボタンで確定'
      : '山札と交換するカードを 1 枚選んでね（永琳の薬）';
    if (SEL_MODE === 'peek') return SEL_SELECTED.length === 1
      ? '獲得するカードを選択中。決定ボタンで確定'
      : '山札の上 4 枚の中から獲得するカードを 1 枚選んでね';
    return '取得カードの効果を選択中…';
  }

  // select フェーズの UI（取得カードの選択）:
  // 選択欄は「あなたの取得行」の上に重ねて表示する（meRow の子として DOM 移動）
  function renderSelectArea() {
    // table-rows の再構築で要素が detached になるため、参照はモジュール変数で保持する
    if (!SELECT_AREA) SELECT_AREA = document.getElementById('select-area');
    const areaEl = SELECT_AREA;
    if (!STATE || STATE.phase !== 'select') {
      areaEl.classList.remove('active');
      // 選択フェーズが終わったらモードを持ち越さない（次の小悪魔取得で古い破棄UIが出るのを防ぐ）
      SEL_MODE = null;
      SEL_SELECTED = [];
      STAGED_CHOICE = null;
      return;
    }
    const p = STATE.players[0];
    const selectTurn = STATE.selectNeeded.includes(0);

    if (!selectTurn) {
      // 他人の選択待ち。古いモードを残さない
      SEL_MODE = null;
      SEL_SELECTED = [];
      STAGED_CHOICE = null;
    } else {
      const need = humanSelectNeeded();
      // 今の必要モードと一致しない古いモードが残っていたら選び直す
      if (!SEL_MODE || !need[SEL_MODE]) enterSelectMode();
    }

    areaEl.classList.add('active');
    areaEl.innerHTML = '';

    const meRow = document.querySelector('.table-row.me');
    if (meRow) meRow.appendChild(areaEl);

    const title = document.createElement('div');
    title.className = 'select-title';
    title.textContent = selectStatusText(selectTurn);
    areaEl.appendChild(title);

    const list = document.createElement('div');
    list.className = 'select-list';
    if (SEL_MODE === 'peek' && selectTurn) {
      // 小悪魔の山札確認: 候補 4 枚を表示（全部選択可）
      (STATE.peekCards[0] || []).forEach((inst, idx) => {
        const el = cardEl(inst.key, inst.icons, 'taken', inst);
        if (SEL_SELECTED.includes(idx)) el.classList.add('selected');
        el.classList.add('clickable');
        el.addEventListener('click', () => onTakenClick(idx));
        list.appendChild(el);
      });
    } else {
      p.taken.forEach((card, idx) => {
        const el = cardEl(card.key, card.icons, 'taken', card);
        const isSel = SEL_SELECTED.includes(idx);
        if (isSel) el.classList.add('selected');
        if (selectTurn) {
          // 効果カード自身・破棄済みは対象外としてグレーアウト表示
          if (selectTargetable(card, SEL_MODE)) {
            el.classList.add('clickable');
            el.addEventListener('click', () => onTakenClick(idx));
          } else {
            el.classList.add('not-target');
          }
        } else {
          el.classList.add('disabled');
        }
        list.appendChild(el);
      });
    }
    areaEl.appendChild(list);

    const btnRow = document.createElement('div');
    btnRow.className = 'select-btn-row';
    if (SEL_MODE && selectTurn) {
      const confirmBtn = document.createElement('button');
      confirmBtn.disabled = SEL_MODE !== 'flip' && SEL_SELECTED.length !== 1;
      if (SEL_MODE === 'flip') {
        confirmBtn.textContent = `裏返しを決定（${SEL_SELECTED.length} 枚）`;
      } else if (SEL_MODE === 'discard') {
        const bonus = (p.taken.map((inst) => defOf(inst.key)).find((d) => d.discardBonus) || {}).discardBonus || 2;
        confirmBtn.textContent = `このカードを破棄する（+${bonus} 点）`;
      } else if (SEL_MODE === 'copy') {
        confirmBtn.textContent = 'この効果をコピーする';
      } else if (SEL_MODE === 'swap') {
        confirmBtn.textContent = 'このカードを山札と交換する';
      } else if (SEL_MODE === 'peek') {
        confirmBtn.textContent = 'このカードを獲得する';
      }
      confirmBtn.addEventListener('click', confirmSelect);
      btnRow.appendChild(confirmBtn);

      const skipBtn = document.createElement('button');
      skipBtn.className = 'secondary';
      skipBtn.textContent = '効果を使わない';
      skipBtn.addEventListener('click', skipSelection);
      btnRow.appendChild(skipBtn);
    }
    areaEl.appendChild(btnRow);
  }

  // 上部プレイヤーバー（BGA 風コンパクト表示: 名前・今ラウンド即時点・合計）
  function renderPlayerBar() {
    const wrap = $('player-bar');
    wrap.innerHTML = '';
    STATE.players.forEach((p, pi) => {
      const picked = STATE.picks[pi] !== null;
      const roundPts = p.roundScores[STATE.round];
      const tags = [];
      if (p.chopsticks > 0) tags.push(`早×${p.chopsticks}`);
      if (p.desserts.length > 0) tags.push(`デザート×${p.desserts.length}`);
      // 乱入者（霊夢/魔理沙）はゲーム通算で数えるので、手元ではなく通算カウントを出す
      if (STATE.intruderKey) {
        const cnt = gameEndCountFor(p, STATE.intruderKey);
        if (cnt > 0) tags.push(`${nameOf(STATE.intruderKey)}×${cnt}`);
      }
      const el = document.createElement('div');
      el.className = `player-chip${pi === 0 ? ' me' : ''}${picked ? ' picked' : ''}`;
      el.innerHTML = `
        <span class="chip-name">${pi === 0 ? 'あなた' : ''}${p.name}</span>
        <span class="chip-round">${STATE.phase !== 'over' && roundPts ? `R${STATE.round + 1} +${roundPts}` : ''}</span>
        <span class="chip-tags">${tags.join(' ')}</span>
        <span class="chip-score">${Engine.scorePlayer(STATE, pi)}点</span>`;
      wrap.appendChild(el);
    });
  }

  // 直近ピック（state.lastPicks）で取られたカードに .new を付けてポップイン表示（renderTableRows 内で処理）

  // プレイヤーごとの追跡リソース（春の合計・兎/妖精メイドの枚数など）
  // うどんげの幻覚中は、隠れているカードの寄与を差し引いてバッジから中身がバレないようにする
  // そのカードが自分から見えないか。免疫は「その手番で鈴仙を出した本人」だけ
  function hiddenFromViewer(inst) {
    if (!inst) return false;
    if (inst.masked) return true; // オンラインはサーバーが既に伏せている
    if (!inst.hiddenTaken) return false;
    return inst.hiddenBy !== 0;
  }

  function visibleTaken(p) {
    return p.taken.filter((inst) => !hiddenFromViewer(inst));
  }

  // 幻覚で隠した乱入者ぶんを差し引いた通算（ローカル対戦用。オンラインはサーバーが処理済み）
  function gameEndCountFor(p, key) {
    let n = (p.gameEndCounts && p.gameEndCounts[key]) || 0;
    n -= p.taken.filter((i) => hiddenFromViewer(i) && i.key === key).length;
    return Math.max(0, n);
  }

  function trackedTags(pi) {
    const p = STATE.players[pi];
    const tags = [];
    const shown = visibleTaken(p);
    // 春雪: ラウンド統計の春アイコン合計（妖夢の吸収も反映済み）
    if (STATE.incidentId === 'spring' && STATE.roundStats) {
      // 自分から見えていないカードのアイコンは差し引く（オンラインはサーバーが処理済み＝0）
      const hiddenIcons = p.taken
        .filter((i) => hiddenFromViewer(i))
        .reduce((a, i) => a + (i.icons || 0), 0);
      const icons = Math.max(0, STATE.roundStats[pi].springIcons - hiddenIcons);
      tags.push({ icon: COUNT_ICON_SVG.spring, label: String(icons), color: '#b8487e' });
    }
    // 多数決系カード（巻物=兎、妖精メイド等）のアイコン合計
    for (const def of Object.values(STATE.cardMap)) {
      if (def.kind !== 'maki' && def.kind !== 'temaki') continue;
      // 春雪では春の合計を上で既に表示するため重複を避ける
      if (STATE.incidentId === 'spring' && def.kind === 'maki') continue;
      let n = 0;
      for (const inst of shown) {
        if (inst.key === def.key && !inst.flipped) n += inst.icons || 1;
      }
      const icon = def.kind === 'maki' ? COUNT_ICON_SVG[countIconKind(def)] : '';
      tags.push({ icon, label: `${def.kind === 'maki' ? '' : def.icon}${n}`, color: def.color });
    }
    return tags;
  }

  // プレイヤーごとの「取ったカード」行（あなた → 他のプレイヤーの順）
  function renderTableRows() {
    const wrap = $('table-rows');
    wrap.innerHTML = '';
    // 「新しく取った」アニメはピック解決の瞬間だけ。カード選択などによる再描画では再生しない
    const animateNew = STATE.pickSeq !== PICK_ANIM_SIG;
    PICK_ANIM_SIG = STATE.pickSeq;
    const order = [];
    for (let i = 0; i < STATE.playerCount; i++) order.push(i);
    order.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
    for (const pi of order) {
      const p = STATE.players[pi];
      const row = document.createElement('div');
      row.className = `table-row${pi === 0 ? ' me' : ''}`;

      const main = document.createElement('div');
      main.className = 'row-main';
      const label = document.createElement('div');
      label.className = 'row-label';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${pi === 0 ? 'あなた' : ''}${p.name} の取ったカード`;
      label.appendChild(nameSpan);
      // 追跡リソース（春合計・兎枚数など）
      for (const t of trackedTags(pi)) {
        const tag = document.createElement('span');
        tag.className = 'row-tag';
        tag.style.background = t.color;
        tag.innerHTML = (t.icon || '') + `<span>${t.label}</span>`;
        label.appendChild(tag);
      }
      main.appendChild(label);

      const cards = document.createElement('div');
      cards.className = 'row-cards';
      if (p.taken.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'row-empty';
        empty.textContent = '—';
        cards.appendChild(empty);
      } else {
        // 慧音のコピー（copied インスタンス）は慧音カードに重ねて表示するため独立カードとしては描かない
        const shown = p.taken.filter((inst) => !inst.copied && !inst.peekedGain);
        // 今ピック分だけ .new を付ける: taken 末尾から lastPicks の keys と照合
        const lp = STATE.lastPicks && STATE.lastPicks.find((x) => x.pi === pi);
        const keys = lp ? [...lp.keys] : [];
        const els = shown.map((inst) => {
          // うどんげの幻覚: 幻覚中の他プレイヤーのピックは「うどんげ」として表示される。
          // 本物の鈴仙と見分けが付かないよう、偽の鈴仙にも「1点」を付ける（付けると中身がバレる）
          if (hiddenFromViewer(inst)) {
            return cardEl('y_reisen', null, 'mini', null, 1);
          }
          return cardEl(inst.key, inst.icons, 'mini', inst, roundPtsOf(inst, pi));
        });
        for (let i = els.length - 1; i >= 0 && keys.length && animateNew; i--) {
          const k = keys.indexOf(shown[i].key);
          if (k >= 0) { els[i].classList.add('new'); keys.splice(k, 1); }
        }
        // 慧音のコピー・小悪魔の獲得カードは「獲得したカードの上に元カードを重ねる」
        const copiedInst = p.taken.find((inst) => inst.copied);
        for (let i = 0; i < els.length; i++) {
          const inst = shown[i];
          const def = defOf(inst.key);
          if (!def || inst.discarded) continue;
          let baseKey = null;
          let baseIcons = null;
          let verb = '';
          if (def.kind === 'copy' && copiedInst) {
            baseKey = copiedInst.key;
            baseIcons = copiedInst.icons;
            verb = 'コピー';
          } else if (inst.peekedBy) {
            baseKey = inst.peekedBy.key;
            baseIcons = inst.peekedBy.icons;
            verb = '獲得';
          }
          if (!baseKey) continue;
          const base = cardEl(baseKey, baseIcons, 'mini copy-base', null);
          base.classList.toggle('new', els[i].classList.contains('new'));
          base.appendChild(cardEl(inst.key, null, 'mini copy-overlay', null));
          base.title = `${nameOf(inst.key)}が「${nameOf(baseKey)}」を${verb}：${descOf(defOf(baseKey))}`;
          els[i] = base;
          break;
        }
        els.forEach((el) => cards.appendChild(el));
      }
      main.appendChild(cards);
      row.appendChild(main);

      // デザート置き場（右端固定・BGA 版準拠）
      const dbox = document.createElement('div');
      dbox.className = 'dessert-box';
      const dlabel = document.createElement('div');
      dlabel.className = 'box-label';
      dlabel.textContent = p.desserts.length ? `デザート ×${p.desserts.length}` : 'デザート置き場';
      dbox.appendChild(dlabel);
      const dcards = document.createElement('div');
      dcards.className = 'box-cards';
      const dlp = STATE.lastPicks && STATE.lastPicks.find((x) => x.pi === pi);
      const dkeys = dlp ? [...dlp.keys] : [];
      const dels = p.desserts.map((inst) => cardEl(inst.key, null, 'mini'));
      for (let i = dels.length - 1; i >= 0 && dkeys.length && animateNew; i--) {
        const k = dkeys.indexOf(p.desserts[i].key);
        if (k >= 0) { dels[i].classList.add('new'); dkeys.splice(k, 1); }
      }
      dels.forEach((el) => dcards.appendChild(el));
      dbox.appendChild(dcards);
      row.appendChild(dbox);

      wrap.appendChild(row);
    }
  }

  function renderRound() {
    if (STATE.phase === 'over') {
      $('round-indicator').textContent = '宴会終了';
      $('pass-indicator').textContent = '';
      return;
    }
    $('round-indicator').textContent = `ラウンド ${STATE.round + 1} / ${STATE.incidentName}`;
    $('pass-indicator').textContent = STATE.passDir === 1 ? '手札は右隣へ流れる' : '手札は左隣へ流れる';
  }

  let FINAL_CLOSED = false; // 最終結果バナーを一度閉じたら再表示しない
  let FLY_FROMS = []; // FLIP アニメ用: 確定した手札カードの中心座標
  let SELECT_AREA = null; // 取得時選択欄の要素（table-rows 再構築で detached になるため参照を保持）
  let HAND_SIG = ''; // 前回 render 時の手札シグネチャ（パス・配りアニメの判定用）
  let HAND_COUNT = null; // 前回 render 時の手札枚数
  let DEAL_ANIM = false; // ラウンド開始直後フラグ（配りアニメを1回だけ発動）
  let LAST_FLOW_DIR = 1; // 最後のパス方向（流れ込みアニメの来る方向）
  let PICK_ANIM_SIG = -1; // 前回アニメしたピック連番（取得カードの popIn を解決時だけに絞る）

  // 確定時に選択カードの現在座標を記録（FLIP アニメの移動元）
  function flyFromIdx(idx) {
    const el = document.querySelectorAll('#hand .card')[idx];
    if (!el) return;
    const r = el.getBoundingClientRect();
    FLY_FROMS.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  // 取得アニメ: 手札にあった位置から自分の取得行へカードを飛ばす（FLIP）
  function flyNewCards() {
    if (!FLY_FROMS.length) return;
    const targets = document.querySelectorAll('.table-row.me .card.mini.new');
    targets.forEach((el) => {
      const f = FLY_FROMS.length > 1 ? FLY_FROMS.shift() : FLY_FROMS[0];
      const r = el.getBoundingClientRect();
      const dx = f.x - (r.left + r.width / 2);
      const dy = f.y - (r.top + r.height / 2);
      el.classList.add('fly'); // CSS の popIn を無効化して JS で動かす
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1)';
          el.style.transform = 'translate(0, 0)';
        });
      });
      el.addEventListener('transitionend', function h(e) {
        if (e.propertyName !== 'transform') return;
        el.style.transition = '';
        el.style.transform = '';
        el.removeEventListener('transitionend', h);
      });
    });
    FLY_FROMS = [];
  }

  function renderBanner() {
    const el = $('banner');
    // ゲーム終了: 最終結果バナー（スコアテーブル廃止に伴いここで表示）
    if (STATE.phase === 'over' && !STATE.roundBanner) {
      if (FINAL_CLOSED) { el.classList.add('hidden'); return; }
      // 順位と同点処理は Engine 側の定義（合計点 → デザート枚数 → 同率）に従う
      const ranked = Engine.finalRanking(STATE);
      const rankCounts = new Map();
      ranked.forEach((r) => rankCounts.set(r.rank, (rankCounts.get(r.rank) || 0) + 1));
      const rows = ranked
        .map((r) => {
          const p = STATE.players[r.pi];
          const rounds = p.roundScores
            .map((v, i) => `R${i + 1} ${v >= 0 ? '+' : ''}${v}`)
            .join(' / ');
          const ge = Engine.gameEndBreakdown(STATE, r.pi);
          const geTotal = ge.reduce((a, x) => a + x.pts, 0);
          const geList = ge
            .map((x) => `<span class="bp-extra">${x.label} <b>${x.pts >= 0 ? '+' : ''}${x.pts}</b></span>`)
            .join('');
          const desserts = p.desserts
            .map((d) => cardEl(d.key, null, 'mini banner-card').outerHTML)
            .join('');
          return `<div class="bp${r.pi === 0 ? ' banner-me' : ''}">
            <div class="bp-head"><span>${r.rank}位${rankCounts.get(r.rank) > 1 ? '（同率）' : ''} ${r.pi === 0 ? 'あなた' : ''}${r.name}</span><span class="bp-total">${r.total}点</span></div>
            <div class="bp-sub">デザート${r.desserts}枚 ／ ${rounds} ／ ゲーム末 ${geTotal >= 0 ? '+' : ''}${geTotal}</div>
            ${geList ? `<div class="bp-extras">${geList}</div>` : ''}
            ${desserts ? `<div class="bp-cards">${desserts}</div>` : ''}
          </div>`;
        })
        .join('');
      const actions = `<div class="banner-actions">
        ${ONLINE ? '' : '<button data-act="again">もう一度遊ぶ</button>'}
        <button class="secondary" data-act="lobby">ロビーへ戻る</button>
        <button class="secondary" data-act="close">結果を閉じる</button>
      </div>`;
      el.innerHTML = `<h2>宴会が幕を閉じた</h2><div class="banner-players">${rows}</div>${actions}<p class="banner-note">同点はデザート枚数で判定 ・ クリックで閉じる</p>`;
      el.classList.remove('hidden');
      el.onclick = (ev) => {
        if (ev.target.closest('button')) return;
        FINAL_CLOSED = true;
        renderAll();
      };
      el.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'again') { startGame(); return; }
          if (act === 'lobby') { backToLobby(); return; }
          FINAL_CLOSED = true;
          renderAll();
        });
      });
      return;
    }
    if (!STATE.roundBanner) { el.classList.add('hidden'); return; }
    const b = STATE.roundBanner;
    const rows = b.results
      .sort((a, x) => x.points - a.points)
      .map((r) => {
        const cards = (r.cards || [])
          .map((c) =>
            cardEl(
              c.key,
              c.icons > 1 ? c.icons : null,
              'mini banner-card',
              { flipped: c.flipped, discarded: c.discarded },
              c.pts ? c.pts : null,
            ).outerHTML,
          )
          .join('');
        // 取得点数一覧: カード種別ごとに合算し、点が動いたものだけ並べる。
        // アリスのように「カードとしては 1 種・手元では複数種」のカードは 1 行にまとめる
        const byKey = new Map();
        for (const c of r.cards || []) {
          const d = defOf(c.key);
          const id = d && d.group ? `group:${d.group}` : c.key;
          const e = byKey.get(id) || { key: c.key, def: d, count: 0, icons: 0, pts: 0, types: new Set(), flags: new Set() };
          e.count += 1;
          e.icons += c.icons || 1;
          e.pts += c.pts || 0;
          e.types.add(c.key);
          if (c.discarded) e.flags.add('破棄');
          if (c.flipped) e.flags.add('裏返し');
          byKey.set(id, e);
        }
        const pointRows = [];
        for (const e of byKey.values()) {
          if (!e.pts) continue;
          const def = e.def || defOf(e.key);
          const cnt = e.count > 1 ? `（${e.count}枚）` : '';
          const icons = e.icons > e.count ? `（${e.icons}個）` : '';
          const flag = e.flags.size ? `・${[...e.flags].join('・')}` : '';
          const label = def && def.group
            ? `${def.name}（${e.types.size}種・${e.count}枚）${flag}`
            : `${def ? def.name : e.key}${cnt}${icons}${flag}`;
          pointRows.push(`<div class="bp-point"><span>${label}</span><b>${e.pts >= 0 ? '+' : ''}${e.pts}</b></div>`);
        }
        for (const e of r.extras || []) {
          if (!e.pts) continue;
          pointRows.push(`<div class="bp-point"><span>${e.label}</span><b>${e.pts >= 0 ? '+' : ''}${e.pts}</b></div>`);
        }
        if (!pointRows.length) pointRows.push('<div class="bp-point"><span>なし</span><b>+0</b></div>');
        pointRows.push(`<div class="bp-point bp-point-total"><span>合計</span><b>${r.points >= 0 ? '+' : ''}${r.points}</b></div>`);
        return `<div class="bp${r.pi === 0 ? ' banner-me' : ''}">
          <div class="bp-head"><span>${r.pi === 0 ? 'あなた' : r.name}</span><span class="bp-total">${r.points >= 0 ? '+' : ''}${r.points}点</span></div>
          <div class="bp-body">
            <div class="bp-col">
              <div class="bp-col-title">取得カード</div>
              <div class="bp-cards">${cards || '<span class="bp-empty">なし</span>'}</div>
            </div>
            <div class="bp-col bp-col-points">
              <div class="bp-col-title">取得点数</div>
              ${pointRows.join('')}
            </div>
          </div>
        </div>`;
      })
      .join('');
    el.innerHTML = `<h2>ラウンド ${b.round + 1} 結果</h2><div class="banner-players">${rows}</div><p class="banner-note">${ONLINE ? 'クリックで次へ（全員の準備を待っています）' : 'カードをクリックで次のラウンド開始'}</p>`;
    el.classList.remove('hidden');
    el.onclick = () => {
      if (ONLINE) { Net.continueRound(); return; }
      STATE.roundBanner = null; DEAL_ANIM = true; renderAll(); // 次ラウンドの配りアニメ
    };
  }

  // 異変カード一覧モーダル（現在のセットの全カード・説明・構成枚数）
  function toggleCardRef() {
    const el = $('cardref');
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
    el.innerHTML = '';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'secondary ref-close';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', toggleCardRef);
    el.appendChild(closeBtn);

    const h2 = document.createElement('h2');
    h2.textContent = `異変「${STATE.incidentName}」・${STATE.incidentSubtitle}`;
    el.appendChild(h2);

    // メイン → 乱入者 → デザート の順に種別ごと表示
    const allKeys = Object.keys(STATE.cardMap);
    const groups = [
      { title: 'メインカード', keys: allKeys.filter((k) => k !== STATE.dessert.key && k !== STATE.intruderKey) },
      { title: '乱入者', keys: STATE.intruderKey ? [STATE.intruderKey] : [] },
      { title: 'デザート', keys: [STATE.dessert.key] },
    ];
    for (const g of groups) {
      if (!g.keys.length) continue;
      const h3 = document.createElement('h3');
      h3.textContent = g.title;
      el.appendChild(h3);
      const grid = document.createElement('div');
      grid.className = 'ref-grid';
      // アリスは 4 種で「1 枚のカード」なので 1 件にまとめて表示する
      const emitted = new Set();
      for (const key of g.keys) {
        const def = STATE.cardMap[key];
        if (def.group) {
          if (emitted.has(def.group)) continue;
          emitted.add(def.group);
        }
        const variants = def.group ? g.keys.map((k) => STATE.cardMap[k]).filter((d) => d.group === def.group) : [def];
        const n = variants.reduce((sum, d) => sum + ((STATE.initialCounts && STATE.initialCounts[d.key]) || 0), 0);
        // ミニカード + 横に完全な説明文（カード面に長文を詰め込まない）
        const item = document.createElement('div');
        item.className = 'ref-item' + (variants.length > 1 ? ' ref-item-wide' : '');
        const minis = document.createElement('div');
        minis.className = 'ref-minis';
        for (const d of variants) minis.appendChild(cardEl(d.key, null, 'mini'));
        item.appendChild(minis);
        const txt = document.createElement('div');
        txt.className = 'ref-text';
        const kind = countIconKind(def);
        const compo = kind && def.iconCounts
          ? `<div class="ref-compo">${Object.entries(def.iconCounts).map(([c, num]) => `<span class="ref-compo-item">${COUNT_ICON_SVG[kind].repeat(Number(c))}<span>×${num}</span></span>`).join('')}</div>`
          : '';
        const variantsHtml = variants.length > 1
          ? `<div class="ref-variants">${variants.map((d) => `<span>${d.variant || d.name}</span>`).join('')}</div>`
          : '';
        txt.innerHTML = `<div class="ref-name">${def.name}<span class="ref-count">×${n}${variants.length > 1 ? `（${variants.length}種）` : ''}</span></div>${variantsHtml}${compo}<div class="ref-desc">${descOf(def)}</div>`;
        item.appendChild(txt);
        grid.appendChild(item);
      }
      el.appendChild(grid);
    }
    el.classList.remove('hidden');
  }

  // 右パネル: いま選んでいる（またはホバー中の）カードを拡大表示する
  let PREVIEW = null;

  function renderPreview() {
    const el = $('preview');
    if (!el) return;
    let target = PREVIEW;
    if (!target && STATE && STATE.phase === 'pick' && PICK_SELECTED !== null) {
      const c = STATE.players[0].hand[PICK_SELECTED];
      if (c) target = { key: c.key, icons: c.icons };
    }
    if (!target && STATE && CHOP_SELECTED.length) {
      const c = STATE.players[0].hand[CHOP_SELECTED[CHOP_SELECTED.length - 1]];
      if (c) target = { key: c.key, icons: c.icons };
    }
    if (!target) {
      el.innerHTML = '<div class="preview-empty">カードを選ぶと<br>ここに大きく表示されます</div>';
      return;
    }
    const def = defOf(target.key);
    if (!def) { el.innerHTML = ''; return; }
    const kind = countIconKind(def);
    const icons = Number(target.icons) || 0;
    const iconHtml = kind && icons
      ? `<div class="preview-icons">${COUNT_ICON_SVG[kind].repeat(icons)}<span>×${icons}</span></div>`
      : '';
    const tags = [];
    if (target.inst && target.inst.discarded) tags.push('破棄');
    if (target.inst && target.inst.flipped) tags.push('裏返し（2点）');
    if (target.inst && target.inst.copied) tags.push('慧音のコピー');
    el.innerHTML = `
      <div class="preview-card"><img src="assets/cards/${def.key}.webp" alt="" onerror="this.parentElement.classList.add('no-art')"></div>
      <div class="preview-name">${cardLabel(def)}${tags.length ? `<span class="preview-tag">${tags.join('・')}</span>` : ''}</div>
      ${iconHtml}
      <div class="preview-desc">${descOf(def)}</div>`;
  }

  function renderAll() {
    autoSkipIfEmpty();
    renderRound();
    renderHand();
    renderPlayerBar();
    renderTableRows();
    renderSelectArea(); // table-rows 再構築の後に呼び、あなたの行にオーバーレイを重ねる
    renderBanner();
    renderPreview();
    updateTimerIndicator();
  }

  // ---- 対戦（サーバー権威） ----

  function randomRoomCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  }

  function lobbyName() {
    return $('input-name').value.trim() || '幹事';
  }

  function createRoom() {
    Net.join(randomRoomCode(), lobbyName());
  }

  function joinRoom() {
    const code = $('input-code').value.trim().toUpperCase();
    if (!code) { $('input-code').focus(); return; }
    Net.join(code, lobbyName());
  }

  function showOnlineLobby(lobby) {
    ONLINE = true;
    $('online-lobby').classList.remove('hidden');
    $('mp-entry').classList.add('hidden');
    $('btn-start').classList.add('hidden'); // 対戦中はホットシート開始ボタンを隠す
    $('mode-select').classList.add('hidden');
    $('solo-panel').classList.add('hidden');
    $('mp-entry').classList.add('hidden');
    $('online-code').textContent = lobby.roomCode;
    $('online-players').innerHTML = lobby.players
      .map((p) => `<div class="online-player${p.seat === MY_SEAT ? ' me' : ''}">${p.isHost ? '★' : ''}${p.name}${p.connected ? '' : ' <span class="off">（切断）</span>'}</div>`)
      .join('');
    const me = lobby.players.find((p) => p.seat === MY_SEAT);
    const isHostMe = !!(me && me.isHost);
    $('btn-online-start').classList.toggle('hidden', !isHostMe);
    // ルーム設定（ホストのみ変更可）
    const settings = lobby.settings || {};
    $('setting-incident').value = settings.incident || '';
    $('setting-timer').value = String(settings.timerSeconds !== undefined ? settings.timerSeconds : 60);
    $('setting-incident').disabled = !isHostMe || lobby.started;
    $('setting-timer').disabled = !isHostMe || lobby.started;
    $('setting-hint').textContent = isHostMe
      ? 'ルームマスターとして変更できます'
      : 'ルームマスターのみ変更できます';
    $('online-hint').textContent = lobby.started
      ? 'ゲーム開始…'
      : `${lobby.players.length}/${lobby.maxPlayers}人（${lobby.minPlayers}人以上で開始）`;
  }

  function buildSettingOptions() {
    const sel = $('setting-incident');
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'おまかせ';
    sel.appendChild(auto);
    for (const id of Data.INCIDENT_IDS) {
      const inc = Data.incidentById(id);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = inc.name;
      sel.appendChild(o);
    }
  }

  function sendSettings() {
    Net.setSettings({
      timerSeconds: Number($('setting-timer').value),
      incident: $('setting-incident').value,
    });
  }

  function updateTimerIndicator() {
    const el = $('timer-indicator');
    if (!el) return;
    if (!ONLINE || !STATE || !STATE.deadline) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((STATE.deadline - Date.now()) / 1000));
    el.classList.remove('hidden');
    el.textContent = `残り ${left}秒`;
  }

  function init() {
    $('btn-start').addEventListener('click', startGame);
    $('input-name').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!$('solo-panel').classList.contains('hidden')) startGame();
      else if (!$('mp-entry').classList.contains('hidden')) joinRoom();
    });
    $('btn-chopsticks').addEventListener('click', toggleChopsticks);
    $('btn-confirm-pick').addEventListener('click', confirmPick);
    $('btn-cardref').addEventListener('click', toggleCardRef);
    $('btn-create').addEventListener('click', createRoom);
    $('btn-join').addEventListener('click', joinRoom);
    $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    $('btn-online-start').addEventListener('click', () => Net.start());
    $('setting-incident').addEventListener('change', sendSettings);
    $('setting-timer').addEventListener('change', sendSettings);
    $('btn-mode-solo').addEventListener('click', () => showMode('solo'));
    $('btn-mode-online').addEventListener('click', () => showMode('online'));
    $('btn-solo-back').addEventListener('click', showModeSelect);
    $('btn-mp-back').addEventListener('click', showModeSelect);
    buildSoloIncidentOptions();
    buildSettingOptions();
    setInterval(updateTimerIndicator, 500);
  }

  // サーバーからの通知（net.js 経由）
  window.App = {
    onJoined(msg) {
      ONLINE = true;
      MY_SEAT = msg.seat;
      $('mp-entry').classList.add('hidden');
      $('online-lobby').classList.remove('hidden');
      if (msg.reconnected) {
        const hint = $('online-hint');
        if (hint) hint.textContent = '再接続しました';
      }
    },
    onLobby(lobby) {
      showOnlineLobby(lobby);
    },
    onState(view) {
      const hadBanner = !!(STATE && STATE.roundBanner);
      STATE = view;
      if (hadBanner && !view.roundBanner) DEAL_ANIM = true;
      if (view.picks && view.picks[0]) {
        PICK_SELECTED = null;
        CHOP_SELECTED = [];
        CHOPSTICKS_MODE = false;
      }
      $('lobby').classList.add('hidden');
      $('app').classList.remove('hidden');
      renderAll();
    },
    onGameOver() { /* 最終バナーは renderBanner が担当 */ },
    onStatus(text) {
      const hint = $('online-hint');
      if (hint) hint.textContent = text;
    },
    onError(message) {
      const hint = $('online-hint');
      if (hint && !$('online-lobby').classList.contains('hidden')) hint.textContent = message;
      else alert(message);
    },
    onDisconnect() {
      if (!ONLINE) return;
      const st = $('hand-status');
      if (st) st.textContent = '接続が切れたよ。自動で再接続しています…';
    },
    onConnected() {},
  };

  document.addEventListener('DOMContentLoaded', init);

  // デバッグ・テスト用に公開（Game.state でヘッドレスエンジンの state を直接参照できる）
  window.Game = { startGame, renderAll, get state() { return STATE; } };
})();


