/**
 * 将视觉模型边框定位规则与本地 CV 结果合并，产出最终 borderRects / tagRects。
 */
import { detectRects, isPlausibleBorderBar } from '@/layout/detect';
import { filterSolidGraphicRects, rectContainsCharCenters } from '@/layout/graphicBlock';
import type { BorderLayoutGuide, BorderRect, TagRect } from '@/model/types';
import { uuid } from '@/lib/utils';

function normToPx(
  v: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): BorderRect {
  return {
    id: uuid(),
    x: Math.round(v.x * width),
    y: Math.round(v.y * height),
    w: Math.max(1, Math.round(v.w * width)),
    h: Math.max(1, Math.round(v.h * height)),
  };
}

function iou(a: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>, b: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function overlapsExcludeZone(
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
  guide: BorderLayoutGuide,
  width: number,
  height: number,
): boolean {
  for (const z of guide.excludeZones) {
    const zone = normToPx(z, width, height);
    if (iou(rect, zone) > 0.35) return true;
  }
  return false;
}

function visionBarsToRects(guide: BorderLayoutGuide, width: number, height: number, bin: Uint8Array): BorderRect[] {
  const out: BorderRect[] = [];
  for (const bar of guide.borderBars) {
    if (bar.confidence < 0.45) continue;
    const rect = normToPx(bar, width, height);
    if (rect.w < 2 || rect.h < 2) continue;
    if (overlapsExcludeZone(rect, guide, width, height)) continue;
    if (!isPlausibleBorderBar(bin, width, height, rect)) continue;
    out.push(rect);
  }
  return out;
}

function visionTagsToRects(guide: BorderLayoutGuide, width: number, height: number, bin: Uint8Array): TagRect[] {
  return filterSolidGraphicRects(
    guide.tagBlocks
      .filter((t) => t.confidence >= 0.62 && t.w > 0.01 && t.h > 0.01)
      .map((t) => normToPx(t, width, height)),
    bin,
    width,
    height,
  );
}

function mergeBorderRects(vision: BorderRect[], local: BorderRect[]): BorderRect[] {
  const out = [...vision];
  for (const l of local) {
    if (!out.some((v) => iou(v, l) > 0.35)) out.push(l);
  }
  return out;
}

function mergeTagRects(vision: TagRect[], local: TagRect[]): TagRect[] {
  const out = [...vision];
  for (const l of local) {
    if (!out.some((v) => iou(v, l) > 0.35)) out.push(l);
  }
  return out;
}

export interface MergedLayoutRects {
  borderRects: BorderRect[];
  tagRects: TagRect[];
  rectMask: Uint8Array;
}

/**
 * 本地 CV 检测 + 视觉规则合并。
 * 视觉 frame 条优先；本地结果补漏；excludeZones 剔除误检。
 */
export function mergeLayoutWithGuide(
  bin: Uint8Array,
  width: number,
  height: number,
  local: { borderRects: BorderRect[]; tagRects: TagRect[]; rectMask: Uint8Array },
  guide: BorderLayoutGuide,
): MergedLayoutRects {
  const visionBorders = visionBarsToRects(guide, width, height, bin);
  const visionTags = visionTagsToRects(guide, width, height, bin);

  let borderRects = mergeBorderRects(visionBorders, local.borderRects);
  let tagRects = mergeTagRects(visionTags, local.tagRects);

  // 视觉确认有外框但条数不足时，用 frame.inset + thicknessPx 补框
  if (guide.frame.hasOuterFrame && borderRects.filter((r) => Math.max(r.w, r.h) > Math.min(width, height) * 0.2).length < 2) {
    const t = guide.frame.thicknessPx ?? Math.max(4, Math.round(Math.min(width, height) * 0.015));
    const inset = guide.frame.inset ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const x0 = Math.round(inset.left * width);
    const y0 = Math.round(inset.top * height);
    const x1 = Math.round((1 - inset.right) * width);
    const y1 = Math.round((1 - inset.bottom) * height);
    const synthetic: BorderRect[] = [
      { id: uuid(), x: x0, y: y0, w: x1 - x0, h: t },
      { id: uuid(), x: x0, y: y1 - t, w: x1 - x0, h: t },
      { id: uuid(), x: x0, y: y0, w: t, h: y1 - y0 },
      { id: uuid(), x: x1 - t, y: y0, w: t, h: y1 - y0 },
    ];
    for (const s of synthetic) {
      if (isPlausibleBorderBar(bin, width, height, s) && !borderRects.some((b) => iou(b, s) > 0.3)) {
        borderRects.push(s);
      }
    }
  }

  // 剔除落在 excludeZones 内的 local 误检
  borderRects = borderRects.filter((r) => !overlapsExcludeZone(r, guide, width, height));
  tagRects = filterSolidGraphicRects(tagRects, bin, width, height);

  return { borderRects, tagRects, rectMask: buildRectMask(borderRects, tagRects, width, height, bin) };
}

function buildRectMask(
  borderRects: BorderRect[],
  tagRects: TagRect[],
  width: number,
  height: number,
  bin: Uint8Array,
): Uint8Array {
  const rectMask = new Uint8Array(bin.length);
  const mark = (rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>) => {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) rectMask[y * width + x] = 1;
    }
  };
  for (const r of borderRects) mark(r);
  for (const r of tagRects) mark(r);
  return rectMask;
}

/** 用全页字符探测剔除误分为装饰块的文字区，返回最终 tagRects */
export function finalizeTagRects(
  tagRects: TagRect[],
  probeChars: Array<{ cx: number; cy: number }>,
  bin: Uint8Array,
  width: number,
  height: number,
): TagRect[] {
  return filterSolidGraphicRects(
    tagRects.filter((r) => !rectContainsCharCenters(r, probeChars, 2)),
    bin,
    width,
    height,
  );
}

/** 无视觉 guide 时直接本地检测 */
export function detectLayoutLocal(bin: Uint8Array, width: number, height: number) {
  return detectRects(bin, width, height);
}
