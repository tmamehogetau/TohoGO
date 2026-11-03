'use strict';

// ホットシート UI。seat0 = 人間、seat1..3 = AI。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  let STATE = null;
  let CHOPSTICKS_MODE = false;
  let CHOP_SELECTED = []; // pick2 モード中の選択 idx
  let PICK_SELECTED = null; // 通常ピックで選択中の idx（決定ボタンで確定）
  let SEL_MODE = null;    // 取得時選択: 'discard' | 'flip' | 'copy' | null
  let SEL_SELECTED = [];  // flip モード中の選択 idx

  const $ = (id) => document.getElementById(id);

  let SEL_INCIDENT = ''; // '' = おまかせ（ランダム抽選）

  // ロビーの異変選択 UI（data.js の INCIDENTS から動的生成）
  function incidentOption(id, title, desc) {
    const el = document.createElement('div');
    el.className = `incident-option${id === SEL_INCIDENT ? ' selected' : ''}`;
    el.innerHTML = `<div class="opt-title">${title}</div><div class="opt-desc">${desc}</div>`;
    el.addEventListener('click', () => { SEL_INCIDENT = id; buildIncidentPicker(); });
    return el;
  }

  function buildIncidentPicker() {
    const wrap = $('incident-picker');
    wrap.innerHTML = '';
    wrap.appendChild(incidentOption('', 'おまかせ', '異変はゲーム開始時にランダムで決まる'));
    for (const id of Data.INCIDENT_IDS) {
      const inc = Data.incidentById(id);
      const extra = inc.intruders ? '（乱入者はランダムで 1 種参加）' : '';
      wrap.appendChild(incidentOption(id, inc.name, `${inc.subtitle}／${inc.theme}${extra}`));
    }
  }

  function startGame() {
    const name = $('input-name').value.trim() || '幹事';
    const opts = SEL_INCIDENT ? { incident: SEL_INCIDENT } : {};
    STATE = Engine.newGame(4, [name, '萃香', '魔理沙', 'にとり'], opts);
    CHOPSTICKS_MODE = false;
    CHOP_SELECTED = [];
    PICK_SELECTED = null;
    SEL_MODE = null;
    SEL_SELECTED = [];
    FINAL_CLOSED = false;
    $('lobby').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderAll();
  }

  // カード定義は state.cardMap から引く（異変ごとにキャラが変わるため）
  function defOf(key) {
    return STATE.cardMap[key];
  }

  function nameOf(key) {
    const d = STATE.cardMap[key];
    return d ? d.name : key;
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
        if (def.intruderPenalty) parts.push(`乱入者が誰かに取られると -${def.intruderPenalty} 点`);
        return parts.join('／');
      }
      case 'maki': return `このアイコンの合計を競う・最多 ${MAKI.first} 点／2 位 ${MAKI.second} 点`;
      case 'temaki': return `この枚数を競う・最多 +${def.most}／最少 ${def.least} 点`;
      case 'springMost': return `ラウンド末・春の獲得数が全員最多なら +${def.most} 点（このカードの所持が条件）`;
      case 'springSteal': return `取った瞬間・全員の春を ${def.steal} 個ずつ奪って自分の春にする`;
      case 'pair': return `2 枚で 1 ペア = ${def.points} 点`;
      case 'set3': return `3 枚で 1 セット = ${def.points} 点`;
      case 'collect': return `1/2/3/4/5+ 枚で ${def.table.join('/')} 点`;
      case 'roundComboCount': return `このラウンドに自分がデザートを取るたび +${def.per} 点`;
      case 'tofu': return `1 枚 ${def.table[0]} 点・2 枚 ${def.table[1]} 点・3 枚以上 0 点`;
      case 'kindCount': return `ラウンド末・「取ったカードの種類数 ${def.offset >= 0 ? '+' : ''}${def.offset}」点`;
      case 'letty': return `ラウンド末・(自分の冬の枚数 − 自分の春の個数) × ${def.mult} 点`;
      case 'coop': return `ラウンド末・自分以外が出したリグル 1 枚につき +1 点`;
      case 'flip': return `取得時・手元のカード 1 枚を裏返せる（判定から外れて 2 点）`;
      case 'copy': return `取得時・手元の他のカード 1 枚の効果をコピー`;
      case 'deckPeek': return `ラウンド末・山札の上 ${def.peek} 枚から 1 枚獲得`;
      case 'collectByTwo': return `ゲーム末・2 枚ごとに ${def.per2} 点・4 枚以上で +${def.bonusAt4}`;
      case 'parity': return `ゲーム末・偶数枚なら 2 枚ごとに ${def.per2Even} 点／奇数なら ${def.per2Odd} 点`;
      case 'dessertLeast': return `ゲーム末・このデザートの枚数が最少なら ${def.least} 点`;
      case 'dessertIce': return `ゲーム末・${def.per} 枚ごとに +${def.points} 点`;
      case 'dessertRound': return `ラウンド末・最多保有で +${def.roundMost} 点／ゲーム末に最多で ${def.finalLeast} 点`;
      default: return '';
    }
  }

  // カード面に載せる短縮版（全文はツールチップ・カード一覧で見れる）
  function shortDesc(def) {
    const full = descOf(def);
    if (full.length <= 30) return full;
    const parts = full.split('／');
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if ((out + '／' + parts[i]).length > 30) break;
      out += '／' + parts[i];
    }
    return out.length > 30 ? out.slice(0, 28) + '…' : out;
  }

  // ---- 人間の入力 ----

  // クリックは選択のトグルのみ。確定は決定ボタン（confirmPick）で行う（ミスクリック防止）
  function onHandClick(idx) {
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0] !== null) return;
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
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0] !== null) return;
    const p = STATE.players[0];

    if (CHOPSTICKS_MODE && p.chopsticks > 0) {
      if (CHOP_SELECTED.length !== 2) return;
      CHOP_SELECTED.forEach((i) => flyFromIdx(i));
      Engine.dispatch(STATE, { kind: 'pick2', pi: 0, idxs: [...CHOP_SELECTED].sort((a, b) => a - b) });
      CHOP_SELECTED = [];
      afterHumanPick();
      return;
    }

    if (PICK_SELECTED === null) return;
    flyFromIdx(PICK_SELECTED);
    const res = Engine.dispatch(STATE, { kind: 'pick', pi: 0, idx: PICK_SELECTED });
    if (!res.ok) { FLY_FROMS.pop(); alert(res.error); return; }
    PICK_SELECTED = null;
    afterHumanPick();
  }

  function toggleChopsticks() {
    const p = STATE.players[0];
    if (p.chopsticks <= 0) return;
    CHOPSTICKS_MODE = !CHOPSTICKS_MODE;
    CHOP_SELECTED = [];
    renderAll();
  }

  function runAiPicks() {
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
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0] !== null) return;
    if (STATE.players[0].hand.length !== 0) return;
    const res = Engine.dispatch(STATE, { kind: 'skip', pi: 0 });
    if (res.ok) runAiPicks();
  }

  function runAiSelections() {
    if (STATE.phase !== 'select') return;
    for (const pi of STATE.selectNeeded) {
      if (pi === 0) continue; // 人間の選択は select UI に委ねる（{} で自動解決しない）
      if (STATE.selections[pi] === null) {
        Engine.dispatch(STATE, { kind: 'choose', pi, choice: {} });
      }
    }
  }

  function afterHumanPick() {
    runAiPicks();
    runAiSelections();
    CHOPSTICKS_MODE = false;
    renderAll();
    flyNewCards();
  }

  // ---- 取得時選択（select フェーズ）の入力 ----

  function humanSelectNeeded() {
    // エンジンの selectionNeeded と同じ判定を UI 側で行う
    const p = STATE.players[0];
    const need = { discard: false, flip: false, copy: false };
    for (const inst of p.taken) {
      const def = defOf(inst.key);
      if (!def || inst.selectionDone) continue;
      if (def.kind === 'instant' && def.discardBonus) need.discard = true;
      if (def.kind === 'flip') need.flip = true;
      if (def.kind === 'copy') need.copy = true;
    }
    return need;
  }

  function enterSelectMode() {
    const need = humanSelectNeeded();
    if (need.discard) SEL_MODE = 'discard';
    else if (need.copy) SEL_MODE = 'copy';
    else if (need.flip) SEL_MODE = 'flip';
    else SEL_MODE = null;
    SEL_SELECTED = [];
    return SEL_MODE;
  }

  function onTakenClick(idx) {
    if (!STATE || STATE.phase !== 'select') return;
    if (!SEL_MODE) return;
    // flip も 1 枚制限なので discard / copy と同じ単一選択トグル（確定は決定ボタン）
    if (SEL_SELECTED.includes(idx)) SEL_SELECTED = [];
    else SEL_SELECTED = [idx];
    renderAll();
  }

  // select フェーズの決定ボタン（flip は 0 枚でも確定可・discard/copy は 1 枚選択が条件）
  function confirmSelect() {
    if (!STATE || STATE.phase !== 'select') return;
    if (SEL_MODE === 'discard') {
      if (SEL_SELECTED.length !== 1) return;
      Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { discard: SEL_SELECTED[0] } });
    } else if (SEL_MODE === 'copy') {
      if (SEL_SELECTED.length !== 1) return;
      Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { copy: SEL_SELECTED[0] } });
    } else if (SEL_MODE === 'flip') {
      Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { flip: [...SEL_SELECTED] } });
    } else {
      return;
    }
    SEL_MODE = null;
    SEL_SELECTED = [];
    runAiSelections();
    renderAll();
  }

  function skipSelection() {
    if (!STATE || STATE.phase !== 'select') return;
    Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: SEL_MODE === 'flip' ? { flip: [] } : {} });
    SEL_MODE = null;
    SEL_SELECTED = [];
    runAiSelections();
    renderAll();
  }

  // ---- 描画 ----

  function cardEl(key, icons, extra) {
    const def = defOf(key);
    const el = document.createElement('div');
    el.className = `card${extra ? ' ' + extra : ''}`;
    el.style.background = def.color;
    const iconText = icons ? `${def.icon}<span class="card-icons">×${icons}</span>` : def.icon;
    el.innerHTML = `
      <div class="card-icon">${iconText}</div>
      <div class="card-name">${def.name}</div>
      <div class="card-desc">${shortDesc(def)}</div>`;
    el.title = `${def.name}：${descOf(def)}`;
    return el;
  }

  function renderHand() {
    const handEl = $('hand');
    handEl.innerHTML = '';
    const p = STATE.players[0];
    const myTurn = STATE.phase === 'pick' && STATE.picks[0] === null;
    const selectTurn = STATE.phase === 'select' && STATE.selectNeeded.includes(0);

    const statusEl = $('hand-status');
    if (STATE.phase === 'over') {
      statusEl.textContent = '宴会終了！';
    } else if (STATE.phase === 'select') {
      statusEl.textContent = selectStatusText(selectTurn);
    } else if (STATE.picks[0] !== null) {
      statusEl.textContent = '他の幹事の選択を待っている…';
    } else if (CHOPSTICKS_MODE) {
      statusEl.textContent = `早飲みモード：2枚選んでね（${CHOP_SELECTED.length}/2 枚選択）`;
    } else if (PICK_SELECTED !== null && p.hand[PICK_SELECTED]) {
      statusEl.textContent = `「${defOf(p.hand[PICK_SELECTED].key).name}」を選択中。決定ボタンで確定`;
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
    if (SEL_MODE === 'flip') return SEL_SELECTED.length === 1
      ? '裏返すカードを選択中。決定ボタンで確定（選ばなければ効果なし）'
      : '裏返すカードを 1 枚選んでね（選ばなければ効果なし）';
    if (SEL_MODE === 'discard') return SEL_SELECTED.length === 1
      ? '破棄するカードを選択中。決定ボタンで確定'
      : '破棄するカードを 1 枚選んでね';
    if (SEL_MODE === 'copy') return SEL_SELECTED.length === 1
      ? 'コピーするカードを選択中。決定ボタンで確定'
      : 'コピーするカードを 1 枚選んでね';
    return '取得カードの効果を選択中…';
  }

  // select フェーズの UI（取得カードの選択）
  // スペースは常時確保（visibility 制御・レイアウトずれ防止）
  function renderSelectArea() {
    const areaEl = $('select-area');
    if (!STATE || STATE.phase !== 'select') {
      areaEl.innerHTML = '';
      areaEl.classList.remove('active');
      return;
    }
    const p = STATE.players[0];
    const selectTurn = STATE.selectNeeded.includes(0);

    if (!SEL_MODE && selectTurn) enterSelectMode();

    areaEl.classList.add('active');
    areaEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'select-title';
    title.textContent = selectStatusText(selectTurn);
    areaEl.appendChild(title);

    const list = document.createElement('div');
    list.className = 'select-list';
    p.taken.forEach((card, idx) => {
      const el = cardEl(card.key, card.icons, 'taken');
      const isSel = SEL_SELECTED.includes(idx);
      if (isSel) el.classList.add('selected');
      if (selectTurn) {
        el.classList.add('clickable');
        el.addEventListener('click', () => onTakenClick(idx));
      } else {
        el.classList.add('disabled');
      }
      list.appendChild(el);
    });
    areaEl.appendChild(list);

    const btnRow = document.createElement('div');
    btnRow.className = 'select-btn-row';
    if (SEL_MODE && selectTurn) {
      const confirmBtn = document.createElement('button');
      confirmBtn.disabled = SEL_MODE !== 'flip' && SEL_SELECTED.length !== 1;
      if (SEL_MODE === 'flip') {
        confirmBtn.textContent = 'このカードを裏返す';
      } else if (SEL_MODE === 'discard') {
        const bonus = (p.taken.map((inst) => defOf(inst.key)).find((d) => d.discardBonus) || {}).discardBonus || 2;
        confirmBtn.textContent = `このカードを破棄する（+${bonus} 点）`;
      } else if (SEL_MODE === 'copy') {
        confirmBtn.textContent = 'この効果をコピーする';
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
  function trackedTags(pi) {
    const p = STATE.players[pi];
    const tags = [];
    // 春雪: ラウンド統計の春アイコン合計（妖夢の吸収も反映済み）
    if (STATE.incidentId === 'spring' && STATE.roundStats) {
      tags.push({ label: `春 ${STATE.roundStats[pi].springIcons}`, color: '#d16a9e' });
    }
    // 多数決系カード（巻物=兎、妖精メイド等）のアイコン合計
    for (const def of Object.values(STATE.cardMap)) {
      if (def.kind !== 'maki' && def.kind !== 'temaki') continue;
      // 春雪では春の合計を上で既に表示するため重複を避ける
      if (STATE.incidentId === 'spring' && def.kind === 'maki') continue;
      let n = 0;
      for (const inst of p.taken) {
        if (inst.key === def.key && !inst.flipped) n += inst.icons || 1;
      }
      tags.push({ label: `${def.icon} ${n}`, color: def.color });
    }
    return tags;
  }

  // プレイヤーごとの「取ったカード」行（あなた → 他のプレイヤーの順）
  function renderTableRows() {
    const wrap = $('table-rows');
    wrap.innerHTML = '';
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
        tag.textContent = t.label;
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
        // 今ピック分だけ .new を付ける: taken 末尾から lastPicks の keys と照合
        const lp = STATE.lastPicks && STATE.lastPicks.find((x) => x.pi === pi);
        const keys = lp ? [...lp.keys] : [];
        const els = p.taken.map((inst) => cardEl(inst.key, inst.icons, 'mini'));
        for (let i = els.length - 1; i >= 0 && keys.length; i--) {
          const k = keys.indexOf(p.taken[i].key);
          if (k >= 0) { els[i].classList.add('new'); keys.splice(k, 1); }
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
      for (let i = dels.length - 1; i >= 0 && dkeys.length; i--) {
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
      const ranked = STATE.players
        .map((p, pi) => ({ pi, name: p.name, total: Engine.scorePlayer(STATE, pi), dessert: p.desserts.length }))
        .sort((a, b) => b.total - a.total || b.dessert - a.dessert);
      const rows = ranked
        .map((r, i) => `<div class="${r.pi === 0 ? 'banner-me' : ''}">${i + 1}位 ${r.pi === 0 ? 'あなた' : ''}${r.name}: ${r.total}点（デザート${r.dessert}）</div>`)
        .join('');
      el.innerHTML = `<h2>宴会が幕を閉じた</h2>${rows}<p class="banner-note">クリックで閉じる</p>`;
      el.classList.remove('hidden');
      el.onclick = () => { FINAL_CLOSED = true; renderAll(); };
      return;
    }
    if (!STATE.roundBanner) { el.classList.add('hidden'); return; }
    const b = STATE.roundBanner;
    const rows = b.results
      .sort((a, x) => x.points - a.points)
      .map((r) => `<div>${r.pi === 0 ? 'あなた' : ''}${r.name}: ${r.points >= 0 ? '+' : ''}${r.points}点</div>`)
      .join('');
    el.innerHTML = `<h2>ラウンド ${b.round + 1} 結果</h2>${rows}<p class="banner-note">カードをクリックで次のラウンド開始</p>`;
    el.classList.remove('hidden');
    el.onclick = () => { STATE.roundBanner = null; renderAll(); };
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
      for (const key of g.keys) {
        const def = STATE.cardMap[key];
        const n = (STATE.initialCounts && STATE.initialCounts[key]) || 0;
        // ミニカード + 横に完全な説明文（カード面に長文を詰め込まない）
        const item = document.createElement('div');
        item.className = 'ref-item';
        item.appendChild(cardEl(key, null, 'mini'));
        const txt = document.createElement('div');
        txt.className = 'ref-text';
        txt.innerHTML = `<div class="ref-name">${def.name}<span class="ref-count">×${n}</span></div><div class="ref-desc">${descOf(def)}</div>`;
        item.appendChild(txt);
        grid.appendChild(item);
      }
      el.appendChild(grid);
    }
    el.classList.remove('hidden');
  }

  function renderLog() {
    const el = $('log');
    el.innerHTML = STATE.log.slice(-30).reverse().map((l) => `<div class="log-line">R${l.round + 1} ${l.text}</div>`).join('');
  }

  function renderAll() {
    autoSkipIfEmpty();
    renderRound();
    renderHand();
    renderSelectArea();
    renderPlayerBar();
    renderTableRows();
    renderBanner();
    renderLog();
  }

  function init() {
    $('btn-start').addEventListener('click', startGame);
    $('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });
    $('btn-chopsticks').addEventListener('click', toggleChopsticks);
    $('btn-confirm-pick').addEventListener('click', confirmPick);
    $('btn-cardref').addEventListener('click', toggleCardRef);
    buildIncidentPicker();
  }

  document.addEventListener('DOMContentLoaded', init);

  // デバッグ・テスト用に公開（Game.state でヘッドレスエンジンの state を直接参照できる）
  window.Game = { startGame, renderAll, get state() { return STATE; } };
})();
