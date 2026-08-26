import { check, eq, section, summary } from './helpers.mjs';
import { dilateForCharacterGrouping, filterResidualLineChars, segmentChars } from '../src/segment/segment.ts';
import { rebuildLeftMarginTextRegions } from '../src/layout/marginRegions.ts';

function block(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) bin[yy * width + xx] = 1;
  }
}

// 笔画式假字（边框+十字笔画），贴近真实汉字墨迹密度
function glyph(bin, width, x, y, w, h, t = 2) {
  for (let xx = x; xx < x + w; xx++) {
    for (let i = 0; i < t; i++) {
      bin[(y + i) * width + xx] = 1;
      bin[(y + h - 1 - i) * width + xx] = 1;
    }
  }
  for (let yy = y; yy < y + h; yy++) {
    for (let i = 0; i < t; i++) {
      bin[yy * width + x + i] = 1;
      bin[yy * width + x + w - 1 - i] = 1;
    }
  }
  for (let xx = x; xx < x + w; xx++) bin[(y + Math.floor(h / 2)) * width + xx] = 1;
  for (let yy = y; yy < y + h; yy++) bin[yy * width + x + Math.floor(w / 2)] = 1;
}

section('断笔聚合');
const width = 160;
const height = 100;
const bin = new Uint8Array(width * height);
block(bin, width, 20, 20, 12, 24);
block(bin, width, 36, 20, 12, 24);
block(bin, width, 100, 20, 12, 24);
block(bin, width, 116, 20, 12, 24);

const grouped = dilateForCharacterGrouping(bin, width, height, 5);
check('膨胀后同字断笔连通', grouped[30 * width + 34] === 1);
check('相邻两字之间仍有空白', grouped[30 * width + 75] === 0);

const chars = segmentChars(bin, width, height, []);
eq('四个断笔块聚合为两个字符', chars.length, 2);
check('两个字符中心保持分离', Math.abs(chars[0].cx - chars[1].cx) > 50);

section('竖排粘连与边框排除');
const verticalWidth = 180;
const verticalHeight = 180;
const verticalBin = new Uint8Array(verticalWidth * verticalHeight);
// 三个正常字提供稳定字号基准。
block(verticalBin, verticalWidth, 20, 20, 18, 18);
block(verticalBin, verticalWidth, 60, 20, 18, 18);
block(verticalBin, verticalWidth, 100, 20, 18, 18);
// 两个竖排相邻字间距很小，膨胀后会粘连，应该由水平投影重新拆开。
block(verticalBin, verticalWidth, 140, 70, 18, 18);
block(verticalBin, verticalWidth, 140, 92, 18, 18);
// 实心装饰块必须在分割前剔除。
block(verticalBin, verticalWidth, 10, 130, 100, 40);

const verticalChars = segmentChars(
  verticalBin,
  verticalWidth,
  verticalHeight,
  [],
  [{ x: 10, y: 130, w: 100, h: 40 }],
);
eq('竖排粘连字拆成独立字符且不包含装饰块', verticalChars.length, 5);
check('拆分后的竖排字框高度接近单字', verticalChars.every((char) => char.bbox[3] - char.bbox[1] <= 22));

section('页边大字与小字');
const pageWidth = 320;
const pageHeight = 420;
const pageBin = new Uint8Array(pageWidth * pageHeight);
// 正文区三个字（框内）
block(pageBin, pageWidth, 120, 80, 16, 16);
block(pageBin, pageWidth, 160, 80, 16, 16);
block(pageBin, pageWidth, 200, 80, 16, 16);
// 左侧页边标题（大字，竖排）
glyph(pageBin, pageWidth, 18, 40, 28, 34);
glyph(pageBin, pageWidth, 18, 82, 28, 34);
glyph(pageBin, pageWidth, 18, 124, 28, 34);
glyph(pageBin, pageWidth, 18, 166, 28, 34);
// 左下角页码（小字）
glyph(pageBin, pageWidth, 22, 360, 12, 14, 1);
glyph(pageBin, pageWidth, 22, 382, 12, 14, 1);
// 模拟外框：正文在 x=90 以右
const frameBorder = [{ x: 88, y: 20, w: 4, h: 360 }];

