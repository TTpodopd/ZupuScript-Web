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

/** 右页边外框竖条的右边缘 x：其右侧即为右页边区（对称于 leftFrameX）。 */
function detectRightFrameFromBinary(bin: Uint8Array, width: number, height: number): number | undefined {
  const y0 = Math.max(0, Math.floor(height * 0.06));
  const y1 = Math.min(height, Math.floor(height * 0.96));
  const minRun = Math.max(8, Math.floor(height * 0.2));
  const candidates: Array<{ x: number; score: number }> = [];
  for (let x = Math.floor(width * 0.52); x < Math.floor(width * 0.985); x += 1) {
    let ink = 0;
    let run = 0;
    let longest = 0;
    for (let y = y0; y < y1; y += 1) {
      // A scanned frame is often 1–3 px wide and slightly broken; tolerate a
      // one-pixel horizontal drift while keeping the continuity requirement.
      const hit = bin[y * width + x] || (x > 0 && bin[y * width + x - 1]) || (x + 1 < width && bin[y * width + x + 1]);
      if (hit) { ink += 1; run += 1; longest = Math.max(longest, run); } else run = 0;
    }
    const coverage = ink / Math.max(1, y1 - y0);
    if (coverage >= 0.22 && longest >= minRun) candidates.push({ x, score: coverage + longest / Math.max(1, height) });
  }
  if (!candidates.length) return undefined;
  // Collapse adjacent pixels into bars and choose the rightmost strong bar;
  // title glyphs cannot satisfy the long-run/coverage thresholds together.
  const groups: Array<{ x0: number; x1: number; score: number }> = [];
  for (const c of candidates) {
    const prev = groups[groups.length - 1];
    if (prev && c.x <= prev.x1 + 2) { prev.x1 = c.x; prev.score = Math.max(prev.score, c.score); }
    else groups.push({ x0: c.x, x1: c.x, score: c.score });
  }
  const strong = groups.filter((g) => g.score >= 0.35);
  const chosen = (strong.length ? strong : groups).sort((a, b) => b.x1 - a.x1)[0];
  return chosen ? chosen.x1 + 1 : undefined;
}

