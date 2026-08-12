import { isForcedLocal } from '@/privacy/consent';
import { loadApiKey } from '@/privacy/keystore';
import { getProvider } from '@/recognize/orchestrator';
import type { ProviderConfig } from '@/recognize/types';
import { LOCAL_MODEL_CONNECTION_ID, useSettingsStore } from '@/store/settingsStore';
import type { PrivacyMode } from '@/model/types';
import { RECOGNITION_PROMPT_VERSION } from './prompt';

/** 当前是否应走全本地识别（与设置里「本地模型」选项对齐） */
export function isLocalRecognitionMode(mode?: PrivacyMode): boolean {
  if (isForcedLocal()) return true;
  const settings = useSettingsStore.getState();
  const resolved = mode ?? settings.privacyMode;
  return (
    resolved === 'A'
    || settings.activeConnectionId === LOCAL_MODEL_CONNECTION_ID
    || settings.provider.provider === 'local'
  );
}

/** 解析实际识别模式：本地 = A，远端统一 = C（整页上云） */
export function resolveRecognitionMode(): PrivacyMode {
  if (isLocalRecognitionMode()) return 'A';
  return 'C';
}

/** 识别配置签名（含提示词版本，算法升级后自动触发重识别） */
export function currentRecognitionSettingsKey(): string {
  const settings = useSettingsStore.getState();
  const mode = resolveRecognitionMode();
  return `${mode}:${settings.activeConnectionId}:${settings.activeModelId}:${RECOGNITION_PROMPT_VERSION}`;
}

/** 构造完全本地的识别配置，不访问 keystore 或任何云端 Provider。 */
export function buildLocalProviderConfig(): ProviderConfig {
  const settings = useSettingsStore.getState();
  return {
    provider: 'local',
    model: 'local-tesseract',
    concurrency: settings.concurrency,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
  };
}

/** 从设置与 keystore 构建识别配置（分析页批处理与识别面板共用） */
export async function buildProviderConfig(
  passphrase?: string,
  apiKeyOverride?: string,
): Promise<{ cfg: ProviderConfig; mode: PrivacyMode }> {
  const settings = useSettingsStore.getState();
  const mode = resolveRecognitionMode();

  if (mode === 'A') {
    return {
      mode,
      cfg: buildLocalProviderConfig(),
    };
  }

  const connection = settings.activeConnection();
  const model = connection?.models.find((m) => m.id === settings.activeModelId);
  const providerId = connection?.provider ?? settings.provider.provider;

  const override = apiKeyOverride?.trim();
  const fromConnection = connection ? await loadApiKey(connection.id, passphrase) : null;
  const fromProvider = await loadApiKey(providerId, passphrase);
  const storedKey = override || fromConnection || fromProvider || undefined;

  if (!storedKey) {
    throw new Error('未配置 API Key，请在「设置 → 模型接入」中保存密钥（默认加密存于本机）');
  }
  if (providerId === 'custom' && !(connection?.endpoint || settings.provider.endpoint)?.trim()) {
    throw new Error('未配置 API Base URL，请在「设置 → 模型接入」中填写');
  }

  const modelId =
    model?.id ||
    settings.activeModelId ||
    settings.provider.model ||
    getProvider(providerId)?.defaultModel ||
    '';

  return {
    mode,
    cfg: {
      provider: providerId,
      apiKey: storedKey,
      endpoint: connection?.endpoint || settings.provider.endpoint || undefined,
      proxyUrl: connection?.proxyUrl || settings.provider.proxyUrl || undefined,
      model: modelId,
      concurrency: settings.concurrency,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
    },
  };
}

/** 当前激活模型的可读标签（视觉/识别进度展示） */
export function describeActiveModel(cfg?: Pick<ProviderConfig, 'model' | 'provider'>): string {
  if (cfg?.provider === 'local') return '本地模型（Tesseract）';
  const settings = useSettingsStore.getState();
  if (settings.activeConnectionId === LOCAL_MODEL_CONNECTION_ID) return '本地模型（Tesseract）';
  const connection = settings.activeConnection();
  const active = connection?.models.find((m) => m.id === settings.activeModelId);
  const modelId = cfg?.model || active?.id || settings.provider.model;
  const modelName = active?.name?.trim();
  if (modelName && modelName !== modelId) return `${modelName}（${modelId}）`;
  return modelId || '未配置模型';
}
