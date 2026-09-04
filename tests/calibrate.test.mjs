/**
 * calibrate/calibrate.ts 标定换算测试（PRD F5.x，PT_PER_MM=2.834645669）。
 */
import { check, eq, approx, section, summary } from './helpers.mjs';
import {
  pxToMm, mmToPx, charHeightToPt, lineWidthToPt, pageMmFromPx,
  clusterCharHeights, calibratePage, ptForGroup,
  countCharsByGroup, activeFontGroups, applyFontSizeToGroup, applyFontSizeToAllChars, medianPtForGroup, medianPtAllChars, FONT_GROUP_LABELS,
} from '../src/calibrate/calibrate.ts';
import { MM_PER_PT, PT_PER_MM, DEFAULT_PX_PER_MM } from '../src/lib/constants.ts';
import { makeSamplePage } from './helpers.mjs';

section('常量契约');
eq('PT_PER_MM = 2.834645669', PT_PER_MM, 2.834645669);
eq('MM_PER_PT = 0.352778', MM_PER_PT, 0.352778);
check('MM_PER_PT ≈ 1/PT_PER_MM', Math.abs(MM_PER_PT * PT_PER_MM - 1) < 1e-5);

section('px ↔ mm 换算');
const pxPerMm = 200 / 25.4; // 7.874015748
approx('pxToMm: 200px@200dpi ≈ 25.4mm', pxToMm(200, pxPerMm), 25.4, 1e-9);
approx('mmToPx: 25.4mm@200dpi = 200px', mmToPx(25.4, pxPerMm), 200, 1e-9);
approx('pxToMm/mmToPx 互逆', mmToPx(pxToMm(1234.5, pxPerMm), pxPerMm), 1234.5, 1e-9);

section('字高 → pt（F5.1）');
// 字高 40px @200dpi → 40 / 7.874... = 5.08mm → /0.352778 ≈ 14.4pt
approx('charHeightToPt(40px, 200dpi)', charHeightToPt(40, pxPerMm), 40 / pxPerMm / MM_PER_PT, 1e-9);
approx('charHeightToPt 数值合理 ≈14.4pt', charHeightToPt(40, pxPerMm), 14.3999, 1e-3);
eq('pxPerMm=0 时返回 0（防御除零）', charHeightToPt(40, 0), 0);

section('线宽 px → pt（F5.3）');
approx('lineWidthToPt(3px, 200dpi)', lineWidthToPt(3, pxPerMm), (3 / pxPerMm) * PT_PER_MM, 1e-9);
eq('pxPerMm=0 时返回 0', lineWidthToPt(3, 0), 0);

section('页面 mm（F5.4）');
const [wMm, hMm] = pageMmFromPx(2000, 3000, pxPerMm);
approx('2000px → 254mm', wMm, 254, 1e-9);
approx('3000px → 381mm', hMm, 381, 1e-9);

section('字号聚类（F5.2）');
eq('空字符列表返回空', clusterCharHeights([]).length, 0);
const mkChar = (h, kind = 'text') => ({
  id: `c-${h}-${Math.random()}`, text: '某', cx: 0, cy: 0, bbox: [0, 0, 20, h],
  pt: 0, conf: 0.9, note: 'ok', source: 'llm', edited: false, group: 'body', kind,
});
// 两组明显不同的高度：~40px（正文）与 ~80px（>15% 容差切分）
const chars = [...Array(5)].map(() => mkChar(40)).concat([...Array(3)].map(() => mkChar(80)));
const groups = clusterCharHeights(chars);
eq('聚类分为 2 组', groups.length, 2);
approx('小组中位数 40', groups[0], 40, 1e-9);
approx('大组中位数 80', groups[1], 80, 1e-9);

section('整页自动标定 calibratePage');
const page = makeSamplePage();
// 两组文本高度：正文 5 个 40px + 标题 1 个 80px；边栏字同高 40（聚类语义：最小=正文，最大=标题）
page.chars = [...Array(5)].map(() => mkChar(40)).concat([mkChar(80), { ...mkChar(40, 'side') }]);
const r = calibratePage(page);
approx('正文字号 ≈ 14.4pt', r.fontSizes.body, Math.round((40 / pxPerMm / MM_PER_PT) * 10) / 10, 1e-9);
approx('标题字号 ≈ 28.8pt', r.fontSizes.title, Math.round((80 / pxPerMm / MM_PER_PT) * 10) / 10, 1e-9);
check('side 字归入 pageno 组', r.chars[r.chars.length - 1].group === 'pageno');
check('字符写回 pt 与组一致', r.chars.every((c) => c.pt === r.fontSizes[c.group]));

// 人工覆盖（F5.5）
const r2 = calibratePage(page, { body: 12 });
eq('人工覆盖 body=12 优先', r2.fontSizes.body, 12);
check('body 组字符 pt 同步为 12', r2.chars.filter((c) => c.group === 'body').every((c) => c.pt === 12));

