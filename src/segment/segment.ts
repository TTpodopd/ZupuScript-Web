/**
 * 字符分割（流程③，全本地）：去除谱系线后做连通域分析，
 * 得到每个字的包围盒与中心坐标；含过宽连通域的垂直投影拆分启发式。
 */
import {
  CHAR_MAX_SIZE,
  CHAR_MERGE_GAP_FACTOR,
  CHAR_MERGE_OVERLAP_MIN,
  CHAR_MERGE_REL_AREA_MAX,
  CHAR_MIN_AREA,
  CHAR_MIN_SIZE,
  CHAR_SPLIT_REL_AREA,
} from '@/lib/constants';
import { connectedComponents, type ComponentBox } from '@/imaging/raster';
import type { BorderRect, CharItem, SourceKind, TagRect, TreeLine } from '@/model/types';
import { median, uuid } from '@/lib/utils';
import { supplementMarginChars } from '@/segment/marginChars';
import { inkCentroidInRect } from '@/imaging/ink';

/** 方形核二值膨胀（可分离滑窗），用于把一个汉字内断开的笔画聚合成单一字框。 */
export function dilateForCharacterGrouping(bin: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(bin);
  const horizontal = new Uint8Array(bin.length);
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      if (x + radius < width) count += bin[y * width + x + radius];
      if (x - radius - 1 >= 0) count -= bin[y * width + x - radius - 1];
      horizontal[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      if (y + radius < height) count += horizontal[(y + radius) * width + x];
      if (y - radius - 1 >= 0) count -= horizontal[(y - radius - 1) * width + x];
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function tightenBox(bin: Uint8Array, width: number, height: number, box: ComponentBox): ComponentBox | null {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let area = 0;
  for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.h); y += 1) {
    for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.w); x += 1) {
      if (!bin[y * width + x]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); area += 1;
    }
  }
  return maxX < minX ? null : { label: box.label, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area };
}

function boxToCharItem(
  b: TaggedBox,
  bin: Uint8Array,
  width: number,
  height: number,
): CharItem {
  const centroid = inkCentroidInRect(bin, width, height, b.x, b.y, b.w, b.h);
  const cx = centroid?.cx ?? b.x + b.w / 2;
  const cy = centroid?.cy ?? b.y + b.h / 2;
  return {
    id: uuid(),
    text: null,
    cx,
    cy,
    bbox: [b.x, b.y, b.x + b.w, b.y + b.h] as [number, number, number, number],
    pt: 0,
    conf: 0,
    note: b.wasSplit ? ('split' as const) : b.wasMerge ? ('merge' as const) : ('empty' as const),
    source: 'manual' as const,
    edited: false,
    group: 'body' as const,
    kind: 'text' as const,
  };
}

/** 在二值图上抹除谱系线（线宽自适应，细线少扩边以免吃掉笔画） */
export function eraseLines(bin: Uint8Array, width: number, height: number, lines: TreeLine[]): Uint8Array {
  const out = new Uint8Array(bin);
  for (const l of lines) {
    const pad =
      l.widthPx <= 4
        ? Math.max(1, Math.ceil(l.widthPx / 2))
        : Math.ceil(l.widthPx / 2) + 2;
    if (l.orientation === 'h') {
      const x0 = Math.max(0, Math.floor(Math.min(l.x1, l.x2)));
      const x1 = Math.min(width, Math.ceil(Math.max(l.x1, l.x2)));
      const y0 = Math.max(0, Math.floor(l.y1 - pad));
      const y1 = Math.min(height, Math.ceil(l.y1 + pad));
      for (let y = y0; y < y1; y++) out.fill(0, y * width + x0, y * width + x1);
    } else {
      const y0 = Math.max(0, Math.floor(Math.min(l.y1, l.y2)));
      const y1 = Math.min(height, Math.ceil(Math.max(l.y1, l.y2)));
      const x0 = Math.max(0, Math.floor(l.x1 - pad));
      const x1 = Math.min(width, Math.ceil(l.x1 + pad));
      for (let y = y0; y < y1; y++) out.fill(0, y * width + x0, y * width + x1);
    }
  }
  return out;
}

