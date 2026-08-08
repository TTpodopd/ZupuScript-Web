import type { BorderRect, TagRect } from '@/model/types';

/** 实心边条的真实线宽（取短边） */
export function borderBarThickness(rect: Pick<BorderRect, 'w' | 'h'>): number {
  return Math.max(1, Math.min(rect.w, rect.h));
}

/** 按条带方向绘制实心边条，避免把宽松包围盒整块涂黑 */
export function drawBorderBar(ctx: CanvasRenderingContext2D, rect: BorderRect): void {
  const t = borderBarThickness(rect);
  if (rect.w >= rect.h * 2.5) {
    ctx.fillRect(rect.x, rect.y, rect.w, t);
    return;
  }
  if (rect.h >= rect.w * 2.5) {
    ctx.fillRect(rect.x, rect.y, t, rect.h);
    return;
  }
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

/** 装饰实心块：整块填黑 + 可选白色折角（书标） */
export function drawTagBlock(ctx: CanvasRenderingContext2D, rect: TagRect): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(Math.floor(rect.x), Math.floor(rect.y), rect.w, rect.h);
  if (rect.w < 40 || rect.h < 40) return;
  const y = rect.y + rect.h * 0.77;
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'butt';
  ctx.lineWidth = Math.max(1, rect.w * 0.1);
  ctx.beginPath();
  ctx.moveTo(rect.x + rect.w * 0.12, y + rect.h * 0.23);
  ctx.lineTo(rect.x + rect.w * 0.5, y);
  ctx.lineTo(rect.x + rect.w * 0.88, y + rect.h * 0.23);
  ctx.stroke();
}
