'use strict';

// 異変パック定義。
// カードは「kind（メカニズム）」+「name/icon/color（キャラ味付け）」+「count（枚数）」+「params」。
// IIFE で包む: ブラウザでは全 script が同一グローバルスコープのため、const 宣言の衝突を防ぐ。

(function () {
  const RULES = {
    ROUNDS: 3,
    // スシGOパーティー準拠: 2-3人10枚 / 4-5人9枚
    HAND_SIZES: { 2: 10, 3: 10, 4: 9, 5: 9 },
    DESSERT_MIX: [5, 3, 2], // ラウンド1/2/3 のデザート混入数
    // 多数決の標準配点（DESIGN 2-4）: 2人=1位4点/同点各2点、3人以上=1位6点/一意の2位3点
    MAKI_POINTS: { first: 6, second: 3 },
    MAKI_2P: { first: 4, tie: 2 },
    // パス方向（DESIGN 4）: ラウンド1・3 は左、ラウンド 2 は右（-1=左隣 / 1=右隣）
    PASS_DIRS: [-1, 1, -1],
  };

  // ---------------- 紅霧異変（紅魔郷） ----------------
  const SCARLET_MAIN = [
    { key: 'k_remi', kind: 'instant', points: 3, name: 'レミリア', icon: '王', color: '#8b1a2b', count: 3 },
    { key: 'k_fran', kind: 'instant', points: 2, discardBonus: 2, name: 'フランドール', icon: '妹', color: '#c22a4e', count: 4 },
    { key: 'k_meirin', kind: 'instant', points: 1, comboKeys: ['k_sakuya'], comboBonus: 1, name: '紅美鈴', icon: '門', color: '#b8434a', count: 5 },
    { key: 'k_sakuya', kind: 'instant', points: 3, absentKeys: ['k_remi', 'k_fran'], name: '十六夜咲夜', icon: 'メ', color: '#9aa5b1', count: 8 },
    { key: 'k_patch', kind: 'kindCount', offset: -3, name: 'パチュリー', icon: '図', color: '#8e3b8e', count: 3 },
    { key: 'k_rumia', kind: 'collect', table: [1, 3, 6, 10, 15], name: 'ルーミア', icon: '闇', color: '#3a3a42', count: 8 },
    { key: 'k_daiyousei', kind: 'roundComboCount', targetKey: 'k_cirno', per: 1, name: '大妖精', icon: '精', color: '#b8d8e8', count: 8 },
    { key: 'k_maid', kind: 'temaki', most: 4, least: -4, name: '妖精メイド', icon: '奉', color: '#5f8f3e', count: 12 },
    { key: 'k_kozue', kind: 'deckPeek', peek: 4, name: '小悪魔', icon: '悪', color: '#3d7ea6', count: 3 },
  ];
  const SCARLET_DESSERT = { key: 'k_cirno', kind: 'dessertLeast', least: -9, name: 'チルノ', icon: '⑨', color: '#5bb8d4', pool: 15 };

  // ---------------- 春雪異変（妖々夢） ----------------
  const SPRING_MAIN = [
    { key: 's_yukari', kind: 'instant', points: 3, name: '八雲紫', icon: '境', color: '#7b4ea3', count: 3 },
    { key: 's_ran', kind: 'instant', points: 2, comboKeys: ['s_yukari', 's_chen'], comboBonus: 1, name: '八雲藍', icon: '狐', color: '#d9a441', count: 4 },
    { key: 's_chen', kind: 'instant', points: 1, comboKeys: ['s_yukari', 's_ran'], comboBonus: 1, name: '橙', icon: '橙', color: '#d97e30', count: 5 },
    { key: 's_spring', kind: 'maki', iconCounts: { 1: 4, 2: 5, 3: 3 }, name: '春', icon: '春', color: '#e88ab8', count: 12 },
    { key: 's_yuyuko', kind: 'springMost', most: 4, name: '西行寺幽々子', icon: '姫', color: '#d8cfe8', count: 3 },
    { key: 's_youmu', kind: 'springSteal', steal: 1, pointPer: 1, name: '魂魄妖夢', icon: '庭', color: '#8fb8a0', count: 3 },
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

  // ---------------- 永夜異変（永夜抄） ----------------
  // 乱入者（霊夢/魔理沙）はランダムでいずれか 1 種のみデッキに組み込まれる
  const ETERNAL_MAIN = [
    { key: 'y_kaguya', kind: 'instant', points: 3, name: '蓬莱山輝夜', icon: '夜', color: '#c9a84c', count: 3 },
    { key: 'y_eirin', kind: 'instant', points: 2, pointsIfNoKey: { key: 'y_kaguya', points: 3 }, swap: true, name: '八意永琳', icon: '薬', color: '#6a8fb8', count: 4 },
    { key: 'y_reisen', kind: 'instant', points: 1, hidden: true, name: '鈴仙', icon: '幻', color: '#b85a7a', count: 5 },
    { key: 'y_tewi', kind: 'tofu', table: [2, 6, 0], name: '因幡てゐ', icon: '幸', color: '#6a9955', count: 8 },
    { key: 'y_mystia', kind: 'flip', flipPoints: 2, name: 'ミスティア', icon: '歌', color: '#a67c52', count: 3 },
    { key: 'y_keine', kind: 'copy', name: '上白沢慧音', icon: '史', color: '#4a7ea6', count: 3 },
    { key: 'y_riggle', kind: 'coop', points: 1, name: 'リグル', icon: '蜻', color: '#c87a4a', count: 8 },
    { key: 'y_rabbit', kind: 'maki', iconCounts: { 1: 4, 2: 5, 3: 3 }, name: '玉兎', icon: '兎', color: '#e8e6e3', count: 12 },
  ];
  const ETERNAL_INTRUDERS = [
    { key: 'y_reimu', kind: 'pair', points: 4, gameEnd: true, gameEndTotalAtLeast: { count: 7, points: 7 }, name: '博麗霊夢', icon: '夢', color: '#c22a4e', count: 8 },
    { key: 'y_marisa', kind: 'set3', points: 9, gameEnd: true, gameEndMost: { points: 9 }, name: '霧雨魔理沙', icon: '星', color: '#4a4a52', count: 8 },
  ];
  const ETERNAL_DESSERT = { key: 'y_moko', kind: 'dessertRound', roundPenalty: -1, endMostPer: 2, name: '藤原妹紅', icon: '火', color: '#d15a32', pool: 15 };

  // ---------------- パック ----------------
  const INCIDENTS = {
    scarlet: {
      id: 'scarlet',
      name: '紅霧異変',
      subtitle: '紅の館の夜会',
      theme: 'キャラ間連携',
      main: SCARLET_MAIN,
      dessert: SCARLET_DESSERT,
      intruders: null,
    },
    spring: {
      id: 'spring',
      name: '春雪異変',
      subtitle: '白玉楼の桜見宴会',
      theme: '春をめぐる攻防',
      main: SPRING_MAIN,
      dessert: SPRING_DESSERT,
      intruders: null,
    },
    eternal: {
      id: 'eternal',
      name: '永夜異変',
      subtitle: '永遠亭の月見宴会',
      theme: '数量の管理とジレンマ',
      main: ETERNAL_MAIN,
      dessert: ETERNAL_DESSERT,
      intruders: ETERNAL_INTRUDERS,
    },
  };

  const INCIDENT_IDS = ['scarlet', 'spring', 'eternal'];

  function incidentById(id) {
    return INCIDENTS[id] || null;
  }

  // パック内の key → 定義（メイン＋デザート＋乱入者）
  function buildCardMap(incident, intruderDef) {
    const map = {};
    for (const def of incident.main) map[def.key] = def;
    map[incident.dessert.key] = incident.dessert;
    if (intruderDef) map[intruderDef.key] = intruderDef;
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
