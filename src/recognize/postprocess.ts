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
import type { CharItem, CharNote } from '@/model/types';
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

    // 族谱中「子」是高频排行/亲属字，「孑」极罕见；模型给出「子」候选或低置信时定向消歧。
    if (
      _ctx.isGenealogy
      && result.char === '孑'
      && (result.confidence < 0.9 || candidates?.includes('子'))
    ) {
      result.char = '子';
      result.confidence = Math.max(result.confidence, DICT_CANDIDATE_CONF);
      result.candidates = [...new Set(['子', ...(candidates ?? []), '孑'])].slice(0, 3);
      result.candidateUsed = true;
    }

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
/**
 * 最终写回前清理「子/孑」系统性误识别。
 * 仅处理自动识别的正文/排行，用户手工确认、标题和页码保持原字。
 */
export function correctAutomatedZiJieConfusion(char: CharItem): CharItem {
  if (char.text !== '孑') return char;
  if (char.edited || char.source === 'manual') return char;
  if (char.group !== 'body' && char.group !== 'rank') return char;
  return {
    ...char,
    text: '子',
    conf: Math.max(char.conf, DICT_CANDIDATE_CONF),
    note: char.note === 'empty' ? 'blurry' : char.note,
  };
}
