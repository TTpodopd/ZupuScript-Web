import { check, eq, section, summary } from './helpers.mjs';
import { applyLeftMarginPageNumbers, detectLeftMarginGraphics, rebuildLeftMarginTextRegions, rebuildRightMarginTextRegions, removeCharsInsideMarginGraphics } from '../src/layout/marginRegions.ts';

function setRect(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) bin[yy * width + xx] = 1;
}
function strokeGlyph(bin, width, x, y, w, h) {
  for (let xx = x; xx < x + w; xx += 1) {
    bin[y * width + xx] = 1;
    bin[(y + h - 1) * width + xx] = 1;
  }
  for (let yy = y; yy < y + h; yy += 1) {
    bin[yy * width + x] = 1;
    bin[yy * width + x + w - 1] = 1;
  }
  for (let xx = x; xx < x + w; xx += 1) bin[(y + Math.floor(h / 2)) * width + xx] = 1;
}
function char(id, cx, cy, w = 20, h = 20) {
  return { id, text: null, cx, cy, bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' };
}
// 空心横笔：上下两条边（fill 低，贴近木刻笔画而非实心块）
function barStroke(bin, width, x, y, w, h) {
  for (let xx = x; xx < x + w; xx += 1) {
    bin[y * width + xx] = 1;
    bin[(y + h - 1) * width + xx] = 1;
  }
}

section('左侧书签图块');
const width = 400;
const height = 600;
const bin = new Uint8Array(width * height);
setRect(bin, width, 35, 180, 45, 100);
const graphics = detectLeftMarginGraphics(bin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }]);
check('检出左外框外高填充装饰块', graphics.length >= 1);
const body = [char('body', 250, 250)];
const withGraphic = [char('fake', 57, 230, 30, 30), ...body];
eq('装饰块内假框移除，正文保留', removeCharsInsideMarginGraphics(withGraphic, graphics).map((c) => c.id).join(','), 'body');

section('左下页码横笔');
const pageBin = new Uint8Array(width * height);
// 左下同列：三条横笔=三，下面两条=二，再下面一条=一
setRect(pageBin, width, 38, 410, 30, 2);
setRect(pageBin, width, 38, 420, 30, 2);
setRect(pageBin, width, 38, 430, 30, 2);
setRect(pageBin, width, 38, 465, 30, 2);
setRect(pageBin, width, 38, 475, 30, 2);
setRect(pageBin, width, 38, 510, 30, 2);
const pageChars = applyLeftMarginPageNumbers([], pageBin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }], 24);
eq('按横笔生成页码候选字框', pageChars.length, 3);
check('页码候选不硬编码内容', pageChars.every((c) => c.text === null && !c.edited));
check('页码标记 pageno/side', pageChars.every((c) => c.group === 'pageno' && c.kind === 'side'));
const bodyChar = char('body-stable', 250, 300);
const withBody = applyLeftMarginPageNumbers([bodyChar], pageBin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }], 24);
check('正文字符完全保留', withBody.some((c) => c.id === bodyChar.id && c.cx === bodyChar.cx && c.cy === bodyChar.cy));


section('direct margin rebuild for different page number');
const directBin = new Uint8Array(width * height);
// four title bands with realistic sparse strokes
for (const y of [80, 125, 170, 215]) strokeGlyph(directBin, width, 42, y, 24, 28);
// different page number glyph-like bands in lower gutter
setRect(directBin, width, 42, 410, 24, 24);
setRect(directBin, width, 42, 465, 24, 24);
const stableBody = char('stable-body', 250, 280);
const rebuilt = rebuildLeftMarginTextRegions([stableBody], directBin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }]);
eq('title boxes follow actual bands', rebuilt.filter((c) => c.group === 'title').length, 4);
check('title text left for OCR', rebuilt.filter((c) => c.group === 'title').every((c) => c.text === null && !c.edited));
eq('two page number OCR boxes rebuilt', rebuilt.filter((c) => c.group === 'pageno').length, 2);
check('page number text left for OCR', rebuilt.filter((c) => c.group === 'pageno').every((c) => c.text === null && !c.edited));
check('body remains unchanged after direct rebuild', rebuilt.some((c) => c.id === stableBody.id && c.cx === stableBody.cx && c.cy === stableBody.cy));
section('木刻标题断笔合并为整字');
const fragW = 400;
const fragH = 600;
const fragBin = new Uint8Array(fragW * fragH);
// 四字竖排标题：每字三条空心横笔（断成三条带），字间间距远大于字内笔间距。
for (let ch = 0; ch < 4; ch += 1) {
  const top = 60 + ch * 56;
  for (let s = 0; s < 3; s += 1) barStroke(fragBin, fragW, 40, top + s * 16, 30, 8);
}
const fragBody = char('frag-body', 250, 300);
const fragRebuilt = rebuildLeftMarginTextRegions([fragBody], fragBin, fragW, fragH, [{ x: 120, y: 20, w: 5, h: 560 }]);
eq('断笔标题合并为四个整字', fragRebuilt.filter((c) => c.group === 'title').length, 4);
check('标题整字高度覆盖多笔', fragRebuilt.filter((c) => c.group === 'title').every((c) => c.bbox[3] - c.bbox[1] >= 24));
check('合并标题不误删正文', fragRebuilt.some((c) => c.id === 'frag-body'));

