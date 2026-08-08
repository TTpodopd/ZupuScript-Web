/**
 * 空白页检测：导入时跳过 PDF/图片中的无内容页。
 * 对降采样后的像素统计墨迹占比，避免全分辨率扫描开销。
 */
import {
  BLANK_PAGE_DARK_THRESHOLD,
  BLANK_PAGE_MAX_INK_RATIO,
  BLANK_PAGE_PROBE_MAX_EDGE,
} from '@/lib/constants';

export interface RasterLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** ImageData / 降采样结果 → 是否空白页 */
export function isBlankRaster(
  image: RasterLike,
  darkThreshold = BLANK_PAGE_DARK_THRESHOLD,
  maxInkRatio = BLANK_PAGE_MAX_INK_RATIO,
): boolean {
  const { data, width, height } = image;
  const total = width * height;
  if (total === 0) return true;

  const step = total > 65_536 ? 4 : 1;
  let dark = 0;
  let sampled = 0;
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (lum < darkThreshold) dark++;
    sampled++;
  }
  return dark / sampled < maxInkRatio;
}

/** Canvas → 是否空白页（PDF 拆页渲染后可直接检测） */
export function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return true;
  const scale = Math.min(1, BLANK_PAGE_PROBE_MAX_EDGE / Math.max(w, h));
  if (scale >= 1) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    return isBlankRaster(ctx.getImageData(0, 0, w, h));
  }
  const probe = document.createElement('canvas');
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  probe.width = pw;
  probe.height = ph;
  const pctx = probe.getContext('2d')!;
  pctx.fillStyle = '#ffffff';
  pctx.fillRect(0, 0, pw, ph);
  pctx.drawImage(canvas, 0, 0, pw, ph);
  return isBlankRaster(pctx.getImageData(0, 0, pw, ph));
}

/** Blob / File → 是否空白页（图片导入用） */
export async function isBlankImageBlob(blob: Blob): Promise<boolean> {
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, BLANK_PAGE_PROBE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return isBlankRaster(ctx.getImageData(0, 0, w, h));
  } finally {
    bmp.close();
  }
}
