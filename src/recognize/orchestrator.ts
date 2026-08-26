/**
 * 识别编排器（全应用唯一出网点，共享约定）。
 * 职责：分批（≤100字）→ 拼图 → 哈希缓存 → 并发≤5 → 指数退避重试 →
 *      校验（数量守恒/单字符/置信度）→ 失败降级本地 Tesseract（全部 conf=0 标红）→
 *      成本估算与审计日志。
 */
import { CONFIDENCE_THRESHOLD, GRID_BATCH_SIZE, GRID_COLS, PAGE_RECOGNITION_MAX_EDGE } from '@/lib/constants';
import type { CharItem, Page, PrivacyMode } from '@/model/types';
import { assertModeAllowed } from '@/privacy/consent';
import { bumpSessionUploads, logAudit } from '@/privacy/audit';
import { getCache, listPagesOfProject, setCache } from '@/storage/db';
import { buildGridBatch, hashBatch, pageBinaryToPngBase64Downscaled } from '@/segment/grid';
import { backoffDelay, fnv1a, runPool } from '@/lib/utils';
import {
  buildGridUserPrompt,
  buildPageAnchoredReviewPrompt,
  buildPageAnchoredUserPrompt,
  buildReviewPrompt,
  isValidChar,
  RECOGNITION_PROMPT_VERSION,
} from './prompt';
import { correctAutomatedZiJieConfusion, markAutomatedHandwrittenRankForReview, normalizeKnownMarginTitleBoxes, parseMarginTitleHint, postprocessItems, repairGenealogySequences } from './postprocess';
import { inferProjectMarginTitle } from './projectConsensus';
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
  RecognizedPageItem,
} from './types';
import { geminiProvider } from './providers/gemini';
import { openaiProvider } from './providers/openai';
import { anthropicProvider } from './providers/anthropic';
import { customProvider } from './providers/custom';
import { deepseekProvider } from './providers/deepseek';
import type { GlyphVerifyInput } from './glyphVerify';
import { inkMetricsInBbox } from '@/imaging/ink';
import { canonicalizeAnchoredPageItems, normalizeAnchoredPageItems } from './anchorMatch';
import { applyRecognitionPatch, fillFromAnchoredItems } from './fillPipeline';
import { countRecognitionVotes, deferIncompleteRecognition, mergeThreeRecognitionPasses } from './consensus';

const PROVIDERS: Record<Exclude<ProviderId, 'local'>, LLMProvider> = {
  gemini: geminiProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
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
  glyphDrafts?: Map<string, GlyphVerifyInput>,
): Promise<void> {
  try {
    const results = await localOcrChars(slice, bin, width, height);
    for (const c of slice) {
      const result = results.get(c.id);
      const text = result?.text ?? null;
      patch.set(c.id, { text, conf: 0, note: text ? 'blurry' : 'empty', source: 'local' });
      if (text) {
        glyphDrafts?.set(c.id, {
          primary: text,
          modelConfidence: result?.confidence ?? 0,
          candidates: result?.candidates,
          routeVotes: result?.agreeingPasses ?? 0,
        });
      }
    }
  } catch {
    for (const c of slice) {
      patch.set(c.id, { text: null, conf: 0, note: 'empty', source: 'local' });
    }
  }
}

function mergePageVerifiedItems(
  first: RecognizedPageItem[],
  second: RecognizedPageItem[],
  third: RecognizedPageItem[],
  chars: CharItem[],
  widthPx: number,
  heightPx: number,
): RecognizedPageItem[] {
  const merged = mergeThreeRecognitionPasses(first, second, third);
  return merged.map((it) => {
    const idx = it.id;
    if (idx < 0 || idx >= chars.length) {
      const fallback = first.find((f) => f.id === it.id);
      return {
        ...it,
        rx: fallback?.rx ?? 0,
        ry: fallback?.ry ?? 0,
      };
    }
    const anchor = chars[idx];
    return {
      ...it,
      rx: Math.round((anchor.cx / widthPx) * 10000) / 10000,
      ry: Math.round((anchor.cy / heightPx) * 10000) / 10000,
    };
  });
}

