/**
 * 识别编排器（全应用唯一出网点，共享约定）。
 * 职责：分批（≤100字）→ 拼图 → 哈希缓存 → 并发≤5 → 指数退避重试 →
 *      校验（数量守恒/单字符/置信度）→ 失败降级本地 Tesseract（全部 conf=0 标红）→
 *      成本估算与审计日志。
 */
import { CONFIDENCE_THRESHOLD, GRID_BATCH_SIZE, TOKENS_PER_CHAR } from '@/lib/constants';
import type { CharItem, Page, PrivacyMode } from '@/model/types';
import { assertModeAllowed } from '@/privacy/consent';
import { bumpSessionUploads, logAudit } from '@/privacy/audit';
import { getCache, setCache } from '@/storage/db';
import { buildGridBatch, hashBatch, pageBinaryToPngBase64 } from '@/segment/grid';
import { backoffDelay, median, runPool } from '@/lib/utils';
import { isValidChar } from './prompt';
import { postprocessItems } from './postprocess';
import { localOcrChars } from './local/tesseract';
import type {
  GridBatch,
  LLMProvider,
  ProviderConfig,
  ProviderId,
  RecognizePageOutcome,
  RecognizeProgress,
  RecognizedItem,
} from './types';
import { geminiProvider } from './providers/gemini';
import { openaiProvider } from './providers/openai';
import { anthropicProvider } from './providers/anthropic';
import { customProvider } from './providers/custom';

const PROVIDERS: Record<Exclude<ProviderId, 'local'>, LLMProvider> = {
  gemini: geminiProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  custom: customProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  if (id === 'local') {
    // 本地兜底不作为网络 Provider；返回 gemini 占位不会被执行（orchestrator 已分流）
    throw new Error('local 不是网络 Provider，请使用 recognizePage 的 A 模式');
  }
  return PROVIDERS[id];
}

export function providerDomain(provider: LLMProvider, cfg: ProviderConfig): string {
  try {
    const raw = cfg.proxyUrl || cfg.endpoint || provider.defaultEndpoint || 'localhost';
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return 'unknown';
  }
}

/** 带超时的 AbortSignal 包装 */
function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

/** 单批识别（重试 + 指数退避 + 缓存），返回 null 表示彻底失败（调用方降级本地） */
async function recognizeOneBatch(
  provider: LLMProvider,
  cfg: ProviderConfig,
  batch: GridBatch,
  cacheKey: string,
): Promise<{ items: RecognizedItem[]; usage?: { promptTokens: number; completionTokens: number } } | null> {
  const cached = await getCache(cacheKey).catch(() => undefined);
  if (cached) {
    return { items: cached.items as RecognizedItem[] };
  }
  const expect = batch.ids.length;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) await backoffDelay(attempt - 1);
    const { signal, cancel } = withTimeout(cfg.timeoutMs);
    try {
      const result = await provider.recognize({ mode: 'B', batch, signal }, cfg);
      cancel();
      // 校验链第 1 环：数量守恒
      if (result.items.length !== expect) {
        throw new Error(`数量不守恒：期望 ${expect} 条，实得 ${result.items.length} 条`);
      }
      // 校验链第 2 环：id 必须完整覆盖 0..expect-1
      const seen = new Set(result.items.map((it) => it.id));
      for (let i = 0; i < expect; i++) {
        if (!seen.has(i)) throw new Error(`返回编号缺失：${i}`);
      }
      await setCache({ key: cacheKey, items: result.items, createdAt: Date.now() }).catch(() => undefined);
      return result;
    } catch (err) {
      cancel();
      if (attempt === cfg.maxRetries) {
        console.warn(`[orchestrator] 批 ${batch.batchIndex} 重试 ${cfg.maxRetries} 次后失败：`, err);
        return null;
      }
    }
  }
  return null;
}

/** 失败批降级：本地 Tesseract，结果全部 conf=0 标红（共享约定：降级链末端） */
async function downgradeBatch(
  slice: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  patch: Map<string, Partial<CharItem>>,
): Promise<void> {
  try {
    const results = await localOcrChars(slice, bin, width, height);
    for (const c of slice) {
      const text = results.get(c.id) ?? null;
      patch.set(c.id, { text, conf: 0, note: text ? 'blurry' : 'empty', source: 'local' });
    }
  } catch {
    for (const c of slice) {
      patch.set(c.id, { text: null, conf: 0, note: 'empty', source: 'local' });
    }
  }
}

