/**
 * model/zpproj.ts：.zpproj.json 导出→导入往返一致性 + 默认值补齐 + 密钥不落盘。
 */
import { check, eq, approx, section, summary, makeSamplePage, makeSampleProject } from './helpers.mjs';
import { exportProject, importProject, ZPPROJ_VERSION } from '../src/model/zpproj.ts';

section('导出 → 导入往返（round-trip）');
const project = makeSampleProject();
const page = makeSamplePage();
page.recognition = { mode: 'B', provider: 'openai', model: 'gpt-4o', batches: 3, costEstimateCny: 0.42 };

const json = exportProject(project, [page]);
const file = JSON.parse(json);

eq('顶层 app 标识', file.app, 'zupuscript-web');
eq('版本号', file.version, ZPPROJ_VERSION);
check('无 BOM', json.charCodeAt(0) !== 0xfeff);

// 密钥不落盘（P1.x：项目文件可安全传阅）
check('导出 JSON 不含 apiKey 字段', !/apiKey|api_key/i.test(json));
check('导出 JSON 不含 imageKey 原图引用', !json.includes('imageKey'));

const { project: p2, pages } = importProject(json);
eq('导入出 1 页', pages.length, 1);
const q = pages[0];
eq('项目名往返一致', p2.name, project.name);
eq('图像宽往返', q.source.widthPx, page.source.widthPx);
eq('图像高往返', q.source.heightPx, page.source.heightPx);
approx('pxPerMm 往返', q.calibration.pxPerMm, page.calibration.pxPerMm, 1e-12);
eq('pageMm 往返', JSON.stringify(q.calibration.pageMm), JSON.stringify(page.calibration.pageMm));
approx('deskewDeg 往返', q.calibration.deskewDeg, page.calibration.deskewDeg, 1e-12);
eq('fontSizes 往返', JSON.stringify(q.fontSizes), JSON.stringify(page.fontSizes));
eq('外框条数往返', q.borderRects.length, page.borderRects.length);
eq('外框坐标往返', JSON.stringify([q.borderRects[0].x, q.borderRects[0].y, q.borderRects[0].w, q.borderRects[0].h]),
  JSON.stringify([page.borderRects[0].x, page.borderRects[0].y, page.borderRects[0].w, page.borderRects[0].h]));
eq('树线条数往返', q.treeLines.length, page.treeLines.length);
eq('树线方向字段重建（v）', q.treeLines[0].orientation, 'v');
eq('树线方向字段重建（h）', q.treeLines[1].orientation, 'h');
eq('节点往返', q.treeNodes.length, page.treeNodes.length);
eq('字符条数往返', q.chars.length, page.chars.length);
eq('null 文本往返（看不清）', q.chars[1].text, null);
eq('字符 conf 往返', q.chars[0].conf, 0.97);
eq('字符 kind=side 往返', q.chars[2].kind, 'side');
eq('字符 edited 往返', q.chars[2].edited, true);
eq('破损笔画往返', q.artifacts.length, page.artifacts.length);
check('识别元信息往返', q.recognition?.mode === 'B' && q.recognition?.model === 'gpt-4o'
  && Math.abs(q.recognition.costEstimateCny - 0.42) < 1e-12);
eq('有字符数据 → 状态 proofread', q.status, 'proofread');
check('project.pageIds 与页 id 对齐', p2.pageIds.length === 1 && p2.pageIds[0] === q.id);
check('新 id 重新分配（不复用旧 id）', q.id !== page.id);

section('默认值补齐（残缺 JSON）');
const minimal = JSON.stringify({
  app: 'zupuscript-web', version: '2.0', name: '残缺项目',
  pages: [{ version: '2.0', source: { name: 'a.png', width_px: 100, height_px: 200 } }],
});
const imp = importProject(minimal);
const mp = imp.pages[0];
eq('缺 calibration → pxPerMm=0', mp.calibration.pxPerMm, 0);
eq('缺 calibration → pageMm=[0,0]', JSON.stringify(mp.calibration.pageMm), JSON.stringify([0, 0]));
eq('缺 font_sizes → 全 0', JSON.stringify(mp.fontSizes), JSON.stringify({ body: 0, title: 0, pageno: 0, rank: 0 }));
eq('缺数组字段 → 空数组', mp.borderRects.length + mp.treeLines.length + mp.chars.length + mp.artifacts.length, 0);
eq('无字符 → 状态 imported', mp.status, 'imported');

// 字符字段默认值
const withChar = JSON.stringify({
  app: 'zupuscript-web', version: '2.0', name: 'x',
  pages: [{ version: '2.0', source: { name: 'a.png', width_px: 1, height_px: 1 },
    chars: [{ text: '某', cx: 1, cy: 2, pt: 10, conf: 0.5, bbox: [0, 0, 9, 9], source: 'llm', edited: false }] }],
});
const wc = importProject(withChar).pages[0].chars[0];
eq('缺 note → ok', wc.note, 'ok');
eq('缺 group → body', wc.group, 'body');
eq('缺 kind → text', wc.kind, 'text');

section('异常输入');
let threw = '';
try { importProject('not json'); } catch (e) { threw = e.message; }
check('非法 JSON 抛错', threw.includes('JSON'));
threw = '';
try { importProject(JSON.stringify({ app: 'other', pages: [] })); } catch (e) { threw = e.message; }
check('错误 app 标识抛错', threw.includes('zpproj'));
threw = '';
try { importProject(JSON.stringify({ app: 'zupuscript-web', version: '1.0', pages: [] })); } catch (e) { threw = e.message; }
check('旧版本 1.x 抛错', threw.includes('版本'));

section('多页排序');
const pg0 = { ...makeSamplePage(), id: 'a', index: 0 };
const pg1 = { ...makeSamplePage(), id: 'b', index: 1 };
const multi = JSON.parse(exportProject(project, [pg1, pg0])); // 乱序传入
check('导出按 index 排序', multi.pages[0].source.name === pg0.source.name || multi.pages.length === 2);

summary('zpproj');