const pageChars = segmentChars(pageBin, pageWidth, pageHeight, [], frameBorder, frameBorder);
const marginSide = pageChars.filter((c) => c.kind === 'side');
eq('页边标题与页码识别为 side', marginSide.length, 6);
check('正文三字保留在框内', pageChars.filter((c) => c.cx > 100).length, 3);
check('页边大字高度明显大于正文', marginSide.some((c) => c.bbox[3] - c.bbox[1] >= 24));

section('谱系线残段过滤');
const lineChars = [
  { id: 'residual', text: null, cx: 75, cy: 100, bbox: [60, 98, 90, 102], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' },
  { id: 'isolated-one', text: null, cx: 75, cy: 140, bbox: [60, 138, 90, 142], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' },
  { id: 'square-glyph', text: null, cx: 120, cy: 100, bbox: [111, 91, 129, 109], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' },
];
const cleanedLineChars = filterResidualLineChars(lineChars, [{ id: 'line', x1: 20, y1: 100, x2: 100, y2: 100, widthPx: 2, orientation: 'h' }], 18);
eq('贴近谱系横线的细长残段被移除', cleanedLineChars.some((char) => char.id === 'residual'), false);
check('远离谱系线的孤立横字保留', cleanedLineChars.some((char) => char.id === 'isolated-one'));
check('线旁方形汉字保留', cleanedLineChars.some((char) => char.id === 'square-glyph'));

section('无参考线的竖线残段过滤');
const thinLineBin = new Uint8Array(160 * 160);
block(thinLineBin, 160, 80, 60, 3, 22);
const isolatedThinLine = {
  id: 'isolated-thin-vertical', text: null, cx: 81.5, cy: 71, bbox: [78, 58, 85, 84],
  pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
};
const noLineReference = filterResidualLineChars([isolatedThinLine], [{ id: 'unrelated', x1: 10, y1: 10, x2: 10, y2: 120, widthPx: 2, orientation: 'v' }], 18, thinLineBin, 160, 160);
eq('未检出谱系线时，主体内极细竖线仍被移除', noLineReference.length, 0);

section('T 形接头短桩过滤（擦线后遗留）');
{
  // 横线 y=100 x∈[20,100] 已检出并被擦除；接头处遗留竖桩 x∈[78,81] y∈[101,124]
  const junctionBin = new Uint8Array(160 * 160);
  block(junctionBin, 160, 78, 101, 4, 24);
  const junctionStub = {
    id: 'junction-stub', text: null, cx: 80, cy: 113, bbox: [77, 100, 83, 126],
    pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
  };
  const hLine = [{ id: 'h', x1: 20, y1: 100, x2: 100, y2: 100, widthPx: 2, orientation: 'h' }];
  eq('贴横线的竖向接头短桩被移除', filterResidualLineChars([junctionStub], hLine, 18, junctionBin, 160, 160).length, 0);

  // 同样形态但远离任何谱系线 → 保留（无线证据不剔除）
  const farBin = new Uint8Array(160 * 160);
  block(farBin, 160, 78, 101, 4, 24);
  const farStub = { ...junctionStub, id: 'far-stub' };
  const farLine = [{ id: 'h2', x1: 20, y1: 20, x2: 60, y2: 20, widthPx: 2, orientation: 'h' }];
  eq('无线证据的细墨迹不误删', filterResidualLineChars([farStub], farLine, 18, farBin, 160, 160).length, 1);
}

section('共线漏检线尾过滤');
{
  // 检测横线止于 x=100；实际墨迹线尾延伸到 x∈[103,124]（长 22 < 1.35×字号，旧长度规则漏网）
  const tailBin = new Uint8Array(160 * 160);
  block(tailBin, 160, 103, 99, 22, 3);
  const tailChar = {
    id: 'line-tail', text: null, cx: 114, cy: 100, bbox: [102, 98, 126, 102],
    pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
  };
  const hLine = [{ id: 'h', x1: 20, y1: 100, x2: 100, y2: 100, widthPx: 2, orientation: 'h' }];
  eq('与检测线共线的漏检线尾被移除', filterResidualLineChars([tailChar], hLine, 18, tailBin, 160, 160).length, 0);

  // 同位置的孤立「一」（字号内长度、无线共线证据）不受影响
  const oneBin = new Uint8Array(160 * 160);
  block(oneBin, 160, 103, 139, 16, 3);
  const oneChar = {
    id: 'isolated-yi', text: null, cx: 111, cy: 140, bbox: [103, 138, 119, 142],
    pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
  };
  eq('远离谱系线的孤立「一」保留', filterResidualLineChars([oneChar], hLine, 18, oneBin, 160, 160).length, 1);
}

section('十字接头团块过滤');
{
  // 20×20 的十字细带墨迹（线宽 3）贴着检测横线：接头残块
  const crossBin = new Uint8Array(160 * 160);
  block(crossBin, 160, 60, 99, 20, 3);
  block(crossBin, 160, 68, 90, 3, 20);
  const crossChar = {
    id: 'cross-junction', text: null, cx: 70, cy: 100, bbox: [60, 90, 80, 110],
    pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
  };
  const hLine = [{ id: 'h', x1: 20, y1: 100, x2: 100, y2: 100, widthPx: 2, orientation: 'h' }];
  eq('贴线的十字接头团块被移除', filterResidualLineChars([crossChar], hLine, 18, crossBin, 160, 160).length, 0);

  // 同样形态但远离谱系线：正文里的「十」保留
  const farCrossBin = new Uint8Array(160 * 160);
  block(farCrossBin, 160, 60, 49, 20, 3);
  block(farCrossBin, 160, 68, 40, 3, 20);
  const farCross = { ...crossChar, id: 'real-shi', cy: 50, bbox: [60, 40, 80, 60] };
  eq('远离谱系线的十字形真字保留', filterResidualLineChars([farCross], hLine, 18, farCrossBin, 160, 160).length, 1);

  // 田字格笔画结构（多横带）不是接头形态，贴线也保留
  const fieldBin = new Uint8Array(160 * 160);
  glyph(fieldBin, 160, 60, 90, 20, 20, 2);
  const fieldChar = { ...crossChar, id: 'field-glyph', bbox: [60, 90, 80, 110] };
  eq('框形笔画真字贴线也不误删', filterResidualLineChars([fieldChar], hLine, 18, fieldBin, 160, 160).length, 1);
}

section('节点圆残弧过滤');
{
  // 圆环墨迹（圆心 100,100，半径 14，粗 2），右侧开缺口模拟擦线切割后的 C 形残弧
  const ringBin = new Uint8Array(160 * 160);
  for (let y = 0; y < 160; y += 1) {
    for (let x = 0; x < 160; x += 1) {
      const d = Math.hypot(x - 100, y - 100);
      if (d >= 13 && d <= 15 && !(x > 100 && Math.abs(y - 100) < 6)) ringBin[y * 160 + x] = 1;
    }
  }
  const arcChar = {
    id: 'node-arc', text: null, cx: 97, cy: 100, bbox: [85, 85, 115, 115],
    pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text',
  };
  const nodeEvidence = [{ cx: 100, cy: 100, r: 14 }];
  eq('节点圆环残弧被移除', filterResidualLineChars([arcChar], [], 18, ringBin, 160, 160, nodeEvidence).length, 0);
  eq('无节点证据时不误删同形墨迹', filterResidualLineChars([{ ...arcChar, id: 'keep' }], [], 18, ringBin, 160, 160).length, 1);

  // 圆内的真实字（墨迹集中在圆心附近，与环带不重合）保留
  const innerBin = new Uint8Array(160 * 160);
  block(innerBin, 160, 94, 94, 12, 12);
  const innerChar = { ...arcChar, id: 'inner-glyph', bbox: [94, 94, 106, 106], cx: 100, cy: 100 };
  eq('圆内字保留', filterResidualLineChars([innerChar], [], 18, innerBin, 160, 160, nodeEvidence).length, 1);
}

section('端到端：节点圆残弧不产生噪声框');
{
  const nW = 220;
  const nH = 180;
  const nBin = new Uint8Array(nW * nH);
  glyph(nBin, nW, 30, 60, 18, 18, 2);
  // 节点圆环（圆心 150,90，半径 14）+ 穿过圆心的竖线（擦线后把圆环切成两段残弧）
  for (let y = 0; y < nH; y += 1) {
    for (let x = 0; x < nW; x += 1) {
      const d = Math.hypot(x - 150, y - 90);
      if (d >= 13 && d <= 15) nBin[y * nW + x] = 1;
    }
  }
  block(nBin, nW, 149, 20, 2, 140);
  const nLines = [{ id: 'v', x1: 150, y1: 20, x2: 150, y2: 160, widthPx: 2, orientation: 'v' }];
  const nNodes = [{ id: 'n', cx: 150, cy: 90, r: 14, strokePx: 2 }];

  const withNodes = segmentChars(nBin, nW, nH, nLines, [], [], { nodes: nNodes });
  eq('正文真字保留', withNodes.filter((c) => c.cx < 100).length, 1);
  eq('提供节点证据后无残弧噪声框', withNodes.filter((c) => c.cx > 100).length, 0);

  const withoutNodes = segmentChars(nBin, nW, nH, nLines);
  check('对照：无节点证据时残弧确会产生噪声框', withoutNodes.filter((c) => c.cx > 100).length > 0);
}

section('端到端：漏检接头不产生正文噪声框');
{
  const e2eW = 260;
  const e2eH = 200;
  const e2eBin = new Uint8Array(e2eW * e2eH);
  // 三个正文真字
  glyph(e2eBin, e2eW, 30, 30, 18, 18, 2);
  glyph(e2eBin, e2eW, 30, 70, 18, 18, 2);
  glyph(e2eBin, e2eW, 30, 110, 18, 18, 2);
  // 谱系竖线 x=140 y∈[30,150]（已检出，将被擦除）
  block(e2eBin, e2eW, 139, 30, 2, 120);
  // 未检出的 L 形接头：横向分支（5px 粗）+ 向下竖桩，擦线后整块残留在正文区
  block(e2eBin, e2eW, 141, 88, 21, 5);
  block(e2eBin, e2eW, 148, 93, 5, 15);
  const detectedLines = [
    { id: 'v', x1: 140, y1: 30, x2: 140, y2: 150, widthPx: 2, orientation: 'v' },
  ];
  const e2eChars = segmentChars(e2eBin, e2eW, e2eH, detectedLines);
  eq('三个正文真字全部保留', e2eChars.filter((c) => c.cx < 110).length, 3);
  eq('漏检 L 形接头不产生噪声字框', e2eChars.filter((c) => c.cx > 110).length, 0);
}

section('页边标题/页码泛化');
const marginWidth = 320;
const marginHeight = 500;
const marginBin = new Uint8Array(marginWidth * marginHeight);
// 五字竖排标题，验证不再依赖固定四字书名。
for (let i = 0; i < 5; i++) glyph(marginBin, marginWidth, 18, 30 + i * 38, 24, 30, 2);
// 两个页码字的横/竖笔，只用于生成 OCR 字框，不能被分割器直接写成「三、一」。
for (const [x, y, w, h] of [[24, 365, 18, 3], [24, 378, 18, 3], [24, 405, 3, 18], [16, 412, 18, 3]]) {
  block(marginBin, marginWidth, x, y, w, h);
}
const marginChars = rebuildLeftMarginTextRegions(
  [{ id: 'body', text: null, cx: 160, cy: 120, bbox: [151, 111, 169, 129], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' }],
  marginBin,
  marginWidth,
  marginHeight,
  [{ x: 90, y: 20, w: 4, h: 450 }],
);
eq('标题字框按实际字数生成', marginChars.filter((char) => char.group === 'title').length, 5);
check('标题字框不预填样本文字', marginChars.filter((char) => char.group === 'title').every((char) => char.text === null));
check('页码至少生成两个待识别字框', marginChars.filter((char) => char.group === 'pageno').length >= 2);
check('页码字框不硬编码内容', marginChars.filter((char) => char.group === 'pageno').every((char) => char.text === null));
summary('segment');
