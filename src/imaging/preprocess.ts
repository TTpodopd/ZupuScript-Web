/**
 * 图像预处理（F2.x，全本地，纯 JS 实现）：
 * 投影法去斜（±5°）、Otsu/Sauvola 自适应二值化、中值去噪 + 小连通域剔除、DPI 归一。
 */
import {
  DEFAULT_DPI,
  DENOISE_MIN_AREA,
  DESKEW_RANGE_DEG,
  MEDIAN_RADIUS,
} from '@/lib/constants';
import { connectedComponents, histogram, resizeGray, rotateBinaryNearest, toGray } from './raster';

export interface PreprocessOptions {
  targetDpi: number;
  /** 源 DPI（导入时记录到 SourceInfo；缺省视为与 targetDpi 一致，即不缩放） */
  sourceDpi?: number;
  binarizer: 'otsu' | 'sauvola';
  /** Otsu 模式下的手动阈值偏移（-50..50），undefined = 自动 */
  threshold?: number;
  /** 手动去斜角度（优先级高于自动估计） */
  manualDeskewDeg?: number;
  /** 高精度模式：尝试 OpenCV.js 增强（懒加载，失败自动回退纯 JS） */
  useOpenCV?: boolean;
  /** 二值化后加粗笔画（PDF 矢量渲染 anti-alias 断点修复，1=3×3 膨胀） */
  strokeDilate?: number;
  /** 小连通域剔除面积下限（PDF 宜更小以保留细页框） */
  denoiseMinArea?: number;
  /** 中值滤波半径，0=跳过（PDF 保留细框） */
  medianRadius?: number;
  /** 为 true 时在去噪前复制 layoutBinary（供版面检测，保留细页框） */
  dualBinary?: boolean;
  /** 分割二值图开运算半径（去椒盐噪点），0=跳过 */
  morphOpenRadius?: number;
}

export interface PreprocessResult {
  width: number;
  height: number;
  deskewDeg: number;
  /** DPI 归一后锁定：pxPerMm = targetDpi / 25.4 */
  pxPerMm: number;
  /** 二值矩阵（0/1，未打包，1=墨迹） */
  binary: Uint8Array;
  /** 去噪前二值图（dualBinary 时供版面检测） */
  layoutBinary?: Uint8Array;
}

/* ---------- Otsu ---------- */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = histogram(gray);
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export function binarizeOtsu(gray: Uint8Array, threshold?: number): Uint8Array {
  const t = threshold ?? otsuThreshold(gray);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < t ? 1 : 0;
  return out;
}

/* ---------- Sauvola（积分图加速） ---------- */
export function binarizeSauvola(gray: Uint8Array, width: number, height: number, windowSize = 25, k = 0.2): Uint8Array {
  const R = 128;
  const w = width;
  const h = height;
  // 积分图（sum 与平方和），用 Float64 防溢出
  const integral = new Float64Array((w + 1) * (h + 1));
  const integralSq = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v;
      rowSq += v * v;
      const i = (y + 1) * (w + 1) + (x + 1);
      integral[i] = integral[i - (w + 1)] + rowSum;
      integralSq[i] = integralSq[i - (w + 1)] + rowSq;
    }
  }
  const half = Math.floor(windowSize / 2);
  const out = new Uint8Array(w * h);
  const rectSum = (ii: Float64Array, x0: number, y0: number, x1: number, y1: number): number =>
    ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w, x + half + 1);
      const count = (x1 - x0) * (y1 - y0);
      const sum = rectSum(integral, x0, y0, x1, y1);
      const sq = rectSum(integralSq, x0, y0, x1, y1);
      const mean = sum / count;
      const variance = sq / count - mean * mean;
      const std = Math.sqrt(Math.max(0, variance));
      const threshold = mean * (1 + k * (std / R - 1));
      out[y * w + x] = gray[y * w + x] < threshold ? 1 : 0;
    }
  }
  return out;
}

/* ---------- 中值滤波（3×3，去椒盐噪点，F2.4） ---------- */
export function medianFilterBinary(bin: Uint8Array, width: number, height: number, radius = MEDIAN_RADIUS): Uint8Array {
  if (radius <= 0) return bin;
  const out = new Uint8Array(bin.length);
  const win: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      win.length = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          win.push(bin[yy * width + xx]);
        }
      }
      win.sort((a, b) => a - b);
      out[y * width + x] = win[Math.floor(win.length / 2)];
    }
  }
  return out;
}

/** 形态学膨胀：加粗细笔画、连接 anti-alias 断点 */
export function dilateBinary(bin: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (radius <= 0) return bin;
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!bin[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** 形态学腐蚀：剔除孤立噪点（与 dilate 配对做开运算） */
export function erodeBinary(bin: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (radius <= 0) return bin;
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!bin[y * width + x]) continue;
      let keep = true;
      outer:
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) {
          keep = false;
          break;
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || !bin[yy * width + xx]) {
            keep = false;
            break outer;
          }
        }
      }
      out[y * width + x] = keep ? 1 : 0;
    }
  }
  return out;
}

/** 开运算：先腐蚀后膨胀，去除小噪点同时保留较粗笔画 */
export function openBinary(bin: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (radius <= 0) return bin;
  return dilateBinary(erodeBinary(bin, width, height, radius), width, height, radius);
}

/** 小连通域剔除（F2.4 去噪第二步） */
export function removeSmallComponents(bin: Uint8Array, width: number, height: number, minArea = DENOISE_MIN_AREA): Uint8Array {
  const { labels, boxes } = connectedComponents(bin, width, height);
  const kill = new Set<number>();
  for (const b of boxes) {
    if (b.area < minArea) kill.add(b.label);
  }
  if (kill.size === 0) return bin;
  const out = new Uint8Array(bin);
  for (let i = 0; i < out.length; i++) {
    if (out[i] && kill.has(labels[i])) out[i] = 0;
  }
  return out;
}

