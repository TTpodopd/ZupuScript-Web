/**
 * 字符分割（流程③，全本地）：去除谱系线后做连通域分析，
 * 得到每个字的包围盒与中心坐标；含过宽连通域的垂直投影拆分启发式。
 */
import { CHAR_MAX_SIZE, CHAR_MIN_AREA, CHAR_MIN_SIZE } from '@/lib/constants';
import { connectedComponents, type ComponentBox } from '@/imaging/raster';
import type { BorderRect, CharItem, TagRect, TreeLine } from '@/model/types';
import { median, uuid } from '@/lib/utils';

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

/** 在二值图上抹除谱系线（线两侧加 padding） */
export function eraseLines(bin: Uint8Array, width: number, height: number, lines: TreeLine[]): Uint8Array {
  const out = new Uint8Array(bin);
  for (const l of lines) {
    const pad = Math.ceil(l.widthPx / 2) + 2;
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

/** 垂直投影拆分过宽连通域（两个或多个字粘连）：在中间 1/3 区域找投影谷切分 */
function splitWideComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetWidth: number,
): ComponentBox[] {
  const parts: ComponentBox[] = [box];
  let splitHappened = true;
  // 迭代拆分，直到每段宽度 ≤ 1.6×目标宽
  let guard = 0;
  while (splitHappened && guard++ < 8) {
    splitHappened = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.w <= targetWidth * 1.6) continue;
      // 垂直投影
      const proj = new Uint32Array(p.w);
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          if (bin[y * width + x]) proj[x - p.x]++;
        }
      }
      // 在中间区域找最小投影列
      const lo = Math.floor(p.w * 0.3);
      const hi = Math.ceil(p.w * 0.7);
      let minCol = -1;
      let minVal = Infinity;
      for (let x = lo; x < hi; x++) {
        if (proj[x] < minVal) {
          minVal = proj[x];
          minCol = x;
        }
      }
      // 谷底足够低才切（避免把单字拆开）
      if (minCol < 0 || minVal > p.h * 0.15) continue;
      const cutX = p.x + minCol;
      const left: ComponentBox = { label: p.label, x: p.x, y: p.y, w: minCol, h: p.h, area: 0 };
      const right: ComponentBox = { label: p.label, x: cutX, y: p.y, w: p.w - minCol, h: p.h, area: 0 };
      if (left.w < CHAR_MIN_SIZE || right.w < CHAR_MIN_SIZE) continue;
      parts.splice(i, 1, left, right);
      splitHappened = true;
      break;
    }
  }
  return parts;
}

/** 水平投影拆分竖排粘连字：逻辑与横向拆分对称。 */
function splitTallComponent(
  bin: Uint8Array,
  width: number,
  box: ComponentBox,
  targetHeight: number,
): ComponentBox[] {
  const parts: ComponentBox[] = [box];
  let splitHappened = true;
  let guard = 0;
  while (splitHappened && guard++ < 8) {
    splitHappened = false;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.h <= targetHeight * 1.6) continue;
      const projection = new Uint32Array(part.h);
      for (let y = part.y; y < part.y + part.h; y += 1) {
        for (let x = part.x; x < part.x + part.w; x += 1) {
          if (bin[y * width + x]) projection[y - part.y] += 1;
        }
      }
      const lo = Math.floor(part.h * 0.3);
      const hi = Math.ceil(part.h * 0.7);
      let minRow = -1;
      let minValue = Infinity;
      for (let y = lo; y < hi; y += 1) {
        if (projection[y] < minValue) {
          minValue = projection[y];
          minRow = y;
        }
      }
      if (minRow < 0 || minValue > part.w * 0.15) continue;
      const cutY = part.y + minRow;
      const top: ComponentBox = { label: part.label, x: part.x, y: part.y, w: part.w, h: minRow, area: 0 };
      const bottom: ComponentBox = { label: part.label, x: part.x, y: cutY, w: part.w, h: part.h - minRow, area: 0 };
      if (top.h < CHAR_MIN_SIZE || bottom.h < CHAR_MIN_SIZE) continue;
      parts.splice(i, 1, top, bottom);
      splitHappened = true;
      break;
    }
  }
  return parts;
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
): CharItem[] {
  const withoutLines = eraseLines(bin, width, height, lines);
  const cleaned = eraseLayoutRects(withoutLines, width, height, excludedRects);
  const { labels, boxes: fragments } = connectedComponents(cleaned, width, height);
  const denoised = new Uint8Array(cleaned);
  const smallLabels = new Set(fragments.filter((box) => box.area < 6).map((box) => box.label));
  if (smallLabels.size > 0) {
    for (let i = 0; i < denoised.length; i += 1) if (smallLabels.has(labels[i])) denoised[i] = 0;
  }
  // 半径过大会把竖排相邻字和线端残留黏成一个框；高分辨率页面也限制在 5px 内。
  const groupingRadius = Math.max(2, Math.min(5, Math.round(Math.min(width, height) / 650)));
  const grouped = connectedComponents(dilateForCharacterGrouping(denoised, width, height, groupingRadius), width, height).boxes;
  const boxes = grouped.map((box) => tightenBox(denoised, width, height, box)).filter((box): box is ComponentBox => box !== null);

  // 粗过滤：字符尺寸范围
  const raw = boxes.filter(
    (b) => {
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      const fill = b.area / Math.max(1, b.w * b.h);
      return b.area >= CHAR_MIN_AREA && b.w >= CHAR_MIN_SIZE * 1.5 && b.h >= CHAR_MIN_SIZE * 1.5
        // 先允许中等长条进入投影拆分；最终字框会再次按 2.2 的长宽比收口。
        && b.w <= CHAR_MAX_SIZE && b.h <= CHAR_MAX_SIZE && aspect <= 4
        && fill >= 0.045;
    },
  );
  if (raw.length === 0) return [];

  // 以高度中位数为典型字尺寸，拆分过宽粘连块
  const typicalH = median(raw.map((b) => b.h)) || 20;
  const typicalW = median(raw.map((b) => b.w)) || typicalH;
  const splitBoxes: ComponentBox[] = [];
  for (const b of raw) {
    if (b.w > typicalW * 1.8 && b.w > b.h * 1.3) {
      splitBoxes.push(...splitWideComponent(cleaned, width, b, typicalW));
    } else if (b.h > typicalH * 1.8 && b.h > b.w * 1.3) {
      splitBoxes.push(...splitTallComponent(cleaned, width, b, typicalH));
    } else {
      splitBoxes.push(b);
    }
  }

  // 拆分后的子框再次收紧到真实墨迹，避免投影切口留下空白边距。
  const tightenedSplitBoxes = splitBoxes
    .map((box) => tightenBox(cleaned, width, height, box))
    .filter((box): box is ComponentBox => box !== null);

  const chars: CharItem[] = tightenedSplitBoxes
    .filter((b) => {
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      return b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE && aspect <= 2.2;
    })
    .map((b) => ({
      id: uuid(),
      text: null,
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      bbox: [b.x, b.y, b.x + b.w, b.y + b.h] as [number, number, number, number],
      pt: 0,
      conf: 0,
      note: 'empty' as const,
      source: 'manual' as const,
      edited: false,
      group: 'body' as const,
      kind: 'text' as const,
    }));
  // 稳定排序：先上后下、先右后左（竖排阅读习惯），便于人工核对顺序
  chars.sort((a, b) => (Math.abs(a.cy - b.cy) > typicalH / 2 ? a.cy - b.cy : b.cx - a.cx));
  return chars;
}
