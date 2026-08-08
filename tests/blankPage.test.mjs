/**
 * imaging/blankPage.ts：空白页墨迹占比判定。
 */
import { check, section, summary } from './helpers.mjs';
import { isBlankRaster } from '../src/imaging/blankPage.ts';

function makeRaster(w, h, pixel) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a = 255] = pixel(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

section('全白页 → 空白');
check(
  '纯白图判定为空白',
  isBlankRaster(makeRaster(200, 300, () => [255, 255, 255])),
);

section('有内容页 → 非空白');
check(
  '居中 20×20 黑块判定为有内容',
  !isBlankRaster(
    makeRaster(200, 200, (x, y) =>
      x >= 90 && x < 110 && y >= 90 && y < 110 ? [0, 0, 0] : [255, 255, 255],
    ),
  ),
);

section('噪声容忍');
check(
  '少量噪点仍视为空白',
  isBlankRaster(
    makeRaster(100, 100, (x, y) => (x === 50 && y === 50 ? [0, 0, 0] : [255, 255, 255])),
  ),
);

summary('blankPage');
