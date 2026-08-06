/**
 * 本地 OCR Worker：Tesseract.js（chi_tra）隔离加载，避免阻塞主线程与首屏。
 * 仅作为模式 A 与云端失败降级链的兜底，结果一律由调用方标 conf=0。
 */
import * as Comlink from 'comlink';
import type { OcrWorkerAPI } from '@/recognize/local/tesseract';

type TesseractWorker = {
  recognize: (image: string) => Promise<{ data: { text: string } }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

let tess: TesseractWorker | null = null;

async function getTesseract(): Promise<TesseractWorker> {
  if (!tess) {
    const { createWorker } = await import('tesseract.js');
    // OEM_LSTM_ONLY + PSM_SINGLE_CHAR：单字小图场景
    const w = (await createWorker('chi_tra', 1)) as unknown as TesseractWorker;
    await w.setParameters({
      tessedit_pageseg_mode: '10', // PSM_SINGLE_CHAR
      preserve_interword_spaces: '0',
    });
    tess = w;
  }
  return tess;
}

const api: OcrWorkerAPI = {
  async ocrChars(items) {
    const w = await getTesseract();
    const out: Array<{ key: string; text: string | null }> = [];
    for (const item of items) {
      try {
        const { data } = await w.recognize(item.dataUrl);
        const text = data.text.trim().replace(/\s+/g, '');
        // 只认不猜：空结果或多字符都保守处理（多字截首字由人工确认，仍标 conf=0）
        out.push({ key: item.key, text: text.length > 0 ? [...text][0] : null });
      } catch {
        out.push({ key: item.key, text: null });
      }
    }
    return out;
  },

  async terminate() {
    if (tess) {
      await tess.terminate().catch(() => undefined);
      tess = null;
    }
  },
};

Comlink.expose(api);
