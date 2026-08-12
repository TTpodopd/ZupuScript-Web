/**
 * S3 版面结构：列聚类、竖排人名 vs 横向排行标签、阅读顺序与字心间距异常检测。
 */
import type { CharItem, CharKind, FontGroup } from '@/model/types';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import { median } from '@/lib/utils';

export type ColumnKind = 'vertical_name' | 'rank_label' | 'mixed';

export interface CharColumn {
  cx: number;
  kind: ColumnKind;
  charIds: string[];
}

export function estimateCharSide(chars: Pick<CharItem, 'bbox'>[]): number {
  if (chars.length === 0) return 20;
  const sides = chars.map((c) => {
    const w = c.bbox[2] - c.bbox[0];
    const h = c.bbox[3] - c.bbox[1];
    return (w + h) / 2;
  });
  return median(sides);
}

/** 一维 x 聚类：相邻字 cx 距列心 <0.4 字宽且列宽 ≤0.48 字宽（防链式合并多列） */
export function clusterCharColumns(chars: CharItem[], charSideRef?: number): CharColumn[] {
  if (chars.length === 0) return [];
  const side = charSideRef ?? estimateCharSide(chars);
  const closeTol = side * 0.4;
  const maxSpan = side * 0.48;
  const sorted = [...chars].sort((a, b) => a.cx - b.cx);
  const groups: CharItem[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const group = groups[groups.length - 1];
    const refX = median(group.map((c) => c.cx));
    const minX = Math.min(...group.map((c) => c.cx), cur.cx);
    const maxX = Math.max(...group.map((c) => c.cx), cur.cx);
    if (cur.cx - refX < closeTol && maxX - minX <= maxSpan) {
      group.push(cur);
    } else {
      groups.push([cur]);
    }
  }
  return groups.map((group) => ({
    cx: median(group.map((c) => c.cx)),
    kind: classifyColumnKind(group, side),
    charIds: group.map((c) => c.id),
  }));
}

export function classifyColumnKind(chars: CharItem[], charSideRef: number): ColumnKind {
  if (chars.length >= 3) {
    const ys = chars.map((c) => c.cy).sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]);
    const meanGap = gaps.reduce((s, g) => s + g, 0) / Math.max(1, gaps.length);
    const std = Math.sqrt(gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / Math.max(1, gaps.length));
    if (std < 8 && meanGap > charSideRef * 0.5) return 'vertical_name';
  }
  if (chars.length === 2) {
    const [a, b] = chars;
    const dx = Math.abs(a.cx - b.cx);
    const dy = Math.abs(a.cy - b.cy);
    if (dy < charSideRef * 0.35 && Math.abs(dx - charSideRef) < 15) return 'rank_label';
  }
  return 'mixed';
}

/** 竖排：列从右到左，列内从上到下 */
export function sortCharsReadingOrder(chars: CharItem[], charSideRef?: number): CharItem[] {
  const side = charSideRef ?? estimateCharSide(chars);
  const columns = clusterCharColumns(chars, side);
  columns.sort((a, b) => b.cx - a.cx);
  const order: CharItem[] = [];
  const byId = new Map(chars.map((c) => [c.id, c]));
  for (const col of columns) {
    const colChars = col.charIds.map((id) => byId.get(id)).filter((c): c is CharItem => Boolean(c));
    colChars.sort((a, b) => a.cy - b.cy);
    order.push(...colChars);
  }
  return order;
}

/** 列内字心间距标准差 > 3px 或出现约 2 倍行距 → 标记可能漏字 */
export function flagColumnSpacingAnomalies(chars: CharItem[], charSideRef?: number): Set<string> {
  const flagged = new Set<string>();
  const side = charSideRef ?? estimateCharSide(chars);
  for (const col of clusterCharColumns(chars, side)) {
    const colChars = col.charIds
      .map((id) => chars.find((c) => c.id === id))
      .filter((c): c is CharItem => Boolean(c))
      .sort((a, b) => a.cy - b.cy);
    if (colChars.length < 3) continue;
    const xSpread = Math.max(...colChars.map((c) => c.cx)) - Math.min(...colChars.map((c) => c.cx));
    if (col.kind !== 'vertical_name' && xSpread > side * 0.65) continue;
    const gaps = colChars.slice(1).map((c, i) => c.cy - colChars[i].cy);
    const med = median(gaps);
    const std = Math.sqrt(gaps.reduce((s, g) => s + (g - med) ** 2, 0) / gaps.length);
    for (let i = 0; i < colChars.length; i += 1) {
      if (std > 3) flagged.add(colChars[i].id);
      if (i > 0 && gaps[i - 1] > med * 1.85) {
        flagged.add(colChars[i].id);
        flagged.add(colChars[i - 1].id);
      }
    }
  }
  return flagged;
}

function bboxOverlapRatio(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return inter / Math.min(areaA, areaB);
}

