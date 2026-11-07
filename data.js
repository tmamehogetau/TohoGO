'use strict';

// ステージセット定義。
// カードは「kind（メカニズム）」+「name/icon/color（キャラ味付け）」+「count（枚数）」+「params」。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  const RULES = {
    ROUNDS: 3,
    // スシGOパーティー準拠: 2-3人10枚 / 4-5人9枚
    HAND_SIZES: { 2: 10, 3: 10, 4: 9, 5: 9 },
    DESSERT_MIX: [5, 3, 2], // ラウンド1/2/3 の継続カード混入数
    // 多数決の標準配点（DESIGN 2-4）: 2人=1位4点/同点各2点、3人以上=1位6点/一意の2位3点
    MAKI_POINTS: { first: 6, second: 3 },
    MAKI_2P: { first: 4, tie: 2 },
    // パス方向（DESIGN 4）: ラウンド1・3 は左、ラウンド 2 は右（-1=左隣 / 1=右隣）
    PASS_DIRS: [-1, 1, -1],
  };

  // ---------------- 紅魔館（紅魔郷） ----------------
  const SCARLET_MAIN = [
    { key: 'k_remi', kind: 'instant', points: 3, name: 'レミリア', icon: '王', color: '#8b1a2b', count: 3 },
    { key: 'k_fran', kind: 'instant', points: 2, discardBonus: 2, name: 'フランドール', icon: '妹', color: '#c22a4e', count: 4 },
    { key: 'k_meirin', kind: 'instant', points: 1, comboKeys: ['k_sakuya'], comboBonus: 1, name: '紅美鈴', icon: '門', color: '#b8434a', count: 5 },
    { key: 'k_sakuya', kind: 'instant', points: 3, absentKeys: ['k_sakuya'], name: '十六夜咲夜', icon: 'メ', color: '#9aa5b1', count: 8 },
    { key: 'k_patch', kind: 'kindCount', offset: -3, name: 'パチュリー', icon: '図', color: '#8e3b8e', count: 3 },
    { key: 'k_rumia', kind: 'collect', table: [1, 3, 6, 10, 15], name: 'ルーミア', icon: '闇', color: '#3a3a42', count: 8 },
    { key: 'k_daiyousei', kind: 'socialJoin', sameTurn: true, joinKeys: ['k_cirno', 'k_daiyousei'], per: 1, name: '大妖精', icon: '精', color: '#b8d8e8', count: 8 },
    { key: 'k_maid', kind: 'temaki', most: 4, least: -4, name: '妖精メイド', icon: '奉', color: '#5f8f3e', count: 12 },
    { key: 'k_kozue', kind: 'deckPeek', peek: 4, name: '小悪魔', icon: '悪', color: '#3d7ea6', count: 3 },
  ];
  const SCARLET_DESSERT = { key: 'k_cirno', kind: 'dessertLeast', least: -9, name: 'チルノ', icon: '⑨', color: '#5bb8d4', pool: 15 };

  // ---------------- 白玉楼（妖々夢） ----------------
  const SPRING_MAIN = [
    { key: 's_yukari', kind: 'instant', points: 3, name: '八雲紫', icon: '境', color: '#7b4ea3', count: 3 },
    { key: 's_ran', kind: 'instant', points: 2, comboKeys: ['s_yukari', 's_chen'], comboBonus: 1, comboAtEnd: true, name: '八雲藍', icon: '狐', color: '#d9a441', count: 4 },
    { key: 's_chen', kind: 'instant', points: 1, comboKeys: ['s_yukari', 's_ran'], comboBonus: 1, comboAtEnd: true, name: '橙', icon: '橙', color: '#d97e30', count: 5 },
    { key: 's_spring', kind: 'maki', iconCounts: { 1: 4, 2: 5, 3: 3 }, name: '春', icon: '春', color: '#e88ab8', count: 12 },
    { key: 's_yuyuko', kind: 'springMost', most: 4, name: '西行寺幽々子', icon: '姫', color: '#d8cfe8', count: 3 },
    { key: 's_youmu', kind: 'springBoost', name: '魂魄妖夢', icon: '庭', color: '#8fb8a0', count: 3 },
    // アリスは「1 枚のカード」だが、手元では 4 種の人形（各 2 枚）に分かれる。
    // カードとしては 4 種とも「アリス」（name は共通・variant で人形を見分ける）。
    // 得点は集めた種類数（1種1点/2種4点/3種9点/4種16点）
    { key: 's_alice_hourai', kind: 'aliceSet', group: 'alice', groupLabel: 'アリス', name: 'アリス', variant: '蓬莱人形', table: [0, 1, 4, 9, 16], icon: '蓬', color: '#c9a84c', count: 2 },
    { key: 's_alice_shanghai', kind: 'aliceSet', group: 'alice', groupLabel: 'アリス', name: 'アリス', variant: '上海人形', table: [0, 1, 4, 9, 16], icon: '上', color: '#c9a84c', count: 2 },
    { key: 's_alice_kyo', kind: 'aliceSet', group: 'alice', groupLabel: 'アリス', name: 'アリス', variant: '京人形', table: [0, 1, 4, 9, 16], icon: '京', color: '#c9a84c', count: 2 },
    { key: 's_alice_french', kind: 'aliceSet', group: 'alice', groupLabel: 'アリス', name: 'アリス', variant: '仏蘭西人形', table: [0, 1, 4, 9, 16], icon: '仏', color: '#c9a84c', count: 2 },
    { key: 's_prism', kind: 'set3', points: 10, name: 'プリズムリバー3姉妹', icon: '奏', color: '#6a9fd8', count: 8 },
    // 案3.5: 2枚ごとに6点＋2枚ごとに自分の春アイコン合計-1（春の順位判定が下がる）
  { key: 's_letty', kind: 'pairCond', points: 6, reduceSpringIconsPerPair: 1, name: 'レティ', icon: '冬', color: '#a8c8e8', count: 8 },
  ];
  const SPRING_DESSERT = { key: 's_lily', kind: 'dessertIce', per: 4, points: 12, name: 'リリーホワイト', icon: '報', color: '#f0e6b8', pool: 15 };

  // ---------------- 永遠亭（永夜抄） ----------------
  // 霊夢/魔理沙はランダムでいずれか 1 種のみデッキに組み込まれる（永夜のみ）
  const ETERNAL_MAIN = [
    { key: 'y_kaguya', kind: 'instant', points: 3, name: '蓬莱山輝夜', icon: '夜', color: '#c9a84c', count: 3 },
    { key: 'y_eirin', kind: 'instant', points: 2, pointsIfPicked: { key: 'y_kaguya', bonus: 1 }, name: '八意永琳', icon: '薬', color: '#6a8fb8', count: 4 },
    { key: 'y_reisen', kind: 'instant', points: 1, hidden: true, name: '鈴仙', icon: '幻', color: '#b85a7a', count: 5 },
    { key: 'y_tewi', kind: 'tofu', table: [2, 6, 0], name: '因幡てゐ', icon: '幸', color: '#6a9955', count: 8 },
    { key: 'y_mystia', kind: 'flip', flipPoints: 2, name: 'ミスティア', icon: '歌', color: '#a67c52', count: 3 },
    { key: 'y_keine', kind: 'copy', name: '上白沢慧音', icon: '史', color: '#4a7ea6', count: 3 },
    { key: 'y_riggle', kind: 'coop', points: 1, name: 'リグル', icon: '蜻', color: '#c87a4a', count: 8 },
    { key: 'y_rabbit', kind: 'maki', iconCounts: { 1: 4, 2: 5, 3: 3 }, name: '玉兎', icon: '兎', color: '#e8e6e3', count: 12 },
  ];
  const ETERNAL_INTRUDERS = [
    { key: 'y_reimu', kind: 'pair', pairRamp: 4, name: '博麗霊夢', icon: '夢', color: '#c22a4e', count: 8 },
    { key: 'y_marisa', kind: 'collect', table: [0, 2, 8, 13, 21], gameEnd: true, name: '霧雨魔理沙', icon: '星', color: '#4a4a52', count: 8 },
  ];
  const ETERNAL_DESSERT = { key: 'y_moko', kind: 'dessertMostLeast', most: 6, least: -6, name: '藤原妹紅', icon: '火', color: '#d15a32', pool: 15 };

  // ---------------- 守矢神社（風神録） ----------------
  // 信仰の取り合い（到達レース）と厄の押し付けがテーマ
  const MOUNTAIN_MAIN = [
    { key: 'f_kanako', kind: 'instant', points: 3, buffable: true, name: '八坂神奈子', icon: '山', color: '#8d6e3a', count: 3 },
    { key: 'f_suwako', kind: 'instant', points: 2, buffable: true, name: '洩矢諏訪子', icon: '蛙', color: '#5f8f3e', count: 5 },
    { key: 'f_sanae', kind: 'instant', points: 1, buffTargets: ['f_kanako', 'f_suwako'], name: '東風谷早苗', icon: '奇', color: '#4a8fb8', count: 4 },
    { key: 'f_hina', kind: 'eel', first: -3, more: 7, name: '鍵山雛', icon: '厄', color: '#8e3b6a', count: 8 },
    { key: 'f_aya', kind: 'scoop', scoop: 2, draw: 2, name: '射命丸文', icon: '文', color: '#3a3a42', count: 3 },
    { key: 'f_nitori', kind: 'swapNamed', name: '河城にとり', icon: '道', color: '#3d7ea6', count: 3 },
    { key: 'f_minoriko', kind: 'collect', table: [1, 3, 6, 10, 15], name: '秋穣子', icon: '穣', color: '#c8a44a', count: 8 },
    { key: 'f_shizuha', kind: 'pairWith', partner: 'f_minoriko', points: 3, name: '秋静葉', icon: '紅', color: '#c85a3a', count: 8 },
    { key: 'f_faith', kind: 'uramaki', iconCounts: { 3: 5, 4: 4, 5: 3 }, threshold: 10, rankPoints: [8, 5, 2], name: '信仰', icon: '信', color: '#d8c07a', count: 12 },
  ];
  const MOUNTAIN_DESSERT = { key: 'f_momiji', kind: 'dessertParity', zero: -3, even: 5, name: '犬走椛', icon: '狼', color: '#a85a3a', pool: 15 };

  // ---------------- セット ----------------
  const INCIDENTS = {
    scarlet: {
      id: 'scarlet',
      name: '紅魔館',
      subtitle: '紅い館の連携',
      theme: 'キャラ間連携',
      main: SCARLET_MAIN,
      dessert: SCARLET_DESSERT,
      intruders: null,
    },
    spring: {
      id: 'spring',
      name: '白玉楼',
      subtitle: '桜をめぐる攻防',
      theme: '春をめぐる攻防',
      main: SPRING_MAIN,
      dessert: SPRING_DESSERT,
      intruders: null,
    },
    eternal: {
      id: 'eternal',
      name: '永遠亭',
      subtitle: '月をめぐる管理',
      theme: '数量の管理とジレンマ',
      main: ETERNAL_MAIN,
      dessert: ETERNAL_DESSERT,
      intruders: ETERNAL_INTRUDERS,
    },
    mountain: {
      id: 'mountain',
      name: '守矢神社',
      subtitle: '信仰と厄払い',
      theme: '信仰と厄払い',
      main: MOUNTAIN_MAIN,
      dessert: MOUNTAIN_DESSERT,
      intruders: null,
    },
  };

  const INCIDENT_IDS = ['scarlet', 'spring', 'eternal', 'mountain'];




  // カード面・一覧の文言（card-texts.txt の編集内容を正として、ここに固定する）
  const CARD_TEXTS = {
    "k_remi": {
      "short": "3点",
      "detail": "3 点"
    },
    "k_fran": {
      "short": "2点+破棄",
      "detail": "2 点／取得時、手元の 1 枚を山札へ戻すと +2 点"
    },
    "k_meirin": {
      "short": "1点+連携",
      "detail": "1 点／取得時、十六夜咲夜を所持しているなら +1 点"
    },
    "k_sakuya": {
      "short": "3点／0点",
      "detail": "3 点／他の人が同じ手番に咲夜を取得していると 0 点"
    },
    "k_patch": {
      "short": "種類数-3",
      "detail": "ラウンド終了時、このラウンドに取ったカードの種類数 -3 点（最小 0 点）"
    },
    "k_rumia": {
      "short": "1/3/6/10/15",
      "detail": "ラウンド終了時、取得枚数に応じて得点。1 枚 1 点／2 枚 3 点／3 枚 6 点／4 枚 10 点／5 枚 15 点"
    },
    "k_daiyousei": {
      "short": "同手番のチルノ/大妖精で+1",
      "detail": "取得時、他の人が同じ手番にチルノか大妖精を取っていたら、その人数 × 1 点"
    },
    "k_maid": {
      "short": "最多+4／最少-4",
      "detail": "ラウンド終了時、妖精メイドの枚数が最多なら +4 点／最少 -4 点"
    },
    "k_kozue": {
      "short": "山札4枚見て1枚",
      "detail": "取得時、山札の上 4 枚を見て、その中から 1 枚を取得"
    },
    "k_cirno": {
      "short": "最少で-9",
      "detail": "ゲーム終了時、チルノの保有数が最少だと -9 点"
    },
    "s_yukari": {
      "short": "3点",
      "detail": "3 点"
    },
    "s_ran": {
      "short": "2点+連携",
      "detail": "2 点／ラウンド終了時、八雲紫・橙を取得しているなら +1 点"
    },
    "s_chen": {
      "short": "1点+連携",
      "detail": "1 点／ラウンド終了時、八雲紫・八雲藍を取得しているなら +1 点"
    },
    "s_spring": {
      "short": "最多+6／2位+3",
      "detail": "ラウンド終了時、集めた春アイコンの数で順位を競う。1 位 6 点／2 位 3 点"
    },
    "s_yuyuko": {
      "short": "春の最多で+4×枚",
      "detail": "ラウンド終了時、春アイコンの取得数が最多なら、所持 1 枚につき +4 点"
    },
    "s_youmu": {
      "short": "次の春で春と点を追加",
      "detail": "取得後、次に取得した春のアイコン数ぶんの点と春アイコンを獲得（同一手番で妖夢は1 枚しか反応しない）"
    },
    "s_alice_hourai": {
      "short": "種類数で1/4/9/16点",
      "detail": "ラウンド終了時、所持している人形の種類に応じて得点。1 種 1 点／2 種 4 点／3 種 9 点／4 種 16 点（同種を複数枚所持していても加点は無い）"
    },
    "s_alice_shanghai": {
      "short": "種類数で1/4/9/16点",
      "detail": "ラウンド終了時、所持している人形の種類に応じて得点。1 種 1 点／2 種 4 点／3 種 9 点／4 種 16 点（同種を複数枚所持していても加点は無い）"
    },
    "s_alice_kyo": {
      "short": "種類数で1/4/9/16点",
      "detail": "ラウンド終了時、所持している人形の種類に応じて得点。1 種 1 点／2 種 4 点／3 種 9 点／4 種 16 点（同種を複数枚所持していても加点は無い）"
    },
    "s_alice_french": {
      "short": "種類数で1/4/9/16点",
      "detail": "ラウンド終了時、所持している人形の種類に応じて得点。1 種 1 点／2 種 4 点／3 種 9 点／4 種 16 点（同種を複数枚所持していても加点は無い）"
    },
    "s_prism": {
      "short": "3枚で10点",
      "detail": "ラウンド終了時、3 枚 集めるごとに 10 点"
    },
    "s_letty": {
      "short": "2枚毎6点／春アイコン-1",
      "detail": "ラウンド終了時、2 枚集めるごとに 6 点 ＆ 春アイコン -1"
    },
    "s_lily": {
      "short": "4枚毎+12",
      "detail": "ゲーム終了時、4 枚ごとに +12 点"
    },
    "y_kaguya": {
      "short": "3点",
      "detail": "3 点"
    },
    "y_eirin": {
      "short": "2点+連携",
      "detail": "2 点／同じ手番に誰かが蓬莱山輝夜を取っていれば +1 点"
    },
    "y_reisen": {
      "short": "1点+幻覚",
      "detail": "1 点／取得時、他のプレイヤーは同一手番の取得カードが「鈴仙」に見える。（同時に鈴仙をプレイしたプレイヤーは影響を受けない）"
    },
    "y_tewi": {
      "short": "2/6/0点",
      "detail": "ラウンド終了時、1 枚 2 点／2 枚 6 点 3 枚目以降／0 点"
    },
    "y_mystia": {
      "short": "任意枚を裏返す",
      "detail": "取得時、手元の他のカードを任意の枚数裏返せる。裏返したカードはカード名なし・効果は +2 点のみのカードとして扱う"
    },
    "y_keine": {
      "short": "効果をコピー",
      "detail": "取得時、自身が取得済みの他のカード 1 枚のコピーとなる"
    },
    "y_riggle": {
      "short": "同手番1枚+1",
      "detail": "自分以外にリグルを獲得したプレイヤー 1 人につき1 点"
    },
    "y_rabbit": {
      "short": "最多+6／2位+3",
      "detail": "ラウンド終了時、集めた兎アイコンの数で順位を競う。1 位 6 点／2 位 3 点"
    },
    "y_reimu": {
      "short": "累計ペア4/5/6…",
      "detail": "ゲーム終了時、2 枚ペア 1 組につき得点。1 ペア目 4 点、2 ペア目 5 点、3 ペア目 6 点…（1ペア増えるごとに取得点数が 1 点ずつ増えていく）"
    },
    "y_marisa": {
      "short": "0/2/8/13/21",
      "detail": "ラウンド終了時、取得枚数に応じて得点。1 枚 0 点／2 枚 2 点／3 枚 8 点／4 枚 13 点／5 枚 21 点"
    },
    "y_moko": {
      "short": "最多+6／最少-6",
      "detail": "ゲーム終了時、最多 +6 点／最少 -6 点"
    },
    "f_kanako": {
      "short": "3点",
      "detail": "3 点"
    },
    "f_suwako": {
      "short": "2点",
      "detail": "2 点"
    },
    "f_sanae": {
      "short": "1点+次を3倍",
      "detail": "1 点／取得後、次に八坂神奈子か洩矢諏訪子を取ると それらの点数を 3 倍する（複数持っていても重ならない）"
    },
    "f_hina": {
      "short": "1枚-3／2枚+7",
      "detail": "ラウンド終了時、1 枚 -3 点／2 枚以上 +7 点"
    },
    "f_aya": {
      "short": "手札+2枚",
      "detail": "取得時、手札から 2 枚追加で取得する。その後山札から 2 枚引き、このカードは山札へ戻る"
    },
    "f_nitori": {
      "short": "次に名前指定で交換",
      "detail": "次にカードを取得したあと、カード名を指定する。いずれかの手札にある指名したカードとこのカードを交換する（複数ある場合はランダムに選ばれる）"
    },
    "f_minoriko": {
      "short": "1/3/6/10/15",
      "detail": "ラウンド終了時、取得枚数に応じて得点。1 枚 1 点／2 枚 3 点／3 枚 6 点／4 枚 10 点／5 枚 15 点"
    },
    "f_shizuha": {
      "short": "秋穣子とペア3点",
      "detail": "ラウンド終了時、秋穣子とのペア1 組につき 3 点"
    },
    "f_faith": {
      "short": "10個到達で8/5/2点",
      "detail": "ラウンド中、信仰アイコン合計が 10 に達した人から順に 8 点・5 点・2 点（ラウンド終了時に未到達でも、アイコン数の多い順に残りの順位点）"
    },
    "f_momiji": {
      "short": "0枚-3／偶数+5",
      "detail": "ゲーム終了時に、紅葉の枚数が0 枚 -3 点／偶数枚 +5 点／奇数枚 0 点"
    }
  };


  function incidentById(id) {
    return INCIDENTS[id] || null;
  }

  // セット内の key → 定義（メイン＋継続カード＋追加カード）
  function buildCardMap(incident, intruderDef) {
    const map = {};
    for (const def of incident.main) map[def.key] = def;
    map[incident.dessert.key] = incident.dessert;
    if (intruderDef) map[intruderDef.key] = intruderDef;
    // 文言は CARD_TEXTS を正とする（card-texts.txt の編集内容）
    for (const key of Object.keys(map)) {
      if (CARD_TEXTS[key]) map[key].text = CARD_TEXTS[key];
    }
    return map;
  }

  // メインデッキの構成（インスタンス生成）。icons ありはアイコン数違いに展開する。
  // インスタンス = { key, icons? }（軽量オブジェクト・定義は CARD_BY から引く）
  function buildMainDeck(incident, intruderDef) {
    const defs = intruderDef ? incident.main.concat([intruderDef]) : incident.main;
    const deck = [];
    for (const def of defs) {
      if (def.iconCounts) {
        for (const [iconsStr, n] of Object.entries(def.iconCounts)) {
          const icons = Number(iconsStr);
          for (let i = 0; i < n; i++) deck.push({ key: def.key, icons });
        }
      } else {
        for (let i = 0; i < def.count; i++) deck.push({ key: def.key });
      }
    }
    return deck;
  }

  function buildDessertPool(incident) {
    const def = incident.dessert;
    const pool = [];
    for (let i = 0; i < def.pool; i++) pool.push({ key: def.key });
    return pool;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RULES, INCIDENTS, INCIDENT_IDS, incidentById, buildCardMap, buildMainDeck, buildDessertPool };
  }
  if (typeof window !== 'undefined') {
    window.Data = { RULES, INCIDENTS, INCIDENT_IDS, incidentById, buildCardMap, buildMainDeck, buildDessertPool };
  }
})();






