type LayoutRect = Pick<BorderRect | TagRect, 'x' | 'y' | 'w' | 'h'>;

export interface SegmentOptions {
  sourceKind?: SourceKind;
  /** 检出的节点圆（作为环带证据剔除圆环残弧噪声框） */
  nodes?: NodeEvidence[];
}

interface SegmentThresholds {
  minArea: number;
  minFill: number;
  smallFragmentArea: number;
  phantomFill: number;
  supplementFill: number;
  minSide: number;
}

function segmentThresholds(kind: SourceKind): SegmentThresholds {
  if (kind === 'pdf') {
    return {
      minArea: 24,
      minFill: 0.07,
      smallFragmentArea: 14,
      phantomFill: 0.1,
      supplementFill: 0.08,
      minSide: 10,
    };
  }
  return {
    minArea: CHAR_MIN_AREA,
    minFill: 0.045,
    smallFragmentArea: 6,
    phantomFill: 0.07,
    supplementFill: 0.06,
    minSide: 8,
  };
}

/** 已确认的实心边框与装饰块不参与字符分割。 */
export function eraseLayoutRects(
  bin: Uint8Array,
  width: number,
  height: number,
  rects: LayoutRect[],
): Uint8Array {
  const out = new Uint8Array(bin);
  for (const rect of rects) {
    const pad = 2;
    const x0 = Math.max(0, Math.floor(rect.x - pad));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.w + pad));
    const y0 = Math.max(0, Math.floor(rect.y - pad));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.h + pad));
    for (let y = y0; y < y1; y += 1) out.fill(0, y * width + x0, y * width + x1);
  }
  return out;
}

type TaggedBox = ComponentBox & { wasSplit?: boolean; wasMerge?: boolean };

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

/** PDF S1.3：断裂字符合并（面积、副方向重合、主方向间隙三条件） */
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
    const gap = b.y >= a.y + a.h
      ? b.y - (a.y + a.h)
      : a.y >= b.y + b.h
        ? a.y - (b.y + b.h)
        : 0;
    const overlap = overlap1D(a.x, a.x + a.w, b.x, b.x + b.w);
    return overlap >= CHAR_MERGE_OVERLAP_MIN && gap <= typicalSide * CHAR_MERGE_GAP_FACTOR;
  }

  const gap = b.x >= a.x + a.w
    ? b.x - (a.x + a.w)
    : a.x >= b.x + b.w
      ? a.x - (b.x + b.w)
      : 0;
  const overlap = overlap1D(a.y, a.y + a.h, b.y, b.y + b.h);
  return overlap >= CHAR_MERGE_OVERLAP_MIN && gap <= typicalSide * CHAR_MERGE_GAP_FACTOR;
}

function mergeBrokenComponents(
  boxes: ComponentBox[],
  typicalArea: number,
  typicalSide: number,
): TaggedBox[] {
  let list: TaggedBox[] = boxes.map((box) => ({ ...box }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (!shouldMergeBoxes(list[i], list[j], typicalArea, typicalSide)) continue;
        const merged = mergeBoxes(list[i], list[j]);
        list.splice(j, 1);
        list[i] = { ...merged, wasMerge: true };
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

/** 垂直投影拆分过宽连通域（PDF S1.2：rel_area>1.6 时在中间 1/3 找谷底切分） */
function splitWideComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetWidth: number,
  typicalArea: number,
): TaggedBox[] {
  const relArea = (box.w * box.h) / Math.max(1, typicalArea);
  if (relArea <= CHAR_SPLIT_REL_AREA && box.w <= targetWidth * 1.8) return [{ ...box }];

  const proj = new Uint32Array(box.w);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      if (bin[y * width + x]) proj[x - box.x] += 1;
    }
  }
  const lo = Math.floor(box.w * 0.3);
  const hi = Math.ceil(box.w * 0.7);
  let minCol = -1;
  let minVal = Infinity;
  for (let x = lo; x < hi; x += 1) {
    if (proj[x] < minVal) {
      minVal = proj[x];
      minCol = x;
    }
  }
  if (minCol < 0 || minVal > box.h * 0.12) return [{ ...box }];

  const cutX = box.x + minCol;
  const left: TaggedBox = { label: box.label, x: box.x, y: box.y, w: minCol, h: box.h, area: 0, wasSplit: true };
  const right: TaggedBox = { label: box.label, x: cutX, y: box.y, w: box.w - minCol, h: box.h, area: 0, wasSplit: true };
  if (left.w < CHAR_MIN_SIZE || right.w < CHAR_MIN_SIZE) return [{ ...box }];
  return [left, right];
}

