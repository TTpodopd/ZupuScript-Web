/**
 * DeepSeek 官方 API（OpenAI 兼容 chat/completions）。
 * 密钥经 privacy/keystore 加密持久化到本机 IndexedDB。
 */
import type { LLMProvider, ProviderConfig, RecognizeBatchRequest, RecognizeBatchResult, RecognizePageResult } from '../types';
import { customProvider } from './custom';

const DEFAULT_ENDPOINT = 'https://api.deepseek.com';

function withDefaults(cfg: ProviderConfig): ProviderConfig {
  return {
    ...cfg,
    endpoint: cfg.endpoint?.trim() || DEFAULT_ENDPOINT,
    apiKey: cfg.apiKey,
  };
}

export const deepseekProvider: LLMProvider = {
  id: 'deepseek',
  label: 'DeepSeek',
  needsKey: true,
  defaultEndpoint: DEFAULT_ENDPOINT,
  defaultModel: 'deepseek-v4-flash',

  recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult> {
    if (!cfg.apiKey) throw new Error('未配置 DeepSeek API Key');
    return customProvider.recognize(req, withDefaults(cfg));
  },

  recognizePageImage(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult> {
    if (!cfg.apiKey) throw new Error('未配置 DeepSeek API Key');
    return customProvider.recognizePageImage!(req, withDefaults(cfg));
  },

  estimateCost(charCount: number): number {
    return customProvider.estimateCost(charCount);
  },
};