export function rightFrameX(
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
  bin?: Uint8Array,
): number {
  const bars = borderRects
    .filter((r) => r.h > height * 0.35 && r.h > r.w * 4 && r.x + r.w > width * 0.5)
    .sort((a, b) => (b.x + b.w) - (a.x + a.w));
  const rectFrame = bars[0]?.x !== undefined ? bars[0].x + bars[0].w : undefined;
  if (bin) {
    const detectedFrame = detectRightFrameFromBinary(bin, width, height);
    // Keep the connected-component result when the binary image has no
    // reliable frame evidence (unit fixtures and faint scans), but replace a
    // stale/misaligned rect when a strong long border is visible in the image.
    if (detectedFrame !== undefined && (rectFrame === undefined || Math.abs(detectedFrame - rectFrame) > width * 0.025)) {
      return detectedFrame;
    }
  }
  return rectFrame ?? width * 0.84;
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
 * 左下页码专用定位：按横笔和垂直间距生成候选字框，不猜测具体汉字。
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
  // 预处理可能把细横笔断开；有页边墨迹时仍允许生成几何候选框。
  const hasPageInk = marginInkRatio(bin, width, height, frameX) >= 0.00008;
  if (!strokes.length) return chars;

  const xTol = Math.max(8, bodyTypicalH * 0.45);
  const cols: ComponentBox[][] = [];
  for (const stroke of [...strokes].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2))) {
    const cx = stroke.x + stroke.w / 2;
    const col = cols.find((items) => Math.abs(median(items.map((b) => b.x + b.w / 2)) - cx) <= xTol);
    if (col) col.push(stroke);
    else cols.push([stroke]);
  }

  const candidates: Array<{ x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }> = [];
  for (const col of cols) {
    const sorted = [...col].sort((a, b) => a.y - b.y);
    let group: ComponentBox[] = [sorted[0]];
    const emit = () => {
      if (group.length < 1) return;
      const x0 = Math.min(...group.map((b) => b.x));
      const x1 = Math.max(...group.map((b) => b.x + b.w));
      const inkY0 = Math.min(...group.map((b) => b.y));
      const inkY1 = Math.max(...group.map((b) => b.y + b.h));
      const cy = (inkY0 + inkY1) / 2;
      const pad = Math.max(2, bodyTypicalH * 0.12);
      candidates.push({ x0: x0 - pad, x1: x1 + pad, y0: inkY0 - pad, y1: inkY1 + pad, cx: (x0 + x1) / 2, cy });
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

  // 没有足够墨迹时不补写虚构字框，避免把空白边栏送入 OCR。
  if (!hasPageInk && candidates.length === 0) return chars;

  let out = chars.filter((c) => !(c.cx < frameX && c.cy > height * 0.58));
  for (const candidate of candidates) {
    const nearIndex = out.findIndex((c) => c.cx < frameX && Math.hypot(c.cx - candidate.cx, c.cy - candidate.cy) < bodyTypicalH * 0.65);
    const value: Partial<CharItem> = {
      text: null,
      cx: candidate.cx,
      cy: candidate.cy,
      bbox: [candidate.x0, candidate.y0, candidate.x1, candidate.y1],
      conf: 0,
      note: 'empty',
      source: 'manual',
      edited: false,
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

function bandInkFill(
  bin: Uint8Array,
  width: number,
  height: number,
  band: MarginBand,
): number {
  let ink = 0;
  const x0 = Math.max(0, Math.floor(band.x0));
  const x1 = Math.min(width, Math.ceil(band.x1));
  const y0 = Math.max(0, Math.floor(band.y0));
  const y1 = Math.min(height, Math.ceil(band.y1));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) ink += bin[y * width + x];
  }
  return ink / Math.max(1, (x1 - x0) * (y1 - y0));
}

function bandOverlapsRect(band: MarginBand, rect: Pick<TagRect, 'x' | 'y' | 'w' | 'h'>): boolean {
  return band.x0 < rect.x + rect.w && band.x1 > rect.x && band.y0 < rect.y + rect.h && band.y1 > rect.y;
}

/** 收紧到原图有效墨迹，避免投影带把周围留白一并带进校对框。 */
function tightInkBand(bin: Uint8Array, width: number, height: number, band: MarginBand): MarginBand | undefined {
  let x0 = Math.min(width, Math.ceil(band.x1));
  let x1 = Math.max(0, Math.floor(band.x0));
  let y0 = Math.min(height, Math.ceil(band.y1));
  let y1 = Math.max(0, Math.floor(band.y0));
  for (let y = Math.max(0, Math.floor(band.y0)); y < Math.min(height, Math.ceil(band.y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(band.x0)); x < Math.min(width, Math.ceil(band.x1)); x += 1) {
      if (!bin[y * width + x]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
    }
  }
  return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : undefined;
}

function inkBandsInStrip(
  bin: Uint8Array,
  width: number,
  height: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): MarginBand[] {
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
  return inkBandsInStrip(bin, width, height, x0, x1, Math.floor(height * fromRatio), Math.min(height, Math.ceil(height * toRatio)));
}

/** 间隙双峰分界：明显「字内小间隙 + 字间大间隙」时返回几何均值分界，否则 null。 */
function bimodalGapThreshold(gaps: number[]): number | null {
  if (gaps.length < 4) return null;
  const lo = Math.min(...gaps);
  const hi = Math.max(...gaps);
  if (hi - lo < 2) return null;
  let c1 = lo;
  let c2 = hi;
  for (let iter = 0; iter < 16; iter += 1) {
    let s1 = 0;
    let n1 = 0;
    let s2 = 0;
    let n2 = 0;
    for (const g of gaps) {
      if (Math.abs(g - c1) <= Math.abs(g - c2)) { s1 += g; n1 += 1; }
      else { s2 += g; n2 += 1; }
    }
    const next1 = n1 ? s1 / n1 : c1;
    const next2 = n2 ? s2 / n2 : c2;
    if (Math.abs(next1 - c1) < 0.5 && Math.abs(next2 - c2) < 0.5) { c1 = next1; c2 = next2; break; }
    c1 = next1;
    c2 = next2;
  }
  const low = Math.min(c1, c2);
  const high = Math.max(c1, c2);
  if (low <= 0 || high / low < 1.7) return null;
  return Math.sqrt(low * high);
}

/**
 * 把同一竖排标题列里因断笔产生的多个墨迹带合并为整字字框。
 * 带高已接近字宽（每带即整字）时不做合并；否则按「汉字≈方形」特性把带累加成整字：
 * 带间小隙归入同字（断笔字），累积高达到字宽且出现明显字间大隙才切到下一字。
 * 相比旧版的双峰间隙分界，对密集字（世/祖 单带）+ 断笔字（三 多带）混合列更稳健。
 */
function groupBandsIntoTitleChars(bands: MarginBand[]): MarginBand[] {
  if (bands.length <= 1) return bands.map((b) => ({ ...b }));
  const sorted = [...bands].sort((a, b) => a.y0 - b.y0);
  const minX = Math.min(...sorted.map((b) => b.x0));
  const maxX = Math.max(...sorted.map((b) => b.x1));
  const charW = Math.max(8, Math.min(400, maxX - minX));
  const medBandH = median(sorted.map((b) => b.y1 - b.y0)) || charW;
  if (medBandH >= charW * 0.6) return sorted.map((b) => ({ ...b }));

  const groups: MarginBand[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const band = sorted[i];
    const group = groups[groups.length - 1];
    const gap = band.y0 - group[group.length - 1].y1;
    const curH = group[group.length - 1].y1 - group[0].y0;
    // 当前组已近整字，且与下一带出现明显字间大隙 → 关字；否则并入（断笔字内部）
    if (curH >= charW * 0.85 && gap >= charW * 0.4) {
      groups.push([band]);
    } else {
      group.push(band);
    }
  }
  return groups.map((group) => ({
    y0: Math.min(...group.map((b) => b.y0)),
    y1: Math.max(...group.map((b) => b.y1)),
    x0: Math.min(...group.map((b) => b.x0)),
    x1: Math.max(...group.map((b) => b.x1)),
  }));
}

/**
 * 行投影会同时看到相邻竖列和断笔。先按 x 中心聚成竖列，再在列内合并断笔，
 * 最后选靠近页框且排列最稳定的一列，避免标题框跨到正文列或边框。
 */
function selectVerticalTitleColumn(
  bands: MarginBand[],
  edgeX: number,
  minChars: number,
): MarginBand[] {
  if (!bands.length) return [];
  const typicalWidth = median(bands.map((band) => band.x1 - band.x0)) || 12;
  const xTolerance = Math.max(8, typicalWidth * 1.25);
  const columns: MarginBand[][] = [];
  for (const band of [...bands].sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1))) {
    const cx = (band.x0 + band.x1) / 2;
    const column = columns.find((items) => (
      Math.abs(median(items.map((item) => (item.x0 + item.x1) / 2)) - cx) <= xTolerance
    ));
    if (column) column.push(band);
    else columns.push([band]);
  }

  const scored = columns
    .map((raw) => groupBandsIntoTitleChars(raw))
    .filter((glyphs) => glyphs.length >= minChars)
    .map((glyphs) => {
      const ordered = [...glyphs].sort((a, b) => a.y0 - b.y0);
      const centers = ordered.map((band) => (band.x0 + band.x1) / 2);
      const heights = ordered.map((band) => band.y1 - band.y0);
      const gaps = ordered.slice(1).map((band, index) => band.y0 - ordered[index].y1);
      const xSpread = Math.max(...centers) - Math.min(...centers);
      const medianHeight = Math.max(1, median(heights));
      const gapMedian = gaps.length ? median(gaps) : medianHeight;
      const gapError = gaps.length
        ? gaps.reduce((sum, gap) => sum + Math.abs(gap - gapMedian), 0) / gaps.length
        : 0;
      const columnX = median(centers);
      const edgeDistance = Math.abs(edgeX - columnX);
      const score = ordered.length * 100
        - (xSpread / medianHeight) * 18
        - (gapError / medianHeight) * 12
        - Math.max(0, edgeDistance) / Math.max(1, typicalWidth);
      return { ordered, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.ordered ?? [];
}

/**
 * 不依赖通用字符分割，直接从左页边原图投影重建书名与页码字框。
 * 这里不填充文字内容，交给正常 OCR/LLM 读取，避免把某一张样本的书名或页码带入新图片。
 */
export function rebuildLeftMarginTextRegions(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
  excludedRects: Array<Pick<TagRect, 'x' | 'y' | 'w' | 'h'>> = [],
): CharItem[] {
  const frameX = leftFrameX(width, height, borderRects);
  // 清空左外框区域已有框，避免旧分割碎片、书签图块和页码框混入。
  let out = chars.filter((c) => c.cx >= frameX - 2);

  // 书名/卷名不再写死内容。按左页边的竖向墨迹带推断字框，具体文字交给 OCR 或锚点模型。
  // 木刻标题单字由多条断笔组成：先把同一字的多个墨迹带合并成整字，避免「倪氏宗譜」被拆成碎片。
  const graphicTop = Math.min(
    height * 0.58,
    ...excludedRects
      .filter((rect) => rect.y > height * 0.14 && rect.x + rect.w <= frameX + 2)
      .map((rect) => Math.max(height * 0.04, rect.y - Math.max(3, height * 0.012))),
  );
  const titleBottom = Math.max(height * 0.18, graphicTop);
  const rawTitleBands = inkBandsInGutter(bin, width, height, frameX, 0.04, titleBottom / height)
    .filter((band) => {
      const bandH = band.y1 - band.y0;
      const bandW = band.x1 - band.x0;
      const aspect = Math.max(bandW, bandH) / Math.max(1, Math.min(bandW, bandH));
      return bandH >= Math.max(3, height * 0.006)
        && bandH <= height * 0.16
        && aspect <= 6
        // 木刻标题笔画可接近实心（细横/竖笔）；实心书签由 excludedRects（marginGraphics）排除。
        && bandInkFill(bin, width, height, band) < 0.96
        && !excludedRects.some((rect) => bandOverlapsRect(band, rect));
    });
  const selectedTitleBands = selectVerticalTitleColumn(rawTitleBands, frameX, 2);
  const tightTitleBands = selectedTitleBands.map((band) => tightInkBand(bin, width, height, band) ?? band);
  const fixedColumn = tightTitleBands.length === 4;
  const commonCx = fixedColumn ? median(tightTitleBands.map((band) => (band.x0 + band.x1) / 2)) : 0;
  const commonW = fixedColumn ? median(tightTitleBands.map((band) => band.x1 - band.x0)) : 0;
  const commonH = fixedColumn ? median(tightTitleBands.map((band) => band.y1 - band.y0)) : 0;
  for (const band of tightTitleBands) {
    const pad = Math.max(1, Math.min(2, (fixedColumn ? commonW : band.x1 - band.x0) * 0.04));
    const cx = fixedColumn ? commonCx : (band.x0 + band.x1) / 2;
    const cy = (band.y0 + band.y1) / 2;
    const halfW = fixedColumn ? commonW / 2 : (band.x1 - band.x0) / 2;
    const halfH = fixedColumn ? commonH / 2 : (band.y1 - band.y0) / 2;
    out.push({
      id: uuid(), text: null, cx, cy,
      bbox: [cx - halfW - pad, cy - halfH - pad, cx + halfW + pad, cy + halfH + pad],
      pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'title', kind: 'side',
    });
  }

  // 固定书名项目的低清扫描可能把四个字粘成一个连通域，或只留下一个
  // 可分割框。只要左边框内侧仍有标题墨迹，就按墨迹总高度均分四个等高
  // 字框；字号由实际高度决定，避免使用固定像素值。
  if (selectedTitleBands.length < 4) {
    const titleX0 = Math.max(0, Math.floor(frameX - Math.max(width * 0.12, 4 * (median(rawTitleBands.map((b) => b.x1 - b.x0)) || 12))));
    const titleX1 = Math.max(titleX0 + 1, Math.floor(frameX - Math.max(2, width * 0.006)));
    const ys: number[] = [];
    let inkX0 = titleX1;
    let inkX1 = titleX0;
    const y0 = Math.floor(height * 0.08);
    const y1 = Math.floor(titleBottom);
    for (let y = y0; y < y1; y += 1) {
      let rowInk = 0;
      let minInkX = titleX1;
      let maxInkX = titleX0;
      for (let x = titleX0; x < titleX1; x += 1) {
        if (!bin[y * width + x]) continue;
        rowInk += 1;
        minInkX = Math.min(minInkX, x);
        maxInkX = Math.max(maxInkX, x);
      }
      const inkSpan = maxInkX >= minInkX ? maxInkX - minInkX + 1 : 0;
      // 宽幅、近实心的行通常属于左侧书签/装饰块，不属于书名笔画。
      if (rowInk > 0 && inkSpan <= (titleX1 - titleX0) * 0.72 && rowInk < (titleX1 - titleX0) * 0.78) {
        ys.push(y);
        inkX0 = Math.min(inkX0, minInkX);
        inkX1 = Math.max(inkX1, maxInkX);
      }
    }
    if (ys.length >= 4) {
      // Replace incomplete segmentation with the four normalized boxes.
      out = out.filter((c) => !(c.group === 'title' && c.kind === 'side' && c.cx < frameX));
      const inkY0 = Math.min(...ys);
      const inkY1 = Math.max(...ys) + 1;
      const rawGlyphH = (inkY1 - inkY0) / 4;
      const referenceSide = median(
        chars
          .filter((char) => char.cx >= frameX && char.group !== 'pageno' && char.kind !== 'side')
          .map((char) => Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1])),
      ) || Math.max(12, Math.min(width, height) * 0.035);
      // Blue body boxes are the visual reference: title boxes may be taller
      // for vertical writing, but should not be wider than one body glyph.
      const glyphH = Math.min(rawGlyphH * 0.86, referenceSide * 1.2);
      if (glyphH >= Math.max(6, height * 0.018)) {
        // Use the actual book-title ink envelope, not the broader margin strip.
        // It keeps the red proofing boxes close to the glyphs while all four
        // titles retain one identical size and vertical alignment.
        const inkGlyphW = Math.max(6, inkX1 - inkX0 + 1);
        const cx = (inkX0 + inkX1 + 1) / 2;
        const glyphW = Math.min(inkGlyphW * 1.04, referenceSide * 0.46);
        for (let i = 0; i < 4; i += 1) {
          const cy = inkY0 + rawGlyphH * (i + 0.5);
          const pad = Math.max(1, Math.min(2, referenceSide * 0.02));
          out.push({
            id: uuid(), text: null, cx, cy,
            bbox: [cx - glyphW / 2 - pad, cy - glyphH / 2 - pad, cx + glyphW / 2 + pad, cy + glyphH / 2 + pad],
            pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'title', kind: 'side',
          });
        }
      }
    }
  }

  // 左页边书名为同字号的竖排标题。无论上游来自逐字分割还是粘连兜底，
  // 最终都按同一中心线和同一框尺寸写回，避免笔画更密的「譜」得到不同大小。
  const marginTitleChars = out
    .filter((c) => c.group === 'title' && c.kind === 'side' && c.cx < frameX)
    .sort((a, b) => a.cy - b.cy)
    // The left book title is the uppermost title column; a false graphic
    // boundary must not leave its fourth glyph outside the normalization.
    .slice(0, 4);
  if (marginTitleChars.length === 4) {
    const boxW = median(marginTitleChars.map((c) => c.bbox[2] - c.bbox[0]));
    const boxH = median(marginTitleChars.map((c) => c.bbox[3] - c.bbox[1]));
    const columnX = median(marginTitleChars.map((c) => c.cx));
    const ids = new Set(marginTitleChars.map((c) => c.id));
    out = out.map((c) => {
      if (!ids.has(c.id)) return c;
      return {
        ...c,
        cx: columnX,
        bbox: [columnX - boxW / 2, c.cy - boxH / 2, columnX + boxW / 2, c.cy + boxH / 2],
      };
    });
  }

  // 页码/卷次只定位字框，不根据笔画数量猜「一/二/三」。页码常是
  // 「二十」这类横笔很多的大字：不能把每一横当成一个字符框，也不能
  // 让书签、左外框的残墨参与行投影。
  const bodySide = median(
    chars
      .filter((char) => char.cx >= frameX && char.group !== 'pageno')
      .map((char) => Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1])),
  ) || Math.max(12, Math.min(width, height) * 0.035);
  const x0 = Math.max(0, Math.floor(frameX * 0.08));
  const x1 = Math.max(x0 + 1, Math.floor(frameX - Math.max(3, width * 0.004)));
  const lastMarginGraphicBottom = Math.max(
    height * 0.56,
    ...excludedRects
      .filter((rect) => rect.x < frameX && rect.y + rect.h > height * 0.28)
      .map((rect) => rect.y + rect.h + bodySide * 0.35),
  );
  const pageY0 = Math.min(Math.floor(height * 0.9), Math.floor(lastMarginGraphicBottom));
  const pageY1 = Math.floor(height * 0.96);
  const isExcluded = (x: number, y: number) => excludedRects.some((rect) => (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  ));

  // 先切出笔画带。连续的竖笔（如「十」）会是一整带；「二」的两横
  // 保持为两条带，在下一步按同列和字高合并。
  const strokeBands: MarginBand[] = [];
  const inkRows: number[] = [];
  for (let y = pageY0; y < pageY1; y += 1) {
    let minX = x1;
    let maxX = x0;
    for (let x = x0; x < x1; x += 1) {
      if (!bin[y * width + x] || isExcluded(x, y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    // 页面外框和偶发污点不足以构成页码笔画；页码的横笔至少有正文
    // 单字宽度的四分之一。
    if (maxX >= minX && maxX - minX + 1 >= Math.max(4, bodySide * 0.24)) inkRows.push(y);
  }
  if (!inkRows.length) return out;

  const strokeGap = Math.max(1, Math.round(bodySide * 0.12));
  let bandY0 = inkRows[0];
  let previousRow = inkRows[0];
  const emitStrokeBand = (y0: number, y1: number) => {
    let minX = x1;
    let maxX = x0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!bin[y * width + x] || isExcluded(x, y)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    if (maxX >= minX) strokeBands.push({ x0: minX, x1: maxX + 1, y0, y1 });
  };
  for (let i = 1; i < inkRows.length; i += 1) {
    if (inkRows[i] - previousRow <= strokeGap) previousRow = inkRows[i];
    else {
      emitStrokeBand(bandY0, previousRow + 1);
      bandY0 = inkRows[i];
      previousRow = inkRows[i];
    }
  }
  emitStrokeBand(bandY0, previousRow + 1);

  const usableStrokes = strokeBands.filter((band) => {
    const bandW = band.x1 - band.x0;
    const bandH = band.y1 - band.y0;
    return bandW >= Math.max(4, bodySide * 0.24)
      && bandW <= Math.max(bodySide * 2.5, (x1 - x0) * 0.92)
      && bandH <= bodySide * 1.8;
  });
  if (!usableStrokes.length) return out;

  // 页码只保留书签下方最稳定的一列。先按 x 中心聚列，再把同字内的
  // 多条横笔合并；「二」「三」不会再生成数个只有横线高度的图形框。
  const columnTolerance = Math.max(6, bodySide * 0.7);
  const columns: MarginBand[][] = [];
  for (const band of [...usableStrokes].sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1))) {
    const cx = (band.x0 + band.x1) / 2;
    const column = columns.find((items) => Math.abs(median(items.map((item) => (item.x0 + item.x1) / 2)) - cx) <= columnTolerance);
    if (column) column.push(band);
    else columns.push([band]);
  }
  const pageColumns = columns.map((column) => {
    const ordered = [...column].sort((a, b) => a.y0 - b.y0);
    const glyphs: MarginBand[] = [];
    let current = { ...ordered[0] };
    for (let i = 1; i < ordered.length; i += 1) {
      const next = ordered[i];
      const gap = next.y0 - current.y1;
      const currentH = current.y1 - current.y0;
      const mergedH = next.y1 - current.y0;
      const horizontalOverlap = Math.max(0, Math.min(current.x1, next.x1) - Math.max(current.x0, next.x0));
      const sameGlyph = gap <= bodySide * 0.98
        && mergedH <= bodySide * 1.55
        && horizontalOverlap >= Math.min(current.x1 - current.x0, next.x1 - next.x0) * 0.42
        // A tall existing band is normally a complete character such as「十」;
        // do not attach the next page digit to it.
        && currentH < bodySide * 0.82;
      if (sameGlyph) {
        current = {
          x0: Math.min(current.x0, next.x0), x1: Math.max(current.x1, next.x1),
          y0: current.y0, y1: next.y1,
        };
      } else {
        glyphs.push(current);
        current = { ...next };
      }
    }
    glyphs.push(current);
    const widthScore = median(glyphs.map((band) => band.x1 - band.x0)) / Math.max(1, bodySide);
    return { glyphs, score: glyphs.length * 4 + Math.min(2, widthScore) };
  }).filter((entry) => entry.glyphs.length <= 4)
    .sort((a, b) => b.score - a.score);
  const pageGlyphs = pageColumns[0]?.glyphs ?? [];
  if (!pageGlyphs.length) return out;

  // 页码是同一字号的竖排大字。收紧到墨迹后统一中心线和方形框，既给
  // OCR 留出完整字形，又防止「二」被画成几条细小的图形框。
  const columnX = median(pageGlyphs.map((band) => (band.x0 + band.x1) / 2));
  const pageGlyphSide = Math.max(
    bodySide * 0.55,
    Math.min(bodySide * 2.2, (median(pageGlyphs.map((band) => Math.max(band.x1 - band.x0, band.y1 - band.y0))) || bodySide) * 1.16),
  );
  for (const glyph of pageGlyphs) {
    const cy = (glyph.y0 + glyph.y1) / 2;
    out.push({
      id: uuid(), text: null, cx: columnX, cy,
      bbox: [columnX - pageGlyphSide / 2, cy - pageGlyphSide / 2, columnX + pageGlyphSide / 2, cy + pageGlyphSide / 2],
      pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'pageno', kind: 'side',
    });
  }
  return out;
}

/**
 * 右页边竖排标题重建：从右外框内侧窄带补回右侧大字标题（世次/卷次，如「三世祖」「卷二」）。
 * 内容无关：只按字方性与列几何推断字框，字数自适应（2–8），不绑定任何样本标题。
 * 保留已正确分割的正文与右侧非标题字符。
 */
export function rebuildRightMarginTextRegions(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  borderRects: Array<Pick<BorderRect, 'x' | 'y' | 'w' | 'h'>>,
  excludedRects: Array<Pick<TagRect, 'x' | 'y' | 'w' | 'h'>> = [],
): CharItem[] {
  const frameX = rightFrameX(width, height, borderRects, bin);
  const bodySide = median(
    chars
      .filter((char) => char.kind !== 'side' && char.group !== 'pageno')
      .map((char) => Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1])),
  ) || Math.max(12, Math.min(width, height) * 0.035);
  const innerGap = Math.max(3, width * 0.004);
  const bandWidth = Math.max(width * 0.12, bodySide * 5);
  // 「三世祖」位于右外框内侧。只移除这条窄带中的旧标题碎片，正文其余区域保持不变。
  const x0 = Math.max(0, Math.floor(frameX - bandWidth));
  const x1 = Math.min(width, Math.floor(frameX - innerGap));
  if (x1 - x0 < 12) return chars;
  // 版面阶段（markRightEdgeTitleColumn）已把右缘大字竖列标成 title 时，直接保留其良构字框；
  // 不再用行投影窄带重建——否则会把已对齐的好框替换成可能错位的窄带框，甚至重建失败时整列丢失。
  const existingTitle = chars.filter(
    (c) => c.group === 'title' && c.cx >= x0 && c.cx <= frameX + 2 && c.cy <= height * 0.64,
  );
  if (existingTitle.length >= 2) {
    return chars.filter((c) => c.group === 'title' || c.cx < x0 || c.cx > frameX + 2 || c.cy > height * 0.64);
  }
  // 右缘标题窄带内的旧分割框可能仍被标成 body（例如三根竖笔合成的噪声框），
  // 不能只按 group=title 清理，否则旧噪声会与新标题框叠加显示并再次送入 OCR。
  let out = chars.filter((c) => !(
    c.cx >= x0
    && c.cx <= frameX + 2
    && c.cy <= height * 0.64
  ));
  const rawBands = inkBandsInStrip(
    bin,
    width,
    height,
    x0,
    x1,
    Math.floor(height * 0.04),
    Math.floor(height * 0.62),
  ).filter((band) => {
    const bandH = band.y1 - band.y0;
    const bandW = band.x1 - band.x0;
    const aspect = Math.max(bandW, bandH) / Math.max(1, Math.min(bandW, bandH));
    const sparseBand = bandInkFill(bin, width, height, band) < 0.96;
    const compactDenseStroke = bandW <= bodySide * 0.7 && bandH <= bodySide * 2.4;
    return bandH >= Math.max(3, height * 0.006)
      && bandH <= height * 0.16
      && aspect <= 6
      && (sparseBand || compactDenseStroke)
      && !excludedRects.some((rect) => bandOverlapsRect(band, rect));
  });

  // 自适应字数（2–8）而非写死「三字」，兼容「二世祖」「卷次」等不同世次标题；
  // 整列字框统一宽度并居中对齐到公共中心 x，避免不同宽字导致框列错位，影响识别与填充。
  const titleGlyphs = selectVerticalTitleColumn(rawBands, frameX, 2);
  if (titleGlyphs.length > 0) {
    const columnX = median(titleGlyphs.map((b) => (b.x0 + b.x1) / 2));
    const colHalfW = Math.max(...titleGlyphs.map((b) => (b.x1 - b.x0) / 2));
    for (const band of titleGlyphs) {
      const pad = Math.max(2, colHalfW * 0.16);
      out.push({
        id: uuid(), text: null,
        cx: columnX,
        cy: (band.y0 + band.y1) / 2,
        bbox: [Math.round(columnX - colHalfW - pad), band.y0 - pad, Math.round(columnX + colHalfW + pad), band.y1 + pad],
        pt: 0, conf: 0, note: 'empty', source: 'manual', edited: false, group: 'title', kind: 'side',
      });
    }
  }
  return out;
}
