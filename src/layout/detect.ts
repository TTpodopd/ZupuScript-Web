/**
 * 版面检测（F3.1–F3.3，全本地）：
 * 形态学开运算（横核/纵核）→ 外框实心黑条、谱系横线、竖线。
 *
 * 实现说明：矩形核 (k,1) / (1,k) 的开运算等价于「保留长度 ≥ k 的连续墨迹行程」，
 * 这里用行程长度法实现，与 OpenCV morphologyEx 结果一致且更快。
 */
import {
  KERNEL_H_LEN,
  KERNEL_LINE_V_LEN,
  KERNEL_V_LEN,
  MIN_LINE_LEN,
} from '@/lib/constants';
import { connectedComponents } from '@/imaging/raster';
import { isSolidGraphicBlock } from '@/layout/graphicBlock';
import type { BorderRect, TagRect, TreeLine } from '@/model/types';
import { uuid } from '@/lib/utils';

/**
 * 行程开运算：axis='h' 保留水平连续 ≥ len 的墨迹段；axis='v' 保留垂直段。
 */
export function openingByRunLength(
  bin: Uint8Array,
  width: number,
  height: number,
  axis: 'h' | 'v',
  len: number,
): Uint8Array {
  const out = new Uint8Array(bin.length);
  if (axis === 'h') {
    for (let y = 0; y < height; y++) {
      let runStart = -1;
      for (let x = 0; x <= width; x++) {
        const ink = x < width ? bin[y * width + x] : 0;
        if (ink && runStart < 0) runStart = x;
        if (!ink && runStart >= 0) {
          if (x - runStart >= len) {
            out.fill(1, y * width + runStart, y * width + x);
          }
          runStart = -1;
        }
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      let runStart = -1;
      for (let y = 0; y <= height; y++) {
        const ink = y < height ? bin[y * width + x] : 0;
        if (ink && runStart < 0) runStart = y;
        if (!ink && runStart >= 0) {
          if (y - runStart >= len) {
            for (let yy = runStart; yy < y; yy++) out[yy * width + x] = 1;
          }
          runStart = -1;
        }
      }
    }
  }
  return out;
}

/** 从开运算结果提取线段（连通域 → 中心线 + 厚度） */
function componentsToLines(opened: Uint8Array, width: number, height: number, orientation: 'h' | 'v'): TreeLine[] {
  const { boxes } = connectedComponents(opened, width, height);
  const lines: TreeLine[] = [];
  for (const b of boxes) {
    if (orientation === 'h') {
      if (b.w < MIN_LINE_LEN) continue;
      const cy = b.y + b.h / 2;
      lines.push({
        id: uuid(),
        x1: b.x,
        y1: cy,
        x2: b.x + b.w,
        y2: cy,
        widthPx: Math.max(1, Math.round(b.h)),
        orientation: 'h',
      });
    } else {
      if (b.h < MIN_LINE_LEN) continue;
      const cx = b.x + b.w / 2;
      lines.push({
        id: uuid(),
        x1: cx,
        y1: b.y,
        x2: cx,
        y2: b.y + b.h,
        widthPx: Math.max(1, Math.round(b.w)),
        orientation: 'v',
      });
    }
  }
  return lines;
}

export interface RectDetectResult {
  borderRects: BorderRect[];
  tagRects: TagRect[];
  /** 外框/装饰块掩码（供线段检测前剔除，避免粗条被误判为线） */
  rectMask: Uint8Array;
}

function projectionBands(bin: Uint8Array, width: number, height: number, axis: 'h' | 'v', minCoverage: number): Array<{ start: number; end: number }> {
  const length = axis === 'h' ? height : width;
  const span = axis === 'h' ? width : height;
  const bands: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i <= length; i += 1) {
    let ink = 0;
    if (i < length) {
      if (axis === 'h') {
        for (let x = 0; x < width; x += 1) ink += bin[i * width + x];
      } else {
        for (let y = 0; y < height; y += 1) ink += bin[y * width + i];
      }
    }
    const isBand = i < length && ink / span >= minCoverage;
    if (isBand && start < 0) start = i;
    if (!isBand && start >= 0) {
      bands.push({ start, end: i });
      start = -1;
    }
  }
  return bands;
}

