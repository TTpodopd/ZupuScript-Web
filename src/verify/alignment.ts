/**
 * 原图一比一定位校验：字框/字心必须与原图墨迹对齐；识别填充需通过位置+字形双重校验。
 */
import { inkMetricsInBbox, refineAllCharBoxes, refineCharBoxToInk } from '@/imaging/ink';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { CharItem } from '@/model/types';
import { isCjkGlyph } from '@/recognize/prompt';
import {
  applyGlyphVerification,
  cropCharPatch,
  normalizeGlyphBitmap,
  type GlyphVerifyInput,
  verifyGlyphCandidates,
} from '@/recognize/glyphVerify';

export interface CharAlignmentScore {
  offsetPx: number;
  fillRatio: number;
  inkArea: number;
  aligned: boolean;
}

export interface PageAlignmentStats {
  total: number;
  aligned: number;
  avgOffsetPx: number;
  lowInk: number;
}

const MIN_INK_AREA = 6;
const MIN_FILL = 0.05;
const MAX_OFFSET_RATIO = 0.22;

export function scoreCharAlignment(
  char: CharItem,
  bin: Uint8Array,
  pageW: number,
  pageH: number,
): CharAlignmentScore {
  const metrics = inkMetricsInBbox(bin, pageW, pageH, char.bbox);
  if (!metrics) {
    return { offsetPx: Infinity, fillRatio: 0, inkArea: 0, aligned: false };
  }
  const side = Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1], 10);
  const offsetPx = Math.hypot(char.cx - metrics.inkCx, char.cy - metrics.inkCy);
  const aligned =
    offsetPx <= side * MAX_OFFSET_RATIO
    && metrics.fillRatio >= MIN_FILL
    && metrics.inkArea >= MIN_INK_AREA;
  return {
    offsetPx,
    fillRatio: metrics.fillRatio,
    inkArea: metrics.inkArea,
    aligned,
  };
}

/** 分析阶段：锁定字框到原图墨迹并标记未对齐项 */
export function validateAndRefineCharPositions(
  chars: CharItem[],
  bin: Uint8Array,
  pageW: number,
  pageH: number,
): { chars: CharItem[]; stats: PageAlignmentStats } {
  const refined = refineAllCharBoxes(chars, bin, pageW, pageH);
  let aligned = 0;
  let lowInk = 0;
  let offsetSum = 0;

  const out = refined.map((char) => {
    const score = scoreCharAlignment(char, bin, pageW, pageH);
    offsetSum += Number.isFinite(score.offsetPx) ? score.offsetPx : 0;
    if (score.aligned) {
      aligned += 1;
      return char;
    }
    if (score.inkArea < MIN_INK_AREA || score.fillRatio < MIN_FILL) {
      lowInk += 1;
      return { ...char, note: 'empty' as const, conf: 0 };
    }
    return {
      ...char,
      note: 'spacing' as const,
      conf: Math.min(char.conf, CONFIDENCE_THRESHOLD - 0.02),
    };
  });

  return {
    chars: out,
    stats: {
      total: chars.length,
      aligned,
      avgOffsetPx: chars.length > 0 ? offsetSum / chars.length : 0,
      lowInk,
    },
  };
}

/** 识别填充校验：位置锁定 + 字形回验 + 不合格则清空文字 */
export function finalizeRecognitionFill(
  chars: CharItem[],
  bin: Uint8Array,
  pageW: number,
  pageH: number,
  glyphDrafts: Map<string, GlyphVerifyInput>,
): CharItem[] {
  let result = refineAllCharBoxes(chars, bin, pageW, pageH);

  if (glyphDrafts.size > 0 && typeof document !== 'undefined') {
    result = applyGlyphVerification(result, bin, pageW, pageH, glyphDrafts);
  }

  return result.map((char) => {
    const locked = refineCharBoxToInk(char, bin, pageW, pageH);
    const score = scoreCharAlignment(locked, bin, pageW, pageH);

    // 最终安全网：字框只允许 CJK 汉字，字母/数字/标点/符号一律清空
    if (locked.text && !isCjkGlyph(locked.text)) {
      return { ...locked, text: null, conf: 0, note: 'empty' as const };
    }

    if (!char.text) return locked;

    // 页码由左页边区域算法按横笔确定，细笔墨迹不应被正文对齐阈值清空。
    if (char.edited && char.source === 'manual' && char.group === 'pageno') return locked;

    if (!score.aligned || score.inkArea < MIN_INK_AREA) {
      return { ...locked, text: null, conf: 0, note: 'empty' as const };
    }

    const draft = glyphDrafts.get(char.id);
    if (draft && typeof document !== 'undefined') {
      const patch = cropCharPatch(locked, bin, pageW, pageH);
      if (patch) {
        const patchNorm = normalizeGlyphBitmap(patch.data, patch.w, patch.h);
        const verified = verifyGlyphCandidates(patchNorm, draft);
        if (verified.topScore < 0.38) {
          return {
            ...locked,
            text: verified.text,
            conf: Math.min(verified.confidence, CONFIDENCE_THRESHOLD - 0.05),
            note: 'blurry' as const,
          };
        }
        if (verified.confidence < CONFIDENCE_THRESHOLD) {
          return { ...locked, text: verified.text, conf: verified.confidence, note: verified.note };
        }
        return { ...locked, text: verified.text, conf: verified.confidence, note: verified.note };
      }
    }

    if (locked.conf < CONFIDENCE_THRESHOLD && score.offsetPx > 3) {
      return { ...locked, conf: Math.min(locked.conf, CONFIDENCE_THRESHOLD - 0.03), note: 'blurry' as const };
    }

    return locked;
  });
}

export function aggregatePageAlignment(
  chars: CharItem[],
  bin: Uint8Array,
  pageW: number,
  pageH: number,
): PageAlignmentStats {
  let aligned = 0;
  let lowInk = 0;
  let offsetSum = 0;
  for (const char of chars) {
    const score = scoreCharAlignment(char, bin, pageW, pageH);
    offsetSum += Number.isFinite(score.offsetPx) ? score.offsetPx : 0;
    if (score.aligned) aligned += 1;
    else if (score.inkArea < MIN_INK_AREA) lowInk += 1;
  }
  return {
    total: chars.length,
    aligned,
    avgOffsetPx: chars.length > 0 ? offsetSum / chars.length : 0,
    lowInk,
  };
}
