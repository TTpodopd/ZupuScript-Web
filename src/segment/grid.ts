/**
 * B 模式字符拼图构造（F4.4 / 7.2 最小上行原则）：
 * - 每批 ≤100 字，10×N 网格，编号打乱（模型拿不到阅读顺序与上下文）；
 * - 单字统一缩到 128×128 白底黑字 PNG（木刻版繁体笔画密，分辨率足够才能保笔画完整）；
 * - 缩放策略：缩小用面积平均（防锯齿混叠），放大用双线性（防最近邻锯齿断笔）；
 * - 二值裁剪后做 1px 形态学闭运算，修补木刻版的细小断笔；
 * - 左上角红色编号，模型按「编号 → 字」JSON 返回，本地按编号映回原坐标。
 */
import {
  GRID_BATCH_SIZE,
  GRID_CELL_PAD,
  GRID_CELL_PX,
  GRID_CLOSE_RADIUS,
  GRID_COLS,
  GRID_LABEL_FONT_PX,
} from '@/lib/constants';
import { cropBinary } from '@/imaging/raster';
import type { CharItem } from '@/model/types';
import type { GridBatch } from '@/recognize/types';
import { arrayBufferToBase64, fnv1a } from '@/lib/utils';

/** 生成 0..n-1 的随机置换（Fisher–Yates，编号打乱） */
function shuffledPermutation(n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/**
 * 形态学闭运算（先膨胀后腐蚀，正方形核，半径 radius 像素）。
 * 用途：修补木刻版扫描造成的 1~2px 断笔/缺口，不改变字形轮廓。
 */
export function closeBinary(data: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (radius <= 0 || width === 0 || height === 0) return data;
  const dilate = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let dy = -radius; dy <= radius && !v; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          const row = yy * width;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < width && src[row + xx]) {
              v = 1;
              break;
            }
          }
        }
        out[y * width + x] = v;
      }
    }
    return out;
  };
  const erode = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 1;
        for (let dy = -radius; dy <= radius && v; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) {
            v = 0;
            break;
          }
          const row = yy * width;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width || !src[row + xx]) {
              v = 0;
              break;
            }
          }
        }
        out[y * width + x] = v;
      }
    }
    return out;
  };
  return erode(dilate(data));
}

/**
 * 二值图 → 目标尺寸墨迹覆盖度（0..255，255=纯墨）。
 * 缩小 = 面积平均（每个目标像素按源像素覆盖权重求均值，消除锯齿混叠）；
 * 放大 = 双线性插值（平滑无锯齿，避免最近邻放大产生的断笔错觉）。
 */
export function scaleCoverage(bin: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, dw) * Math.max(0, dh));
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;
  if (dw <= sw && dh <= sh) {
    // ---- 面积平均下采样 ----
    const xRatio = sw / dw;
    const yRatio = sh / dh;
    for (let y = 0; y < dh; y++) {
      const sy0 = y * yRatio;
      const sy1 = (y + 1) * yRatio;
      const iy0 = Math.floor(sy0);
      const iy1 = Math.min(sh, Math.ceil(sy1));
      for (let x = 0; x < dw; x++) {
        const sx0 = x * xRatio;
        const sx1 = (x + 1) * xRatio;
        const ix0 = Math.floor(sx0);
        const ix1 = Math.min(sw, Math.ceil(sx1));
        let sum = 0;
        let area = 0;
        for (let iy = iy0; iy < iy1; iy++) {
          const wy = Math.min(iy + 1, sy1) - Math.max(iy, sy0);
          const row = iy * sw;
          for (let ix = ix0; ix < ix1; ix++) {
            const wx = Math.min(ix + 1, sx1) - Math.max(ix, sx0);
            const wgt = wx * wy;
            sum += bin[row + ix] * wgt;
            area += wgt;
          }
        }
        out[y * dw + x] = area > 0 ? Math.round((sum / area) * 255) : 0;
      }
    }
  } else {
    // ---- 双线性上采样 ----
    for (let y = 0; y < dh; y++) {
      const sy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / dh - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fy = sy - y0;
      for (let x = 0; x < dw; x++) {
        const sx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / dw - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(sw - 1, x0 + 1);
        const fx = sx - x0;
        const v00 = bin[y0 * sw + x0];
        const v10 = bin[y0 * sw + x1];
        const v01 = bin[y1 * sw + x0];
        const v11 = bin[y1 * sw + x1];
        const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
        out[y * dw + x] = Math.round(v * 255);
      }
    }
  }
  return out;
}

