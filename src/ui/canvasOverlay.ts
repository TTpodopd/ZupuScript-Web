import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { CharItem, Page } from '@/model/types';
import type { ViewTransform } from '@/store/editorStore';

export type FitMode = 'contain' | 'width';

export interface FitTransformOptions {
  padding?: number;
  /** contain=整页可见；width=按宽度适配（族谱竖长页更清晰） */
  mode?: FitMode;
  /** 按宽度适配且页面高于视口时，从顶部对齐而非垂直居中 */
  alignTop?: boolean;
}

/** 将页面缩放至视口内并居中（切换页面时的默认视图） */
export function computeFitCenterTransform(
  pageW: number,
  pageH: number,
  viewW: number,
  viewH: number,
  options: FitTransformOptions | number = {},
): ViewTransform {
  const opts: FitTransformOptions = typeof options === 'number' ? { padding: options } : options;
  const padding = opts.padding ?? 0.92;
  const mode = opts.mode ?? 'contain';
  const alignTop = opts.alignTop ?? mode === 'width';

  if (pageW <= 0 || pageH <= 0 || viewW <= 0 || viewH <= 0) {
    return { scale: 0.2, offsetX: 0, offsetY: 0 };
  }
  const scale =
    mode === 'width'
      ? (viewW / pageW) * padding
      : Math.min(viewW / pageW, viewH / pageH) * padding;
  const clamped = Math.max(0.02, Math.min(4, scale));
  const renderedH = pageH * clamped;
  const offsetY = alignTop && renderedH > viewH ? 8 : (viewH - renderedH) / 2;
  return {
    scale: clamped,
    offsetX: (viewW - pageW * clamped) / 2,
    offsetY,
  };
}

/** 将图像坐标点居中到视口（低置信跳转等） */
export function computeCenterOnPoint(
  cx: number,
  cy: number,
  viewW: number,
  viewH: number,
  scale: number,
): ViewTransform {
  return {
    scale,
    offsetX: viewW / 2 - cx * scale,
    offsetY: viewH / 2 - cy * scale,
  };
}

export interface SelectionState {
  selectedCharIds: string[];
  selectedLineIds: string[];
  selectedNodeIds: string[];
  selectedRectIds: string[];
  rubberBand: { x0: number; y0: number; x1: number; y1: number } | null;
}

export type BboxResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const BBOX_MIN_SIZE = 6;

export function unionCharBboxes(bboxes: [number, number, number, number][]): [number, number, number, number] | null {
  if (bboxes.length === 0) return null;
  return [
    Math.min(...bboxes.map((b) => b[0])),
    Math.min(...bboxes.map((b) => b[1])),
    Math.max(...bboxes.map((b) => b[2])),
    Math.max(...bboxes.map((b) => b[3])),
  ];
}

export function bboxCenter(bbox: [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

export function resizeBboxByHandle(
  orig: [number, number, number, number],
  handle: BboxResizeHandle,
  x: number,
  y: number,
  minSize = BBOX_MIN_SIZE,
): [number, number, number, number] {
  let [x0, y0, x1, y1] = orig;
  if (handle === 'n' || handle === 'nw' || handle === 'ne') y0 = y;
  if (handle === 's' || handle === 'sw' || handle === 'se') y1 = y;
  if (handle === 'w' || handle === 'nw' || handle === 'sw') x0 = x;
  if (handle === 'e' || handle === 'ne' || handle === 'se') x1 = x;
  let left = Math.min(x0, x1);
  let top = Math.min(y0, y1);
  let right = Math.max(x0, x1);
  let bottom = Math.max(y0, y1);
  if (right - left < minSize) {
    if (handle.includes('w')) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (handle.includes('n')) top = bottom - minSize;
    else bottom = top + minSize;
  }
  return [left, top, right, bottom];
}

export function scaleBboxesInUnion(
  orig: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }>,
  origUnion: [number, number, number, number],
  newUnion: [number, number, number, number],
): Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> {
  const [ox0, oy0, ox1, oy1] = origUnion;
  const ow = ox1 - ox0 || 1;
  const oh = oy1 - oy0 || 1;
  const [nx0, ny0, nx1, ny1] = newUnion;
  const sx = (nx1 - nx0) / ow;
  const sy = (ny1 - ny0) / oh;
  const out: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> = {};
  for (const [id, o] of Object.entries(orig)) {
    const [bx0, by0, bx1, by1] = o.bbox;
    const bbox: [number, number, number, number] = [
      nx0 + (bx0 - ox0) * sx,
      ny0 + (by0 - oy0) * sy,
      nx0 + (bx1 - ox0) * sx,
      ny0 + (by1 - oy0) * sy,
    ];
    const [cx, cy] = bboxCenter(bbox);
    out[id] = { cx, cy, bbox };
  }
  return out;
}

export function hitBboxResizeHandle(
  x: number,
  y: number,
  bbox: [number, number, number, number],
  scale: number,
): BboxResizeHandle | null {
  const tol = 8 / Math.max(0.02, scale);
  const [x0, y0, x1, y1] = bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const handles: [BboxResizeHandle, number, number][] = [
    ['nw', x0, y0],
    ['n', cx, y0],
    ['ne', x1, y0],
    ['w', x0, cy],
    ['e', x1, cy],
    ['sw', x0, y1],
    ['s', cx, y1],
    ['se', x1, y1],
  ];
  for (const [handle, hx, hy] of handles) {
    if (Math.hypot(x - hx, y - hy) <= tol) return handle;
  }
  return null;
}

export function cursorForBboxHandle(handle: BboxResizeHandle): string {
  const map: Record<BboxResizeHandle, string> = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
  };
  return map[handle];
}

