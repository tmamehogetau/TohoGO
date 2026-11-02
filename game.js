'use strict';

// ホットシート UI。seat0 = 人間、seat1..3 = AI。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  let STATE = null;
  let CHOPSTICKS_MODE = false;
  let CHOP_SELECTED = []; // pick2 モード中の選択 idx
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

  // kind から簡易説明テキストを生成（カード裏面の説明相当）
  function descOf(def) {
    switch (def.kind) {
      case 'instant':
        if (def.absentKeys) return '主と同席で 0 点・なければ 3 点';
        if (def.comboKeys) return '揃うとボーナス';
        if (def.hidden) return '出すと情報が隠れる';
        return `${def.points} 点`;
      case 'maki': return 'アイコン合計で順位競争';
      case 'temaki': return `最多 ${def.most} 点 / 最少 ${def.least} 点`;
      case 'springMost': return '春最多なら 4 点';
      case 'springSteal': return '全員の春を 1 個ずつ吸収';
      case 'pair': return '2 枚 1 セット = 5 点';
      case 'set3': return '3 枚 1 セット = 10 点';
      case 'collect': return '収集 1/3/6/10/15 点';
      case 'roundComboCount': return '今ラウンドの⑨ 1 枚ごとに 1 点';
      case 'tofu': return '1 枚 2 点 / 2 枚 6 点 / 3 枚以上 0 点';
      case 'kindCount': return '種類数 − 3 点';
      case 'letty': return '(冬枚数 − 春枚数) × 2 点';
      case 'coop': return '仲間のリグル 1 人につき 1 点';
      case 'flip': return '出したら裏返し対象を選べる';
      case 'copy': return '取得カードの効果をコピー';
      case 'deckPeek': return '山札 4 枚見て 1 枚獲得';
      case 'collectByTwo': return '2 枚ごとに 4 点・4 枚以上 +2';
      case 'parity': return '偶数なら 2 枚ごとに 6 点';
      case 'dessertLeast': return `ゲーム末・最少 ${def.least} 点`;
      case 'dessertIce': return `ゲーム末・${def.per} 枚ごとに ${def.points} 点`;
      case 'dessertRound': return '各ラウンド末・最多で判定';
      default: return '';
    }
  }

  // ---- 人間の入力 ----

  function onHandClick(idx) {
    if (!STATE || STATE.phase !== 'pick' || STATE.picks[0] !== null) return;
    const p = STATE.players[0];

    if (CHOPSTICKS_MODE && p.chopsticks > 0) {
      if (CHOP_SELECTED.includes(idx)) {
        CHOP_SELECTED = CHOP_SELECTED.filter((i) => i !== idx);
        renderAll();
        return;
      }
      CHOP_SELECTED.push(idx);
      if (CHOP_SELECTED.length === 2) {
        Engine.dispatch(STATE, { kind: 'pick2', pi: 0, idxs: [...CHOP_SELECTED].sort((a, b) => a - b) });
        CHOP_SELECTED = [];
        afterHumanPick();
      } else {
        renderAll();
      }
      return;
    }

    const res = Engine.dispatch(STATE, { kind: 'pick', pi: 0, idx });
    if (!res.ok) { alert(res.error); return; }
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
    if (SEL_MODE === 'discard') {
      // 破棄するカードを選択 → 即確定
      Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { discard: idx } });
      SEL_MODE = null;
      runAiSelections();
      renderAll();
      return;
    }
    if (SEL_MODE === 'copy') {
      // コピーするカードを選択 → 即確定
      Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { copy: idx } });
      SEL_MODE = null;
      runAiSelections();
      renderAll();
      return;
    }
    if (SEL_MODE === 'flip') {
      if (SEL_SELECTED.includes(idx)) {
        SEL_SELECTED = SEL_SELECTED.filter((i) => i !== idx);
      } else {
        SEL_SELECTED.push(idx);
      }
      renderAll();
    }
  }

  function confirmFlip() {
    if (SEL_MODE !== 'flip') return;
    Engine.dispatch(STATE, { kind: 'choose', pi: 0, choice: { flip: [...SEL_SELECTED] } });
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
      <div class="card-desc">${descOf(def)}</div>`;
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
    } else {
      statusEl.textContent = '手札から 1 枚選んで隣に回そう';
    }

    const chopBtn = $('btn-chopsticks');
    chopBtn.classList.toggle('hidden', !(myTurn && p.chopsticks > 0));
    chopBtn.classList.toggle('active', CHOPSTICKS_MODE);

    p.hand.forEach((card, idx) => {
      const el = cardEl(card.key, card.icons);
      const selected = CHOP_SELECTED.includes(idx);
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
    if (SEL_MODE === 'flip') return `裏返すカードを選んでね（${SEL_SELECTED.length} 枚選択・決定ボタンで確定）`;
    if (SEL_MODE === 'discard') return '破棄するカードを 1 枚選んでね';
    if (SEL_MODE === 'copy') return 'コピーするカードを 1 枚選んでね';
    return '取得カードの効果を選択中…';
  }

  // select フェーズの UI（取得カードの選択）
  function renderSelectArea() {
    const areaEl = $('select-area');
    if (!STATE || STATE.phase !== 'select') {
      areaEl.classList.add('hidden');
      return;
    }
    const p = STATE.players[0];
    const selectTurn = STATE.selectNeeded.includes(0);

    if (!SEL_MODE && selectTurn) enterSelectMode();

    areaEl.classList.remove('hidden');
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
    if (SEL_MODE === 'flip' && selectTurn) {
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = `裏返しを決定（${SEL_SELECTED.length} 枚）`;
      confirmBtn.addEventListener('click', confirmFlip);
      btnRow.appendChild(confirmBtn);
    }
    if (selectTurn) {
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
        const cell = cardEl(key, null, 'ref');
        const cnt = document.createElement('div');
        cnt.className = 'ref-count';
        cnt.textContent = `×${n}`;
        cell.appendChild(cnt);
        grid.appendChild(cell);
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
    $('btn-cardref').addEventListener('click', toggleCardRef);
    buildIncidentPicker();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { startGame, renderAll, get state() { return STATE; } };
})();
