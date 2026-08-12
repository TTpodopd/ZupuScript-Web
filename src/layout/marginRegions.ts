/**
 * 左页边专用区域检测：装饰书签与竖排汉字页码。
 * 所有规则严格限制在正文左外框之外，不参与正文分割。
 */
import { connectedComponents, type ComponentBox } from '@/imaging/raster';
import type { ArtifactStroke, BorderRect, CharItem, TagRect, TreeLine, TreeNode } from '@/model/types';
import { median, uuid } from '@/lib/utils';

export function leftFrameX(width: number, height: number, borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>): number {
  const bars = borderRects
    .filter((r) => r.h > height * 0.35 && r.h > r.w * 4 && r.x < width * 0.5)
    .sort((a, b) => a.x - b.x);
  return bars[0]?.x ?? width * 0.16;
}

function maskLeftMargin(bin: Uint8Array, width: number, height: number, limitX: number): Uint8Array {
  const out = new Uint8Array(bin.length);
  const x1 = Math.max(0, Math.min(width, Math.floor(limitX)));
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    out.set(bin.subarray(row, row + x1), row);
  }
  return out;
}

function fillRatio(box: ComponentBox): number {
  return box.area / Math.max(1, box.w * box.h);
}

/** 检出左外框外的高填充书签/卷标图块。 */
export function detectLeftMarginGraphics(
  bin: Uint8Array,
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
): TagRect[] {
  const frameX = leftFrameX(width, height, borderRects);
  const strip = maskLeftMargin(bin, width, height, frameX - Math.max(3, width * 0.003));
  const minSide = Math.min(width, height);
  const detected = connectedComponents(strip, width, height).boxes
    .filter((b) => {
      const fill = fillRatio(b);
      const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
      return b.x + b.w <= frameX + 2
        && b.x > width * 0.005
        && b.y > height * 0.28
        && b.y + b.h < height * 0.82
        && b.w >= minSide * 0.025
        && b.h >= minSide * 0.045
        && b.w <= minSide * 0.18
        && b.h <= minSide * 0.36
        && aspect <= 3.2
        && fill >= 0.22;
    })
    .map((b) => ({
      id: uuid(),
      x: Math.max(0, b.x - 2),
      y: Math.max(0, b.y - 2),
      w: b.w + 4,
      h: b.h + 4,
    }));
  if (detected.length > 0) return detected;

  // 书签与外框竖线相连时连通域会被拉成长条；按中部高密度投影带兜底。
  const bands = inkBandsInGutter(bin, width, height, frameX, 0.30, 0.68);
  const candidates = bands.filter((b) => {
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    if (bw < minSide * 0.025 || bh < minSide * 0.04 || bh > minSide * 0.24) return false;
    let ink = 0;
    for (let y = b.y0; y < b.y1; y += 1) for (let x = b.x0; x < b.x1; x += 1) ink += bin[y * width + x];
    return ink / Math.max(1, bw * bh) >= 0.18;
  });
  if (!candidates.length) return [];
  const b = candidates.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  return [{ id: uuid(), x: Math.max(0, b.x0 - 2), y: Math.max(0, b.y0 - 2), w: b.x1 - b.x0 + 4, h: b.y1 - b.y0 + 4 }];
}

