/**
 * 全部核心类型定义（契约见 docs/ARCHITECTURE.md 第 3 章）。
 * 坐标系约定：一律原图像素坐标；字符/节点 = 中心 (cx, cy)；矩形 = 左上 (x, y, w, h)；线段 = 两端点。
 */
import type { ProviderId } from '@/recognize/types';

export type PageStatus = 'imported' | 'preprocessed' | 'analyzed' | 'recognized' | 'proofread' | 'exported';
/** 资料来源：扫描图 / PDF 拆页 / 脚本导入 */
export type SourceKind = 'image' | 'pdf' | 'script';
/** A 全本地 / B 拼图上云（遗留） / C 整页上云（远端默认） */
export type PrivacyMode = 'A' | 'B' | 'C';
export type CharSource = 'llm' | 'local' | 'manual';
export type CharNote = 'ok' | 'blurry' | 'damaged' | 'multi' | 'empty' | 'split' | 'merge' | 'spacing';
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
  /** 资料类型；旧项目可省略，运行时由 resolveSourceKind 推断 */
  kind?: SourceKind;
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
  /** 识别完成时的设置签名（模式+连接+模型），用于检测切换后需重跑 */
  settingsKey?: string;
}

/** 视觉模型输出的边框定位与检测规则（0–1 归一化坐标，原点在左上） */
export interface BorderLayoutBar {
  role: 'frame' | 'divider' | 'decoration';
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 归一化 x（0–1） */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface BorderLayoutGuide {
  version: string;
  confidence: number;
  /** 一页话概述页框形态 */
  summary: string;
  /** 供本地 CV 参考的检测规则（自然语言） */
  rules: string[];
  frame: {
    hasOuterFrame: boolean;
    /** 页框相对页面边缘的内缩量（0–1） */
    inset?: { top: number; right: number; bottom: number; left: number };
    /** 估计线宽（像素，基于附件图尺寸） */
    thicknessPx?: number;
  };
  borderBars: BorderLayoutBar[];
  tagBlocks: Array<{ x: number; y: number; w: number; h: number; confidence: number }>;
  /** 不应误判为边框的区域（如空白页边、正文竖列） */
  excludeZones: Array<{ x: number; y: number; w: number; h: number; reason: string }>;
  /** 模型与调用元数据 */
  meta?: { provider: string; model: string; analyzedAt: number };
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
  /** 视觉模型边框定位规则（版面分析时生成，供检测与渲染参考） */
  borderLayoutGuide?: BorderLayoutGuide;
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
