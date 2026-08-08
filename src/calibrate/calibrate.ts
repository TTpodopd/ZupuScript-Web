/**
 * 坐标与字号标定（F5.x，全本地）。
 * 换算公式集中在本文件（共享约定）：
 * - pt = 字面高px / PX_PER_MM / 0.352778（F5.1）
 * - 线宽 pt = px / PX_PER_MM × 2.834645669（F5.3）
 * - 页面 mm = px / PX_PER_MM（F5.4）
 */
import { FONT_CLUSTER_REL_TOL, MM_PER_PT, PT_PER_MM } from '@/lib/constants';
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

/** S7：从二值图测量字框内墨迹真实高度（用于 pt 换算） */
export function inkHeightPx(
  bin: Uint8Array,
  width: number,
  height: number,
  bbox: [number, number, number, number],
): number {
  const [x0, y0, x1, y1] = bbox;
  let minY = y1;
  let maxY = y0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
      if (!bin[y * width + x]) continue;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxY >= minY ? maxY - minY + 1 : Math.max(1, y1 - y0);
}

export interface CalibrateBinary {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * 字号聚类分组（F5.2 / S7.1）：按字面高度一维聚类，组间间隔 >15% 切分。
 */
export function clusterCharHeights(chars: CharItem[], heights?: number[]): number[] {
  if (chars.length === 0) return [];
  const values = heights ?? chars.map((c) => c.bbox[3] - c.bbox[1]);
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = groups[groups.length - 1];
    const ref = median(cur);
    if (sorted[i] > ref * (1 + FONT_CLUSTER_REL_TOL) && groups.length < 4) {
      groups.push([sorted[i]]);
    } else {
      cur.push(sorted[i]);
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

/** 面板展示用分组名称 */
export const FONT_GROUP_LABELS: Record<FontGroup, string> = {
  body: '正文（小字）',
  title: '标题（大字）',
  pageno: '页码/边栏',
  rank: '主文字（树谱字）',
};

export function countCharsByGroup(chars: CharItem[]): Record<FontGroup, number> {
  const counts: Record<FontGroup, number> = { body: 0, title: 0, pageno: 0, rank: 0 };
  for (const c of chars) counts[c.group]++;
  return counts;
}

/** 本页实际有字符的分组，按字数降序 */
export function activeFontGroups(chars: CharItem[]): FontGroup[] {
  const counts = countCharsByGroup(chars);
  const order: FontGroup[] = ['rank', 'body', 'title', 'pageno'];
  return order.filter((g) => counts[g] > 0).sort((a, b) => counts[b] - counts[a]);
}

/** 分组内字符当前字号（取中位数，用于面板显示） */
export function medianPtForGroup(chars: CharItem[], group: FontGroup): number {
  const pts = chars.filter((c) => c.group === group).map((c) => c.pt).filter((pt) => pt > 0);
  if (pts.length === 0) return 0;
  return Math.round(median(pts) * 10) / 10;
}

/** 全页字符当前字号（取中位数，用于面板显示） */
export function medianPtAllChars(chars: CharItem[]): number {
  const pts = chars.map((c) => c.pt).filter((pt) => pt > 0);
  if (pts.length === 0) return 0;
  return Math.round(median(pts) * 10) / 10;
}

/** 直接改全页字号（全局统一） */
export function applyFontSizeToAllChars(page: Page, pt: number): CalibrationResult {
  return {
    fontSizes: { body: pt, title: pt, pageno: pt, rank: pt },
    chars: page.chars.map((c) => ({ ...c, pt, edited: true })),
  };
}

/** 直接改某一组的字号，不重跑聚类（避免误改分组归属） */
export function applyFontSizeToGroup(page: Page, group: FontGroup, pt: number): CalibrationResult {
  return {
    fontSizes: { ...page.fontSizes, [group]: pt },
    chars: page.chars.map((c) => (c.group === group ? { ...c, pt, edited: true } : c)),
  };
}

/**
 * 自动标定整页：
 * 1. 聚类字号分组；2. 每组高度中位数 → pt；3. 写回 char.pt 与 char.group。
 * @param overrides 人工覆盖的字号（F5.5），优先级最高
 */
export function calibratePage(
  page: Page,
  overrides?: Partial<FontSizes>,
  binary?: CalibrateBinary,
): CalibrationResult {
  const pxPerMm = page.calibration.pxPerMm;
  const inkHeights = page.chars.map((c) => (
    binary
      ? inkHeightPx(binary.data, binary.width, binary.height, c.bbox)
      : c.bbox[3] - c.bbox[1]
  ));
  const heights = clusterCharHeights(page.chars, inkHeights);
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
  const chars = page.chars.map((c, idx) => {
    const h = inkHeights[idx] ?? c.bbox[3] - c.bbox[1];
    let bestRank = 0;
    let bestDist = Infinity;
    heights.forEach((rep, rank) => {
      const d = Math.abs(h - rep);
      if (d < bestDist) {
        bestDist = d;
        bestRank = rank;
      }
    });
    const group =
      c.kind === 'side' && (c.group === 'title' || c.group === 'pageno')
        ? c.group
        : c.kind === 'side'
          ? 'pageno'
          : groupNameForRank(bestRank, heights.length);
    return { ...c, group, pt: fontSizes[group] };
  });

  return { fontSizes, chars };
}

/** 单字重标定（人工改组后调用） */
export function ptForGroup(group: FontGroup, fontSizes: FontSizes): number {
  return fontSizes[group];
}
