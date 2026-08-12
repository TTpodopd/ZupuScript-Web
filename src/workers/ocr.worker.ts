/**
 * 本地 OCR Worker：Tesseract.js（chi_tra + chi_tra_vert 双引擎投票）隔离加载。
 * 族谱竖排用 vert 引擎，横排用 chi_tra；双引擎一致才提置信度。
 * 仅作为模式 A 与云端失败降级链的兜底，返回多轮投票后的保守置信度。
 *
 * tesseract.js 必须在 worker 顶部静态 import，让 Vite 把整个 Tesseract.js
 * 打进 worker bundle，避免 Worker dynamic import /node_modules/.vite/deps/ 时
 * 跨域/路径解析失败（"error loading dynamically imported module"）。
 */
import * as Comlink from 'comlink';
import { createWorker } from 'tesseract.js';
import type { LocalOcrResult, LocalOcrWorkerProgress, OcrWorkerAPI } from '@/recognize/local/tesseract';

type TesseractWorker = {
  recognize: (image: string) => Promise<{ data: { text: string; confidence?: number } }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

let tessNormal: TesseractWorker | null = null;
let tessVert: TesseractWorker | null = null;
let reportProgress: ((progress: LocalOcrWorkerProgress) => void) | undefined;

const assetRoot = new URL(`${import.meta.env.BASE_URL}tesseract/`, self.location.origin).href;
const tesseractOptions = {
  workerPath: `${assetRoot}worker.min.js`,
  corePath: `${assetRoot}core`,
  langPath: `${assetRoot}tessdata`,
  cacheMethod: 'write',
  gzip: true,
  logger: (message: { status: string; progress: number }) => {
    reportProgress?.({ status: message.status, progress: message.progress });
  },
};

async function getTesseractNormal(): Promise<TesseractWorker> {
  if (!tessNormal) {
    const w = (await createWorker('chi_tra', 1, tesseractOptions)) as unknown as TesseractWorker;
    await w.setParameters({
      tessedit_pageseg_mode: '10', // PSM_SINGLE_CHAR
      preserve_interword_spaces: '0',
    });
    tessNormal = w;
  }
  return tessNormal;
}

async function getTesseractVert(): Promise<TesseractWorker> {
  if (!tessVert) {
    const w = (await createWorker('chi_tra_vert', 1, tesseractOptions)) as unknown as TesseractWorker;
    await w.setParameters({
      tessedit_pageseg_mode: '10',
      preserve_interword_spaces: '0',
    });
    tessVert = w;
  }
  return tessVert;
}

const CJK_GLYPH_RE = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}\u3007\u3021-\u3029\u3038-\u303B]$/u;

const api: OcrWorkerAPI = {
  async ocrChars(items, onProgress) {
    reportProgress = onProgress;
    const out: LocalOcrResult[] = [];
    try {
      const wn = await getTesseractNormal();
    const wv = await getTesseractVert().catch(() => null); // vert 可能不支持，降级单引擎
    for (const item of items) {
      try {
        const votes = new Map<string, { score: number; count: number; confidenceSum: number }>();
        let totalPasses = 0;
        const addVote = (glyph: string | null, weight: number, confidence01: number) => {
          if (!glyph || !CJK_GLYPH_RE.test(glyph)) return; // 字母/数字/标点/符号不参与投票
          const vote = votes.get(glyph) ?? { score: 0, count: 0, confidenceSum: 0 };
          vote.score += weight + confidence01;
          vote.count += 1;
          vote.confidenceSum += confidence01;
          votes.set(glyph, vote);
        };
        for (const dataUrl of item.dataUrls) {
          const { data: dn } = await wn.recognize(dataUrl);
          totalPasses += 1;
          addVote([...dn.text.trim().replace(/\s+/g, '')][0] ?? null, 1, (dn.confidence ?? 0) / 100);
          if (wv) {
            const { data: dv } = await wv.recognize(dataUrl);
            totalPasses += 1;
            addVote([...dv.text.trim().replace(/\s+/g, '')][0] ?? null, 1.25, (dv.confidence ?? 0) / 100);
          }
        }
        let text: string | null = null;
        let best = -1;
        let winner = { score: 0, count: 0, confidenceSum: 0 };
        for (const [candidate, vote] of votes) {
          if (vote.score > best) {
            best = vote.score;
            text = candidate;
            winner = vote;
          }
        }
        const agreement = winner.count / Math.max(1, totalPasses);
        const averageConfidence = winner.confidenceSum / Math.max(1, winner.count);
        const confidence = text ? Math.min(0.96, Math.max(0, 0.35 + agreement * 0.45 + averageConfidence * 0.2)) : 0;
        const candidates = [...votes.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .map(([candidate]) => candidate)
          .slice(0, 3);
        out.push({ key: item.key, text, confidence, candidates });
      } catch {
        out.push({ key: item.key, text: null, confidence: 0, candidates: [] });
      }
    }
      return out;
    } finally {
      reportProgress = undefined;
    }
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