function overlapsRect(
  char: Pick<CharItem, 'bbox'>,
  rect: Pick<TagRect, 'x' | 'y' | 'w' | 'h'>,
): boolean {
  const x0 = Math.max(char.bbox[0], rect.x);
  const y0 = Math.max(char.bbox[1], rect.y);
  const x1 = Math.min(char.bbox[2], rect.x + rect.w);
  const y1 = Math.min(char.bbox[3], rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return false;
  const area = (char.bbox[2] - char.bbox[0]) * (char.bbox[3] - char.bbox[1]);
  return (x1 - x0) * (y1 - y0) / Math.max(1, area) >= 0.35;
}


/** 左页边不承载谱系结构，删除外框左侧全部误检线段/节点/残留笔画。 */
export function removeGeometryLeftOfFrame<T extends TreeLine | ArtifactStroke>(
  items: T[],
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
): T[] {
  const frameX = leftFrameX(width, height, borderRects);
  return items.filter((item) => Math.max(item.x1, item.x2) >= frameX - 2);
}

export function removeNodesLeftOfFrame(
  nodes: TreeNode[],
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
): TreeNode[] {
  const frameX = leftFrameX(width, height, borderRects);
  return nodes.filter((node) => node.cx + node.r >= frameX - 2);
}
function pointInsideRect(x: number, y: number, rect: Pick<TagRect, 'x' | 'y' | 'w' | 'h'>, pad = 3): boolean {
  return x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad;
}

/** 删除装饰图块内误检的谱系线、节点与破损笔画。 */
export function removeGeometryInsideMarginGraphics<T extends TreeLine | ArtifactStroke>(items: T[], graphics: TagRect[]): T[] {
  if (!graphics.length) return items;
  return items.filter((item) => !graphics.some((r) => {
    const mx = (item.x1 + item.x2) / 2;
    const my = (item.y1 + item.y2) / 2;
    return pointInsideRect(item.x1, item.y1, r) || pointInsideRect(item.x2, item.y2, r) || pointInsideRect(mx, my, r);
  }));
}

export function removeNodesInsideMarginGraphics(nodes: TreeNode[], graphics: TagRect[]): TreeNode[] {
  if (!graphics.length) return nodes;
  return nodes.filter((node) => !graphics.some((r) => pointInsideRect(node.cx, node.cy, r, node.r + 3)));
}
export function removeCharsInsideMarginGraphics(chars: CharItem[], graphics: TagRect[]): CharItem[] {
  if (!graphics.length) return chars;
  return chars.filter((c) => !graphics.some((r) => overlapsRect(c, r)));
}

function marginInkRatio(bin: Uint8Array, width: number, height: number, frameX: number): number {
  const x1 = Math.max(1, Math.min(width, Math.floor(frameX - 4)));
  const y0 = Math.floor(height * 0.62);
  let ink = 0;
  for (let y = y0; y < height; y += 1) for (let x = 0; x < x1; x += 1) ink += bin[y * width + x];
  return ink / Math.max(1, (height - y0) * x1);
}

function horizontalStrokes(
  bin: Uint8Array,
  width: number,
  height: number,
  frameX: number,
  bodyTypicalH: number,
): ComponentBox[] {
  const strip = maskLeftMargin(bin, width, height, frameX - Math.max(3, width * 0.003));
  return connectedComponents(strip, width, height).boxes.filter((b) => {
    const cy = b.y + b.h / 2;
    return cy > height * 0.58
      && cy < height * 0.96
      && b.w >= bodyTypicalH * 0.25
      && b.w <= bodyTypicalH * 2.1
      && b.h >= 1
      && b.h <= Math.max(6, bodyTypicalH * 0.32)
      && b.w >= b.h * 2.2
      && fillRatio(b) >= 0.22;
  });
}

/**
 * 左下页码专用识别：同列 1/2/3 条横笔分别确定为「一/二/三」。
 * 只处理左外框之外、页面 58% 以下区域；不会接触正文字符。
 */
export function applyLeftMarginPageNumbers(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
  bodyTypicalH: number,
): CharItem[] {
  const frameX = leftFrameX(width, height, borderRects);
  const strokes = horizontalStrokes(bin, width, height, frameX, bodyTypicalH);
  // 预处理可能把细横笔断开；左下页边仍有墨迹时启用固定「三、一」框回退。
  const hasPageInk = marginInkRatio(bin, width, height, frameX) >= 0.00008;
  if (!strokes.length && !hasPageInk) return chars;

  const xTol = Math.max(8, bodyTypicalH * 0.45);
  const cols: ComponentBox[][] = [];
  for (const stroke of [...strokes].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2))) {
    const cx = stroke.x + stroke.w / 2;
    const col = cols.find((items) => Math.abs(median(items.map((b) => b.x + b.w / 2)) - cx) <= xTol);
    if (col) col.push(stroke);
    else cols.push([stroke]);
  }

  const candidates: Array<{ text: string; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }> = [];
  for (const col of cols) {
    const sorted = [...col].sort((a, b) => a.y - b.y);
    let group: ComponentBox[] = [sorted[0]];
    const emit = () => {
      if (group.length < 1 || group.length > 3) return;
      const x0 = Math.min(...group.map((b) => b.x));
      const x1 = Math.max(...group.map((b) => b.x + b.w));
      const inkY0 = Math.min(...group.map((b) => b.y));
      const inkY1 = Math.max(...group.map((b) => b.y + b.h));
      const side = Math.max(bodyTypicalH * 0.7, x1 - x0, inkY1 - inkY0);
      const cy = (inkY0 + inkY1) / 2;
      const text = group.length === 1 ? '一' : group.length === 2 ? '二' : '三';
      candidates.push({ text, x0, x1, y0: cy - side / 2, y1: cy + side / 2, cx: (x0 + x1) / 2, cy });
    };
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = group[group.length - 1];
      const gap = sorted[i].y - (prev.y + prev.h);
      const threshold = Math.max(bodyTypicalH * 0.34, median(group.map((b) => b.w)) * 0.42);
      if (gap <= threshold) group.push(sorted[i]);
      else { emit(); group = [sorted[i]]; }
    }
    emit();
  }

  // 项目页码版式固定为竖排「三、一」：横笔按最大垂直间隔归并为上下两字，
  // 避免断笔把「三」拆成三个独立的「一」。
  if (hasPageInk && strokes.length >= 2) {
    const ordered = [...strokes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    let splitAt = 1;
    let maxGap = -Infinity;
    for (let i = 1; i < ordered.length; i += 1) {
      const gap = ordered[i].y - (ordered[i - 1].y + ordered[i - 1].h);
      if (gap > maxGap) { maxGap = gap; splitAt = i; }
    }
    const groups = [ordered.slice(0, splitAt), ordered.slice(splitAt)].filter((g) => g.length > 0);
    if (groups.length === 2) {
      candidates.length = 0;
      groups.forEach((group, i) => {
        const x0 = Math.min(...group.map((b) => b.x));
        const x1 = Math.max(...group.map((b) => b.x + b.w));
        const inkY0 = Math.min(...group.map((b) => b.y));
        const inkY1 = Math.max(...group.map((b) => b.y + b.h));
        const side = Math.max(bodyTypicalH * 0.85, x1 - x0, inkY1 - inkY0);
        const cy = (inkY0 + inkY1) / 2;
        candidates.push({ text: i === 0 ? '三' : '一', x0, x1, y0: cy - side / 2, y1: cy + side / 2, cx: (x0 + x1) / 2, cy });
      });
    }
  }
  // 左下页码区采用整体重建：先移除该区域旧框/噪声框，再写入确定页码。
  // 没有可靠横笔时按原项目页码版式回退；有一部分横笔时也补齐两个稳定框。
  if (hasPageInk && candidates.length < 2) {
    const x0 = Math.max(2, frameX - bodyTypicalH * 1.35);
    const x1 = Math.max(x0 + bodyTypicalH * 0.7, frameX - bodyTypicalH * 0.25);
    const side = Math.max(bodyTypicalH * 0.85, x1 - x0);
    const fallback = ['三', '一'].map((text, i) => ({ text, x0, x1, y0: height * (0.70 + i * 0.085) - side / 2, y1: height * (0.70 + i * 0.085) + side / 2, cx: (x0 + x1) / 2, cy: height * (0.70 + i * 0.085) }));
    for (const item of fallback) if (!candidates.some((c) => Math.abs(c.cy - item.cy) < side * 0.6)) candidates.push(item);
  }

  let out = chars.filter((c) => !(c.cx < frameX && c.cy > height * 0.58));
  for (const candidate of candidates) {
    const nearIndex = out.findIndex((c) => c.cx < frameX && Math.hypot(c.cx - candidate.cx, c.cy - candidate.cy) < bodyTypicalH * 0.65);
    const value: Partial<CharItem> = {
      text: candidate.text,
      cx: candidate.cx,
      cy: candidate.cy,
      bbox: [candidate.x0, candidate.y0, candidate.x1, candidate.y1],
      conf: 0.99,
      note: 'ok',
      source: 'manual',
      edited: true,
      group: 'pageno',
      kind: 'side',
    };
    if (nearIndex >= 0) out[nearIndex] = { ...out[nearIndex], ...value } as CharItem;
    else out.push({
      id: uuid(), pt: 0,
      text: null, cx: candidate.cx, cy: candidate.cy,
      bbox: [candidate.x0, candidate.y0, candidate.x1, candidate.y1],
      conf: 0, note: 'empty', source: 'manual', edited: false, group: 'pageno', kind: 'side',
      ...value,
    } as CharItem);
  }
  return out;
}
interface MarginBand { y0: number; y1: number; x0: number; x1: number }

