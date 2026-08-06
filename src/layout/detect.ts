/**
 * 版面检测（F3.1–F3.3，全本地）：
 * 形态学开运算（横核/纵核）→ 外框实心黑条、谱系横线、竖线。
 *
 * 实现说明：矩形核 (k,1) / (1,k) 的开运算等价于「保留长度 ≥ k 的连续墨迹行程」，
 * 这里用行程长度法实现，与 OpenCV morphologyEx 结果一致且更快。
 */
import {
  KERNEL_H_LEN,
  KERNEL_LINE_V_LEN,
  KERNEL_V_LEN,
  MIN_LINE_LEN,
} from '@/lib/constants';
import { connectedComponents } from '@/imaging/raster';
import type { BorderRect, TagRect, TreeLine } from '@/model/types';
import { uuid } from '@/lib/utils';

/**
 * 行程开运算：axis='h' 保留水平连续 ≥ len 的墨迹段；axis='v' 保留垂直段。
 */
export function openingByRunLength(
  bin: Uint8Array,
  width: number,
  height: number,
  axis: 'h' | 'v',
  len: number,
): Uint8Array {
  const out = new Uint8Array(bin.length);
  if (axis === 'h') {
    for (let y = 0; y < height; y++) {
      let runStart = -1;
      for (let x = 0; x <= width; x++) {
        const ink = x < width ? bin[y * width + x] : 0;
        if (ink && runStart < 0) runStart = x;
        if (!ink && runStart >= 0) {
          if (x - runStart >= len) {
            out.fill(1, y * width + runStart, y * width + x);
          }
          runStart = -1;
        }
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      let runStart = -1;
      for (let y = 0; y <= height; y++) {
        const ink = y < height ? bin[y * width + x] : 0;
        if (ink && runStart < 0) runStart = y;
        if (!ink && runStart >= 0) {
          if (y - runStart >= len) {
            for (let yy = runStart; yy < y; yy++) out[yy * width + x] = 1;
          }
          runStart = -1;
        }
      }
    }
  }
  return out;
}

/** 从开运算结果提取线段（连通域 → 中心线 + 厚度） */
function componentsToLines(opened: Uint8Array, width: number, height: number, orientation: 'h' | 'v'): TreeLine[] {
  const { boxes } = connectedComponents(opened, width, height);
  const lines: TreeLine[] = [];
  for (const b of boxes) {
    if (orientation === 'h') {
      if (b.w < MIN_LINE_LEN) continue;
      const cy = b.y + b.h / 2;
      lines.push({
        id: uuid(),
        x1: b.x,
        y1: cy,
        x2: b.x + b.w,
        y2: cy,
        widthPx: Math.max(1, Math.round(b.h)),
        orientation: 'h',
      });
    } else {
      if (b.h < MIN_LINE_LEN) continue;
      const cx = b.x + b.w / 2;
      lines.push({
        id: uuid(),
        x1: cx,
        y1: b.y,
        x2: cx,
        y2: b.y + b.h,
        widthPx: Math.max(1, Math.round(b.w)),
        orientation: 'v',
      });
    }
  }
  return lines;
}

export interface RectDetectResult {
  borderRects: BorderRect[];
  tagRects: TagRect[];
  /** 外框/装饰块掩码（供线段检测前剔除，避免粗条被误判为线） */
  rectMask: Uint8Array;
}

/**
 * 检测外框实心黑条与装饰块（F3.1/F3.5 第一步）。
 * 粗核开运算（横 80 / 纵 80）取交集区域 → 连通域 → 按长宽比与填充率分类。
 */
export function detectRects(bin: Uint8Array, width: number, height: number): RectDetectResult {
  const openH = openingByRunLength(bin, width, height, 'h', KERNEL_H_LEN);
  const openV = openingByRunLength(bin, width, height, 'v', KERNEL_V_LEN);
  // 交集：同时被横核与纵核保留的像素属于粗实心结构
  const solid = new Uint8Array(bin.length);
  for (let i = 0; i < solid.length; i++) {
    solid[i] = openH[i] | openV[i];
  }
  const { labels, boxes } = connectedComponents(solid, width, height);
  const borderRects: BorderRect[] = [];
  const tagRects: TagRect[] = [];
  const rectMask = new Uint8Array(bin.length);
  for (const b of boxes) {
    const longSide = Math.max(b.w, b.h);
    const shortSide = Math.min(b.w, b.h);
    const aspect = longSide / Math.max(1, shortSide);
    const fillRatio = b.area / (b.w * b.h);
    const isBorder = aspect >= 5 && longSide >= 150 && fillRatio >= 0.5;
    const isTag = !isBorder && b.w >= 30 && b.h >= 30 && fillRatio >= 0.55 && b.area >= 1200;
    if (!isBorder && !isTag) continue;
    const entry = { id: uuid(), x: b.x, y: b.y, w: b.w, h: b.h };
    if (isBorder) borderRects.push(entry);
    else tagRects.push(entry);
    // 掩码标记
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === b.label) rectMask[i] = 1;
    }
  }
  return { borderRects, tagRects, rectMask };
}

/**
 * 检测谱系横线与竖线（F3.2/F3.3）。
 * 先剔除粗实心块，再分别用横核 (≥40,1) 与纵核 (1,≥40) 开运算。
 */
export function detectTreeLines(bin: Uint8Array, width: number, height: number, rectMask: Uint8Array): TreeLine[] {
  const cleaned = new Uint8Array(bin.length);
  for (let i = 0; i < cleaned.length; i++) {
    cleaned[i] = bin[i] && !rectMask[i] ? 1 : 0;
  }
  const openH = openingByRunLength(cleaned, width, height, 'h', MIN_LINE_LEN);
  const openV = openingByRunLength(cleaned, width, height, 'v', KERNEL_LINE_V_LEN);
  const hLines = componentsToLines(openH, width, height, 'h');
  const vLines = componentsToLines(openV, width, height, 'v');
  return [...hLines, ...vLines];
}
