/**
 * 设置对话框：识别参数（并发/超时/重试/预算护栏）、
 * 隐私（模式、审计日志、一键清空 P1.5）、密钥管理入口说明。
 * P1.2：常驻显示当前隐私模式徽号与本次会话已上行图片数。
 */
import { useEffect, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { MAX_CONCURRENCY } from '@/lib/constants';
import { clearAuditLogs, exportAuditText, getSessionUploads, listAuditLogs, type AuditEntry } from '@/privacy/audit';
import { destroyApiKey } from '@/privacy/keystore';
import { isForcedLocal, revokeConsent } from '@/privacy/consent';
import { clearAllStores } from '@/storage/db';
import { clearAllImages } from '@/storage/opfs';
import { useSettingsStore } from '@/store/settingsStore';
import { downloadText, formatTime } from '@/lib/utils';
import type { PrivacyMode } from '@/model/types';

export default function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const settings = useSettingsStore();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const forcedLocal = isForcedLocal();

  useEffect(() => {
    if (open) void listAuditLogs().then(setAudit);
  }, [open]);

  /** 一键清空本地全部数据（P1.5 / A9） */
  const handleWipe = async () => {
    if (!confirm('确定清空本地全部数据？项目、图像、撤销栈、密钥、审计日志将彻底删除，不可恢复。')) return;
    await clearAllStores();
    await clearAllImages();
    revokeConsent();
    // 会话密钥由 keystore 内部 Map 持有，刷新页面即销毁
    location.reload();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="recognize">
          <TabsList>
            <TabsTrigger value="recognize">识别</TabsTrigger>
            <TabsTrigger value="privacy">隐私与审计</TabsTrigger>
            <TabsTrigger value="about">关于</TabsTrigger>
          </TabsList>

          <TabsContent value="recognize" className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>并发数（≤{MAX_CONCURRENCY}，F11.4 防触发厂商 429）</Label>
                <Input type="number" min={1} max={MAX_CONCURRENCY} value={settings.concurrency} onChange={(e) => settings.setConcurrency(parseInt(e.target.value, 10))} />
              </div>
              <div>
                <Label>超时（毫秒）</Label>
                <Input type="number" min={5000} step={5000} value={settings.timeoutMs} onChange={(e) => settings.setTimeoutMs(parseInt(e.target.value, 10) || 60000)} />
              </div>
              <div>
                <Label>失败重试次数（指数退避）</Label>
                <Input type="number" min={0} max={5} value={settings.maxRetries} onChange={(e) => settings.setMaxRetries(parseInt(e.target.value, 10))} />
              </div>
              <div>
                <Label>默认隐私模式</Label>
                <Select
                  value={settings.privacyMode}
                  onChange={(e) => settings.setPrivacyMode(e.target.value as PrivacyMode)}
                  disabled={forcedLocal}
                  options={[
                    { value: 'A', label: 'A · 全本地' },
                    { value: 'B', label: 'B · 拼图上云（默认）' },
                    { value: 'C', label: 'C · 整页上云' },
                  ]}
                />
              </div>
              <div>
                <Label>单页成本上限（元，F4.10）</Label>
                <Input type="number" min={0} step={0.1} value={settings.pageBudgetCny} onChange={(e) => settings.setPageBudgetCny(parseFloat(e.target.value) || 0)} />
              </div>
              <div>
                <Label>单项目成本上限（元）</Label>
                <Input type="number" min={0} step={1} value={settings.projectBudgetCny} onChange={(e) => settings.setProjectBudgetCny(parseFloat(e.target.value) || 0)} />
              </div>
              <div>
                <Label>输出字形</Label>
                <Select
                  value={settings.outputScript}
                  onChange={(e) => settings.setOutputScript(e.target.value as 'original' | 'simplified')}
                  options={[
                    { value: 'original', label: '原字形（1:1 复刻，默认）' },
                    { value: 'simplified', label: '简化字' },
                  ]}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              API Key 在「分析」页的识别面板中输入与保存（仅存本机，支持仅会话不落盘 / AES-GCM 加密持久化）。
              建议使用各厂商的限额子密钥。
            </p>
            <div className="flex gap-2">
              {(['gemini', 'openai', 'anthropic', 'custom'] as const).map((p) => (
                <Button key={p} size="sm" variant="outline" onClick={() => void destroyApiKey(p)}>
                  清除 {p} 密钥
                </Button>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="privacy" className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-sm">
              当前隐私模式：<b>{settings.privacyMode}</b>
              {forcedLocal && <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground">已锁定全本地</span>}
              <span className="ml-4">本次会话已上行图片：<b>{getSessionUploads()}</b> 张</span>
              <span className="ml-4">累计成本：<b>¥{settings.sessionCostCny.toFixed(3)}</b></span>
            </div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">隐私审计日志（仅存本地，保留 30 天）</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => downloadText('隐私审计日志.txt', exportAuditText(audit))}>
                  <Download className="h-4 w-4" /> 导出
                </Button>
                <Button size="sm" variant="outline" onClick={() => void clearAuditLogs().then(() => setAudit([]))}>
                  清空日志
                </Button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto rounded border">
              {audit.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">暂无记录。每次云端识别都会记录时间、模式、字符数与目标域名。</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted">
                      <th className="p-1.5 text-left">时间</th>
                      <th className="p-1.5 text-left">模式</th>
                      <th className="p-1.5 text-left">厂商</th>
                      <th className="p-1.5 text-left">域名</th>
                      <th className="p-1.5 text-right">字符数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className="p-1.5">{formatTime(a.ts)}</td>
                        <td className="p-1.5">{a.mode}</td>
                        <td className="p-1.5">{a.provider}</td>
                        <td className="p-1.5">{a.domain}</td>
                        <td className="p-1.5 text-right">{a.charCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <Button variant="destructive" onClick={() => void handleWipe()}>
              <Trash2 className="h-4 w-4" /> 一键清空本地全部数据
            </Button>
          </TabsContent>

          <TabsContent value="about" className="space-y-2 text-sm">
            <p>
              <b>ZupuScript Web</b> —— 族谱图像转 Scribus 脚本工具（v2.0）。
              打开网页即用，图像与项目数据全程留在本地，唯一出网行为是你明确同意后的云端识别调用。
            </p>
            <p className="text-muted-foreground">
              配套软件：Scribus 1.6.6（Python 3 Scripter）。生成脚本在「脚本 → 执行脚本…」中运行。
              无遥测、无埋点、无第三方分析脚本；前端代码可审计。
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
