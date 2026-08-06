/**
 * calibrate/calibrate.ts 标定换算测试（PRD F5.x，PT_PER_MM=2.834645669）。
 */
import { check, eq, approx, section, summary } from './helpers.mjs';
import {
  pxToMm, mmToPx, charHeightToPt, lineWidthToPt, pageMmFromPx,
  clusterCharHeights, calibratePage, ptForGroup,
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
// 两组明显不同的高度：~40px（正文）与 ~80px（标题，>1.3 倍）
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

// 单组时所有组兜底为同一字号
const single = calibratePage({ ...page, chars: [mkChar(40)] });
check('单组时 title/pageno/rank 兜底 = body', single.fontSizes.title === single.fontSizes.body
  && single.fontSizes.pageno === single.fontSizes.body && single.fontSizes.rank === single.fontSizes.body);

summary('calibrate');
