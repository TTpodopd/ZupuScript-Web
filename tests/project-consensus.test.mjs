/** 项目级书名共识测试：从项目自身高置信页面推断书名（泛化改造） */
import { check, eq, section, summary } from './helpers.mjs';
import { extractMarginTitleColumns, inferProjectMarginTitle } from '../src/recognize/projectConsensus.ts';

let seq = 0;
function makeTitleChar(text, cx, cy, { conf = 0.92, edited = false, kind = 'side', group = 'title' } = {}) {
  seq += 1;
  return {
    id: `tc-${seq}`,
    text,
    cx,
    cy,
    bbox: [cx - 12, cy - 14, cx + 12, cy + 14],
    pt: 14,
    conf,
    note: text ? 'ok' : 'empty',
    source: 'llm',
    edited,
    group,
    kind,
  };
}

function makePage(id, chars, widthPx = 2000) {
  return {
    id,
    projectId: 'proj-x',
    index: 0,
    status: 'recognized',
    source: { name: `${id}.png`, page: 1, widthPx, heightPx: 3000, dpi: 200 },
    calibration: { pxPerMm: 7.874, pageMm: [254, 381], deskewDeg: 0 },
    fontSizes: { body: 10.5, title: 16, pageno: 9, rank: 12 },
    borderRects: [],
    tagRects: [],
    treeLines: [],
    treeNodes: [],
    chars,
    artifacts: [],
    imageKey: `img-${id}`,
  };
}

function titleColumn(text, cx, startY = 100, step = 40, overrides = []) {
  return [...text].map((ch, i) => makeTitleChar(ch, cx, startY + i * step, overrides[i] ?? {}));
}

section('extractMarginTitleColumns');
{
  // 完整高置信标题列 → 提取
  const page = makePage('p1', titleColumn('倪氏宗譜', 40));
  const cols = extractMarginTitleColumns(page);
  eq('完整高置信列被提取', cols.length, 1);
  eq('列文本自上而下拼接', cols[0]?.text, '倪氏宗譜');

  // 含低置信字 → 整列不作为证据
  const weak = makePage('p2', titleColumn('倪氏宗譜', 40, 100, 40, [{}, {}, {}, { conf: 0.4 }]));
  eq('含低置信字的列不参与共识', extractMarginTitleColumns(weak).length, 0);

  // 人工编辑过的低置信字视为已确认
  const edited = makePage('p3', titleColumn('倪氏宗譜', 40, 100, 40, [{}, {}, {}, { conf: 0.3, edited: true }]));
  eq('人工确认字可支撑共识', extractMarginTitleColumns(edited).length, 1);

  // 右半页标题不算左页边书名
  const right = makePage('p4', titleColumn('三世祖', 1800));
  eq('右侧标题不进入书名共识', extractMarginTitleColumns(right).length, 0);

  // 单字列不提取
  const single = makePage('p5', [makeTitleChar('倪', 40, 100)]);
  eq('单字列不提取', extractMarginTitleColumns(single).length, 0);

  // 非 title/side 字符不提取
  const body = makePage('p6', [...titleColumn('倪氏宗譜', 40)].map((c) => ({ ...c, kind: 'text', group: 'body' })));
  eq('正文字符不进入书名共识', extractMarginTitleColumns(body).length, 0);
}

section('inferProjectMarginTitle');
{
  const pageA = makePage('a', titleColumn('倪氏宗譜', 40));
  const pageB = makePage('b', titleColumn('倪氏宗譜', 44));
  const pageC = makePage('c', titleColumn('王氏宗譜', 40));

  eq('两页共识命中', inferProjectMarginTitle([pageA, pageB]), '倪氏宗譜');
  eq('单页证据不足不提示', inferProjectMarginTitle([pageA]), undefined);
  eq('对半分裂无多数不提示', inferProjectMarginTitle([pageA, pageC]), undefined);
  eq('多数票胜出', inferProjectMarginTitle([pageA, pageB, pageC]), '倪氏宗譜');
  eq('空项目不提示', inferProjectMarginTitle([]), undefined);

  // 同一页重复列只计一票
  const dup = makePage('dup', [...titleColumn('倪氏宗譜', 40), ...titleColumn('倪氏宗譜', 80)]);
  eq('页内重复列不重复计票', inferProjectMarginTitle([dup, makePage('solo', [])]), undefined);

  // 不同项目风格的标题互不干扰：无共识时保持沉默
  eq('全弱证据页无共识', inferProjectMarginTitle([
    makePage('w1', titleColumn('倪氏宗譜', 40, 100, 40, [{}, {}, {}, { conf: 0.2 }])),
    makePage('w2', titleColumn('倪氏宗譜', 40, 100, 40, [{}, {}, {}, { conf: 0.2 }])),
  ]), undefined);
}
summary('项目书名共识模块测试');
