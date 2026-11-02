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

  function startGame() {
    const name = $('input-name').value.trim() || '幹事';
    STATE = Engine.newGame(4, [name, '萃香', '魔理沙', 'にとり']);
    CHOPSTICKS_MODE = false;
    CHOP_SELECTED = [];
    SEL_MODE = null;
    SEL_SELECTED = [];
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

  function renderPlayers() {
    const wrap = $('players');
    wrap.innerHTML = '';
    STATE.players.forEach((p, pi) => {
      const counts = Engine.countKeys(p.taken);
      const badges = Object.entries(counts)
        .map(([key, n]) => {
          const def = defOf(key);
          if (!def) return '';
          return `<span class="badge" style="background:${def.color}">${def.icon}×${n}</span>`;
        })
        .join('');
      const dessertCount = p.desserts.length;
      const dessertBadge = dessertCount > 0 ? `<span class="badge dessert-badge">デザート×${dessertCount}</span>` : '';
      const chopBadge = p.chopsticks > 0 ? `<span class="badge chop-badge">早×${p.chopsticks}</span>` : '';
      const picked = STATE.picks[pi] !== null;
      const el = document.createElement('div');
      el.className = `player-panel${pi === 0 ? ' me' : ''}${picked ? ' picked' : ''}`;
      el.innerHTML = `
        <div class="player-head">
          <span class="player-name">${pi === 0 ? 'あなた' : ''}${p.name}</span>
          <span class="player-score">${Engine.scorePlayer(STATE, pi)}点</span>
        </div>
        <div class="player-badges">${badges}${dessertBadge}${chopBadge}${picked ? '<span class="badge pick-flag">選択済み</span>' : ''}</div>`;
      wrap.appendChild(el);
    });
  }

  function renderScore() {
    const el = $('score-panel');
    if (STATE.phase !== 'over') {
      const rows = STATE.players
        .map((p, pi) => {
          const rs = p.roundScores;
          return `<tr><td>${pi === 0 ? 'あなた' : ''}${p.name}</td><td>${rs[0]}</td><td>${rs[1]}</td><td>${rs[2]}</td><td><b>${Engine.scorePlayer(STATE, pi)}</b></td></tr>`;
        })
        .join('');
      el.innerHTML = `
        <h3>スコア</h3>
        <table class="score-table">
          <tr><th>幹事</th><th>R1</th><th>R2</th><th>R3</th><th>合計</th></tr>
          ${rows}
        </table>`;
      return;
    }
    const ranked = STATE.players
      .map((p, pi) => ({ pi, name: p.name, total: Engine.scorePlayer(STATE, pi), dessert: p.desserts.length }))
      .sort((a, b) => b.total - a.total || b.dessert - a.dessert);
    const rows = ranked
      .map((r, i) => `<tr class="${r.pi === 0 ? 'me' : ''}"><td>${i + 1}位</td><td>${r.pi === 0 ? 'あなた' : ''}${r.name}</td><td>${r.total}点</td><td>デザート${r.dessert}</td></tr>`)
      .join('');
    el.innerHTML = `
      <h3>最終結果</h3>
      <table class="score-table">
        <tr><th>順位</th><th>幹事</th><th>合計</th><th>デザート</th></tr>
        ${rows}
      </table>`;
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

  function renderBanner() {
    const el = $('banner');
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

  function renderLog() {
    const el = $('log');
    el.innerHTML = STATE.log.slice(-30).reverse().map((l) => `<div class="log-line">R${l.round + 1} ${l.text}</div>`).join('');
  }

  function renderAll() {
    autoSkipIfEmpty();
    renderRound();
    renderHand();
    renderSelectArea();
    renderPlayers();
    renderScore();
    renderBanner();
    renderLog();
  }

  function init() {
    $('btn-start').addEventListener('click', startGame);
    $('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });
    $('btn-chopsticks').addEventListener('click', toggleChopsticks);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { startGame, renderAll, get state() { return STATE; } };
})();
