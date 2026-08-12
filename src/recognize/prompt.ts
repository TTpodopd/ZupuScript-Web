/**
 * 大模型提示词与 JSON Schema（PRD 第 9 章，唯一来源）。
 * 共享约定：六条硬规则只允许出现在本文件，禁止在别处复制改写。
 *
 * 六条硬规则（防「编字」，错字比空字危害大得多）：
 * 1. 只认不猜  2. 逐格独立  3. 保留原字形  4. 一格一字  5. 禁止解释  6. 数量守恒
 */
import { SURNAMES } from './dict/surnames';
import { GENEALOGY_TERMS } from './dict/genealogy';
import type { CharNote } from '@/model/types';

/** 姓氏 TOP100（内嵌提示词先验） */
const SURNAMES_TOP100 = SURNAMES.slice(0, 100).join('、');

/** 族谱高频词先验（内嵌提示词消歧用） */
const GENEALOGY_PRIOR = GENEALOGY_TERMS.slice(0, 80).join('、');

/** 修改提示词或识别规则时升级，防止复用旧模型缓存。 */
export const RECOGNITION_PROMPT_VERSION = 'genealogy-ocr-v12';
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
  '7.【仅限汉字】char 与 candidates 只能是汉字（含繁体、异体、扩展区），严禁输出英文字母、阿拉伯数字、标点、箭头或任何符号；无法确认为汉字时 char=null。',
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
export function buildGridUserPrompt(cols: number, rows: number, count: number, draft: GridPromptDraft[] = [], pageNumberIds: number[] = []): string {
  const parts = [
    `附件是 ${cols}x${rows} 编号字符网格，共 ${count} 格。每格白底黑字，左上角红色数字是 id，不是待识别文字。`,
    '编号已随机打乱，与族谱阅读顺序、人物关系和上下文无关。必须按红色 id 逐格独立识别。',
    '逐格放大观察部首结构、关键笔画、封闭区域和断笔连接；不要把格线、红色编号、污点识别成文字。',
    'char 与 candidates 只允许汉字；字母、数字、标点、箭头、符号一律无效，返回 char=null。',
    '繁体、异体、俗体必须保持原字形。清晰的一格只输出一个字；空白格返回 null；粘连两个字时 note=multi。',
  ];
  if (pageNumberIds.length > 0) {
    parts.push(`页码专用提示：编号 ${pageNumberIds.join('、')} 来自左下竖排页码区，通常是汉字数字「一二三四五六七八九十」之一。必须依据该格真实字形识别，不得固定猜测，也不得返回阿拉伯数字。`);
  }
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

/** C 模式锚点填字专用规则（与 anchors JSON 配套） */
export const ANCHORED_FILL_RULES = [
  '【锚点填字规则 — 最高优先级，违反则整页无效】',
  '0. 本地程序按 id 严格一对一填字：items[id].char 只写入第 id 个字框，绝不按坐标重新匹配或交换字框。',
  '1. items.length 必须等于 anchors.length；anchors 中列出的每个 id 恰好出现一次，不得多报或漏报 id。',
  '2. 每条记录的 rx、ry 必须从 anchors 中同 id 条目原样复制（保留 4 位小数），禁止自行估算、四舍五入重算或按阅读顺序改写坐标。',
  '3. char 必须是 anchors[id] 坐标点处原图可见的单个汉字；禁止把同列上一字、下一字、邻列同高字填入当前 id。',
  '4. 竖排族谱阅读顺序（列右→左、列内上→下）仅用于你扫描图像，不得据此调换 id 与 char 的对应关系。',
  '5. anchors[id] 处无字、只有谱系线/节点/污点 → char=null，confidence<0.6，rx/ry 仍复制 anchors[id]。',
  '6. 填完后自检：若把 char 填到相邻 id 更合理，说明串位，必须改 char 而非改 id/rx/ry。',
  '7. 谱系图多列网格（如「三子/次子/長子」下各列人名）每列独立：id 对应该列该行的字心，禁止跨列填字。',
  '',
  '【反串位示例】若 anchors[3] 在右列、anchors[4] 在左列且同高，则 id=3 的 char 必须是右列该点汉字，不能把左列同高字填进 id=3；rx/ry 仍分别复制 anchors[3] 与 anchors[4]。',
  '8. char 与 candidates 只能是汉字；字母、数字、标点、箭头等符号视为识别失败，char=null、confidence<0.6。',
].join('\n');

/** C 模式用户提示词（整页识别 + 相对坐标） */
export const PAGE_USER_PROMPT = [
  '附件是一页竖排繁体中文族谱、家谱或世系图扫描页。请识别所有真实可见文字，并给出每个字中心的相对坐标 rx/ry（0 到 1，原点在左上角，x 向右、y 向下）。',
  '坐标精度要求：rx/ry 必须对应该字墨迹的几何中心，误差应小于字宽的 1/4；不要用整列或整行中心代替单字中心。',
  '先扫描页边标题、卷次和页码，再扫描正文区域。正文通常按列从上到下、从右到左，但每个字的坐标必须独立精确。',
  '必须覆盖姓名、排行、称谓、配偶、生卒葬信息、旁注和节点附近小字；不得只识别大字或主干姓名。',
  '严格区分文字与外框、谱系连接线、圆形节点、装饰块、箭头、污点和破损痕迹，这些图形不得生成字符。',
  '逐字保留繁体、异体和俗体原字形。字形不清时返回 null 和低置信度，不得根据亲属关系或常见姓名补全。',
  'char 只允许汉字（含异体、扩展区）；字母、数字、标点、箭头等符号一律不得输出，对应 char=null。',
  '完成后进行覆盖检查：检查顶部、底部、左右侧栏和各谱系分支是否漏字；检查是否有重复坐标或虚构字符。',
  '输出完整 JSON，禁止解释。',
].join('\n');

/** C 模式用户提示词（整页 + 本地分割锚点，保证字位数量守恒） */
export function buildPageAnchoredUserPrompt(
  chars: Array<{ cx: number; cy: number; kind?: string; group?: string; skipAnchor?: boolean }>,
  widthPx: number,
  heightPx: number,
): string {
  const anchors = chars
    .map((c, id) => ({
      id,
      rx: Math.round((c.cx / widthPx) * 10000) / 10000,
      ry: Math.round((c.cy / heightPx) * 10000) / 10000,
      skip: Boolean(c.skipAnchor),
      ...(c.kind === 'side' ? { region: 'margin' as const, group: c.group ?? 'title' } : {}),
    }))
    .filter((a) => !a.skip)
    .map(({ skip: _skip, ...rest }) => rest);
  return [
    ANCHORED_FILL_RULES,
    '',
    PAGE_USER_PROMPT,
    '',
    `【字位锚点】本地分割已标出 ${anchors.length} 个待识字（${widthPx}×${heightPx}px）。`,
    '下列 anchors 中每个 id 对应一个待填字位；你必须为每个 id 输出一条 items 记录。',
    '关键：items[i].rx 与 items[i].ry 必须等于 anchors 中 id=i 的 rx/ry（原样复制），items[i].char 为该坐标处的可见汉字。',
    'region=margin 的锚点为页边标题、书名或页码（常见汉字数字如「三一」「卷二」，竖排），字号可能与正文差异很大，仍须逐 id 填 char，不得漏 id。',
    JSON.stringify({ count: anchors.length, anchors }),
  ].join('\n');
}

/** 整页锚点识别二次校验（附 anchors 防串位） */
export function buildPageAnchoredReviewPrompt(
  draft: string,
  chars: Array<{ cx: number; cy: number; skipAnchor?: boolean }>,
  widthPx: number,
  heightPx: number,
): string {
  const anchors = chars
    .map((c, id) => ({
      id,
      rx: Math.round((c.cx / widthPx) * 10000) / 10000,
      ry: Math.round((c.cy / heightPx) * 10000) / 10000,
      skip: Boolean(c.skipAnchor),
    }))
    .filter((a) => !a.skip)
    .map(({ skip: _skip, ...rest }) => rest);
  return [
    ANCHORED_FILL_RULES,
    '',
    `附件仍是同一页族谱整页图（${widthPx}×${heightPx}px）。本地分割共 ${anchors.length} 个字位锚点。`,
    '第一次识别 JSON 草稿（待审，可能有 id/char 串位）：',
    draft,
    '',
    '复核步骤：',
    '1. 对每个 id，放大原图 anchors[id] 坐标处，核对 char 是否为该点汉字；错误则改 char，禁止改 rx/ry（须与 anchors 一致）。',
    '2. 重点检查谱系分支多列网格、邻列同高、排行标签（三子/次子/長子）附近是否串位。',
    '3. items.length 必须仍为 ' + anchors.length + '；无法确认 char=null。',
    '锚点坐标（rx/ry 必须原样复制）：',
    JSON.stringify({ anchors }),
    '只输出完整 JSON items，不要解释。',
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
  const glyphs = [...char];
  if (note === 'multi') return glyphs.length <= 2 && glyphs.every(isCjkGlyph);
  return glyphs.length === 1 && isCjkGlyph(glyphs[0]);
}

/** 族谱字框只允许 CJK 表意文字（含扩展区/兼容区）；字母、数字、标点、箭头等一律无效 */
export function isCjkGlyph(ch: string): boolean {
  return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}\u3007\u3021-\u3029\u3038-\u303B]$/u.test(ch);
}

/** 清洗模型/本地输出：非 CJK（字母、数字、标点、箭头、符号）一律置空，绝不写入字框 */
export function sanitizeCharOutput(
  char: string | null,
  note?: string,
): { char: string | null; note: CharNote | undefined } {
  if (char === null) return { char: null, note: note as CharNote | undefined };
  const glyphs = [...char].filter(isCjkGlyph);
  if (glyphs.length === 0) return { char: null, note: 'empty' };
  if (glyphs.length === 1) return { char: glyphs[0], note: note as CharNote | undefined };
  return { char: glyphs.slice(0, 2).join(''), note: 'multi' };
}
