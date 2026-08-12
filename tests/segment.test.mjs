import { check, eq, section, summary } from './helpers.mjs';
import { dilateForCharacterGrouping, segmentChars } from '../src/segment/segment.ts';

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

summary('segment');