/** B 模式拼图批处理（模式 C 漏字时复用） */
async function runGridBatchesForChars(
  unresolved: CharItem[],
  bin: Uint8Array,
  width: number,
  height: number,
  cfg: ProviderConfig,
  budgetCny: number,
  provider: LLMProvider,
  patch: Map<string, Partial<CharItem>>,
  glyphDrafts: Map<string, GlyphVerifyInput>,
  usageTotal: { promptTokens: number; completionTokens: number },
  onBatchDone: (done: number, total: number, message: string) => void,
  marginTitleHint?: string,
): Promise<{ costCny: number; failedBatches: number }> {
  if (unresolved.length === 0) return { costCny: 0, failedBatches: 0 };
  const slices: CharItem[][] = [];
  for (let start = 0; start < unresolved.length; start += GRID_BATCH_SIZE) {
    slices.push(unresolved.slice(start, start + GRID_BATCH_SIZE));
  }
  let costCny = 0;
  let failedBatches = 0;
  let done = 0;
  let stoppedByBudget = false;
  await runPool(slices, Math.min(cfg.concurrency, 5), async (slice, idx) => {
    if (stoppedByBudget) {
      await downgradeBatch(slice, bin, width, height, patch, glyphDrafts);
      failedBatches += 1;
      return;
    }
    const batch = await buildGridBatch(slice, bin, width, height, idx);
    const localDraft = batch.ids.map((sliceIndex, id) => {
      const char = slice[sliceIndex];
      return { id, char: char?.text ?? null, confidence: char?.conf ?? 0 };
    });
    const cols = Math.min(GRID_COLS, slice.length);
    const rows = Math.ceil(slice.length / Math.max(1, cols));
    const pageNumberIds = batch.ids.map((sliceIndex, id) => (slice[sliceIndex]?.group === 'pageno' ? id : -1)).filter((id) => id >= 0);
    const rankIds = batch.ids.map((sliceIndex, id) => (slice[sliceIndex]?.group === 'rank' ? id : -1)).filter((id) => id >= 0);
    const titleIds = batch.ids.map((sliceIndex, id) => {
      const char = slice[sliceIndex];
      return char?.group === 'title' && (char.kind !== 'side' || char.cx > width * 0.5) ? id : -1;
    }).filter((id) => id >= 0);
    const marginTitleIds = batch.ids.map((sliceIndex, id) => {
      const char = slice[sliceIndex];
      return char?.group === 'title' && char.kind === 'side' && char.cx <= width * 0.5 ? id : -1;
    }).filter((id) => id >= 0);
    const initialPrompt = buildGridUserPrompt(cols, rows, slice.length, localDraft, pageNumberIds, rankIds, titleIds, marginTitleIds, marginTitleHint);
    const cacheKey = [
      RECOGNITION_PROMPT_VERSION,
      cfg.provider,
      cfg.model,
      hashBatch(slice, idx),
      fnv1a(batch.ids.join(',')),
      fnv1a(initialPrompt),
    ].join(':');
    const estimate = provider.estimateCost(slice.length);
    // 三次独立识别均要完成，预算不足时整批降级本地多裁剪投票，
    // 不能为了省一次复核而把两轮结果当作最终填充。
    if (costCny + estimate * 3 > budgetCny) {
      stoppedByBudget = true;
      await downgradeBatch(slice, bin, width, height, patch, glyphDrafts);
      failedBatches += 1;
      onBatchDone(done, slices.length, '已达单页成本上限，剩余批次降级本地识别');
      return;
    }
    const result = await recognizeOneBatch(provider, cfg, batch, cacheKey, initialPrompt);
    bumpSessionUploads(1);
    if (!result) {
      failedBatches += 1;
        await downgradeBatch(slice, bin, width, height, patch, glyphDrafts);
    } else {
      costCny += estimate;
      if (result.usage) {
        usageTotal.promptTokens += result.usage.promptTokens;
        usageTotal.completionTokens += result.usage.completionTokens;
      }
      let reviewedItems = deferIncompleteRecognition(result.items);
      let consensusRounds: RecognizedItem[][] | undefined;
      try {
        const reviewPrompt = buildReviewPrompt(JSON.stringify({ items: result.items }), slice.length, 2);
        const reviewKey = `${cacheKey}:review-2:${fnv1a(reviewPrompt)}`;
        const second = await recognizeOneBatch(provider, cfg, batch, reviewKey, reviewPrompt);
        if (second) {
          bumpSessionUploads(1);
          costCny += estimate;
          if (second.usage) {
            usageTotal.promptTokens += second.usage.promptTokens;
            usageTotal.completionTokens += second.usage.completionTokens;
          }
          onBatchDone(done, slices.length, `第 ${idx + 1}/${slices.length} 批第 2/3 轮核验完成，正在进行第 3 轮…`);
          const finalPrompt = buildReviewPrompt(
            JSON.stringify({ round1: result.items, round2: second.items }),
            slice.length,
            3,
          );
          const finalKey = `${cacheKey}:review-3:${fnv1a(finalPrompt)}`;
          const third = await recognizeOneBatch(provider, cfg, batch, finalKey, finalPrompt);
          if (third) {
            bumpSessionUploads(1);
            costCny += estimate;
            if (third.usage) {
              usageTotal.promptTokens += third.usage.promptTokens;
              usageTotal.completionTokens += third.usage.completionTokens;
            }
            consensusRounds = [result.items, second.items, third.items];
            reviewedItems = mergeThreeRecognitionPasses(result.items, second.items, third.items);
            onBatchDone(done, slices.length, `第 ${idx + 1}/${slices.length} 批三轮核验完成，正在按多数共识写入`);
          }
        }
      } catch (err) {
        console.warn('[orchestrator] 三轮模型核验未完整完成，不自动写入该批：', err);
      }
      const processed = postprocessItems(reviewedItems, { isGenealogy: true, strictConsensus: true });
      for (const item of processed) {
        const sliceIndex = batch.ids[item.id];
        const char = slice[sliceIndex];
        if (!char) continue;
        const valid = isValidChar(item.char, item.note);
        patch.set(char.id, {
          text: valid ? item.char : null,
          conf: valid ? item.confidence : 0,
          note: valid ? item.note ?? 'ok' : 'empty',
          source: 'llm',
        });
        if (valid) {
          glyphDrafts.set(char.id, {
            primary: item.char,
            modelConfidence: item.confidence,
            candidates: item.candidates,
            routeVotes: consensusRounds
              ? countRecognitionVotes(item.id, item.char, consensusRounds)
              : 0,
          });
        }
      }
    }
    done += 1;
    onBatchDone(done, slices.length, `拼图识别 ${done}/${slices.length} 批`);
  });
  return { costCny, failedBatches };
}

