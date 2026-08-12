/**
 * 锚点填字：Mode C 严格 id → 字框 一对一映射（items[id] → chars[id]）。
 */
import { estimateCharSide } from '@/segment/columns';
import type { CharItem } from '@/model/types';
import type { RecognizedPageItem } from './types';

export interface AnchorMatchOptions {
  widthPx: number;
  heightPx: number;
}

function itemCoordsValid(item: RecognizedPageItem): boolean {
  if (!Number.isFinite(item.rx) || !Number.isFinite(item.ry)) return false;
  return item.rx > 0.0005 || item.ry > 0.0005;
}

function distPx(
  item: RecognizedPageItem,
  char: CharItem,
  widthPx: number,
  heightPx: number,
): number {
  return Math.hypot(item.rx * widthPx - char.cx, item.ry * heightPx - char.cy);
}

function charSide(char: CharItem): number {
  return Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1], 12);
}

/** 模型 rx/ry 是否落在该 id 锚点附近（视为已原样复制 anchors） */
export function isCoordAtAnchor(
  item: RecognizedPageItem,
  charIndex: number,
  chars: CharItem[],
  widthPx: number,
  heightPx: number,
): boolean {
  if (charIndex < 0 || charIndex >= chars.length) return false;
  const anchor = chars[charIndex];
  return distPx(item, anchor, widthPx, heightPx) <= charSide(anchor) * 0.32;
}

/** 模型坐标偏离锚点过远时，回填锚点坐标供匹配（防止模型乱写 rx/ry） */
export function normalizeAnchoredPageItems(
  items: RecognizedPageItem[],
  chars: CharItem[],
  widthPx: number,
  heightPx: number,
): RecognizedPageItem[] {
  const side = estimateCharSide(chars);
  const maxDrift = Math.max(side * 1.6, 16);

  return items.map((item) => {
    const idx = item.id;
    if (idx < 0 || idx >= chars.length) return item;
    const anchor = chars[idx];
    const drift = distPx(item, anchor, widthPx, heightPx);
    if (drift > maxDrift) {
      return {
        ...item,
        rx: Math.round((anchor.cx / widthPx) * 10000) / 10000,
        ry: Math.round((anchor.cy / heightPx) * 10000) / 10000,
      };
    }
    return item;
  });
}

/** 将模型输出规范为 anchors[id] 坐标，并按 id 一对一映射到字框 */
export function mapAnchoredItemsById(
  items: RecognizedPageItem[],
  chars: CharItem[],
  skipIds: Set<string>,
  widthPx: number,
  heightPx: number,
): Map<string, RecognizedPageItem> {
  const normalized = normalizeAnchoredPageItems(items, chars, widthPx, heightPx);
  const bestByIndex = new Map<number, RecognizedPageItem>();

  for (const item of normalized) {
    const idx = item.id;
    if (idx < 0 || idx >= chars.length) continue;
    const prev = bestByIndex.get(idx);
    if (!prev || (item.confidence ?? 0) > (prev.confidence ?? 0)) {
      const anchor = chars[idx];
      bestByIndex.set(idx, {
        ...item,
        id: idx,
        rx: Math.round((anchor.cx / widthPx) * 10000) / 10000,
        ry: Math.round((anchor.cy / heightPx) * 10000) / 10000,
      });
    }
  }

  const result = new Map<string, RecognizedPageItem>();
  for (let idx = 0; idx < chars.length; idx += 1) {
    const char = chars[idx];
    if (skipIds.has(char.id)) continue;
    const item = bestByIndex.get(idx);
    if (item) result.set(char.id, item);
  }
  return result;
}

type Edge = {
  item: RecognizedPageItem;
  char: CharItem;
  charIndex: number;
  dist: number;
};

function greedyAssign(edges: Edge[]): Map<string, RecognizedPageItem> {
  edges.sort((a, b) => {
    const d = a.dist - b.dist;
    if (Math.abs(d) > 0.2) return d;
    return (b.item.confidence ?? 0) - (a.item.confidence ?? 0);
  });

  const result = new Map<string, RecognizedPageItem>();
  const usedChars = new Set<string>();
  const usedItems = new Set<RecognizedPageItem>();

  for (const edge of edges) {
    if (usedChars.has(edge.char.id) || usedItems.has(edge.item)) continue;
    result.set(edge.char.id, edge.item);
    usedChars.add(edge.char.id);
    usedItems.add(edge.item);
  }
  return result;
}

