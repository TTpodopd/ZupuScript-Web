/**
 * 数据区序列化：Page → BORDER_RECTS / TREE_LINES / ... Python 字面量（PRD 10.3）。
 * 数据与逻辑分离：坐标数据为独立列表，绘制函数不含硬编码（F7.4）。
 */
import type { CharItem, Page } from '@/model/types';

/**
 * Python 字符串字面量转义（双引号风格）。
 * 防注入：反斜杠、双引号、控制字符一律转义；汉字等可打印字符原样输出（UTF-8 无 BOM）。
 */
export function pyStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** 数字格式化：去掉多余小数，Python 可解析 */
function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

/** 单字符字面量；null（看不清）序列化为 None，由脚本跳过 */
function charLit(c: CharItem): string {
  return c.text === null ? 'None' : pyStr(c.text);
}

export interface EmitOptions {
  /** 名称前缀（多页合并且区分对象名时用） */
  namePrefix?: string;
}

/**
 * 输出单页数据区 Python 字典字面量（七段结构第 4 段的一页内容）。
 * 所有坐标均为原图像素中心坐标，脚本内部统一用 mm(px) 换算（PRD 10.3）。
 */
export function emitPageData(page: Page, opts: EmitOptions = {}): string {
  const p = opts.namePrefix ?? '';
  const lines: string[] = ['{'];

  const rects = page.borderRects.map(
    (r, i) => `    (${num(r.x)}, ${num(r.y)}, ${num(r.w)}, ${num(r.h)}, "${p}R${String(i).padStart(3, '0')}"),`,
  );
  lines.push(`  "BORDER_RECTS": [`);
  lines.push(...rects);
  lines.push('  ],');

  const tags = page.tagRects.map(
    (r, i) => `    (${num(r.x)}, ${num(r.y)}, ${num(r.w)}, ${num(r.h)}, "${p}T${String(i).padStart(3, '0')}"),`,
  );
  lines.push(`  "TAG_RECT": [`);
  lines.push(...tags);
  lines.push('  ],');

  const treeLines = page.treeLines.map(
    (l, i) =>
      `    (${num(l.x1)}, ${num(l.y1)}, ${num(l.x2)}, ${num(l.y2)}, ${num(l.widthPx)}, "${p}L${String(i).padStart(3, '0')}"),`,
  );
  lines.push(`  "TREE_LINES": [`);
  lines.push(...treeLines);
  lines.push('  ],');

  const nodes = page.treeNodes.map(
    (n, i) => `    (${num(n.cx)}, ${num(n.cy)}, ${num(n.r)}, ${num(n.strokePx)}, "${p}N${String(i).padStart(3, '0')}"),`,
  );
  lines.push(`  "TREE_NODES": [`);
  lines.push(...nodes);
  lines.push('  ],');

  const sideChars = page.chars.filter((c) => c.kind === 'side');
  const textChars = page.chars.filter((c) => c.kind !== 'side');
  const sideLits = sideChars.map(
    (c, i) => `    (${charLit(c)}, ${num(c.cx)}, ${num(c.cy)}, ${num(c.pt)}, "${p}S${String(i).padStart(4, '0')}"),`,
  );
  lines.push(`  "SIDE_CHARS": [`);
  lines.push(...sideLits);
  lines.push('  ],');

  const textLits = textChars.map(
    (c, i) => `    (${charLit(c)}, ${num(c.cx)}, ${num(c.cy)}, ${num(c.pt)}, "${p}C${String(i).padStart(4, '0')}"),`,
  );
  lines.push(`  "TEXT_CHARS": [`);
  lines.push(...textLits);
  lines.push('  ],');

  const artifacts = page.artifacts.map(
    (a) => `    (${num(a.x1)}, ${num(a.y1)}, ${num(a.x2)}, ${num(a.y2)}, ${num(a.widthPx)}),`,
  );
  lines.push(`  "ARTIFACT_STROKES": [`);
  lines.push(...artifacts);
  lines.push('  ],');

  lines.push('}');
  return lines.join('\n');
}

/** 多页数据区：PAGES = [ {...}, {...} ]（单页也是 1 元素列表，脚本统一循环） */
export function emitAllPagesData(pages: Page[]): string {
  const blocks = pages.map((pg, i) => emitPageData(pg, { namePrefix: `P${i}_` }));
  return `PAGES = [\n${blocks.join(',\n')}\n]`;
}

/** 统计各数据条数（供 lint 守恒校验） */
export function countEmitted(page: Page): {
  borderRects: number;
  tagRects: number;
  treeLines: number;
  treeNodes: number;
  sideChars: number;
  textChars: number;
  artifacts: number;
} {
  return {
    borderRects: page.borderRects.length,
    tagRects: page.tagRects.length,
    treeLines: page.treeLines.length,
    treeNodes: page.treeNodes.length,
    sideChars: page.chars.filter((c) => c.kind === 'side').length,
    textChars: page.chars.filter((c) => c.kind !== 'side').length,
    artifacts: page.artifacts.length,
  };
}
