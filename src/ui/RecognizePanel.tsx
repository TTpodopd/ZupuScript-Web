/**
 * 识别面板（F4.x）：模式 A/B/C、Provider 选择、成本预估（F4.9）、
 * 上行拼图预览（P1.3）、首次云端同意弹窗（P1.1）、实时进度。
 * 唯一出网点为 recognize/orchestrator.ts。
 */
import { useState } from 'react';
import { Eye, Loader2, Play, ShieldCheck } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { CONFIDENCE_THRESHOLD, GRID_BATCH_SIZE } from '@/lib/constants';
import type { Page, PrivacyMode } from '@/model/types';
import { grantConsent, hasConsented, isForcedLocal } from '@/privacy/consent';
import { loadApiKey, saveApiKey } from '@/privacy/keystore';
import { getBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getProvider, providerDomain, recognizePage } from '@/recognize/orchestrator';
import type { ProviderConfig, ProviderId, RecognizeProgress } from '@/recognize/types';
import { buildGridBatch } from '@/segment/grid';
import { ENDPOINT_PRESETS } from '@/recognize/providers/custom';

const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: 'gemini', label: 'Google Gemini（推荐，CORS 友好）' },
  { value: 'openai', label: 'OpenAI（建议限额子密钥）' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'custom', label: '自定义 / 国内厂商（OpenAI 兼容）' },
];

