/**
 * 大模型提示词与 JSON Schema（PRD 第 9 章，唯一来源）。
 * 共享约定：六条硬规则只允许出现在本文件，禁止在别处复制改写。
 *
 * 六条硬规则（防「编字」，错字比空字危害大得多）：
 * 1. 只认不猜  2. 逐格独立  3. 保留原字形  4. 一格一字  5. 禁止解释  6. 数量守恒
 */
import { SURNAMES } from './dict/surnames';
import { GENEALOGY_TERMS } from './dict/genealogy';

/** 姓氏 TOP100（内嵌提示词先验） */
const SURNAMES_TOP100 = SURNAMES.slice(0, 100).join('、');

/** 族谱高频词先验（内嵌提示词消歧用） */
const GENEALOGY_PRIOR = GENEALOGY_TERMS.slice(0, 80).join('、');

/** 修改提示词或识别规则时升级，防止复用旧模型缓存。 */
export const RECOGNITION_PROMPT_VERSION = 'genealogy-ocr-v5';
export const LAYOUT_BORDER_PROMPT_VERSION = 'border-layout-v1';

export const LAYOUT_BORDER_SYSTEM_PROMPT = [
  '你是族谱、家谱扫描件版面分析专家，专精识别外框实心黑条、装饰黑块与谱系结构线。',
  '你的任务是输出边框定位与检测规则文档，供本地程序二次精确化；不是 OCR 文字。',
  '',
  '【必须识别】',
  '- 包裹正文区域的四边实心外框（常见为较粗黑色矩形框，扫描件可能内缩于白边）',
  '- 页内横向/竖向实心装饰条（如卷次标题黑底）',
  '',
  '【必须排除】',
  '- 谱系细横线/竖线（仅 1–3px 的连接线）',
  '- 圆形节点、文字笔画、页边空白、扫描噪声',
  '- 竖排/横排正文、书名、页码、人名等文字列（tagBlocks 与 excludeZones 中标记，绝不当作装饰黑块）',
  '',
  'tagBlocks 仅用于少量实心装饰图形（如书标折角、侧边图标），不得覆盖含多个汉字的区域。',
  '',
  '坐标一律使用相对值 0–1（左上角为原点）。只输出 JSON，禁止解释。',
].join('\n');

export function buildLayoutBorderUserPrompt(
  widthPx: number,
  heightPx: number,
  localDraft?: { borderRects: Array<{ x: number; y: number; w: number; h: number }>; tagRects: Array<{ x: number; y: number; w: number; h: number }> },
): string {
  const parts = [
    `附件为 ${widthPx}×${heightPx}px 的族谱页二值图（白底黑墨）。请输出边框定位与检测规则。`,
    '重点找出包裹谱系图的正文外框四条实心边条；每条给出 side、role=frame、归一化 bbox 与 confidence。',
    'rules 数组写出 3–6 条本地检测建议，例如：外框线宽约 N px、距页边内缩比例、哪些区域是空白页边等。',
    'excludeZones 标出空白页边或竖排正文列，避免误检为边框。',
  ];
  if (localDraft && (localDraft.borderRects.length > 0 || localDraft.tagRects.length > 0)) {
    parts.push(
      '下面是本地 CV 初稿（可能漏检或误检），请对照原图修正：',
      JSON.stringify({
        local_border_rects_px: localDraft.borderRects.map((r) => [r.x, r.y, r.w, r.h]),
        local_tag_rects_px: localDraft.tagRects.map((r) => [r.x, r.y, r.w, r.h]),
      }),
    );
  }
  parts.push('输出完整 JSON。');
  return parts.join('\n');
}

