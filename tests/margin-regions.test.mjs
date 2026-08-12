import { check, eq, section, summary } from './helpers.mjs';
import { applyLeftMarginPageNumbers, detectLeftMarginGraphics, rebuildLeftMarginTextRegions, removeCharsInsideMarginGraphics } from '../src/layout/marginRegions.ts';

function setRect(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) bin[yy * width + xx] = 1;
}
function char(id, cx, cy, w = 20, h = 20) {
  return { id, text: null, cx, cy, bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'body', kind: 'text' };
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
eq('重建两个固定页码字框', pageChars.length, 2);
eq('页码从上到下为三一', pageChars.sort((a, b) => a.cy - b.cy).map((c) => c.text).join(''), '三一');
check('页码标记 pageno/side', pageChars.every((c) => c.group === 'pageno' && c.kind === 'side'));
const bodyChar = char('body-stable', 250, 300);
const withBody = applyLeftMarginPageNumbers([bodyChar], pageBin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }], 24);
check('正文字符完全保留', withBody.some((c) => c.id === bodyChar.id && c.cx === bodyChar.cx && c.cy === bodyChar.cy));


section('direct margin rebuild for different page number');
const directBin = new Uint8Array(width * height);
// four title bands
for (const y of [80, 125, 170, 215]) setRect(directBin, width, 42, y, 24, 28);
// different page number glyph-like bands in lower gutter
setRect(directBin, width, 42, 410, 24, 24);
setRect(directBin, width, 42, 465, 24, 24);
const stableBody = char('stable-body', 250, 280);
const rebuilt = rebuildLeftMarginTextRegions([stableBody], directBin, width, height, [{ x: 120, y: 20, w: 5, h: 560 }]);
eq('fixed title rebuilt', rebuilt.filter((c) => c.group === 'title').map((c) => c.text).join(''), '倪氏宗譜');
eq('two page number OCR boxes rebuilt', rebuilt.filter((c) => c.group === 'pageno').length, 2);
check('page number text left for OCR', rebuilt.filter((c) => c.group === 'pageno').every((c) => c.text === null && !c.edited));
check('body remains unchanged after direct rebuild', rebuilt.some((c) => c.id === stableBody.id && c.cx === stableBody.cx && c.cy === stableBody.cy));
summary('margin regions');