export function setCharsBboxSize(
  chars: { id: string; cx: number; cy: number; bbox: [number, number, number, number] }[],
  width?: number,
  height?: number,
): Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> {
  const out: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> = {};
  for (const c of chars) {
    const w = width ?? c.bbox[2] - c.bbox[0];
    const h = height ?? c.bbox[3] - c.bbox[1];
    out[c.id] = {
      cx: c.cx,
      cy: c.cy,
      bbox: [c.cx - w / 2, c.cy - h / 2, c.cx + w / 2, c.cy + h / 2],
    };
  }
  return out;
}

function drawBboxResizeHandles(ctx: CanvasRenderingContext2D, bbox: [number, number, number, number], inv: number): void {
  const [x0, y0, x1, y1] = bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = 4 * inv;
  const points = [
    [x0, y0],
    [cx, y0],
    [x1, y0],
    [x0, cy],
    [x1, cy],
    [x0, y1],
    [cx, y1],
    [x1, y1],
  ];
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(37,99,235,0.95)';
  ctx.lineWidth = 1.5 * inv;
  for (const [px, py] of points) {
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
    ctx.strokeRect(px - r, py - r, r * 2, r * 2);
  }
}

/** 线段是否与框选矩形相交（族谱树线为水平/垂直） */
export function lineIntersectsRect(
  line: { x1: number; y1: number; x2: number; y2: number; orientation: 'h' | 'v' },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const rx0 = Math.min(x0, x1);
  const ry0 = Math.min(y0, y1);
  const rx1 = Math.max(x0, x1);
  const ry1 = Math.max(y0, y1);
  if (line.orientation === 'h') {
    const ly = line.y1;
    const lx0 = Math.min(line.x1, line.x2);
    const lx1 = Math.max(line.x1, line.x2);
    return ly >= ry0 && ly <= ry1 && lx0 <= rx1 && lx1 >= rx0;
  }
  const lx = line.x1;
  const ly0 = Math.min(line.y1, line.y2);
  const ly1 = Math.max(line.y1, line.y2);
  return lx >= rx0 && lx <= rx1 && ly0 <= ry1 && ly1 >= ry0;
}