export const LAYOUT_BORDER_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['confidence', 'summary', 'rules', 'frame', 'borderBars', 'tagBlocks', 'excludeZones'],
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    rules: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    frame: {
      type: 'object',
      required: ['hasOuterFrame'],
      properties: {
        hasOuterFrame: { type: 'boolean' },
        inset: {
          type: 'object',
          properties: {
            top: { type: 'number', minimum: 0, maximum: 0.5 },
            right: { type: 'number', minimum: 0, maximum: 0.5 },
            bottom: { type: 'number', minimum: 0, maximum: 0.5 },
            left: { type: 'number', minimum: 0, maximum: 0.5 },
          },
        },
        thicknessPx: { type: 'number', minimum: 1, maximum: 500 },
      },
    },
    borderBars: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'x', 'y', 'w', 'h', 'confidence'],
        properties: {
          role: { type: 'string', enum: ['frame', 'divider', 'decoration'] },
          side: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
          w: { type: 'number', minimum: 0, maximum: 1 },
          h: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    tagBlocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['x', 'y', 'w', 'h', 'confidence'],
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
          w: { type: 'number', minimum: 0, maximum: 1 },
          h: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    excludeZones: {
      type: 'array',
      items: {
        type: 'object',
        required: ['x', 'y', 'w', 'h', 'reason'],
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
          w: { type: 'number', minimum: 0, maximum: 1 },
          h: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export interface GridPromptDraft {
  id: number;
  char: string | null;
  confidence: number;
  candidates?: string[];
}

/** 系统提示词（PRD 9.1 原文 + 六条硬规则展开 + 族谱场景增强） */
export const SYSTEM_PROMPT = [
  '你是繁体中文古籍与族谱图像识别专家，专精木刻版、石印版和低清扫描件。你的任务是依据可见字形逐字转写，不是续写、翻译或内容推理。',
  '',
  '【场景说明】',
  '本图来自木刻版或石印版族谱扫描件。族谱为竖排右起繁体中文，可能包含异体字、俗字、避讳字。',
  '木刻版笔画可能断裂、模糊、粘连、缺墨或扩墨；人名可能包含冷僻字、异体字、俗字和避讳字。',
  '边框、谱系横线/竖线、圆形节点、装饰黑块、页码引线、污点和红色编号都不是正文字符。',
  '',
  '【视觉判定顺序】',
  '先看部件位置与外轮廓，再核对横竖撇捺点钩、封闭区域数量和局部断笔；最后才可使用族谱字词先验消歧。',
  '若字形证据与先验冲突，必须服从图像字形。不得因为某字常见于人名或称谓就补写。',
  '',
  '【族谱先验（仅用于消歧，不可据此推测未见之字）】',
  `常见姓氏：${SURNAMES_TOP100}`,
  `族谱高频词：${GENEALOGY_PRIOR}`,
  '若某格字形与上述姓氏/高频词一致则可提高置信度；若不一致则按实际字形返回。',
  '',
  '硬性规则：',
  '1.【只认不猜】看不清的字必须返回 null 并给低置信度，禁止根据常见姓名推测补全。',
  '2.【逐字独立】字符拼图按每个编号格独立判断；整页图按每个可见字独立落点。上下文只能辅助形近字消歧，不能替代字形证据。',
  '3.【保留原字形】繁体输出繁体，异体字输出异体字，禁止转简、禁止规范化。例如「爲」不写「为」，「逺」不写「遠」。',
  '4.【一项一字】拼图每格、整页结果每项只返回一个字符；若裁剪格明显粘连两个字则返回 multi 标记。',
  '5.【禁止解释】只输出 JSON，不输出任何说明文字。',
  '6.【数量守恒】返回条目数必须等于输入格数，一个都不能少。',
  '',
  '【置信度标定】',
  '- 0.95-1.00：主要部件和关键笔画清晰，多种解释中只有一个成立。',
  '- 0.85-0.94：字形基本明确，只有轻微断笔或噪声，不影响定字。',
  '- 0.60-0.84：存在两个以上形近可能，必须提供 candidates，并标 blurry 或 damaged。',
  '- 0.00-0.59：无法可靠定字，char 必须为 null，禁止硬猜。',
  '',
  '【输出字段说明】',
  '- char：原字形字符（异体照原样），看不清为 null',
  '- simplified：对应规范简化字（可空串，用于消歧参考）',
  '- candidates：看不清时提供 1-3 个形近候选字（可空数组，仅当 char 为 null 时提供）',
].join('\n');

/** B 模式用户提示词（随网格尺寸动态生成） */
export function buildGridUserPrompt(cols: number, rows: number, count: number, draft: GridPromptDraft[] = []): string {
  const parts = [
    `附件是 ${cols}x${rows} 编号字符网格，共 ${count} 格。每格白底黑字，左上角红色数字是 id，不是待识别文字。`,
    '编号已随机打乱，与族谱阅读顺序、人物关系和上下文无关。必须按红色 id 逐格独立识别。',
    '逐格放大观察部首结构、关键笔画、封闭区域和断笔连接；不要把格线、红色编号、污点识别成文字。',
    '繁体、异体、俗体必须保持原字形。清晰的一格只输出一个字；空白格返回 null；粘连两个字时 note=multi。',
  ];
  if (draft.length > 0) {
    parts.push(
      '下面是本地 OCR 候选，仅供对照，可能为空或错误。必须以附件字形为准，不得直接照抄：',
      JSON.stringify({ local_draft: draft }),
    );
  }
  parts.push('输出完整 JSON items；id 必须覆盖 0 到 count-1，每个 id 恰好出现一次，不要输出解释。');
  return parts.join('\n');
}

/** 二次综合校验提示：模型必须重新看图，并审查初次输出。 */
export function buildReviewPrompt(draft: string, count: number): string {
  return [
    `这是同一张编号字符图，共 ${count} 格。下面是第一次识别的 JSON 草稿：`,
    draft,
    '不要照抄草稿。请逐格重新放大观察，按部件结构、关键笔画、封闭区域、断笔和粘连情况独立复核。',
    '重点检查第一次输出中的 null、低置信、形近字、简繁误写和异体字规范化错误。',
    '只在附件有明确字形证据时修正；不确定必须返回 char=null、confidence<0.60，并保留 1-3 个 candidates。',
    '输出完整 items 数组，id 必须覆盖每个格子且顺序可任意；不要输出解释文字。',
  ].join('\n');
}

/** C 模式用户提示词（整页识别 + 相对坐标） */
export const PAGE_USER_PROMPT = [
  '附件是一页竖排繁体中文族谱、家谱或世系图扫描页。请识别所有真实可见文字，并给出每个字中心的相对坐标 rx/ry（0 到 1，原点在左上角）。',
  '先扫描页边标题、卷次和页码，再扫描正文区域。正文通常按列从上到下、从右到左，但坐标必须以实际位置为准。',
  '必须覆盖姓名、排行、称谓、配偶、生卒葬信息、旁注和节点附近小字；不得只识别大字或主干姓名。',
  '严格区分文字与外框、谱系连接线、圆形节点、装饰块、箭头、污点和破损痕迹，这些图形不得生成字符。',
  '逐字保留繁体、异体和俗体原字形。字形不清时返回 null 和低置信度，不得根据亲属关系或常见姓名补全。',
  '完成后进行覆盖检查：检查顶部、底部、左右侧栏和各谱系分支是否漏字；检查是否有重复坐标或虚构字符。',
  '输出完整 JSON，禁止解释。',
].join('\n');

/** C 模式用户提示词（整页 + 本地分割锚点，保证字位数量守恒） */
export function buildPageAnchoredUserPrompt(
  chars: Array<{ cx: number; cy: number; kind?: string; group?: string }>,
  widthPx: number,
  heightPx: number,
): string {
  const anchors = chars.map((c, id) => ({
    id,
    rx: Math.round((c.cx / widthPx) * 10000) / 10000,
    ry: Math.round((c.cy / heightPx) * 10000) / 10000,
    ...(c.kind === 'side' ? { region: 'margin' as const, group: c.group ?? 'title' } : {}),
  }));
  return [
    PAGE_USER_PROMPT,
    '',
    `【字位锚点】本地分割已标出 ${anchors.length} 个待识字，下列 id/rx/ry 为各字中心相对坐标（0–1，原点左上）。`,
    'region=margin 的锚点为页边标题或页码，字号可能与正文差异很大，请优先对照原图逐字识别，不得漏字。',
    '你必须为每个 id 返回恰好一条 items 记录：items.length 必须等于锚点数量，id 从 0 到 count-1 各出现一次，不得遗漏、合并或虚构。',
    'char 应对应该 id 坐标处可见字形；看不清返回 null；谱系线、节点圆、外框不是文字。',
    JSON.stringify({ anchors }),
  ].join('\n');
}

/** 整页锚点识别二次校验 */
export function buildPageAnchoredReviewPrompt(draft: string, count: number): string {
  return [
    `附件仍是同一页族谱整页图。本地分割共 ${count} 个字位锚点。第一次识别 JSON：`,
    draft,
    `请逐 id 重新对照原图复核，items 长度必须仍为 ${count}，每个 id 恰好一条。`,
    '纠正误字、漏字与 confidence；无法确认返回 null。只输出 JSON。',
  ].join('\n');
}

/** 整页识别二次校验提示：复核文字与坐标，但不得补写原图不存在的内容。 */
export function buildPageReviewPrompt(draft: string): string {
  return [
    PAGE_USER_PROMPT,
    '下面是第一次整页识别输出，请把它作为待审文档，而不是正确答案：',
    draft,
    '请按顶部、右侧正文、中部谱系、左侧正文、底部和页边文字的顺序重新扫描原图，纠正误字、漏字、重复字和坐标偏移。',
    '重点检查小号竖排字、节点附近文字、侧栏标题、页码，以及被谱系线邻近干扰的字符。',
    '无法确认的字符必须返回 null 和低置信度；禁止依据上下文补全原图不可见的文字。',
    '只输出完整 JSON。',
  ].join('\n');
}

/** B 模式响应 JSON Schema（PRD 9.2 + 族谱增强字段） */
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
          simplified: { type: 'string', maxLength: 2 },
          candidates: { type: 'array', items: { type: 'string', maxLength: 2 }, maxItems: 3 },
        },
      },
    },
  },
} as const;

/** C 模式响应 JSON Schema（整页 + 相对坐标 + 族谱增强字段） */
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
          simplified: { type: 'string', maxLength: 2 },
          candidates: { type: 'array', items: { type: 'string', maxLength: 2 }, maxItems: 3 },
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
