/**
 * .zpproj.json 序列化 / 反序列化 / 迁移（PRD 第 13 章，version "2.0"）。
 * 项目文件不包含原图、不包含密钥，可安全传阅。
 */
import type { Calibration, CharItem, FontSizes, Page, Project, RecognitionMeta } from './types';
import { createEmptyPage } from './types';
import { uuid } from '@/lib/utils';

export const ZPPROJ_VERSION = '2.0';

/** .zpproj.json 单页结构（字段名与 PRD 13 章一致，紧凑命名） */
interface ZpprojPageJson {
  version: string;
  source: { name: string; kind?: 'image' | 'pdf' | 'script'; page?: number; width_px: number; height_px: number; dpi?: number };
  calibration: { px_per_mm: number; page_mm: [number, number]; deskew_deg: number };
  font_sizes: FontSizes;
  recognition?: {
    mode: 'A' | 'B' | 'C';
    provider: string;
    model: string;
    batches: number;
    cost_estimate_cny: number;
  };
  border_rects: Array<[number, number, number, number]>;
  tag_rects?: Array<[number, number, number, number]>;
  tree_lines: Array<[number, number, number, number, number]>;
  tree_nodes: Array<[number, number, number, number]>;
  chars: Array<{
    text: string | null;
    cx: number;
    cy: number;
    pt: number;
    conf: number;
    bbox: [number, number, number, number];
    source: 'llm' | 'local' | 'manual';
    edited: boolean;
    note?: CharItem['note'];
    group?: CharItem['group'];
    kind?: CharItem['kind'];
  }>;
  artifacts: Array<[number, number, number, number, number]>;
  history: unknown[];
}

/** 完整项目导出格式（多页） */
export interface ZpprojFile {
  app: 'zupuscript-web';
  version: string;
  name: string;
  exportedAt: number;
  pages: ZpprojPageJson[];
}

function pageToJson(page: Page): ZpprojPageJson {
  return {
    version: ZPPROJ_VERSION,
    source: {
      name: page.source.name,
      kind: page.source.kind,
      page: page.source.page,
      width_px: page.source.widthPx,
      height_px: page.source.heightPx,
      dpi: page.source.dpi,
    },
    calibration: {
      px_per_mm: page.calibration.pxPerMm,
      page_mm: page.calibration.pageMm,
      deskew_deg: page.calibration.deskewDeg,
    },
    font_sizes: { ...page.fontSizes },
    recognition: page.recognition
      ? {
          mode: page.recognition.mode,
          provider: page.recognition.provider,
          model: page.recognition.model,
          batches: page.recognition.batches,
          cost_estimate_cny: page.recognition.costEstimateCny,
        }
      : undefined,
    border_rects: page.borderRects.map((r) => [r.x, r.y, r.w, r.h]),
    tag_rects: page.tagRects.map((r) => [r.x, r.y, r.w, r.h]),
    tree_lines: page.treeLines.map((l) => [l.x1, l.y1, l.x2, l.y2, l.widthPx]),
    tree_nodes: page.treeNodes.map((n) => [n.cx, n.cy, n.r, n.strokePx]),
    chars: page.chars.map((c) => ({
      text: c.text,
      cx: c.cx,
      cy: c.cy,
      pt: c.pt,
      conf: c.conf,
      bbox: c.bbox,
      source: c.source,
      edited: c.edited,
      note: c.note,
      group: c.group,
      kind: c.kind,
    })),
    artifacts: page.artifacts.map((a) => [a.x1, a.y1, a.x2, a.y2, a.widthPx]),
    history: [],
  };
}

/** 导出整个项目为 .zpproj.json 文本（UTF-8 无 BOM，不含原图与密钥） */
export function exportProject(project: Project, pages: Page[]): string {
  const file: ZpprojFile = {
    app: 'zupuscript-web',
    version: ZPPROJ_VERSION,
    name: project.name,
    exportedAt: Date.now(),
    pages: pages
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(pageToJson),
  };
  return JSON.stringify(file, null, 2);
}

