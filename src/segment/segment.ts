/**
 * 字符分割（流程③，全本地）：去除谱系线后做连通域分析，
 * 得到每个字的包围盒与中心坐标；含过宽连通域的垂直投影拆分启发式。
 */
import { CHAR_MAX_SIZE, CHAR_MIN_AREA, CHAR_MIN_SIZE } from '@/lib/constants';
import { connectedComponents, type ComponentBox } from '@/imaging/raster';
import type { CharItem, TreeLine } from '@/model/types';
import { median, uuid } from '@/lib/utils';

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

/**
 * 字符分割主入口。
 * @returns CharItem[]（text=null，等待识别；坐标为原图像素中心坐标）
 */
export function segmentChars(bin: Uint8Array, width: number, height: number, lines: TreeLine[]): CharItem[] {
  const cleaned = eraseLines(bin, width, height, lines);
  const { boxes } = connectedComponents(cleaned, width, height);

  // 粗过滤：字符尺寸范围
  const raw = boxes.filter(
    (b) => b.area >= CHAR_MIN_AREA && b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE && b.w <= CHAR_MAX_SIZE && b.h <= CHAR_MAX_SIZE,
  );
  if (raw.length === 0) return [];

  // 以高度中位数为典型字尺寸，拆分过宽粘连块
  const typicalH = median(raw.map((b) => b.h)) || 20;
  const typicalW = median(raw.map((b) => b.w)) || typicalH;
  const splitBoxes: ComponentBox[] = [];
  for (const b of raw) {
    if (b.w > typicalW * 1.8 && b.w > b.h * 1.3) {
      splitBoxes.push(...splitWideComponent(cleaned, width, b, typicalW));
    } else {
      splitBoxes.push(b);
    }
  }

  const chars: CharItem[] = splitBoxes
    .filter((b) => b.w >= CHAR_MIN_SIZE && b.h >= CHAR_MIN_SIZE)
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