/** 水平投影拆分竖排粘连字（逻辑与横向拆分对称） */
function splitTallComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetHeight: number,
  typicalArea: number,
): TaggedBox[] {
  const relArea = (box.w * box.h) / Math.max(1, typicalArea);
  if (relArea <= CHAR_SPLIT_REL_AREA && box.h <= targetHeight * 1.45) return [{ ...box }];

  const projection = new Uint32Array(box.h);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      if (bin[y * width + x]) projection[y - box.y] += 1;
    }
  }
  const lo = Math.floor(box.h * 0.3);
  const hi = Math.ceil(box.h * 0.7);
  let minRow = -1;
  let minValue = Infinity;
  for (let y = lo; y < hi; y += 1) {
    if (projection[y] < minValue) {
      minValue = projection[y];
      minRow = y;
    }
  }
  if (minRow < 0 || minValue > box.w * 0.12) return [{ ...box }];

  const cutY = box.y + minRow;
  const top: TaggedBox = { label: box.label, x: box.x, y: box.y, w: box.w, h: minRow, area: 0, wasSplit: true };
  const bottom: TaggedBox = { label: box.label, x: box.x, y: cutY, w: box.w, h: box.h - minRow, area: 0, wasSplit: true };
  if (top.h < CHAR_MIN_SIZE || bottom.h < CHAR_MIN_SIZE) return [{ ...box }];
  return [top, bottom];
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

function countInkInBox(
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
  return ink;
}

/** 噪声碎片：边长过小且墨迹量不足以构成汉字笔画 */
function isNoiseFragment(
  bin: Uint8Array,
  width: number,
  height: number,
  b: Pick<ComponentBox, 'x' | 'y' | 'w' | 'h'>,
  typicalSide: number,
  minSide: number,
): boolean {
  const short = Math.min(b.w, b.h);
  const ink = countInkInBox(bin, width, height, b);
  if (short < minSide && ink < typicalSide * 1.8) return true;
  if (short < Math.max(5, typicalSide * 0.3) && ink < typicalSide * 2.4) return true;
  return false;
}

function supplementMissedChars(
  bin: Uint8Array,
  width: number,
  height: number,
  existing: CharItem[],
  typicalH: number,
  minArea: number,
  minFill: number,
): CharItem[] {
  const { boxes } = connectedComponents(bin, width, height);
  const minSize = Math.max(CHAR_MIN_SIZE, Math.round(typicalH * 0.45));
  const maxSize = Math.min(CHAR_MAX_SIZE, Math.round(typicalH * 2.2));
  const extras: CharItem[] = [];

  for (const b of boxes) {
    if (b.area < minArea || b.w < minSize || b.h < minSize) continue;
    if (b.w > maxSize || b.h > maxSize) continue;
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    if (aspect > 2.4) continue;
    if (inkFillInBox(bin, width, height, b) < minFill) continue;
    if (isNoiseFragment(bin, width, height, b, typicalH, Math.max(6, Math.round(typicalH * 0.4)))) continue;

    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const near = existing.some(
      (c) => Math.hypot(c.cx - cx, c.cy - cy) < Math.max(minSize, typicalH * 0.34),
    );
    if (near) continue;

    extras.push({
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
      group: 'body' as const,
      kind: 'text' as const,
    });
  }
  return extras.length ? [...existing, ...extras] : existing;
}

function distancePointToSegment(px: number, py: number, line: TreeLine): number {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return Math.hypot(px - line.x1, py - line.y1);
  const t = Math.max(0, Math.min(1, ((px - line.x1) * dx + (py - line.y1) * dy) / lengthSq));
  return Math.hypot(px - (line.x1 + t * dx), py - (line.y1 + t * dy));
}

