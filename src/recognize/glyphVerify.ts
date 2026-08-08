/**
 * S5 字形回验：render-and-compare，用目标字体渲染候选字并与原图切片的像素比对。
 * 模型/OCR 只产出候选，最终置信度由 IoU + 倒角距离 + 投影相关加权决定。
 */
import { cropBinary } from '@/imaging/raster';
import { scaleCoverage } from '@/segment/grid';
import { PREVIEW_FONT_FAMILY } from '@/verify/preview';
import type { CharItem, CharNote } from '@/model/types';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';

export const GLYPH_NORMALIZE_SIZE = 64;

/** 族谱高频形近字混淆组（PDF S5.4） */
export const GLYPH_CONFUSION_GROUPS: readonly string[][] = [
  ['倪', '倮', '倩'],
  ['遷', '遞', '邁', '遴'],
  ['為', '爲'],
  ['子', '孓', '孑'],
  ['銘', '銭', '銅'],
  ['宗', '崇'],
  ['庭', '延'],
  ['譜', '溥'],
  ['己', '已', '巳'],
  ['土', '士'],
  ['戌', '戍', '戊'],
  ['未', '末'],
  ['王', '玉'],
  ['日', '曰'],
  ['人', '入'],
  ['大', '太', '天'],
  ['干', '千', '于'],
  ['申', '甲', '由'],
];

const CONFUSION_LOOKUP = new Map<string, string[]>();
for (const group of GLYPH_CONFUSION_GROUPS) {
  for (const ch of group) {
    const peers = group.filter((value) => value !== ch);
    CONFUSION_LOOKUP.set(ch, [...new Set([...(CONFUSION_LOOKUP.get(ch) ?? []), ...peers])]);
  }
}

/** 紧裁 → 补方 → 缩放到 64×64 → 再二值化 */
export function normalizeGlyphBitmap(data: Uint8Array, width: number, height: number, size = GLYPH_NORMALIZE_SIZE): Uint8Array {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!data[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return new Uint8Array(size * size);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const side = Math.max(cropW, cropH);
  const padded = new Uint8Array(side * side);
  const offX = Math.floor((side - cropW) / 2);
  const offY = Math.floor((side - cropH) / 2);
  for (let y = 0; y < cropH; y += 1) {
    for (let x = 0; x < cropW; x += 1) {
      if (data[(minY + y) * width + (minX + x)]) padded[(offY + y) * side + (offX + x)] = 1;
    }
  }
  const scaled = scaleCoverage(padded, side, side, size, size);
  const out = new Uint8Array(size * size);
  for (let i = 0; i < scaled.length; i += 1) out[i] = scaled[i] >= 128 ? 1 : 0;
  return out;
}

export function bitmapIoU(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) inter += 1;
    if (a[i] || b[i]) union += 1;
  }
  return union > 0 ? inter / union : 0;
}

/** 对称倒角距离（归一化到 0..1，越小越像） */
export function bitmapChamferNorm(a: Uint8Array, b: Uint8Array, size: number): number {
  if (a.length !== b.length) return 1;
  const distA = distanceTransform(a, size);
  const distB = distanceTransform(b, size);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]) {
      sum += distB[i];
      count += 1;
    }
    if (b[i]) {
      sum += distA[i];
      count += 1;
    }
  }
  if (count === 0) return 1;
  return Math.min(1, sum / count / (size * 0.35));
}

function distanceTransform(bin: Uint8Array, size: number): Float32Array {
  const dist = new Float32Array(bin.length);
  const maxD = size * 2;
  for (let i = 0; i < bin.length; i += 1) dist[i] = bin[i] ? 0 : maxD;
  // 两遍扫描近似 EDT
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[i - size] + 1);
    }
  }
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = size - 1; x >= 0; x -= 1) {
      const i = y * size + x;
      if (x + 1 < size) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y + 1 < size) dist[i] = Math.min(dist[i], dist[i + size] + 1);
    }
  }
  return dist;
}

export function projectionCorrelation(a: Uint8Array, b: Uint8Array, size: number): number {
  const rowA = new Float32Array(size);
  const rowB = new Float32Array(size);
  const colA = new Float32Array(size);
  const colB = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = a[y * size + x];
      rowA[y] += v;
      colA[x] += v;
      rowB[y] += b[y * size + x];
      colB[x] += b[y * size + x];
    }
  }
  const rowCorr = pearson(rowA, rowB);
  const colCorr = pearson(colA, colB);
  return (rowCorr + colCorr) / 2;
}

function pearson(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? Math.max(-1, Math.min(1, num / den)) : 0;
}

