/**
 * 项目级书名共识推断（泛化改造核心）。
 *
 * 旧实现把样本项目的书名「倪氏宗譜」硬编码进提示词与后处理修复，
 * 对新谱书图像要么提示失效、要么产生偏向性误导。
 * 本模块改为：从项目自身已高置信识别的页面里，对左页边竖排书名做投票共识；
 * 有共识才给提示词/修复用，没有共识就完全内容无关（新谱书零偏见）。
 */
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import { median } from '@/lib/utils';
import type { CharItem, Page } from '@/model/types';

/** 共识投票最少命中页数（低于此值视为证据不足，不产生提示） */
export const MARGIN_TITLE_MIN_VOTES = 2;
/** 参与共识扫描的最多页数（超大项目保护） */
export const MARGIN_TITLE_SCAN_PAGE_CAP = 60;

export interface MarginTitleColumn {
  /** 列中心 x（像素） */
  cx: number;
  /** 自上而下拼接的书名文本 */
  text: string;
}

/** 字是否算「已确认」：有字，且人工编辑过或置信度达标 */
function isSolidChar(char: CharItem, minConf: number): boolean {
  return Boolean(char.text) && (char.edited || char.conf >= minConf);
}

/**
 * 提取单页左页边「整列已确认」的竖排标题列。
 * 只有整列每个字都可靠时才作为投票证据，避免把半页噪声带进共识。
 */
export function extractMarginTitleColumns(page: Page, minConf = CONFIDENCE_THRESHOLD): MarginTitleColumn[] {
  const widthPx = page.source?.widthPx ?? 0;
  if (widthPx <= 0) return [];
  const sideTitles = page.chars.filter(
    (c) => c.kind === 'side' && c.group === 'title' && c.cx <= widthPx * 0.5,
  );
  if (sideTitles.length === 0) return [];

  // 与后处理一致的按 cx 聚列逻辑
  const typicalWidth = median(sideTitles.map((c) => c.bbox[2] - c.bbox[0])) || 20;
  const columns: CharItem[][] = [];
  for (const char of [...sideTitles].sort((a, b) => a.cx - b.cx)) {
    const column = columns.find(
      (items) => Math.abs(median(items.map((item) => item.cx)) - char.cx) <= typicalWidth * 0.75,
    );
    if (column) column.push(char);
    else columns.push([char]);
  }

  const out: MarginTitleColumn[] = [];
  for (const column of columns) {
    if (column.length < 2 || column.length > 8) continue; // 书名常见 2–8 字
    if (!column.every((char) => isSolidChar(char, minConf))) continue;
    const ordered = [...column].sort((a, b) => a.cy - b.cy);
    out.push({
      cx: median(column.map((c) => c.cx)),
      text: ordered.map((c) => c.text).join(''),
    });
  }
  return out;
}

/**
 * 跨页投票推断项目书名。
 * - 每页同一文本只计 1 票（页内重复列不重复计票）
 * - 需至少 MARGIN_TITLE_MIN_VOTES 票，且得票严格多于次高者（无多数 → 不提示）
 */
export function inferProjectMarginTitle(
  pages: Page[],
  minVotes = MARGIN_TITLE_MIN_VOTES,
): string | undefined {
  const votes = new Map<string, number>();
  for (const page of pages.slice(0, MARGIN_TITLE_SCAN_PAGE_CAP)) {
    const seenOnPage = new Set<string>();
    for (const column of extractMarginTitleColumns(page)) {
      if (seenOnPage.has(column.text)) continue;
      seenOnPage.add(column.text);
      votes.set(column.text, (votes.get(column.text) ?? 0) + 1);
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [best, bestVotes] = ranked[0] ?? [];
  if (!best || bestVotes < minVotes) return undefined;
  const secondVotes = ranked[1]?.[1] ?? 0;
  if (bestVotes <= secondVotes) return undefined;
  return best;
}