/** 轴对齐线段到矩形的距离（相交为 0）。谱系线均为横平竖直，可精确快算。 */
function distanceAxisSegmentToRect(
  line: TreeLine,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  if (line.orientation === 'h') {
    const lx0 = Math.min(line.x1, line.x2);
    const lx1 = Math.max(line.x1, line.x2);
    const dx = lx1 < x0 ? x0 - lx1 : lx0 > x1 ? lx0 - x1 : 0;
    const dy = line.y1 < y0 ? y0 - line.y1 : line.y1 > y1 ? line.y1 - y1 : 0;
    return Math.hypot(dx, dy);
  }
  const ly0 = Math.min(line.y1, line.y2);
  const ly1 = Math.max(line.y1, line.y2);
  const dy = ly1 < y0 ? y0 - ly1 : ly0 > y1 ? ly0 - y1 : 0;
  const dx = line.x1 < x0 ? x0 - line.x1 : line.x1 > x1 ? line.x1 - x1 : 0;
  return Math.hypot(dx, dy);
}

export interface NodeEvidence {
  cx: number;
  cy: number;
  r: number;
}

/**
 * 墨迹落在节点圆环带上的像素占比（0..1）。
 * 节点圆被谱系线擦除切割后残留的弧段，其墨迹几乎全部贴合原圆环；
 * 圆内/圆旁的真实汉字不会与环带重合。
 */
function ringInkFraction(
  bin: Uint8Array,
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  nodes: NodeEvidence[],
): number {
  let best = 0;
  for (const node of nodes) {
    const tol = Math.max(3, node.r * 0.22);
    // 粗筛：墨迹 bbox 与节点扩展方形无交则跳过
    if (
      minX > node.cx + node.r + tol
      || maxX < node.cx - node.r - tol
      || minY > node.cy + node.r + tol
      || maxY < node.cy - node.r - tol
    ) continue;
    let total = 0;
    let onRing = 0;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!bin[y * width + x]) continue;
        total += 1;
        const d = Math.hypot(x - node.cx, y - node.cy);
        if (Math.abs(d - node.r) <= tol) onRing += 1;
      }
    }
    if (total > 0) best = Math.max(best, onRing / total);
  }
  return best;
}

/**
 * 墨迹是否由「一横一竖两条细带」构成（L/T/十字接头残段形态）。
 * 真实汉字笔画结构复杂（多条横带或竖带、框形结构），不会命中单一带判据。
 */
function isTwoBarJunctionInk(
  bin: Uint8Array,
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  typicalSide: number,
): boolean {
  const iw = maxX - minX + 1;
  const ih = maxY - minY + 1;
  const bandThickness = Math.max(3, Math.round(typicalSide * 0.28));
  const rowInk = new Uint32Array(ih);
  const colInk = new Uint32Array(iw);
  let total = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!bin[y * width + x]) continue;
      rowInk[y - minY] += 1;
      colInk[x - minX] += 1;
      total += 1;
    }
  }
  if (total === 0) return false;

  const findBand = (hist: Uint32Array, span: number): [number, number] | null => {
    let start = -1;
    let end = -1;
    for (let i = 0; i < hist.length; i += 1) {
      if (hist[i] >= span * 0.5) {
        if (start < 0) start = i;
        end = i;
      }
    }
    if (start < 0 || end - start + 1 > bandThickness) return null;
    return [start, end];
  };

  const hBand = findBand(rowInk, iw);
  const vBand = findBand(colInk, ih);
  if (!hBand || !vBand) return false;

  let outside = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!bin[y * width + x]) continue;
      const inH = y - minY >= hBand[0] && y - minY <= hBand[1];
      const inV = x - minX >= vBand[0] && x - minX <= vBand[1];
      if (!inH && !inV) outside += 1;
    }
  }
  return outside <= total * 0.1;
}

