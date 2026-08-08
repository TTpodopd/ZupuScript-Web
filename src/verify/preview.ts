/**
 * 重建预览渲染（F9.1）：按生成数据在 Canvas 上渲染重建位图，
 * 校对台右栏与质检报告共用。尺寸与原图一致（像素坐标系）。
 */
import { MM_PER_PT } from '@/lib/constants';
import type { Page } from '@/model/types';

export const PREVIEW_FONT_FAMILY = '"Noto Serif CJK TC", "Source Han Serif TC", "Noto Serif CJK SC", "SimSun", serif';
/** v7 脚本直接使用 Scribus pt，不额外放大浏览器预览。 */
export const PREVIEW_FONT_SCALE = 1;

/** 字号 pt → 像素字高（与生成脚本 mm(px) 换算互为逆运算） */
export function ptToPx(pt: number, pxPerMm: number): number {
  return pt * MM_PER_PT * pxPerMm;
}

/**
 * 渲染重建预览到指定 canvas（1:1 原图尺寸）。
 * 黑底白字？不——白底黑墨，与原图同方向，便于叠加比对。
 */
export function renderPreviewToCanvas(page: Page, canvas: HTMLCanvasElement): void {
  const w = page.source.widthPx;
  const h = page.source.heightPx;
  const pxPerMm = page.calibration.pxPerMm || 1;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  // 外框实心黑条与装饰块
  for (const r of [...page.borderRects, ...page.tagRects]) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  // v7 黑标底部的白色折角，按黑标矩形相对位置复原。
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'butt';
  for (const r of page.tagRects) {
    if (r.w < 40 || r.h < 40) continue;
    const y = r.y + r.h * 0.77;
    const midX = r.x + r.w * 0.50;
    ctx.lineWidth = Math.max(1, r.w * 0.10);
    ctx.beginPath();
    ctx.moveTo(r.x + r.w * 0.12, y + r.h * 0.23);
    ctx.lineTo(midX, y);
    ctx.lineTo(r.x + r.w * 0.88, y + r.h * 0.23);
    ctx.stroke();
  }
  // 谱系连线
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'butt';
  for (const l of page.treeLines) {
    ctx.lineWidth = Math.max(1, l.widthPx);
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  // 节点空心圆
  for (const n of page.treeNodes) {
    ctx.lineWidth = Math.max(1, n.strokePx);
    ctx.beginPath();
    ctx.arc(n.cx, n.cy, n.r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.arc(n.cx, n.cy, n.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 破损痕迹
  ctx.strokeStyle = '#777777';
  for (const a of page.artifacts) {
    ctx.lineWidth = Math.max(1, a.widthPx);
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
  }
  // 字符（按中心绘制）
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of page.chars) {
    if (!c.text || c.pt <= 0) continue;
    const fontPx = ptToPx(c.pt, pxPerMm) * PREVIEW_FONT_SCALE;
    ctx.font = `500 ${fontPx}px ${PREVIEW_FONT_FAMILY}`;
    ctx.fillText(c.text, c.cx, c.cy);
  }
}

/** 渲染重建预览的二值矩阵（供 IoU 计算；1=墨迹） */
export function renderPreviewBinary(page: Page): Uint8Array {
  const canvas = document.createElement('canvas');
  renderPreviewToCanvas(page, canvas);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = img.data[i] < 128 ? 1 : 0;
  }
  return out;
}

/** canvas → PNG dataURL（报告内联用） */
export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}
