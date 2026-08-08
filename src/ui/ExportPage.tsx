import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileCode2, FileImage, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Label, Textarea } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { CONFIDENCE_THRESHOLD } from '@/lib/constants';
import { generateMergedScript, generatePageScript } from '@/generator/export';
import { lintScript } from '@/generator/lint';
import { getBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { buildReportHtml, computeVerify, type VerifyMetrics } from '@/verify/report';
import { renderPreviewToCanvas } from '@/verify/preview';
import { downloadText } from '@/lib/utils';
import { exportProofreadPdf, exportProofreadPng } from '@/export/proofreadExport';

type BusyAction = 'png' | 'pagePdf' | 'allPdf' | 'verify' | null;

export default function ExportPage() {
  const { pages, currentPageId, currentProject, setView } = useProjectStore();
  const project = currentProject();
  const [selectedPageId, setSelectedPageId] = useState<string | null>(currentPageId);
  const [editedCode, setEditedCode] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState('');
  const [metrics, setMetrics] = useState<VerifyMetrics | null>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);

  const readyPages = useMemo(() => pages.filter((page) => page.chars.length > 0), [pages]);
  const previewPage = readyPages.find((page) => page.id === selectedPageId) ?? readyPages[0];

  const generatedPageScript = useMemo(
    () => (previewPage ? generatePageScript(previewPage) : null),
    [previewPage],
  );
  const previewScript = useMemo(() => {
    if (!generatedPageScript) return null;
    if (editedCode === null) return generatedPageScript;
    const issues = lintScript(editedCode);
    return {
      ...generatedPageScript,
      code: editedCode,
      issues,
      ok: !issues.some((issue) => issue.level === 'error'),
    };
  }, [editedCode, generatedPageScript]);
  const mergedScript = useMemo(
    () => (project && readyPages.length > 0 ? generateMergedScript(project, readyPages) : null),
    [project, readyPages],
  );

  useEffect(() => {
    if (previewPage && resultCanvasRef.current) renderPreviewToCanvas(previewPage, resultCanvasRef.current);
  }, [previewPage]);

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

  const runExport = async (action: Exclude<BusyAction, null>, task: () => Promise<string>) => {
    setBusyAction(action);
    setMessage('正在生成文件…');
    try {
      const filename = await task();
      setMessage(`已生成：${filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导出失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerify = async () => {
    if (!previewPage) return;
    setBusyAction('verify');
    setMessage('正在比对校对成果与原图…');
    try {
      const stored = await getBinaryImage(previewPage.binaryKey);
      if (!stored) throw new Error('找不到预处理二值图，无法质检');
      const result = computeVerify(previewPage, stored.bin, stored.width, stored.height);
      setMetrics(result);
      downloadText(
        `质检报告_${previewPage.source.name.replace(/\.[^.]+$/, '')}.html`,
        buildReportHtml(previewPage, result),
        'text/html',
      );
      setMessage(`质检完成：IoU ${result.iou.toFixed(3)}，字符命中率 ${(result.charHitRate * 100).toFixed(1)}%`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '质检失败');
    } finally {
      setBusyAction(null);
    }
  };

  const downloadMergedScript = () => {
    if (!mergedScript) return;
    if (!mergedScript.ok) {
      setMessage(`脚本自检未通过：${mergedScript.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；')}`);
      return;
    }
    downloadText(mergedScript.filename, mergedScript.code, 'text/x-python');
    setMessage(`已生成：${mergedScript.filename}（单个脚本包含 ${readyPages.length} 页）`);
  };

  const downloadCurrentPageScript = () => {
    if (!previewScript) return;
    if (!previewScript.ok) {
      setMessage(`脚本自检未通过：${previewScript.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；')}`);
      return;
    }
    downloadText(previewScript.filename, previewScript.code, 'text/x-python');
    setMessage(`已生成：${previewScript.filename}`);
  };

  const lowConfTotal = readyPages.reduce(
    (total, page) => total + page.chars.filter((char) => char.conf < CONFIDENCE_THRESHOLD).length,
    0,
  );
  const busy = busyAction !== null;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-end gap-3 border-b pb-4">
        <div>
          <h1 className="text-xl font-semibold">成果导出</h1>
          <p className="mt-1 text-sm text-muted-foreground">直接使用校对结果，或交给 Scribus 做印刷级排版。</p>
        </div>
        <div className="ml-auto w-full sm:w-72">
          <Select
            value={previewPage?.id ?? ''}
            onChange={(event) => {
              setSelectedPageId(event.target.value);
              setEditedCode(null);
              setMetrics(null);
            }}
            options={readyPages.map((page) => ({ value: page.id, label: `第 ${page.index + 1} 页 · ${page.source.name}` }))}
            aria-label="选择导出页面"
          />
        </div>
      </header>

      {lowConfTotal > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <span>还有 {lowConfTotal} 个低置信字符未确认，导出前建议完成校对。</span>
          <Button className="ml-auto" size="sm" variant="outline" onClick={() => setView('editor')}>
            返回画布
          </Button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <FileImage className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">校对成果</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">导出的是干净成品，不包含选中框、低置信标记和操作提示。</p>
          </div>

          <div className="flex min-h-80 items-center justify-center bg-muted/35 p-4">
            {previewPage ? (
              <canvas
                ref={resultCanvasRef}
                className="max-h-[440px] max-w-full border bg-white object-contain shadow-sm"
                aria-label="校对成果预览"
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无可导出的校对页面</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 border-t p-4">
            <Button
              onClick={() => previewPage && void runExport('png', () => exportProofreadPng(previewPage))}
              disabled={!previewPage || busy}
            >
              {busyAction === 'png' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
              当前页 PNG
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                previewPage &&
                void runExport('pagePdf', () =>
                  exportProofreadPdf([previewPage], `${previewPage.source.name.replace(/\.[^.]+$/, '')}_校对成果.pdf`),
                )
              }
              disabled={!previewPage || busy}
            >
              {busyAction === 'pagePdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              当前页 PDF
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void runExport('allPdf', () =>
                  exportProofreadPdf(readyPages, `${project.name}_校对成果.pdf`, (done, total) =>
                    setMessage(`正在生成 PDF：${done}/${total} 页`),
                  ),
                )
              }
              disabled={readyPages.length === 0 || busy}
            >
              {busyAction === 'allPdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              全部页面 PDF
            </Button>
          </div>
        </section>

        <section className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Scribus 脚本</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            主脚本已内嵌全部版面数据，可直接在 Scribus 1.6.6 中执行，不再附带 JSON、TXT、说明和辅助脚本。
          </p>

          <div className="mt-5 rounded-md border border-primary/25 bg-primary/5 p-4">
            <p className="text-xs text-muted-foreground">推荐 · 全项目一个文件</p>
            <p className="mt-1 break-all text-sm font-medium">{mergedScript?.filename ?? '暂无可导出脚本'}</p>
            <p className="mt-1 text-xs text-muted-foreground">包含 {readyPages.length} 页，执行后自动按顺序创建页面。</p>
            <Button className="mt-4 w-full" onClick={downloadMergedScript} disabled={!mergedScript || !mergedScript.ok || busy}>
              <Download className="h-4 w-4" /> 下载完整 Scribus 脚本
            </Button>
          </div>

          <div className="mt-4 border-t pt-4">
            <p className="text-xs text-muted-foreground">只处理当前页时</p>
            <p className="mt-1 break-all text-sm">{previewScript?.filename ?? '未选择页面'}</p>
            <Button className="mt-3 w-full" variant="outline" onClick={downloadCurrentPageScript} disabled={!previewScript || !previewScript.ok || busy}>
              <Download className="h-4 w-4" /> 仅下载当前页脚本
            </Button>
          </div>

          <div className="mt-5 rounded-md bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
            在 Scribus 中先新建与脚本顶部尺寸一致的文档，再通过“脚本 → 执行脚本”运行下载的 `.py` 文件。
          </div>
        </section>
      </div>

      {message && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{message}</p>}

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">脚本检查与高级编辑</summary>
        <div className="border-t p-4">
          {previewScript && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <Label>当前页脚本</Label>
                <span className={previewScript.ok ? 'text-xs text-green-700 dark:text-green-400' : 'text-xs text-destructive'}>
                  {previewScript.ok
                    ? '自检通过'
                    : previewScript.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；')}
                </span>
              </div>
              <Textarea
                className="code-font h-[360px] w-full text-xs leading-4"
                value={previewScript.code}
                onChange={(event) => setEditedCode(event.target.value)}
                spellCheck={false}
                aria-label="当前页 Scribus 脚本"
              />
              <p className="mt-2 text-xs text-muted-foreground">这里的修改只应用于“仅下载当前页脚本”。</p>
            </>
          )}
        </div>
      </details>

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">可选：生成当前页质检报告</summary>
        <div className="flex flex-wrap items-center gap-3 border-t p-4">
          <Button variant="outline" onClick={() => void handleVerify()} disabled={!previewPage || busy}>
            {busyAction === 'verify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            下载质检报告
          </Button>
          {metrics && (
            <>
              <span className="text-sm">IoU：{metrics.iou.toFixed(3)}</span>
              <span className="text-sm">字符命中率：{(metrics.charHitRate * 100).toFixed(1)}%</span>
              <span className="text-sm">平均偏移：{metrics.avgOffsetPx.toFixed(2)} px</span>
              <img src={metrics.overlayDataUrl} alt="质检叠加结果" className="ml-auto h-20 rounded border" />
            </>
          )}
        </div>
      </details>
    </div>
  );
}
