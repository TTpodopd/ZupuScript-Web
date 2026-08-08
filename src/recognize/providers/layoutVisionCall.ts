/**
 * 边框版面视觉分析：直接复用 settings 中已配置的 Provider / model。
 */
import type { BorderLayoutGuide } from '@/model/types';
import {
  buildLayoutBorderUserPrompt,
  LAYOUT_BORDER_PROMPT_VERSION,
  LAYOUT_BORDER_RESPONSE_SCHEMA,
  LAYOUT_BORDER_SYSTEM_PROMPT,
} from '../prompt';
import type { ProviderConfig } from '../types';
import { callConfiguredMultimodalJson } from './multimodalJson';

export interface LayoutVisionDraft {
  borderRects: Array<{ x: number; y: number; w: number; h: number }>;
  tagRects: Array<{ x: number; y: number; w: number; h: number }>;
}

function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function parseLayoutBorderGuide(json: unknown, meta?: BorderLayoutGuide['meta']): BorderLayoutGuide {
  const root = json as Record<string, unknown>;
  const frameRaw = (root.frame ?? {}) as Record<string, unknown>;
  const insetRaw = frameRaw.inset as Record<string, unknown> | undefined;
  return {
    version: LAYOUT_BORDER_PROMPT_VERSION,
    confidence: clamp01(root.confidence),
    summary: String(root.summary ?? ''),
    rules: Array.isArray(root.rules) ? root.rules.map(String).slice(0, 8) : [],
    frame: {
      hasOuterFrame: Boolean(frameRaw.hasOuterFrame),
      inset: insetRaw
        ? {
            top: clamp01(insetRaw.top),
            right: clamp01(insetRaw.right),
            bottom: clamp01(insetRaw.bottom),
            left: clamp01(insetRaw.left),
          }
        : undefined,
      thicknessPx: frameRaw.thicknessPx ? Math.max(1, Number(frameRaw.thicknessPx)) : undefined,
    },
    borderBars: Array.isArray(root.borderBars)
      ? root.borderBars.map((raw) => {
          const b = raw as Record<string, unknown>;
          return {
            role: (['frame', 'divider', 'decoration'].includes(String(b.role)) ? b.role : 'frame') as 'frame' | 'divider' | 'decoration',
            side: ['top', 'bottom', 'left', 'right'].includes(String(b.side))
              ? (b.side as 'top' | 'bottom' | 'left' | 'right')
              : undefined,
            x: clamp01(b.x),
            y: clamp01(b.y),
            w: clamp01(b.w),
            h: clamp01(b.h),
            confidence: clamp01(b.confidence),
          };
        })
      : [],
    tagBlocks: Array.isArray(root.tagBlocks)
      ? root.tagBlocks.map((raw) => {
          const t = raw as Record<string, unknown>;
          return { x: clamp01(t.x), y: clamp01(t.y), w: clamp01(t.w), h: clamp01(t.h), confidence: clamp01(t.confidence) };
        })
      : [],
    excludeZones: Array.isArray(root.excludeZones)
      ? root.excludeZones.map((raw) => {
          const z = raw as Record<string, unknown>;
          return { x: clamp01(z.x), y: clamp01(z.y), w: clamp01(z.w), h: clamp01(z.h), reason: String(z.reason ?? '') };
        })
      : [],
    meta,
  };
}

/** 调用已配置模型，输出边框定位规则文档 */
export async function callLayoutBorderVision(
  cfg: ProviderConfig,
  imageBase64: string,
  widthPx: number,
  heightPx: number,
  localDraft: LayoutVisionDraft | undefined,
  signal: AbortSignal,
): Promise<BorderLayoutGuide> {
  const userPrompt = buildLayoutBorderUserPrompt(widthPx, heightPx, localDraft);
  const useStrictSchema = cfg.provider === 'gemini' || cfg.provider === 'openai';
  const json = await callConfiguredMultimodalJson(cfg, {
    systemPrompt: LAYOUT_BORDER_SYSTEM_PROMPT,
    userPrompt,
    imageBase64,
    schema: useStrictSchema ? LAYOUT_BORDER_RESPONSE_SCHEMA : undefined,
    schemaName: 'border_layout',
    signal,
  });
  return parseLayoutBorderGuide(json, {
    provider: cfg.provider,
    model: cfg.model,
    analyzedAt: Date.now(),
  });
}