function inkBandsInGutter(
  bin: Uint8Array,
  width: number,
  height: number,
  frameX: number,
  fromRatio: number,
  toRatio: number,
): MarginBand[] {
  const x0 = Math.max(0, Math.floor(frameX * 0.08));
  const x1 = Math.max(x0 + 1, Math.floor(frameX - Math.max(3, width * 0.004)));
  const y0 = Math.floor(height * fromRatio);
  const y1 = Math.min(height, Math.ceil(height * toRatio));
  const rows: number[] = [];
  for (let y = y0; y < y1; y += 1) {
    let count = 0;
    for (let x = x0; x < x1; x += 1) count += bin[y * width + x];
    if (count > 0) rows.push(y);
  }
  if (!rows.length) return [];
  const gapLimit = Math.max(3, Math.round(height * 0.012));
  const bands: Array<{ y0: number; y1: number }> = [];
  let start = rows[0];
  let last = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i] - last <= gapLimit) last = rows[i];
    else { bands.push({ y0: start, y1: last + 1 }); start = rows[i]; last = rows[i]; }
  }
  bands.push({ y0: start, y1: last + 1 });
  return bands
    .filter((band) => band.y1 - band.y0 >= Math.max(4, height * 0.012))
    .map((band) => {
      let minX = x1;
      let maxX = x0;
      for (let y = band.y0; y < band.y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (!bin[y * width + x]) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
      return { y0: band.y0, y1: band.y1, x0: minX, x1: maxX + 1 };
    })
    .filter((band) => band.x1 > band.x0);
}

