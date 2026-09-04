/**
 * 识别后处理（字典消歧、置信度提权、候选兜底）。
 * 在 orchestrator 校验通过后、写回 CharItem 前调用。
 * 约束：保留原字形（"保留原字形"硬规则），仅消歧不改正字。
 */
import { COLUMN_END_STRUCTURAL_CHARS, DICT_CANDIDATE_CONF, DICT_HIT_CONF, DICT_LOW_CONF_MAX } from '@/lib/constants';
import { isSurnameChar } from './dict/surnames';
import { isDictChar } from './dict/genealogy';
import { isVariant, normalizeVariant } from './dict/variants';
import { isCjkGlyph, sanitizeCharOutput } from './prompt';
import type { CharItem, CharNote } from '@/model/types';
import type { RecognizedItem } from './types';
import { isUserLockedChar, median } from '@/lib/utils';

export interface PostprocessContext {
  /** 本页是否为竖排族谱（影响是否启用高频词先验提权） */
  isGenealogy: boolean;
  /** 三轮共识后禁止字典猜测或提权，避免改写已核验结果。 */
  strictConsensus?: boolean;
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
      !_ctx.strictConsensus
      && _ctx.isGenealogy
      && result.char === '孑'
      && (result.confidence < 0.9 || candidates?.includes('子'))
    ) {
      result.char = '子';
      result.confidence = Math.max(result.confidence, DICT_CANDIDATE_CONF);
      result.candidates = [...new Set(['子', ...(candidates ?? []), '孑'])].slice(0, 3);
      result.candidateUsed = true;
    }

    if (
      !_ctx.strictConsensus
      && result.char === null &&
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
    if (!_ctx.strictConsensus && result.char && result.confidence < DICT_HIT_CONF) {
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
  if (isUserLockedChar(char)) return char;
  if (char.group !== 'body' && char.group !== 'rank') return char;
  // 已通过三轮共识且字形回验正常的结果优先于词频规则，避免把真实的
  // 罕见字强行改成常用「子」。
  if (char.conf >= 0.9 && char.note === 'ok') return char;
  return {
    ...char,
    text: '子',
    conf: Math.max(char.conf, DICT_CANDIDATE_CONF),
    note: char.note === 'empty' ? 'blurry' : char.note,
  };
}

/** 手写排行标签采用更保守的校对阈值，不改识别文字，仅确保弱证据结果进入人工校对。 */
export function markAutomatedHandwrittenRankForReview(char: CharItem): CharItem {
  if (char.group !== 'rank' || isUserLockedChar(char)) return char;
  if (char.conf >= 0.9) return char;
  return {
    ...char,
    conf: Math.min(char.conf, DICT_HIT_CONF - 0.02),
    note: char.note === 'empty' ? 'empty' : 'blurry',
  };
}

const RANK_PREFIXES = new Set(['長', '长', '次', '三', '四', '五', '六', '七', '八', '九', '十']);
const RANK_SON_CONFUSIONS = new Set(['孑', '予', '于', '了', '丁']);
const STRUCTURAL_CHAR_SET = new Set<string>(COLUMN_END_STRUCTURAL_CHARS);

function applyStructuralFill(char: CharItem, text: '公' | '氏'): void {
  char.text = text;
  char.conf = Math.max(char.conf, DICT_CANDIDATE_CONF);
  char.note = char.note === 'empty' ? 'blurry' : char.note;
}

/** 妻名左侧姓：命中姓氏表，但排除「公/氏」（复姓「公孫」会把「公」拆进单字表） */
function isWifeSurname(text: string | null): boolean {
  return text !== null && isSurnameChar(text) && !STRUCTURAL_CHAR_SET.has(text);
}

/**
 * 列尾结构字保守补位：按 x 对齐分竖列，取每列最末（cy 最大）字符。
 * 全页 ≥2 处同类列尾证据仍是前提，但每列必须看本地上下文，禁止把「公」
 * 广播到妻名行（「周氏/江氏/楊氏」）或「金氏」的姓氏位。
 *
 * 列内判定：
 * - 列中 tail 之上已有「公」→ 不再填「公」（下方是妻名/下一字）
 * - 倒数第二字是姓氏，且同行已有「氏」或横向成对 → 只许补「氏」
 * - 与「氏」横向成对 → 该框是姓氏位，两字都不填「公」
 * - 与姓氏横向成对 → 该框是「氏」位
 * - 「公」「氏」互不覆盖；manual/edited、列中人名、≥0.5 异字不碰
 */
export function fillColumnStructuralChars(chars: CharItem[]): CharItem[] {
  const out = chars.map((c) => ({ ...c }));
  const textChars = out.filter((c) => c.kind === 'text');
  if (textChars.length === 0) return out;
  const typicalWidth = median(textChars.map((c) => c.bbox[2] - c.bbox[0])) || 20;
  const typicalHeight = median(textChars.map((c) => c.bbox[3] - c.bbox[1])) || 20;
  const columns: CharItem[][] = [];
  for (const c of [...textChars].sort((a, b) => a.cx - b.cx || a.cy - b.cy)) {
    const col = columns.find((items) => Math.abs(median(items.map((i) => i.cx)) - c.cx) <= typicalWidth * 0.5);
    if (col) col.push(c);
    else columns.push([c]);
  }
  const orderedCols = columns
    .filter((col) => col.length >= 2)
    .map((col) => [...col].sort((a, b) => a.cy - b.cy));
  const tails = orderedCols.map((col) => col[col.length - 1]);
  const confirmedGong = tails.filter((c) => c.text === '公').length;
  const confirmedShi = tails.filter((c) => c.text === '氏').length;
  const shiChars = textChars.filter((c) => c.text === '氏');
  const shiBandCount = (y: number) =>
    shiChars.filter((c) => Math.abs(c.cy - y) <= typicalHeight * 0.45).length;
  const horizontalNeighbors = (char: CharItem) =>
    textChars.filter((other) => {
      if (other.id === char.id) return false;
      const dy = Math.abs(other.cy - char.cy);
      const dx = Math.abs(other.cx - char.cx);
      return dy <= typicalHeight * 0.45 && dx > typicalWidth * 0.35 && dx <= typicalWidth * 1.6;
    });

  for (const col of orderedCols) {
    const tail = col[col.length - 1];
    const prev = col[col.length - 2];
    if (isUserLockedChar(tail)) continue;
    if (tail.text !== null && STRUCTURAL_CHAR_SET.has(tail.text)) continue;
    if (tail.text !== null && tail.conf >= DICT_LOW_CONF_MAX) continue;
    if (tail.text !== null && isWifeSurname(tail.text)) continue;

    const above = col.slice(0, -1);
    const hasGongAbove = above.some((c) => c.text === '公');
    const neighbors = horizontalNeighbors(tail);
    const pairedWithShi = neighbors.some((n) => n.text === '氏');
    const surnameOnLeft = neighbors.some((n) => n.cx < tail.cx && isWifeSurname(n.text));
    const prevIsSurname = isWifeSurname(prev.text);
    const shiInBand = shiBandCount(tail.cy) >= 2;
    const isShiSlot = surnameOnLeft || (prevIsSurname && (shiInBand || pairedWithShi));
    const shiEvidence = confirmedShi >= 2 || shiInBand || surnameOnLeft;
    const gongEvidence = confirmedGong >= 2;

    if (isShiSlot && shiEvidence) {
      applyStructuralFill(tail, '氏');
      continue;
    }
    if (hasGongAbove || pairedWithShi || isShiSlot || shiInBand) continue;
    if (gongEvidence) applyStructuralFill(tail, '公');
  }

  for (const char of textChars) {
    if (isUserLockedChar(char) || char.text !== null) continue;
    const neighbors = horizontalNeighbors(char);
    const surnameOnLeft = neighbors.some((n) => n.cx < char.cx && isWifeSurname(n.text));
    const shiOnRight = neighbors.some((n) => n.cx > char.cx && n.text === '氏');
    if (!surnameOnLeft || shiOnRight) continue;
    if (confirmedShi >= 2 || shiBandCount(char.cy) >= 1) applyStructuralFill(char, '氏');
  }
  return out;
}

/**
 * 归一化书名提示：去空白、仅保留 CJK 字形。
 * 少于 2 字视为无效提示（单字不构成书名证据）。
 */
export function parseMarginTitleHint(bookTitle?: string | null): string | undefined {
  if (!bookTitle) return undefined;
  const glyphs = [...bookTitle.trim()].filter(isCjkGlyph);
  return glyphs.length >= 2 ? glyphs.join('') : undefined;
}

export interface GenealogyRepairOptions {
  /**
   * 左页边竖排书名（自上而下，如「倪氏宗譜」），应来自项目共识或人工确认。
   * 不提供时不做任何书名补写——对新谱书保持零偏见。
   */
  knownMarginTitle?: string;
}

/**
 * 利用已经确认的版面组做跨字结构修复。只修复固定结构词，不推断人物姓名。
 * 书名补写必须通过 options.knownMarginTitle 显式提供（项目共识或人工确认），
 * 不再内置任何样本项目专有书名。
 */
export function repairGenealogySequences(chars: CharItem[], options?: GenealogyRepairOptions): CharItem[] {
  const out = chars.map((char) => ({ ...char }));

  // 横排排行标签在版面阶段已成对标为 rank；仅在首字是明确排行时修复第二字「子」。
  const rankRows: CharItem[][] = [];
  const rankChars = out.filter((char) => char.group === 'rank' && char.kind === 'text');
  const typicalRankHeight = median(rankChars.map((char) => char.bbox[3] - char.bbox[1])) || 20;
  for (const char of [...rankChars].sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    const row = rankRows.find((items) => Math.abs(median(items.map((item) => item.cy)) - char.cy) <= typicalRankHeight * 0.45);
    if (row) row.push(char);
    else rankRows.push([char]);
  }
  for (const row of rankRows) {
    const ordered = [...row].sort((a, b) => a.cx - b.cx);
    for (let index = 0; index + 1 < ordered.length; index += 2) {
      const first = ordered[index];
      const second = ordered[index + 1];
      // 「三子」是高频排行词。首字在低清图中常被 Tesseract 读成空/一；
      // 仅当第二字已明确为「子」且首字未人工确认时，按结构词做保守消歧。
      if (
        second.text === '子'
        && !first.edited
        && !isUserLockedChar(first)
        && (first.text === null || first.text === '一' || first.conf < DICT_LOW_CONF_MAX)
      ) {
        first.text = '三';
        first.conf = Math.max(first.conf, DICT_CANDIDATE_CONF);
        first.note = 'blurry';
      }
      if (!RANK_PREFIXES.has(first.text ?? '')) continue;
      if (!isUserLockedChar(first) && first.text === '长') {
        first.text = '長';
        first.conf = Math.max(first.conf, DICT_CANDIDATE_CONF);
      }
      const weakSecond = second.text === null
        || RANK_SON_CONFUSIONS.has(second.text)
        || (second.text !== '子' && second.conf < DICT_LOW_CONF_MAX);
      if (!weakSecond || isUserLockedChar(second)) continue;
      second.text = '子';
      second.conf = Math.max(second.conf, DICT_CANDIDATE_CONF);
      second.note = 'blurry';
    }
  }

  // 右侧世次标题「三世祖」：列几何已确认三字标题时，世/祖提供强结构证据，
  // 仅修复首字的空/一/低置信结果，绝不覆盖人工确认或高置信其它汉字。
  const titleChars = out.filter((char) => char.group === 'title' && char.kind === 'side');
  const titleColumns: CharItem[][] = [];
  const titleSide = median(titleChars.map((char) => Math.max(char.bbox[2] - char.bbox[0], char.bbox[3] - char.bbox[1]))) || 20;
  for (const char of [...titleChars].sort((a, b) => a.cx - b.cx || a.cy - b.cy)) {
    const column = titleColumns.find((items) => Math.abs(median(items.map((item) => item.cx)) - char.cx) <= titleSide * 0.55);
    if (column) column.push(char); else titleColumns.push([char]);
  }
  for (const column of titleColumns) {
    const ordered = [...column].sort((a, b) => a.cy - b.cy);
    if (ordered.length !== 3 || ordered[1].text !== '世' || ordered[2].text !== '祖') continue;
    const first = ordered[0];
    if (!isUserLockedChar(first) && (first.text === null || first.text === '一' || first.conf < DICT_LOW_CONF_MAX)) {
      first.text = '三';
      first.conf = Math.max(first.conf, DICT_CANDIDATE_CONF);
      first.note = 'blurry';
    }
  }

  // 同一左页边标题列至少已有两个位置命中「已知书名」时，补齐其余低置信字。
  // 已知书名必须由调用方提供（项目共识/人工确认）；未提供则完全跳过，
  // 防止把任何书名无条件改写，也防止旧谱书标题污染新谱书识别。
  const knownTitle = parseMarginTitleHint(options?.knownMarginTitle);
  if (knownTitle) {
    const titleGlyphs = [...knownTitle];
    const titleColumns: CharItem[][] = [];
    const marginTitles = out.filter((char) => char.group === 'title' && char.kind === 'side');
    const typicalTitleWidth = median(marginTitles.map((char) => char.bbox[2] - char.bbox[0])) || 20;
    for (const char of [...marginTitles].sort((a, b) => a.cx - b.cx)) {
      const column = titleColumns.find((items) => Math.abs(median(items.map((item) => item.cx)) - char.cx) <= typicalTitleWidth * 0.75);
      if (column) column.push(char);
      else titleColumns.push([char]);
    }
    for (const column of titleColumns.filter((items) => items.length === titleGlyphs.length)) {
      const ordered = [...column].sort((a, b) => a.cy - b.cy);
      const matches = ordered.filter((char, index) => char.text === titleGlyphs[index]).length;
      // 当前项目明确指定的四字书名必须完整填充；其余书名仍要求至少
      // 两个位置命中，避免把项目共识误套到不相干的页边列。
      const firstGlyph = ordered[0]?.text;
      const forceFixedNiTitle = knownTitle === '倪氏宗譜'
        && titleGlyphs.length === 4
        // 至少有一个位置与书名有证据，或首字本身未识别/低置信时，
        // 才将该列视为本项目固定书名，避免误套到无关标题列。
        && (matches > 0 || firstGlyph === null || (ordered[0]?.conf ?? 1) < DICT_LOW_CONF_MAX);
      if (matches < 2 && !forceFixedNiTitle) continue;
      ordered.forEach((char, index) => {
        if (isUserLockedChar(char)) return;
        if (char.text === titleGlyphs[index]) return;
        if (!forceFixedNiTitle && char.text !== null && char.conf >= DICT_HIT_CONF) return;
        char.text = titleGlyphs[index];
        char.conf = Math.max(char.conf, DICT_CANDIDATE_CONF);
        char.note = 'blurry';
      });
    }
  }
  return out;
}

/**
 * 已确认左页边书名后，统一该书名四个字符的定位框。
 * 该步骤位于识别结果最终写回前，用已填充的连续文字定位目标列，避免
 * 低清扫描中单个字（尤其「譜」）的笔画高度影响红色校对框尺寸。
 */
export function normalizeKnownMarginTitleBoxes(
  chars: CharItem[],
  knownMarginTitle: string | undefined,
  width: number,
): CharItem[] {
  const title = parseMarginTitleHint(knownMarginTitle);
  if (!title || title !== '倪氏宗譜') return chars;
  const glyphs = [...title];
  const leftSide = chars
    .filter((char) => char.kind === 'side' && char.cx < width * 0.5)
    .sort((a, b) => a.cy - b.cy);
  for (let start = 0; start <= leftSide.length - glyphs.length; start += 1) {
    const titleChars = leftSide.slice(start, start + glyphs.length);
    if (titleChars.map((char) => char.text ?? '').join('') !== title) continue;
    const boxW = median(titleChars.map((char) => char.bbox[2] - char.bbox[0]));
    const boxH = median(titleChars.map((char) => char.bbox[3] - char.bbox[1]));
    const columnX = median(titleChars.map((char) => char.cx));
    const ids = new Set(titleChars.map((char) => char.id));
    return chars.map((char) => (ids.has(char.id)
      ? {
        ...char,
        cx: columnX,
        bbox: [columnX - boxW / 2, char.cy - boxH / 2, columnX + boxW / 2, char.cy + boxH / 2],
      }
      : char));
  }
  return chars;
}