/** 单字二值裁剪 → 闭运算修断笔 → 平滑缩放到单元格 → 白底居中绘制 */
function drawCharIntoCell(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  bbox: [number, number, number, number],
  cellX: number,
  cellY: number,
): void {
  const pad = 4;
  const crop = cropBinary(
    bin,
    pageWidth,
    pageHeight,
    bbox[0] - pad,
    bbox[1] - pad,
    bbox[2] - bbox[0] + pad * 2,
    bbox[3] - bbox[1] + pad * 2,
  );
  if (crop.width === 0 || crop.height === 0) return;
  // 形态学闭运算：修补木刻版细小断笔（半径 1px，不改字形轮廓）
  const closed = closeBinary(crop.data, crop.width, crop.height, GRID_CLOSE_RADIUS);
  // 等比缩放到单元格内部绘制区（四周与顶部留编号位）
  const inner = GRID_CELL_PX - GRID_CELL_PAD * 2;
  const scale = Math.min(inner / crop.width, inner / crop.height, 4); // 最多放大 4 倍
  const dw = Math.max(1, Math.round(crop.width * scale));
  const dh = Math.max(1, Math.round(crop.height * scale));
  // 平滑缩放（面积平均/双线性）并绘制，白底黑字带抗锯齿灰度
  const cov = scaleCoverage(closed, crop.width, crop.height, dw, dh);
  const img = ctx.createImageData(dw, dh);
  for (let i = 0; i < cov.length; i++) {
    const v = 255 - cov[i];
    const o = i * 4;
    img.data[o] = v;
    img.data[o + 1] = v;
    img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  const ox = cellX + Math.round((GRID_CELL_PX - dw) / 2);
  const oy = cellY + Math.round((GRID_CELL_PX - dh) / 2) + 4; // 编号占位下移
  ctx.putImageData(img, ox, oy);
}

async function canvasToPngBase64(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    const htmlCanvas = canvas as HTMLCanvasElement;
    blob = await new Promise<Blob>((resolve, reject) => {
      htmlCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('拼图编码失败'))), 'image/png');
    });
  }
  return arrayBufferToBase64(await blob.arrayBuffer());
}

/**
 * 构造一批拼图。
 * @param chars 本批字符（调用方已按 GRID_BATCH_SIZE 切分）
 * @returns GridBatch，ids[显示编号] = chars 下标（编号已打乱）
 */
export async function buildGridBatch(
  chars: CharItem[],
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  batchIndex: number,
): Promise<GridBatch> {
  const n = chars.length;
  const cols = Math.min(GRID_COLS, n);
  const rows = Math.ceil(n / cols);
  const width = cols * GRID_CELL_PX;
  const height = rows * GRID_CELL_PX;

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    canvas = c;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const perm = shuffledPermutation(n); // perm[i] = 第 i 格的显示编号
  const ids: number[] = new Array(n); // ids[显示编号] = chars 下标
  for (let i = 0; i < n; i++) {
    const displayId = perm[i];
    ids[displayId] = i;
    const cellX = (i % cols) * GRID_CELL_PX;
    const cellY = Math.floor(i / cols) * GRID_CELL_PX;
    // 红色编号（左上角，14px 与 128px 单元格匹配，保证模型可读）
    ctx.fillStyle = '#d00';
    ctx.font = `bold ${GRID_LABEL_FONT_PX}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(String(displayId), cellX + 2, cellY + 1);
    drawCharIntoCell(ctx, bin, pageWidth, pageHeight, chars[i].bbox, cellX, cellY);
  }

  const imageBase64Png = await canvasToPngBase64(canvas);
  return { batchIndex, imageBase64Png, ids };
}

/** 把整页字符切成 ≤100 字/批，逐批构造拼图 */
export async function buildAllGrids(
  chars: CharItem[],
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
): Promise<GridBatch[]> {
  const batches: GridBatch[] = [];
  for (let start = 0, idx = 0; start < chars.length; start += GRID_BATCH_SIZE, idx++) {
    const slice = chars.slice(start, start + GRID_BATCH_SIZE);
    batches.push(await buildGridBatch(slice, bin, pageWidth, pageHeight, idx));
  }
  return batches;
}

/** 批内容哈希（结果缓存键：同图不同批互不冲突） */
export function hashBatch(chars: CharItem[], batchIndex: number): string {
  const sig = chars.map((c) => c.bbox.join(',')).join('|');
  return fnv1a(`${batchIndex}:${chars.length}:${sig}`);
}

/** 整页二值图 → PNG base64（C 模式整页上行） */
export async function pageBinaryToPngBase64(bin: Uint8Array, width: number, height: number): Promise<string> {
  return pageBinaryToPngBase64Downscaled(bin, width, height, Math.max(width, height));
}

/** 整页二值图 → 限长边 PNG base64（版面视觉分析等轻量上行） */
export async function pageBinaryToPngBase64Downscaled(
  bin: Uint8Array,
  width: number,
  height: number,
  maxEdge: number,
): Promise<string> {
  const longest = Math.max(width, height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(outW, outH);
  } else {
    const c = document.createElement('canvas');
    c.width = outW;
    c.height = outH;
    canvas = c;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (scale >= 0.999) {
    const img = ctx.createImageData(width, height);
    for (let i = 0, j = 0; j < bin.length; i += 4, j += 1) {
      const v = bin[j] ? 0 : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    const img = ctx.createImageData(outW, outH);
    for (let y = 0; y < outH; y += 1) {
      const sy = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < outW; x += 1) {
        const sx = Math.min(width - 1, Math.floor(x / scale));
        const v = bin[sy * width + sx] ? 0 : 255;
        const o = (y * outW + x) * 4;
        img.data[o] = v;
        img.data[o + 1] = v;
        img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvasToPngBase64(canvas);
}