export interface RecognizePageResultFull {
  chars: CharItem[];
  outcome: RecognizePageOutcome;
}

/**
 * 识别整页字符。
 * @param mode A 全本地 / B 拼图上云（默认）/ C 整页上云
 * @param budgetCny 单页成本上限（元），超限自动停止后续批次，已识别部分保留
 */
export async function recognizePage(
  page: Page,
  bin: Uint8Array,
  width: number,
  height: number,
  cfg: ProviderConfig,
  mode: PrivacyMode,
  budgetCny = Infinity,
  onProgress?: (p: RecognizeProgress) => void,
): Promise<RecognizePageResultFull> {
  assertModeAllowed(mode);
  const totalChars = page.chars.length;
  const patch = new Map<string, Partial<CharItem>>();
  const usageTotal = { promptTokens: 0, completionTokens: 0 };
  let costCny = 0;
  let failedBatches = 0;
  let batchCount = 0;

  const report = (done: number, message: string) =>
    onProgress?.({
      totalBatches: batchCount,
      doneBatches: done,
      failedBatches,
      recognizedChars: patch.size,
      totalChars,
      costCny,
      message,
    });

  if (mode === 'A') {
    /* ---------- 模式 A：全本地 Tesseract ---------- */
    const results = await localOcrChars(page.chars, bin, width, height);
    for (const c of page.chars) {
      const text = results.get(c.id) ?? null;
      patch.set(c.id, { text, conf: 0, note: text ? 'blurry' : 'empty', source: 'local' });
    }
    report(1, '本地识别完成（结果全部标红待人工确认）');
  } else if (mode === 'B') {
    /* ---------- 模式 B：字符拼图上云（默认） ---------- */
    const provider = getProvider(cfg.provider);
    // 预切片（保持 ids → 片内下标的映射）
    const slices: CharItem[][] = [];
    for (let start = 0; start < page.chars.length; start += GRID_BATCH_SIZE) {
      slices.push(page.chars.slice(start, start + GRID_BATCH_SIZE));
    }
    batchCount = slices.length;
    report(0, `共 ${slices.length} 批拼图，开始上行识别`);

    let done = 0;
    let stoppedByBudget = false;
    await runPool(slices, Math.min(cfg.concurrency, 5), async (slice, idx) => {
      if (stoppedByBudget) {
        await downgradeBatch(slice, bin, width, height, patch);
        failedBatches++;
        return;
      }
      const batch = await buildGridBatch(slice, bin, width, height, idx);
      const cacheKey = `${cfg.provider}:${cfg.model}:${hashBatch(slice, idx)}`;
      // 预算护栏（F4.10）：预估超限则停止后续批次
      const estimate = provider.estimateCost(slice.length);
      if (costCny + estimate > budgetCny) {
        stoppedByBudget = true;
        await downgradeBatch(slice, bin, width, height, patch);
        failedBatches++;
        report(done, '已达单页成本上限，剩余批次降级本地识别');
        return;
      }
      const result = await recognizeOneBatch(provider, cfg, batch, cacheKey);
      bumpSessionUploads(1);
      if (!result) {
        failedBatches++;
        await downgradeBatch(slice, bin, width, height, patch);
      } else {
        costCny += estimate;
        if (result.usage) {
          usageTotal.promptTokens += result.usage.promptTokens;
          usageTotal.completionTokens += result.usage.completionTokens;
        }
        // 后处理：字典提权 + 候选兜底 + 异体记录
        const processed = postprocessItems(result.items, { isGenealogy: true });
        for (const item of processed) {
          const sliceIndex = batch.ids[item.id];
          const char = slice[sliceIndex];
          if (!char) continue;
          // 校验链第 3 环：单字符且非 ASCII；不合格标记待人工
          const valid = isValidChar(item.char, item.note);
          patch.set(char.id, {
            text: valid ? item.char : item.char,
            conf: valid ? item.confidence : Math.min(item.confidence, CONFIDENCE_THRESHOLD - 0.01),
            note: valid ? item.note ?? 'ok' : 'multi',
            source: 'llm',
          });
        }
      }
      done++;
      report(done, `已完成 ${done}/${slices.length} 批`);
    });

    // 审计日志（仅元数据，绝不含图像与文字）
    await logAudit({
      mode: 'B',
      provider: cfg.provider,
      domain: providerDomain(provider, cfg),
      charCount: totalChars,
      batches: batchCount,
      pageId: page.id,
    }).catch(() => undefined);
  } else {
    /* ---------- 模式 C：整页上云 + 相对坐标匹配校验（F4.5） ---------- */
    const provider = getProvider(cfg.provider);
    batchCount = 1;
    if (!provider.recognizePageImage) throw new Error(`${provider.label} 不支持整页识别`);
    const pageImageBase64 = await pageBinaryToPngBase64(bin, width, height);
    const { signal, cancel } = withTimeout(cfg.timeoutMs * 2);
    try {
      const result = await provider.recognizePageImage({ mode: 'C', pageImageBase64, signal }, cfg);
      cancel();
      bumpSessionUploads(1);
      costCny = provider.estimateCost(totalChars) * 3; // 整页 token 高一个量级
      if (result.usage) {
        usageTotal.promptTokens += result.usage.promptTokens;
        usageTotal.completionTokens += result.usage.completionTokens;
      }
      // 最近邻匹配：模型相对坐标 → 像素坐标 → 与本地分割中心匹配（阈值 0.5 字宽）
      const typicalW = median(page.chars.map((c) => c.bbox[2] - c.bbox[0])) || 30;
      const threshold = typicalW * 0.5;
      const used = new Set<number>();
      for (const c of page.chars) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < result.items.length; i++) {
          if (used.has(i)) continue;
          const it = result.items[i];
          const dx = it.rx * width - c.cx;
          const dy = it.ry * height - c.cy;
          const d = Math.hypot(dx, dy);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestDist <= threshold) {
          used.add(bestIdx);
          const it = result.items[bestIdx];
          const valid = isValidChar(it.char, it.note);
          patch.set(c.id, {
            text: it.char,
            // 匹配不上以本地分割为准，坐标不动；匹配置信度按距离降权
            conf: valid ? it.confidence * Math.max(0.5, 1 - bestDist / threshold / 2) : 0,
            note: valid ? it.note ?? 'ok' : 'multi',
            source: 'llm',
          });
        } else {
          patch.set(c.id, { text: null, conf: 0, note: 'empty', source: 'llm' });
        }
      }
    } catch (err) {
      cancel();
      // 整页失败 → 整页降级本地
      failedBatches = 1;
      await downgradeBatch(page.chars, bin, width, height, patch);
      report(1, `整页识别失败，已降级本地：${err instanceof Error ? err.message : String(err)}`);
    }
    await logAudit({
      mode: 'C',
      provider: cfg.provider,
      domain: providerDomain(provider, cfg),
      charCount: totalChars,
      batches: 1,
      pageId: page.id,
    }).catch(() => undefined);
  }

  // 应用补丁（坐标一律不动，只写回 text/conf/note/source）
  const chars = page.chars.map((c) => {
    const p = patch.get(c.id);
    return p ? { ...c, ...p } : c;
  });

  return {
    chars,
    outcome: {
      updatedCount: patch.size,
      batches: batchCount,
      failedBatches,
      costCny,
      usage: usageTotal,
      mode,
    },
  };
}

/**
 * 双模型交叉验证（F4.7，P1 预留接口）。
 * 两个模型结果不一致的字强制 conf=0 转人工确认。
 */
export async function crossValidate(
  page: Page,
  bin: Uint8Array,
  width: number,
  height: number,
  cfgA: ProviderConfig,
  cfgB: ProviderConfig,
  mode: PrivacyMode,
  onProgress?: (p: RecognizeProgress) => void,
): Promise<RecognizePageResultFull> {
  const [ra, rb] = [
    await recognizePage(page, bin, width, height, cfgA, mode, Infinity, onProgress),
    await recognizePage(page, bin, width, height, cfgB, mode, Infinity, onProgress),
  ];
  const mapB = new Map(rb.chars.map((c) => [c.id, c]));
  const chars = ra.chars.map((ca) => {
    const cb = mapB.get(ca.id);
    if (!cb) return ca;
    if (ca.text !== cb.text) {
      // 不一致 → 强制人工
      return { ...ca, conf: 0, note: 'blurry' as const };
    }
    return { ...ca, conf: Math.min(ca.conf, cb.conf) };
  });
  return {
    chars,
    outcome: {
      ...ra.outcome,
      costCny: ra.outcome.costCny + rb.outcome.costCny,
    },
  };
}
