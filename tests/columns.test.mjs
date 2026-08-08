import { check, eq, section, summary } from './helpers.mjs';
import {
  clusterCharColumns,
  classifyColumnKind,
  sortCharsReadingOrder,
  flagColumnSpacingAnomalies,
  applyColumnStructure,
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

const rankPair = [mkChar('r1', 50, 200), mkChar('r2', 58, 200)];
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
const structured = applyColumnStructure([
  ...rankPair.map((c) => ({ ...c, group: 'body' })),
]);
check('排行标签归入 rank 组', structured.every((c) => c.group === 'rank'));

summary('columns');
