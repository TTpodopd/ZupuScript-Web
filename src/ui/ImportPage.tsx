/**
 * 导入页（F1.1–F1.3）：拖拽 / 点选 / Ctrl+V 粘贴 / 文件夹批量导入；
 * PDF 用 PDF.js 本地拆页渲染（可指定页码范围与渲染 DPI）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderInput, ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { createEmptyPage } from '@/model/types';
import { useProjectStore } from '@/store/projectStore';
import { hasFSAccess, pickDirectory, readImageFilesFromDirectory } from '@/storage/fsaccess';
import { putImage } from '@/storage/opfs';
import { naturalCompare, uuid } from '@/lib/utils';
import { DEFAULT_DPI } from '@/lib/constants';

const IMAGE_RE = /\.(png|jpe?g|webp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;

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
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
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
  const [pdfDpi, setPdfDpi] = useState(DEFAULT_DPI);
  const fileRef = useRef<HTMLInputElement>(null);

  const appendLog = useCallback((msg: string) => setLog((l) => [...l.slice(-30), msg]), []);

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
        if (newPages.length > 0) addPages(newPages);
      } finally {
        setBusy(false);
      }
    },
    [currentProjectId, pages.length, addPages, appendLog],
  );

  const importPdf = useCallback(
    async (file: File) => {
      if (!currentProjectId) return;
      setBusy(true);
      appendLog(`正在拆分 PDF：${file.name}（DPI=${pdfDpi}）…`);
      try {
        const rendered = await renderPdfPages(file, pdfRange, pdfDpi, (d, t) => appendLog(`PDF 渲染 ${d}/${t}`));
        const newPages = [];
        let index = pages.length;
        for (const r of rendered) {
          const imageKey = `img_${uuid()}.png`;
          await putImage(imageKey, r.blob);
          newPages.push(
            createEmptyPage(
              uuid(),
              currentProjectId,
              index++,
              { name: `${file.name} 第${r.pageNo}页`, page: r.pageNo, widthPx: r.width, heightPx: r.height, dpi: pdfDpi },
              imageKey,
            ),
          );
        }
        addPages(newPages);
        appendLog(`PDF 拆页完成：${rendered.length} 页`);
      } catch (err) {
        appendLog(`PDF 处理失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [currentProjectId, pages.length, pdfRange, pdfDpi, addPages, appendLog],
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
      for (const p of pdfs) void importPdf(p);
    },
    [importImageFiles, importPdf],
  );

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
          <Button onClick={() => setView('projects')}>返回项目列表</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-xl font-semibold">导入图像 · {currentProject()?.name}</h1>

      <div
        className={`mb-4 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          dragOver ? 'border-primary bg-accent' : 'border-border'
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
        <ImagePlus className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
        <p className="text-sm">拖入图像 / PDF，或点击选择文件；也可以直接 Ctrl+V 粘贴剪切板图像</p>
        <p className="mt-1 text-xs text-muted-foreground">支持 PNG / JPG / WebP（TIFF 请先转换格式）/ PDF</p>
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

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="pdf-range">PDF 页码范围（留空全部）</Label>
          <Input id="pdf-range" value={pdfRange} onChange={(e) => setPdfRange(e.target.value)} placeholder="如 1-3,5" className="w-36" />
        </div>
        <div>
          <Label htmlFor="pdf-dpi">PDF 渲染 DPI</Label>
          <Input
            id="pdf-dpi"
            type="number"
            value={pdfDpi}
            onChange={(e) => setPdfDpi(Math.max(72, parseInt(e.target.value, 10) || DEFAULT_DPI))}
            className="w-24"
          />
        </div>
        {hasFSAccess() && (
          <Button variant="outline" onClick={() => void handleFolder()} disabled={busy}>
            <FolderInput className="h-4 w-4" /> 从文件夹批量导入
          </Button>
        )}
        {busy && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        <div className="flex-1" />
        <Button onClick={() => setView('analyze')} disabled={pages.length === 0}>
          前往分析 →
        </Button>
      </div>

      <h2 className="mb-2 text-sm font-medium">已导入页面（{pages.length}）</h2>
      <ul className="mb-4 max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
        {pages.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
            <span className="w-8 text-muted-foreground">#{p.index + 1}</span>
            <button className="flex-1 truncate text-left" onClick={() => setCurrentPage(p.id)} title={p.source.name}>
              {p.source.name}
            </button>
            <span className="text-xs text-muted-foreground">
              {p.source.widthPx}×{p.source.heightPx}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void removePage(p.id)} aria-label="删除本页">
              删除
            </Button>
          </li>
        ))}
      </ul>

      {log.length > 0 && (
        <pre className="max-h-32 overflow-y-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">{log.join('\n')}</pre>
      )}
    </div>
  );
}