function markRectMask(mask: Uint8Array, width: number, height: number, rect: BorderRect): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) mask[y * width + x] = 1;
  }
}

function appendRectIfDistinct(
  rects: BorderRect[],
  rect: BorderRect,
  tolerance = { x: 8, y: 8, w: 16, h: 16 },
): void {
  if (
    rects.some(
      (existing) =>
        Math.abs(existing.x - rect.x) < tolerance.x &&
        Math.abs(existing.y - rect.y) < tolerance.y &&
        Math.abs(existing.w - rect.w) < tolerance.w &&
        Math.abs(existing.h - rect.h) < tolerance.h,
    )
  ) {
    return;
  }
  rects.push(rect);
}

function maxBorderBarThickness(pageW: number, pageH: number): number {
  return Math.max(12, Math.round(Math.min(pageW, pageH) * 0.065));
}

function pageEdgePad(pageW: number, pageH: number): number {
  return Math.max(16, Math.round(Math.min(pageW, pageH) * 0.12));
}

function isNearPageEdge(
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): boolean {
  const pad = pageEdgePad(width, height);
  return (
    rect.x < pad ||
    rect.y < pad ||
    rect.x + rect.w > width - pad ||
    rect.y + rect.h > height - pad
  );
}

function countInkInRect(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  let ink = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) ink += bin[y * width + x];
  }
  return ink;
}

function inkFillRatio(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): number {
  const area = Math.max(1, rect.w * rect.h);
  return countInkInRect(bin, width, height, rect) / area;
}

/** 长条方向上的墨迹覆盖（竖条看行、横条看列） */
function barSpanCoverage(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (rect.w >= rect.h * 2) {
    let cols = 0;
    for (let x = x0; x < x1; x += 1) {
      for (let y = y0; y < y1; y += 1) {
        if (bin[y * width + x]) {
          cols += 1;
          break;
        }
      }
    }
    return cols / Math.max(1, x1 - x0);
  }
  let rows = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (bin[y * width + x]) {
        rows += 1;
        break;
      }
    }
  }
  return rows / Math.max(1, y1 - y0);
}

/** 检测阶段：墨迹密度 + 条带形态，过滤空白页边误检 */
export function isPlausibleBorderBar(
  bin: Uint8Array,
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): boolean {
  const shortSide = Math.min(rect.w, rect.h);
  const longSide = Math.max(rect.w, rect.h);
  const aspect = longSide / Math.max(1, shortSide);
  const maxThickness = maxBorderBarThickness(width, height);
  const fill = inkFillRatio(bin, width, height, rect);
  const span = barSpanCoverage(bin, width, height, rect);
  const nearEdge = isNearPageEdge(width, height, rect);

  if (fill < 0.28) return false;
  if (aspect >= 2.5 && span < 0.48) return false;

  const pageArea = width * height;
  const area = rect.w * rect.h;
  if (area > pageArea * 0.12) {
    if (shortSide > maxThickness || fill < 0.5) return false;
  }

  // 页边高填充实心框（扫描/PDF 均适用）
  if (nearEdge && fill >= 0.4 && aspect >= 2.8 && shortSide <= maxThickness) return true;
  // 细页框
  if (aspect >= 4 && shortSide <= maxThickness && fill >= 0.32) return true;
  // 较厚装饰边条
  if (aspect >= 5 && shortSide >= Math.max(8, Math.round(Math.min(width, height) * 0.004)) && fill >= 0.48) {
    return true;
  }
  return shortSide <= maxThickness && aspect >= 3 && fill >= 0.42;
}

/** 渲染阶段：面积过大且不够「细条」时只描边不填黑（避免整页涂黑） */
export function isRenderableSolidBorderRect(
  rect: Pick<BorderRect, 'w' | 'h'>,
  pageW: number,
  pageH: number,
): boolean {
  const area = rect.w * rect.h;
  const pageArea = pageW * pageH;
  if (area <= pageArea * 0.12) return true;
  const minDim = Math.min(rect.w, rect.h);
  return minDim <= maxBorderBarThickness(pageW, pageH);
}