function jsonToPage(json: ZpprojPageJson, projectId: string, index: number): Page {
  const width = json.source?.width_px ?? 0;
  const height = json.source?.height_px ?? 0;
  const page = createEmptyPage(
    uuid(),
    projectId,
    index,
    {
      name: json.source?.name ?? `page-${index + 1}`,
      kind: json.source?.kind,
      page: json.source?.page,
      widthPx: width,
      heightPx: height,
      dpi: json.source?.dpi ?? 0,
    },
    '', // 原图不在项目文件内，imageKey 留空，需用户重新关联
  );
  const cal: Calibration = {
    pxPerMm: json.calibration?.px_per_mm ?? 0,
    pageMm: json.calibration?.page_mm ?? [0, 0],
    deskewDeg: json.calibration?.deskew_deg ?? 0,
  };
  page.calibration = cal;
  const fs: Partial<FontSizes> = json.font_sizes ?? {};
  page.fontSizes = { body: fs.body ?? 0, title: fs.title ?? 0, pageno: fs.pageno ?? 0, rank: fs.rank ?? 0 };
  if (json.recognition) {
    const meta: RecognitionMeta = {
      mode: json.recognition.mode,
      provider: (json.recognition.provider as RecognitionMeta['provider']) ?? 'custom',
      model: json.recognition.model ?? '',
      batches: json.recognition.batches ?? 0,
      costEstimateCny: json.recognition.cost_estimate_cny ?? 0,
    };
    page.recognition = meta;
  }
  page.borderRects = (json.border_rects ?? []).map(([x, y, w, h]) => ({ id: uuid(), x, y, w, h }));
  page.tagRects = (json.tag_rects ?? []).map(([x, y, w, h]) => ({ id: uuid(), x, y, w, h }));
  page.treeLines = (json.tree_lines ?? []).map(([x1, y1, x2, y2, widthPx]) => ({
    id: uuid(),
    x1,
    y1,
    x2,
    y2,
    widthPx,
    orientation: Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? ('h' as const) : ('v' as const),
  }));
  page.treeNodes = (json.tree_nodes ?? []).map(([cx, cy, r, strokePx]) => ({ id: uuid(), cx, cy, r, strokePx }));
  page.chars = (json.chars ?? []).map((c) => ({
    id: uuid(),
    text: c.text ?? null,
    cx: c.cx,
    cy: c.cy,
    bbox: c.bbox,
    pt: c.pt ?? 0,
    conf: c.conf ?? 0,
    note: c.note ?? 'ok',
    source: c.source ?? 'manual',
    edited: c.edited ?? false,
    group: c.group ?? 'body',
    kind: c.kind ?? 'text',
  }));
  page.artifacts = (json.artifacts ?? []).map(([x1, y1, x2, y2, widthPx]) => ({ id: uuid(), x1, y1, x2, y2, widthPx }));
  // 有字符数据即视为已校对过（保守状态）
  if (page.chars.length > 0) page.status = 'proofread';
  return page;
}

export interface ImportedProject {
  project: Project;
  pages: Page[];
}

/** 导入 .zpproj.json（含版本校验与字段默认值补齐） */
export function importProject(jsonText: string): ImportedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error('项目文件不是合法的 JSON');
  }
  const file = raw as Partial<ZpprojFile>;
  if (file.app !== 'zupuscript-web' || !Array.isArray(file.pages)) {
    throw new Error('不是有效的 .zpproj.json 项目文件');
  }
  const major = String(file.version ?? '').split('.')[0];
  if (major !== '2') {
    throw new Error(`不支持的项目版本：${file.version ?? '未知'}（当前支持 2.x）`);
  }
  const now = Date.now();
  const project: Project = {
    id: uuid(),
    name: file.name || '导入的项目',
    createdAt: now,
    updatedAt: now,
    pageIds: [],
  };
  const pages = file.pages.map((p, i) => jsonToPage(p, project.id, i));
  project.pageIds = pages.map((p) => p.id);
  return { project, pages };
}
