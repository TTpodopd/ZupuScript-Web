/**
 * B 模式字符拼图构造（F4.4 / 7.2 最小上行原则）：
 * - 每批 ≤100 字，10×N 网格，编号打乱（模型拿不到阅读顺序与上下文）；
 * - 单字统一缩到 64×64 白底黑字 PNG（成本控制：分辨率下采样 + 二值化压缩）；
 * - 左上角红色编号，模型按「编号 → 字」JSON 返回，本地按编号映回原坐标。
 */
import { GRID_BATCH_SIZE, GRID_CELL_PX, GRID_COLS } from '@/lib/constants';
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

/** 单字二值裁剪 → 64×64 白底居中 ImageData 像素绘制辅助 */
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
  // 等比缩放到 ≤ 48×48（留边放编号）
  const inner = GRID_CELL_PX - 16;
  const scale = Math.min(inner / crop.width, inner / crop.height, 4); // 最多放大 4 倍
  const dw = Math.max(1, Math.round(crop.width * scale));
  const dh = Math.max(1, Math.round(crop.height * scale));
  // 最近邻缩放并画黑像素
  const img = ctx.createImageData(dw, dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(crop.width - 1, Math.floor(x / scale));
      const sy = Math.min(crop.height - 1, Math.floor(y / scale));
      const ink = crop.data[sy * crop.width + sx];
      const o = (y * dw + x) * 4;
      const v = ink ? 0 : 255;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
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
    // 红色编号（左上角）
    ctx.fillStyle = '#d00';
    ctx.font = 'bold 11px sans-serif';
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
  const img = ctx.createImageData(width, height);
  for (let i = 0, j = 0; j < bin.length; i += 4, j++) {
    const v = bin[j] ? 0 : 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToPngBase64(canvas);
}
