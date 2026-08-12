import { check, eq, section, summary } from './helpers.mjs';
import {
  clusterCharColumns,
  classifyColumnKind,
  sortCharsReadingOrder,
  flagColumnSpacingAnomalies,
  applyColumnStructure,
  snapCharsToColumnCenters,
  dedupeOverlappingChars,
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

summary('columns');
