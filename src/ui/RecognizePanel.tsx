/**
 * 识别面板（F4.x）：模式 A/C、Provider 选择、成本预估、首次云端同意弹窗、实时进度。
 */
import { useState } from 'react';
import { Loader2, Play, ShieldCheck } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import type { Page } from '@/model/types';
import { grantConsent, hasConsented, isForcedLocal } from '@/privacy/consent';
import { buildProviderConfig, currentRecognitionSettingsKey, isLocalRecognitionMode, resolveRecognitionMode } from '@/recognize/buildConfig';
import { saveApiKey } from '@/privacy/keystore';
import { getBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getProvider, providerDomain, recognizePage } from '@/recognize/orchestrator';
import type { RecognizeProgress } from '@/recognize/types';

export default function RecognizePanel({ page }: { page: Page }) {
  const { updatePage } = useProjectStore();
  const settings = useSettingsStore();
  const forcedLocal = isForcedLocal();

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sessionOnly, setSessionOnly] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false); // P1.1：默认不勾选
  const [progress, setProgress] = useState<RecognizeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const mode = resolveRecognitionMode();
  const localMode = isLocalRecognitionMode(mode);
  const connection = settings.activeConnection();
  const model = localMode
    ? { id: 'local-tesseract', name: 'Tesseract（chi_tra）' }
    : connection?.models.find((m) => m.id === settings.activeModelId);
  const providerId = localMode ? 'local' : (connection?.provider ?? settings.provider.provider);
  const provider = providerId === 'local' ? null : getProvider(providerId);
  const lowConfCount = page.chars.filter((c) => c.conf < CONFIDENCE_THRESHOLD && c.source !== 'manual').length;

  /** 成本预估（远端统一模式 C：整页上云） */
  const estimate = provider && !localMode ? provider.estimateCost(page.chars.length) * 6 : 0;

  const buildConfig = () => buildProviderConfig(passphrase || undefined, apiKeyInput);

  const doRecognize = async () => {
    setBusy(true);
    setMessage('');
    setProgress(null);
    try {
      const stored = await getBinaryImage(page.binaryKey);
      if (!stored) throw new Error('找不到预处理结果，请先运行预处理');
      const { cfg, mode: recognizeMode } = await buildConfig();
      const { chars, outcome } = await recognizePage(
        page,
        stored.bin,
        stored.width,
        stored.height,
        cfg,
        recognizeMode,
        settings.pageBudgetCny,
        setProgress,
      );
      updatePage(page.id, {
        chars,
        status: 'recognized',
        recognition: {
          mode: recognizeMode,
          provider: cfg.provider,
          model: cfg.model,
          batches: outcome.batches,
          costEstimateCny: outcome.costCny,
          settingsKey: currentRecognitionSettingsKey(),
        },
      });
      settings.addSessionCost(outcome.costCny);
      setMessage(
        `识别与模型输出校验完成：${outcome.updatedCount} 字，${outcome.batches} 批（失败 ${outcome.failedBatches}），约 ¥${outcome.costCny.toFixed(3)}`,
      );
    } catch (err) {
      setMessage(`识别失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStart = () => {
    if (!localMode && !hasConsented(mode)) {
      setConsentOpen(true); // P1.1 首次云端识别弹窗
      return;
    }
    void doRecognize();
  };

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    try {
      await saveApiKey(connection?.id ?? providerId, apiKeyInput.trim(), passphrase || undefined, sessionOnly);
      if (!sessionOnly && !localMode) grantConsent(mode);
      setMessage(sessionOnly ? '密钥已保存（仅本次会话）' : '密钥已加密保存到本机，刷新后自动加载');
      setApiKeyInput('');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '密钥保存失败');
    }
  };

  return (
    <section id="recognize-step" className="scroll-mt-24 rounded-lg border p-4" aria-label="大模型识别">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4" /> 深度识别与复核（共 {page.chars.length} 字
        {lowConfCount > 0 ? `，其中 ${lowConfCount} 字低置信待人工` : ''}）
      </h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <Label>识别模式</Label>
            <p className="mt-1 rounded-md bg-muted px-3 py-2 text-sm">
              {localMode ? 'A · 全本地（Tesseract，图像不出本机）' : 'C · 整页上云（远端统一模式，准确率最高）'}
            </p>
            {forcedLocal && <p className="mt-1 text-xs text-destructive">当前部署已锁定全本地模式（P1.7）</p>}
          </div>

          {!localMode && (
            <>
              <div className="rounded-lg border bg-muted/40 p-3 md:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Label>当前模型连接</Label>
                    <p className="mt-1 text-sm font-medium">{connection?.name ?? '未选择连接'} · {model?.name || model?.id || '未选择模型'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{connection?.endpoint || '请在设置 → 模型接入中配置 Base URL'}</p>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">设置中管理</span>
                </div>
              </div>
              <div className="space-y-2 rounded-md border border-dashed p-3">
                  <Label>API Key 快速覆盖（推荐在设置 → 模型接入中管理）</Label>
                <Input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 API Key" autoComplete="off" />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={sessionOnly} onChange={(e) => setSessionOnly(e.target.checked)} />
                  仅本次会话（不勾选则加密保存到本机）
                </label>
                {sessionOnly && (
                  <p className="text-xs text-muted-foreground">关闭浏览器后需重新输入 Key。</p>
                )}
                {!sessionOnly && (
                  <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="可选：自定义加密口令（留空则用本机设备密钥）" autoComplete="new-password" />
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
              {provider && !localMode ? `　目标域名：${providerDomain(provider, { provider: providerId, model: '', concurrency: 1, timeoutMs: 0, maxRetries: 0, endpoint: settings.provider.endpoint || undefined, proxyUrl: settings.provider.proxyUrl || undefined })}` : ''}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleStart} disabled={busy || page.chars.length === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              开始识别
            </Button>
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
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <span className={progress.doneBatches > 0 || progress.message.includes('初次') ? 'text-foreground' : ''}>① 初次识别</span>
                <span className={progress.message.includes('校验') ? 'text-foreground' : ''}>② 模型输出校验</span>
                <span className={progress.doneBatches === progress.totalBatches ? 'text-foreground' : ''}>③ 结果合并</span>
              </div>
            </div>
          )}
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {page.status === 'recognized' && (
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              初次识别和模型输出校验已完成。两轮不一致的字符已自动降低置信度，请在结果画布中重点确认。
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
              整页上云：整页图像将发送给大模型厂商进行识别，准确率最高。除此次识别外，图像与项目数据不会离开本机。
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
