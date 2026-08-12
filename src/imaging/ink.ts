/**
 * 原图二值墨迹测量：质心、紧框、填充率（定位与校验共用）。
 */
import type { CharItem } from '@/model/types';

export interface InkMetrics {
  inkCx: number;
  inkCy: number;
  tight: [number, number, number, number];
  fillRatio: number;
  inkArea: number;
}

export function inkCentroidInRect(
  bin: Uint8Array,
  pageW: number,
  pageH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { cx: number; cy: number } | null {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(pageW, x + w);
  const y1 = Math.min(pageH, y + h);
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      if (!bin[yy * pageW + xx]) continue;
      sumX += xx;
      sumY += yy;
      n += 1;
    }
  }
  return n > 0 ? { cx: sumX / n, cy: sumY / n } : null;
}

/** 在 bbox 内统计原图墨迹：质心、紧框、填充率 */
export function inkMetricsInBbox(
  bin: Uint8Array,
  pageW: number,
  pageH: number,
  bbox: [number, number, number, number],
): InkMetrics | null {
  const bx0 = Math.max(0, Math.floor(bbox[0]));
  const by0 = Math.max(0, Math.floor(bbox[1]));
  const bx1 = Math.min(pageW, Math.ceil(bbox[2]));
  const by1 = Math.min(pageH, Math.ceil(bbox[3]));
  if (bx1 <= bx0 || by1 <= by0) return null;

  let minX = pageW;
  let minY = pageH;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  const boxArea = (bx1 - bx0) * (by1 - by0);

  for (let y = by0; y < by1; y += 1) {
    for (let x = bx0; x < bx1; x += 1) {
      if (!bin[y * pageW + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      n += 1;
    }
  }
  if (n === 0) return null;

  return {
    inkCx: sumX / n,
    inkCy: sumY / n,
    tight: [minX, minY, maxX + 1, maxY + 1],
    fillRatio: n / Math.max(1, boxArea),
    inkArea: n,
  };
}

/** 将字框与中心锁定到原图墨迹（一比一定位） */
export function refineCharBoxToInk(
  char: CharItem,
  bin: Uint8Array,
  pageW: number,
  pageH: number,
  padRatio = 0.08,
): CharItem {
  const metrics = inkMetricsInBbox(bin, pageW, pageH, char.bbox);
  if (!metrics || metrics.inkArea < 4) return char;

  const [tx0, ty0, tx1, ty1] = metrics.tight;
  const tw = tx1 - tx0;
  const th = ty1 - ty0;
  const pad = Math.max(1, Math.round(Math.max(tw, th) * padRatio));

  return {
    ...char,
    cx: metrics.inkCx,
    cy: metrics.inkCy,
    bbox: [
      Math.max(0, tx0 - pad),
      Math.max(0, ty0 - pad),
      Math.min(pageW, tx1 + pad),
      Math.min(pageH, ty1 + pad),
    ],
  };
}

export function refineAllCharBoxes(
  chars: CharItem[],
  bin: Uint8Array,
  pageW: number,
  pageH: number,
): CharItem[] {
  return chars.map((c) => refineCharBoxToInk(c, bin, pageW, pageH));
}
