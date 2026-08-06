/**
 * 本地 OCR Worker：Tesseract.js（chi_tra + chi_tra_vert 双引擎投票）隔离加载。
 * 族谱竖排用 vert 引擎，横排用 chi_tra；双引擎一致才提置信度。
 * 仅作为模式 A 与云端失败降级链的兜底，结果一律由调用方标 conf=0。
 */
import * as Comlink from 'comlink';
import type { OcrWorkerAPI } from '@/recognize/local/tesseract';
import { ALL_DICT_CHARS } from '@/recognize/dict/genealogy';

type TesseractWorker = {
  recognize: (image: string) => Promise<{ data: { text: string } }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

let tessNormal: TesseractWorker | null = null;
let tessVert: TesseractWorker | null = null;

/** 字典白名单：限定 Tesseract 只输出字典中的字 */
const WHITELIST = [...ALL_DICT_CHARS].join('');

async function getTesseractNormal(): Promise<TesseractWorker> {
  if (!tessNormal) {
    const { createWorker } = await import('tesseract.js');
    const w = (await createWorker('chi_tra', 1)) as unknown as TesseractWorker;
    await w.setParameters({
      tessedit_pageseg_mode: '10', // PSM_SINGLE_CHAR
      tessedit_char_whitelist: WHITELIST,
      preserve_interword_spaces: '0',
    });
    tessNormal = w;
  }
  return tessNormal;
}

async function getTesseractVert(): Promise<TesseractWorker> {
  if (!tessVert) {
    const { createWorker } = await import('tesseract.js');
    const w = (await createWorker('chi_tra_vert', 1)) as unknown as TesseractWorker;
    await w.setParameters({
      tessedit_pageseg_mode: '10',
      tessedit_char_whitelist: WHITELIST,
      preserve_interword_spaces: '0',
    });
    tessVert = w;
  }
  return tessVert;
}

const api: OcrWorkerAPI = {
  async ocrChars(items) {
    const out: Array<{ key: string; text: string | null }> = [];
    const wn = await getTesseractNormal();
    const wv = await getTesseractVert().catch(() => null); // vert 可能不支持，降级单引擎
    for (const item of items) {
      try {
        const { data: dn } = await wn.recognize(item.dataUrl);
        const tn = dn.text.trim().replace(/\s+/g, '');
        let text = tn.length > 0 ? [...tn][0] : null;

        // 双引擎投票：若 vert 可用，取 vert 结果，一致才确认，不一致取 vert
        if (wv && text) {
          const { data: dv } = await wv.recognize(item.dataUrl);
          const tv = dv.text.trim().replace(/\s+/g, '');
          const vertText = tv.length > 0 ? [...tv][0] : null;
          if (vertText && vertText !== text) {
            text = vertText; // 取 vert 结果（竖排族谱更准）
          }
        }
        out.push({ key: item.key, text });
      } catch {
        out.push({ key: item.key, text: null });
      }
    }
    return out;
  },

  async terminate() {
    if (tessNormal) {
      await tessNormal.terminate().catch(() => undefined);
      tessNormal = null;
    }
    if (tessVert) {
      await tessVert.terminate().catch(() => undefined);
      tessVert = null;
    }
  },
};

Comlink.expose(api);
