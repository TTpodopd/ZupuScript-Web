/**
 * 同形指纹聚类与传播回归：
 * - 指纹对位移/粗细微差的容忍度，与不同字形的区分度；
 * - 聚类：同形归簇、异形分簇、空裁剪剔除；
 * - 传播：强种子填空位/提同字置信；结构字「公/氏」不覆盖已有汉字；高证据异字、人工字不碰。
 * 运行：node --experimental-strip-types --no-warnings --loader ./tests/alias-loader.mjs tests/glyph-cluster.test.mjs
 */
import { check, eq, section, summary } from './helpers.mjs';
import {
  glyphFingerprint,
  clusterFingerprints,
  hammingDistance,
  isSameGlyph,
  propagateLocalGlyphs,
  FINGERPRINT_MAX_HAMMING,
} from '../src/recognize/glyphCluster.ts';

function makeBin(width, height, fill) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y) ? 1 : 0;
  }
  return data;
}

// 「T」形：12×12，顶横 + 中竖
const tGlyph = (dx = 0, dy = 0) => (x, y) => {
  const xx = x - dx;
  const yy = y - dy;
  return (yy >= 2 && yy <= 4 && xx >= 2 && xx <= 9) || (xx >= 5 && xx <= 6 && yy >= 2 && yy <= 10);
};
// 「L」形：左竖 + 底横
const lGlyph = (x, y) => ((x >= 2 && x <= 3 && y >= 2 && y <= 10) || (y >= 9 && y <= 10 && x >= 2 && x <= 9));

section('指纹：同形容忍位移与断笔');
{
  const bin = makeBin(24, 24, tGlyph());
  const shifted = makeBin(24, 24, tGlyph(1, 0));
  const broken = makeBin(24, 24, (x, y) => tGlyph()(x, y) && !(x === 6 && y === 7));
  const fA = glyphFingerprint(bin, 24, 24, [2, 2, 10, 10]);
  const fB = glyphFingerprint(shifted, 24, 24, [2, 2, 10, 10]);
  const fC = glyphFingerprint(broken, 24, 24, [2, 2, 10, 10]);
  check('位移 1px 判同形', isSameGlyph(fA, fB), `d=${hammingDistance(fA, fB)}`);
  check('断笔 1px 判同形', isSameGlyph(fA, fC), `d=${hammingDistance(fA, fC)}`);
}

section('指纹：不同字形区分');
{
  const binT = makeBin(24, 24, tGlyph());
  const binL = makeBin(24, 24, lGlyph);
  const fT = glyphFingerprint(binT, 24, 24, [2, 2, 10, 10]);
  const fL = glyphFingerprint(binL, 24, 24, [2, 2, 10, 10]);
  check('T/L 汉明距离超阈值', !isSameGlyph(fT, fL), `d=${hammingDistance(fT, fL)} > ${FINGERPRINT_MAX_HAMMING}`);
}

section('聚类：同形归簇、空裁剪剔除');
{
  const binT = makeBin(24, 24, tGlyph());
  const binL = makeBin(24, 24, lGlyph);
  const empty = new Uint8Array(24 * 24);
  const fps = [
    glyphFingerprint(binT, 24, 24, [2, 2, 10, 10]),
    glyphFingerprint(makeBin(24, 24, tGlyph(1, 1)), 24, 24, [2, 2, 10, 10]),
    glyphFingerprint(binL, 24, 24, [2, 2, 10, 10]),
    glyphFingerprint(empty, 24, 24, [2, 2, 10, 10]),
  ];
  const clusters = clusterFingerprints(fps);
  eq('两个有效簇', clusters.length, 2);
  const tCluster = clusters.find((m) => m.includes(0));
  check('T 形两位同簇', tCluster?.includes(1) === true);
  const lCluster = clusters.find((m) => m.includes(2));
  eq('L 形独立成簇', lCluster?.length, 1);
}

