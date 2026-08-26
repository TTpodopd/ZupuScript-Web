import { check, eq, section, summary } from './helpers.mjs';
import {
  clusterCharColumns,
  classifyColumnKind,
  sortCharsReadingOrder,
  flagColumnSpacingAnomalies,
  applyColumnStructure,
  snapCharsToColumnCenters,
  dedupeOverlappingChars,
  detectHandwrittenRankPairs,
} from '../src/segment/columns.ts';

function mkChar(id, cx, cy, h = 18) {
  return {
    id,
    text: null,
    cx,
    cy,
    bbox: [cx - 9, cy - h / 2, cx + 9, cy + h / 2],
    pt: 0,
    conf: 0.9,
    note: 'ok',
    source: 'manual',
    edited: false,
    group: 'body',
    kind: 'text',
  };
}

section('列聚类');
const verticalCol = [
  mkChar('a', 100, 40),
  mkChar('b', 102, 70),
  mkChar('c', 98, 100),
];
const cols = clusterCharColumns(verticalCol, 18);
eq('竖排三字为一列', cols.length, 1);
check('列类型为竖排人名', cols[0].kind === 'vertical_name');

const rankPair = [mkChar('r1', 50, 200), mkChar('r2', 70, 200)];
check('横向两字为排行标签', classifyColumnKind(rankPair, 18) === 'rank_label');

section('阅读顺序');
const page = [
  ...verticalCol,
  mkChar('d', 140, 40),
  mkChar('e', 138, 70),
];
const ordered = sortCharsReadingOrder(page, 18);
check('列从右到左', ordered[0].cx > ordered[ordered.length - 1].cx);

section('字距异常');
const gaps = [
  mkChar('g1', 200, 40),
  mkChar('g2', 200, 68),
  mkChar('g3', 200, 96),
  mkChar('g4', 200, 200),
];
const flagged = flagColumnSpacingAnomalies(gaps, 18);
check('大间距标记漏字嫌疑', flagged.size > 0);

section('applyColumnStructure');
// 横向相邻且不重叠的两字（排行标签式）：dedupe 不得误删，结构处理后数量守恒
const structured = applyColumnStructure([
  ...rankPair.map((c) => ({ ...c, group: 'body' })),
]);
check('横向相邻两字均保留', structured.length === 2);

section('列内 x 吸附');
const drifted = [
  mkChar('d1', 198, 40),
  mkChar('d2', 205, 70),
  mkChar('d3', 201, 100),
];
const snapped = snapCharsToColumnCenters(drifted, 18);
check('同列 cx 对齐', snapped.every((c) => Math.abs(c.cx - snapped[0].cx) < 0.01));

section('谱系图 4 列不合并');
const gridCols = [];
for (let col = 0; col < 4; col += 1) {
  const cx = 100 + col * 28;
  for (let row = 0; row < 3; row += 1) {
    gridCols.push(mkChar(`g${col}${row}`, cx + (col % 2), 200 + row * 32));
  }
}
const gridCluster = clusterCharColumns(gridCols, 18);
eq('4 列竖排网格应分为 4 列', gridCluster.length, 4);

section('重叠字框去重');
const overlap = [
  mkChar('o1', 200, 300),
  mkChar('o2', 203, 302),
];
const deduped = dedupeOverlappingChars(overlap, 18);
check('重叠框只保留一个', deduped.length === 1);

section('手写排行标签定向检测');
const handwrittenRanks = [
  mkChar('long', 50, 180, 20), mkChar('son1', 70, 183, 18),
  mkChar('second', 115, 181, 22), mkChar('son2', 136, 179, 19),
  mkChar('third', 180, 182, 21), mkChar('son3', 201, 180, 18),
];
const rankPairs = detectHandwrittenRankPairs(handwrittenRanks, 20);
eq('同行多组双字标签全部检出', rankPairs.length, 3);
const refinedRanks = applyColumnStructure(handwrittenRanks, 20);
check('检出标签标记为 rank', refinedRanks.every((char) => char.group === 'rank'));
for (const pair of rankPairs) {
  const first = refinedRanks.find((char) => char.id === pair.firstId);
  const second = refinedRanks.find((char) => char.id === pair.secondId);
  check(`排行双框 y 对齐 ${pair.firstId}`, Math.abs(first.cy - second.cy) < 0.01);
}

const ordinaryHorizontal = [
  mkChar('t1', 40, 260), mkChar('t2', 60, 260), mkChar('t3', 80, 260), mkChar('t4', 100, 260),
];
eq('连续横排正文不误判为排行双字组', detectHandwrittenRankPairs(ordinaryHorizontal, 20).length, 0);
section('右侧世次标题列');
const rightTitlePage = [
  mkChar('body1', 80, 80, 18), mkChar('body2', 120, 80, 18), mkChar('body3', 160, 80, 18),
  mkChar('body4', 80, 120, 18), mkChar('body5', 120, 120, 18), mkChar('body6', 160, 120, 18),
  mkChar('gen1', 280, 60, 26), mkChar('gen2', 282, 92, 26), mkChar('gen3', 279, 124, 26),
];
const rightStructured = applyColumnStructure(rightTitlePage, 18, 320);
check('右侧连续大字竖列标记为标题', rightStructured.filter((char) => char.id.startsWith('gen')).every((char) => char.group === 'title'));
check('正文分组保持不变', rightStructured.filter((char) => char.id.startsWith('body')).every((char) => char.group === 'body'));
summary('columns');
