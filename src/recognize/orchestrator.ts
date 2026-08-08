/**
 * 识别编排器（全应用唯一出网点，共享约定）。
 * 职责：分批（≤100字）→ 拼图 → 哈希缓存 → 并发≤5 → 指数退避重试 →
 *      校验（数量守恒/单字符/置信度）→ 失败降级本地 Tesseract（全部 conf=0 标红）→
 *      成本估算与审计日志。
 */
import { CONFIDENCE_THRESHOLD, GRID_BATCH_SIZE, GRID_COLS } from '@/lib/constants';
import type { CharItem, Page, PrivacyMode } from '@/model/types';
import { assertModeAllowed } from '@/privacy/consent';
import { bumpSessionUploads, logAudit } from '@/privacy/audit';
import { getCache, setCache } from '@/storage/db';
import { buildGridBatch, hashBatch, pageBinaryToPngBase64 } from '@/segment/grid';
import { backoffDelay, fnv1a, median, runPool } from '@/lib/utils';
import {
  buildGridUserPrompt,
  buildPageReviewPrompt,
  buildReviewPrompt,
  isValidChar,
  RECOGNITION_PROMPT_VERSION,
} from './prompt';
import { postprocessItems } from './postprocess';
import { localOcrChars } from './local/tesseract';
import { learnCharacters, recallCharacters } from './memory';
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

