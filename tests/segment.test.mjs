import { check, eq, section, summary } from './helpers.mjs';
import { dilateForCharacterGrouping, segmentChars } from '../src/segment/segment.ts';

function block(bin, width, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) bin[yy * width + xx] = 1;
  }
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

summary('segment');