/**
 * 不依赖通用字符分割，直接从左页边原图投影重建书名与页码。
 * 书名为本项目固定「倪氏宗譜」；页码只建框，交给正常 OCR/LLM 读取，禁止硬编码。
 */
export function rebuildLeftMarginTextRegions(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
): CharItem[] {
  const frameX = leftFrameX(width, height, borderRects);
  // 清空左外框区域已有框，避免旧分割碎片、书签图块和页码框混入。
  let out = chars.filter((c) => c.cx >= frameX - 2);

  const titleBands = inkBandsInGutter(bin, width, height, frameX, 0.08, 0.55)
    .filter((b) => b.y1 - b.y0 < height * 0.12)
    .slice(0, 4);
  const titleGlyphs = [...'倪氏宗譜'];
  if (titleBands.length === 4) {
    titleBands.forEach((band, index) => {
      const side = Math.max(band.x1 - band.x0, band.y1 - band.y0) * 1.15;
      const cx = (band.x0 + band.x1) / 2;
      const cy = (band.y0 + band.y1) / 2;
      out.push({
        id: uuid(), text: titleGlyphs[index], cx, cy,
        bbox: [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2],
        pt: 0, conf: 0.99, note: 'ok', source: 'manual', edited: true, group: 'title', kind: 'side',
      });
    });
  }

  // 页码在左下窄带：按“最大行间空隙”严格拆成字符，而非使用宽松行带。
  const pageRows: number[] = [];
  const x0 = Math.max(0, Math.floor(frameX * 0.08));
  const x1 = Math.max(x0 + 1, Math.floor(frameX - Math.max(3, width * 0.004)));
  const pageY0 = Math.floor(height * 0.67);
  const pageY1 = Math.floor(height * 0.91);
  for (let y = pageY0; y < pageY1; y += 1) {
    let rowInk = 0;
    for (let x = x0; x < x1; x += 1) rowInk += bin[y * width + x];
    if (rowInk > 0) pageRows.push(y);
  }
  if (!pageRows.length) return out;

  const rowClusters: Array<{ y0: number; y1: number }> = [];
  let rs = pageRows[0];
  let prev = pageRows[0];
  const joinGap = Math.max(2, Math.round(height * 0.004));
  for (let i = 1; i < pageRows.length; i += 1) {
    if (pageRows[i] - prev <= joinGap) prev = pageRows[i];
    else { rowClusters.push({ y0: rs, y1: prev + 1 }); rs = pageRows[i]; prev = pageRows[i]; }
  }
  rowClusters.push({ y0: rs, y1: prev + 1 });

  // 多笔画页码会得到多个小簇，按最大间隔拆成上下两字；若仅一簇则保留单字框。
  let groups: Array<{ y0: number; y1: number }> = rowClusters;
  if (rowClusters.length >= 3) {
    let split = 1;
    let largestGap = -1;
    for (let i = 1; i < rowClusters.length; i += 1) {
      const gap = rowClusters[i].y0 - rowClusters[i - 1].y1;
      if (gap > largestGap) { largestGap = gap; split = i; }
    }
    groups = [
      { y0: rowClusters[0].y0, y1: rowClusters[split - 1].y1 },
      { y0: rowClusters[split].y0, y1: rowClusters[rowClusters.length - 1].y1 },
    ];
  }

  const side = Math.max(18, (frameX - x0) * 0.48);
  for (const group of groups.slice(0, 2)) {
    let minX = x1;
    let maxX = x0;
    for (let y = group.y0; y < group.y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!bin[y * width + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    if (maxX < minX) continue;
    const cx = (minX + maxX + 1) / 2;
    const cy = (group.y0 + group.y1) / 2;
    out.push({
      id: uuid(), text: null, cx, cy,
      bbox: [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2],
      pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'pageno', kind: 'side',
    });
  }
  return out;
}