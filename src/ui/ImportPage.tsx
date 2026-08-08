/**
 * 导入页（F1.1–F1.3）：拖拽 / 点选 / Ctrl+V 粘贴 / 文件夹批量导入；
 * PDF 用 PDF.js 本地拆页渲染（可指定页码范围与渲染 DPI）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileCode2, FolderInput, ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { createEmptyPage } from '@/model/types';
import { useProjectStore } from '@/store/projectStore';
import { hasFSAccess, pickDirectory, readImageFilesFromDirectory } from '@/storage/fsaccess';
import { putImage } from '@/storage/opfs';
import { naturalCompare, pagesPendingAnalysis, uuid } from '@/lib/utils';
import { parseGeneratedScript } from '@/parser/scriptParser';
import { isBlankCanvas, isBlankImageBlob } from '@/imaging/blankPage';
import { PDF_RENDER_DPI } from '@/lib/constants';

const IMAGE_RE = /\.(png|jpe?g|webp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;

interface PendingPdf {
  id: string;
  file: File;
  pageRange: string;
}

/** 图像文件 → ImageData 尺寸探测（TIFF 等不支持的格式会抛错，由调用方提示） */
async function probeImage(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/** PDF 拆页渲染（F1.2），返回每页 PNG Blob 与原页码 */
async function renderPdfPages(
  file: File,
  pageRange: string,
  dpi: number,
  onProgress: (done: number, total: number) => void,
  onBlankPage?: (pageNo: number) => void,
): Promise<Array<{ pageNo: number; blob: Blob; width: number; height: number }>> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const total = doc.numPages;

  // 解析页码范围："1-3,5" → [1,2,3,5]
  const wanted = new Set<number>();
  for (const part of pageRange.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, parseInt(m[1], 10));
    const b = Math.min(total, m[2] ? parseInt(m[2], 10) : a);
    for (let i = a; i <= b; i++) wanted.add(i);
  }
  if (wanted.size === 0) for (let i = 1; i <= total; i++) wanted.add(i);

  const results: Array<{ pageNo: number; blob: Blob; width: number; height: number }> = [];
  const scale = dpi / 72;
  let done = 0;
  for (const pageNo of [...wanted].sort((a, b) => a - b)) {
    const pdfPage = await doc.getPage(pageNo);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    if (isBlankCanvas(canvas)) {
      onBlankPage?.(pageNo);
      onProgress(++done, wanted.size);
      continue;
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PDF 页编码失败'))), 'image/png'),
    );
    results.push({ pageNo, blob, width: canvas.width, height: canvas.height });
    onProgress(++done, wanted.size);
  }
  return results;
}

