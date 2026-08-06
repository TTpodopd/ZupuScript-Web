/**
 * OpenAI Provider（PRD 9.4：支持浏览器直调，需提示密钥暴露风险，建议限额子密钥）。
 * 使用 chat/completions + response_format json_schema 强制结构化输出。
 */
import type {
  LLMProvider,
  ProviderConfig,
  RecognizeBatchRequest,
  RecognizeBatchResult,
  RecognizePageResult,
  RecognizedItem,
  RecognizedPageItem,
} from '../types';
import {
  buildGridUserPrompt,
  extractJson,
  GRID_RESPONSE_SCHEMA,
  PAGE_RESPONSE_SCHEMA,
  PAGE_USER_PROMPT,
  SYSTEM_PROMPT,
} from '../prompt';

const DEFAULT_ENDPOINT = 'https://api.openai.com';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function callOpenAI(
  cfg: ProviderConfig,
  imageBase64: string,
  text: string,
  schemaName: string,
  schema: object,
  signal: AbortSignal,
): Promise<{ json: unknown; usage?: { promptTokens: number; completionTokens: number } }> {
  if (!cfg.apiKey) throw new Error('未配置 OpenAI API Key');
  const base = (cfg.proxyUrl || cfg.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
  const body = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    },
  };
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI 请求失败 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  if (data.error?.message) throw new Error(`OpenAI 错误：${data.error.message}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI 返回为空');
  return {
    json: extractJson(content),
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
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
    };
  });
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  label: 'OpenAI（建议限额子密钥）',
  needsKey: true,
  defaultEndpoint: DEFAULT_ENDPOINT,
  defaultModel: 'gpt-4o-mini',

  async recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult> {
    if (!req.batch) throw new Error('B 模式请求缺少拼图');
    const cols = Math.min(10, req.batch.ids.length);
    const rows = Math.ceil(req.batch.ids.length / cols);
    const { json, usage } = await callOpenAI(
      cfg,
      req.batch.imageBase64Png,
      buildGridUserPrompt(cols, rows, req.batch.ids.length),
      'grid_recognition',
      GRID_RESPONSE_SCHEMA,
      req.signal,
    );
    return { items: parseItems(json), usage };
  },

  async recognizePageImage(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult> {
    if (!req.pageImageBase64) throw new Error('C 模式请求缺少整页图');
    const { json, usage } = await callOpenAI(cfg, req.pageImageBase64, PAGE_USER_PROMPT, 'page_recognition', PAGE_RESPONSE_SCHEMA, req.signal);
    const rawItems = (json as { items: Array<Record<string, unknown>> }).items;
    const items: RecognizedPageItem[] = parseItems(json).map((it, i) => ({
      ...it,
      rx: Math.max(0, Math.min(1, Number(rawItems[i]?.rx) || 0)),
      ry: Math.max(0, Math.min(1, Number(rawItems[i]?.ry) || 0)),
    }));
    return { items, usage };
  },

  estimateCost(charCount: number): number {
    const batches = Math.ceil(charCount / 100);
    return batches * 0.012;
  },
};
