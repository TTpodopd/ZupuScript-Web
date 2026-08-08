/**
 * 多模态 JSON 调用：与字符识别共用同一套 Provider / endpoint / model 配置。
 * 版面视觉、整页识别等场景统一经此出口，避免重复路由与模型选择分叉。
 */
import { TOKENS_PER_CHAR } from '@/lib/constants';
import { extractJson } from '../prompt';
import type { ProviderConfig } from '../types';
import { routeThroughProxy } from './endpoint';

export interface MultimodalJsonRequest {
  systemPrompt: string;
  userPrompt: string;
  imageBase64: string;
  tokenBudget?: number;
  schema?: object;
  schemaName?: string;
  signal: AbortSignal;
}

function tokenBudget(req: MultimodalJsonRequest): number {
  return req.tokenBudget ?? Math.max(2048, 80 * TOKENS_PER_CHAR);
}

function formatHttpError(label: string, status: number, detail: string): string {
  if (status === 429) return `${label} HTTP 429：API 请求过于频繁`;
  if (status === 401 || status === 403) return `${label} HTTP ${status}：API 密钥无效或无权限`;
  const snippet = detail.replace(/\s+/g, ' ').slice(0, 120);
  return snippet ? `${label} HTTP ${status}：${snippet}` : `${label} HTTP ${status}：请求失败`;
}

async function callGemini(cfg: ProviderConfig, req: MultimodalJsonRequest, maxTokens: number): Promise<unknown> {
  if (!cfg.apiKey) throw new Error('未配置 Gemini API Key');
  const base = (cfg.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const url = routeThroughProxy(
    cfg.proxyUrl,
    `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
  );
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents: [{
      role: 'user',
      parts: [{ text: req.userPrompt }, { inline_data: { mime_type: 'image/png', data: req.imageBase64 } }],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    },
  };
  if (req.schema) body.generationConfig = { ...(body.generationConfig as object), responseSchema: req.schema };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: req.signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(formatHttpError('Gemini', res.status, detail));
  }
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (data.error?.message) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 返回为空');
  return extractJson(text);
}

async function callOpenAI(cfg: ProviderConfig, req: MultimodalJsonRequest, maxTokens: number): Promise<unknown> {
  if (!cfg.apiKey) throw new Error('未配置 OpenAI API Key');
  const base = (cfg.endpoint || 'https://api.openai.com').replace(/\/$/, '').replace(/\/v1$/, '');
  const body: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: req.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: req.userPrompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
        ],
      },
    ],
  };
  if (req.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.schemaName ?? 'structured_output', strict: true, schema: req.schema },
    };
  } else {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(routeThroughProxy(cfg.proxyUrl, `${base}/v1/chat/completions`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(formatHttpError('OpenAI', res.status, detail));
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; error?: { message?: string } };
  if (data.error?.message) throw new Error(data.error.message);
  const raw = data.choices?.[0]?.message?.content;
  const content = Array.isArray(raw) ? raw.map((part) => part.text ?? '').join('') : raw;
  if (!content) throw new Error('OpenAI 返回为空');
  return extractJson(content);
}

async function callCompatible(cfg: ProviderConfig, req: MultimodalJsonRequest, maxTokens: number): Promise<unknown> {
  let base = (cfg.endpoint || '').replace(/\/$/, '');
  if (!base) throw new Error('未配置 API Base URL');
  base = base.replace(/\/v1$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: req.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: req.userPrompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };
  const res = await fetch(routeThroughProxy(cfg.proxyUrl, `${base}/v1/chat/completions`), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(formatHttpError('兼容端点', res.status, detail));
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; error?: { message?: string } };
  if (data.error?.message) throw new Error(data.error.message);
  const raw = data.choices?.[0]?.message?.content;
  const content = Array.isArray(raw) ? raw.map((part) => part.text ?? '').join('') : raw;
  if (!content) throw new Error('兼容端点返回为空');
  return extractJson(content);
}

async function callAnthropic(cfg: ProviderConfig, req: MultimodalJsonRequest, maxTokens: number): Promise<unknown> {
  if (!cfg.apiKey) throw new Error('未配置 Anthropic API Key');
  const base = (cfg.endpoint || 'https://api.anthropic.com').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: 0,
    system: req.systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.imageBase64 } },
        { type: 'text', text: req.userPrompt },
      ],
    }],
  };
  if (req.schema) {
    const toolName = req.schemaName ?? 'structured_output';
    body.tools = [{ name: toolName, description: req.systemPrompt, input_schema: req.schema }];
    body.tool_choice = { type: 'tool', name: toolName };
  }
  const res = await fetch(routeThroughProxy(cfg.proxyUrl, `${base}/v1/messages`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(formatHttpError('Anthropic', res.status, detail));
  }
  const data = (await res.json()) as { content?: Array<{ type: string; input?: unknown; text?: string }>; error?: { message?: string } };
  if (data.error?.message) throw new Error(data.error.message);
  if (req.schema) {
    const toolUse = data.content?.find((part) => part.type === 'tool_use');
    if (!toolUse?.input) throw new Error('Anthropic 未返回结构化结果');
    return toolUse.input;
  }
  const text = data.content?.find((part) => part.type === 'text')?.text;
  if (!text) throw new Error('Anthropic 返回为空');
  return extractJson(text);
}

/** 按 settings 中已选 Provider + model 发起多模态 JSON 请求 */
export async function callConfiguredMultimodalJson(
  cfg: ProviderConfig,
  req: MultimodalJsonRequest,
): Promise<unknown> {
  if (!cfg.model?.trim()) {
    throw new Error('未配置模型 ID，请在「设置 → 模型接入」中选择模型');
  }
  const maxTokens = tokenBudget(req);
  switch (cfg.provider) {
    case 'gemini':
      return callGemini(cfg, req, maxTokens);
    case 'openai':
      return callOpenAI(cfg, req, maxTokens);
    case 'anthropic':
      return callAnthropic(cfg, req, maxTokens);
    case 'custom':
      return callCompatible(cfg, req, maxTokens);
    default:
      throw new Error(`当前模式（${cfg.provider}）不支持视觉分析`);
  }
}
