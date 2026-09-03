/**
 * 本地兜底识别（F4.11）：Tesseract.js chi_tra，经 Comlink 隔离在 ocr.worker。
 * 多裁剪、多方向投票后返回校准置信度；云端失败降级时由编排器决定是否标红。
 * 无密钥也能跑完全流程；图像不出本机。
 */
import * as Comlink from 'comlink';
import { cropBinary } from '@/imaging/raster';
import type { CharItem } from '@/model/types';
import { arrayBufferToBase64 } from '@/lib/utils';
import { closeBinary, dilateBinary, scaleCoverage } from '@/segment/grid';

/** 本地 OCR 渲染：1px 闭运算修木刻断笔（与 B 模式拼图同源、实测有效） */
export const LOCAL_OCR_CLOSE_RADIUS = 1;
/** 木刻字笔画细，放大上限放宽到 6 倍，小字也能补到 Tesseract 舒适尺寸 */
export const LOCAL_OCR_MAX_UPSCALE = 6;

export interface OcrWorkerAPI {
  ocrChars(
    items: Array<{ key: string; dataUrls: string[]; orientation?: 'horizontal' | 'vertical' }>,
    onProgress?: (progress: LocalOcrWorkerProgress) => void,
  ): Promise<LocalOcrResult[]>;
  terminate(): Promise<void>;
}

export interface LocalOcrWorkerProgress {
  status: string;
  progress: number;
}

export interface LocalOcrResult {
  key: string;
  text: string | null;
  confidence: number;
  candidates: string[];
  agreeingPasses: number;
  totalPasses: number;
}

let workerInstance: Worker | null = null;
let workerApi: Comlink.Remote<OcrWorkerAPI> | null = null;
const LOCAL_OCR_CHUNK_TIMEOUT_MS = 180_000;

function resetLocalOcrWorker(): void {
  workerInstance?.terminate();
  workerInstance = null;
  workerApi = null;
}

async function runWithLocalOcrTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      resetLocalOcrWorker();
      reject(new Error('本地 OCR 初始化或识别超时，请重试；若仍失败请刷新页面检查本地资源'));
    }, LOCAL_OCR_CHUNK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function getWorker(): Comlink.Remote<OcrWorkerAPI> {
  if (!workerApi) {
    workerInstance = new Worker(new URL('../../workers/ocr.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<OcrWorkerAPI>(workerInstance);
  }
  return workerApi;
}

/**
 * 单字二值裁剪 → 纯像素渲染（可测试，不依赖 OffscreenCanvas）：
 * 1px 闭运算修木刻断笔 → 平滑灰度缩放（面积平均/双线性，与 B 模式拼图同源）→ 白底居中。
 * 旧实现为硬二值 + 最近邻采样，放大时产生锯齿断笔、缩小时丢笔画，是本地识别低置信的主因之一。
 */
export function renderCharPixels(
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  bbox: [number, number, number, number],
  pad: number,
  size: number,
  thicken = false,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const crop = cropBinary(bin, pageWidth, pageHeight, bbox[0] - pad, bbox[1] - pad, bbox[2] - bbox[0] + pad * 2, bbox[3] - bbox[1] + pad * 2);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    out[o] = 255;
    out[o + 1] = 255;
    out[o + 2] = 255;
    out[o + 3] = 255;
  }
  if (crop.width > 0 && crop.height > 0) {
    let prepared = closeBinary(crop.data, crop.width, crop.height, LOCAL_OCR_CLOSE_RADIUS);
    // 粗化变体：闭运算后再 1px 膨胀，把木刻细笔画加粗一档。
    // Tesseract 对 <2px 细线漏检严重，加粗版作为独立投票路，与常规路互补。
    if (thicken) prepared = dilateBinary(prepared, crop.width, crop.height, 1);
    const scale = Math.min((size - 12) / crop.width, (size - 12) / crop.height, LOCAL_OCR_MAX_UPSCALE);
    const dw = Math.max(1, Math.round(crop.width * scale));
    const dh = Math.max(1, Math.round(crop.height * scale));
    const cov = scaleCoverage(prepared, crop.width, crop.height, dw, dh);
    const img = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < dw * dh; i++) {
      const v = 255 - cov[i];
      const o = i * 4;
      img[o] = v;
      img[o + 1] = v;
      img[o + 2] = v;
      img[o + 3] = 255;
    }
    const ox = Math.round((size - dw) / 2);
    const oy = Math.round((size - dh) / 2);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = ((y) * dw + x) * 4;
        const d = ((y + oy) * size + (x + ox)) * 4;
        out[d] = img[s];
        out[d + 1] = img[s + 1];
        out[d + 2] = img[s + 2];
        out[d + 3] = 255;
      }
    }
  }
  return { data: out, width: size, height: size };
}

