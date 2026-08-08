import type { BorderRect, CharItem, Page, SourceInfo, TagRect, TreeLine, TreeNode, ArtifactStroke } from '@/model/types';
import { uuid } from '@/lib/utils';

export interface ParsedScriptPage {
  page: Page;
  warnings: string[];
}

function numberValue(value: string, symbols: Record<string, number> = {}): number {
  const token = value.trim();
  if (token in symbols) return symbols[token];
  const n = Number(token);
  return Number.isFinite(n) ? n : 0;
}

function decodePyString(value: string): string {
  const body = value.slice(1, -1).replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  try {
    return JSON.parse(`"${body.replace(/"/g, '\\"')}"`);
  } catch {
    return body.replace(/\\([\\"])/g, '$1');
  }
}

function section(code: string, key: string): string {
  const objectValue = code.match(new RegExp(`['"]${key}['"]\\s*:\\s*\\[(.*?)\\]`, 's'))?.[1];
  if (objectValue !== undefined) return objectValue;
  const assignment = code.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\))`, 'm'))?.[1];
  if (!assignment) return '';
  if (assignment.startsWith('[')) return assignment.slice(1, -1);
  return assignment;
}

function tuples(value: string): string[] {
  const out: string[] = [];
  let start = -1;
  let quote = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"' || ch === "'") quote = false;
      continue;
    }
    if (ch === '"' || ch === "'") quote = true;
    else if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(value.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

function fields(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"' || ch === "'") quote = false;
    } else if (ch === '"' || ch === "'") quote = true;
    else if (ch === ',') {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

function parsePageBlock(code: string, index: number, name: string, width: number, height: number, pxPerMm: number, fontSizes = { body: 0, title: 0, pageno: 0, rank: 0 }, symbols: Record<string, number> = {}): Page {
  const rects: BorderRect[] = tuples(section(code, 'BORDER_RECTS')).map((v) => {
    const f = fields(v); return { id: uuid(), x: numberValue(f[0], symbols), y: numberValue(f[1], symbols), w: numberValue(f[2], symbols), h: numberValue(f[3], symbols) };
  });
  const tags: TagRect[] = tuples(section(code, 'TAG_RECT')).map((v) => {
    const f = fields(v); return { id: uuid(), x: numberValue(f[0], symbols), y: numberValue(f[1], symbols), w: numberValue(f[2], symbols), h: numberValue(f[3], symbols) };
  });
  const lines: TreeLine[] = tuples(section(code, 'TREE_LINES')).map((v) => {
    const f = fields(v); const x1 = numberValue(f[0], symbols); const y1 = numberValue(f[1], symbols); const x2 = numberValue(f[2], symbols); const y2 = numberValue(f[3], symbols);
    return { id: uuid(), x1, y1, x2, y2, widthPx: numberValue(f[4], symbols), orientation: Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? 'h' : 'v' };
  });
  const nodes: TreeNode[] = tuples(section(code, 'TREE_NODES')).map((v) => { const f = fields(v); return { id: uuid(), cx: numberValue(f[0], symbols), cy: numberValue(f[1], symbols), r: numberValue(f[2], symbols), strokePx: numberValue(f[3], symbols) }; });
  const charsFor = (key: string, kind: 'text' | 'side'): CharItem[] => tuples(section(code, key)).map((v) => {
    const f = fields(v); const text = f[0] === 'None' ? null : decodePyString(f[0]); const cx = numberValue(f[1], symbols); const cy = numberValue(f[2], symbols); const pt = numberValue(f[3], symbols); const objectName = f[4] ? decodePyString(f[4]) : '';
    const half = Math.max(8, pt * (pxPerMm || 1) / 2.8346);
    const group = kind === 'side'
      ? (fontSizes.pageno > 0 && Math.abs(pt - fontSizes.pageno) < 0.01 ? 'pageno' : 'title')
      : (objectName.includes('排行') ? 'rank' : 'body');
    return { id: uuid(), text, cx, cy, bbox: [cx - half, cy - half, cx + half, cy + half], pt, conf: 1, note: text === null ? 'blurry' : 'ok', source: 'manual', edited: false, group, kind };
  });
  const artifacts: ArtifactStroke[] = tuples(section(code, 'ARTIFACT_STROKES')).map((v) => { const f = fields(v); return { id: uuid(), x1: numberValue(f[0], symbols), y1: numberValue(f[1], symbols), x2: numberValue(f[2], symbols), y2: numberValue(f[3], symbols), widthPx: numberValue(f[4], symbols) }; });
  const source: SourceInfo = { name: `${name}${index > 0 ? ` 第${index + 1}页` : ''}`, widthPx: width || 1200, heightPx: height || 1600, dpi: 300 };
  const resolvedFontSizes = { ...fontSizes };
  if (resolvedFontSizes.body <= 0) resolvedFontSizes.body = charsFor('TEXT_CHARS', 'text')[0]?.pt ?? 0;
  return { id: uuid(), projectId: '', index, status: 'proofread', source, calibration: { pxPerMm: pxPerMm || 11.811, pageMm: [source.widthPx / (pxPerMm || 11.811), source.heightPx / (pxPerMm || 11.811)], deskewDeg: 0 }, fontSizes: resolvedFontSizes, borderRects: rects, tagRects: tags, treeLines: lines, treeNodes: nodes, chars: [...charsFor('TEXT_CHARS', 'text'), ...charsFor('SIDE_CHARS', 'side')], artifacts, imageKey: '' };
}

export function parseGeneratedScript(code: string, name = '脚本结果'): ParsedScriptPage[] {
  const width = numberValue(code.match(/SOURCE_WIDTH_PX\s*=\s*([\d.]+)/)?.[1] ?? '0');
  const height = numberValue(code.match(/SOURCE_HEIGHT_PX\s*=\s*([\d.]+)/)?.[1] ?? '0');
  const pxPerMm = numberValue(code.match(/PX_PER_MM\s*=\s*([\d.]+)/)?.[1] ?? '0');
  const fontSizes = {
    body: numberValue(code.match(/BODY_PT\s*=\s*([\d.]+)/)?.[1] ?? '0'),
    title: numberValue(code.match(/TITLE_PT\s*=\s*([\d.]+)/)?.[1] ?? '0'),
    pageno: numberValue(code.match(/PAGENO_PT\s*=\s*([\d.]+)/)?.[1] ?? '0'),
    rank: numberValue(code.match(/RANK_PT\s*=\s*([\d.]+)/)?.[1] ?? '0'),
  };
  const symbols: Record<string, number> = {
    BODY_PT: fontSizes.body,
    TITLE_PT: fontSizes.title,
    PAGENO_PT: fontSizes.pageno,
    RANK_PT: fontSizes.rank,
  };
  const blocks: string[] = [];
  const re = /\{\s*["']BORDER_RECTS["'][\s\S]*?["']ARTIFACT_STROKES["']\s*:\s*\[[\s\S]*?\]\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) blocks.push(match[0]);
  if (blocks.length === 0 && code.includes('BORDER_RECTS') && code.includes('TEXT_CHARS')) {
    blocks.push(code);
  }
  if (blocks.length === 0 || !code.includes('TEXT_CHARS')) {
    throw new Error('未找到可编辑的 PAGES 坐标数据，请选择本工具生成的 Scribus 脚本');
  }
  return blocks.map((block, index) => ({ page: parsePageBlock(block, index, name.replace(/\.(py|txt)$/i, ''), width, height, pxPerMm, fontSizes, symbols), warnings: [] }));
}