section('传播：强种子填空位、提同字；结构字不覆盖异字');
{
  const binT = makeBin(24, 24, tGlyph());
  const binShift = makeBin(24, 24, tGlyph(1, 0));
  const binL = makeBin(24, 24, lGlyph);
  const chars = [
    { id: 'a', bbox: [2, 2, 10, 10], edited: false, source: 'local', text: '公', conf: 0.95 },
    { id: 'b', bbox: [2, 2, 10, 10], edited: false, source: 'local', text: null, conf: 0 },
    { id: 'c', bbox: [3, 2, 10, 10], edited: false, source: 'local', text: '公', conf: 0.5 },
    { id: 'd', bbox: [2, 2, 10, 10], edited: false, source: 'local', text: '松', conf: 0.3 },
    { id: 'e', bbox: [2, 2, 10, 10], edited: false, source: 'local', text: '松', conf: 0.8 },
    { id: 'f', bbox: [40, 40, 10, 10], edited: true, source: 'manual', text: '王', conf: 0.99 }, // 空区域，不入簇
    { id: 'g', bbox: [2, 2, 10, 10], edited: false, source: 'local', text: '乙', conf: 0.2 },
  ];
  const bins = [binT, binShift, binT, binT, binT, binT, binL];
  // 用整页二值图：把每个字形放到不同位置（简化：全部同位置，bbox 相同则指纹相同）
  const page = makeBin(48, 48, (x, y) => {
    if (x < 24 && y < 24) return tGlyph()(x, y);
    if (x >= 24 && y < 24) return tGlyph(-1, 0)(x - 24, y); // b 用位移版
    if (x < 24 && y >= 24) return lGlyph(x, y - 24);
    return false;
  });
  // 代码库 bbox 约定为 [x0, y0, x1, y1]。b 指向整页右上的位移版 T（源 1px 位移 ≈ 真实扫描抖动）；g 指向左下 L 形
  const bboxes = [
    [2, 2, 12, 12],
    [25, 2, 35, 12],
    [2, 2, 12, 12],
    [2, 2, 12, 12],
    [2, 2, 12, 12],
    [40, 40, 48, 48],
    [2, 26, 12, 36],
  ];
  const pageChars = chars.map((c, i) => ({ ...c, bbox: bboxes[i] }));
  const results = new Map(pageChars.map((c) => [c.id, { key: c.id, text: c.text, confidence: c.conf, candidates: [] }]));
  const improved = propagateLocalGlyphs(pageChars, results, page, 48, 48);
  check('传播发生（空位回填 + 同字提权）', improved >= 2, `improved=${improved}`);
  eq('空位 b 填种子字「公」', results.get('b').text, '公');
  check('空位 b 置信 0.88', results.get('b').confidence === 0.88);
  check('同字 c 提至 ≥0.88', results.get('c').confidence >= 0.88);
  eq('结构字「公」不覆盖低证据异字 d', results.get('d').text, '松');
  eq('高证据异字 e 保留原字', results.get('e').text, '松');
  eq('人工字 f 不碰', results.get('f').text, '王');
  eq('异形 g（L 形）不被 T 种子覆盖', results.get('g').text, '乙');
}

section('传播：非结构字强种子仍可覆盖低证据异字；公不覆盖周/氏');
{
  const page = makeBin(48, 48, (x, y) => {
    if (x < 24 && y < 24) return tGlyph()(x, y);
    return false;
  });
  const box = [2, 2, 12, 12];
  const overwriteChars = [
    { id: 'seed', bbox: box, edited: false, source: 'local', text: '子', conf: 0.95 },
    { id: 'weak', bbox: box, edited: false, source: 'local', text: '松', conf: 0.3 },
  ];
  const overwriteResults = new Map(overwriteChars.map((c) => [c.id, { key: c.id, text: c.text, confidence: c.conf, candidates: [] }]));
  propagateLocalGlyphs(overwriteChars, overwriteResults, page, 48, 48);
  eq('非结构字「子」可覆盖低证据异字', overwriteResults.get('weak').text, '子');

  const structuralChars = [
    { id: 'gong', bbox: box, edited: false, source: 'local', text: '公', conf: 0.95 },
    { id: 'zhou', bbox: box, edited: false, source: 'local', text: '周', conf: 0.3 },
    { id: 'shi', bbox: box, edited: false, source: 'local', text: '氏', conf: 0.2 },
  ];
  const structuralResults = new Map(structuralChars.map((c) => [c.id, { key: c.id, text: c.text, confidence: c.conf, candidates: [] }]));
  propagateLocalGlyphs(structuralChars, structuralResults, page, 48, 48);
  eq('强公种子不覆盖低置信周', structuralResults.get('zhou').text, '周');
  eq('强公种子不覆盖低置信氏', structuralResults.get('shi').text, '氏');
}

