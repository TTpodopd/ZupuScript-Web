/**
 * 坐标与字号标定（F5.x，全本地）。
 * 换算公式集中在本文件（共享约定）：
 * - pt = 字面高px / PX_PER_MM / 0.352778（F5.1）
 * - 线宽 pt = px / PX_PER_MM × 2.834645669（F5.3）
 * - 页面 mm = px / PX_PER_MM（F5.4）
 */
import { MM_PER_PT, PT_PER_MM } from '@/lib/constants';
import type { CharItem, FontGroup, FontSizes, Page } from '@/model/types';
import { median } from '@/lib/utils';

export function pxToMm(px: number, pxPerMm: number): number {
  return px / pxPerMm;
}

export function mmToPx(mm: number, pxPerMm: number): number {
  return mm * pxPerMm;
}

/** F5.1：字面高 px → 字号 pt */
export function charHeightToPt(heightPx: number, pxPerMm: number): number {
  if (pxPerMm <= 0) return 0;
  return heightPx / pxPerMm / MM_PER_PT;
}

/** F5.3：线宽 px → pt */
export function lineWidthToPt(widthPx: number, pxPerMm: number): number {
  if (pxPerMm <= 0) return 0;
  return (widthPx / pxPerMm) * PT_PER_MM;
}

/** F5.4：页面像素尺寸 → mm */
export function pageMmFromPx(widthPx: number, heightPx: number, pxPerMm: number): [number, number] {
  return [pxToMm(widthPx, pxPerMm), pxToMm(heightPx, pxPerMm)];
}

/**
 * 字号聚类分组（F5.2）：按包围盒高度一维聚类（最多 3 组 + 特大标题组）。
 * 简单实现：高度排序后按 >1.3 倍间隔切分，组内取中位数换算 pt。
 * @returns 每组代表高度（px）升序
 */
export function clusterCharHeights(chars: CharItem[]): number[] {
  if (chars.length === 0) return [];
  const heights = chars.map((c) => c.bbox[3] - c.bbox[1]).sort((a, b) => a - b);
  const groups: number[][] = [[heights[0]]];
  for (let i = 1; i < heights.length; i++) {
    const cur = groups[groups.length - 1];
    const ref = median(cur);
    if (heights[i] > ref * 1.3 && groups.length < 4) {
      groups.push([heights[i]]);
    } else {
      cur.push(heights[i]);
    }
  }
  return groups.map((g) => median(g));
}

export interface CalibrationResult {
  fontSizes: FontSizes;
  /** 字符分组与字号写回后的字符表 */
  chars: CharItem[];
}

/** 组索引 → FontGroup 语义：最小=正文，次小=排行，最大=标题；书名页码由位置人工改 */
function groupNameForRank(rankAsc: number, total: number): FontGroup {
  if (total <= 1) return 'body';
  if (rankAsc === total - 1) return 'title';
  if (rankAsc === 0) return 'body';
  return 'rank';
}

/**
 * 自动标定整页：
 * 1. 聚类字号分组；2. 每组高度中位数 → pt；3. 写回 char.pt 与 char.group。
 * @param overrides 人工覆盖的字号（F5.5），优先级最高
 */
export function calibratePage(page: Page, overrides?: Partial<FontSizes>): CalibrationResult {
  const pxPerMm = page.calibration.pxPerMm;
  const heights = clusterCharHeights(page.chars);
  const fontSizes: FontSizes = { body: 0, title: 0, pageno: 0, rank: 0 };

  // 每组代表高度 → pt
  const groupPts = heights.map((h) => Math.round(charHeightToPt(h, pxPerMm) * 10) / 10);
  heights.forEach((_h, rankAsc) => {
    const g = groupNameForRank(rankAsc, heights.length);
    fontSizes[g] = groupPts[rankAsc];
  });
  if (fontSizes.rank === 0) fontSizes.rank = fontSizes.body;
  if (fontSizes.title === 0) fontSizes.title = fontSizes.body;
  if (fontSizes.pageno === 0) fontSizes.pageno = fontSizes.body;

  // 人工覆盖
  if (overrides) {
    for (const k of ['body', 'title', 'pageno', 'rank'] as const) {
      const v = overrides[k];
      if (v !== undefined && v > 0) fontSizes[k] = v;
    }
  }

  // 写回字符：按高度就近归组
  const chars = page.chars.map((c) => {
    const h = c.bbox[3] - c.bbox[1];
    let bestRank = 0;
    let bestDist = Infinity;
    heights.forEach((rep, rank) => {
      const d = Math.abs(h - rep);
      if (d < bestDist) {
        bestDist = d;
        bestRank = rank;
      }
    });
    const group = c.kind === 'side' ? 'pageno' : groupNameForRank(bestRank, heights.length);
    return { ...c, group, pt: fontSizes[group] };
  });

  return { fontSizes, chars };
}

/** 单字重标定（人工改组后调用） */
export function ptForGroup(group: FontGroup, fontSizes: FontSizes): number {
  return fontSizes[group];
}