/** 把单字渲染为白底 PNG dataURL 供 Tesseract 识别 */
async function charCropToDataUrl(
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  bbox: [number, number, number, number],
  pad = 4,
  size = 96,
  thicken = false,
): Promise<string> {
  const { data, width, height } = renderCharPixels(bin, pageWidth, pageHeight, bbox, pad, size, thicken);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const b64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:image/png;base64,${b64}`;
}

/** 投票聚合条目（与 ocr.worker 内部结构一致，抽出便于测试与共享语义） */
export interface LocalVote {
  score: number;
  count: number;
  confidenceSum: number;
}

/**
 * 稳定赢家判定：winner 必须落在 top-2（容忍双引擎近音/近形分歧），
 * 一致率 ≥0.6 且与第三名分差 ≥0.5 才允许提前退出。
 * 旧实现要求 top1 且 agreement≥0.75，双引擎系统性分歧时永远凑不满，白白多跑轮数。
 */
export function hasStableLocalWinner(votes: Map<string, LocalVote>, totalPasses: number): boolean {
  if (totalPasses < 6 || votes.size === 0) return false;
  const ranked = [...votes.values()].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 2);
  const third = ranked[2];
  const agreement = Math.max(...top.map((v) => v.count / totalPasses));
  const margin = top[1] ? top[0].score - top[1].score : top[0].score;
  const gapToThird = third ? top[0].score - third.score : Number.POSITIVE_INFINITY;
  return agreement >= 0.6 && gapToThird >= 0.5 && margin >= 0;
}

/**
 * 本地投票置信度校准：一致率主导。
 * - 双引擎三裁剪全一致（agreement=1, tess≈0.9）→ ≈0.98 → 过 0.85 阈值免校对；
 * - top1 但多裁剪分歧大（agreement≈0.34, tess≈0.5）→ ≈0.54 → 如实标红进校对；
 * - 旧公式 0.35+agreement*0.45+tess*0.2 把低一致率结果也顶到 0.6 附近，既不过线也不够低，校对面板噪声大。
 */
export function calibrateLocalConfidence(agreement: number, averageTessConfidence: number): number {
  return Math.min(0.98, Math.max(0, 0.25 + agreement * 0.55 + averageTessConfidence * 0.2));
}

/**
 * 本地识别一批字符。返回 charId → 多轮投票结果。
 */
export async function localOcrChars(
  chars: CharItem[],
  bin: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  onProgress?: (done: number, total: number, message?: string) => void,
): Promise<Map<string, LocalOcrResult>> {
  const api = getWorker();
  const results = new Map<string, LocalOcrResult>();
  const chunkSize = 12;
  for (let start = 0; start < chars.length; start += chunkSize) {
    const chunk = chars.slice(start, start + chunkSize);
    const items = await Promise.all(chunk.map(async (c) => ({
      key: c.id,
      // 「三」主要由横画构成；即使它位于竖排标题，也优先使用横排模型，
      // 避免 chi_tra_vert 将三横误压成单竖线/「一」。
      orientation: c.group === 'rank' || c.group === 'title' || c.group === 'pageno' ? 'horizontal' as const : 'vertical' as const,
      // 三裁剪投票：紧/中/松 padding × 更大渲染尺寸（160/160/192，旧 96/96/128）。
      // 木刻单字约 20~30px，旧 96px 下放大仅 3 倍且最近邻采样，笔画锯齿严重；
      // 新尺寸 + 双线性/面积平均 + 闭运算修断笔，显著改善小字与弱笔画命中率。
      // 四裁剪投票：紧/中/松 padding × 更大渲染尺寸 + 第 4 路粗化变体（细笔画加粗一档）。
      // 木刻单字约 20~30px，细线在常规渲染下仍可能被 Tesseract 漏检，
      // 粗化路独立投票，与常规路互补，显著降低空识别率。
      dataUrls: await Promise.all([
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 2, 160),
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 5, 160),
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 8, 192),
        charCropToDataUrl(bin, pageWidth, pageHeight, c.bbox, 4, 160, true),
      ]),
    })));
    let partial: LocalOcrResult[];
    try {
      partial = await runWithLocalOcrTimeout(api.ocrChars(
        items,
        Comlink.proxy((progress: LocalOcrWorkerProgress) => {
          const percent = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
          onProgress?.(start, chars.length, `${progress.status} ${percent}%`);
        }),
      ));
    } catch (error) {
      resetLocalOcrWorker();
      throw error;
    }
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
  resetLocalOcrWorker();
}
