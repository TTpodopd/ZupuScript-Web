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
  // 只让尚未分类的普通正文建立自动字号簇。已由版面规则标出的标题/行款/页码
  // 若混入聚类，会把较小的行款误当作正文基准，并把真正正文整体改组。
  const autoEntries = page.chars
    .map((char, index) => ({ char, height: inkHeights[index] }))
    .filter(({ char }) => char.kind !== 'side' && char.group === 'body');
  const bodyMedian = median(autoEntries.map(({ height }) => height).filter((h) => h > 0));
  const clusteredEntries = bodyMedian > 0
    ? autoEntries.filter(({ height }) => height >= bodyMedian * 0.7)
    : autoEntries;
  const autoChars = clusteredEntries.length > 0
    ? clusteredEntries.map(({ char }) => char)
    : autoEntries.length > 0 ? autoEntries.map(({ char }) => char) : page.chars;
  const autoHeights = clusteredEntries.length > 0
    ? clusteredEntries.map(({ height }) => height)
    : autoEntries.length > 0 ? autoEntries.map(({ height }) => height) : inkHeights;
  const heights = clusterCharHeights(autoChars, autoHeights);
  const fontSizes: FontSizes = { body: 0, title: 0, pageno: 0, rank: 0 };

  // 每组代表高度 → pt
  const groupPts = heights.map((h) => Math.round(charHeightToPt(h, pxPerMm) * 10) / 10);
  heights.forEach((_h, rankAsc) => {
    const g = groupNameForRank(rankAsc, heights.length);
    fontSizes[g] = groupPts[rankAsc];
  });

  // 先按高度给普通正文分组；版面阶段已明确识别出的标题、行款和页边字必须保留语义，
  // 否则「長子/次子」等横排标签会在字号标定时被重新覆盖成正文。
  const groups = page.chars.map((c, idx): FontGroup => {
    if (c.kind === 'side') return c.group === 'title' ? 'title' : 'pageno';
    if (c.group !== 'body') return c.group;
    const h = inkHeights[idx] ?? c.bbox[3] - c.bbox[1];
    if (bodyMedian > 0 && h < bodyMedian * 0.7) return 'body';
    let bestRank = 0;
    let bestDist = Infinity;
    heights.forEach((rep, rank) => {
      const distance = Math.abs(h - rep);
      if (distance < bestDist) {
        bestDist = distance;
        bestRank = rank;
      }
    });
    return groupNameForRank(bestRank, heights.length);
  });

  // 对每个语义组单独取真实墨迹高度中位数。标题框的 padding、断笔和正文数量
  // 不再共同拉高或压低字号，四字书名与右侧世次标题会得到各自稳定字号。
  for (const group of ['body', 'title', 'rank'] as const) {
    const measured = inkHeights.filter((height, index) => (
      groups[index] === group
      && height > 0
      && (group !== 'body' || bodyMedian <= 0 || height >= bodyMedian * 0.7)
    ));
    if (measured.length > 0) {
      fontSizes[group] = Math.round(charHeightToPt(median(measured), pxPerMm) * 10) / 10;
    }
  }
  if (fontSizes.body === 0) fontSizes.body = groupPts[0] ?? 0;
  if (fontSizes.rank === 0) fontSizes.rank = fontSizes.body;
  if (fontSizes.title === 0) fontSizes.title = fontSizes.body;
  if (fontSizes.pageno === 0) fontSizes.pageno = fontSizes.body;

  // 页码使用与主体正文完全一致的字号。细横笔的真实墨迹高度不参与字号计算，
  // 左页边算法仅负责定位和字框；正文/标题/排行的标定规则保持不变。
  const hasPageNumbers = page.chars.some((c) => c.kind === 'side' && c.group === 'pageno');
  if (hasPageNumbers && fontSizes.body > 0) fontSizes.pageno = fontSizes.body;

  // 人工覆盖
  if (overrides) {
    for (const k of ['body', 'title', 'pageno', 'rank'] as const) {
      const v = overrides[k];
      if (v !== undefined && v > 0) fontSizes[k] = v;
    }
  }

  const chars = page.chars.map((c, idx) => {
    const group = groups[idx];
    return { ...c, group, pt: fontSizes[group] };
  });

  return { fontSizes, chars };
}

/** 单字重标定（人工改组后调用） */
export function ptForGroup(group: FontGroup, fontSizes: FontSizes): number {
  return fontSizes[group];
}
