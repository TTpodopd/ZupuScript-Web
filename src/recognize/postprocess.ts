/**
 * 识别后处理（字典消歧、置信度提权、候选兜底）。
 * 在 orchestrator 校验通过后、写回 CharItem 前调用。
 * 约束：保留原字形（"保留原字形"硬规则），仅消歧不改正字。
 */
import { DICT_CANDIDATE_CONF, DICT_HIT_CONF, DICT_LOW_CONF_MAX } from '@/lib/constants';
import { isSurnameChar } from './dict/surnames';
import { isDictChar } from './dict/genealogy';
import { isVariant, normalizeVariant } from './dict/variants';
import { isCjkGlyph, sanitizeCharOutput } from './prompt';
import type { CharNote } from '@/model/types';
import type { RecognizedItem } from './types';

export interface PostprocessContext {
  /** 本页是否为竖排族谱（影响是否启用高频词先验提权） */
  isGenealogy: boolean;
}

export interface PostprocessedItem extends RecognizedItem {
  /** 异体归一后的规范字（仅记录，不改 char 原值） */
  normalizedChar?: string;
  /** 是否命中字典提权 */
  dictBoosted?: boolean;
  /** 是否使用了候选兜底 */
  candidateUsed?: boolean;
}

/**
 * 对一批识别结果做后处理。
 * - 命中姓氏/高频词且 conf < 0.85 → conf 提至 DICT_HIT_CONF (0.86)
 * - conf < DICT_LOW_CONF_MAX 且有 candidates → 若首候选在字典中 → 采用首候选 conf = DICT_CANDIDATE_CONF (0.80)
 * - 异体字保留原字并记录 normalizedChar
 * 数量守恒由 orchestrator 保证，本函数不改变 items 长度。
 */
export function postprocessItems(
  items: RecognizedItem[],
  _ctx: PostprocessContext = { isGenealogy: true },
): PostprocessedItem[] {
  return items.map((item) => {
    const cleaned = sanitizeCharOutput(item.char, item.note);
    const result: PostprocessedItem = {
      ...item,
      char: cleaned.char,
      note: (cleaned.note ?? item.note) as CharNote | undefined,
    };

    // 异体字记录
    if (result.char && isVariant(result.char)) {
      result.normalizedChar = normalizeVariant(result.char);
    }

    // 候选兜底：conf 极低且有候选（仅 CJK 候选有效）
    const candidates = (item as RecognizedItem & { candidates?: string[] }).candidates?.filter(isCjkGlyph);
    result.candidates = candidates;
    if (
      result.char === null &&
      candidates &&
      candidates.length > 0 &&
      item.confidence < DICT_LOW_CONF_MAX
    ) {
      const first = candidates[0];
      if (first && (isSurnameChar(first) || isDictChar(first))) {
        result.char = first;
        result.confidence = DICT_CANDIDATE_CONF;
        result.candidateUsed = true;
        return result;
      }
    }

    // 字典提权：命中且 conf 略低于阈值
    if (result.char && result.confidence < DICT_HIT_CONF) {
      if (isSurnameChar(result.char) || isDictChar(result.char)) {
        result.confidence = DICT_HIT_CONF;
        result.dictBoosted = true;
      }
    }

    return result;
  });
}
