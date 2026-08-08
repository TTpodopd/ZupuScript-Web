/**
 * 页边文字专用分割：标题、页码等字号与正文差异大，单独多尺度处理，不改动正文区字框。
 */
import {
  CHAR_MAX_SIZE,
  CHAR_MERGE_GAP_FACTOR,
  CHAR_MERGE_OVERLAP_MIN,
  CHAR_MERGE_REL_AREA_MAX,
  CHAR_MIN_AREA,
  CHAR_MIN_SIZE,
  CHAR_SPLIT_REL_AREA,
  MARGIN_CONTENT_INSET_RATIO,
  MARGIN_EDGE_STRIP_RATIO,
} from '@/lib/constants';
import { connectedComponents, type ComponentBox } from '@/imaging/raster';
import type { CharItem } from '@/model/types';
import { dilateForCharacterGrouping } from '@/segment/segment';
import { median, uuid } from '@/lib/utils';

export interface PageContentBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type LayoutRect = { x: number; y: number; w: number; h: number };

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const span = Math.max(a1, b1) - Math.min(a0, b0);
  return span > 0 ? inter / span : 0;
}

function mergeBoxes(a: ComponentBox, b: ComponentBox): ComponentBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { label: a.label, x, y, w: x2 - x, h: y2 - y, area: a.area + b.area };
}

function tightenBox(bin: Uint8Array, width: number, height: number, box: ComponentBox): ComponentBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.h); y += 1) {
    for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.w); x += 1) {
      if (!bin[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { label: box.label, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: box.area };
}

function inkFillInBox(
  bin: Uint8Array,
  width: number,
  height: number,
  box: Pick<ComponentBox, 'x' | 'y' | 'w' | 'h'>,
): number {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(width, box.x + box.w);
  const y1 = Math.min(height, box.y + box.h);
  let ink = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) ink += bin[y * width + x];
  }
  return ink / Math.max(1, (x1 - x0) * (y1 - y0));
}

/** 由外框条带推断正文区；无框时用页面中央区域作 fallback */
export function inferPageContentBounds(
  width: number,
  height: number,
  borderRects: LayoutRect[] = [],
): PageContentBounds {
  const edge = Math.round(Math.min(width, height) * MARGIN_EDGE_STRIP_RATIO);
  const inset = Math.round(Math.min(width, height) * MARGIN_CONTENT_INSET_RATIO);
  let left = edge;
  let right = width - edge;
  let top = edge;
  let bottom = height - edge;

  const verticalBars = borderRects
    .filter((r) => r.h > r.w * 1.8 && r.h > height * 0.22)
    .sort((a, b) => a.x - b.x);
  const horizontalBars = borderRects
    .filter((r) => r.w > r.h * 1.8 && r.w > width * 0.22)
    .sort((a, b) => a.y - b.y);

  if (verticalBars.length >= 2) {
    left = Math.max(left, verticalBars[0].x + verticalBars[0].w + inset);
    right = Math.min(right, verticalBars[verticalBars.length - 1].x - inset);
  } else if (verticalBars.length === 1) {
    const bar = verticalBars[0];
    if (bar.x < width * 0.45) left = Math.max(left, bar.x + bar.w + inset);
    else right = Math.min(right, bar.x - inset);
  }

  if (horizontalBars.length >= 2) {
    top = Math.max(top, horizontalBars[0].y + horizontalBars[0].h + inset);
    bottom = Math.min(bottom, horizontalBars[horizontalBars.length - 1].y - inset);
  } else if (horizontalBars.length === 1) {
    const bar = horizontalBars[0];
    if (bar.y < height * 0.45) top = Math.max(top, bar.y + bar.h + inset);
    else bottom = Math.min(bottom, bar.y - inset);
  }

  return {
    left: Math.max(0, Math.min(left, width - 1)),
    right: Math.max(1, Math.min(right, width)),
    top: Math.max(0, Math.min(top, height - 1)),
    bottom: Math.max(1, Math.min(bottom, height)),
  };
}

export function isMarginPoint(cx: number, cy: number, bounds: PageContentBounds): boolean {
  return cx < bounds.left || cx > bounds.right || cy < bounds.top || cy > bounds.bottom;
}

