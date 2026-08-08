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

/** 一维 x 聚类：同列容差 ≈ 0.6 字宽 */
export function clusterCharColumns(chars: CharItem[], charSideRef?: number): CharColumn[] {
  if (chars.length === 0) return [];
  const side = charSideRef ?? estimateCharSide(chars);
  const tol = side * 0.6;
  const sorted = [...chars].sort((a, b) => a.cx - b.cx);
  const groups: CharItem[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const lastGroup = groups[groups.length - 1];
    const refX = median(lastGroup.map((c) => c.cx));
    if (cur.cx - refX < tol) lastGroup.push(cur);
    else groups.push([cur]);
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

export function applyColumnStructure(
  chars: CharItem[],
  charSideRef?: number,
): CharItem[] {
  const side = charSideRef ?? estimateCharSide(chars);
  const columns = clusterCharColumns(chars, side);
  const spacingFlags = flagColumnSpacingAnomalies(chars, side);
  const byId = new Map(chars.map((c) => [c.id, { ...c }]));

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
