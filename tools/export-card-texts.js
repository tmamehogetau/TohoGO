'use strict';
// カードの3種テキスト（カード面 / ツールチップ / カード一覧）を1つのテキストに書き出す。
// 使い方: node tools/export-card-texts.js [出力パス]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Data = require(path.join(ROOT, 'data.js'));

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'card-texts.txt');

// game.js から descOf / tinyDesc をそのまま取り出して評価する
const src = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
function sliceFn(name, nextMarker) {
  const start = src.indexOf(`  function ${name}(def) {`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  const end = src.indexOf(nextMarker, start);
  return src.slice(start, end);
}
const descBody = sliceFn('descOf', '  // カード面用の極短テキスト');
const tinyBody = sliceFn('tinyDesc', '  // ---- 数アイコン');

function makeFns(map) {
  const nameOf = (key) => (map[key] ? map[key].name : key);
  const descOf = new Function('nameOf', 'Data', 'MAKI', 'gameEndBonusText', descBody + '\nreturn descOf;')(
    nameOf, Data, Data.RULES.MAKI_POINTS, () => '',
  );
  const tinyDesc = new Function('nameOf', 'Data', 'MAKI', 'gameEndBonusText', tinyBody + '\nreturn tinyDesc;')(
    nameOf, Data, Data.RULES.MAKI_POINTS, () => '',
  );
  return { descOf, tinyDesc };
}

const lines = [];
const push = (s = '') => lines.push(s);

push('東方数紙業 カードテキスト一覧');
push(`生成: ${new Date().toISOString().slice(0, 10)}`);
push('');
push('このファイルは game.js の descOf()（詳細説明）と tinyDesc()（カード面の短縮表記）から');
push('自動生成しています（tools/export-card-texts.js）。ゲーム内の表示と常に一致します。');
push('');
push('■ カード上の説明   = カード面に直接描かれる短いテキスト（tinyDesc）');
push('■ ツールチップ     = カードにマウスを乗せたときの title 属性（カード名：詳細）');
push('■ カード一覧       = 「ステージカード一覧」で表示される説明文（descOf）');
push('※ 右パネルの拡大表示も、ツールチップと同じ「カード名＋詳細」を出します。');
push('');
push('='.repeat(72));

for (const id of Data.INCIDENT_IDS) {
  const inc = Data.incidentById(id);
  const map = Data.buildCardMap(inc, null);
  for (const c of inc.intruders || []) {
    const m = Data.buildCardMap(inc, c);
    map[c.key] = m[c.key];
  }
  const { descOf, tinyDesc } = makeFns(map);

  push('');
  push(`■ ${inc.name}（${inc.subtitle}）`);
  push('='.repeat(72));

  const cardLabel = (def) => (def.variant ? `${def.name}（${def.variant}）` : def.name);
  const countOf = (def) => {
    if (def.iconCounts) return Object.values(def.iconCounts).reduce((a, b) => a + b, 0);
    return def.count || def.pool || 0;
  };
  const iconCompo = (def) => {
    if (!def.iconCounts) return '';
    return Object.entries(def.iconCounts)
      .map(([c, n]) => `アイコン${c}個×${n}枚`)
      .join(' ');
  };

  // 同じグループ（アリスの人形 4 種など）は 1 行にまとめる
  const rows = [];
  const seenGroup = new Map();
  for (const def of inc.main) {
    if (def.group) {
      if (seenGroup.has(def.group)) {
        seenGroup.get(def.group).variants.push(def.variant || def.name);
        seenGroup.get(def.group).count += def.count || 1;
        continue;
      }
      const row = { def, label: cardLabel(def), note: '', variants: [def.variant || def.name], count: def.count || 1 };
      seenGroup.set(def.group, row);
      rows.push(row);
      continue;
    }
    rows.push({ def, label: cardLabel(def), note: '', variants: null, count: countOf(def) });
  }
  for (const def of inc.intruders || []) rows.push({ def, label: cardLabel(def), note: '（どちらか1種のみ入る）', variants: null, count: countOf(def) });
  rows.push({ def: inc.dessert, label: `〔継続カード〕${inc.dessert.name}`, note: '', variants: null, count: countOf(inc.dessert) });

  for (const row of rows) {
    const { def, label, note } = row;
    const variantsText = row.variants && row.variants.length > 1
      ? `（${row.variants.length}種: ${row.variants.join('・')}）`
      : (row.variants ? `（${row.variants[0]}）` : '');
    push('');
    push(`── ${label.replace(/（[^）]*）$/, '')}${variantsText}${note} ／ ${row.count} 枚${iconCompo(def) ? ` ／ ${iconCompo(def)}` : ''}`);
    push(`  カード上  : ${tinyDesc(def)}`);
    push(`  ツールチップ: ${def.group ? def.groupLabel : label}：${descOf(def)}`);
    push(`  カード一覧: ${descOf(def)}`);
  }
}

push('');
push('='.repeat(72));
push('※ カード一覧ではカード名・枚数（アリスは「（4種）」）と、マキ系はアイコン構成も併記されます。');
push('※ ツールチップは同じ詳細文の前に「カード名：」が付きます。');
push('');

fs.writeFileSync(OUT, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`書き出しました: ${OUT}（${lines.length} 行）`);