function shouldMergeBoxes(
  a: ComponentBox,
  b: ComponentBox,
  typicalArea: number,
  typicalSide: number,
): boolean {
  const merged = mergeBoxes(a, b);
  if ((merged.w * merged.h) / Math.max(1, typicalArea) > CHAR_MERGE_REL_AREA_MAX) return false;

  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const verticalPrimary = Math.abs(by - ay) >= Math.abs(bx - ax);

  if (verticalPrimary) {
    const gap = b.y >= a.y + a.h ? b.y - (a.y + a.h) : a.y >= b.y + b.h ? a.y - (b.y + b.h) : 0;
    const overlap = overlap1D(a.x, a.x + a.w, b.x, b.x + b.w);
    return overlap >= CHAR_MERGE_OVERLAP_MIN && gap <= typicalSide * CHAR_MERGE_GAP_FACTOR;
  }

  const gap = b.x >= a.x + a.w ? b.x - (a.x + a.w) : a.x >= b.x + b.w ? a.x - (b.x + b.w) : 0;
  const overlap = overlap1D(a.y, a.y + a.h, b.y, b.y + b.h);
  return overlap >= CHAR_MERGE_OVERLAP_MIN && gap <= typicalSide * CHAR_MERGE_GAP_FACTOR;
}

function mergeBrokenComponents(boxes: ComponentBox[], typicalArea: number, typicalSide: number): ComponentBox[] {
  let list = boxes.map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (!shouldMergeBoxes(list[i], list[j], typicalArea, typicalSide)) continue;
        const merged = mergeBoxes(list[i], list[j]);
        list.splice(j, 1);
        list[i] = merged;
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

function splitTallComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetHeight: number,
  typicalArea: number,
): ComponentBox[] {
  const relArea = (box.w * box.h) / Math.max(1, typicalArea);
  if (relArea <= CHAR_SPLIT_REL_AREA && box.h <= targetHeight * 1.35) return [{ ...box }];

  const projection = new Uint32Array(box.h);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      if (bin[y * width + x]) projection[y - box.y] += 1;
    }
  }
  const lo = Math.floor(box.h * 0.28);
  const hi = Math.ceil(box.h * 0.72);
  let minRow = -1;
  let minValue = Infinity;
  for (let y = lo; y < hi; y += 1) {
    if (projection[y] < minValue) {
      minValue = projection[y];
      minRow = y;
    }
  }
  if (minRow < 0 || minValue > box.w * 0.1) return [{ ...box }];

  const cutY = box.y + minRow;
  const top: ComponentBox = { label: box.label, x: box.x, y: box.y, w: box.w, h: minRow, area: 0 };
  const bottom: ComponentBox = { label: box.label, x: box.x, y: cutY, w: box.w, h: box.h - minRow, area: 0 };
  if (top.h < CHAR_MIN_SIZE || bottom.h < CHAR_MIN_SIZE) return [{ ...box }];
  return [top, bottom];
}

function splitWideComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetWidth: number,
  typicalArea: number,
): ComponentBox[] {
  const relArea = (box.w * box.h) / Math.max(1, typicalArea);
  if (relArea <= CHAR_SPLIT_REL_AREA && box.w <= targetWidth * 1.6) return [{ ...box }];

  const proj = new Uint32Array(box.w);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      if (bin[y * width + x]) proj[x - box.x] += 1;
    }
  }
  const lo = Math.floor(box.w * 0.28);
  const hi = Math.ceil(box.w * 0.72);
  let minCol = -1;
  let minVal = Infinity;
  for (let x = lo; x < hi; x += 1) {
    if (proj[x] < minVal) {
      minVal = proj[x];
      minCol = x;
    }
  }
  if (minCol < 0 || minVal > box.h * 0.1) return [{ ...box }];

  const cutX = box.x + minCol;
  const left: ComponentBox = { label: box.label, x: box.x, y: box.y, w: minCol, h: box.h, area: 0 };
  const right: ComponentBox = { label: box.label, x: cutX, y: box.y, w: box.w - minCol, h: box.h, area: 0 };
  if (left.w < CHAR_MIN_SIZE || right.w < CHAR_MIN_SIZE) return [{ ...box }];
  return [left, right];
}