/** 剔除中心过近或 bbox 高度重叠的重复字框 */
export function dedupeOverlappingChars(chars: CharItem[], charSideRef?: number): CharItem[] {
  if (chars.length < 2) return chars;
  const side = charSideRef ?? estimateCharSide(chars);
  const minDist = side * 0.36;
  const sorted = [...chars].sort((a, b) => {
    const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
    const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
    return areaB - areaA;
  });
  const kept: CharItem[] = [];
  for (const c of sorted) {
    const dup = kept.some((k) => {
      const dist = Math.hypot(c.cx - k.cx, c.cy - k.cy);
      if (dist >= minDist) return false;
      // 横向相邻的两个独立字（如排行标签「次子」）中心距可小于 0.36 字宽，
      // 但包围盒不重叠且水平间隙足够，不能当作重复框删除。
      const hGap = Math.max(c.bbox[0], k.bbox[0]) - Math.min(c.bbox[2], k.bbox[2]);
      const vGap = Math.max(c.bbox[1], k.bbox[1]) - Math.min(c.bbox[3], k.bbox[3]);
      if (Math.max(hGap, vGap) >= side * 0.35) return false;
      return bboxOverlapRatio(c.bbox, k.bbox) > 0.22 || dist < side * 0.3;
    });
    if (!dup) kept.push(c);
  }
  return kept;
}

/**
 * 竖排列内 x 对齐、横向排行标签 y 对齐，消除分割字框漂移。
 * 仅对同列 ≥2 字生效；竖排 outlier（距列心 >0.5 字宽）不强行吸附。
 */
export function snapCharsToColumnCenters(chars: CharItem[], charSideRef?: number): CharItem[] {
  if (chars.length === 0) return [];
  const side = charSideRef ?? estimateCharSide(chars);
  const columns = clusterCharColumns(chars, side);
  const byId = new Map(
    chars.map((c) => [c.id, { ...c, bbox: [...c.bbox] as [number, number, number, number] }]),
  );

  for (const col of columns) {
    if (col.charIds.length < 2) continue;

    if (col.kind === 'rank_label') {
      const members = col.charIds.map((id) => byId.get(id)).filter((c): c is CharItem => Boolean(c));
      const colCy = median(members.map((c) => c.cy));
      for (const c of members) {
        const shiftY = colCy - c.cy;
        c.cy = colCy;
        c.bbox = [c.bbox[0], c.bbox[1] + shiftY, c.bbox[2], c.bbox[3] + shiftY];
      }
      continue;
    }

    const colCx = col.cx;
    for (const id of col.charIds) {
      const c = byId.get(id);
      if (!c || c.kind === 'side') continue;
      const shiftX = colCx - c.cx;
      if (Math.abs(shiftX) > side * 0.5) continue;
      c.cx = colCx;
      c.bbox = [c.bbox[0] + shiftX, c.bbox[1], c.bbox[2] + shiftX, c.bbox[3]];
    }

    // 列内行距规整：仅列内 x 已对齐（xSpread 小）且行距稳定时微调 cy
    const colChars = col.charIds
      .map((id) => byId.get(id))
      .filter((c): c is CharItem => Boolean(c && c.kind !== 'side'))
      .sort((a, b) => a.cy - b.cy);
    if (colChars.length < 3) continue;
    const xSpread = Math.max(...colChars.map((c) => c.cx)) - Math.min(...colChars.map((c) => c.cx));
    if (xSpread > side * 0.22) continue;
    const gaps = colChars.slice(1).map((c, i) => c.cy - colChars[i].cy);
    const medGap = median(gaps);
    if (medGap < side * 0.45) continue;
    const gapStd = Math.sqrt(gaps.reduce((s, g) => s + (g - medGap) ** 2, 0) / gaps.length);
    if (gapStd > side * 0.22) continue;

    const anchorY = colChars[0].cy;
    for (let i = 0; i < colChars.length; i += 1) {
      const c = colChars[i];
      const targetCy = anchorY + i * medGap;
      const shiftY = targetCy - c.cy;
      if (Math.abs(shiftY) > side * 0.28) continue;
      c.cy = targetCy;
      c.bbox = [c.bbox[0], c.bbox[1] + shiftY, c.bbox[2], c.bbox[3] + shiftY];
    }
  }

  return [...byId.values()];
}

export function applyColumnStructure(
  chars: CharItem[],
  charSideRef?: number,
): CharItem[] {
  const side = charSideRef ?? estimateCharSide(chars);
  const deduped = dedupeOverlappingChars(chars, side);
  const columns = clusterCharColumns(deduped, side);
  const spacingFlags = flagColumnSpacingAnomalies(deduped, side);
  const byId = new Map(deduped.map((c) => [c.id, { ...c }]));

  for (const col of columns) {
    for (const id of col.charIds) {
      const c = byId.get(id);
      if (!c) continue;
      if (c.kind === 'side') continue;
      if (col.kind === 'rank_label') {
        c.group = 'rank' as FontGroup;
        c.kind = 'text' as CharKind;
      } else if (col.kind === 'vertical_name') {
        c.group = c.group === 'pageno' ? 'pageno' : ('body' as FontGroup);
      }
      if (spacingFlags.has(id)) {
        c.note = 'spacing';
        if (c.conf >= CONFIDENCE_THRESHOLD) c.conf = CONFIDENCE_THRESHOLD - 0.02;
      }
    }
  }

  return sortCharsReadingOrder([...byId.values()], side);
}
