/**
 * 大模型提示词与 JSON Schema（PRD 第 9 章，唯一来源）。
 * 共享约定：六条硬规则只允许出现在本文件，禁止在别处复制改写。
 *
 * 六条硬规则（防「编字」，错字比空字危害大得多）：
 * 1. 只认不猜  2. 逐格独立  3. 保留原字形  4. 一格一字  5. 禁止解释  6. 数量守恒
 */

/** 系统提示词（PRD 9.1 原文 + 六条硬规则展开） */
export const SYSTEM_PROMPT = [
  '你是繁体中文古籍单字识别引擎。只认不猜，看不清返回 null。禁止转简，禁止补全，禁止解释。',
  '硬性规则：',
  '1.【只认不猜】看不清的字必须返回 null 并给低置信度，禁止根据常见姓名推测补全。',
  '2.【逐格独立】每个编号格独立判断，禁止利用相邻格推断上下文。',
  '3.【保留原字形】繁体输出繁体，异体字输出异体字，禁止转简、禁止规范化。',
  '4.【一格一字】每格只返回一个字符；若明显是两个字则返回 multi 标记。',
  '5.【禁止解释】只输出 JSON，不输出任何说明文字。',
  '6.【数量守恒】返回条目数必须等于输入格数，一个都不能少。',
].join('\n');

/** B 模式用户提示词（随网格尺寸动态生成） */
export function buildGridUserPrompt(cols: number, rows: number, count: number): string {
  return `图中是 ${cols}x${rows} 网格，共 ${count} 格，每格一个字（白底黑字），左上角标有红色编号。逐格识别并按 schema 返回。编号是打乱的，与阅读顺序无关，禁止据此推测上下文。`;
}

/** C 模式用户提示词（整页识别 + 相对坐标） */
export const PAGE_USER_PROMPT = [
  '这是一页竖排繁体中文族谱扫描图。请识别图中每一个汉字，并给出该字中心在图中的相对坐标（0 到 1，原点在左上角）。',
  '六条硬规则同样适用：只认不猜、逐字独立、保留原字形、一字一条、禁止解释、不得遗漏也不得虚构。',
  '按 schema 返回 JSON。',
].join('\n');

/** B 模式响应 JSON Schema（PRD 9.2 原文） */
export const GRID_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'char', 'confidence'],
        properties: {
          id: { type: 'integer' },
          char: { type: ['string', 'null'], maxLength: 2 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          note: { type: 'string', enum: ['ok', 'blurry', 'damaged', 'multi', 'empty'] },
        },
      },
    },
  },
} as const;

/** C 模式响应 JSON Schema（整页 + 相对坐标） */
export const PAGE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'char', 'confidence', 'rx', 'ry'],
        properties: {
          id: { type: 'integer' },
          char: { type: ['string', 'null'], maxLength: 2 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rx: { type: 'number', minimum: 0, maximum: 1 },
          ry: { type: 'number', minimum: 0, maximum: 1 },
          note: { type: 'string', enum: ['ok', 'blurry', 'damaged', 'multi', 'empty'] },
        },
      },
    },
  },
} as const;

/**
 * 从模型自由文本中稳健提取 JSON（去代码围栏、截取首个 { 到末个 }）。
 * 仅作为 response_format 失效时的兜底解析。
 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('模型返回中找不到 JSON 对象');
  }
  return JSON.parse(t.slice(start, end + 1));
}

/** 校验单条识别结果：char 必须为 null、单字符、或带 multi 标记的双字符（F4.6 校验链） */
export function isValidChar(char: string | null, note?: string): boolean {
  if (char === null) return true;
  if (note === 'multi') return char.length <= 2;
  // 单字符且非 ASCII（族谱场景为汉字/异体字）
  return [...char].length === 1 && !/^[\x20-\x7E]$/.test(char);
}
