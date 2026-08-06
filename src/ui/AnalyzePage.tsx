/**
 * 分析页（F2.x / F3.x）：预处理参数（去斜滑块、二值化切换、阈值）+ 运行管线 +
 * 图元遮罩叠示（可逐类开关，F3.7）+ 批处理（P1 极简：连续多页顺序本地处理）。
 * 识别入口（RecognizePanel）嵌在本页底部。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Loader2, Play, Settings2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { Slider } from '@/ui/components/ui/slider';
import { DEFAULT_DPI, DESKEW_RANGE_DEG } from '@/lib/constants';
import { calibratePage } from '@/calibrate/calibrate';
import { pageMmFromPx } from '@/calibrate/calibrate';
import { binaryToImageData } from '@/imaging/raster';
import type { Page } from '@/model/types';
import { getBinaryImage, getPageImageData, putBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { PipelineAPI, ProgressInfo } from '@/workers/pipeline.worker';
import RecognizePanel from './RecognizePanel';

type MaskKey = 'rects' | 'lines' | 'nodes' | 'tags' | 'artifacts';
const MASK_COLORS: Record<MaskKey, string> = {
  rects: 'rgba(220,38,38,0.45)',
  lines: 'rgba(37,99,235,0.5)',
  nodes: 'rgba(22,163,74,0.55)',
  tags: 'rgba(234,88,12,0.45)',
  artifacts: 'rgba(147,51,234,0.45)',
};
const MASK_LABELS: Record<MaskKey, string> = {
  rects: '外框',
  lines: '谱系线',
  nodes: '节点圆',
  tags: '装饰块',
  artifacts: '破损痕迹',
};

function createPipeline(): { worker: Worker; api: Comlink.Remote<PipelineAPI> } {
  const worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), { type: 'module' });
  return { worker, api: Comlink.wrap<PipelineAPI>(worker) };
}

export default function AnalyzePage() {
  const { pages, currentPageId, setCurrentPage, updatePage, setView } = useProjectStore();
  const { setBatchQueue, updateBatchTask } = useSettingsStore();
  const page: Page | undefined = pages.find((p) => p.id === currentPageId) ?? pages[0];

  const [binarizer, setBinarizer] = useState<'otsu' | 'sauvola'>('otsu');
  const [threshold, setThreshold] = useState(0);
  const [manualDeg, setManualDeg] = useState(0);
  const [useOpenCV, setUseOpenCV] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [masks, setMasks] = useState<Record<MaskKey, boolean>>({ rects: true, lines: true, nodes: true, tags: true, artifacts: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipelineRef = useRef<ReturnType<typeof createPipeline> | null>(null);

  const getPipeline = () => {
    if (!pipelineRef.current) pipelineRef.current = createPipeline();
    return pipelineRef.current;
  };
  useEffect(() => () => pipelineRef.current?.worker.terminate(), []);

  /** ① 预处理：原图 → 去斜/二值化/去噪/DPI 归一 → binary 存 OPFS + calibration 锁定 */
  const runPreprocess = async (target: Page): Promise<Uint8Array | null> => {
    const image = await getPageImageData(target.imageKey);
    if (!image) {
      setMessage('找不到原图（可能从 .zpproj 导入后尚未重新关联图像）');
      return null;
    }
    const { api } = getPipeline();
    const result = await api.preprocess(
      image,
      {
        targetDpi: target.source.dpi > 0 ? target.source.dpi : DEFAULT_DPI,
        sourceDpi: target.source.dpi > 0 ? target.source.dpi : undefined,
        binarizer,
        threshold: binarizer === 'otsu' ? threshold : undefined,
        manualDeskewDeg: Math.abs(manualDeg) > 0.01 ? manualDeg : undefined,
        useOpenCV,
      },
      Comlink.proxy((p: ProgressInfo) => setProgress(p)),
    );
    const binaryKey = `bin_${target.id}.png`;
    await putBinaryImage(binaryKey, result.binary as Uint8Array, result.width, result.height);
    updatePage(target.id, {
      binaryKey,
      status: 'preprocessed',
      calibration: {
        pxPerMm: result.pxPerMm,
        pageMm: pageMmFromPx(result.width, result.height, result.pxPerMm),
        deskewDeg: result.deskewDeg,
      },
      source: { ...target.source, widthPx: result.width, heightPx: result.height },
    });
    return result.binary as Uint8Array;
  };

  /** ② 版面分析 + 字符分割 + 自动标定 */
  const runAnalyze = async (target: Page, binary?: Uint8Array): Promise<void> => {
    let bin = binary;
    let w = target.source.widthPx;
    let h = target.source.heightPx;
    if (!bin) {
      const stored = await getBinaryImage(target.binaryKey);
      if (!stored) {
        setMessage('请先运行预处理');
        return;
      }
      bin = stored.bin;
      w = stored.width;
      h = stored.height;
    }
    const { api } = getPipeline();
    const layout = await api.analyze(bin as Uint8Array, w, h, Comlink.proxy((p: ProgressInfo) => setProgress(p)));
    setProgress({ stage: 'segment', percent: 50 });
    const chars = await api.segment(bin as Uint8Array, w, h, layout.treeLines);
    // 自动标定（F5.1/F5.2）：聚类字号并写回
    const calibrated = calibratePage({ ...target, chars, calibration: { ...target.calibration, pxPerMm: target.calibration.pxPerMm } });
    updatePage(target.id, {
      borderRects: layout.borderRects,
      tagRects: layout.tagRects,
      treeLines: layout.treeLines,
      treeNodes: layout.treeNodes,
      artifacts: layout.artifacts,
      chars: calibrated.chars,
      fontSizes: calibrated.fontSizes,
      status: 'analyzed',
    });
    setProgress({ stage: 'segment', percent: 100 });
    setMessage(
      `分析完成：外框 ${layout.borderRects.length}，连线 ${layout.treeLines.length}，节点 ${layout.treeNodes.length}，字符 ${chars.length}`,
    );
  };

  const handleRunAll = async () => {
    if (!page || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const bin = await runPreprocess(page);
      if (bin) await runAnalyze({ ...page, ...useProjectStore.getState().pages.find((p) => p.id === page.id)! } as Page, bin);
    } catch (err) {
      setMessage(`处理失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** ③ 批处理（P1 极简）：连续多页顺序处理，失败页跳过并记录（F11.1/F11.2） */
  const handleBatch = async () => {
    if (busy) return;
    setBusy(true);
    setBatchQueue(pages.map((p) => ({ pageId: p.id, status: 'pending' })));
    let ok = 0;
    let fail = 0;
    for (const p of pages) {
      updateBatchTask(p.id, { status: 'running' });
      setMessage(`批处理：第 ${p.index + 1}/${pages.length} 页（成功 ${ok}，失败 ${fail}）`);
      try {
        const bin = await runPreprocess(p);
        if (!bin) throw new Error('无原图');
        const fresh = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        await runAnalyze(fresh, bin);
        updateBatchTask(p.id, { status: 'done' });
        ok++;
      } catch (err) {
        updateBatchTask(p.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        fail++;
      }
    }
    setMessage(`批处理完成：成功 ${ok} 页，失败 ${fail} 页${fail > 0 ? '（失败页可单独重试）' : ''}`);
    setBusy(false);
  };

  /* ---------- 遮罩叠示（F3.7） ---------- */
  const overlayData = useMemo(() => page, [page]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overlayData) return;
    void (async () => {
      const stored = await getBinaryImage(overlayData.binaryKey);
      if (!stored) return;
      const scale = Math.min(1, 900 / stored.width);
      const w = Math.round(stored.width * scale);
      const h = Math.round(stored.height * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      // 底：二值图
      const img = binaryToImageData(stored.bin, stored.width, stored.height);
      const tmp = document.createElement('canvas');
      tmp.width = stored.width;
      tmp.height = stored.height;
      tmp.getContext('2d')!.putImageData(img, 0, 0);
      ctx.drawImage(tmp, 0, 0, w, h);
      // 遮罩
      const s = scale;
      if (masks.rects) {
        ctx.fillStyle = MASK_COLORS.rects;
        for (const r of overlayData.borderRects) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      }
      if (masks.tags) {
        ctx.fillStyle = MASK_COLORS.tags;
        for (const r of overlayData.tagRects) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      }
      if (masks.lines) {
        ctx.strokeStyle = MASK_COLORS.lines;
        for (const l of overlayData.treeLines) {
          ctx.lineWidth = Math.max(1.5, l.widthPx * s);
          ctx.beginPath();
          ctx.moveTo(l.x1 * s, l.y1 * s);
          ctx.lineTo(l.x2 * s, l.y2 * s);
          ctx.stroke();
        }
      }
      if (masks.nodes) {
        ctx.strokeStyle = MASK_COLORS.nodes;
        ctx.lineWidth = 2;
        for (const n of overlayData.treeNodes) {
          ctx.beginPath();
          ctx.arc(n.cx * s, n.cy * s, n.r * s, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (masks.artifacts) {
        ctx.strokeStyle = MASK_COLORS.artifacts;
        ctx.lineWidth = 2;
        for (const a of overlayData.artifacts) {
          ctx.beginPath();
          ctx.moveTo(a.x1 * s, a.y1 * s);
          ctx.lineTo(a.x2 * s, a.y2 * s);
          ctx.stroke();
        }
      }
    })();
  }, [overlayData, masks]);

  if (pages.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        当前项目还没有页面，请先到「导入」页添加图像。
        <div className="mt-4">
          <Button onClick={() => setView('import')}>前往导入</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">本地分析</h1>
        <Select
          value={page?.id ?? ''}
          onChange={(e) => setCurrentPage(e.target.value)}
          options={pages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}（${p.status}）` }))}
          className="w-72"
          aria-label="选择页面"
        />
        <Button onClick={() => void handleRunAll()} disabled={busy || !page}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          运行：预处理 + 版面分析 + 字符分割
        </Button>
        <Button variant="outline" onClick={() => void handleBatch()} disabled={busy}>
          批量处理全部页
        </Button>
        <Button variant="ghost" onClick={() => setView('editor')} disabled={!page || page.chars.length === 0}>
          前往校对 →
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* 参数面板 */}
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Settings2 className="h-4 w-4" /> 预处理参数
          </div>
          <div>
            <Label>二值化算法（F2.3）</Label>
            <Select value={binarizer} onChange={(e) => setBinarizer(e.target.value as 'otsu' | 'sauvola')} options={[
              { value: 'otsu', label: 'Otsu（整体阈值，速度快）' },
              { value: 'sauvola', label: 'Sauvola（局部自适应，污损页）' },
            ]} />
          </div>
          {binarizer === 'otsu' && (
            <div>
              <Label>阈值偏移：{threshold}</Label>
              <Slider value={[threshold]} onValueChange={([v]) => setThreshold(v)} min={-50} max={50} step={1} />
            </div>
          )}
          <div>
            <Label>手动去斜：{manualDeg.toFixed(1)}°（0 = 自动，F2.2）</Label>
            <Slider value={[manualDeg]} onValueChange={([v]) => setManualDeg(v)} min={-DESKEW_RANGE_DEG} max={DESKEW_RANGE_DEG} step={0.1} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useOpenCV} onChange={(e) => setUseOpenCV(e.target.checked)} />
            高精度模式（懒加载 OpenCV.js，失败自动回退）
          </label>
          {page && page.calibration.pxPerMm > 0 && (
            <div className="rounded bg-muted p-2 text-xs text-muted-foreground">
              PX_PER_MM 已锁定：{page.calibration.pxPerMm.toFixed(3)}　去斜：
              {page.calibration.deskewDeg.toFixed(1)}°　页面：
              {page.calibration.pageMm[0].toFixed(1)}×{page.calibration.pageMm[1].toFixed(1)} mm
            </div>
          )}
          <div>
            <Label>遮罩开关（F3.7）</Label>
            <div className="mt-1 space-y-1">
              {(Object.keys(MASK_LABELS) as MaskKey[]).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={masks[k]}
                    onChange={(e) => setMasks((m) => ({ ...m, [k]: e.target.checked }))}
                  />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: MASK_COLORS[k] }} />
                  {MASK_LABELS[k]}
                  {k === 'rects' && page ? `（${page.borderRects.length}）` : ''}
                  {k === 'lines' && page ? `（${page.treeLines.length}）` : ''}
                  {k === 'nodes' && page ? `（${page.treeNodes.length}）` : ''}
                  {k === 'tags' && page ? `（${page.tagRects.length}）` : ''}
                  {k === 'artifacts' && page ? `（${page.artifacts.length}）` : ''}
                </label>
              ))}
            </div>
          </div>
          {progress && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                {progress.stage} {progress.percent}%
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
          )}
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </div>

        {/* 预览画布 */}
        <div className="overflow-auto rounded-lg border bg-muted/30 p-2">
          <canvas ref={canvasRef} className="mx-auto max-w-full" aria-label="分析结果遮罩预览" />
          {!page?.binaryKey && (
            <p className="p-10 text-center text-sm text-muted-foreground">尚未预处理。点击上方「运行」开始本地分析。</p>
          )}
        </div>
      </div>

      {/* 识别（模式 A/B/C） */}
      {page && page.chars.length > 0 && <RecognizePanel page={page} />}
    </div>
  );
}