/** 树谱节点（圆）是否与框选矩形相交 */
export function nodeIntersectsRect(
  node: { cx: number; cy: number; r: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const rx0 = Math.min(x0, x1);
  const ry0 = Math.min(y0, y1);
  const rx1 = Math.max(x0, x1);
  const ry1 = Math.max(y0, y1);
  const closestX = Math.max(rx0, Math.min(node.cx, rx1));
  const closestY = Math.max(ry0, Math.min(node.cy, ry1));
  return Math.hypot(node.cx - closestX, node.cy - closestY) <= node.r;
}

/** 装饰/边框矩形是否与框选矩形相交 */
export function layoutRectIntersectsRect(
  rect: { x: number; y: number; w: number; h: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const rx0 = Math.min(x0, x1);
  const ry0 = Math.min(y0, y1);
  const rx1 = Math.max(x0, x1);
  const ry1 = Math.max(y0, y1);
  return rect.x < rx1 && rect.x + rect.w > rx0 && rect.y < ry1 && rect.y + rect.h > ry0;
}

/** 字符是否与框选矩形相交（中心在内或 bbox 重叠） */
export function charIntersectsRect(
  char: Pick<CharItem, 'cx' | 'cy' | 'bbox'>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const rx0 = Math.min(x0, x1);
  const ry0 = Math.min(y0, y1);
  const rx1 = Math.max(x0, x1);
  const ry1 = Math.max(y0, y1);
  if (char.cx >= rx0 && char.cx <= rx1 && char.cy >= ry0 && char.cy <= ry1) return true;
  const [bx0, by0, bx1, by1] = char.bbox;
  return bx0 < rx1 && bx1 > rx0 && by0 < ry1 && by1 > ry0;
}

/** 框选区域内所有可编辑图元 */
export function collectRegionSelection(
  page: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { charIds: string[]; lineIds: string[]; nodeIds: string[]; rectIds: string[] } {
  return {
    charIds: page.chars.filter((c) => charIntersectsRect(c, x0, y0, x1, y1)).map((c) => c.id),
    lineIds: page.treeLines.filter((l) => lineIntersectsRect(l, x0, y0, x1, y1)).map((l) => l.id),
    nodeIds: page.treeNodes.filter((n) => nodeIntersectsRect(n, x0, y0, x1, y1)).map((n) => n.id),
    rectIds: [...page.borderRects, ...page.tagRects]
      .filter((r) => layoutRectIntersectsRect(r, x0, y0, x1, y1))
      .map((r) => r.id),
  };
}

/** 在原图/校对区共用的选区与高亮 overlay（图像坐标系，已应用 scale 前调用） */
export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  page: Page,
  selection: SelectionState,
  scale: number,
  options: { showLowConf?: boolean; showRubber?: boolean; focusCharId?: string | null } = {},
): void {
  const { showLowConf = false, showRubber = true, focusCharId = null } = options;
  const inv = 1 / Math.max(0.02, scale);

  if (showLowConf) {
    ctx.lineWidth = 2 * inv;
    for (const c of page.chars) {
      const bw = c.bbox[2] - c.bbox[0];
      const bh = c.bbox[3] - c.bbox[1];
      if (!c.text) {
        ctx.strokeStyle = 'rgba(234,88,12,0.8)';
        ctx.setLineDash([4 * inv, 3 * inv]);
        ctx.strokeRect(c.bbox[0] - 1, c.bbox[1] - 1, bw + 2, bh + 2);
        ctx.setLineDash([]);
      } else if (c.note === 'spacing') {
        ctx.strokeStyle = 'rgba(37,99,235,0.85)';
        ctx.setLineDash([5 * inv, 4 * inv]);
        ctx.strokeRect(c.bbox[0] - 2, c.bbox[1] - 2, bw + 4, bh + 4);
        ctx.setLineDash([]);
      } else if (c.note === 'split' || c.note === 'merge') {
        ctx.strokeStyle = 'rgba(234,88,12,0.85)';
        ctx.strokeRect(c.bbox[0] - 2, c.bbox[1] - 2, bw + 4, bh + 4);
      } else if (c.conf < CONFIDENCE_THRESHOLD) {
        ctx.strokeStyle = 'rgba(220,38,38,0.85)';
        ctx.strokeRect(c.bbox[0] - 2, c.bbox[1] - 2, bw + 4, bh + 4);
      }
    }
  }

  ctx.strokeStyle = 'rgba(37,99,235,0.95)';
  ctx.lineWidth = 2 * inv;
  for (const c of page.chars) {
    if (selection.selectedCharIds.includes(c.id)) {
      ctx.strokeRect(c.bbox[0] - 3, c.bbox[1] - 3, c.bbox[2] - c.bbox[0] + 6, c.bbox[3] - c.bbox[1] + 6);
    }
  }

  const selLine = page.treeLines.find((l) => l.id === selection.selectedLineIds[0]);
  for (const lineId of selection.selectedLineIds) {
    const line = page.treeLines.find((l) => l.id === lineId);
    if (!line) continue;
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = Math.max(2 * inv, line.widthPx + 4);
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.stroke();
  }
  if (selLine && selection.selectedLineIds.length === 1) {
    ctx.fillStyle = '#2563eb';
    for (const [px, py] of [[selLine.x1, selLine.y1], [selLine.x2, selLine.y2]] as const) {
      ctx.beginPath();
      ctx.arc(px, py, 6 * inv, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const nodeId of selection.selectedNodeIds) {
    const node = page.treeNodes.find((n) => n.id === nodeId);
    if (!node) continue;
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = 2 * inv;
    ctx.beginPath();
    ctx.arc(node.cx, node.cy, node.r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const rectId of selection.selectedRectIds) {
    const rect = [...page.borderRects, ...page.tagRects].find((r) => r.id === rectId);
    if (!rect) continue;
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = 2 * inv;
    ctx.strokeRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
  }

  if (showRubber && selection.rubberBand) {
    const { x0, y0, x1, y1 } = selection.rubberBand;
    ctx.strokeStyle = 'rgba(37,99,235,0.9)';
    ctx.setLineDash([4 * inv, 4 * inv]);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }

  if (selection.selectedCharIds.length > 0) {
    const selected = page.chars.filter((c) => selection.selectedCharIds.includes(c.id));
    const union = unionCharBboxes(selected.map((c) => c.bbox));
    if (union) drawBboxResizeHandles(ctx, union, inv);
  }

  /* 悬停/跳转预览：青色，绘制在最上层，与低置信红框、选中蓝框区分 */
  if (focusCharId) {
    const focus = page.chars.find((c) => c.id === focusCharId);
    if (focus) {
      const pad = 6;
      const x = focus.bbox[0] - pad;
      const y = focus.bbox[1] - pad;
      const w = focus.bbox[2] - focus.bbox[0] + pad * 2;
      const h = focus.bbox[3] - focus.bbox[1] + pad * 2;
      ctx.save();
      ctx.fillStyle = 'rgba(6,182,212,0.22)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(8,145,178,1)';
      ctx.lineWidth = 3.5 * inv;
      ctx.setLineDash([8 * inv, 5 * inv]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}