/** 删除与已确认谱系线同向且贴近线段/端点的细长残段；方形汉字与孤立「一」不受影响。
 *  传入原二值图时，还会剔除：
 *  1. 「bbox 方正但内部墨迹是细长线」的膨胀线残段（短谱系线漏检后混入正文）；
 *  2. 与检测线共线的漏检线尾（同向延长、间隙很小）；
 *  3. 扒在检测线上的异向细墨迹（T/L 接头擦线后遗留的短桩）；
 *  4. 贴着检测线的一横一竖双细带团块（L/T/十字接头残块）。
 *  所有新规则都要求存在谱系线证据且墨迹为细线形态，正文真实字形不受影响。 */
export function filterResidualLineChars(
  chars: CharItem[],
  lines: TreeLine[],
  typicalSide: number,
  bin?: Uint8Array,
  width?: number,
  height?: number,
  nodes?: NodeEvidence[],
): CharItem[] {
  return chars.filter((char) => {
    const w = char.bbox[2] - char.bbox[0];
    const h = char.bbox[3] - char.bbox[1];
    let horizontal = w >= h * 2.2 && w >= typicalSide * 0.6;
    let vertical = h >= w * 2.2 && h >= typicalSide * 0.6;
    let isolatedThinVerticalInk = false;

    // 墨迹几何判定：bbox 方正但内部墨迹是细长线（膨胀后变方的线残段）。
    if (bin && width && height) {
      const x0 = Math.max(0, Math.floor(char.bbox[0]));
      const y0 = Math.max(0, Math.floor(char.bbox[1]));
      const x1 = Math.min(width, Math.ceil(char.bbox[2]));
      const y1 = Math.min(height, Math.ceil(char.bbox[3]));
      let minX = width; let minY = height; let maxX = -1; let maxY = -1;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (!bin[y * width + x]) continue;
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      if (maxX >= minX) {
        // 节点圆残弧：墨迹主体（≥70%）落在检出节点圆的环带上 → 圆环被擦线切割后的残留。
        // 圆内/圆旁的真实汉字不与环带重合，不受影响。
        if (nodes && nodes.length > 0 && ringInkFraction(bin, width, minX, minY, maxX, maxY, nodes) >= 0.7) {
          return false;
        }
        const iw = maxX - minX + 1;
        const ih = maxY - minY + 1;
        const inkAspect = Math.max(iw, ih) / Math.max(1, Math.min(iw, ih));
        if (inkAspect >= 3) {
          horizontal = iw >= ih;
          vertical = ih >= iw;
          // 单根竖线没有足够横向笔画构成汉字；即使版面检测漏掉其所属谱系线，
          // 也不能作为待 OCR 字框保留。保守限制为极细、长度接近正常字高的墨迹。
          isolatedThinVerticalInk = vertical
            && iw <= Math.max(3, typicalSide * 0.18)
            && ih >= typicalSide * 0.85;
          // 细长且明显长于典型字宽：是线残段而非「一」等孤立笔画，直接剔除。
          if (Math.max(iw, ih) > typicalSide * 1.35) return false;
        }

        // 线接头/线尾残段剔除（泛化：只依赖检测到的谱系线证据，不依赖样本内容）。
        // thinInk 闸门保证真实汉字不受影响——汉字墨迹短边≈字号，远大于细线宽度；
        // 无谱系线证据时一律保留，孤立的「一」不会被误删。
        const inkShort = Math.min(iw, ih);
        const inkLong = Math.max(iw, ih);
        const thinInk = inkShort <= Math.max(4, typicalSide * 0.25);
        if (thinInk && lines.length > 0 && inkLong >= typicalSide * 0.25 && inkLong <= typicalSide * 1.35) {
          const horizontalInk = iw >= ih;
          for (const line of lines) {
            if ((horizontalInk && line.orientation === 'h') || (!horizontalInk && line.orientation === 'v')) {
              // 同向延长线：检测线的漏检线尾，与已检出线段共线且间隙很小
              const axisTol = Math.max(3, line.widthPx + 2);
              const onAxis = horizontalInk
                ? Math.abs(char.cy - line.y1) <= axisTol
                : Math.abs(char.cx - line.x1) <= axisTol;
              if (onAxis) {
                const span0 = horizontalInk ? Math.min(line.x1, line.x2) : Math.min(line.y1, line.y2);
                const span1 = horizontalInk ? Math.max(line.x1, line.x2) : Math.max(line.y1, line.y2);
                const ink0 = horizontalInk ? minX : minY;
                const ink1 = horizontalInk ? maxX : maxY;
                const gap = ink0 > span1 ? ink0 - span1 : span0 > ink1 ? span0 - ink1 : 0;
                const minLong = horizontalInk ? typicalSide * 1.05 : typicalSide * 0.6;
                if (gap <= typicalSide * 0.6 && inkLong >= minLong) return false;
              }
            } else {
              // 异向贴线：扒在谱系线上的 T/L 接头残段（擦线后遗留的短桩）
              const touchTol = Math.max(3, typicalSide * 0.12);
              if (distanceAxisSegmentToRect(line, minX - touchTol, minY - touchTol, maxX + touchTol, maxY + touchTol) <= line.widthPx / 2 + 1) {
                return false;
              }
            }
          }
        }

        // L/T/十字接头团块：墨迹两个方向都有跨度、由一横一竖两条细带构成且贴着谱系线。
        // 正文里的「十」等真实字形不贴谱系线，不会命中。
        if (
          lines.length > 0
          && iw >= typicalSide * 0.4
          && ih >= typicalSide * 0.4
          && isTwoBarJunctionInk(bin, width, minX, minY, maxX, maxY, typicalSide)
        ) {
          const touchTol = Math.max(3, typicalSide * 0.12);
          const touchesLine = lines.some(
            (line) => distanceAxisSegmentToRect(line, minX - touchTol, minY - touchTol, maxX + touchTol, maxY + touchTol) <= line.widthPx / 2 + 1,
          );
          if (touchesLine) return false;
        }
      }
    }

    if (!horizontal && !vertical) return true;
    // 单根极细竖线不是可识别汉字。无论页面其它位置是否检测到谱系线，
    // 都直接丢弃，避免把远离谱系线的竖向扫描噪声送入 OCR。
    if (isolatedThinVerticalInk) return false;
    if (lines.length === 0) return true; // 横向短笔可能是「一」，保留

    const nearby = lines.some((line) => {
      if (horizontal && line.orientation !== 'h') return false;
      if (vertical && line.orientation !== 'v') return false;
      const tolerance = Math.max(4, line.widthPx * 2 + Math.min(w, h));
      if (distancePointToSegment(char.cx, char.cy, line) > tolerance) return false;
      if (horizontal) {
        const overlap = Math.max(0, Math.min(char.bbox[2], Math.max(line.x1, line.x2)) - Math.max(char.bbox[0], Math.min(line.x1, line.x2)));
        return overlap >= Math.min(w, typicalSide) * 0.35 || Math.min(Math.abs(char.bbox[0] - line.x2), Math.abs(char.bbox[2] - line.x1)) <= tolerance;
      }
      const overlap = Math.max(0, Math.min(char.bbox[3], Math.max(line.y1, line.y2)) - Math.max(char.bbox[1], Math.min(line.y1, line.y2)));
      return overlap >= Math.min(h, typicalSide) * 0.35 || Math.min(Math.abs(char.bbox[1] - line.y2), Math.abs(char.bbox[3] - line.y1)) <= tolerance;
    });
    return !nearby;
  });
}
function filterPhantomChars(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  minFill: number,
): CharItem[] {
  return chars.filter((c) => {
    const w = c.bbox[2] - c.bbox[0];
    const h = c.bbox[3] - c.bbox[1];
    const fill = inkFillInBox(bin, width, height, { x: c.bbox[0], y: c.bbox[1], w, h });
    return fill >= minFill;
  });
}

