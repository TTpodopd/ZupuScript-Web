/**
 * 全部核心类型定义（契约见 docs/ARCHITECTURE.md 第 3 章）。
 * 坐标系约定：一律原图像素坐标；字符/节点 = 中心 (cx, cy)；矩形 = 左上 (x, y, w, h)；线段 = 两端点。
 */
import type { ProviderId } from '@/recognize/types';

export type PageStatus = 'imported' | 'preprocessed' | 'analyzed' | 'recognized' | 'proofread' | 'exported';
/** A 全本地 / B 拼图上云(默认) / C 整页上云 */
export type PrivacyMode = 'A' | 'B' | 'C';
export type CharSource = 'llm' | 'local' | 'manual';
export type CharNote = 'ok' | 'blurry' | 'damaged' | 'multi' | 'empty';
export type FontGroup = 'body' | 'title' | 'pageno' | 'rank';
/** side = 书名/页码竖排字 → 生成 SIDE_CHARS */
export type CharKind = 'text' | 'side';
export type Orientation = 'h' | 'v';

export interface CharItem {
  id: string;
  /** 只认不猜：看不清为 null */
  text: string | null;
  /** 原图像素中心坐标 */
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
  /** 标定后字号（pt），未标定为 0 */
  pt: number;
  /** 0..1，<0.85 标红 */
  conf: number;
  note: CharNote;
  source: CharSource;
  edited: boolean;
  group: FontGroup;
  kind: CharKind;
}

export interface BorderRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TagRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreeLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 像素厚度 */
  widthPx: number;
  orientation: Orientation;
}

export interface TreeNode {
  id: string;
  cx: number;
  cy: number;
  r: number;
  strokePx: number;
}

export interface ArtifactStroke {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  widthPx: number;
}

export interface SourceInfo {
  name: string;
  page?: number;
  widthPx: number;
  heightPx: number;
  dpi: number;
}

export interface Calibration {
  /** 预处理（DPI 归一）后写入并锁定，全链路不得改 */
  pxPerMm: number;
  pageMm: [number, number];
  deskewDeg: number;
}

export interface FontSizes {
  body: number;
  title: number;
  pageno: number;
  rank: number;
}

export interface RecognitionMeta {
  mode: PrivacyMode;
  provider: ProviderId;
  model: string;
  batches: number;
  costEstimateCny: number;
}

export interface Page {
  id: string;
  projectId: string;
  index: number;
  status: PageStatus;
  source: SourceInfo;
  calibration: Calibration;
  fontSizes: FontSizes;
  borderRects: BorderRect[];
  tagRects: TagRect[];
  treeLines: TreeLine[];
  treeNodes: TreeNode[];
  chars: CharItem[];
  artifacts: ArtifactStroke[];
  recognition?: RecognitionMeta;
  /** OPFS / idb Blob 中的原图键 */
  imageKey: string;
  /** OPFS 中二值图键（预处理后） */
  binaryKey?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
}

/** 创建空 Page 的工厂（字段默认值集中在此，避免散落） */
export function createEmptyPage(
  id: string,
  projectId: string,
  index: number,
  source: SourceInfo,
  imageKey: string,
): Page {
  return {
    id,
    projectId,
    index,
    status: 'imported',
    source,
    calibration: { pxPerMm: 0, pageMm: [0, 0], deskewDeg: 0 },
    fontSizes: { body: 0, title: 0, pageno: 0, rank: 0 },
    borderRects: [],
    tagRects: [],
    treeLines: [],
    treeNodes: [],
    chars: [],
    artifacts: [],
    imageKey,
  };
}
