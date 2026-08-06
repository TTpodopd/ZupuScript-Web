/**
 * Anthropic Claude Provider。
 * PRD 9.4：浏览器直调必须带 anthropic-dangerous-direct-browser-access 请求头。
 * Claude 无 response_format，改用工具调用（tool_use）强制结构化输出。
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
import { buildGridUserPrompt, GRID_RESPONSE_SCHEMA, PAGE_RESPONSE_SCHEMA, PAGE_USER_PROMPT, SYSTEM_PROMPT } from '../prompt';
import { TOKENS_PER_CHAR } from '@/lib/constants';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com';

interface AnthropicResponse {
  content?: Array<{ type: string; input?: unknown; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

async function callAnthropic(
  cfg: ProviderConfig,
  imageBase64: string,
  text: string,
  toolName: string,
  schema: object,
  signal: AbortSignal,
  charCount: number,
): Promise<{ json: unknown; usage?: { promptTokens: number; completionTokens: number } }> {
  if (!cfg.apiKey) throw new Error('未配置 Anthropic API Key');
  const base = (cfg.proxyUrl || cfg.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
  const maxTokens = Math.max(2048, charCount * TOKENS_PER_CHAR);
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
          { type: 'text', text },
        ],
      },
    ],
    tools: [
      {
        name: toolName,
        description: '按识别结果填写，严格遵守六条硬规则。',
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: toolName },
  };
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // PRD 9.4 要求：浏览器直调必须声明此头
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic 请求失败 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as AnthropicResponse;
  if (data.error?.message) throw new Error(`Anthropic 错误：${data.error.message}`);
  const toolUse = data.content?.find((c) => c.type === 'tool_use');
  if (!toolUse?.input) throw new Error('Anthropic 未返回结构化结果');
  return {
    json: toolUse.input,
    usage: data.usage
      ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0 }
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

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  needsKey: true,
  defaultEndpoint: DEFAULT_ENDPOINT,
  defaultModel: 'claude-sonnet-4-5',

  async recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult> {
    if (!req.batch) throw new Error('B 模式请求缺少拼图');
    const cols = Math.min(10, req.batch.ids.length);
    const rows = Math.ceil(req.batch.ids.length / cols);
    const { json, usage } = await callAnthropic(
      cfg,
      req.batch.imageBase64Png,
      buildGridUserPrompt(cols, rows, req.batch.ids.length),
      'submit_grid_recognition',
      GRID_RESPONSE_SCHEMA,
      req.signal,
      req.batch.ids.length,
    );
    return { items: parseItems(json), usage };
  },

  async recognizePageImage(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult> {
    if (!req.pageImageBase64) throw new Error('C 模式请求缺少整页图');
    const { json, usage } = await callAnthropic(
      cfg,
      req.pageImageBase64,
      PAGE_USER_PROMPT,
      'submit_page_recognition',
      PAGE_RESPONSE_SCHEMA,
      req.signal,
      500,
    );
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
    return batches * 0.03;
  },
};