/** @deprecated 仅测试/非锚点场景；Mode C 锚点填字请用 mapAnchoredItemsById */
export function matchAnchoredItemsToChars(
  items: RecognizedPageItem[],
  chars: CharItem[],
  skipIds: Set<string>,
  opts: AnchorMatchOptions,
): Map<string, RecognizedPageItem> {
  const { widthPx, heightPx } = opts;
  const eligible = chars
    .map((char, index) => ({ char, index }))
    .filter(({ char }) => !skipIds.has(char.id));
  if (eligible.length === 0 || items.length === 0) return new Map();

  const normalized = normalizeAnchoredPageItems(items, chars, widthPx, heightPx);
  const result = new Map<string, RecognizedPageItem>();
  const usedItems = new Set<RecognizedPageItem>();
  const usedCharIds = new Set<string>();

  for (const item of normalized) {
    if (!item.char) continue;
    const idx = item.id;
    if (idx < 0 || idx >= chars.length) continue;
    const char = chars[idx];
    if (skipIds.has(char.id)) continue;
    if (!isCoordAtAnchor(item, idx, chars, widthPx, heightPx)) continue;
    result.set(char.id, item);
    usedItems.add(item);
    usedCharIds.add(char.id);
  }

  const charSideEst = estimateCharSide(eligible.map(({ char }) => char));
  const maxDist = Math.max(charSideEst * 0.52, 11);
  const idBonus = charSideEst * 0.12;
  const edges: Edge[] = [];

  for (const item of normalized) {
    if (!item.char || usedItems.has(item)) continue;
    for (const { char, index } of eligible) {
      if (usedCharIds.has(char.id)) continue;
      if (!itemCoordsValid(item)) {
        if (item.id !== index) continue;
        const dist = distPx(item, char, widthPx, heightPx);
        if (dist > maxDist * 1.5) continue;
        edges.push({ item, char, charIndex: index, dist });
        continue;
      }
      const dist = distPx(item, char, widthPx, heightPx);
      if (dist > maxDist) continue;
      const bonus = item.id === index ? -idBonus : 0;
      edges.push({ item, char, charIndex: index, dist: dist + bonus });
    }
  }

  for (const [charId, item] of greedyAssign(edges)) {
    if (!result.has(charId)) {
      result.set(charId, item);
    }
  }
  return result;
}

/** 填字置信度：坐标偏差越大、id 不一致，置信越低 */
export function anchorMatchConfidence(
  item: RecognizedPageItem,
  char: CharItem,
  charIndex: number,
  widthPx: number,
  heightPx: number,
): number {
  let conf = item.confidence;
  const dist = distPx(item, char, widthPx, heightPx);
  const charSide = Math.max(
    char.bbox[2] - char.bbox[0],
    char.bbox[3] - char.bbox[1],
    12,
  );

  if (item.id !== charIndex) {
    conf = Math.min(conf, conf * 0.9);
  }
  if (dist > charSide * 0.2) {
    conf = Math.min(conf, conf * (1 - Math.min(0.35, (dist - charSide * 0.2) / charSide)));
  }
  if (dist > charSide * 0.48) {
    conf = Math.min(conf, 0.55);
  }
  return conf;
}

/** 校验锚点识别输出：按 id 索引，缺失 id 保留空位 */
export function canonicalizeAnchoredPageItems(
  items: RecognizedPageItem[],
  charCount: number,
): RecognizedPageItem[] {
  const byId = new Map<number, RecognizedPageItem>();
  for (const item of items) {
    if (item.id < 0 || item.id >= charCount) continue;
    const prev = byId.get(item.id);
    if (!prev || (item.confidence ?? 0) >= (prev.confidence ?? 0)) {
      byId.set(item.id, item);
    }
  }
  const out: RecognizedPageItem[] = [];
  for (let id = 0; id < charCount; id += 1) {
    const hit = byId.get(id);
    if (hit) {
      out.push({ ...hit, id });
    } else {
      out.push({ id, char: null, confidence: 0, rx: 0, ry: 0, note: 'empty' });
    }
  }
  return out;
}