function appendBorderRectIfValid(
  rects: BorderRect[],
  rect: BorderRect,
  bin: Uint8Array,
  width: number,
  height: number,
  tolerance = { x: 8, y: 8, w: 16, h: 16 },
): boolean {
  if (!isPlausibleBorderBar(bin, width, height, rect)) return false;
  if (!isRenderableSolidBorderRect(rect, width, height)) return false;
  const before = rects.length;
  appendRectIfDistinct(rects, rect, tolerance);
  return rects.length > before;
}

function isFlushWithPageEdge(
  width: number,
  height: number,
  rect: Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>,
): boolean {
  const tol = 4;
  const touchesTop = rect.y <= tol;
  const touchesBottom = rect.y + rect.h >= height - tol;
  const touchesLeft = rect.x <= tol;
  const touchesRight = rect.x + rect.w >= width - tol;
  if (rect.w >= rect.h * 2) return touchesTop || touchesBottom;
  if (rect.h >= rect.w * 2) return touchesLeft || touchesRight;
  return touchesTop || touchesBottom || touchesLeft || touchesRight;
}

/** 单轴开运算 + 页边位置约束，检出扫描件厚页框（横纵交集会漏掉短边 < 80px 的实心条） */
function detectSolidFrameBars(bin: Uint8Array, width: number, height: number): BorderRect[] {
  const vMinRun = Math.max(MIN_LINE_LEN, Math.round(height * 0.48));
  const hMinRun = Math.max(MIN_LINE_LEN, Math.round(width * 0.48));
  const edgePad = pageEdgePad(width, height);
  const maxThick = maxBorderBarThickness(width, height);
  const bars: BorderRect[] = [];

  const consider = (box: { x: number; y: number; w: number; h: number }, orient: 'h' | 'v') => {
    const shortSide = orient === 'v' ? box.w : box.h;
    const longSide = orient === 'v' ? box.h : box.w;
    if (shortSide < 2 || shortSide > maxThick) return;
    if (longSide < (orient === 'v' ? height : width) * 0.46) return;
    const nearEdge =
      orient === 'v'
        ? box.x < edgePad || box.x + box.w > width - edgePad
        : box.y < edgePad || box.y + box.h > height - edgePad;
    if (!nearEdge) return;
    const rect: BorderRect = { id: uuid(), x: box.x, y: box.y, w: box.w, h: box.h };
    if (!isPlausibleBorderBar(bin, width, height, rect)) return;
    appendRectIfDistinct(bars, rect);
  };

  const vOpen = openingByRunLength(bin, width, height, 'v', vMinRun);
  for (const box of connectedComponents(vOpen, width, height).boxes) consider(box, 'v');

  const hOpen = openingByRunLength(bin, width, height, 'h', hMinRun);
  for (const box of connectedComponents(hOpen, width, height).boxes) consider(box, 'h');

  return bars;
}

