/**
 * 识别填充管线：锚点匹配 → 写入 patch → 原图一比一校验 → 字形回验。
 * orchestrator 识别出 patch 后统一经此模块落字，保证位置与填充一致。
 */
import { anchorMatchConfidence, mapAnchoredItemsById, normalizeAnchoredPageItems } from '@/recognize/anchorMatch';
import { isCjkGlyph, isValidChar, sanitizeCharOutput } from '@/recognize/prompt';
import { postprocessItems } from '@/recognize/postprocess';
import type { GlyphVerifyInput } from '@/recognize/glyphVerify';
import { finalizeRecognitionFill } from '@/verify/alignment';
import type { CharItem } from '@/model/types';
import type { RecognizedPageItem } from './types';

/** Mode C 锚点结果写入 patch（严格 id → 字框 一对一） */
export function fillFromAnchoredItems(
  items: RecognizedPageItem[],
  chars: CharItem[],
  skipIds: Set<string>,
  patch: Map<string, Partial<CharItem>>,
  glyphDrafts: Map<string, GlyphVerifyInput>,
  widthPx: number,
  heightPx: number,
  strictConsensus = false,
): number {
  const processed = (postprocessItems(items, { isGenealogy: true, strictConsensus }) as RecognizedPageItem[]).map((it) => {
    const cleaned = sanitizeCharOutput(it.char, it.note);
    return { ...it, char: cleaned.char, note: cleaned.note };
  });
  const matched = mapAnchoredItemsById(processed, chars, skipIds, widthPx, heightPx);
  let applied = 0;

  for (const [charId, item] of matched) {
    if (!item.char || item.confidence < 0.5) continue;
    if (!isValidChar(item.char, item.note)) continue;
    const charIndex = item.id;
    const char = chars[charIndex];
    if (!char || char.id !== charId) continue;

    const conf = anchorMatchConfidence(item, char, charIndex, widthPx, heightPx);
    if (conf < 0.45) continue;
    patch.set(charId, {
      text: item.char,
      conf,
      note: item.note ?? 'ok',
      source: 'llm',
    });
    glyphDrafts.set(charId, {
      primary: item.char,
      modelConfidence: conf,
      candidates: (item.candidates ?? []).filter(isCjkGlyph),
      routeVotes: 1,
    });
    applied += 1;
  }
  return applied;
}

/** 将 patch 合并到字表并完成原图校验填充 */
export function applyRecognitionPatch(
  pageChars: CharItem[],
  patch: Map<string, Partial<CharItem>>,
  glyphDrafts: Map<string, GlyphVerifyInput>,
  bin: Uint8Array,
  width: number,
  height: number,
): CharItem[] {
  const merged = pageChars.map((c) => {
    const p = patch.get(c.id);
    return p ? { ...c, ...p } : c;
  });
  return finalizeRecognitionFill(merged, bin, width, height, glyphDrafts);
}
