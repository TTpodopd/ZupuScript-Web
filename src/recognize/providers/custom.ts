/**
 * 自定义 OpenAI 兼容端点 Provider（F4.1）：
 * 阿里百炼 / 智谱 / DeepSeek / Ollama 本地 / 任意 OpenAI 兼容网关。
 * 预置 endpoint 模板在设置界面下拉选择；CORS 不通时可填可选代理 URL（PRD 6.3）。
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
import { buildGridUserPrompt, extractJson, PAGE_USER_PROMPT, SYSTEM_PROMPT } from '../prompt';
import { TOKENS_PER_CHAR } from '@/lib/constants';

/** 预置端点模板（设置界面下拉） */
export const ENDPOINT_PRESETS: Array<{ label: string; endpoint: string; model: string }> = [
  { label: '阿里百炼（通义千问）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-vl-max' },
  { label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
  { label: 'DeepSeek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: 'Ollama 本地（隐私最佳）', endpoint: 'http://localhost:11434', model: 'qwen2.5vl:7b' },
  { label: '自定义 OpenAI 兼容端点', endpoint: '', model: '' },
];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function callCompatible(
  cfg: ProviderConfig,
  imageBase64: string,
  text: string,
  signal: AbortSignal,
  charCount: number,
): Promise<{ json: unknown; usage?: { promptTokens: number; completionTokens: number } }> {
  const base = (cfg.proxyUrl || cfg.endpoint || '').replace(/\/$/, '');
  if (!base) throw new Error('自定义端点未配置 endpoint');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const maxTokens = Math.max(2048, charCount * TOKENS_PER_CHAR);
  const body: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0,
    max_tokens: maxTokens,
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
  };
  // 兼容端点对 json_schema 支持不一：优先 response_format json_object + 提示词约束
  body.response_format = { type: 'json_object' };
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`端点请求失败 HTTP ${res.status}：${detail.slice(0, 200)}（若 CORS 报错请配置代理 URL）`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  if (data.error?.message) throw new Error(`端点错误：${data.error.message}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('端点返回为空');
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

export const customProvider: LLMProvider = {
  id: 'custom',
  label: '自定义 / 国内厂商（OpenAI 兼容）',
  needsKey: false,
  defaultEndpoint: '',
  defaultModel: '',

  async recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult> {
    if (!req.batch) throw new Error('B 模式请求缺少拼图');
    const cols = Math.min(10, req.batch.ids.length);
    const rows = Math.ceil(req.batch.ids.length / cols);
    const { json, usage } = await callCompatible(
      cfg,
      req.batch.imageBase64Png,
      buildGridUserPrompt(cols, rows, req.batch.ids.length),
      req.signal,
      req.batch.ids.length,
    );
    return { items: parseItems(json), usage };
  },

  async recognizePageImage(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult> {
    if (!req.pageImageBase64) throw new Error('C 模式请求缺少整页图');
    const { json, usage } = await callCompatible(cfg, req.pageImageBase64, PAGE_USER_PROMPT, req.signal, 500);
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
    return batches * 0.008; // 国内厂商普遍更便宜，粗略估
  },
};