/** 在页边窄带内按列/行剖面提取紧凑条框，避免把整个扫描带当作边框 */
function extractBarFromStripProfile(
  bin: Uint8Array,
  width: number,
  height: number,
  axis: 'h' | 'v',
  start: number,
  end: number,
  anchor: 'min' | 'max',
): BorderRect | null {
  const maxThick = maxBorderBarThickness(width, height);
  const minSpan = axis === 'v' ? height * 0.52 : width * 0.52;

  type SliceStat = { i: number; spanLen: number; fill: number; inkMin: number; inkMax: number };
  const slices: SliceStat[] = [];

  if (axis === 'v') {
    for (let x = start; x < end; x += 1) {
      let rows = 0;
      let ink = 0;
      let minY = height;
      let maxY = 0;
      for (let y = 0; y < height; y += 1) {
        if (!bin[y * width + x]) continue;
        rows += 1;
        ink += 1;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (rows === 0) continue;
      const spanLen = maxY - minY + 1;
      if (spanLen < minSpan) continue;
      slices.push({ i: x, spanLen, fill: ink / spanLen, inkMin: minY, inkMax: maxY });
    }
  } else {
    for (let y = start; y < end; y += 1) {
      let cols = 0;
      let ink = 0;
      let minX = width;
      let maxX = 0;
      for (let x = 0; x < width; x += 1) {
        if (!bin[y * width + x]) continue;
        cols += 1;
        ink += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      if (cols === 0) continue;
      const spanLen = maxX - minX + 1;
      if (spanLen < minSpan) continue;
      slices.push({ i: y, spanLen, fill: ink / spanLen, inkMin: minX, inkMax: maxX });
    }
  }

  if (!slices.length) return null;

  const runs: Array<{ start: number; end: number; slices: SliceStat[] }> = [];
  let runStart = slices[0].i;
  let runSlices: SliceStat[] = [slices[0]];
  for (let idx = 1; idx < slices.length; idx += 1) {
    if (slices[idx].i === slices[idx - 1].i + 1) {
      runSlices.push(slices[idx]);
    } else {
      runs.push({ start: runStart, end: slices[idx - 1].i + 1, slices: runSlices });
      runStart = slices[idx].i;
      runSlices = [slices[idx]];
    }
  }
  runs.push({ start: runStart, end: runSlices[runSlices.length - 1].i + 1, slices: runSlices });

  const pick =
    anchor === 'min'
      ? runs.sort((a, b) => a.start - b.start)[0]
      : runs.sort((a, b) => b.end - a.end)[0];
  if (!pick || pick.end - pick.start > maxThick) return null;

  const inkMin = Math.min(...pick.slices.map((s) => s.inkMin));
  const inkMax = Math.max(...pick.slices.map((s) => s.inkMax));
  if (axis === 'v') {
    return { id: uuid(), x: pick.start, y: inkMin, w: pick.end - pick.start, h: inkMax - inkMin + 1 };
  }
  return { id: uuid(), x: inkMin, y: pick.start, w: inkMax - inkMin + 1, h: pick.end - pick.start };
}

/** 扫描页边窄带，提取 PDF 细页框与内缩厚页框 */
function detectPageOutlineBars(bin: Uint8Array, width: number, height: number): BorderRect[] {
  const strip = Math.max(24, Math.round(Math.min(width, height) * 0.12));
  const bars: BorderRect[] = [];

  const tryBar = (bar: BorderRect | null) => {
    if (!bar) return;
    if (!isFlushWithPageEdge(width, height, bar)) return;
    if (!isPlausibleBorderBar(bin, width, height, bar)) return;
    appendRectIfDistinct(bars, { ...bar, id: uuid() });
  };

  tryBar(extractBarFromStripProfile(bin, width, height, 'h', 0, strip, 'min'));
  tryBar(extractBarFromStripProfile(bin, width, height, 'h', height - strip, height, 'max'));
  tryBar(extractBarFromStripProfile(bin, width, height, 'v', 0, strip, 'min'));
  tryBar(extractBarFromStripProfile(bin, width, height, 'v', width - strip, width, 'max'));
  return bars;
}

/**
 * 检测外框实心黑条与装饰块（F3.1/F3.5 第一步）。
 * 粗核开运算（横 80 / 纵 80）取交集区域 → 连通域 → 按长宽比与填充率分类。
 */
export function detectRects(bin: Uint8Array, width: number, height: number): RectDetectResult {
  const openH = openingByRunLength(bin, width, height, 'h', KERNEL_H_LEN);
  const openV = openingByRunLength(bin, width, height, 'v', KERNEL_V_LEN);
  // 只有同时通过横向和纵向开运算的像素才是实心结构。
  // 使用并集会把任意一条细谱系线误升级为 BorderRect，随后在画布上变成巨型红框。
  const solid = new Uint8Array(bin.length);
  for (let i = 0; i < solid.length; i++) {
    solid[i] = openH[i] & openV[i];
  }
  const { labels, boxes } = connectedComponents(solid, width, height);
  const borderRects: BorderRect[] = [];
  const tagRects: TagRect[] = [];
  const rectMask = new Uint8Array(bin.length);

  const addBars = (bars: BorderRect[]) => {
    for (const bar of bars) {
      appendRectIfDistinct(borderRects, bar);
      markRectMask(rectMask, width, height, bar);
    }
  };

  addBars(detectSolidFrameBars(bin, width, height));
  addBars(detectPageOutlineBars(bin, width, height));

  const edgeMargin = (axis: 'h' | 'v') =>
    axis === 'h' ? Math.max(16, Math.round(height * 0.1)) : Math.max(16, Math.round(width * 0.1));
  const isEdgeBand = (axis: 'h' | 'v', band: { start: number; end: number }) => {
    const margin = edgeMargin(axis);
    const span = axis === 'h' ? height : width;
    return band.start < margin || band.end > span - margin;
  };
  const minBandThickness = (atEdge: boolean) =>
    atEdge
      ? Math.max(2, Math.round(Math.min(width, height) * 0.0008))
      : Math.max(8, Math.round(Math.min(width, height) * 0.004));

  const addProjectionBorder = (axis: 'h' | 'v', band: { start: number; end: number }) => {
    const atEdge = isEdgeBand(axis, band);
    // 投影只补页边实心框；正文列/行高覆盖带不能当作边框
    if (!atEdge) return;
    const minThickness = minBandThickness(atEdge);
    if (band.end - band.start < minThickness) return;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let y = axis === 'h' ? band.start : 0; y < (axis === 'h' ? band.end : height); y += 1) {
      for (let x = axis === 'v' ? band.start : 0; x < (axis === 'v' ? band.end : width); x += 1) {
        if (!bin[y * width + x]) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    if (maxX <= minX || maxY <= minY) return;
    const rect = { id: uuid(), x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    if (appendBorderRectIfValid(borderRects, rect, bin, width, height)) {
      markRectMask(rectMask, width, height, rect);
    }
  };
  // 投影补漏：页边高覆盖带（阈值略低以兼容厚框内缘）
  for (const band of projectionBands(bin, width, height, 'h', 0.72)) addProjectionBorder('h', band);
  for (const band of projectionBands(bin, width, height, 'v', 0.72)) addProjectionBorder('v', band);
  for (const b of boxes) {
    const longSide = Math.max(b.w, b.h);
    const shortSide = Math.min(b.w, b.h);
    const aspect = longSide / Math.max(1, shortSide);
    const fillRatio = b.area / (b.w * b.h);
    const minSolidThickness = Math.max(8, Math.round(Math.min(width, height) * 0.004));
    // 长宽比只说明“像线”，不能说明“是实心边条”。厚度门槛专门排除谱系细线。
    const isBorder = aspect >= 5 && longSide >= 150 && shortSide >= minSolidThickness && fillRatio >= 0.55;
    const entry = { id: uuid(), x: b.x, y: b.y, w: b.w, h: b.h };
    const isTag =
      !isBorder &&
      b.w >= 30 &&
      b.h >= 30 &&
      fillRatio >= 0.58 &&
      b.area >= 1200 &&
      isSolidGraphicBlock(bin, width, height, entry);
    if (!isBorder && !isTag) continue;
    if (isBorder) appendBorderRectIfValid(borderRects, entry, bin, width, height);
    else tagRects.push(entry);
    // 掩码标记
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === b.label) rectMask[i] = 1;
    }
  }
  return { borderRects, tagRects, rectMask };
}

/**
 * 检测谱系横线与竖线（F3.2/F3.3）。
 * 先剔除粗实心块，再分别用横核 (≥40,1) 与纵核 (1,≥40) 开运算。
 */
export function detectTreeLines(bin: Uint8Array, width: number, height: number, rectMask: Uint8Array): TreeLine[] {
  const cleaned = new Uint8Array(bin.length);
  for (let i = 0; i < cleaned.length; i++) {
    cleaned[i] = bin[i] && !rectMask[i] ? 1 : 0;
  }
  const horizontalMin = Math.max(MIN_LINE_LEN, Math.round(width * 0.08));
  const verticalMin = Math.max(KERNEL_LINE_V_LEN, Math.round(height * 0.022));
  const openH = openingByRunLength(cleaned, width, height, 'h', horizontalMin);
  const openV = openingByRunLength(cleaned, width, height, 'v', verticalMin);
  const hLines = componentsToLines(openH, width, height, 'h').filter((line) => line.widthPx <= Math.max(10, height * 0.004));
  const vLines = componentsToLines(openV, width, height, 'v').filter((line) => line.widthPx <= Math.max(10, width * 0.006));
  return [...hLines, ...vLines];
}
