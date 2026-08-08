import { isForcedLocal } from '@/privacy/consent';
import { loadApiKey } from '@/privacy/keystore';
import { getProvider } from '@/recognize/orchestrator';
import type { ProviderConfig } from '@/recognize/types';
import { useSettingsStore } from '@/store/settingsStore';
import type { PrivacyMode } from '@/model/types';

/** 从设置与 keystore 构建识别配置（分析页批处理与识别面板共用） */
export async function buildProviderConfig(
  passphrase?: string,
  apiKeyOverride?: string,
): Promise<{ cfg: ProviderConfig; mode: PrivacyMode }> {
  const settings = useSettingsStore.getState();
  const forcedLocal = isForcedLocal();
  const mode: PrivacyMode = forcedLocal ? 'A' : settings.privacyMode;

  if (mode === 'A') {
    return {
      mode,
      cfg: {
        provider: 'local',
        model: 'local-tesseract',
        concurrency: settings.concurrency,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
      },
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