function classifyMarginChar(
  cx: number,
  cy: number,
  h: number,
  bounds: PageContentBounds,
  width: number,
  height: number,
  bodyTypicalH: number,
): Pick<CharItem, 'group' | 'kind'> {
  const isTop = cy < bounds.top + Math.min(width, height) * 0.08 || cy < height * 0.14;
  const isBottom = cy > bounds.bottom - Math.min(width, height) * 0.08 || cy > height * 0.86;
  const isLarge = h >= bodyTypicalH * 1.25;

  if (isTop && isLarge) return { group: 'title', kind: 'side' };
  if (isBottom && h <= bodyTypicalH * 0.85) return { group: 'pageno', kind: 'side' };
  if (isLarge) return { group: 'title', kind: 'side' };
  if (isBottom) return { group: 'pageno', kind: 'side' };
  return { group: 'title', kind: 'side' };
}

function boxesToMarginChars(
  boxes: ComponentBox[],
  bin: Uint8Array,
  width: number,
  height: number,
  bounds: PageContentBounds,
  bodyTypicalH: number,
): CharItem[] {
  return boxes
    .filter((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      return (
        isMarginPoint(cx, cy, bounds)
        && b.w >= CHAR_MIN_SIZE
        && b.h >= CHAR_MIN_SIZE
        && aspect <= 2.8
        && inkFillInBox(bin, width, height, b) >= 0.05
      );
    })
    .map((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const meta = classifyMarginChar(cx, cy, b.h, bounds, width, height, bodyTypicalH);
      return {
        id: uuid(),
        text: null,
        cx,
        cy,
        bbox: [b.x, b.y, b.x + b.w, b.y + b.h] as [number, number, number, number],
        pt: 0,
        conf: 0,
        note: 'empty' as const,
        source: 'manual' as const,
        edited: false,
        ...meta,
      };
    });
}

