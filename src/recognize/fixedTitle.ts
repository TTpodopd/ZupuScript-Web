/**
 * 固定识别《倪氏宗譜》左侧书名栏。
 * 仅处理左侧区域；按 x 聚类、合并断裂碎片后固定填入四字。
 */
import { median } from '@/lib/utils';
import type { CharItem } from '@/model/types';

export const FIXED_BOOK_TITLE = '倪氏宗譜';

export interface FixedTitleResult {
  assignments: Map<string, string>;
  /** 仅含四个书名字符组的主框/碎片框，不包含下方页码与书签。 */
  consumedIds: Set<string>;
  titleRegion?: [number, number, number, number];
}

export interface FixedTitleDebug {
  leftCount: number;
  clusterCount: number;
  clusters: Array<{ cx: number; count: number; medH: number }>;
  picked: Array<{ id: string; cx: number; cy: number; h: number }>;
  reason: string;
}

let lastDebug: FixedTitleDebug | null = null;
export function getFixedTitleDebug(): FixedTitleDebug | null { return lastDebug; }

function clusterByX(chars: CharItem[], gapPx: number): CharItem[][] {
  const sorted = [...chars].sort((a, b) => a.cx - b.cx);
  const clusters: CharItem[][] = sorted.length ? [[sorted[0]]] : [];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = clusters[clusters.length - 1];
    const refX = median(last.map((c) => c.cx));
    if (sorted[i].cx - refX <= gapPx) last.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  return clusters;
}

interface CharGroup { members: CharItem[]; cy: number; h: number }

function groupFragments(col: CharItem[], colMedH: number): CharGroup[] {
  const sorted = [...col].sort((a, b) => a.cy - b.cy);
  const groups: CharItem[][] = sorted.length ? [[sorted[0]]] : [];
  for (let i = 1; i < sorted.length; i += 1) {
    const group = groups[groups.length - 1];
    const prev = group[group.length - 1];
    if (sorted[i].cy - prev.cy < colMedH * 0.6) group.push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map((members) => {
    const y0 = Math.min(...members.map((m) => m.bbox[1]));
    const y1 = Math.max(...members.map((m) => m.bbox[3]));
    return { members, cy: (y0 + y1) / 2, h: y1 - y0 };
  });
}

export function resolveFixedBookTitle(chars: CharItem[], width: number): FixedTitleResult {
  const glyphs = [...FIXED_BOOK_TITLE];
  const empty = (): FixedTitleResult => ({ assignments: new Map(), consumedIds: new Set() });
  const left = chars.filter((c) => c.cx < width * 0.4);
  const describe = (clusters: CharItem[][], picked: CharGroup[], reason: string) => {
    lastDebug = {
      leftCount: left.length,
      clusterCount: clusters.length,
      clusters: clusters.map((c) => ({
        cx: Math.round(median(c.map((x) => x.cx))),
        count: c.length,
        medH: Math.round(median(c.map((x) => x.bbox[3] - x.bbox[1]))),
      })),
      picked: picked.map((g) => ({
        id: g.members[0].id,
        cx: Math.round(g.members[0].cx),
        cy: Math.round(g.cy),
        h: Math.round(g.h),
      })),
      reason,
    };
  };

  if (left.length < glyphs.length) {
    describe([], [], '左侧字框不足 4 个');
    return empty();
  }
  const gapPx = Math.max(24, median(left.map((c) => c.bbox[3] - c.bbox[1])) * 1.2);
  const clusters = clusterByX(left, gapPx);
  const ranked = clusters
    .map((col) => ({ col, medH: median(col.map((c) => c.bbox[3] - c.bbox[1])) }))
    .sort((a, b) => b.medH - a.medH);

  for (const { col, medH } of ranked) {
    const solid = col.filter((c) => c.bbox[3] - c.bbox[1] >= medH * 0.5);
    const groups = groupFragments(solid, medH);
    if (groups.length < glyphs.length) continue;
    const top = groups.slice(0, glyphs.length);
    const heights = top.map((g) => g.h);
    const topMedH = median(heights);
    const colIds = new Set(col.map((c) => c.id));
    const otherHeights = chars.filter((c) => !colIds.has(c.id)).map((c) => c.bbox[3] - c.bbox[1]);
    if (otherHeights.length && topMedH < median(otherHeights) * 1.12) continue;
    if (heights.some((h) => h < topMedH * 0.55 || h > topMedH * 1.6)) continue;
    if (top.slice(1).some((g, i) => g.cy - top[i].cy < topMedH * 0.7 || g.cy - top[i].cy > topMedH * 3.5)) continue;

    const assignments = new Map<string, string>();
    const consumedIds = new Set<string>();
    top.forEach((group, index) => {
      group.members.forEach((member, memberIndex) => {
        if (memberIndex === 0) assignments.set(member.id, glyphs[index]);
        consumedIds.add(member.id);
      });
    });
    const regionPad = topMedH * 0.35;
    const titleRegion: [number, number, number, number] = [
      Math.min(...top.flatMap((g) => g.members.map((m) => m.bbox[0]))) - regionPad,
      Math.min(...top.flatMap((g) => g.members.map((m) => m.bbox[1]))) - regionPad,
      Math.max(...top.flatMap((g) => g.members.map((m) => m.bbox[2]))) + regionPad,
      Math.max(...top.flatMap((g) => g.members.map((m) => m.bbox[3]))) + regionPad,
    ];
    describe(clusters, top, '命中');
    return { assignments, consumedIds, titleRegion };
  }
  describe(clusters, [], '未找到大字书名栏');
  return empty();
}

export function collectFixedBookTitle(chars: CharItem[], width: number): Map<string, string> {
  return resolveFixedBookTitle(chars, width).assignments;
}