export function scoreGlyphMatch(patch: Uint8Array, rendered: Uint8Array): number {
  const iou = bitmapIoU(patch, rendered);
  const chamfer = bitmapChamferNorm(patch, rendered, GLYPH_NORMALIZE_SIZE);
  const proj = projectionCorrelation(patch, rendered, GLYPH_NORMALIZE_SIZE);
  return 0.45 * iou + 0.35 * (1 - chamfer) + 0.2 * Math.max(0, proj);
}

const renderCache = new Map<string, Uint8Array>();

/** 用校对字体把单字渲染为归一化位图（浏览器环境） */
export function renderCharGlyphBitmap(ch: string, fontPx = 48): Uint8Array | null {
  if (typeof document === 'undefined') return null;
  const key = `${ch}:${fontPx}`;
  const cached = renderCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_NORMALIZE_SIZE * 2;
  canvas.height = GLYPH_NORMALIZE_SIZE * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = `500 ${fontPx}px ${PREVIEW_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, canvas.width / 2, canvas.height / 2);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const raw = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < raw.length; i += 4, j += 1) raw[j] = img.data[i] < 128 ? 1 : 0;
  const normalized = normalizeGlyphBitmap(raw, canvas.width, canvas.height);
  renderCache.set(key, normalized);
  return normalized;
}

export function expandGlyphCandidates(primary: string | null, extras: string[] = []): string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value || [...value].length !== 1) return;
    if (!out.includes(value)) out.push(value);
  };
  add(primary);
  for (const value of extras) add(value);
  for (const value of [...out]) {
    for (const peer of CONFUSION_LOOKUP.get(value) ?? []) add(peer);
  }
  return out.slice(0, 8);
}

export interface GlyphVerifyInput {
  primary: string | null;
  modelConfidence: number;
  candidates?: string[];
  routeVotes?: number;
}

export interface GlyphVerifyResult {
  text: string | null;
  confidence: number;
  note: CharNote;
  candidates: string[];
  topScore: number;
  margin: number;
}

export function cropCharPatch(
  char: Pick<CharItem, 'bbox'>,
  bin: Uint8Array,
  width: number,
  height: number,
): { data: Uint8Array; w: number; h: number } | null {
  const [x0, y0, x1, y1] = char.bbox;
  const side = Math.max(x1 - x0, y1 - y0);
  const pad = Math.max(2, Math.round(side * 0.15));
  const crop = cropBinary(bin, width, height, x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
  if (crop.width <= 0 || crop.height <= 0) return null;
  return { data: crop.data, w: crop.width, h: crop.height };
}

/** 对单字候选集做字形回验并重算置信度 */
export function verifyGlyphCandidates(
  patchNorm: Uint8Array,
  input: GlyphVerifyInput,
): GlyphVerifyResult {
  const candidates = expandGlyphCandidates(input.primary, input.candidates ?? []);
  if (candidates.length === 0) {
    return { text: null, confidence: 0, note: 'empty', candidates: [], topScore: 0, margin: 0 };
  }
  const scored = candidates
    .map((ch) => {
      const rendered = renderCharGlyphBitmap(ch);
      if (!rendered) return { ch, score: ch === input.primary ? input.modelConfidence : 0 };
      return { ch, score: scoreGlyphMatch(patchNorm, rendered) };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const margin = top && second ? top.score - second.score : top?.score ?? 0;
  const agree = input.routeVotes ?? (input.primary === top?.ch ? 1 : 0);
  const agreeFactor = 0.5 + 0.5 * Math.min(1, agree / 3);
  const marginFactor = margin > 0.06 ? 1 : margin <= 0.03 ? 0.7 : 0.85;
  let confidence = (top?.score ?? 0) * agreeFactor * marginFactor;
  confidence = Math.max(0, Math.min(1, confidence));

  let note: CharNote = 'ok';
  if (!top?.ch) note = 'empty';
  else if (confidence < 0.75 || margin <= 0.03) note = 'blurry';
  else if (confidence < CONFIDENCE_THRESHOLD) note = 'blurry';

  return {
    text: top?.ch ?? null,
    confidence,
    note,
    candidates: scored.slice(0, 3).map((item) => item.ch),
    topScore: top?.score ?? 0,
    margin,
  };
}

/** 批量字形回验（识别管线末尾调用） */
export function applyGlyphVerification(
  chars: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  drafts: Map<string, GlyphVerifyInput>,
): CharItem[] {
  return chars.map((char) => {
    const draft = drafts.get(char.id);
    if (!draft) return char;
    const patch = cropCharPatch(char, bin, width, height);
    if (!patch) return char;
    const patchNorm = normalizeGlyphBitmap(patch.data, patch.w, patch.h);
    const verified = verifyGlyphCandidates(patchNorm, draft);
    const keepText = verified.text ?? draft.primary;
    return {
      ...char,
      text: keepText,
      conf: verified.confidence,
      note: verified.note,
    };
  });
}
