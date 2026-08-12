import { check, eq, section, summary } from './helpers.mjs';
import { mapAnchoredItemsById, anchorMatchConfidence, canonicalizeAnchoredPageItems } from '../src/recognize/anchorMatch.ts';

function char(id, cx, cy, w = 20, h = 20) {
  return {
    id,
    text: null,
    cx,
    cy,
    bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    pt: 12,
    conf: 0,
    note: 'empty',
    source: 'manual',
    edited: false,
    group: 'body',
    kind: 'text',
  };
}

section('严格 id 一对一：items[id] → chars[id]');
const width = 1000;
const height = 1200;
const chars = [
  char('a', 200, 100),
  char('b', 200, 200),
  char('c', 200, 300),
];
const items = [
  { id: 0, char: '乙', confidence: 0.92, rx: 0.2, ry: 200 / height, note: 'ok' },
  { id: 1, char: '甲', confidence: 0.91, rx: 0.2, ry: 100 / height, note: 'ok' },
  { id: 2, char: '丙', confidence: 0.9, rx: 0.2, ry: 300 / height, note: 'ok' },
];
const matched = mapAnchoredItemsById(items, chars, new Set(), width, height);
eq('id=0 写入字框 a', matched.get('a')?.char, '乙');
eq('id=1 写入字框 b', matched.get('b')?.char, '甲');
eq('id=2 写入字框 c', matched.get('c')?.char, '丙');
eq('每个字框最多一条', matched.size, 3);

section('canonicalize 补齐缺失 id');
const sparse = [
  { id: 0, char: '甲', confidence: 0.9, rx: 0.2, ry: 0.1, note: 'ok' },
  { id: 2, char: '丙', confidence: 0.88, rx: 0.2, ry: 0.3, note: 'ok' },
];
const full = canonicalizeAnchoredPageItems(sparse, 3);
eq('补齐后长度', full.length, 3);
eq('缺失 id=1 为空', full[1].char, null);

section('邻列同高：仍按 id 一对一');
const twoColChars = [
  char('left', 200, 300),
  char('right', 380, 300),
];
const crossItems = [
  { id: 0, char: '右', confidence: 0.93, rx: 0.38, ry: 300 / height, note: 'ok' },
  { id: 1, char: '左', confidence: 0.92, rx: 0.2, ry: 300 / height, note: 'ok' },
];
const crossMatched = mapAnchoredItemsById(crossItems, twoColChars, new Set(), width, height);
eq('id=0 填 left 框', crossMatched.get('left')?.char, '右');
eq('id=1 填 right 框', crossMatched.get('right')?.char, '左');

section('4x3 网格 id 映射');
const gridW = 1000;
const gridH = 1200;
const gridChars = [];
for (let col = 0; col < 4; col += 1) {
  const cx = 150 + col * 80;
  for (let row = 0; row < 3; row += 1) {
    gridChars.push(char(`${col}${row}`, cx, 400 + row * 50));
  }
}
const gridItems = [];
for (let col = 0; col < 4; col += 1) {
  const labels = [['倪', '为', '勤'], ['倪', '为', '禄'], ['邵', '久', '金'], ['倪', '为', '兵']][col];
  const cx = 150 + col * 80;
  for (let row = 0; row < 3; row += 1) {
    gridItems.push({
      id: col * 3 + row,
      char: labels[row],
      confidence: 0.9,
      rx: cx / gridW,
      ry: (400 + row * 50) / gridH,
      note: 'ok',
    });
  }
}
const gridMatched = mapAnchoredItemsById(gridItems, gridChars, new Set(), gridW, gridH);
eq('4x3 左下列「勤」', gridMatched.get('02')?.char, '勤');
eq('4x3 右下列「兵」', gridMatched.get('32')?.char, '兵');

section('锚点坐标锁定后置信不降');
const conf = anchorMatchConfidence(
  { id: 0, char: '甲', confidence: 0.95, rx: 0.2, ry: 100 / height },
  chars[0],
  0,
  width,
  height,
);
check('同 id 且坐标在锚点置信保持', conf >= 0.94);

summary('anchor match');