/** 页边多尺度分割：按局部字高分组处理，避免被正文中位字高拖累 */
function segmentMarginScale(
  cleaned: Uint8Array,
  denoised: Uint8Array,
  width: number,
  height: number,
  bounds: PageContentBounds,
  bodyTypicalH: number,
): CharItem[] {
  const { boxes: fragments } = connectedComponents(denoised, width, height);
  const smallLabels = new Set(fragments.filter((box) => box.area < 6).map((box) => box.label));
  const scrubbed = new Uint8Array(denoised);
  if (smallLabels.size > 0) {
    const { labels } = connectedComponents(denoised, width, height);
    for (let i = 0; i < scrubbed.length; i += 1) if (smallLabels.has(labels[i])) scrubbed[i] = 0;
  }

  const groupingRadius = Math.max(1, Math.min(3, Math.round(bodyTypicalH / 24)));
  const grouped = connectedComponents(
    dilateForCharacterGrouping(scrubbed, width, height, groupingRadius),
    width,
    height,
  ).boxes;

  const marginRaw = grouped
    .map((box) => tightenBox(scrubbed, width, height, box))
    .filter((box): box is ComponentBox => box !== null)
    .filter((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (!isMarginPoint(cx, cy, bounds)) return false;
      const fill = b.area / Math.max(1, b.w * b.h);
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      return (
        b.area >= CHAR_MIN_AREA
        && b.w >= CHAR_MIN_SIZE
        && b.h >= CHAR_MIN_SIZE
        && b.w <= CHAR_MAX_SIZE
        && b.h <= CHAR_MAX_SIZE
        && aspect <= 4.5
        && fill >= 0.04
      );
    });

  if (marginRaw.length === 0) return [];

  const heightClusters = clusterHeights(marginRaw.map((b) => b.h));
  const allBoxes: ComponentBox[] = [];

  for (const clusterH of heightClusters) {
    const clusterBoxes = marginRaw.filter((b) => Math.abs(b.h - clusterH) <= clusterH * 0.28);
    if (clusterBoxes.length === 0) continue;
    const typicalH = median(clusterBoxes.map((b) => b.h)) || clusterH;
    const typicalW = median(clusterBoxes.map((b) => b.w)) || typicalH;
    const typicalArea = typicalW * typicalH;
    const typicalSide = (typicalW + typicalH) / 2;
    const merged = mergeBrokenComponents(clusterBoxes, typicalArea, typicalSide);

    for (const b of merged) {
      const relArea = (b.w * b.h) / Math.max(1, typicalArea);
      if (relArea > CHAR_SPLIT_REL_AREA || (b.w > typicalW * 1.55 && b.w > b.h * 1.2)) {
        allBoxes.push(...splitWideComponent(cleaned, width, b, typicalW, typicalArea));
      } else if (b.h > typicalH * 1.25 && b.h > b.w * 1.05) {
        allBoxes.push(...splitTallComponent(cleaned, width, b, typicalH, typicalArea));
      } else {
        allBoxes.push(b);
      }
    }
  }

  const tightened = allBoxes
    .map((box) => tightenBox(cleaned, width, height, box))
    .filter((box): box is ComponentBox => box !== null);

  let chars = boxesToMarginChars(tightened, cleaned, width, height, bounds, bodyTypicalH);

  // 页边补漏：放宽尺寸上下限
  const { boxes } = connectedComponents(scrubbed, width, height);
  for (const b of boxes) {
    if (b.area < CHAR_MIN_AREA || b.w < CHAR_MIN_SIZE || b.h < CHAR_MIN_SIZE) continue;
    if (b.w > CHAR_MAX_SIZE || b.h > CHAR_MAX_SIZE) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (!isMarginPoint(cx, cy, bounds)) continue;
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    if (aspect > 2.6) continue;
    if (inkFillInBox(scrubbed, width, height, b) < 0.05) continue;
    const near = chars.some((c) => Math.hypot(c.cx - cx, c.cy - cy) < Math.max(CHAR_MIN_SIZE, b.h * 0.38));
    if (near) continue;
    const meta = classifyMarginChar(cx, cy, b.h, bounds, width, height, bodyTypicalH);
    chars.push({
      id: uuid(),
      text: null,
      cx,
      cy,
      bbox: [b.x, b.y, b.x + b.w, b.y + b.h] as [number, number, number, number],
      pt: 0,
      conf: 0,
      note: 'empty' as const,
      source: 'manual' as const,
      edited: false,
      ...meta,
    });
  }

  return chars;
}

function clusterHeights(heights: number[]): number[] {
  if (heights.length === 0) return [];
  const sorted = [...heights].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = groups[groups.length - 1];
    const ref = median(cur);
    if (sorted[i] > ref * 1.32) groups.push([sorted[i]]);
    else cur.push(sorted[i]);
  }
  return groups.map((g) => median(g));
}

function overlapsBodyChar(margin: CharItem, body: CharItem, bodyTypicalH: number): boolean {
  const dx = Math.abs(margin.cx - body.cx);
  const dy = Math.abs(margin.cy - body.cy);
  const bodySide = Math.max(body.bbox[2] - body.bbox[0], body.bbox[3] - body.bbox[1]);
  return dx < bodySide * 0.55 && dy < bodySide * 0.55;
}

/**
 * 在正文分割完成后补充页边字框：剔除页边区的正文误检，替换为页边专用分割结果。
 */
export function supplementMarginChars(
  cleaned: Uint8Array,
  denoised: Uint8Array,
  width: number,
  height: number,
  bodyChars: CharItem[],
  bodyTypicalH: number,
  borderRects: LayoutRect[] = [],
): CharItem[] {
  const bounds = inferPageContentBounds(width, height, borderRects);
  const bodyKept = bodyChars.filter((c) => !isMarginPoint(c.cx, c.cy, bounds));
  const marginChars = segmentMarginScale(cleaned, denoised, width, height, bounds, bodyTypicalH)
    .filter((m) => !bodyKept.some((b) => overlapsBodyChar(m, b, bodyTypicalH)));

  const merged = [...bodyKept, ...marginChars];
  merged.sort((a, b) => (Math.abs(a.cy - b.cy) > bodyTypicalH / 2 ? a.cy - b.cy : b.cx - a.cx));
  return merged;
}