/**
 * 字符分割主入口。
 * @returns CharItem[]（text=null，等待识别；坐标为原图像素中心坐标）
 */
export function segmentChars(
  bin: Uint8Array,
  width: number,
  height: number,
  lines: TreeLine[],
  excludedRects: LayoutRect[] = [],
  borderRectsForMargin: LayoutRect[] = excludedRects,
  options?: SegmentOptions,
): CharItem[] {
  const thresholds = segmentThresholds(options?.sourceKind ?? 'image');
  const withoutLines = eraseLines(bin, width, height, lines);
  const cleaned = eraseLayoutRects(withoutLines, width, height, excludedRects);
  const { labels, boxes: fragments } = connectedComponents(cleaned, width, height);
  const denoised = new Uint8Array(cleaned);
  const smallLabels = new Set(
    fragments.filter((box) => box.area < thresholds.smallFragmentArea).map((box) => box.label),
  );
  if (smallLabels.size > 0) {
    for (let i = 0; i < denoised.length; i += 1) if (smallLabels.has(labels[i])) denoised[i] = 0;
  }
  // 半径过大会把竖排相邻字和线端残留黏成一个框；高分辨率页面也限制在 5px 内。
  const groupingRadius = Math.max(2, Math.min(4, Math.round(Math.min(width, height) / 650)));
  const grouped = connectedComponents(dilateForCharacterGrouping(denoised, width, height, groupingRadius), width, height).boxes;
  const boxes = grouped.map((box) => tightenBox(denoised, width, height, box)).filter((box): box is ComponentBox => box !== null);

  // 粗过滤：字符尺寸范围
  const raw = boxes.filter(
    (b) => {
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      const fill = b.area / Math.max(1, b.w * b.h);
      return b.area >= thresholds.minArea && b.w >= CHAR_MIN_SIZE * 1.5 && b.h >= CHAR_MIN_SIZE * 1.5
        // 先允许中等长条进入投影拆分；最终字框会再次按 2.2 的长宽比收口。
        && b.w <= CHAR_MAX_SIZE && b.h <= CHAR_MAX_SIZE && aspect <= 4
        && fill >= thresholds.minFill;
    },
  );
  if (raw.length === 0) return [];

  // 以高度中位数为典型字尺寸，拆分过宽粘连块
  const typicalH = median(raw.map((b) => b.h)) || 20;
  const typicalW = median(raw.map((b) => b.w)) || typicalH;
  const typicalArea = typicalW * typicalH;
  const typicalSide = (typicalW + typicalH) / 2;

  const mergedRaw = mergeBrokenComponents(raw, typicalArea, typicalSide);

  const splitBoxes: TaggedBox[] = [];
  for (const b of mergedRaw) {
    const relArea = (b.w * b.h) / Math.max(1, typicalArea);
    if (relArea > CHAR_SPLIT_REL_AREA || (b.w > typicalW * 1.8 && b.w > b.h * 1.3)) {
      splitBoxes.push(...splitWideComponent(cleaned, width, b, typicalW, typicalArea));
    } else if (b.h > typicalH * 1.45 && b.h > b.w * 1.15) {
      splitBoxes.push(...splitTallComponent(cleaned, width, b, typicalH, typicalArea));
    } else {
      splitBoxes.push({ ...b, wasMerge: b.wasMerge });
    }
  }

  const tightenedSplitBoxes: TaggedBox[] = [];
  for (const box of splitBoxes) {
    const tight = tightenBox(cleaned, width, height, box);
    if (!tight) continue;
    tightenedSplitBoxes.push({ ...tight, wasSplit: box.wasSplit, wasMerge: box.wasMerge });
  }

  let chars: CharItem[] = tightenedSplitBoxes
    .filter((b) => {
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      return b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE && aspect <= 2.2
        && !isNoiseFragment(cleaned, width, height, b, typicalSide, thresholds.minSide);
    })
    .map((b) => boxToCharItem(b, cleaned, width, height));

  chars = supplementMissedChars(
    denoised,
    width,
    height,
    chars,
    typicalH,
    thresholds.minArea,
    thresholds.supplementFill,
  );
  chars = filterPhantomChars(chars, cleaned, width, height, thresholds.phantomFill);
  chars = filterResidualLineChars(chars, lines, typicalSide, cleaned, width, height, options?.nodes);
  chars = supplementMarginChars(
    cleaned,
    denoised,
    width,
    height,
    chars,
    typicalH,
    borderRectsForMargin,
  );
  chars.sort((a, b) => (Math.abs(a.cy - b.cy) > typicalH / 2 ? a.cy - b.cy : b.cx - a.cx));
  return chars;
}
