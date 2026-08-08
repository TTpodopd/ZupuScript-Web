import type { ViewTransform } from '@/store/editorStore';

export const RULER_SIZE = 22;

export interface RulerGuide {
  x?: number;
  y?: number;
  color?: string;
}

export interface RulerOptions {
  viewW: number;
  viewH: number;
  pageW: number;
  pageH: number;
  transform: ViewTransform;
  cursor?: { x: number; y: number } | null;
  guides?: RulerGuide[];
}

function pickStep(scale: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  for (const step of steps) {
    if (step * scale >= 36) return step;
  }
  return steps[steps.length - 1];
}

function imageToScreenX(x: number, transform: ViewTransform): number {
  return x * transform.scale + transform.offsetX;
}

function imageToScreenY(y: number, transform: ViewTransform): number {
  return y * transform.scale + transform.offsetY;
}

function drawGuidesVertical(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  guides: RulerGuide[],
  transform: ViewTransform,
): void {
  for (const g of guides) {
    if (g.x === undefined) continue;
    const sx = imageToScreenX(g.x, transform);
    if (sx < 0 || sx > width) continue;
    ctx.strokeStyle = g.color ?? '#2563eb';
    ctx.lineWidth = 1;
    ctx.setLineDash(g.color?.includes('0.') ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, 0);
    ctx.lineTo(sx + 0.5, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawGuidesHorizontal(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  guides: RulerGuide[],
  transform: ViewTransform,
): void {
  for (const g of guides) {
    if (g.y === undefined) continue;
    const sy = imageToScreenY(g.y, transform);
    if (sy < 0 || sy > height) continue;
    ctx.strokeStyle = g.color ?? '#2563eb';
    ctx.lineWidth = 1;
    ctx.setLineDash(g.color?.includes('0.') ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(0, sy + 0.5);
    ctx.lineTo(width, sy + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawHorizontalRuler(ctx: CanvasRenderingContext2D, width: number, options: RulerOptions): void {
  const { transform, pageW } = options;
  const h = RULER_SIZE;
  ctx.clearRect(0, 0, width, h);
  ctx.fillStyle = '#eceae4';
  ctx.fillRect(0, 0, width, h);
  ctx.strokeStyle = '#b8b4aa';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(width, h - 0.5);
  ctx.stroke();

  const step = pickStep(transform.scale);
  const startX = Math.max(0, Math.floor(-transform.offsetX / transform.scale / step) * step);
  const endX = Math.min(pageW, Math.ceil((width - transform.offsetX) / transform.scale / step) * step);

  for (let x = startX; x <= endX; x += step) {
    const sx = imageToScreenX(x, transform);
    if (sx < -24 || sx > width + 24) continue;
    const major = step >= 50 || x % (step * 5) === 0;
    const tickH = major ? 10 : 6;
    ctx.strokeStyle = major ? '#78716c' : '#a8a29e';
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, h);
    ctx.lineTo(sx + 0.5, h - tickH);
    ctx.stroke();
  }

  if (options.cursor) {
    const sx = imageToScreenX(options.cursor.x, transform);
    if (sx >= 0 && sx <= width) {
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, 0);
      ctx.lineTo(sx + 0.5, h);
      ctx.stroke();
    }
  }

  drawGuidesVertical(ctx, width, h, options.guides ?? [], transform);
}

export function drawVerticalRuler(ctx: CanvasRenderingContext2D, height: number, options: RulerOptions): void {
  const { transform, pageH } = options;
  const w = RULER_SIZE;
  ctx.clearRect(0, 0, w, height);
  ctx.fillStyle = '#eceae4';
  ctx.fillRect(0, 0, w, height);
  ctx.strokeStyle = '#b8b4aa';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w - 0.5, 0);
  ctx.lineTo(w - 0.5, height);
  ctx.stroke();

  const step = pickStep(transform.scale);
  const startY = Math.max(0, Math.floor(-transform.offsetY / transform.scale / step) * step);
  const endY = Math.min(pageH, Math.ceil((height - transform.offsetY) / transform.scale / step) * step);

  for (let y = startY; y <= endY; y += step) {
    const sy = imageToScreenY(y, transform);
    if (sy < -24 || sy > height + 24) continue;
    const major = step >= 50 || y % (step * 5) === 0;
    const tickW = major ? 10 : 6;
    ctx.strokeStyle = major ? '#78716c' : '#a8a29e';
    ctx.beginPath();
    ctx.moveTo(w, sy + 0.5);
    ctx.lineTo(w - tickW, sy + 0.5);
    ctx.stroke();
  }

  if (options.cursor) {
    const sy = imageToScreenY(options.cursor.y, transform);
    if (sy >= 0 && sy <= height) {
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, sy + 0.5);
      ctx.lineTo(w, sy + 0.5);
      ctx.stroke();
    }
  }

  drawGuidesHorizontal(ctx, w, height, options.guides ?? [], transform);
}

/** 在画布上绘制十字参考线（图像坐标） */
export function drawCanvasCrosshair(
  ctx: CanvasRenderingContext2D,
  options: RulerOptions,
): void {
  const { viewW, viewH, transform, cursor, guides = [] } = options;
  if (cursor) {
    const sx = imageToScreenX(cursor.x, transform);
    const sy = imageToScreenY(cursor.y, transform);
    ctx.save();
    ctx.strokeStyle = 'rgba(220,38,38,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (sx >= 0 && sx <= viewW) {
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, 0);
      ctx.lineTo(sx + 0.5, viewH);
      ctx.stroke();
    }
    if (sy >= 0 && sy <= viewH) {
      ctx.beginPath();
      ctx.moveTo(0, sy + 0.5);
      ctx.lineTo(viewW, sy + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawGuidesVertical(ctx, viewW, viewH, guides, transform);
  drawGuidesHorizontal(ctx, viewW, viewH, guides, transform);
}

export function buildSelectionRulerGuides(
  chars: { cx: number; cy: number; bbox: [number, number, number, number] }[],
): RulerGuide[] {
  if (chars.length === 0) return [];
  const guides: RulerGuide[] = [];
  for (const c of chars) {
    guides.push({ x: Math.round(c.cx), color: '#2563eb' }, { y: Math.round(c.cy), color: '#2563eb' });
  }
  if (chars.length === 1) {
    const c = chars[0];
    guides.push(
      { x: Math.round(c.bbox[0]), color: 'rgba(37,99,235,0.45)' },
      { x: Math.round(c.bbox[2]), color: 'rgba(37,99,235,0.45)' },
      { y: Math.round(c.bbox[1]), color: 'rgba(37,99,235,0.45)' },
      { y: Math.round(c.bbox[3]), color: 'rgba(37,99,235,0.45)' },
    );
  } else {
    const x0 = Math.min(...chars.map((c) => c.bbox[0]));
    const x1 = Math.max(...chars.map((c) => c.bbox[2]));
    const y0 = Math.min(...chars.map((c) => c.bbox[1]));
    const y1 = Math.max(...chars.map((c) => c.bbox[3]));
    guides.push(
      { x: Math.round(x0), color: 'rgba(37,99,235,0.45)' },
      { x: Math.round(x1), color: 'rgba(37,99,235,0.45)' },
      { y: Math.round(y0), color: 'rgba(37,99,235,0.45)' },
      { y: Math.round(y1), color: 'rgba(37,99,235,0.45)' },
    );
  }
  return guides;
}
