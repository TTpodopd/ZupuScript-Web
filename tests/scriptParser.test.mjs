import { check, eq, section, summary } from './helpers.mjs';
import { parseGeneratedScript } from '../src/parser/scriptParser.ts';

section('Scribus v7 原生脚本解析');
const code = `
SOURCE_WIDTH_PX = 1956.0
SOURCE_HEIGHT_PX = 3135.0
PX_PER_MM = 10.0
BODY_PT = 20.5
RANK_PT = 20.5
TITLE_PT = 32.0
PAGENO_PT = 29.0
BORDER_RECTS = [(24, 195, 1776, 22, "外框_上")]
TAG_RECT = [(22, 1301, 139, 165, "左侧黑标")]
TREE_LINES = [(432, 652, 1564, 652, 6, "一代横线")]
TREE_NODES = [(604, 764, 11, 3, "节点_三子")]
SIDE_CHARS = [("倪", 77, 668, TITLE_PT, "书名_倪"), ("三", 56, 2256, PAGENO_PT, "页码_三")]
TEXT_CHARS = [("高", 940, 271, BODY_PT, "一代配偶_高")]
ARTIFACT_STROKES = [(906, 1300, 946, 1292, 2)]
`;
const page = parseGeneratedScript(code, 'v7.py')[0].page;
eq('解析一个页面', page.source.widthPx, 1956);
eq('解析独立列表格式外框', page.borderRects.length, 1);
eq('解析黑标', page.tagRects.length, 1);
eq('解析连线和节点', page.treeLines.length + page.treeNodes.length, 2);
eq('解析字符和破损线', page.chars.length + page.artifacts.length, 4);
eq('保留 v7 字号配置', JSON.stringify(page.fontSizes), JSON.stringify({ body: 20.5, title: 32, pageno: 29, rank: 20.5 }));
check('使用 v7 的 10 px/mm', page.calibration.pxPerMm === 10);

summary('scriptParser');
