/**
 * 生成器链路测试：emit.ts + template.ts + lint.ts + export.ts
 * 覆盖 PRD 第 10 章（七段结构/绘制规则）、第 11 章（Scribus 已知坑规避）。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, eq, section, summary, makeSamplePage, makeSampleProject } from './helpers.mjs';

import { emitPageData, emitAllPagesData, countEmitted, pyStr } from '../src/generator/emit.ts';
import { renderScript, defaultTemplateConfig } from '../src/generator/template.ts';
import { lintScript, hasLintError } from '../src/generator/lint.ts';
import { generatePageScript, generateMergedScript, buildBundle } from '../src/generator/export.ts';
import { MM_PER_PT } from '../src/lib/constants.ts';

// Python 探测：不写死机器路径（历史硬编码 /Users/milei 导致换机即挂）。
// 顺序：env PY_BIN → 当前用户 managed python → PATH 中的 python/python3。
function detectPython() {
  const candidates = [
    process.env.PY_BIN,
    path.join(os.homedir(), '.workbuddy/binaries/python/versions/3.13.12/python.exe'),
    path.join(os.homedir(), '.workbuddy/binaries/python/versions/3.13.12/python'),
    'python',
    'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['-c', 'pass'], { stdio: 'pipe' });
      return c;
    } catch { /* try next */ }
  }
  return null;
}
const PY = detectPython();
const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '_tmp_generated.py');

const page = makeSamplePage();