eq('ptForGroup 直取', ptForGroup('title', r.fontSizes), r.fontSizes.title);

section('分组字号面板辅助');
const mixed = calibratePage(page);
const counts = countCharsByGroup(mixed.chars);
check('正文组有字', counts.body > 0);
check('pageno 组有 side 字', counts.pageno > 0);
const active = activeFontGroups(mixed.chars);
check('activeFontGroups 不含空组', active.every((g) => counts[g] > 0));
check('activeFontGroups 含 rank/body/title/pageno 中有字的组', active.length >= 2);
const resized = applyFontSizeToGroup(mixed, 'body', 9);
check('applyFontSizeToGroup 只改目标组 pt', resized.chars.filter((c) => c.group === 'body').every((c) => c.pt === 9));
check('applyFontSizeToGroup 不改其他组', resized.chars.filter((c) => c.group !== 'body').every((c) => c.pt === mixed.chars.find((x) => x.id === c.id)?.pt));
check('FONT_GROUP_LABELS.rank 可读', FONT_GROUP_LABELS.rank.includes('主文字'));
const allResized = applyFontSizeToAllChars(mixed, 11);
check('applyFontSizeToAllChars 统一 pt', allResized.chars.every((c) => c.pt === 11));
eq('medianPtAllChars 取中位数', medianPtAllChars(allResized.chars), 11);

// 单组时所有组兜底为同一字号
const single = calibratePage({ ...page, chars: [mkChar(40)] });
check('单组时 title/pageno/rank 兜底 = body', single.fontSizes.title === single.fontSizes.body
  && single.fontSizes.pageno === single.fontSizes.body && single.fontSizes.rank === single.fontSizes.body);


section('page number box-height calibration');
const pageNoPage = makeSamplePage();
pageNoPage.chars = [
  ...Array.from({ length: 6 }, (_, i) => ({ ...mkChar(40), id: `body-${i}`, group: 'body' })),
  { ...mkChar(2, 'side'), id: 'page-one', bbox: [0, 0, 40, 40], group: 'pageno', text: '一' },
  { ...mkChar(6, 'side'), id: 'page-two', bbox: [0, 50, 40, 90], group: 'pageno', text: '二' },
];
const pageNoResult = calibratePage(pageNoPage, undefined, { data: new Uint8Array(200 * 200), width: 200, height: 200 });
eq('page number pt equals body pt', pageNoResult.fontSizes.pageno, pageNoResult.fontSizes.body);
check('page number chars use body pt', pageNoResult.chars.filter((c) => c.group === 'pageno').every((c) => c.pt === pageNoResult.fontSizes.body));
check('body pt unchanged by page numbers', pageNoResult.chars.filter((c) => c.group === 'body').every((c) => c.pt === pageNoResult.fontSizes.body));

section('preserve layout semantic groups');
const semanticPage = makeSamplePage();
semanticPage.chars = [
  ...Array.from({ length: 5 }, (_, i) => ({ ...mkChar(40), id: `semantic-body-${i}` })),
  { ...mkChar(66), id: 'book-title', group: 'title', kind: 'side' },
  { ...mkChar(30), id: 'rank-first', group: 'rank' },
  { ...mkChar(30), id: 'rank-second', group: 'rank' },
];
const semanticResult = calibratePage(semanticPage);
eq('页边标题保留 title 分组', semanticResult.chars.find((c) => c.id === 'book-title').group, 'title');
check('排行标签不被字号聚类覆盖为正文', semanticResult.chars.filter((c) => c.id.startsWith('rank-')).every((c) => c.group === 'rank'));
check('标题字号取标题实际高度', semanticResult.fontSizes.title > semanticResult.fontSizes.body);
check('排行字号按自身真实高度计算', semanticResult.fontSizes.rank < semanticResult.fontSizes.body);

section('噪声小框不单独成字号组');
const noisyPage = makeSamplePage();
noisyPage.chars = [
  ...Array.from({ length: 6 }, (_, i) => ({ ...mkChar(40), id: `body-main-${i}` })),
  { ...mkChar(8), id: 'node-speck-a' },
  { ...mkChar(8), id: 'node-speck-b' },
];
const noisyResult = calibratePage(noisyPage);
eq('小噪声框仍归正文组', noisyResult.chars.find((c) => c.id === 'node-speck-a').group, 'body');
eq('小噪声框继承正文字号', noisyResult.chars.find((c) => c.id === 'node-speck-a').pt, noisyResult.fontSizes.body);
eq('正文字号不被小框拉低', noisyResult.fontSizes.body, Math.round((40 / pxPerMm / MM_PER_PT) * 10) / 10);
summary('calibrate');
