import { useEffect, useState } from 'react';
import { Check, ChevronDown, Download, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/components/ui/dialog';
import { MAX_CONCURRENCY } from '@/lib/constants';
import { clearAuditLogs, exportAuditText, getSessionUploads, listAuditLogs, type AuditEntry } from '@/privacy/audit';
import { hasApiKey, saveApiKey } from '@/privacy/keystore';
import { isForcedLocal, revokeConsent } from '@/privacy/consent';
import { clearAllStores } from '@/storage/db';
import { clearAllImages } from '@/storage/opfs';
import { useSettingsStore, type ModelConnection } from '@/store/settingsStore';
import { downloadText, formatTime } from '@/lib/utils';
import type { PrivacyMode } from '@/model/types';
import type { ProviderId } from '@/recognize/types';

const providerOptions: Array<{ value: ProviderId; label: string }> = [
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'custom', label: 'OpenAI 兼容端点' },
];

function connectionLabel(connection: ModelConnection): string {
  return connection.kind === 'compatible' ? 'OpenAI 兼容' : '官方 API';
}

function ModelConnectionsPanel() {
  const settings = useSettingsStore();
  const [keyInput, setKeyInput] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sessionOnly, setSessionOnly] = useState(true);
  const [keySaved, setKeySaved] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<Record<string, string>>({});
  const active = settings.activeConnection();
  const activeModel = active?.models.find((m) => m.id === settings.activeModelId);
  const official = settings.connections.filter((c) => c.kind === 'official');
  const compatible = settings.connections.filter((c) => c.kind === 'compatible');

  useEffect(() => {
    if (!active) return;
    void Promise.all([hasApiKey(active.id), hasApiKey(active.provider)]).then(([byConnection, byProvider]) => setKeySaved(byConnection || byProvider));
  }, [active?.id, active?.provider]);

  const saveKey = async () => {
    if (!active || !keyInput.trim()) return;
    try {
      await saveApiKey(active.id, keyInput.trim(), passphrase || undefined, sessionOnly);
      setKeyInput('');
      setKeySaved(true);
      setTestMessage((s) => ({ ...s, [active.id]: 'API Key 已保存到本机' }));
    } catch (error) {
      setTestMessage((s) => ({ ...s, [active.id]: error instanceof Error ? error.message : 'API Key 保存失败' }));
    }
  };

  const testConnection = async (connection: ModelConnection) => {
    const model = connection.models.find((m) => m.id) ?? connection.models[0];
    if (!connection.endpoint.trim() || !model?.id.trim()) {
      setTestMessage((s) => ({ ...s, [connection.id]: '请先填写 API Base URL 和 Model ID' }));
      return;
    }
    setTestingId(connection.id);
    setTestMessage((s) => ({ ...s, [connection.id]: '' }));
    try {
      const base = connection.endpoint.replace(/\/$/, '');
      const target = connection.kind === 'compatible'
        ? `${base.replace(/\/v1$/i, '')}/v1/models`
        : `${base}/v1beta/models`;
      const url = connection.proxyUrl ? (() => { const u = new URL(connection.proxyUrl); u.searchParams.set('target', target); return u.toString(); })() : target;
      const headers: Record<string, string> = {};
      if (active?.id === connection.id && keyInput.trim()) headers.Authorization = `Bearer ${keyInput.trim()}`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTestMessage((s) => ({ ...s, [connection.id]: '连接成功，可用于识别' }));
    } catch (error) {
      setTestMessage((s) => ({ ...s, [connection.id]: error instanceof Error ? `连接失败：${error.message}` : '连接失败，请检查地址或代理' }));
    } finally {
      setTestingId(null);
    }
  };

  const renderCard = (connection: ModelConnection) => {
    const isActive = connection.id === settings.activeConnectionId;
    return (
      <div key={connection.id} className={`rounded-xl border bg-card/70 transition-colors ${isActive ? 'border-primary/50 shadow-soft' : 'border-border/70'}`}>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => settings.toggleConnection(connection.id)}>
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${connection.expanded ? '' : '-rotate-90'}`} />
          <span className="font-medium">{connection.name || '未命名分组'}</span>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{connection.models.filter((m) => m.id || m.name).length} 个模型</span>
          {isActive && <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">当前使用</span>}
        </button>
        {connection.expanded && (
          <div className="space-y-4 border-t px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">{connectionLabel(connection)}</span>
              <div className="flex gap-2">
                <Button size="sm" variant={isActive ? 'secondary' : 'outline'} onClick={() => settings.setActiveConnection(connection.id)}>
                  {isActive && <Check className="h-3.5 w-3.5" />} {isActive ? '正在使用' : '使用此分组'}
                </Button>
                {connection.kind === 'compatible' && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => settings.removeConnection(connection.id)}>删除分组</Button>}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2"><Label>分组名称</Label><Input value={connection.name} onChange={(e) => settings.updateConnection(connection.id, { name: e.target.value })} /></div>
              <div className="md:col-span-2"><Label>说明</Label><Input value={connection.description} onChange={(e) => settings.updateConnection(connection.id, { description: e.target.value })} /></div>
              {connection.kind === 'official' ? (
                <div><Label>官方服务</Label><Select value={connection.provider} onChange={(e) => settings.updateConnection(connection.id, { provider: e.target.value as ProviderId })} options={providerOptions.filter((p) => p.value !== 'custom')} /></div>
              ) : (
                <div className="md:col-span-2"><Label>API Base URL</Label><Input value={connection.endpoint} onChange={(e) => settings.updateConnection(connection.id, { endpoint: e.target.value })} placeholder="https://api.example.com/v1" /><p className="mt-1 text-xs text-muted-foreground">填写到 /v1，不要包含 /chat/completions。</p></div>
              )}
              <div className={connection.kind === 'official' ? '' : 'md:col-span-2'}><Label>API Key</Label><Input type="password" value={isActive ? keyInput : ''} onChange={(e) => setKeyInput(e.target.value)} placeholder={keySaved && isActive ? '已保存，输入新 Key 可覆盖' : '粘贴 API Key'} /></div>
              {connection.kind === 'compatible' && <div className="md:col-span-2"><Label>可选代理 URL</Label><Input value={connection.proxyUrl} onChange={(e) => settings.updateConnection(connection.id, { proxyUrl: e.target.value })} placeholder="https://你的-worker.workers.dev" /><p className="mt-1 text-xs text-muted-foreground">代理会自动携带真实 Base URL，解决浏览器 CORS。</p></div>}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between"><Label>模型列表</Label><div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => settings.addModel(connection.id)}><Plus className="h-3.5 w-3.5" /> 新建</Button><Button size="sm" variant="ghost" onClick={() => settings.removeModel(connection.id, connection.models[connection.models.length - 1]?.id ?? '')} disabled={connection.models.length <= 1}>删除所有</Button></div></div>
              <div className="space-y-2">
                {connection.models.map((model) => <div key={model.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2"><Input value={model.name} onChange={(e) => settings.updateModel(connection.id, model.id, { name: e.target.value })} placeholder="显示名称" /><Input value={model.id} onChange={(e) => settings.updateModel(connection.id, model.id, { id: e.target.value })} placeholder="Model ID" /><Button size="sm" variant={isActive && settings.activeModelId === model.id ? 'secondary' : 'outline'} onClick={() => { settings.setActiveConnection(connection.id); settings.setActiveModel(model.id); }}>{isActive && settings.activeModelId === model.id ? '当前' : '使用'}</Button><Button size="icon" variant="ghost" aria-label="删除模型" disabled={connection.models.length <= 1} onClick={() => settings.removeModel(connection.id, model.id)}><Trash2 className="h-4 w-4" /></Button></div>)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3"><Button variant="outline" onClick={() => void saveKey()} disabled={!isActive || !keyInput.trim()}>保存 API Key</Button><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={sessionOnly} onChange={(e) => setSessionOnly(e.target.checked)} />仅本次会话</label><Button variant="outline" onClick={() => void testConnection(connection)} disabled={testingId === connection.id}>{testingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}测试连接</Button><span className="text-xs text-muted-foreground">{testMessage[connection.id] || (connection.endpoint ? `将使用 ${connection.endpoint}` : '尚未配置')}</span></div>
          </div>
        )}
      </div>
    );
  };

  return <div className="space-y-5"><div><div className="mb-2 flex items-center justify-between"><div><h3 className="font-semibold">官方 API</h3><p className="text-xs text-muted-foreground">DeepSeek、OpenAI、Gemini、Claude 等官方接口。</p></div><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{official.filter((c) => c.models.some((m) => m.id)).length}/{official.length} 已配置</span></div><div className="space-y-2">{official.map(renderCard)}</div></div><div><div className="mb-2 flex items-center justify-between"><div><h3 className="font-semibold">OpenAI 兼容第三方 API</h3><p className="text-xs text-muted-foreground">云赛、New API、Ollama 及其他兼容服务。</p></div><Button size="sm" variant="ghost" onClick={() => settings.addConnection('compatible')}><Plus className="h-4 w-4" /> 添加分组</Button></div><div className="space-y-2">{compatible.map(renderCard)}</div></div><div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">当前识别：{active?.name ?? '未选择'} / {activeModel?.name || activeModel?.id || '未选择模型'}。API Key 仅保存在本机，不会写入项目文件。</div></div>;
}

export default function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const settings = useSettingsStore();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const forcedLocal = isForcedLocal();

  useEffect(() => { if (open) void listAuditLogs().then(setAudit); }, [open]);

  const handleWipe = async () => {
    if (!confirm('确定清空本地全部数据？项目、图像、撤销栈、密钥、审计日志将彻底删除，不可恢复。')) return;
    await clearAllStores();
    await clearAllImages();
    revokeConsent();
    location.reload();
  };

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>设置</DialogTitle></DialogHeader><Tabs defaultValue="models"><TabsList><TabsTrigger value="models">模型接入</TabsTrigger><TabsTrigger value="recognize">识别参数</TabsTrigger><TabsTrigger value="privacy">隐私与审计</TabsTrigger><TabsTrigger value="about">关于</TabsTrigger></TabsList><TabsContent value="models" className="pt-3"><ModelConnectionsPanel /></TabsContent><TabsContent value="recognize" className="space-y-3 pt-3"><div className="grid gap-3 md:grid-cols-2"><div><Label>并发数（≤{MAX_CONCURRENCY}）</Label><Input type="number" min={1} max={MAX_CONCURRENCY} value={settings.concurrency} onChange={(e) => settings.setConcurrency(parseInt(e.target.value, 10))} /></div><div><Label>超时（毫秒）</Label><Input type="number" min={5000} step={5000} value={settings.timeoutMs} onChange={(e) => settings.setTimeoutMs(parseInt(e.target.value, 10) || 60000)} /></div><div><Label>失败重试次数</Label><Input type="number" min={0} max={5} value={settings.maxRetries} onChange={(e) => settings.setMaxRetries(parseInt(e.target.value, 10))} /></div><div><Label>默认隐私模式</Label><Select value={settings.privacyMode} onChange={(e) => settings.setPrivacyMode(e.target.value as PrivacyMode)} disabled={forcedLocal} options={[{ value: 'A', label: 'A · 全本地' }, { value: 'B', label: 'B · 拼图上云' }, { value: 'C', label: 'C · 整页上云' }]} /></div><div><Label>单页成本上限（元）</Label><Input type="number" min={0} step={0.1} value={settings.pageBudgetCny} onChange={(e) => settings.setPageBudgetCny(parseFloat(e.target.value) || 0)} /></div><div><Label>单项目成本上限（元）</Label><Input type="number" min={0} step={1} value={settings.projectBudgetCny} onChange={(e) => settings.setProjectBudgetCny(parseFloat(e.target.value) || 0)} /></div><div><Label>输出字形</Label><Select value={settings.outputScript} onChange={(e) => settings.setOutputScript(e.target.value as 'original' | 'simplified')} options={[{ value: 'original', label: '原字形（1:1 复刻）' }, { value: 'simplified', label: '简化字' }]} /></div></div></TabsContent><TabsContent value="privacy" className="space-y-3 pt-3"><div className="rounded-md bg-muted p-3 text-sm">当前隐私模式：<b>{settings.privacyMode}</b>{forcedLocal && <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground">已锁定全本地</span>}<span className="ml-4">本次会话已上行图片：<b>{getSessionUploads()}</b> 张</span><span className="ml-4">累计成本：<b>¥{settings.sessionCostCny.toFixed(3)}</b></span></div><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">隐私审计日志（保留 30 天）</h3><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => downloadText('隐私审计日志.txt', exportAuditText(audit))}><Download className="h-4 w-4" />导出</Button><Button size="sm" variant="outline" onClick={() => void clearAuditLogs().then(() => setAudit([]))}>清空日志</Button></div></div><div className="max-h-48 overflow-y-auto rounded border">{audit.length === 0 ? <p className="p-3 text-xs text-muted-foreground">暂无记录。每次云端识别都会记录时间、模式、字符数与目标域名。</p> : <table className="w-full text-xs"><thead><tr className="border-b bg-muted"><th className="p-1.5 text-left">时间</th><th className="p-1.5 text-left">模式</th><th className="p-1.5 text-left">厂商</th><th className="p-1.5 text-left">域名</th><th className="p-1.5 text-right">字符数</th></tr></thead><tbody>{audit.map((a) => <tr key={a.id} className="border-b last:border-0"><td className="p-1.5">{formatTime(a.ts)}</td><td className="p-1.5">{a.mode}</td><td className="p-1.5">{a.provider}</td><td className="p-1.5">{a.domain}</td><td className="p-1.5 text-right">{a.charCount}</td></tr>)}</tbody></table>}</div><Button variant="destructive" onClick={() => void handleWipe()}><Trash2 className="h-4 w-4" />一键清空本地全部数据</Button></TabsContent><TabsContent value="about" className="space-y-2 pt-3 text-sm"><p><b>ZupuScript Web</b> —— 族谱图像转 Scribus 脚本工具（v2.0）。图像与项目数据全程留在本地，只有明确同意后的识别调用会出网。</p><p className="text-muted-foreground">配套软件：Scribus 1.6.6（Python 3 Scripter）。</p></TabsContent></Tabs></DialogContent></Dialog>;
}
