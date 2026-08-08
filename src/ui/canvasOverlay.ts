import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { Page } from '@/model/types';
import type { ViewTransform } from '@/store/editorStore';

export type FitMode = 'contain' | 'width';

export interface FitTransformOptions {
  padding?: number;
  /** contain=整页可见；width=按宽度适配（族谱竖长页更清晰） */
  mode?: FitMode;
  /** 按宽度适配且页面高于视口时，从顶部对齐而非垂直居中 */
  alignTop?: boolean;
}

/** 将页面缩放至视口内并居中（切换页面时的默认视图） */
export function computeFitCenterTransform(
  pageW: number,
  pageH: number,
  viewW: number,
  viewH: number,
  options: FitTransformOptions | number = {},
): ViewTransform {
  const opts: FitTransformOptions = typeof options === 'number' ? { padding: options } : options;
  const padding = opts.padding ?? 0.92;
  const mode = opts.mode ?? 'contain';
  const alignTop = opts.alignTop ?? mode === 'width';

  if (pageW <= 0 || pageH <= 0 || viewW <= 0 || viewH <= 0) {
    return { scale: 0.2, offsetX: 0, offsetY: 0 };
  }
  const scale =
    mode === 'width'
      ? (viewW / pageW) * padding
      : Math.min(viewW / pageW, viewH / pageH) * padding;
  const clamped = Math.max(0.02, Math.min(4, scale));
  const renderedH = pageH * clamped;
  const offsetY = alignTop && renderedH > viewH ? 8 : (viewH - renderedH) / 2;
  return {
    scale: clamped,
    offsetX: (viewW - pageW * clamped) / 2,
    offsetY,
  };
}

/** 将图像坐标点居中到视口（低置信跳转等） */
export function computeCenterOnPoint(
  cx: number,
  cy: number,
  viewW: number,
  viewH: number,
  scale: number,
): ViewTransform {
  return {
    scale,
    offsetX: viewW / 2 - cx * scale,
    offsetY: viewH / 2 - cy * scale,
  };
}

export interface SelectionState {
  selectedCharIds: string[];
  selectedLineId: string | null;
  selectedNodeId: string | null;
  selectedRectId: string | null;
  rubberBand: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** 在原图/校对区共用的选区与高亮 overlay（图像坐标系，已应用 scale 前调用） */
export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  page: Page,
  selection: SelectionState,
  scale: number,
  options: { showLowConf?: boolean; showRubber?: boolean; focusCharId?: string | null } = {},
): void {
  const { showLowConf = false, showRubber = true, focusCharId = null } = options;
  const inv = 1 / Math.max(0.02, scale);

  if (showLowConf) {
    ctx.lineWidth = 2 * inv;
    for (const c of page.chars) {
      if (c.conf < CONFIDENCE_THRESHOLD) {
        ctx.strokeStyle = 'rgba(220,38,38,0.85)';
        ctx.strokeRect(c.bbox[0] - 2, c.bbox[1] - 2, c.bbox[2] - c.bbox[0] + 4, c.bbox[3] - c.bbox[1] + 4);
      }
    }
  }

  ctx.strokeStyle = 'rgba(37,99,235,0.95)';
  ctx.lineWidth = 2 * inv;
  for (const c of page.chars) {
    if (selection.selectedCharIds.includes(c.id)) {
      ctx.strokeRect(c.bbox[0] - 3, c.bbox[1] - 3, c.bbox[2] - c.bbox[0] + 6, c.bbox[3] - c.bbox[1] + 6);
    }
  }

  const selLine = page.treeLines.find((l) => l.id === selection.selectedLineId);
  if (selLine) {
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = Math.max(2 * inv, selLine.widthPx + 4);
    ctx.beginPath();
    ctx.moveTo(selLine.x1, selLine.y1);
    ctx.lineTo(selLine.x2, selLine.y2);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    for (const [px, py] of [[selLine.x1, selLine.y1], [selLine.x2, selLine.y2]] as const) {
      ctx.beginPath();
      ctx.arc(px, py, 6 * inv, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const selNode = page.treeNodes.find((n) => n.id === selection.selectedNodeId);
  if (selNode) {
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = 2 * inv;
    ctx.beginPath();
    ctx.arc(selNode.cx, selNode.cy, selNode.r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  const selRect = [...page.borderRects, ...page.tagRects].find((r) => r.id === selection.selectedRectId);
  if (selRect) {
    ctx.strokeStyle = 'rgba(37,99,235,0.95)';
    ctx.lineWidth = 2 * inv;
    ctx.strokeRect(selRect.x - 3, selRect.y - 3, selRect.w + 6, selRect.h + 6);
  }

  if (showRubber && selection.rubberBand) {
    const { x0, y0, x1, y1 } = selection.rubberBand;
    ctx.strokeStyle = 'rgba(37,99,235,0.9)';
    ctx.setLineDash([4 * inv, 4 * inv]);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }

  /* 悬停/跳转预览：青色，绘制在最上层，与低置信红框、选中蓝框区分 */
  if (focusCharId) {
    const focus = page.chars.find((c) => c.id === focusCharId);
    if (focus) {
      const pad = 6;
      const x = focus.bbox[0] - pad;
      const y = focus.bbox[1] - pad;
      const w = focus.bbox[2] - focus.bbox[0] + pad * 2;
      const h = focus.bbox[3] - focus.bbox[1] + pad * 2;
      ctx.save();
      ctx.fillStyle = 'rgba(6,182,212,0.22)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(8,145,178,1)';
      ctx.lineWidth = 3.5 * inv;
      ctx.setLineDash([8 * inv, 5 * inv]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}
