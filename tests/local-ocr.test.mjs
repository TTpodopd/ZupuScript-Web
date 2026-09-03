/**
 * 本地 OCR 渲染管线与投票校准回归：
 * - renderCharPixels：闭运算修 1px 断笔、放大走双线性产生平滑灰度、白底居中；
 * - calibrateLocalConfidence：一致率主导（全一致过 0.85 免校对，分歧结果给低分）；
 * - hasStableLocalWinner：top-2 容错的提前退出判定。
 * 运行：node --experimental-strip-types --no-warnings --loader ./tests/alias-loader.mjs tests/local-ocr.test.mjs
 */
import { check, eq, approx, section, summary } from './helpers.mjs';
import {
  renderCharPixels,
  calibrateLocalConfidence,
  hasStableLocalWinner,
} from '../src/recognize/local/tesseract.ts';

function makeBin(width, height, fill) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y) ? 1 : 0;
  }
  return data;
}

section('renderCharPixels：闭运算修断笔');
{
  // 12×12 实心墨块，中心 (6,6) 挖 1px 洞模拟木刻断笔
  const bin = makeBin(24, 24, (x, y) => x >= 6 && x < 18 && y >= 6 && y < 18 && !(x === 11 && y === 11));
  const bbox = [6, 6, 12, 12];
  const { data, width, height } = renderCharPixels(bin, 24, 24, bbox, 0, 160);
  eq('输出尺寸 160×160', `${width}x${height}`, '160x160');
  // scale = min(148/12, 6) = 6 → dw = 72，居中 ox = oy = 44。
  // 源洞 (11,11) 相对裁剪 (5,5) → 渲染区 [44+5*6, 44+6*6) = [74,80)。闭运算补洞后该块应为纯墨（v=0）。
  const px = (x, y) => data[(y * width + x) * 4];
  check('断笔洞被闭运算修补（对应渲染块非白）', px(77, 77) < 128, `v=${px(77, 77)}`);
  check('渲染区外保持白底', px(2, 2) === 255 && px(157, 157) === 255);
}

section('renderCharPixels：放大走双线性平滑灰度');
{
  // 12×12 内 1px 细竖线（模拟木刻细笔画），放大 6 倍 → 双线性插值应在笔画边缘产生中间灰阶。
  // 注意不能用 2×2 这类极小图：1px 闭运算会把整块合并成全墨，反而验证不到缩放灰度。
  const bin = makeBin(12, 12, (x, y) => x === 6 && y >= 1 && y <= 11);
  const { data, width } = renderCharPixels(bin, 12, 12, [0, 0, 12, 12], 0, 160);
  let grayCount = 0;
  for (let i = 0; i < width * 160; i++) {
    const v = data[i * 4];
    if (v > 8 && v < 247) grayCount += 1;
  }
  check('存在平滑灰阶像素（非硬二值）', grayCount > 0, `grayCount=${grayCount}`);
}

section('renderCharPixels：空裁剪不崩溃');
{
  const bin = makeBin(8, 8, () => false);
  const { data, width, height } = renderCharPixels(bin, 8, 8, [2, 2, 4, 4], 0, 96);
  eq('空裁剪输出尺寸', `${width}x${height}`, '96x96');
  check('空裁剪全白', data[0] === 255 && data[(95 * 96 + 95) * 4] === 255);
}

section('calibrateLocalConfidence：一致率主导');
approx('双引擎全一致+高 Tesseract → 过免校对阈值', calibrateLocalConfidence(1, 0.9), 0.98);
check('top1 但多裁剪分歧 → 如实低分', calibrateLocalConfidence(0.34, 0.5) < 0.6);
approx('中等一致率', calibrateLocalConfidence(0.5, 0.6), 0.645);
approx('下限 clamp 0', calibrateLocalConfidence(0, 0), 0.25);
approx('上限 clamp 0.98', calibrateLocalConfidence(1, 1), 0.98);

section('hasStableLocalWinner：top-2 容错提前退出');
{
  const v6 = new Map([['公', { score: 8, count: 6, confidenceSum: 5 }]]);
  check('单候选 6/6 全一致 → 稳定', hasStableLocalWinner(v6, 6));
  const vSplit = new Map([
    ['公', { score: 6.5, count: 4, confidenceSum: 3 }],
    ['松', { score: 2.5, count: 2, confidenceSum: 1.4 }],
  ]);
  check('top-2 覆盖全部投票 → 稳定', hasStableLocalWinner(vSplit, 6));
  const vUnstable = new Map([
    ['甲', { score: 2, count: 2, confidenceSum: 1 }],
    ['乙', { score: 2, count: 2, confidenceSum: 1 }],
    ['丙', { score: 2, count: 2, confidenceSum: 1 }],
  ]);
  check('三候选均分 → 不稳定', !hasStableLocalWinner(vUnstable, 6));
  check('轮数不足 6 → 不稳定', !hasStableLocalWinner(v6, 4));
  check('空投票 → 不稳定', !hasStableLocalWinner(new Map(), 6));
}

summary();