section('左侧书名紧凑框避开下方书签');
{
  const titleBin = new Uint8Array(width * height);
  for (let i = 0; i < 4; i += 1) strokeGlyph(titleBin, width, 42, 54 + i * 48, 18, 28);
  // 黑色书签紧邻书名下方，不能充当第四个字或扩大书名字框。
  setRect(titleBin, width, 34, 260, 34, 82);
  const titleChars = rebuildLeftMarginTextRegions(
    [char('title-body', 250, 300)], titleBin, width, height,
    [{ x: 120, y: 20, w: 5, h: 560 }], [{ x: 34, y: 260, w: 34, h: 82 }],
  ).filter((c) => c.group === 'title');
  eq('书名只生成四个字框', titleChars.length, 4);
  check('书名框不落入书签', titleChars.every((c) => c.cy < 250));
  check('四个书名框宽高一致', titleChars.every((c) => Math.abs((c.bbox[2] - c.bbox[0]) - (titleChars[0].bbox[2] - titleChars[0].bbox[0])) < 0.1 && Math.abs((c.bbox[3] - c.bbox[1]) - (titleChars[0].bbox[3] - titleChars[0].bbox[1])) < 0.1));
  check('书名框贴合18px字形', titleChars.every((c) => c.bbox[2] - c.bbox[0] <= 22));
}

section('书签下方的竖排汉字页码');
{
  const pageW = 400;
  const pageH = 600;
  const pageWithBookmark = new Uint8Array(pageW * pageH);
  // 黑色书签不能生成图形/文字候选框；页码「二」「十」位于其下方同一列。
  setRect(pageWithBookmark, pageW, 34, 250, 36, 78);
  setRect(pageWithBookmark, pageW, 40, 398, 28, 2);
  setRect(pageWithBookmark, pageW, 40, 418, 28, 2);
  setRect(pageWithBookmark, pageW, 52, 462, 3, 27);
  setRect(pageWithBookmark, pageW, 40, 474, 28, 3);
  const rebuiltPages = rebuildLeftMarginTextRegions(
    [char('page-body', 250, 300)], pageWithBookmark, pageW, pageH,
    [{ x: 120, y: 20, w: 5, h: 560 }], [{ x: 34, y: 250, w: 36, h: 78 }],
  ).filter((c) => c.group === 'pageno');
  eq('书签下只重建二个页码字框', rebuiltPages.length, 2);
  check('页码框完全位于书签下方', rebuiltPages.every((c) => c.bbox[1] >= 328));
  check('二的双横合并为单个大字框', rebuiltPages[0].bbox[3] - rebuiltPages[0].bbox[1] > 20);
  check('页码框同中心线且尺寸一致', rebuiltPages.every((c) => Math.abs(c.cx - rebuiltPages[0].cx) < 0.1 && Math.abs((c.bbox[2] - c.bbox[0]) - (rebuiltPages[0].bbox[2] - rebuiltPages[0].bbox[0])) < 0.1 && Math.abs((c.bbox[3] - c.bbox[1]) - (rebuiltPages[0].bbox[3] - rebuiltPages[0].bbox[1])) < 0.1));
  check('页码保留为 OCR 空字而非图形块', rebuiltPages.every((c) => c.text === null && c.kind === 'side'));
}