export default function ImportPage() {
  const { currentProjectId, currentProject, pages, addPages, removePage, setCurrentPage, setView } = useProjectStore();
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [pdfRange, setPdfRange] = useState('');
  const [pendingPdfs, setPendingPdfs] = useState<PendingPdf[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const scriptRef = useRef<HTMLInputElement>(null);

  const hasContent = pages.length > 0 || pendingPdfs.length > 0;
  const pendingPages = pagesPendingAnalysis(pages);
  const readyPages = pages.filter((p) => p.chars.length > 0);
  const hasPendingAnalysis = pendingPages.length > 0 || pendingPdfs.length > 0;

  const appendLog = useCallback((msg: string) => setLog((l) => [...l.slice(-30), msg]), []);

  const importScript = async (file: File) => {
    if (!currentProjectId) return;
    setBusy(true);
    try {
      const parsed = parseGeneratedScript(await file.text(), file.name);
      const imported = parsed.map(({ page }, index) => ({
        ...page,
        projectId: currentProjectId,
        index: pages.length + index,
        source: { ...page.source, name: page.source.name || file.name },
      }));
      addPages(imported);
      appendLog(`已解析脚本 ${file.name}：${imported.length} 个结果页`);
      setCurrentPage(imported[0]?.id ?? '');
      setView('editor');
    } catch (err) {
      appendLog(`脚本解析失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const importImageFiles = useCallback(
    async (files: File[]) => {
      if (!currentProjectId) return;
      setBusy(true);
      try {
        const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
        const newPages = [];
        let index = pages.length;
        for (const f of sorted) {
          try {
            if (await isBlankImageBlob(f)) {
              appendLog(`已跳过空白页：${f.name}`);
              continue;
            }
            const { width, height } = await probeImage(f);
            const imageKey = `img_${uuid()}.png`;
            await putImage(imageKey, f);
            newPages.push(
              createEmptyPage(
                uuid(),
                currentProjectId,
                index++,
                { name: f.name, widthPx: width, heightPx: height, dpi: 0 },
                imageKey,
              ),
            );
            appendLog(`已导入 ${f.name}（${width}×${height}）`);
          } catch {
            appendLog(`跳过 ${f.name}：浏览器无法解码（TIFF 请先转 PNG/JPG）`);
          }
        }
        if (newPages.length > 0) {
          addPages(newPages);
          setCurrentPage(newPages[0].id);
        }
      } finally {
        setBusy(false);
      }
    },
    [currentProjectId, pages.length, addPages, appendLog, setCurrentPage],
  );

  const importPdf = useCallback(
    async (file: File, pageRange: string) => {
      if (!currentProjectId) return 0;
      appendLog(`正在拆分 PDF：${file.name}（${PDF_RENDER_DPI} DPI）…`);
      let skippedBlank = 0;
      const rendered = await renderPdfPages(
        file,
        pageRange,
        PDF_RENDER_DPI,
        (d, t) => appendLog(`PDF 渲染 ${d}/${t}`),
        (pageNo) => {
          skippedBlank++;
          appendLog(`已跳过空白页：${file.name} 第${pageNo}页`);
        },
      );
      const newPages = [];
      let index = useProjectStore.getState().pages.length;
      for (const r of rendered) {
        const imageKey = `img_${uuid()}.png`;
        await putImage(imageKey, r.blob);
        newPages.push(
          createEmptyPage(
            uuid(),
            currentProjectId,
            index++,
            { name: `${file.name} 第${r.pageNo}页`, page: r.pageNo, widthPx: r.width, heightPx: r.height, dpi: PDF_RENDER_DPI },
            imageKey,
          ),
        );
      }
      if (newPages.length > 0) {
        addPages(newPages);
        setCurrentPage(newPages[0].id);
      }
      appendLog(
        rendered.length > 0
          ? `PDF 拆页完成：${rendered.length} 页${skippedBlank > 0 ? `，已跳过 ${skippedBlank} 页空白` : ''}`
          : skippedBlank > 0
            ? `PDF 拆页完成：全部为空白页，已跳过 ${skippedBlank} 页`
            : 'PDF 拆页完成：0 页',
      );
      return newPages.length;
    },
    [currentProjectId, addPages, appendLog, setCurrentPage],
  );

  const queuePdfFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setPendingPdfs((current) => [
        ...current,
        ...files.map((file) => ({ id: uuid(), file, pageRange: pdfRange })),
      ]);
      appendLog(`已添加 ${files.length} 个 PDF，请在下方设置页码范围后点击「开始分析」`);
    },
    [appendLog, pdfRange],
  );

  const handleFiles = useCallback(
    (files: Iterable<File>) => {
      const images: File[] = [];
      const pdfs: File[] = [];
      for (const f of files) {
        if (PDF_RE.test(f.name) || f.type === 'application/pdf') pdfs.push(f);
        else if (IMAGE_RE.test(f.name) || f.type.startsWith('image/')) images.push(f);
      }
      if (images.length > 0) void importImageFiles(images);
      if (pdfs.length > 0) queuePdfFiles(pdfs);
    },
    [importImageFiles, queuePdfFiles],
  );

  const startAnalysis = async () => {
    if (busy || !hasContent) return;
    setBusy(true);
    try {
      const queued = [...pendingPdfs];
      for (const item of queued) {
        try {
          await importPdf(item.file, item.pageRange);
        } catch (err) {
          appendLog(`PDF 处理失败（${item.file.name}）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setPendingPdfs([]);
      const latestPages = useProjectStore.getState().pages;
      if (latestPages.length === 0) return;
      if (pagesPendingAnalysis(latestPages).length > 0) {
        setView('analyze');
      } else {
        setView('editor');
      }
    } finally {
      setBusy(false);
    }
  };

  // Ctrl+V 粘贴（F1.1）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles]);

  const handleFolder = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    const files = await readImageFilesFromDirectory(dir);
    if (files.length === 0) {
      appendLog('所选文件夹内没有可导入的图像文件');
      return;
    }
    await importImageFiles(files);
  };

  if (!currentProjectId) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        请先在「项目」页新建或打开一个项目。
        <div className="mt-4">
          <Button onClick={() => setView('projects')} className="rounded-xl">返回项目列表</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <h1 className="mb-5 text-2xl font-semibold tracking-wide sm:text-3xl">导入图像 · {currentProject()?.name}</h1>

      {/* 拖拽导入区 */}
      <div
        className={`mb-5 rounded-2xl border-2 border-dashed p-8 text-center transition-all duration-300 sm:p-10 ${
          dragOver
            ? 'border-primary bg-primary/5 card-shadow-lg'
            : hasContent
              ? 'border-emerald-300 bg-emerald-50/50 card-shadow dark:border-emerald-800 dark:bg-emerald-950/20'
              : 'border-border bg-card card-shadow'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        aria-label="拖入图像或 PDF，或点击选择文件"
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
      >
        <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${
          dragOver ? 'bg-primary/10' : hasContent ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300' : 'bg-muted/60'
        }`}>
          {hasContent ? (
            <CheckCircle2 className="h-7 w-7" />
          ) : (
            <ImagePlus className={`h-6 w-6 transition-colors ${dragOver ? 'text-primary' : 'text-muted-foreground'}`} />
          )}
        </div>
        <p className="text-sm font-medium">
          {hasContent
            ? `资料上传完成 · ${pages.length} 页已就绪${pendingPdfs.length > 0 ? ` · ${pendingPdfs.length} 个 PDF 待设置` : ''}`
            : '拖入图像 / PDF，或点击选择文件'}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {hasContent
            ? readyPages.length > 0
              ? `已有 ${readyPages.length} 页分析结果，可继续追加新资料；确认设置后点击「开始分析」处理新增页`
              : '可继续拖入或点击添加更多资料；确认设置无误后点击「开始分析」'
            : '支持 PNG / JPG / WebP / PDF，也可以直接 Ctrl+V 粘贴剪切板图像'}
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* 上传后：分析设置（PDF 页码等） */}
      {hasContent && (
        <div className="mb-4 rounded-2xl border bg-card p-4 card-shadow">
          <div className="mb-3">
            <h2 className="text-sm font-medium">分析设置</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              上传完成后可在此调整 PDF 页码范围；图像会立即导入，PDF 将在点击「开始分析」时按设置拆页。
            </p>
          </div>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="min-w-0">
                <Label htmlFor="pdf-range-default">PDF 默认页码范围</Label>
                <Input
                  id="pdf-range-default"
                  value={pdfRange}
                  onChange={(e) => setPdfRange(e.target.value)}
                  placeholder="如 1-3,5（留空表示全部页）"
                  className="mt-1 w-full rounded-xl"
                />
                <p className="mt-1 text-xs text-muted-foreground">新添加的 PDF 会使用此默认值，也可在下方逐个修改。</p>
              </div>
            </div>
            {pendingPdfs.length > 0 && (
              <ul className="space-y-2 rounded-xl border bg-muted/20 p-2">
                {pendingPdfs.map((item) => (
                  <li key={item.id} className="grid gap-2 rounded-lg bg-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)_auto] sm:items-end">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={item.file.name}>{item.file.name}</p>
                      <p className="text-xs text-muted-foreground">待拆页 · {PDF_RENDER_DPI} DPI</p>
                    </div>
                    <div className="min-w-0">
                      <Label htmlFor={`pdf-range-${item.id}`} className="text-xs">页码范围</Label>
                      <Input
                        id={`pdf-range-${item.id}`}
                        value={item.pageRange}
                        onChange={(e) =>
                          setPendingPdfs((current) =>
                            current.map((entry) => (entry.id === item.id ? { ...entry, pageRange: e.target.value } : entry)),
                          )
                        }
                        placeholder="如 1-3,5（留空全部）"
                        className="mt-1 w-full rounded-xl"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-lg text-destructive hover:bg-destructive/10"
                      onClick={() => setPendingPdfs((current) => current.filter((entry) => entry.id !== item.id))}
                    >
                      移除
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* 辅助导入方式 */}
      <div className="mb-4 rounded-2xl border bg-card p-4 card-shadow">
        <div className="mb-3">
          <h2 className="text-sm font-medium">其他导入方式</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">批量读取文件夹，或直接打开 Scribus 脚本到画布。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {hasFSAccess() ? (
            <Button variant="outline" onClick={() => void handleFolder()} disabled={busy} className="w-full rounded-xl">
              <FolderInput className="h-4 w-4" /> 从文件夹批量导入
            </Button>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Button variant="outline" onClick={() => scriptRef.current?.click()} disabled={busy} className="w-full rounded-xl">
            <FileCode2 className="h-4 w-4" /> 导入脚本到画布
          </Button>
        </div>
        <input
          ref={scriptRef}
          type="file"
          accept=".py,.txt,text/x-python,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importScript(file);
            e.target.value = '';
          }}
        />
      </div>

      <div className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {hasContent
                ? hasPendingAnalysis
                  ? `${pages.length} 页已导入，其中 ${pendingPages.length + pendingPdfs.length} 页待分析${readyPages.length > 0 ? `（另有 ${readyPages.length} 页已完成）` : ''}`
                  : `${pages.length} 页均已分析完成`
                : '请先上传需要处理的资料'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hasPendingAnalysis
                ? '开始后将仅处理待分析的新增页，已有识别结果会保留。'
                : '开始后将自动完成去斜、增强、版面检测和字符分割，无需选择算法参数。'}
            </p>
          </div>
          {busy && <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />}
          <Button onClick={() => void startAnalysis()} disabled={!hasContent || busy} className="w-full shrink-0 rounded-xl sm:w-auto">
            {hasPendingAnalysis ? '开始分析 →' : readyPages.length > 0 ? '打开结果画布 →' : '开始分析 →'}
          </Button>
        </div>
      </div>

      {/* 已导入页面列表 */}
      <h2 className="mb-3 text-sm font-medium">已导入页面（{pages.length + pendingPdfs.length}）</h2>
      {pages.length === 0 && pendingPdfs.length === 0 ? (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-dashed bg-card/70 px-4 py-4 text-sm text-muted-foreground">
          <ImagePlus className="h-5 w-5 shrink-0" />
          <span>还没有页面。拖入图像、选择 PDF，或导入 Scribus 脚本后，页面会显示在这里。</span>
        </div>
      ) : (
        <ul className="mb-6 max-h-64 space-y-1 overflow-y-auto rounded-xl border bg-card p-2 card-shadow">
          {pendingPdfs.map((item, index) => (
            <li key={item.id} className="flex items-center gap-2.5 rounded-lg bg-amber-50/80 px-3 py-2 text-sm dark:bg-amber-950/20">
              <span className="w-8 shrink-0 text-muted-foreground">待{index + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={item.file.name}>{item.file.name}</span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                PDF · {item.pageRange.trim() || '全部页'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingPdfs((current) => current.filter((entry) => entry.id !== item.id))}
                aria-label="移除待处理 PDF"
                className="shrink-0 rounded-lg text-destructive hover:bg-destructive/10"
              >
                删除
              </Button>
            </li>
          ))}
          {pages.map((p) => (
            <li key={p.id} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent">
              <span className="w-8 shrink-0 text-muted-foreground">#{p.index + 1}</span>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => setCurrentPage(p.id)} title={p.source.name}>
                {p.source.name}
              </button>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {p.source.widthPx}×{p.source.heightPx}
                {p.chars.length > 0 ? ' · 已完成' : ' · 待分析'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void removePage(p.id)} aria-label="删除本页" className="shrink-0 rounded-lg text-destructive hover:bg-destructive/10">
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      {log.length > 0 && (
        <div className="rounded-xl border bg-muted/30 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">导入日志</p>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {log.map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ul>
        </div>
      )}

    </div>
  );
}