export default function RecognizePanel({ page }: { page: Page }) {
  const { updatePage } = useProjectStore();
  const settings = useSettingsStore();
  const forcedLocal = isForcedLocal();

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sessionOnly, setSessionOnly] = useState(true);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false); // P1.1：默认不勾选
  const [progress, setProgress] = useState<RecognizeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const mode = settings.privacyMode;
  const providerId = settings.provider.provider;
  const provider = providerId === 'local' ? null : getProvider(providerId);
  const lowConfCount = page.chars.filter((c) => c.conf < CONFIDENCE_THRESHOLD && c.source !== 'manual').length;

  /** 成本预估（F4.9：调用前预估） */
  const estimate = provider && mode !== 'A' ? provider.estimateCost(page.chars.length) * (mode === 'C' ? 3 : 1) : 0;

  const buildConfig = async (): Promise<ProviderConfig> => {
    const storedKey = (await loadApiKey(providerId, passphrase || undefined)) ?? apiKeyInput ?? undefined;
    return {
      provider: providerId,
      apiKey: storedKey || undefined,
      endpoint: settings.provider.endpoint || undefined,
      proxyUrl: settings.provider.proxyUrl || undefined,
      model: settings.provider.model || provider?.defaultModel || '',
      concurrency: settings.concurrency,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
    };
  };

  const doRecognize = async () => {
    setBusy(true);
    setMessage('');
    setProgress(null);
    try {
      const stored = await getBinaryImage(page.binaryKey);
      if (!stored) throw new Error('找不到预处理结果，请先运行预处理');
      const cfg = await buildConfig();
      const { chars, outcome } = await recognizePage(
        page,
        stored.bin,
        stored.width,
        stored.height,
        cfg,
        mode,
        settings.pageBudgetCny,
        setProgress,
      );
      updatePage(page.id, {
        chars,
        status: 'recognized',
        recognition: {
          mode,
          provider: providerId,
          model: cfg.model,
          batches: outcome.batches,
          costEstimateCny: outcome.costCny,
        },
      });
      settings.addSessionCost(outcome.costCny);
      setMessage(
        `识别完成：${outcome.updatedCount} 字，${outcome.batches} 批（失败 ${outcome.failedBatches}），约 ¥${outcome.costCny.toFixed(3)}`,
      );
    } catch (err) {
      setMessage(`识别失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStart = () => {
    if (mode !== 'A' && !hasConsented(mode)) {
      setConsentOpen(true); // P1.1 首次云端识别弹窗
      return;
    }
    void doRecognize();
  };

  /** 上行内容预览（P1.3）：发送前查看实际将要上传的第一张拼图 */
  const handlePreviewGrid = async () => {
    const stored = await getBinaryImage(page.binaryKey);
    if (!stored || page.chars.length === 0) return;
    const batch = await buildGridBatch(page.chars.slice(0, GRID_BATCH_SIZE), stored.bin, stored.width, stored.height, 0);
    setPreviewUrl(`data:image/png;base64,${batch.imageBase64Png}`);
  };

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    try {
      await saveApiKey(providerId, apiKeyInput.trim(), passphrase || undefined, sessionOnly);
      setMessage(sessionOnly ? '密钥已保存（仅本次会话，不落盘）' : '密钥已用口令 AES-GCM 加密保存到本地');
      setApiKeyInput('');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '密钥保存失败');
    }
  };

  return (
    <section className="rounded-lg border p-4" aria-label="大模型识别">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4" /> 识别（共 {page.chars.length} 字
        {lowConfCount > 0 ? `，其中 ${lowConfCount} 字低置信待人工` : ''}）
      </h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <Label>隐私模式（PRD 7.2）</Label>
            <Select
              value={mode}
              onChange={(e) => settings.setPrivacyMode(e.target.value as PrivacyMode)}
              disabled={forcedLocal}
              options={[
                { value: 'A', label: 'A · 全本地（Tesseract，图像不出本机）' },
                { value: 'B', label: 'B · 字符拼图上云（默认，最小上行）' },
                { value: 'C', label: 'C · 整页上云（难页/污损页，准确率最高）' },
              ]}
            />
            {forcedLocal && <p className="mt-1 text-xs text-destructive">当前部署已锁定全本地模式（P1.7）</p>}
          </div>

          {mode !== 'A' && (
            <>
              <div>
                <Label>厂商</Label>
                <Select
                  value={providerId}
                  onChange={(e) => {
                    const id = e.target.value as ProviderId;
                    const p = getProvider(id);
                    settings.setProvider({ provider: id, model: p.defaultModel, endpoint: '' });
                  }}
                  options={PROVIDER_OPTIONS}
                />
              </div>
              <div>
                <Label>模型</Label>
                <Input value={settings.provider.model} onChange={(e) => settings.setProvider({ model: e.target.value })} placeholder={provider?.defaultModel} />
              </div>
              {providerId === 'custom' && (
                <>
                  <div>
                    <Label>端点模板</Label>
                    <Select
                      value=""
                      onChange={(e) => {
                        const preset = ENDPOINT_PRESETS[parseInt(e.target.value, 10)];
                        if (preset) settings.setProvider({ endpoint: preset.endpoint, model: preset.model });
                      }}
                      options={[{ value: '', label: '选择预置端点…' }, ...ENDPOINT_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))]}
                    />
                  </div>
                  <div>
                    <Label>Endpoint（OpenAI 兼容，必填）</Label>
                    <Input value={settings.provider.endpoint} onChange={(e) => settings.setProvider({ endpoint: e.target.value })} placeholder="https://…" />
                  </div>
                </>
              )}
              <div>
                <Label>可选代理 URL（CORS 不通时使用，严格无状态）</Label>
                <Input value={settings.provider.proxyUrl} onChange={(e) => settings.setProvider({ proxyUrl: e.target.value })} placeholder="留空 = 浏览器直调" />
              </div>
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <Label>API Key（仅存本机，浏览器直调意味着密钥存在于本机浏览器中）</Label>
                <Input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 API Key" autoComplete="off" />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={sessionOnly} onChange={(e) => setSessionOnly(e.target.checked)} />
                  仅本次会话（不落盘，推荐）
                </label>
                {!sessionOnly && (
                  <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="加密口令（用于 AES-GCM 加密保存）" autoComplete="new-password" />
                )}
                <Button size="sm" variant="outline" onClick={() => void handleSaveKey()}>
                  保存密钥
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-md bg-muted p-3 text-sm">
            <div>预估成本：约 ¥{estimate.toFixed(3)}（单页上限 ¥{settings.pageBudgetCny}）</div>
            <div className="mt-1 text-xs text-muted-foreground">
              本次会话累计：¥{settings.sessionCostCny.toFixed(3)}（项目上限 ¥{settings.projectBudgetCny}）
              {provider && mode !== 'A' ? `　目标域名：${providerDomain(provider, { provider: providerId, model: '', concurrency: 1, timeoutMs: 0, maxRetries: 0, endpoint: settings.provider.endpoint || undefined, proxyUrl: settings.provider.proxyUrl || undefined })}` : ''}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleStart} disabled={busy || page.chars.length === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              开始识别
            </Button>
            {mode === 'B' && (
              <Button variant="outline" onClick={() => void handlePreviewGrid()}>
                <Eye className="h-4 w-4" /> 预览上行拼图
              </Button>
            )}
          </div>
          {progress && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">{progress.message}</div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.totalBatches > 0 ? (progress.doneBatches / progress.totalBatches) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {previewUrl && (
            <div>
              <Label>将要上传的拼图（编号已打乱，无版面无上下文）</Label>
              <img src={previewUrl} alt="上行拼图预览" className="mt-1 max-h-64 rounded border" />
            </div>
          )}
        </div>
      </div>

      {/* P1.1 首次云端识别同意弹窗（默认不勾选） */}
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>云端识别隐私告知</DialogTitle>
            <DialogDescription>
              {mode === 'B'
                ? '字符拼图上云：仅上传二值化单字小图拼成的编号网格图（顺序已打乱），不含版面、上下文与文件名。'
                : '整页上云：整页图像将发送给大模型厂商，准确率最高但隐私暴露面最大。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>目标厂商：{provider?.label ?? providerId}</p>
            <p>图像与项目数据除此次识别外不会离开本机；识别调用是唯一的出网行为。</p>
            <p>你可以随时改用模式 A（全本地）或在设置中一键清空全部本地数据。</p>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} />
              我已了解并同意本次会话使用云端识别
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!consentChecked}
              onClick={() => {
                grantConsent(mode);
                setConsentOpen(false);
                void doRecognize();
              }}
            >
              同意并开始
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