section('传播：簇内多点共识种子（无强 OCR）');
{
  // 木刻版典型场景：全页无 ≥0.85 强结果，但同字两处 0.55 互证 → tier2 种子
  const page = makeBin(48, 48, (x, y) => {
    if (x < 24 && y < 24) return tGlyph()(x, y);
    if (x >= 24 && y < 24) return tGlyph()(x - 24, y);
    if (x < 24 && y >= 24) return tGlyph()(x, y - 24);
    return false;
  });
  const bboxes = [
    [2, 2, 12, 12],
    [26, 2, 36, 12],
    [2, 26, 12, 36],
  ];
  const chars = [
    { id: 'p', bbox: bboxes[0], edited: false, source: 'local', text: '公', conf: 0.55 },
    { id: 'q', bbox: bboxes[1], edited: false, source: 'local', text: '公', conf: 0.6 },
    { id: 'r', bbox: bboxes[2], edited: false, source: 'local', text: null, conf: 0 },
  ].map((c) => ({ ...c, kind: 'text', group: 'body', cx: 0, cy: 0, pt: 0, note: 'ok' }));
  const results = new Map(chars.map((c) => [c.id, { key: c.id, text: c.text, confidence: c.conf, candidates: [] }]));
  const improved = propagateLocalGlyphs(chars, results, page, 48, 48);
  eq('空位 r 由共识种子填入', results.get('r').text, '公');
  check('共识种子置信 0.86（低于强种子 0.88）', results.get('r').confidence === 0.86);
  check('共识改善 ≥1 处', improved >= 1);
}

section('传播：历史证据回退（results 未收录时读 c.text）');
{
  // 重跑场景：results 只含本轮待识别字；历史已写回的「公」作为簇内种子
  const page = makeBin(48, 48, (x, y) => {
    if (x < 24 && y < 24) return tGlyph()(x, y);
    if (x >= 24 && y < 24) return tGlyph()(x - 24, y);
    return false;
  });
  const bboxes = [
    [2, 2, 12, 12],
    [26, 2, 36, 12],
  ];
  const chars = [
    // 历史字：不在 results 中，靠 c.text/c.conf 作为证据
    { id: 'h', bbox: bboxes[0], edited: false, source: 'local', text: '公', conf: 0.9 },
    // 本轮字：空位
    { id: 'n', bbox: bboxes[1], edited: false, source: 'local', text: null, conf: 0 },
  ].map((c) => ({ ...c, kind: 'text', group: 'body', cx: 0, cy: 0, pt: 0, note: 'ok' }));
  const results = new Map([
    ['n', { key: 'n', text: null, confidence: 0, candidates: [] }],
  ]);
  propagateLocalGlyphs(chars, results, page, 48, 48);
  eq('历史「公」作为种子回填本轮空位', results.get('n').text, '公');
}

section('传播：同级证据冲突跳过整簇');
{
  // 人工「王」与强 OCR「公」同簇（指纹误并异形）→ 保守跳过，谁都不改
  const page = makeBin(48, 48, (x, y) => {
    if (x < 24 && y < 24) return tGlyph()(x, y);
    if (x >= 24 && y < 24) return tGlyph()(x - 24, y);
    if (x < 24 && y >= 24) return tGlyph()(x, y - 24);
    return false;
  });
  const bboxes = [
    [2, 2, 12, 12],
    [26, 2, 36, 12],
    [2, 26, 12, 36],
  ];
  const chars = [
    { id: 'm', bbox: bboxes[0], edited: true, source: 'manual', text: '王', conf: 0.99 },
    { id: 'o', bbox: bboxes[1], edited: false, source: 'local', text: '公', conf: 0.95 },
    { id: 'v', bbox: bboxes[2], edited: false, source: 'local', text: null, conf: 0 },
  ].map((c) => ({ ...c, kind: 'text', group: 'body', cx: 0, cy: 0, pt: 0, note: 'ok' }));
  const results = new Map(chars.map((c) => [c.id, { key: c.id, text: c.text, confidence: c.conf, candidates: [] }]));
  const improved = propagateLocalGlyphs(chars, results, page, 48, 48);
  eq('冲突簇零改动', improved, 0);
  eq('人工字保持「王」', results.get('m').text, '王');
  eq('强结果保持「公」', results.get('o').text, '公');
  check('空位保持为空（不强行传播）', results.get('v').text === null);
}

section('传播：无种子时零改动');
{
  const binL = makeBin(24, 24, lGlyph);
  const chars = [
    { id: 'x', bbox: [2, 2, 10, 10], edited: false, source: 'local' },
    { id: 'y', bbox: [2, 2, 10, 10], edited: false, source: 'local' },
  ];
  const results = new Map([
    ['x', { key: 'x', text: null, confidence: 0, candidates: [] }],
    ['y', { key: 'y', text: null, confidence: 0, candidates: [] }],
  ]);
  const improved = propagateLocalGlyphs(chars, results, binL, 24, 24);
  eq('无种子不传播', improved, 0);
  check('空位仍为空', results.get('x').text === null);
}

summary();
