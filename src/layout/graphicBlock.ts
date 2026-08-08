/**
 * 实心装饰块 vs 文字区域判别。
 * 族谱页中：装饰黑块 / 书标 → 高填充、少字级连通域、行/列投影无规律间隙；
 * 竖排/横排文字 → 周期性行/列空白、多个字级连通域、填充率中等。
 */
import { CHAR_MAX_SIZE, CHAR_MIN_AREA, CHAR_MIN_SIZE } from '@/lib/constants';
import { connectedComponents } from '@/imaging/raster';

export interface BlockContentStats {
  fill: number;
  charLikeCount: number;
  rowGapCount: number;
  colGapCount: number;
  maxRowInkRatio: number;
  maxColInkRatio: number;
}

function rectSlice(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): { x0: number; y0: number; x1: number; y1: number; local: Uint8Array; w: number; h: number } | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 4 || rh < 4) return null;
  const local = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) local[y * rw + x] = bin[(y0 + y) * width + (x0 + x)];
  }
  return { x0, y0, x1, y1, local, w: rw, h: rh };
}

function countGapTransitions(values: number[], threshold: number): number {
  if (values.length < 3) return 0;
  let gaps = 0;
  let inGap = values[0] < threshold;
  for (let i = 1; i < values.length; i += 1) {
    const gap = values[i] < threshold;
    if (gap && !inGap) gaps += 1;
    inGap = gap;
  }
  return gaps;
}

/** 分析区块内墨迹结构 */
export function analyzeBlockContent(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): BlockContentStats | null {
  const slice = rectSlice(bin, width, height, rect);
  if (!slice) return null;
  const { local, w, h } = slice;
  let ink = 0;
  const rowInk: number[] = [];
  const colInk = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      if (local[y * w + x]) {
        ink += 1;
        row += 1;
        colInk[x] += 1;
      }
    }
    rowInk.push(row);
  }
  const fill = ink / (w * h);
  const maxRow = Math.max(...rowInk, 1);
  const maxCol = Math.max(...colInk, 1);
  const rowGapCount = countGapTransitions(rowInk, maxRow * 0.22);
  const colGapCount = countGapTransitions(colInk, maxCol * 0.22);

  const { boxes } = connectedComponents(local, w, h);
  const charLikeCount = boxes.filter((b) => {
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    const bFill = b.area / Math.max(1, b.w * b.h);
    return (
      b.area >= CHAR_MIN_AREA &&
      b.w >= CHAR_MIN_SIZE &&
      b.h >= CHAR_MIN_SIZE &&
      b.w <= CHAR_MAX_SIZE &&
      b.h <= CHAR_MAX_SIZE &&
      aspect <= 2.8 &&
      bFill >= 0.08
    );
  }).length;

  return {
    fill,
    charLikeCount,
    rowGapCount,
    colGapCount,
    maxRowInkRatio: maxRow / w,
    maxColInkRatio: maxCol / h,
  };
}

/** 是否像竖排/横排文字区域（不应作为实心装饰块） */
export function isTextLikeBlock(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  const stats = analyzeBlockContent(bin, width, height, rect);
  if (!stats) return false;
  const tall = rect.h >= rect.w * 1.15;
  const wide = rect.w >= rect.h * 1.15;

  if (stats.charLikeCount >= 3) return true;
  if (tall && stats.rowGapCount >= 4 && stats.fill < 0.72) return true;
  if (wide && stats.colGapCount >= 4 && stats.fill < 0.72) return true;
  if (stats.fill < 0.48 && stats.charLikeCount >= 2) return true;
  // 竖排标题列：中等填充 + 明显行间隙
  if (tall && stats.rowGapCount >= 3 && stats.fill >= 0.35 && stats.fill <= 0.68) return true;
  return false;
}

/** 是否为应渲染为实心黑块的装饰图形 */
export function isSolidGraphicBlock(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  if (isTextLikeBlock(bin, width, height, rect)) return false;
  const stats = analyzeBlockContent(bin, width, height, rect);
  if (!stats) return false;

  if (stats.fill >= 0.78 && stats.charLikeCount <= 1) return true;
  if (stats.fill >= 0.65 && stats.rowGapCount <= 1 && stats.colGapCount <= 1 && stats.charLikeCount <= 1) {
    return true;
  }
  // 小面积高填充书标 / 折角
  if (rect.w * rect.h < 8000 && stats.fill >= 0.7 && stats.charLikeCount === 0) return true;
  return false;
}

export function filterSolidGraphicRects<T extends { x: number; y: number; w: number; h: number }>(
  rects: T[],
  bin: Uint8Array,
  width: number,
  height: number,
): T[] {
  return rects.filter((r) => isSolidGraphicBlock(bin, width, height, r));
}

/** 装饰块内是否包含足够多已分割字符（说明误分为图形） */
export function rectContainsCharCenters(
  rect: { x: number; y: number; w: number; h: number },
  chars: Array<{ cx: number; cy: number }>,
  minCount = 2,
): boolean {
  let count = 0;
  for (const c of chars) {
    if (c.cx >= rect.x && c.cx <= rect.x + rect.w && c.cy >= rect.y && c.cy <= rect.y + rect.h) count += 1;
    if (count >= minCount) return true;
  }
  return false;
}
