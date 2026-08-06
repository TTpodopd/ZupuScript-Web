/**
 * 导出页（F7.x / F9.x）：脚本预览（等宽可微调，F7.9）+ lint 自检状态 +
 * 导出（下载 / zip / FSAccess 写目录）+ 质检报告入口（P1）+ 字体检查清单（F8.8）。
 */
import { useMemo, useState } from 'react';
import { Download, FileArchive, FolderOutput, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Label, Textarea } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import { buildBundle, downloadBundle, downloadZip, writeBundleToDirectory, type ExportBundle } from '@/generator/export';
import { generatePageScript } from '@/generator/export';
import { getHelperScripts } from '@/generator/helpers';
import { lintScript } from '@/generator/lint';
import { getBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { hasFSAccess } from '@/storage/fsaccess';
import { buildReportHtml, computeVerify, type VerifyMetrics } from '@/verify/report';
import { downloadText } from '@/lib/utils';

export default function ExportPage() {
  const { pages, currentPageId, currentProject, setView } = useProjectStore();
  const project = currentProject();
  const [mode, setMode] = useState<'perPage' | 'merged'>('perPage');
  const [selectedPageId, setSelectedPageId] = useState<string | null>(currentPageId);
  const [editedCode, setEditedCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [metrics, setMetrics] = useState<VerifyMetrics | null>(null);

  const readyPages = useMemo(() => pages.filter((p) => p.chars.length > 0), [pages]);
  const previewPage = readyPages.find((p) => p.id === selectedPageId) ?? readyPages[0];

  /** 当前预览脚本（用户微调优先） */
  const preview = useMemo(() => {
    if (!previewPage) return null;
    if (editedCode !== null) {
      const issues = lintScript(editedCode);
      return { code: editedCode, issues, ok: !issues.some((i) => i.level === 'error') };
    }
    const gen = generatePageScript(previewPage);
    return { code: gen.code, issues: gen.issues, ok: gen.ok };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewPage?.id, previewPage?.chars, editedCode]);

  if (!project) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        请先打开项目。
        <div className="mt-4">
          <Button onClick={() => setView('projects')}>返回项目列表</Button>
        </div>
      </div>
    );
  }

  const makeBundle = (report?: { filename: string; code: string }): ExportBundle =>
    buildBundle(project, readyPages, mode, undefined, report);

  const guardExport = (bundle: ExportBundle): boolean => {
    const bad = bundle.scripts.filter((s) => !s.ok);
    if (bundle.scripts.length === 0) {
      setMessage('没有可导出的页面（请先完成字符分割与校对）');
      return false;
    }
    if (bad.length > 0) {
      setMessage(`自检未通过：${bad[0].issues.filter((i) => i.level === 'error').map((i) => i.message).join('；')}（已阻止导出，F7.5）`);
      return false;
    }
    return true;
  };

  const handleDownload = () => {
    const bundle = makeBundle();
    if (!guardExport(bundle)) return;
    downloadBundle(bundle);
    setMessage('已开始下载（每页 .py + 同名 .txt 副本 + helpers/ 辅助脚本）');
  };

  const handleZip = async () => {
    const bundle = makeBundle();
    if (!guardExport(bundle)) return;
    await downloadZip(bundle, `${project.name}_scribus.zip`);
    setMessage('zip 打包下载已开始');
  };

  const handleWriteDir = async () => {
    const bundle = makeBundle();
    if (!guardExport(bundle)) return;
    setBusy(true);
    try {
      const ok = await writeBundleToDirectory(bundle);
      setMessage(ok ? '已写入所选文件夹' : '已取消');
    } finally {
      setBusy(false);
    }
  };

  /** 质检报告（P1，F9.x）：红蓝黑叠加 + IoU，IoU 低则警示（F9.5） */
  const handleVerify = async () => {
    if (!previewPage) return;
    setBusy(true);
    setMessage('正在渲染重建位图并比对…');
    try {
      const stored = await getBinaryImage(previewPage.binaryKey);
      if (!stored) throw new Error('找不到预处理二值图，无法质检');
      const m = computeVerify(previewPage, stored.bin, stored.width, stored.height);
      setMetrics(m);
      const html = buildReportHtml(previewPage, m);
      downloadText(`质检报告_${previewPage.source.name.replace(/\.[^.]+$/, '')}.html`, html, 'text/html');
      setMessage(
        m.iou < 0.5
          ? `⚠ IoU=${m.iou.toFixed(3)} 偏低，建议返回校对界面检查（F9.5）`
          : `质检完成：IoU=${m.iou.toFixed(3)}，字符命中率 ${(m.charHitRate * 100).toFixed(1)}%，平均偏移 ${m.avgOffsetPx.toFixed(2)}px`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '质检失败');
    } finally {
      setBusy(false);
    }
  };

  const lowConfTotal = readyPages.reduce((n, p) => n + p.chars.filter((c) => c.conf < CONFIDENCE_THRESHOLD).length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">脚本生成与导出</h1>
        <Select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'perPage' | 'merged')}
          options={[
            { value: 'perPage', label: '每页一个脚本' },
            { value: 'merged', label: '多页合并为一个脚本（F7.6）' },
          ]}
          className="w-60"
        />
        <Select
          value={previewPage?.id ?? ''}
          onChange={(e) => {
            setSelectedPageId(e.target.value);
            setEditedCode(null);
          }}
          options={readyPages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}` }))}
          className="w-64"
          aria-label="预览页面"
        />
        <div className="flex-1" />
        <Button onClick={handleDownload} disabled={readyPages.length === 0}>
          <Download className="h-4 w-4" /> 下载
        </Button>
        <Button variant="outline" onClick={() => void handleZip()} disabled={readyPages.length === 0}>
          <FileArchive className="h-4 w-4" /> zip 打包
        </Button>
        {hasFSAccess() && (
          <Button variant="outline" onClick={() => void handleWriteDir()} disabled={readyPages.length === 0 || busy}>
            <FolderOutput className="h-4 w-4" /> 写入文件夹
          </Button>
        )}
        <Button variant="secondary" onClick={() => void handleVerify()} disabled={!previewPage || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          生成质检报告
        </Button>
      </div>

      {lowConfTotal > 0 && (
        <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          提示：还有 {lowConfTotal} 个低置信字符未确认，建议先到「校对」页处理（不强制）。
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {metrics && (
        <div className="flex gap-4 rounded-md border p-3 text-sm">
          <span>IoU：{metrics.iou.toFixed(3)}</span>
          <span>字符命中率：{(metrics.charHitRate * 100).toFixed(1)}%</span>
          <span>平均偏移：{metrics.avgOffsetPx.toFixed(2)} px</span>
          <img src={metrics.overlayDataUrl} alt="叠加比对" className="ml-auto h-20 rounded border" />
        </div>
      )}

      {/* 脚本预览与微调（F7.9） */}
      {preview && (
        <div>
          <div className="mb-1 flex items-center gap-3">
            <Label>脚本预览（可直接微调，导出前自动重新自检）</Label>
            {preview.ok ? (
              <span className="text-xs text-green-700 dark:text-green-400">✓ 自检通过（UTF-8 无 BOM / 括号配对 / 条数守恒）</span>
            ) : (
              <span className="text-xs text-destructive">
                ✗ {preview.issues.filter((i) => i.level === 'error').map((i) => `${i.message}${i.line ? `(第${i.line}行)` : ''}`).join('；')}
              </span>
            )}
          </div>
          <Textarea
            className="code-font h-[420px] w-full text-xs leading-4"
            value={preview.code}
            onChange={(e) => setEditedCode(e.target.value)}
            spellCheck={false}
            aria-label="脚本预览编辑"
          />
        </div>
      )}

      {/* 辅助脚本（F7.9 / 8.10） */}
      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold">辅助脚本（Scribus 内执行）</h2>
        <ul className="grid gap-2 md:grid-cols-2">
          {getHelperScripts(previewPage?.calibration.pageMm).map((h) => (
            <li key={h.filename} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
              <div>
                <div className="font-medium">{h.title}</div>
                <div className="text-xs text-muted-foreground">{h.description}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => downloadText(h.filename, h.code, 'text/x-python')}>
                下载
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {/* 字体检查清单（F8.8，图文指引前置，不藏帮助文档） */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
        <h2 className="mb-2 font-semibold">导出前必看：字体检查清单（防整排空方框）</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            推荐安装 <b>Noto Serif CJK TC Regular</b>（免费开源，最接近旧谱明体）：
            到 notofonts.github.io 下载 <b>静态版 OTF</b>（不要用 Variable 可变字体，Scribus 渲染异常）。
          </li>
          <li>安装时右键字体文件选「<b>为所有用户安装</b>」，否则 Scribus 扫不到。</li>
          <li>装完<b>必须重启 Scribus</b>，字体列表才会刷新。</li>
          <li>备选顺序：Noto Serif CJK TC → 思源宋体（Source Han Serif TC）→ 新细明体（MingLiU/PMingLiU）→ 宋体（SimSun）。</li>
          <li>先在 Scribus 里运行「字体清单脚本」，把清单里的 CJK 全名填到脚本顶部 FORCE_FONT 可 100% 锁定字体。</li>
          <li>新建文档页面尺寸见脚本顶部注释；「查看 → 显示框架」可开关字框虚线（1.6.6 在「查看」菜单，不是「视图」）。</li>
        </ol>
      </div>
    </div>
  );
}
