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

/** 扫描页边区域的墨迹，补回 PDF 矢量细页框（约 1pt） */
function detectPageOutlineFrame(
  bin: Uint8Array,
  width: number,
  height: number,
): BorderRect | null {
  const strip = Math.max(24, Math.round(Math.min(width, height) * 0.045));
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  const scan = (y0: number, y1: number, x0: number, x1: number) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!bin[y * width + x]) continue;
        found = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  };

  scan(0, strip, 0, width);
  scan(height - strip, height, 0, width);
  scan(0, height, 0, strip);
  scan(0, height, width - strip, width);

  if (!found) return null;
  if (maxX - minX < width * 0.35 || maxY - minY < height * 0.35) return null;
  return { id: uuid(), x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
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

  const outline = detectPageOutlineFrame(bin, width, height);
  if (outline) {
    appendRectIfDistinct(borderRects, outline);
    markRectMask(rectMask, width, height, outline);
  }

  // 页面外框通常占据整行/整列的大部分墨迹，投影检测比粗块连通域更稳健，
  // 也能避免把边框拆成大量“谱系线”。
  const edgeMargin = (axis: 'h' | 'v') =>
    axis === 'h' ? Math.max(12, Math.round(height * 0.03)) : Math.max(12, Math.round(width * 0.03));
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
    appendRectIfDistinct(borderRects, rect);
    markRectMask(rectMask, width, height, rect);
  };
  // 投影只用于补回覆盖整页的大实心边条；细线由 detectTreeLines 负责。
  for (const band of projectionBands(bin, width, height, 'h', 0.82)) addProjectionBorder('h', band);
  for (const band of projectionBands(bin, width, height, 'v', 0.82)) addProjectionBorder('v', band);
  for (const b of boxes) {
    const longSide = Math.max(b.w, b.h);
    const shortSide = Math.min(b.w, b.h);
    const aspect = longSide / Math.max(1, shortSide);
    const fillRatio = b.area / (b.w * b.h);
    const minSolidThickness = Math.max(8, Math.round(Math.min(width, height) * 0.004));
    // 长宽比只说明“像线”，不能说明“是实心边条”。厚度门槛专门排除谱系细线。
    const isBorder = aspect >= 5 && longSide >= 150 && shortSide >= minSolidThickness && fillRatio >= 0.55;
    const isTag = !isBorder && b.w >= 30 && b.h >= 30 && fillRatio >= 0.55 && b.area >= 1200;
    if (!isBorder && !isTag) continue;
    const entry = { id: uuid(), x: b.x, y: b.y, w: b.w, h: b.h };
    if (isBorder) appendRectIfDistinct(borderRects, entry);
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
