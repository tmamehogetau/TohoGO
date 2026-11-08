'use strict';

// ホットシート UI。seat0 = 人間、seat1..3 = AI。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  let STATE = null;
  let CHOPSTICKS_MODE = false;
  let CHOP_SELECTED = []; // pick2 モード中の選択 idx
  let PICK_SELECTED = null; // 通常ピックで選択中の idx（決定ボタンで確定）
  let SEL_MODE = null;    // 取得時選択: 'discard' | 'flip' | 'copy' | 'peek' | 'scoop' | 'swapNamed' | null
  let SEL_SELECTED = [];  // flip モード中の選択 idx
  let SEL_NAMED = null;   // にとり: 指定したカード名
  let ROOM_CODE = null;   // 参加中のルームコード（ヘッダー表示・コピー用）
  let STAGED_CHOICE = null; // 段階選択中の確定済み choice（全モード揃ったら choose で送る）

  const $ = (id) => document.getElementById(id);

  // HTML 文字列に埋め込む値は必ずこれを通す（プレイヤー名など外部由来の文字列）
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  let ONLINE = false; // 対戦モード（サーバー権威）
  let MY_SEAT = 0;
  // サーバーから受け取った瞬間の単調時計。残り時間の表示はここからの経過で減らす
  // （サーバーとクライアントの時計がずれていても正しく数えられる）
  let VIEW_ANCHOR_AT = 0;

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
    $('online-lobby').classList.add('hidden');
  }

  // ステージ紋章（assets/ui/<id>.webp）。おまかせは紋章なし
  const STAGE_EMBLEM = {
    scarlet: 'assets/ui/stage_red.webp',
    spring: 'assets/ui/stage_hakugyoku.webp',
    eternal: 'assets/ui/stage_eientei.webp',
    mountain: 'assets/ui/stage_moriya.webp',
  };

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
    // 画像つきのステージ選択カード
    const wrap = $('stage-cards');
    if (!wrap) return;
    wrap.innerHTML = '';
    const cards = [{ id: '', name: 'おまかせ', subtitle: 'ランダム', emblem: null }].concat(
      Data.INCIDENT_IDS.map((id) => {
        const inc = Data.incidentById(id);
        return { id, name: inc.name, subtitle: inc.subtitle, emblem: STAGE_EMBLEM[id] || null };
      }),
    );
    for (const c of cards) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stage-card' + (sel.value === c.id ? ' selected' : '');
      btn.dataset.stage = c.id;
      btn.innerHTML = (c.emblem
        ? '<img class="stage-card-emblem" src="' + c.emblem + '" alt="">'
        : '<span class="stage-card-emblem stage-card-auto">✦</span>')
        + '<span class="stage-card-name">' + c.name + '</span>'
        + '<span class="stage-card-sub">' + c.subtitle + '</span>';
      btn.addEventListener('click', () => {
        sel.value = c.id;
        sel.dispatchEvent(new Event('change'));
        wrap.querySelectorAll('.stage-card').forEach((el) => el.classList.toggle('selected', el.dataset.stage === c.id));
      });
      wrap.appendChild(btn);
    }
  }

  // ソロのAI席名: 東方キャラからランダムに3人（プレイヤー名と重複しないように）
  const AI_NAME_POOL = [
    '霊夢', '魔理沙', '妖夢', '咲夜', 'レミリア', '紫', '幽々子', '輝夜', '永琳', 'てゐ',
    '早苗', '神奈子', '諏訪子', '萃香', '文', 'にとり', '椛', '雛', '穣子', '静葉',
  ];
  function aiSeatNames(count, exclude, cardNames) {
    const pool = AI_NAME_POOL.filter((n) => n !== exclude
      && !(cardNames || []).some((cn) => cn && cn.includes(n)));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  function startGame() {
    const name = $('input-name').value.trim() || 'あなた';
    // おまかせのときは先にステージを決めて、席名がカード名と被らないようにする
    const incident = $('solo-incident').value
      || Data.INCIDENT_IDS[Math.floor(Math.random() * Data.INCIDENT_IDS.length)];
    const inc = Data.incidentById(incident);
    const cardNames = inc
      ? inc.main.map((c) => c.name).concat([inc.dessert.name], (inc.intruders || []).map((c) => c.name))
      : [];
    ONLINE = false;
    STATE = Engine.newGame(4, [name].concat(aiSeatNames(3, name, cardNames)), { incident });
    CHOPSTICKS_MODE = false;
    CHOP_SELECTED = [];
    PICK_SELECTED = null;
    SEL_MODE = null;
    SEL_SELECTED = [];
    FINAL_CLOSED = false;
    DEAL_ANIM = true; // 初回配りアニメ
    SHOWN_ROUND = -1; // 開始アニメをラウンド 1 から出し直す
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
    delete document.body.dataset.stage;
    $('app').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    showModeSelect();
  }

  // カード定義は state.cardMap から引く（ステージごとにキャラが変わるため）
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

  // kind から説明テキストを生成（表記ルール: 数値と単位の間は半角スペース／条件の区切りは「／」／
  // タイミングは「取得時・」「ラウンド末・」「ゲーム末・」「ラウンド中・」で始める）
  function descOf(def) {
    if (def && def.text && def.text.detail) return def.text.detail;
    const MAKI = Data.RULES.MAKI_POINTS;
    switch (def.kind) {
      case 'instant': {
        const parts = [`${def.points} 点`];
        if (def.buffTargets) parts.push(`取得後、次に${def.buffTargets.map(nameOf).join('か')}を取ると 点数 3 倍（1 回につき 1 回）`);
        if (def.absentKeys) parts.push(def.absentKeys.includes(def.key)
          ? '他の人も同じ手番に同じ札を取ると 0 点（単独なら満点）'
          : `誰かが同時に${def.absentKeys.map(nameOf).join('か')}を取ると 0 点`);
        if (def.comboKeys) parts.push(def.comboAtEnd
          ? `ラウンド末・${def.comboKeys.map(nameOf).join('・')}も手元なら +${def.comboBonus} 点`
          : `取った瞬間・${def.comboKeys.map(nameOf).join('・')}も手元なら +${def.comboBonus} 点`);
        if (def.discardBonus) parts.push(`取得時・手元の 1 枚を山札へ戻すと +${def.discardBonus} 点`);
        if (def.zeroIfTaken) parts.push(`同じ手番に${nameOf(def.zeroIfTaken)}を取った人がいると 0 点`);
        if (def.pointsIfPicked) parts.push(`同じ手番に誰か（自分含む）が${nameOf(def.pointsIfPicked.key)}を取っていれば +${def.pointsIfPicked.bonus} 点`);
        if (def.swap) parts.push('取得時・手元のカード 1 枚を山札と交換できる（山札の上から 1 枚引く）');
        if (def.hidden) {
          parts.push('取った手番・他の全員の取得は「うどんげ」に見える');
          parts.push('免疫はその手番の自分だけ。他の人が出した手番では自分も影響を受ける');
        }
        return parts.join('／');
      }
      case 'othersDiff': return `ラウンド末・他の人が同じ手番に取った${nameOf(def.plusKey)}の枚数と${nameOf(def.minusKey)}の枚数の差 × ${def.mult} 点`;
      case 'pairCond': return `ラウンド末・2 枚ごとに ${def.points} 点。ただし 2 枚ごとに春アイコン -${def.reduceSpringIconsPerPair} される（春の競争で不利）`;
      case 'maki': return `ラウンド末・アイコンの合計数を競う。1 位 ${MAKI.first} 点／2 位 ${MAKI.second} 点`;
      case 'temaki': return `ラウンド末・枚数を競う。1 位 +${def.most} 点／最下位 ${def.least} 点`;
      case 'springMost': return `ラウンド末・春の取得数が全員の 1 位なら、所持 1 枚につき +${def.most} 点`;
      case 'springBoost': return '取得後、次に春を取るとアイコン数ぶんの点を追加でもらえる（同じラウンド内で 1 回）';
      case 'pair': return def.pairRamp
        ? `ラウンド末・2 枚 1 ペア。1 ペア目 ${def.pairRamp} 点・2 ペア目 ${def.pairRamp + 1} 点…とゲームを通して増える`
        : `ラウンド末・2 枚 1 ペア = ${def.points} 点${gameEndBonusText(def)}`;
      case 'aliceSet': {
        const tbl = def.table || [0, 1, 4, 9, 16];
        return `ラウンド末・違う人形の種類数で得点。1 種 ${tbl[1]} 点／2 種 ${tbl[2]} 点／3 種 ${tbl[3]} 点／4 種 ${tbl[4]} 点`;
      }
      case 'set3': return `ラウンド末・3 枚 1 セット = ${def.points} 点${gameEndBonusText(def)}`;
      case 'collect': return `ラウンド末・枚数が多いほど得点。${def.table.map((v, i) => `${i + 1} 枚 ${v} 点`).join('／')}…`;
      case 'socialJoin': {
        const names = (def.joinKeys || []).map(nameOf).join('か');
        const per = def.per === undefined ? 1 : def.per;
        return def.sameTurn
          ? `取得した手番・同じ手番に他の人が${names}を取っていたら、その人数 × ${per} 点`
          : `ラウンド末・このラウンドに他の人が${names}を取っていたら、その人数 × ${per} 点`;
      }
      case 'roundComboCount': return `ラウンド末・このラウンドに継続カードを取った枚数 × ${def.per} 点`;
      case 'tofu': return `ラウンド末・1 枚 ${def.table[0]} 点／2 枚 ${def.table[1]} 点。3 枚目を取ると全部 0 点`;
      case 'eel': return `ラウンド末・1 枚だけだと ${def.first} 点。2 枚以上集めると +${def.more} 点`;
      case 'pairWith': return `ラウンド末・${nameOf(def.partner)}と同じ枚数だけペアが成立し、1 組 ${def.points} 点`;
      case 'uramaki': return `ラウンド中・信仰アイコン合計が ${def.threshold} に達した人から順に ${def.rankPoints[0]} 点・${def.rankPoints[1]} 点・${def.rankPoints[2]} 点`;
      case 'scoop': return '取得時・手札から 2 枚追加で取り、山札から 2 枚引き直す（このカードは山札へ戻る）';
      case 'swapNamed': return '次にカードを取ったあと、カード名を指定して誰かの手札と 1 枚交換できる（本体 0 点）';
      case 'dessertParity': return `ゲーム末・0 枚 ${def.zero} 点／偶数枚 +${def.even} 点／奇数枚 0 点`;
      case 'kindCount': return `ラウンド末・このラウンドに取ったカードの種類数 ${def.offset >= 0 ? '+' : ''}${def.offset} 点`;
      case 'letty': return `ラウンド末・自分の冬の枚数から春の個数を引いた数 × ${def.mult} 点`;
      case 'coop': return '取得した手番で、他の人も同時にリグルを取っていたら 1 人につき 1 点';
      case 'flip': return `取得時・手元のカードを裏返せる。裏返すと通常効果を失い 1 枚 ${def.flipPoints} 点になる`;
      case 'copy': return '取得時・手元の他のカード 1 枚の効果をコピー';
      case 'deckPeek': return `取得時・山札の上 ${def.peek} 枚を見て、その中から 1 枚もらえる`;
      case 'collectByTwo': return `ゲーム末・2 枚ごとに ${def.per2} 点／4 枚以上で +${def.bonusAt4}`;
      case 'parity': return `ゲーム末・偶数枚なら 2 枚ごとに ${def.per2Even} 点／奇数なら ${def.per2Odd} 点`;
      case 'dessertLeast': return `ゲーム末・この継続カードの保有数が最少だと ${def.least} 点`;
      case 'dessertIce': return `ゲーム末・${def.per} 枚集めるごとに +${def.points} 点`;
      case 'dessertMostLeast': return `ゲーム末・最多なら +${def.most} 点／最少なら ${def.least} 点`;
      case 'dessertRound': return `ラウンド末・そのラウンドに取った 1 枚ごとに ${def.roundPenalty} 点／ゲーム末・最多なら 所持枚数 × ${def.endMostPer} 点`;
      default: return '';
    }
  }
  // カード面用の極短テキスト（詳細は右の拡大表示とカード一覧で読む）
  function tinyDesc(def) {
    if (def && def.text && def.text.short) return def.text.short;
    switch (def.kind) {
      case 'instant': {
        const extra = [];
        if (def.hidden) extra.push('＋幻覚');
        if (def.comboKeys) extra.push('＋コンボ');
        if (def.swap) extra.push('＋交換');
        if (def.absentKeys && def.absentKeys.includes(def.key)) extra.push('（単独のみ）');
        if (def.buffTargets) extra.push('＋次を3倍');
        if (def.pointsIfPicked) extra.push('＋連携');
        if (def.discardBonus) extra.push('＋破棄');
        return `${def.points}点${extra.join('')}`;
      }
      case 'othersDiff': return `(他${nameOf(def.plusKey)}−他${nameOf(def.minusKey)})×${def.mult}`;
      case 'pairCond': return `2枚毎${def.points}点／春-${def.reduceSpringIconsPerPair || 1}個`;
      case 'maki': return '最多+6／2位+3';
      case 'temaki': return `最多+${def.most}／最少${def.least}`;
      case 'springMost': return `春の最多で+${def.most}×枚`;
      case 'springBoost': return '次の春で春と点を追加';
      case 'pair': return def.pairRamp ? `累計ペア ${def.pairRamp}/${def.pairRamp + 1}/${def.pairRamp + 2}…` : `2枚で${def.points}点`;
      case 'aliceSet': return '種類数で1/4/9/16点';
      case 'set3': return `3枚で${def.points}点`;
      case 'collect': return '枚数で加点';
      case 'socialJoin': {
        const short = (def.joinKeys || []).map((k) => nameOf(k)).join('/');
        const per = def.per === undefined ? 1 : def.per;
        return def.sameTurn ? `同手番の${short}で+${per}` : `他人の${short}で+${per}`;
      }
      case 'roundComboCount': return `継続カード毎+${def.per}`;
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
      case 'dessertMostLeast': return `最多+${def.most}／最少${def.least}`;
      case 'dessertRound': return `取得毎${def.roundPenalty}／最多×${def.endMostPer}`;
      case 'eel': return `1枚${def.first}／2枚+${def.more}`;
      case 'scoop': return '手札+2枚';
      case 'swapNamed': return '次に名前指定で交換';
      case 'pairWith': return `${nameOf(def.partner)}とペア${def.points}点`;
      case 'uramaki': return `${def.threshold}個で${def.rankPoints.join('/')}点`;
      case 'dessertParity': return `0枚${def.zero}／偶数+${def.even}`;
      default: return '';
    }
  }

  // ---- 数アイコン（春＝桜 / 玉兎＝兎 / 信仰＝鳥居） ----
  const COUNT_ICON_SVG = {
    spring: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(72 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(144 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(216 12 12)"/><ellipse cx="12" cy="5.4" rx="3.5" ry="4.3" transform="rotate(288 12 12)"/></g><circle cx="12" cy="12" r="2.1" fill="#f6d67a"/></svg>',
    rabbit: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="8.6" cy="6" rx="2.1" ry="5"/><ellipse cx="15.4" cy="6" rx="2.1" ry="5"/><circle cx="12" cy="15.4" r="6.1"/></g><circle cx="9.9" cy="14.4" r="0.9" fill="#2a2532"/><circle cx="14.1" cy="14.4" r="0.9" fill="#2a2532"/><circle cx="12" cy="17.1" r="0.8" fill="#c98ba8"/></svg>',
    faith: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="2.4" y="4.6" width="19.2" height="2.6" rx="1.1"/><rect x="4.6" y="9.2" width="14.8" height="2.2" rx="1"/><rect x="7.1" y="11.4" width="2.5" height="8.8" rx="1"/><rect x="14.4" y="11.4" width="2.5" height="8.8" rx="1"/></g></svg>',
  };
  function countIconKind(def) {
    if (!def) return null;
    if (def.key === 's_spring') return 'spring';
    if (def.key === 'y_rabbit') return 'rabbit';
    if (def.kind === 'uramaki') return 'faith';
    return null;
  }
  // カード面の右上に出すアイコン数バッジ（春・玉兎・信仰）
  function countBadge(def, icons) {
    const kind = countIconKind(def);
    if (!kind || !icons) return '';
    const max = kind === 'faith' ? 5 : 3; // 信仰は 1 枚に最大 5 個ぶん乗る
    const n = Math.max(1, Math.min(max, Number(icons)));
    return `<span class="card-count card-count-${kind}" title="アイコン ${icons} 個">${COUNT_ICON_SVG[kind].repeat(n)}</span>`;
  }

  // 背景色に対して読みやすい文字色（明るい背景なら濃色）を返す
  function readableInk(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.62 ? '#2a2532' : '#fff';
  }


  // ---- 人間の入力 ----

  // 1 回目のクリックで選択、同じカードをもう一度クリックすると確定（決定ボタンでも可）
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

    if (PICK_SELECTED === idx) {
      // 選択中のカードをもう一度クリック＝そのカードを取る（決定ボタンと同じ）
      confirmPick();
      return;
    }
    PICK_SELECTED = idx;
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

  // 複数モードが同時に必要なときに、この順で 1 つずつ聞く（engine.js の selectionNeeded と対）
  const SEL_ORDER = ['scoop', 'swapNamed', 'discard', 'copy', 'swap', 'flip', 'peek'];

  function humanSelectNeeded() {
    // エンジンの selectionNeeded と同じ判定を UI 側で行う
    const p = STATE.players[0];
    const need = { discard: false, flip: false, copy: false, peek: false, swap: false, scoop: false, swapNamed: false };
    for (const inst of p.taken) {
      const def = defOf(inst.key);
      if (!def || inst.selectionDone) continue;
      if (def.kind === 'instant' && def.discardBonus) need.discard = true;
      if (def.kind === 'instant' && def.swap) need.swap = true;
      if (def.kind === 'flip') need.flip = true;
      if (def.kind === 'copy') need.copy = true;
      if (def.kind === 'deckPeek') need.peek = true;
    }
    if ((p.scoopPending || 0) > 0 && p.hand.length > 0) need.scoop = true;
    if (p.nitoriReady) need.swapNamed = true;
    return need;
  }

  function enterSelectMode() {
    const need = humanSelectNeeded();
    // 蓄積済み choice に含まれていないモードを優先順に選ぶ
    SEL_MODE = SEL_ORDER.find((m) => need[m] && !modeStaged(m)) || null;
    SEL_SELECTED = [];
    SEL_NAMED = null;
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
  // 継続カードは破棄/裏返し/コピーの対象に含まれる（継続カードリスクの回避手段になる）
  function selectTargetable(inst, mode) {
    const def = defOf(inst.key);
    if (!def || inst.discarded) return false;
    if (mode === 'discard') return !def.discardBonus; // フラン自身は破棄できない
    if (mode === 'flip') return def.kind !== 'flip'; // ミスティア自身は裏返せない
    if (mode === 'copy') return def.kind !== 'copy'; // 慧音自身はコピーできない
    if (mode === 'swap') return !def.swap && def.key !== STATE.dessert.key; // 永琳自身と継続カードは交換できない
    return false;
  }

  // 選択モード → choice オブジェクトのキー（小悪魔の山札確認だけ pick になる）
  const CHOICE_KEY = { discard: 'discard', copy: 'copy', swap: 'swap', flip: 'flip', peek: 'pick', scoop: 'scoop', swapNamed: 'named' };

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
    } else if (SEL_MODE === 'scoop') {
      // 文の追加取材: 手札から 2 枚（端数は残り枚数）
      const want = Math.min(STATE.players[0].scoopPending || 2, STATE.players[0].hand.length);
      if (SEL_SELECTED.length !== want) return;
      choice.scoop = [...SEL_SELECTED];
    } else if (SEL_MODE === 'swapNamed') {
      choice.named = SEL_NAMED || null;
    } else {
      return;
    }

    // 残りの必要モードがあれば次へ進む
    const need = humanSelectNeeded();
    const next = SEL_ORDER.find((m) => need[m] && (m === 'flip' ? !Array.isArray(choice.flip) : choice[CHOICE_KEY[m]] === undefined));
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
    const next = SEL_ORDER.find((m) => need[m] && (m === 'flip' ? !Array.isArray(choice.flip) : choice[CHOICE_KEY[m]] === undefined) && m !== SEL_MODE);
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
    // ツールチップ: 基本の説明に、その個体の実際の点数（同席で 0 点・条件で +1 など）を添える
    const basePts = def && typeof def.points === 'number' ? def.points : null;
    let ptsNote = '';
    if (inst) {
      if (inst.discarded) ptsNote = '／今回 0 点（破棄）';
      else if (inst.flipped) ptsNote = '／今回 2 点（裏返し）';
      else if (roundPts !== null && roundPts !== undefined && basePts !== null && roundPts !== basePts) {
        ptsNote = `／今回 ${roundPts} 点`;
        if (inst.absentBlocked) ptsNote += '（同じ手番に咲夜が 2 枚以上）';
      }
    }
    el.title = inst && inst.copied
      ? `慧音のコピー・${cardLabel(def)}：${descOf(def)}${ptsNote}`
      : `${cardLabel(def)}：${descOf(def)}${ptsNote}`;
    return el;
  }

  // 手札のカードに出す「確定済みの点数」（即時点のみ。条件で変わるものは場に出てから出す）
  function handPtsOf(inst) {
    const def = inst && defOf(inst.key);
    if (!def || def.kind !== 'instant') return null;
    return typeof def.points === 'number' ? def.points : null;
  }

  // 取得行に表示する「確定済み点数」（即時系カードのみ・破棄/裏返しはタグが代わりに表示される）
  function roundPtsOf(inst, pi) {
    const def = defOf(inst.key);
    if (!def || inst.flipped || inst.discarded) return null;
    if (def.kind === 'coop') return inst.coopPoints || null; // リグルは取得した手番で確定
    if (def.kind === 'socialJoin' && def.sameTurn) return inst.socialPoints || null; // 大妖精も手番内で確定
    if (def.kind !== 'instant') return null;
    let pts = def.points;
    if (inst.triple) pts *= inst.triple; // 早苗の加護（次の奇跡を 3 倍）
    if (inst.instantCombo && def.comboBonus) pts += def.comboBonus; // 取得時コンボ（美鈴）
    if (def.comboAtEnd && def.comboBonus && def.comboKeys
      && def.comboKeys.every((k) => STATE.players[pi].taken.some((i) => i.key === k && !i.flipped && !i.discarded))) {
      pts += def.comboBonus; // ラウンド末コンボ（藍・橙）
    }
    if (inst.absentBlocked) pts = 0; // 咲夜の同席判定（個体のフラグを見る）
    if (inst.turnBonus) pts += inst.turnBonus; // 永琳: 同じ手番に輝夜が出ていたときの加点
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
      statusEl.textContent = 'ゲーム終了！';
    } else if (STATE.phase === 'select') {
      statusEl.textContent = selectStatusText(selectTurn);
    } else if (STATE.picks[0]) {
      statusEl.textContent = '他のプレイヤーの選択を待っています…';
    } else if (CHOPSTICKS_MODE) {
      statusEl.textContent = `早飲みモード：2 枚選んでね（${CHOP_SELECTED.length}/2 枚選択）`;
    } else if (PICK_SELECTED !== null && p.hand[PICK_SELECTED]) {
      statusEl.textContent = `「${cardLabel(defOf(p.hand[PICK_SELECTED].key))}」を選択中。「このカードを取る」で確定`;
    } else if (STATE.hidden) {
      statusEl.textContent = STATE.hiddenOwner === 0
        ? '幻覚をかけている：出した番の全員の取得がうどんげに見えている'
        : '幻覚がかかっている：出した番の取得がうどんげに見えている';
    } else {
      statusEl.textContent = '手札から 1 枚選んで「このカードを取る」を押してね';
    }

    const chopBtn = $('btn-chopsticks');
    chopBtn.classList.toggle('hidden', !(myTurn && p.chopsticks > 0));
    chopBtn.classList.toggle('active', CHOPSTICKS_MODE);

    const confirmBtn = $('btn-confirm-pick');
    const canConfirm = myTurn && (CHOPSTICKS_MODE ? CHOP_SELECTED.length === 2 : PICK_SELECTED !== null);
    confirmBtn.classList.toggle('hidden', !canConfirm);

    p.hand.forEach((card, idx) => {
      // 出た時点で点数が確定するカード（即時点）は、手札の時点でその点数をカード面に出す
      const el = cardEl(card.key, card.icons, '', null, handPtsOf(card));
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
    if (!selectTurn) return '他のプレイヤーの選択を待っています…';
    if (SEL_MODE === 'scoop') {
      const p0 = STATE.players[0];
      const want = Math.min(p0.scoopPending || 2, p0.hand.length);
      return `射命丸文の取材：追加で取るカードを選んでね（${SEL_SELECTED.length}/${want} 枚）`;
    }
    if (SEL_MODE === 'swapNamed') return '河城にとり：相手の手札から取りたいカード名を指定してね';
    if (SEL_MODE === 'flip') return `裏返すカードを選んでね（${SEL_SELECTED.length} 枚選択・任意枚数）`;
    if (SEL_MODE === 'discard') return SEL_SELECTED.length === 1
      ? '破棄するカードを選択中。「このカードを破棄する」で確定'
      : '破棄するカードを 1 枚選んでね';
    if (SEL_MODE === 'copy') return SEL_SELECTED.length === 1
      ? 'コピーするカードを選択中。「この効果をコピーする」で確定'
      : 'コピーするカードを 1 枚選んでね';
    if (SEL_MODE === 'swap') return SEL_SELECTED.length === 1
      ? '山札と交換するカードを選択中。「このカードを山札と交換する」で確定'
      : '山札と交換するカードを 1 枚選んでね（永琳の薬）';
    if (SEL_MODE === 'peek') return SEL_SELECTED.length === 1
      ? '獲得するカードを選択中。「このカードを獲得する」で確定'
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
      // 他人の選択待ち。古いモードを残さない（オーバーレイも出さない）
      SEL_MODE = null;
      SEL_SELECTED = [];
      STAGED_CHOICE = null;
      areaEl.classList.remove('active');
      return;
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
    } else if (SEL_MODE === 'scoop' && selectTurn) {
      // 射命丸文: 手札から追加で 2 枚選ぶ
      const want = Math.min(p.scoopPending || 2, p.hand.length);
      p.hand.forEach((card, idx) => {
        const el = cardEl(card.key, card.icons);
        if (SEL_SELECTED.includes(idx)) el.classList.add('selected');
        el.classList.add('clickable');
        el.addEventListener('click', () => {
          const at = SEL_SELECTED.indexOf(idx);
          if (at >= 0) SEL_SELECTED.splice(at, 1);
          else if (SEL_SELECTED.length < want) SEL_SELECTED.push(idx);
          renderAll();
        });
        list.appendChild(el);
      });
    } else if (SEL_MODE === 'swapNamed' && selectTurn) {
      // 河城にとり: 相手の手札にあるカード名を指定する
      const keys = Object.keys(STATE.cardMap).filter((k) => k !== STATE.dessert.key);
      const sel = document.createElement('select');
      sel.className = 'name-select';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '（指定しない）';
      sel.appendChild(opt0);
      keys.forEach((k) => {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = nameOf(k);
        sel.appendChild(o);
      });
      sel.value = SEL_NAMED || '';
      sel.addEventListener('change', () => { SEL_NAMED = sel.value || null; });
      list.appendChild(sel);
    } else {
      p.taken.forEach((card, idx) => {
        // 幻覚で伏せられたカードは、コピー対象の一覧でも中身を見せない（うどんげとして出す）
        if (hiddenFromViewer(card)) {
          const masked = defOf('y_reisen') ? cardEl('y_reisen', null, 'taken', { masked: true }) : null;
          if (masked) {
            masked.classList.add('not-target');
            list.appendChild(masked);
            return;
          }
        }
        const el = cardEl(card.key, card.icons, 'taken', card, roundPtsOf(card, 0));
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
      const wantN = SEL_MODE === 'scoop' ? Math.min(p.scoopPending || 2, p.hand.length) : 1;
      confirmBtn.disabled = SEL_MODE === 'flip' || SEL_MODE === 'swapNamed' ? false : SEL_SELECTED.length !== wantN;
      if (SEL_MODE === 'flip') {
        confirmBtn.textContent = `裏返しを決定（${SEL_SELECTED.length} 枚）`;
      } else if (SEL_MODE === 'scoop') {
        confirmBtn.textContent = `この ${wantN} 枚を追加で取る`;
      } else if (SEL_MODE === 'swapNamed') {
        confirmBtn.textContent = 'この名前で調査する';
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
      const pick = STATE.picks[pi];
      // オンラインは真偽値（サーバー契約）、ホットシートは配列/null なので両方を受ける
      const picked = pick === true || Array.isArray(pick);
      const roundPts = p.roundScores[STATE.round];
      const tags = [];
      if (p.chopsticks > 0) tags.push(`早×${p.chopsticks}`);
      if (p.desserts.length > 0) tags.push(`継続カード×${p.desserts.length}`);
      // 霊夢・魔理沙はゲーム通算で数えるので、手元ではなく通算カウントを出す
      if (STATE.intruderKey) {
        const cnt = gameEndCountFor(p, STATE.intruderKey);
        if (cnt > 0) tags.push(`${nameOf(STATE.intruderKey)}×${cnt}`);
      }
      const el = document.createElement('div');
      el.className = `player-chip${pi === 0 ? ' me' : ''}${picked ? ' picked' : ''}`;
      // 退席猶予はサーバー計算の残りミリ秒。受信時刻からの経過だけ引いて表示する
      const elapsed = VIEW_ANCHOR_AT ? performance.now() - VIEW_ANCHOR_AT : 0;
      const offLeft = (p.connected === false && typeof p.disconnectRemainMs === 'number')
        ? Math.max(0, Math.ceil((p.disconnectRemainMs - elapsed) / 1000))
        : null;
      const offTag = offLeft === null
        ? ''
        : offLeft > 0
          ? `<span class="chip-off">退席中（AIまで ${Math.floor(offLeft / 60)}:${String(offLeft % 60).padStart(2, '0')}）</span>`
          : '<span class="chip-off">AI代行中</span>';
      el.innerHTML = `
        <span class="chip-name">${esc(p.name)}${pi === 0 && p.name !== 'あなた' ? '（あなた）' : ''}</span>
        ${offTag}
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

  // 幻覚で隠した追加カードぶんを差し引いた通算（ローカル対戦用。オンラインはサーバーが処理済み）
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
    // 守矢神社: 信仰アイコンの現在値（しきい値に届くと順位点）
    const faithDef = Object.values(STATE.cardMap).find((d) => d.kind === 'uramaki');
    if (faithDef) {
      let n = 0;
      for (const inst of shown) {
        if (inst.key === faithDef.key && !inst.flipped) n += inst.icons || 1;
      }
      const need = faithDef.threshold || 10;
      tags.push({
        icon: COUNT_ICON_SVG.faith,
        label: STATE.roundStats && STATE.roundStats[pi] && STATE.roundStats[pi].faithCleared ? `${n}（到達）` : `${n}/${need}`,
        color: faithDef.color,
      });
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
      nameSpan.textContent = `${p.name}${pi === 0 && p.name !== 'あなた' ? '（あなた）' : ''}の取ったカード`;
      label.appendChild(nameSpan);
      // 追跡リソース（春合計・兎枚数・信仰値など）
      for (const t of trackedTags(pi)) {
        const tag = document.createElement('span');
        tag.className = 'row-tag';
        tag.style.background = t.color;
        // 玉兎（生成り）のように明るい色でも文字が沈まないように、背景に応じて文字色を変える
        tag.style.color = readableInk(t.color);
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
          if (def.kind === 'copy' && copiedInst && !hiddenFromViewer(copiedInst)) {
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

      // 継続カード置き場（右端固定・BGA 版準拠）
      const dbox = document.createElement('div');
      dbox.className = 'dessert-box';
      const dlabel = document.createElement('div');
      dlabel.className = 'box-label';
      dlabel.textContent = p.desserts.length ? `継続カード ×${p.desserts.length}` : '継続カード置き場';
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
      $('round-indicator').textContent = 'ゲーム終了';
      $('pass-indicator').textContent = '';
      return;
    }
    $('round-indicator').textContent = `ラウンド ${STATE.round + 1}｜${STATE.incidentName}`;
    $('pass-indicator').textContent = STATE.passDir === 1 ? '手札は右隣へ流れる' : '手札は左隣へ流れる';
  }

  // ---- ラウンド開始アニメーション ----
  // ラウンドが変わるたびに、中央へ「ラウンド N＋ステージ名」を出してフェードさせる
  // （同時に配りアニメ = DEAL_ANIM も立てる）。入力は妨げない（pointer-events: none）
  let SPLASH_TIMER = null;
  let SHOWN_ROUND = -1; // 直近でスプラッシュを出したラウンド番号

  function showRoundSplash() {
    const el = $('round-splash');
    if (!el) return;
    el.innerHTML = `<div class="rs-box">`
      + `<div class="rs-stage">${esc(STATE.incidentName || '')}</div>`
      + `<div class="rs-round">ラウンド ${STATE.round + 1}</div>`
      + '</div>';
    el.classList.remove('hidden', 'show');
    void el.offsetWidth; // アニメーションを最初から再生し直す
    el.classList.add('show');
    clearTimeout(SPLASH_TIMER);
    SPLASH_TIMER = setTimeout(() => el.classList.add('hidden'), 1700);
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
      // 順位と同点処理は Engine 側の定義（合計点 → 継続カード枚数 → 同率）に従う
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
            <div class="bp-head"><span>${r.rank}位${rankCounts.get(r.rank) > 1 ? '（同率）' : ''} ${esc(r.name)}${r.pi === 0 && r.name !== 'あなた' ? '（あなた）' : ''}</span><span class="bp-total">${r.total}点</span></div>
            <div class="bp-sub">継続カード ${r.desserts} 枚 ／ ${rounds} ／ ゲーム末 ${geTotal >= 0 ? '+' : ''}${geTotal} 点</div>
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
      el.innerHTML = `<h2>ゲーム終了</h2><div class="banner-players">${rows}</div>${actions}<p class="banner-note">同点は継続カード枚数で判定／クリックで閉じる</p>`;
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
    // 並べ替えはコピーに対して行う（state 側の配列を書き換えない）
    const rows = [...b.results]
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
          const cnt = e.count > 1 ? `（${e.count} 枚）` : '';
          const icons = e.icons > e.count ? `（${e.icons} 個）` : '';
          const flag = e.flags.size ? `・${[...e.flags].join('・')}` : '';
          const label = def && def.group
            ? `${def.name}（${e.types.size} 種・${e.count} 枚）${flag}`
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
          <div class="bp-head"><span>${esc(r.name)}${r.pi === 0 && r.name !== 'あなた' ? '（あなた）' : ''}</span><span class="bp-total">${r.points >= 0 ? '+' : ''}${r.points}点</span></div>
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
    el.innerHTML = `<h2>ラウンド ${b.round + 1} の結果</h2><div class="banner-players">${rows}</div><p class="banner-note">${ONLINE ? 'クリックで次へ（全員の準備を待っています）' : 'クリックで次のラウンドへ'}</p>`;
    el.classList.remove('hidden');
    el.onclick = () => {
      if (ONLINE) { Net.continueRound(); return; }
      STATE.roundBanner = null; DEAL_ANIM = true; renderAll(); // 次ラウンドの配りアニメ
    };
  }

  // ステージカード一覧モーダル（現在のセットの全カード・説明・構成枚数）
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
    h2.textContent = `ステージ「${STATE.incidentName}」・${STATE.incidentSubtitle}`;
    el.appendChild(h2);

    // メイン → 継続カード の順に種別ごと表示
    const allKeys = Object.keys(STATE.cardMap);
    const groups = [
      { title: 'メインカード', keys: allKeys.filter((k) => k !== STATE.dessert.key) },
      { title: '継続カード', keys: [STATE.dessert.key] },
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
          ? `<div class="ref-compo ref-compo-${kind}">${Object.entries(def.iconCounts).map(([c, num]) => `<span class="ref-compo-item">${COUNT_ICON_SVG[kind].repeat(Number(c))}<span>×${num}</span></span>`).join('')}</div>`
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
    if (target.inst && target.inst.absentBlocked) tags.push('今回 0 点（同席）');
    if (target.inst && target.inst.triple) tags.push(`今回 ${(def.points || 0) * target.inst.triple} 点（加護）`);
    if (target.inst && target.inst.turnBonus) tags.push(`今回 +${target.inst.turnBonus} 点`);
    el.innerHTML = `
      <div class="preview-card"><img src="assets/cards/${def.key}.webp" alt="" onerror="this.parentElement.classList.add('no-art')"></div>
      <div class="preview-name">${cardLabel(def)}${tags.length ? `<span class="preview-tag">${tags.join('・')}</span>` : ''}</div>
      ${iconHtml}
      <div class="preview-desc">${descOf(def)}</div>`;
  }

  // ヘッダーのステージ紋章を差し替える
  // 対戦中もルームコードが分かるようにヘッダーへ出す
  function renderRoomBadge() {
    const el = $('room-badge');
    if (!el) return;
    const show = ONLINE && ROOM_CODE && STATE;
    el.classList.toggle('hidden', !show);
    if (show) $('room-code-label').textContent = ROOM_CODE;
  }

  function renderStageEmblem() {
    const em = $('stage-emblem');
    if (!em) return;
    const src = STATE && STATE.incidentId ? STAGE_EMBLEM[STATE.incidentId] : null;
    if (src) {
      if (em.getAttribute('src') !== src) em.src = src;
      em.classList.remove('hidden');
    } else {
      em.classList.add('hidden');
    }
    if (STATE && STATE.incidentId) document.body.dataset.stage = STATE.incidentId;
    else delete document.body.dataset.stage;
  }

  function renderAll() {
    autoSkipIfEmpty();
    // ラウンドが変わった瞬間（開始・バナーを閉じた時）に開始アニメを出す。
    // ラウンド番号は結果バナーの生成と同時に進むため、バナー表示中は出さない
    if (STATE && STATE.phase !== 'over' && !STATE.roundBanner && STATE.round !== SHOWN_ROUND) {
      SHOWN_ROUND = STATE.round;
      DEAL_ANIM = true; // 配り直しのアニメも一緒に出す
      showRoundSplash();
    }
    renderRound();
    renderHand();
    renderPlayerBar();
    renderTableRows();
    renderSelectArea(); // table-rows 再構築の後に呼び、あなたの行にオーバーレイを重ねる
    renderBanner();
    renderPreview();
    renderStageEmblem();
    renderRoomBadge();
    updateTimerIndicator();
  }

  // ---- 対戦（サーバー権威） ----

  function lobbyName() {
    return $('input-name').value.trim() || 'あなた';
  }

  // ルームコードをコピー
  function copyRoomCode() {
    const code = $('online-code').textContent.trim();
    const done = () => {
      const btn = $('btn-copy-code');
      const prev = btn.textContent;
      btn.textContent = 'コピー済み';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
      ta.remove();
    }
  }

  // ルームから抜けてモード選択へ戻る
  function leaveOnlineLobby() {
    try { Net.leave(); } catch (e) { /* 切断済みでも続行 */ }
    ONLINE = false;
    $('online-lobby').classList.add('hidden');
    $('mp-entry').classList.remove('hidden');
    showModeSelect();
  }

  function createRoom() {
    setMpStatus('');
    Net.create(lobbyName());
  }

  function joinRoom() {
    const code = $('input-code').value.trim().toUpperCase();
    if (!code) { $('input-code').focus(); return; }
    setMpStatus('');
    Net.join(code, lobbyName());
  }

  // 参加/作成の結果を行内に出す（ルーム未発見などを alert で潰さない）
  function setMpStatus(text) {
    const el = $('mp-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
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
    $('online-room-state').textContent = lobby.started ? '開始' : '待機中';
    $('online-room-state').classList.toggle('started', !!lobby.started);
    $('online-count').textContent = `${lobby.players.length} / ${lobby.maxPlayers} 人`;
    $('online-players').innerHTML = lobby.players
      .map((p) => {
        const mine = p.seat === MY_SEAT;
        const host = p.isHost ? '<span class="tag-host">ホスト</span>' : '';
        const you = mine ? '<span class="tag-you">あなた</span>' : '';
        const off = p.connected ? '' : '<span class="tag-off">切断</span>';
        const ai = p.isAI ? '<span class="tag-ai">AI</span>' : '';
        return `<div class="online-player${mine ? ' me' : ''}${p.connected ? '' : ' off'}">`
          + `<span class="seat-no">${p.seat + 1}</span>`
          + `<span class="player-name">${esc(p.name)}</span>`
          + host + you + ai + off
          + '</div>';
      })
      .join('');
    const me = lobby.players.find((p) => p.seat === MY_SEAT);
    const isHostMe = !!(me && me.isHost);
    $('btn-online-start').classList.toggle('hidden', !isHostMe);
    // AI での人数調整（ホストのみ・開始前のみ）
    const canAdjust = isHostMe && !lobby.started;
    $('ai-controls').classList.toggle('hidden', !canAdjust);
    $('btn-add-ai').disabled = !canAdjust || lobby.players.length >= lobby.maxPlayers;
    $('btn-remove-ai').disabled = !canAdjust || !lobby.players.some((p) => p.isAI);
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
      : (() => {
        const ai = lobby.players.filter((p) => p.isAI).length;
        const humans = lobby.players.length - ai;
        return `${lobby.players.length}/${lobby.maxPlayers}人（人間 ${humans}・AI ${ai}／${lobby.minPlayers}人以上で開始）`;
      })();
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
    if (!ONLINE || !STATE) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    // サーバーが「残りミリ秒」を送る。受信時刻からの経過を引くので、端末の時計がずれていても正しい
    const remain = typeof STATE.deadlineRemainMs === 'number' ? STATE.deadlineRemainMs : null;
    if (remain === null) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const elapsed = VIEW_ANCHOR_AT ? performance.now() - VIEW_ANCHOR_AT : 0;
    const left = Math.max(0, Math.ceil((remain - elapsed) / 1000));
    el.classList.remove('hidden');
    el.textContent = `残り ${left}秒`;
  }

  // ---- Render のスリープ対策 ----
  // 画面を開いている間は 5 分ごとに軽くサーバーを叩いて、無料プランのアイドル停止を避ける
  const KEEPALIVE_MS = 5 * 60 * 1000;
  let keepAliveTimer = null;
  function pingKeepAlive() {
    if (document.visibilityState !== 'visible') return;
    try { fetch('/keepalive', { cache: 'no-store', keepalive: true }).catch(() => {}); } catch (e) { /* 失敗しても無視 */ }
  }
  function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    pingKeepAlive();
    keepAliveTimer = setInterval(pingKeepAlive, KEEPALIVE_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startKeepAlive();
  });

  function init() {
    startKeepAlive();
    // 退席中の席があるときはチップのカウントダウンを毎秒更新
    setInterval(() => {
      if (!STATE || STATE.phase === 'over') return;
      if (!STATE.players.some((p) => p.connected === false)) return;
      renderPlayerBar();
    }, 1000);
    $('btn-start').addEventListener('click', startGame);
    $('input-name').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!$('solo-panel').classList.contains('hidden')) startGame();
      else if (!$('mp-entry').classList.contains('hidden')) joinRoom();
    });
    $('btn-chopsticks').addEventListener('click', toggleChopsticks);
    $('btn-confirm-pick').addEventListener('click', confirmPick);
    $('btn-cardref').addEventListener('click', toggleCardRef);
    $('btn-online-leave').addEventListener('click', leaveOnlineLobby);
    $('room-badge').addEventListener('click', () => {
      if (!ROOM_CODE) return;
      const label = $('room-code-label');
      const done = () => { label.textContent = 'コピー済み'; setTimeout(() => { label.textContent = ROOM_CODE; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ROOM_CODE).then(done).catch(() => {});
    });
    $('btn-add-ai').addEventListener('click', () => Net.addAi());
    $('btn-remove-ai').addEventListener('click', () => Net.removeAi());
    $('btn-copy-code').addEventListener('click', copyRoomCode);
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
    // 遊び方モーダル
    const rulesModal = $('rules-modal');
    const openRules = () => rulesModal.classList.remove('hidden');
    const closeRules = () => rulesModal.classList.add('hidden');
    $('btn-rules').addEventListener('click', openRules);
    $('btn-rules-close').addEventListener('click', closeRules);
    rulesModal.addEventListener('click', (e) => { if (e.target === rulesModal) closeRules(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !rulesModal.classList.contains('hidden')) closeRules(); });
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
      if (lobby && lobby.roomCode) ROOM_CODE = lobby.roomCode;
      showOnlineLobby(lobby);
    },
    onState(view) {
      const hadBanner = !!(STATE && STATE.roundBanner);
      STATE = view;
      VIEW_ANCHOR_AT = performance.now(); // 残り時間の基準点（時計ずれの影響を受けない）
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
      else if (!$('mp-entry').classList.contains('hidden')) setMpStatus(message);
      else alert(message);
    },
    onDisconnect() {
      if (!ONLINE) return;
      const st = $('hand-status');
      if (st) st.textContent = '接続が切れました。自動で再接続しています…';
    },
    onConnected() {},
  };

  document.addEventListener('DOMContentLoaded', init);

  // デバッグ・テスト用に公開（Game.state でヘッドレスエンジンの state を直接参照できる）
  window.Game = { startGame, renderAll, get state() { return STATE; } };
})();






