section('右页边竖排标题重建');
const rW = 400;
const rH = 600;
const rBin = new Uint8Array(rW * rH);
for (let ch = 0; ch < 3; ch += 1) {
  const top = 60 + ch * 56;
  for (let s = 0; s < 3; s += 1) barStroke(rBin, rW, 330, top + s * 16, 30, 8);
}
const rBody = char('r-body', 150, 300);
// 右侧标题位于右外框内侧，不能放在外框外的空白页边。
const rRebuilt = rebuildRightMarginTextRegions([rBody], rBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
eq('右页边标题重建为三个整字', rRebuilt.filter((c) => c.group === 'title').length, 3);
check('右页边正文保留', rRebuilt.some((c) => c.id === 'r-body'));

section('右页边实心竖笔标题');
const denseBin = new Uint8Array(rW * rH);
// 模拟低清扫描中「三/世/祖」退化为高填充竖笔，但三字仍按行带聚合。
for (let ch = 0; ch < 3; ch += 1) {
  const top = 70 + ch * 58;
  for (const x of [330, 338, 346]) setRect(denseBin, rW, x, top, 3, 28);
}
const denseRebuilt = rebuildRightMarginTextRegions([rBody], denseBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
eq('实心竖笔标题仍重建为三个字框', denseRebuilt.filter((c) => c.group === 'title').length, 3);
const staleNoise = { ...char('stale-noise', 340, 130, 8, 70), group: 'body' };
const cleanedDense = rebuildRightMarginTextRegions([rBody, staleNoise], denseBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
check('右缘标题带内旧 body 噪声框被清除', !cleanedDense.some((c) => c.id === 'stale-noise'));

section('右页边标题重建：断笔+密集字混合列（泛化鲁棒）');
{
  const mixedBin = new Uint8Array(rW * rH);
  // 「三」= 3 条空心横笔（断成 3 带）；「世/祖」= 密集方形字（每字 1 带），模拟真实混合形态
  for (let s = 0; s < 3; s += 1) barStroke(mixedBin, rW, 310, 60 + s * 24, 40, 8);
  strokeGlyph(mixedBin, rW, 310, 140, 40, 36);
  strokeGlyph(mixedBin, rW, 310, 200, 40, 36);
  const mixed = rebuildRightMarginTextRegions([rBody], mixedBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
  const titles = mixed.filter((c) => c.group === 'title');
  eq('断笔带+密集带混合列仍合并为三个整字', titles.length, 3);
  check('整字高度覆盖密集字', titles.every((c) => c.bbox[3] - c.bbox[1] >= 26));
  check('整列字框居中对齐（同一 cx）', titles.every((c) => Math.abs(c.cx - titles[0].cx) < 1.5));
}

section('右页边标题：已有良构标题列则保留，不重复重建');
{
  const existingTitles = [
    char('t1', 330, 90, 36, 36),
    char('t2', 330, 146, 36, 36),
    char('t3', 330, 202, 36, 36),
  ].map((c) => ({ ...c, group: 'title', kind: 'side' }));
  const out = rebuildRightMarginTextRegions([...existingTitles, rBody], rBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
  const titles = out.filter((c) => c.group === 'title');
  eq('已有标题列时不重复重建', titles.length, 3);
  check('保留原有已分割标题框', titles.every((c) => c.id.startsWith('t')));
  check('正文保留', out.some((c) => c.id === 'r-body'));
}

section('右页边标题重建：自适应字数（2 与 6 字）');
{
  const twoBin = new Uint8Array(rW * rH);
  strokeGlyph(twoBin, rW, 310, 60, 40, 36);
  strokeGlyph(twoBin, rW, 310, 116, 40, 36);
  const two = rebuildRightMarginTextRegions([rBody], twoBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
  eq('二字世次标题（如卷二）重建两个整字', two.filter((c) => c.group === 'title').length, 2);

  const sixBin = new Uint8Array(rW * rH);
  for (let ch = 0; ch < 6; ch += 1) strokeGlyph(sixBin, rW, 310, 60 + ch * 52, 40, 32);
  const six = rebuildRightMarginTextRegions([rBody], sixBin, rW, rH, [{ x: 360, y: 20, w: 5, h: 560 }]);
  eq('六字标题重建为六个整字', six.filter((c) => c.group === 'title').length, 6);
}

section('右外框缺少结构框时从二值图兜底定位');
{
  const fallbackBin = new Uint8Array(rW * rH);
  // 断裂扫描外框：中间少量缺口，仍应比 84% 固定值更可靠地定位到 x=360。
  for (let y = 20; y < 580; y += 1) {
    if (y % 37 !== 0) fallbackBin[y * rW + 360] = 1;
  }
  for (let ch = 0; ch < 3; ch += 1) strokeGlyph(fallbackBin, rW, 310, 60 + ch * 56, 40, 36);
  const fallback = rebuildRightMarginTextRegions([rBody], fallbackBin, rW, rH, []);
  eq('无 borderRects 时仍重建右侧三个标题字框', fallback.filter((c) => c.group === 'title').length, 3);
}

summary('margin regions');