/* ---------- 投影法去斜（F2.2，±5°） ---------- */
/**
 * 估计倾斜角：对候选角度做「剪切投影」（不实际旋转图像，按 y' = y - x·tanθ 累积行投影），
 * 行投影方差最大时文字行最齐。粗搜 0.5°，细搜 0.1°。
 */
export function estimateSkewDeg(bin: Uint8Array, width: number, height: number): number {
  // 收集墨迹点（抽样上限，避免超大图过慢）
  const xs: number[] = [];
  const ys: number[] = [];
  const stride = Math.max(1, Math.floor((width * height) / 400_000));
  for (let i = 0; i < bin.length; i += stride) {
    if (bin[i]) {
      xs.push(i % width);
      ys.push(Math.floor(i / width));
    }
  }
  if (xs.length < 100) return 0;

  const scoreAt = (deg: number): number => {
    const tan = Math.tan((deg * Math.PI) / 180);
    const proj = new Float64Array(height);
    for (let i = 0; i < xs.length; i++) {
      const yy = Math.round(ys[i] - xs[i] * tan);
      if (yy >= 0 && yy < height) proj[yy]++;
    }
    let mean = 0;
    for (let y = 0; y < height; y++) mean += proj[y];
    mean /= height;
    let variance = 0;
    for (let y = 0; y < height; y++) {
      const d = proj[y] - mean;
      variance += d * d;
    }
    return variance / height;
  };

  let best = 0;
  let bestScore = -1;
  for (let deg = -DESKEW_RANGE_DEG; deg <= DESKEW_RANGE_DEG; deg += 0.5) {
    const s = scoreAt(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  // 细搜
  const lo = Math.max(-DESKEW_RANGE_DEG, best - 0.5);
  const hi = Math.min(DESKEW_RANGE_DEG, best + 0.5);
  for (let deg = lo; deg <= hi + 1e-9; deg += 0.1) {
    const s = scoreAt(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  return Math.round(best * 10) / 10;
}

/* ---------- 完整预处理管线 ---------- */
export interface ProgressLike {
  (p: { stage: string; percent: number }): void;
}

export async function preprocessPipeline(
  image: ImageData,
  opts: PreprocessOptions,
  onProgress?: ProgressLike,
): Promise<PreprocessResult> {
  const report = (stage: string, percent: number) => onProgress?.({ stage, percent });
  const targetDpi = opts.targetDpi || DEFAULT_DPI;

  report('deskew', 5);
  // 1. 灰度化
  let gray = toGray(image);
  let width = image.width;
  let height = image.height;

  // 2. DPI 归一（F2.5）：源 DPI 未知时假定已是目标 DPI（不缩放）
  const srcDpi = opts.sourceDpi && opts.sourceDpi > 0 ? opts.sourceDpi : targetDpi;
  if (Math.abs(srcDpi - targetDpi) > 1) {
    const resized = resizeGray(gray, width, height, targetDpi / srcDpi);
    gray = resized.data;
    width = resized.width;
    height = resized.height;
  }
  report('binarize', 25);

  // 3. 二值化（F2.3）
  let binary: Uint8Array;
  if (opts.binarizer === 'sauvola') {
    binary = binarizeSauvola(gray, width, height);
  } else {
    const auto = otsuThreshold(gray);
    const t = opts.threshold !== undefined ? auto + opts.threshold : auto;
    binary = binarizeOtsu(gray, Math.max(1, Math.min(254, t)));
  }
  if (opts.strokeDilate && opts.strokeDilate > 0) {
    binary = dilateBinary(binary, width, height, opts.strokeDilate);
  }
  report('deskew', 45);

  // 4. 去斜（F2.2）：手动角度优先，否则投影法自动估计
  let deskewDeg = 0;
  if (opts.manualDeskewDeg !== undefined && Math.abs(opts.manualDeskewDeg) > 1e-6) {
    deskewDeg = opts.manualDeskewDeg;
  } else if (opts.useOpenCV) {
    // OpenCV 增强（可选）：失败或超时回退投影法
    const cvDeg = await Promise.race([
      import('./opencv').then(({ estimateSkewWithOpenCV }) => estimateSkewWithOpenCV(binary, width, height)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 18_000)),
    ]).catch(() => null);
    deskewDeg = cvDeg ?? estimateSkewDeg(binary, width, height);
  } else {
    deskewDeg = estimateSkewDeg(binary, width, height);
  }
  if (Math.abs(deskewDeg) > 0.05) {
    binary = rotateBinaryNearest(binary, width, height, -deskewDeg);
  }
  report('denoise', 70);

  const layoutBinary = opts.dualBinary ? new Uint8Array(binary) : undefined;

  // 5. 去噪（F2.4）：开运算 + 中值滤波 + 小连通域剔除（仅作用于分割用 binary）
  const morphOpenRadius = opts.morphOpenRadius ?? 0;
  if (morphOpenRadius > 0) {
    binary = openBinary(binary, width, height, morphOpenRadius);
  }
  const medianRadius = opts.medianRadius ?? MEDIAN_RADIUS;
  const denoiseMinArea = opts.denoiseMinArea ?? DENOISE_MIN_AREA;
  if (medianRadius > 0) {
    binary = medianFilterBinary(binary, width, height, medianRadius);
  }
  report('denoise', 88);
  binary = removeSmallComponents(binary, width, height, denoiseMinArea);
  report('denoise', 100);

  return {
    width,
    height,
    deskewDeg,
    pxPerMm: targetDpi / 25.4,
    binary,
    layoutBinary,
  };
}
