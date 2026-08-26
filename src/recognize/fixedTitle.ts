/**
 * Legacy fixed-title detector kept for backwards-compatible project tests.
 *
 * The production analysis/recognition pipeline no longer calls this module:
 * left-margin title boxes are now content-agnostic and are filled by OCR.
 */
import { median } from '@/lib/utils';
import type { CharItem } from '@/model/types';

/** @deprecated Only retained for importing old project fixtures. */
export const FIXED_BOOK_TITLE = '倪氏宗譜';

export interface FixedTitleResult {
  assignments: Map<string, string>;
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
    if (sorted[i].cx - median(last.map((c) => c.cx)) <= gapPx) last.push(sorted[i]);
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

/** @deprecated Production code intentionally does not use this sample-specific detector. */
export function resolveFixedBookTitle(chars: CharItem[], width: number): FixedTitleResult {
  const glyphs = [...FIXED_BOOK_TITLE];
  const left = chars.filter((c) => c.cx < width * 0.4);
  const empty = (reason: string): FixedTitleResult => {
    lastDebug = { leftCount: left.length, clusterCount: 0, clusters: [], picked: [], reason };
    return { assignments: new Map(), consumedIds: new Set() };
  };
  if (left.length < glyphs.length) return empty('左侧字框不足 4 个');

  const gapPx = Math.max(24, median(left.map((c) => c.bbox[3] - c.bbox[1])) * 1.2);
  const clusters = clusterByX(left, gapPx);
  const ranked = clusters
    .map((col) => ({ col, medH: median(col.map((c) => c.bbox[3] - c.bbox[1])) }))
    .sort((a, b) => b.medH - a.medH);
  for (const { col, medH } of ranked) {
    const groups = groupFragments(col, medH);
    if (groups.length < glyphs.length) continue;
    const top = groups.slice(0, glyphs.length);
    const heights = top.map((g) => g.h);
    const topMedH = median(heights);
    if (heights.some((h) => h < topMedH * 0.55 || h > topMedH * 1.6)) continue;
    if (top.slice(1).some((g, i) => g.cy - top[i].cy < topMedH * 0.7 || g.cy - top[i].cy > topMedH * 3.5)) continue;
    const assignments = new Map<string, string>();
    const consumedIds = new Set<string>();
    top.forEach((group, index) => group.members.forEach((member, memberIndex) => {
      if (memberIndex === 0) assignments.set(member.id, glyphs[index]);
      consumedIds.add(member.id);
    }));
    const pad = topMedH * 0.35;
    const titleRegion: [number, number, number, number] = [
      Math.min(...top.flatMap((g) => g.members.map((m) => m.bbox[0]))) - pad,
      Math.min(...top.flatMap((g) => g.members.map((m) => m.bbox[1]))) - pad,
      Math.max(...top.flatMap((g) => g.members.map((m) => m.bbox[2]))) + pad,
      Math.max(...top.flatMap((g) => g.members.map((m) => m.bbox[3]))) + pad,
    ];
    lastDebug = {
      leftCount: left.length,
      clusterCount: clusters.length,
      clusters: clusters.map((c) => ({ cx: Math.round(median(c.map((x) => x.cx))), count: c.length, medH: Math.round(median(c.map((x) => x.bbox[3] - x.bbox[1]))) })),
      picked: top.map((g) => ({ id: g.members[0].id, cx: Math.round(g.members[0].cx), cy: Math.round(g.cy), h: Math.round(g.h) })),
      reason: '命中（仅兼容旧测试）',
    };
    return { assignments, consumedIds, titleRegion };
  }
  return empty('未找到兼容旧测试的固定标题列');
}

/** @deprecated Use content-agnostic margin boxes plus OCR in production. */
export function collectFixedBookTitle(chars: CharItem[], width: number): Map<string, string> {
  return resolveFixedBookTitle(chars, width).assignments;
}