section('emit.ts 数据区序列化');
const data = emitPageData(page);
for (const key of ['BORDER_RECTS', 'TAG_RECT', 'TREE_LINES', 'TREE_NODES', 'SIDE_CHARS', 'TEXT_CHARS', 'ARTIFACT_STROKES']) {
  check(`数据区包含 ${key}`, data.includes(`"${key}"`));
}
check('看不清的字序列化为 None', data.includes('(None,'), data.split('\n').find((l) => l.includes('None')) ?? '');
check('正文字符进入 TEXT_CHARS 段', /"TEXT_CHARS": \[\n(?:.*\n)*?.*"張"/.test(data));
check('边栏字进入 SIDE_CHARS 段', /"SIDE_CHARS": \[\n\s+\("卷一"/.test(data));
check('null 字符不进 SIDE_CHARS', !data.includes('SIDE_CHARS": [\n    (None'));
eq('pyStr 转义双引号', pyStr('a"b'), '"a\\"b"');
eq('pyStr 转义反斜杠', pyStr('a\\b'), '"a\\\\b"');
eq('pyStr 转义控制字符', pyStr('a\nb'), '"a\\x0ab"');
eq('pyStr 保留汉字', pyStr('張三'), '"張三"');
const cnt = countEmitted(page);
eq('countEmitted 正文字符数（side 除外）', cnt.textChars, 2);
eq('countEmitted 边栏字数', cnt.sideChars, 1);
eq('countEmitted 连线数', cnt.treeLines, 2);

section('template.ts + export.ts 完整脚本生成');
const result = generatePageScript(page);
const code = result.code;
check('generatePageScript 自检通过（ok=true）', result.ok, result.issues.map((i) => i.message).join('; '));

// (a) 七段结构关键标记
const anchors = [
  '# -*- coding: utf-8 -*-',
  '2. import 与环境检查',
  '3. 配置常量区',
  '4. 坐标数据区',
  '5. 工具函数区',
  '6. 绘制函数区',
  '7. main() 与结果弹窗',
];
for (const a of anchors) check(`七段结构标记: ${a}`, code.includes(a));

// (b) Scribus 已知坑规避（PRD 第 11 章）
check('含 haveDoc() 环境检查', code.includes('if not scribus.haveDoc():'));
check('含 CLEAR_PAGE_FIRST 常量且默认 True', /CLEAR_PAGE_FIRST = True/.test(code));
check('清页逻辑遍历删除旧对象', code.includes('getAllObjects()') && code.includes('deleteObject'));
check('三层字体解析 resolve_font', code.includes('def resolve_font():'));
check('第一层 FORCE_FONT 精确指定', code.includes('if FORCE_FONT:'));
check('第二层 PREFERRED_FONTS 名单匹配', code.includes('for want in PREFERRED_FONTS:'));
check('第三层关键词模糊匹配', code.includes('FUZZY_KEYS') && code.includes('notoserifcjk'));
check('字体全部失败时中止（不静默出豆腐块）', code.includes('未找到任何可用中文字体') && code.includes('ICON_CRITICAL'));
// 统计绘制函数内的调用行（前导空格缩进），排除 def 定义行
const applyFontCalls = code.match(/^ +apply_font\(item, font\)/gm) ?? [];
eq('setFont 三次应用（建空框/写字后/selectText 全选后）', applyFontCalls.length, 3);
check('selectText 全选后再应用字体', code.includes('scribus.selectText(0, length, item)'));
check('getFont 反查实际生效字体', code.includes('scribus.getFont(first_item)'));
check('newDoc 未被调用（1.6.6 无法脚本化新建文档；注释提及不算调用）', !code.includes('scribus.newDoc('));

// (c) 文本框 = 字号 × 0.352778 × 2.0
check('文本框边长 = size_pt * MM_PER_PT * 2.0', code.includes('box_mm = size_pt * MM_PER_PT * 2.0'));
check(`MM_PER_PT = ${MM_PER_PT} 写入配置区`, code.includes(`MM_PER_PT = ${MM_PER_PT}`));
check('按中心定位文本框', code.includes('x = mm(cx) - box_mm / 2.0'));

// 线宽换算 px → pt
check('线宽 px→pt 换算（×2.834645669）', code.includes('return float(px) / PX_PER_MM * 2.834645669'));

// 无 BOM、LF 换行
check('脚本无 BOM', code.charCodeAt(0) !== 0xfeff);
check('脚本无 CR 字符', !/\r/.test(code));

// (d) py_compile 语法校验
writeFileSync(TMP, code, 'utf8');
if (PY) {
  let pyOk = true;
  let pyErr = '';
  try {
    execFileSync(PY, ['-m', 'py_compile', TMP], { stdio: 'pipe' });
  } catch (e) {
    pyOk = false;
    pyErr = String(e.stderr ?? e.message);
  }
  check('python -m py_compile 语法合法', pyOk, pyErr);
} else {
  check('python -m py_compile 语法合法（未找到 Python，跳过）', true);
}
try { unlinkSync(TMP); } catch { /* ignore */ }

// 多页合并脚本
section('多页合并脚本');
const page2 = { ...makeSamplePage(), id: 'p2', index: 1 };
const merged = generateMergedScript(makeSampleProject(), [page2, page]); // 故意乱序传入
check('合并脚本自检通过', merged.ok, merged.issues.map((i) => i.message).join('; '));
check('合并脚本按 index 排序（P0_ 在前）', merged.code.indexOf('P0_R000') < merged.code.indexOf('P1_R000'));
check('合并脚本含 newPage 分页', merged.code.includes('scribus.newPage(-1)'));
writeFileSync(TMP, merged.code, 'utf8');
if (PY) {
  let mergedPyOk = true;
  try { execFileSync(PY, ['-m', 'py_compile', TMP], { stdio: 'pipe' }); } catch { mergedPyOk = false; }
  check('合并脚本 py_compile 语法合法', mergedPyOk);
} else {
  check('合并脚本 py_compile 语法合法（未找到 Python，跳过）', true);
}
try { unlinkSync(TMP); } catch { /* ignore */ }

// buildBundle
const bundle = buildBundle(makeSampleProject(), [page], 'perPage');
eq('perPage 模式逐页出脚本', bundle.scripts.length, 1);
check('辅助脚本齐全（≥1 个）', bundle.helpers.length >= 1);

section('lint.ts 自检（正/负用例）');
// 负用例 1：括号不配对
const badParens = lintScript(code.replace('def main():', 'def main(:'));
check('括号不配对能报错', hasLintError(badParens));
check('括号错误信息可读', badParens.some((i) => i.message.includes('括号')));

// 负用例 2：引号未闭合
const badQuote = lintScript(code + '\nx = "未闭合\n');
check('引号未闭合能报错', hasLintError(badQuote));

// 负用例 3：BOM
check('BOM 能报错', hasLintError(lintScript('﻿' + code)));

// 负用例 4：Tab 缩进
check('Tab 缩进能报错', hasLintError(lintScript(code.replace('def main():\n    ', 'def main():\n\t'))));

// 负用例 5：数据条数不守恒（删掉一个正文字符条目）
const broken = code.replace(/\n\s*\("張", 500, 400, 10.5, "C0000"\),/, '');
check('破坏样例确认少了一条 C 记录', !broken.includes('"C0000"'));
const conservation = lintScript(broken, cnt);
check('条数不守恒能报错', hasLintError(conservation), conservation.map((i) => i.message).join('; '));
check('不守恒错误指明期望/实际', conservation.some((i) => i.message.includes('不守恒')));

// 正用例：完整脚本 lint 无 error
const good = lintScript(code, cnt);
check('完整脚本 lint 0 error', !hasLintError(good), good.map((i) => i.message).join('; '));

// 缺锚点
check('缺锚点能报错', hasLintError(lintScript('print(1)')));

summary('generator');