/** 合并初识别与复核结果：一致提权，不一致强制进入人工校对。 */
function mergeReviewedItems(first: RecognizedItem[], reviewed: RecognizedItem[]): RecognizedItem[] {
  const reviewedById = new Map(reviewed.map((item) => [item.id, item]));
  return first.map((initial) => {
    const second = reviewedById.get(initial.id);
    if (!second) return { ...initial, confidence: Math.min(initial.confidence, CONFIDENCE_THRESHOLD - 0.01), note: 'blurry' };
    if (initial.char === second.char) {
      return { ...second, confidence: Math.min(1, Math.max(initial.confidence, second.confidence) + 0.03) };
    }
    if (second.char !== null && second.confidence >= 0.93 && (initial.char === null || initial.confidence < 0.55)) {
      return { ...second, confidence: Math.max(CONFIDENCE_THRESHOLD + 0.03, second.confidence), note: second.note ?? 'ok' };
    }
    return {
      ...second,
      confidence: Math.min(second.confidence, CONFIDENCE_THRESHOLD - 0.01),
      note: second.char === null ? 'empty' : 'blurry',
      candidates: [...new Set([initial.char, second.char, ...(second.candidates ?? [])].filter((value): value is string => Boolean(value)))].slice(0, 3),
    };
  });
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
  promptOverride?: string,
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
      const result = await provider.recognize({ mode: 'B', batch, signal, promptOverride }, cfg);
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
      const text = results.get(c.id)?.text ?? null;
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
    const remembered = await recallCharacters(page.chars, bin, width, height).catch(() => new Map());
    for (const char of page.chars) {
      const memory = remembered.get(char.id);
      if (memory) patch.set(char.id, { text: memory.text, conf: memory.confidence, note: 'ok', source: 'local' });
    }
    const unresolved = page.chars.filter((char) => !remembered.has(char.id));
    batchCount = Math.max(1, Math.ceil(unresolved.length / 12));
    report(0, `本地识别记忆命中 ${remembered.size} 字，继续深度识别 ${unresolved.length} 字`);
    const results = await localOcrChars(unresolved, bin, width, height, (doneChars, total) => {
      const done = Math.ceil((doneChars / Math.max(1, total)) * batchCount);
      report(done, `正在深度识别文字：${doneChars}/${total} 字，已完成多轮投票复核`);
    });
    for (const c of unresolved) {
      const result = results.get(c.id);
      const rawText = result?.text ?? null;
      const valid = isValidChar(rawText);
      const text = valid ? rawText : null;
      const conf = valid ? result?.confidence ?? 0 : 0;
      patch.set(c.id, { text, conf, note: text ? (conf >= CONFIDENCE_THRESHOLD ? 'ok' : 'blurry') : 'empty', source: 'local' });
    }
    report(batchCount, '本地深度识别完成：多轮结果已合并，低置信字请在画布校对');
  } else if (mode === 'B') {
    /* ---------- 模式 B：字符拼图上云（默认） ---------- */
    const provider = getProvider(cfg.provider);
    const remembered = await recallCharacters(page.chars, bin, width, height).catch(() => new Map());
    for (const char of page.chars) {
      const memory = remembered.get(char.id);
      if (memory) patch.set(char.id, { text: memory.text, conf: memory.confidence, note: 'ok', source: 'local' });
    }
    const unresolved = page.chars.filter((char) => !remembered.has(char.id));
    // 预切片（保持 ids → 片内下标的映射）
    const slices: CharItem[][] = [];
    for (let start = 0; start < unresolved.length; start += GRID_BATCH_SIZE) {
      slices.push(unresolved.slice(start, start + GRID_BATCH_SIZE));
    }
    batchCount = slices.length;
    report(0, `识别记忆命中 ${remembered.size} 字；其余 ${unresolved.length} 字分 ${slices.length} 批进行模型校验`);

    let done = 0;
    let stoppedByBudget = false;
    await runPool(slices, Math.min(cfg.concurrency, 5), async (slice, idx) => {
      if (stoppedByBudget) {
        await downgradeBatch(slice, bin, width, height, patch);
        failedBatches++;
        return;
      }
      const batch = await buildGridBatch(slice, bin, width, height, idx);
      const localDraft = batch.ids.map((sliceIndex, id) => {
        const char = slice[sliceIndex];
        return {
          id,
          char: char?.text ?? null,
          confidence: char?.conf ?? 0,
        };
      });
      const cols = Math.min(GRID_COLS, slice.length);
      const rows = Math.ceil(slice.length / Math.max(1, cols));
      const initialPrompt = buildGridUserPrompt(cols, rows, slice.length, localDraft);
      const cacheKey = [
        RECOGNITION_PROMPT_VERSION,
        cfg.provider,
        cfg.model,
        hashBatch(slice, idx),
        fnv1a(batch.ids.join(',')),
        fnv1a(initialPrompt),
      ].join(':');
      // 预算护栏（F4.10）：预估超限则停止后续批次
      const estimate = provider.estimateCost(slice.length);
      if (costCny + estimate * 2 > budgetCny) {
        stoppedByBudget = true;
        await downgradeBatch(slice, bin, width, height, patch);
        failedBatches++;
        report(done, '已达单页成本上限，剩余批次降级本地识别');
        return;
      }
      const result = await recognizeOneBatch(provider, cfg, batch, cacheKey, initialPrompt);
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
        let reviewed = result;
        try {
          const reviewPrompt = buildReviewPrompt(JSON.stringify({ items: result.items }), slice.length);
          const reviewKey = `${cacheKey}:review:${fnv1a(reviewPrompt)}`;
          const second = await recognizeOneBatch(provider, cfg, batch, reviewKey, reviewPrompt);
          if (second) {
            bumpSessionUploads(1);
            reviewed = {
              items: mergeReviewedItems(result.items, second.items),
              usage: {
                promptTokens: (result.usage?.promptTokens ?? 0) + (second.usage?.promptTokens ?? 0),
                completionTokens: (result.usage?.completionTokens ?? 0) + (second.usage?.completionTokens ?? 0),
              },
            };
            costCny += estimate;
            if (second.usage) {
              usageTotal.promptTokens += second.usage.promptTokens;
              usageTotal.completionTokens += second.usage.completionTokens;
            }
            report(done, `第 ${idx + 1}/${slices.length} 批已完成模型综合校验`);
          }
        } catch (err) {
          console.warn('[orchestrator] 模型综合校验失败，保留初次结果：', err);
        }
        // 后处理：字典提权 + 候选兜底 + 异体记录
        const processed = postprocessItems(reviewed.items, { isGenealogy: true });
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
    batchCount = 2;
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
      let reviewedResult = result;
      report(1, '整页初次识别完成，正在进行模型输出文档综合校验');
      const reviewTimeout = withTimeout(cfg.timeoutMs * 2);
      try {
        const second = await provider.recognizePageImage({
          mode: 'C',
          pageImageBase64,
          promptOverride: buildPageReviewPrompt(JSON.stringify({ items: result.items })),
          signal: reviewTimeout.signal,
        }, cfg);
        reviewTimeout.cancel();
        if (second.items.length > 0) {
          reviewedResult = second;
          bumpSessionUploads(1);
          costCny += provider.estimateCost(totalChars) * 3;
          if (second.usage) {
            usageTotal.promptTokens += second.usage.promptTokens;
            usageTotal.completionTokens += second.usage.completionTokens;
          }
        }
      } catch (err) {
        reviewTimeout.cancel();
        console.warn('[orchestrator] 整页模型综合校验失败，保留初次结果：', err);
      }
      report(2, '整页模型输出校验完成，正在匹配字符坐标');
      // 最近邻匹配：模型相对坐标 → 像素坐标 → 与本地分割中心匹配（阈值 0.5 字宽）
      const typicalW = median(page.chars.map((c) => c.bbox[2] - c.bbox[0])) || 30;
      const threshold = typicalW * 0.5;
      const used = new Set<number>();
      for (const c of page.chars) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < reviewedResult.items.length; i++) {
          if (used.has(i)) continue;
          const it = reviewedResult.items[i];
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
          const it = reviewedResult.items[bestIdx];
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
      batches: batchCount,
      pageId: page.id,
    }).catch(() => undefined);
  }

  // 应用补丁（坐标一律不动，只写回 text/conf/note/source）
  const chars = page.chars.map((c) => {
    const p = patch.get(c.id);
    return p ? { ...c, ...p } : c;
  });
  await learnCharacters(chars, bin, width, height, page.id).catch(() => undefined);

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
