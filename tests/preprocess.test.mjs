/**
 * imaging/preprocess.ts：Otsu 阈值、投影法去斜、去噪等纯函数边界用例。
 */
import { check, eq, section, summary } from './helpers.mjs';
import {
  otsuThreshold, binarizeOtsu, binarizeSauvola,
  medianFilterBinary, removeSmallComponents, estimateSkewDeg,
} from '../src/imaging/preprocess.ts';

section('Otsu：合成双峰直方图');
// 合成双峰：墨迹峰 35..45（占 20%），纸背景峰 195..205（占 80%）
const N = 100_000;
const gray = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  gray[i] = i % 5 === 0 ? 35 + (i % 11) : 195 + (i % 11);
}
const t = otsuThreshold(gray);
// 经典 Otsu 取首个最大类间方差的 t，落在墨迹峰右沿（45）到背景峰之前都合理
check(`Otsu 阈值落在两峰之间 (44 < t < 195)，实际 ${t}`, t > 44 && t < 195);

// 全黑/全白不退化
eq('全 0 图阈值兜底 128', otsuThreshold(new Uint8Array(1000)), 128);

section('Otsu 二值化');
const bin = binarizeOtsu(gray);
const inkCount = bin.reduce((a, b) => a + b, 0);
check('墨迹（暗）标 1、背景（亮）标 0，墨迹占比 ≈20%（±4%）',
  inkCount > N * 0.15 && inkCount <= N * 0.21, `ink=${inkCount}`);
check('背景像素全部不误检', bin.every((v, i) => gray[i] < 195 ? true : v === 0));
// 手动阈值
const binManual = binarizeOtsu(gray, 100);
eq('手动阈值生效（t=100 精确分开两峰）', binManual.reduce((a, b) => a + b, 0), N / 5);

section('Sauvola 二值化');
const w = 40, h = 40;
const g2 = new Uint8Array(w * h).fill(200);
for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) g2[y * w + x] = 40; // 一块暗区
const sb = binarizeSauvola(g2, w, h);
check('Sauvola 暗区检出为墨迹', sb[15 * w + 15] === 1);
check('Sauvola 亮背景不误检', sb[0] === 0 && sb[w * h - 1] === 0);

section('投影法去斜（合成斜线图像）');
// 构造 800×400 图像：多条横线以 +2° 倾斜（y = y0 + x·tan(2°)）
const W = 800, H = 400;
const mkSkewed = (deg) => {
  const b = new Uint8Array(W * H);
  const tan = Math.tan((deg * Math.PI) / 180);
  for (let y0 = 30; y0 < H - 30; y0 += 25) {
    for (let x = 20; x < W - 20; x++) {
      for (let dy = 0; dy < 3; dy++) {
        const y = Math.round(y0 + x * tan) + dy;
        if (y >= 0 && y < H) b[y * W + x] = 1;
      }
    }
  }
  return b;
};
const est2 = estimateSkewDeg(mkSkewed(2), W, H);
check(`+2° 斜线估计 ≈ 2°（±0.6），实际 ${est2}`, Math.abs(est2 - 2) <= 0.6);
const estNeg3 = estimateSkewDeg(mkSkewed(-3), W, H);
check(`-3° 斜线估计 ≈ -3°（±0.6），实际 ${estNeg3}`, Math.abs(estNeg3 + 3) <= 0.6);
const est0 = estimateSkewDeg(mkSkewed(0), W, H);
check(`0° 横线估计 ≈ 0°（±0.3），实际 ${est0}`, Math.abs(est0) <= 0.3);
eq('墨迹点过少时返回 0', estimateSkewDeg(new Uint8Array(W * H), W, H), 0);

section('中值滤波去椒盐噪点');
const w3 = 10, h3 = 10;
const noisy = new Uint8Array(w3 * h3);
noisy[5 * w3 + 5] = 1; // 孤立噪点
const filtered = medianFilterBinary(noisy, w3, h3, 1);
eq('孤立噪点被滤除', filtered[5 * w3 + 5], 0);
// 实心块不受影响
const block = new Uint8Array(w3 * h3);
for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) block[y * w3 + x] = 1;
const fb = medianFilterBinary(block, w3, h3, 1);
eq('实心块中心保留', fb[4 * w3 + 4], 1);

section('小连通域剔除');
// 噪点(面积1) + 大连通域(面积 100)
const w4 = 30, h4 = 30;
const cc = new Uint8Array(w4 * h4);
cc[0] = 1; // 孤立点
for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) cc[y * w4 + x] = 1;
const cleaned = removeSmallComponents(cc, w4, h4, 8);
eq('小连通域被剔除', cleaned[0], 0);
eq('大连通域保留', cleaned[15 * w4 + 15], 1);

summary('preprocess');
