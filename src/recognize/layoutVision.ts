/**
 * 边框版面视觉分析编排：上传整页图 → 输出定位/规则文档 → 供本地 merge。
 * 失败时自动降级为纯本地检测，429 限流时会话内跳过后续视觉请求。
 */
import type { BorderLayoutGuide, BorderRect, TagRect } from '@/model/types';
import { LAYOUT_VISION_MAX_EDGE, LAYOUT_VISION_RATE_LIMIT_COOLDOWN_MS } from '@/lib/constants';
import { pageBinaryToPngBase64Downscaled } from '@/segment/grid';
import { assertModeAllowed } from '@/privacy/consent';
import { bumpSessionUploads, logAudit } from '@/privacy/audit';
import { backoffDelay } from '@/lib/utils';
import { describeActiveModel } from './buildConfig';
import { callLayoutBorderVision } from './providers/layoutVisionCall';
import { getProvider, providerDomain } from './orchestrator';
import type { ProviderConfig } from './types';
import type { PrivacyMode } from '@/model/types';

export interface LayoutVisionProgress {
  stage: 'encode' | 'vision' | 'done';
  message: string;
}

export interface LayoutVisionOutcome {
  guide: BorderLayoutGuide;
  costCny: number;
}

const VISION_MAX_RETRIES = 3;

/** 本会话内因 429 暂停视觉边框分析的时间戳 */
let visionRateLimitedUntil = 0;

function estimateLayoutVisionCost(cfg: ProviderConfig): number {
  if (cfg.provider === 'local') return 0;
  const p = getProvider(cfg.provider);
  return Math.max(0.02, p.estimateCost(80));
}

/** 是否可用视觉边框分析（与识别共用 cfg，不再单独选模型） */
export function canUseVisionLayout(cfg: ProviderConfig, mode: PrivacyMode): boolean {
  if (mode === 'A' || cfg.provider === 'local' || shouldSkipVisionLayout()) return false;
  if (!cfg.model?.trim()) return false;
  if (cfg.provider === 'custom' && !cfg.endpoint?.trim()) return false;
  return Boolean(cfg.apiKey || cfg.endpoint?.includes('localhost') || cfg.endpoint?.includes('127.0.0.1'));
}

export function isRetryableVisionHttpStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 502 || status === 503 || status === 504;
}

export function isRetryableVisionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bHTTP (429|408|502|503|504)\b/.test(message)
    || /rate limit|too many requests|quota|resource exhausted/i.test(message);
}

/** 429 后本会话内跳过视觉边框分析 */
export function shouldSkipVisionLayout(): boolean {
  return Date.now() < visionRateLimitedUntil;
}

export function markVisionRateLimited(err: unknown): void {
  if (!isRetryableVisionError(err)) return;
  visionRateLimitedUntil = Date.now() + LAYOUT_VISION_RATE_LIMIT_COOLDOWN_MS;
}

/** 用户可见的降级提示（不暴露原始 JSON） */
export function formatVisionFallbackMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\bHTTP 429\b/i.test(message) || /rate limit|too many requests/i.test(message)) {
    return '视觉边框辅助已跳过（API 请求过于频繁），继续使用本地版面检测…';
  }
  if (/quota|billing|insufficient|余额|额度/i.test(message)) {
    return '视觉边框辅助已跳过（API 额度不足），继续使用本地版面检测…';
  }
  if (/HTTP 401|HTTP 403|invalid.*key|未配置 API Key/i.test(message)) {
    return '视觉边框辅助已跳过（API 密钥无效），继续使用本地版面检测…';
  }
  return '视觉边框辅助不可用，继续使用本地版面检测…';
}

/**
 * 调用视觉模型，生成本页边框定位与规则文档。
 * @param localDraft 本地 CV 初稿，供模型对照修正
 */
export async function analyzeBorderLayoutVision(
  bin: Uint8Array,
  width: number,
  height: number,
  localDraft: { borderRects: BorderRect[]; tagRects: TagRect[] } | undefined,
  cfg: ProviderConfig,
  mode: PrivacyMode,
  onProgress?: (p: LayoutVisionProgress) => void,
  signal?: AbortSignal,
): Promise<LayoutVisionOutcome> {
  assertModeAllowed(mode);
  if (mode === 'A' || cfg.provider === 'local') {
    throw new Error('全本地模式无法使用视觉边框分析');
  }
  if (shouldSkipVisionLayout()) {
    throw new Error('视觉边框分析因限流暂时跳过');
  }

  onProgress?.({ stage: 'encode', message: '正在编码页面图像…' });
  const imageBase64 = await pageBinaryToPngBase64Downscaled(bin, width, height, LAYOUT_VISION_MAX_EDGE);
  const modelLabel = describeActiveModel(cfg);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= VISION_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      onProgress?.({ stage: 'vision', message: `${modelLabel} 限流，${attempt}/${VISION_MAX_RETRIES} 次重试…` });
      await backoffDelay(attempt - 1, 2000);
    } else {
      onProgress?.({ stage: 'vision', message: `视觉边框分析（${modelLabel}）…` });
    }
    try {
      const guide = await callLayoutBorderVision(
        cfg,
        imageBase64,
        width,
        height,
        localDraft,
        signal ?? AbortSignal.timeout(cfg.timeoutMs),
      );
      await bumpSessionUploads(1);
      const provider = getProvider(cfg.provider);
      await logAudit({
        mode,
        provider: cfg.provider,
        domain: providerDomain(provider, cfg),
        charCount: 0,
        batches: 1,
      });
      onProgress?.({ stage: 'done', message: guide.summary || '边框规则已生成' });
      return { guide, costCny: estimateLayoutVisionCost(cfg) };
    } catch (err) {
      lastErr = err;
      if (attempt >= VISION_MAX_RETRIES || !isRetryableVisionError(err)) {
        markVisionRateLimited(err);
        throw err;
      }
    }
  }
  markVisionRateLimited(lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
