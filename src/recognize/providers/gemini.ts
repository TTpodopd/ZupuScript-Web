/**
 * Google Gemini Provider（默认推荐，CORS 友好，PRD 9.4）。
 * 直连 generativelanguage.googleapis.com，responseSchema 强制结构化输出。
 */
import type {
  LLMProvider,
  ProviderConfig,
  RecognizeBatchRequest,
  RecognizeBatchResult,
  RecognizePageResult,
} from '../types';
import {
  buildGridUserPrompt,
  extractJson,
  GRID_RESPONSE_SCHEMA,
  PAGE_RESPONSE_SCHEMA,
  PAGE_USER_PROMPT,
  SYSTEM_PROMPT,
} from '../prompt';
import { TOKENS_PER_CHAR } from '@/lib/constants';
import { routeThroughProxy } from './endpoint';
import type { RecognizedItem, RecognizedPageItem } from '../types';

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

function endpointFor(cfg: ProviderConfig, model: string): string {
  const base = (cfg.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

async function callGemini(
  cfg: ProviderConfig,
  imageBase64: string,
  text: string,
  schema: object,
  signal: AbortSignal,
  charCount: number,
): Promise<{ json: unknown; usage?: { promptTokens: number; completionTokens: number } }> {
  if (!cfg.apiKey) throw new Error('未配置 Gemini API Key');
  const url = routeThroughProxy(cfg.proxyUrl, `${endpointFor(cfg, cfg.model)}?key=${encodeURIComponent(cfg.apiKey)}`);
  // max_tokens 动态：字数 × TOKENS_PER_CHAR，防 JSON 截断导致整批失败
  const maxTokens = Math.max(2048, charCount * TOKENS_PER_CHAR);
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [{ text }, { inline_data: { mime_type: 'image/png', data: imageBase64 } }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini 请求失败 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  if (data.error?.message) throw new Error(`Gemini 错误：${data.error.message}`);
  const text0 = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text0) throw new Error('Gemini 返回为空');
  return {
    json: extractJson(text0),
    usage: data.usageMetadata
      ? {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        }
      : undefined,
  };
}

function parseItems(json: unknown): RecognizedItem[] {
  const items = (json as { items?: unknown[] }).items;
  if (!Array.isArray(items)) throw new Error('返回缺少 items 数组');
  return items.map((raw) => {
    const it = raw as Record<string, unknown>;
    return {
      id: Number(it.id),
      char: it.char === null || it.char === undefined ? null : String(it.char),
      confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)),
      note: it.note as RecognizedItem['note'],
      simplified: typeof it.simplified === 'string' ? it.simplified : undefined,
      candidates: Array.isArray(it.candidates) ? it.candidates.map(String).slice(0, 3) : undefined,
    };
  });
}

export const geminiProvider: LLMProvider = {
  id: 'gemini',
  label: 'Google Gemini（推荐）',
  needsKey: true,
  defaultEndpoint: DEFAULT_ENDPOINT,
  defaultModel: 'gemini-2.0-flash',

  async recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult> {
    if (!req.batch) throw new Error('B 模式请求缺少拼图');
    const cols = Math.min(10, req.batch.ids.length);
    const rows = Math.ceil(req.batch.ids.length / cols);
    const { json, usage } = await callGemini(
      cfg,
      req.batch.imageBase64Png,
      req.promptOverride ?? buildGridUserPrompt(cols, rows, req.batch.ids.length),
      GRID_RESPONSE_SCHEMA,
      req.signal,
      req.batch.ids.length,
    );
    return { items: parseItems(json), usage };
  },

  async recognizePageImage(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult> {
    if (!req.pageImageBase64) throw new Error('C 模式请求缺少整页图');
    const { json, usage } = await callGemini(cfg, req.pageImageBase64, req.promptOverride ?? PAGE_USER_PROMPT, PAGE_RESPONSE_SCHEMA, req.signal, 500);
    const items = parseItems(json).map((it, i) => {
      const raw = (json as { items: Array<Record<string, unknown>> }).items[i];
      const pageItem: RecognizedPageItem = {
        ...it,
        rx: Math.max(0, Math.min(1, Number(raw?.rx) || 0)),
        ry: Math.max(0, Math.min(1, Number(raw?.ry) || 0)),
      };
      return pageItem;
    });
    return { items, usage };
  },

  estimateCost(charCount: number): number {
    // 粗略估算：每批（100字）约 1500 输入 token（图）+ 600 输出 token，按 flash 级定价
    const batches = Math.ceil(charCount / 100);
    return batches * 0.01;
  },
};
