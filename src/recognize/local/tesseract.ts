/**
 * 本地兜底识别（F4.11）：Tesseract.js chi_tra，经 Comlink 隔离在 ocr.worker。
 * 多裁剪、多方向投票后返回校准置信度；云端失败降级时由编排器决定是否标红。
 * 无密钥也能跑完全流程；图像不出本机。
 */
import * as Comlink from 'comlink';
import { cropBinary } from '@/imaging/raster';
import type { CharItem } from '@/model/types';
import { arrayBufferToBase64 } from '@/lib/utils';

export interface OcrWorkerAPI {
  ocrChars(items: Array<{ key: string; dataUrls: string[] }>): Promise<LocalOcrResult[]>;
  terminate(): Promise<void>;
}

export interface LocalOcrResult {
  key: string;
  text: string | null;
  confidence: number;
  candidates: string[];
}

let workerInstance: Worker | null = null;
let workerApi: Comlink.Remote<OcrWorkerAPI> | null = null;

function getWorker(): Comlink.Remote<OcrWorkerAPI> {
  if (!workerApi) {
    workerInstance = new Worker(new URL('../../workers/ocr.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<OcrWorkerAPI>(workerInstance);
  }
  return workerApi;
}

/** 把单字二值裁剪编码为 64×64 白底 PNG dataURL（与拼图同规格，提升 Tesseract 单字命中率） */
async function charCropToDataUrl(
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  bbox: [number, number, number, number],
  pad = 4,
  size = 96,
): Promise<string> {
  const crop = cropBinary(bin, pageWidth, pageHeight, bbox[0] - pad, bbox[1] - pad, bbox[2] - bbox[0] + pad * 2, bbox[3] - bbox[1] + pad * 2);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  if (crop.width > 0 && crop.height > 0) {
    const scale = Math.min((size - 12) / crop.width, (size - 12) / crop.height, 4);
    const dw = Math.max(1, Math.round(crop.width * scale));
    const dh = Math.max(1, Math.round(crop.height * scale));
    const img = ctx.createImageData(dw, dh);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(crop.width - 1, Math.floor(x / scale));
        const sy = Math.min(crop.height - 1, Math.floor(y / scale));
        const v = crop.data[sy * crop.width + sx] ? 0 : 255;
        const o = (y * dw + x) * 4;
        img.data[o] = v;
        img.data[o + 1] = v;
        img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2));
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const b64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:image/png;base64,${b64}`;
}

/**
 * 本地识别一批字符。返回 charId → 多轮投票结果。
 */
export async function localOcrChars(
  chars: CharItem[],
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, LocalOcrResult>> {
  const api = getWorker();
  const results = new Map<string, LocalOcrResult>();
  const chunkSize = 12;
  for (let start = 0; start < chars.length; start += chunkSize) {
    const chunk = chars.slice(start, start + chunkSize);
    const items = await Promise.all(chunk.map(async (c) => ({
      key: c.id,
      dataUrls: await Promise.all([
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 2, 96),
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 5, 96),
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 8, 128),
      ]),
    })));
    const partial = await api.ocrChars(items);
    for (const result of partial) results.set(result.key, result);
    onProgress?.(Math.min(chars.length, start + chunk.length), chars.length);
  }
  return results;
}

/** 释放本地 OCR 资源（WASM 体积大，不用时及时释放） */
export async function shutdownLocalOcr(): Promise<void> {
  if (workerApi) {
    await workerApi.terminate().catch(() => undefined);
  }
  workerInstance?.terminate();
  workerInstance = null;
  workerApi = null;
}