export interface RecognizePageResultFull {
  chars: CharItem[];
  outcome: RecognizePageOutcome;
}

export interface RecognizePageOptions {
  /**
   * 左页边书名提示（人工确认或项目级共识）。
   * 缺省时自动从本项目已高置信识别的页面共识推断；无共识则不注入任何书名偏向，
   * 保证新谱书图像识别的泛化能力。
   */
  bookTitle?: string;
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
  options?: RecognizePageOptions,
): Promise<RecognizePageResultFull> {
  assertModeAllowed(mode);
  // 书名提示：显式提供 → 归一化后使用；否则从项目自身页面共识推断（可能为 undefined = 零偏向）
  let marginTitleHint = parseMarginTitleHint(options?.bookTitle);
  if (!marginTitleHint) {
    marginTitleHint = await listPagesOfProject(page.projectId)
      .then((pages) => inferProjectMarginTitle(pages))
      .catch(() => undefined);
  }
  const totalChars = page.chars.length;
  const patch = new Map<string, Partial<CharItem>>();
  const glyphDrafts = new Map<string, GlyphVerifyInput>();
  // 已由分析阶段区域算法确定的页码同样锁定，避免识别阶段覆盖。
  const protectedPageNumbers = page.chars.filter((c) => c.group === 'pageno' && c.edited && Boolean(c.text));
  const protectedPageNumberIds = new Set(protectedPageNumbers.map((c) => c.id));
  for (const c of protectedPageNumbers) {
    patch.set(c.id, { text: c.text, conf: Math.max(c.conf, 0.99), note: 'ok', source: 'manual' });
  }
  const protectedSkip = new Set(protectedPageNumberIds);
  const segmentNotes = new Map(
    page.chars
      .filter((c) => c.note === 'split' || c.note === 'merge' || c.note === 'spacing')
      .map((c) => [c.id, c.note] as const),
  );
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
    const remembered = await recallCharacters(page.chars, bin, width, height, page.projectId).catch(() => new Map());
    const confirmedMemoryIds = new Set<string>();
    for (const char of page.chars) {
      const memory = remembered.get(char.id);
      // 模型/本地学习结果仍需本次三轮复核；只有重复的人工确认可直接复用。
      if (memory && memory.manualCount >= 2 && !protectedSkip.has(char.id)) {
        confirmedMemoryIds.add(char.id);
        patch.set(char.id, { text: memory.text, conf: memory.confidence, note: 'ok', source: 'local' });
      }
    }
    const unresolved = page.chars.filter((char) => !confirmedMemoryIds.has(char.id) && !protectedSkip.has(char.id));
    batchCount = Math.max(1, Math.ceil(unresolved.length / 12));
    report(0, `人工确认记忆命中 ${confirmedMemoryIds.size} 字，继续深度识别 ${unresolved.length} 字`);
    const results = await localOcrChars(unresolved, bin, width, height, (doneChars, total, detail) => {
      const done = Math.ceil((doneChars / Math.max(1, total)) * batchCount);
      report(done, detail ? `本地 OCR 初始化：${detail}` : `正在深度识别文字：${doneChars}/${total} 字，已完成多轮投票复核`);
    });
    for (const c of unresolved) {
      const result = results.get(c.id);
      const rawText = result?.text ?? null;
      const valid = isValidChar(rawText);
      const text = valid ? rawText : null;
      const conf = valid ? result?.confidence ?? 0 : 0;
      patch.set(c.id, { text, conf, note: text ? (conf >= CONFIDENCE_THRESHOLD ? 'ok' : 'blurry') : 'empty', source: 'local' });
      glyphDrafts.set(c.id, {
        primary: text,
        modelConfidence: conf,
        candidates: result?.candidates,
        routeVotes: result?.agreeingPasses ?? 0,
      });
    }
    report(batchCount, '本地深度识别完成：多轮结果已合并，低置信字请在画布校对');
  } else if (mode === 'B') {
    /* ---------- 模式 B：字符拼图上云（默认） ---------- */
    const provider = getProvider(cfg.provider);
    const remembered = await recallCharacters(page.chars, bin, width, height, page.projectId).catch(() => new Map());
    const confirmedMemoryIds = new Set<string>();
    for (const char of page.chars) {
      const memory = remembered.get(char.id);
      if (memory && memory.manualCount >= 2 && !protectedSkip.has(char.id)) {
        confirmedMemoryIds.add(char.id);
        patch.set(char.id, { text: memory.text, conf: memory.confidence, note: 'ok', source: 'local' });
      }
    }
    const unresolved = page.chars.filter((char) => !confirmedMemoryIds.has(char.id) && !protectedSkip.has(char.id));
    batchCount = Math.max(1, Math.ceil(unresolved.length / GRID_BATCH_SIZE));
    report(0, `人工确认记忆命中 ${confirmedMemoryIds.size} 字；其余 ${unresolved.length} 字分 ${batchCount} 批进行三轮模型校验`);
    const grid = await runGridBatchesForChars(
      unresolved,
      bin,
      width,
      height,
      cfg,
      budgetCny,
      provider,
      patch,
      glyphDrafts,
      usageTotal,
      (done, total, message) => report(Math.min(batchCount, done), message || `已完成 ${done}/${total} 批`),
      marginTitleHint,
    );
    costCny += grid.costCny;
    failedBatches += grid.failedBatches;

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
    /* ---------- 模式 C：锚点整页上云 + 拼图补识别（漏字/低置信回退 B） ---------- */
    const provider = getProvider(cfg.provider);
    const remembered = await recallCharacters(page.chars, bin, width, height, page.projectId).catch(() => new Map());
    const rememberedIds = new Set<string>();
    for (const char of page.chars) {
      const memory = remembered.get(char.id);
      if (memory && memory.manualCount >= 2 && !protectedSkip.has(char.id)) {
        rememberedIds.add(char.id);
        patch.set(char.id, { text: memory.text, conf: memory.confidence, note: 'ok', source: 'local' });
      }
    }
    for (const id of protectedSkip) rememberedIds.add(id);
    const needCloud = page.chars.filter((c) => !rememberedIds.has(c.id));
    const gridSliceCount = Math.max(0, Math.ceil(needCloud.length / GRID_BATCH_SIZE));
    batchCount = 15 + Math.max(1, gridSliceCount);

    let pageApplied = 0;
    if (provider.recognizePageImage && needCloud.length > 0) {
      const pageRoundEstimate = provider.estimateCost(totalChars) * 3;
      if (pageRoundEstimate * 3 > budgetCny) {
        failedBatches += 1;
        report(0, '单页预算不足以完成三轮整页核验，改用本地/拼图多轮识别');
      } else try {
        report(0, '正在编码整页图像…');
        const pageImageBase64 = await pageBinaryToPngBase64Downscaled(bin, width, height, PAGE_RECOGNITION_MAX_EDGE);
        // 无墨迹字框（分割噪声/空位）不作为锚点发给模型，避免模型对空白处编字
        const anchorChars = page.chars.map((c) => {
          const metrics = inkMetricsInBbox(bin, width, height, c.bbox);
          const hasInk = Boolean(metrics && metrics.inkArea >= 6 && metrics.fillRatio >= 0.04);
          return { ...c, skipAnchor: !hasInk || rememberedIds.has(c.id) };
        });
        const anchorPrompt = buildPageAnchoredUserPrompt(anchorChars, width, height, marginTitleHint);
        report(1, '正在调用云端 API 整页识别（第 1/3 轮）…');
        const { signal, cancel } = withTimeout(cfg.timeoutMs * 2);
        const result = await provider.recognizePageImage({ mode: 'C', pageImageBase64, promptOverride: anchorPrompt, signal }, cfg);
        cancel();
        bumpSessionUploads(1);
        costCny += pageRoundEstimate;
        if (result.usage) {
          usageTotal.promptTokens += result.usage.promptTokens;
          usageTotal.completionTokens += result.usage.completionTokens;
        }
        const firstItems = canonicalizeAnchoredPageItems(result.items, page.chars.length);
        let mergedItems = deferIncompleteRecognition(firstItems);
        let consensusRounds: RecognizedPageItem[][] | undefined;
        report(5, '整页初次识别完成，正在按相同锚点进行第 2/3 轮核验…');
        const reviewTimeout = withTimeout(cfg.timeoutMs * 2);
        try {
          const reviewPrompt = buildPageAnchoredReviewPrompt(
            JSON.stringify({ items: firstItems }),
            anchorChars,
            width,
            height,
            2,
          );
          const second = await provider.recognizePageImage({
            mode: 'C',
            pageImageBase64,
            promptOverride: reviewPrompt,
            signal: reviewTimeout.signal,
          }, cfg);
          reviewTimeout.cancel();
          if (second.items.length > 0) {
            bumpSessionUploads(1);
            const secondItems = canonicalizeAnchoredPageItems(second.items, page.chars.length);
            costCny += pageRoundEstimate;
            if (second.usage) {
              usageTotal.promptTokens += second.usage.promptTokens;
              usageTotal.completionTokens += second.usage.completionTokens;
            }
            report(9, '第 2/3 轮整页核验完成，正在进行第 3/3 轮最终确认…');
            const finalTimeout = withTimeout(cfg.timeoutMs * 2);
            try {
              const finalPrompt = buildPageAnchoredReviewPrompt(
                JSON.stringify({ round1: firstItems, round2: secondItems }),
                anchorChars,
                width,
                height,
                3,
              );
              const third = await provider.recognizePageImage({
                mode: 'C',
                pageImageBase64,
                promptOverride: finalPrompt,
                signal: finalTimeout.signal,
              }, cfg);
              finalTimeout.cancel();
              if (third.items.length > 0) {
                bumpSessionUploads(1);
                const thirdItems = canonicalizeAnchoredPageItems(third.items, page.chars.length);
                consensusRounds = [firstItems, secondItems, thirdItems];
                mergedItems = mergePageVerifiedItems(firstItems, secondItems, thirdItems, page.chars, width, height);
                costCny += pageRoundEstimate;
                if (third.usage) {
                  usageTotal.promptTokens += third.usage.promptTokens;
                  usageTotal.completionTokens += third.usage.completionTokens;
                }
              }
            } catch (err) {
              finalTimeout.cancel();
              console.warn('[orchestrator] 第三轮整页核验失败，不自动写入未完成共识的结果：', err);
            }
          }
        } catch (err) {
          reviewTimeout.cancel();
          console.warn('[orchestrator] 第二轮整页核验失败，不自动写入未完成共识的结果：', err);
        }
        report(12, '三轮整页核验完成，正在进行定位与字形校验…');
        mergedItems = canonicalizeAnchoredPageItems(mergedItems, page.chars.length);
        mergedItems = normalizeAnchoredPageItems(mergedItems, page.chars, width, height);
        pageApplied = fillFromAnchoredItems(mergedItems, page.chars, rememberedIds, patch, glyphDrafts, width, height, true);
        if (consensusRounds) {
          for (const item of mergedItems) {
            const char = page.chars[item.id];
            const draft = char ? glyphDrafts.get(char.id) : undefined;
            if (draft) draft.routeVotes = countRecognitionVotes(item.id, item.char, consensusRounds);
          }
        }
        report(14, `整页锚点三轮共识写入 ${pageApplied}/${needCloud.length} 字`);
      } catch (err) {
        console.warn('[orchestrator] 整页锚点识别失败，将改用拼图补识别：', err);
      }
    } else if (!provider.recognizePageImage) {
      console.warn(`[orchestrator] ${provider.label} 不支持整页识别，改用拼图识别`);
    }

    const needGrid = page.chars.filter((c) => {
      if (rememberedIds.has(c.id)) return false;
      const p = patch.get(c.id);
      return !p?.text;
    });
    if (needGrid.length > 0) {
      report(14, `拼图三轮补识别 ${needGrid.length} 字（整页已覆盖 ${pageApplied} 字）…`);
      const grid = await runGridBatchesForChars(
        needGrid,
        bin,
        width,
        height,
        cfg,
        Math.max(0, budgetCny - costCny),
        provider,
        patch,
        glyphDrafts,
        usageTotal,
        (done, total, message) => report(14 + Math.min(1, done / Math.max(1, total)), message),
        marginTitleHint,
      );
      costCny += grid.costCny;
      failedBatches += grid.failedBatches;
    }
    report(batchCount, '云端识别完成');
    await logAudit({
      mode: 'C',
      provider: cfg.provider,
      domain: providerDomain(provider, cfg),
      charCount: totalChars,
      batches: batchCount,
      pageId: page.id,
    }).catch(() => undefined);
  }

  let chars = applyRecognitionPatch(page.chars, patch, glyphDrafts, bin, width, height);

  chars = repairGenealogySequences(
    chars.map(correctAutomatedZiJieConfusion).map(markAutomatedHandwrittenRankForReview),
    { knownMarginTitle: marginTitleHint },
  );
  chars = normalizeKnownMarginTitleBoxes(chars, marginTitleHint, width);

  chars = chars.map((c) => {
    const segNote = segmentNotes.get(c.id);
    if (!segNote) return c;
    return {
      ...c,
      note: segNote,
      conf: Math.min(c.conf, CONFIDENCE_THRESHOLD - 0.01),
    };
  });

  await learnCharacters(chars, bin, width, height, page.id, page.projectId).catch(() => undefined);

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
  options?: RecognizePageOptions,
): Promise<RecognizePageResultFull> {
  const [ra, rb] = [
    await recognizePage(page, bin, width, height, cfgA, mode, Infinity, onProgress, options),
    await recognizePage(page, bin, width, height, cfgB, mode, Infinity, onProgress, options),
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
