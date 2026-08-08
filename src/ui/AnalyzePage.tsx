/**
 * 分析页（F2.x / F3.x）：预处理参数（去斜滑块、二值化切换、阈值）+ 运行管线 +
 * 图元遮罩叠示（可逐类开关，F3.7）+ 批处理（P1 极简：连续多页顺序本地处理）。
 * 识别入口（RecognizePanel）嵌在本页底部。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Check, ChevronRight, Loader2, Play } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { calibratePage } from '@/calibrate/calibrate';
import { pageMmFromPx } from '@/calibrate/calibrate';
import { binaryToImageData } from '@/imaging/raster';
import type { Page } from '@/model/types';
import { getBinaryImage, getPageImageData, putBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { PipelineAPI, ProgressInfo } from '@/workers/pipeline.worker';
import RecognizePanel from './RecognizePanel';
import { recognizePage } from '@/recognize/orchestrator';
import type { ProviderConfig, RecognizeProgress } from '@/recognize/types';

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
  const { pages, currentProjectId, currentPageId, setCurrentPage, updatePage, setView } = useProjectStore();
  const { setBatchQueue, updateBatchTask } = useSettingsStore();
  const page: Page | undefined = pages.find((p) => p.id === currentPageId) ?? pages[0];

  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoProcessing, setAutoProcessing] = useState(false);
  const [recognitionProgress, setRecognitionProgress] = useState<RecognizeProgress | null>(null);
  const [message, setMessage] = useState('');
  const [masks, setMasks] = useState<Record<MaskKey, boolean>>({ rects: true, lines: true, nodes: true, tags: true, artifacts: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipelineRef = useRef<ReturnType<typeof createPipeline> | null>(null);
  const autoStartedRef = useRef<string | null>(null);

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
        targetDpi: target.source.dpi > 0 ? target.source.dpi : 254,
        sourceDpi: target.source.dpi > 0 ? target.source.dpi : undefined,
        binarizer: 'sauvola',
        useOpenCV: true,
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
    const chars = await api.segment(
      bin as Uint8Array,
      w,
      h,
      layout.treeLines,
      [...layout.borderRects, ...layout.tagRects],
    );
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

  const runRecognition = async (target: Page): Promise<void> => {
    const stored = await getBinaryImage(target.binaryKey);
    if (!stored) throw new Error('找不到预处理结果，无法开始识别');
    const settings = useSettingsStore.getState();
    const mode = 'A' as const;
    const cfg: ProviderConfig = {
      provider: 'local',
      model: 'local-tesseract',
      concurrency: settings.concurrency,
      timeoutMs: settings.timeoutMs,
      maxRetries: settings.maxRetries,
    };
    const result = await recognizePage(
      target,
      stored.bin,
      stored.width,
      stored.height,
      cfg,
      mode,
      settings.pageBudgetCny,
      (p: RecognizeProgress) => setRecognitionProgress(p),
    );
    updatePage(target.id, {
      chars: result.chars,
      status: 'recognized',
      recognition: {
        mode,
        provider: 'local',
        model: cfg.model,
        batches: result.outcome.batches,
        costEstimateCny: result.outcome.costCny,
      },
    });
    settings.addSessionCost(result.outcome.costCny);
  };

  const handleRunAll = async () => {
    if (!page || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const bin = await runPreprocess(page);
      if (bin) {
        const preprocessed = useProjectStore.getState().pages.find((item) => item.id === page.id)!;
        await runAnalyze(preprocessed, bin);
        const analyzed = useProjectStore.getState().pages.find((item) => item.id === page.id)!;
        if (analyzed.chars.length > 0) {
          await runRecognition(analyzed);
          setView('editor');
        }
      }
    } catch (err) {
      setMessage(`处理失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const workflow = [
    { key: 'imported', label: '资料上传', hint: '原图已安全保存到本机' },
    { key: 'preprocessed', label: '高清预处理', hint: '自动去斜、增强和去噪' },
    { key: 'analyzed', label: '版面分析', hint: '识别外框、谱系线和节点' },
    { key: 'recognized', label: '字符识别', hint: '完成后进入画布逐字校对' },
    { key: 'proofread', label: '校对并输出', hint: '确认结果后交给 Scribus 排版' },
  ] as const;
  const statusRank: Record<string, number> = { imported: 1, preprocessed: 2, analyzed: 3, recognized: 4, proofread: 4, exported: 5 };
  const statusStep = page ? statusRank[page.status] ?? 0 : 0;
  const activeStep = busy
    ? progress?.stage === 'layout' || progress?.stage === 'segment' ? 2 : 1
    : statusStep;

  /** ③ 批处理（P1 极简）：连续多页顺序处理，失败页跳过并记录（F11.1/F11.2） */
  const handleBatch = async () => {
    if (busy) return;
    const pendingPages = pages.filter((item) => item.status === 'imported' || item.status === 'preprocessed' || item.status === 'analyzed');
    if (pendingPages.length === 0) return;
    setBusy(true);
    setAutoProcessing(true);
    setBatchQueue(pendingPages.map((p) => ({ pageId: p.id, status: 'pending' })));
    let ok = 0;
    let fail = 0;
    for (const p of pendingPages) {
      updateBatchTask(p.id, { status: 'running' });
      setCurrentPage(p.id);
      setMessage(`正在处理第 ${ok + fail + 1}/${pendingPages.length} 页：${p.source.name}`);
      try {
        let analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        if (analyzed.status !== 'analyzed') {
          const bin = await runPreprocess(analyzed);
          if (!bin) throw new Error('无原图');
          analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
          await runAnalyze(analyzed, bin);
          analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        }
        if (analyzed.chars.length > 0) {
          setMessage(`正在识别第 ${ok + fail + 1}/${pendingPages.length} 页：${p.source.name}`);
          await runRecognition(analyzed);
        }
        updateBatchTask(p.id, { status: 'done' });
        ok++;
      } catch (err) {
        updateBatchTask(p.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        fail++;
      }
    }
    setMessage(`批处理完成：成功 ${ok} 页，失败 ${fail} 页${fail > 0 ? '（失败页可单独重试）' : ''}`);
    setBusy(false);
    setAutoProcessing(false);
    if (fail === 0) setView('editor');
  };

  useEffect(() => {
    if (!page || !pages.some((item) => item.status === 'imported') || autoStartedRef.current === currentProjectId) return;
    autoStartedRef.current = currentProjectId;
    void handleBatch();
  }, [currentProjectId, page?.id, page?.status, pages]);

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

  if (autoProcessing || pages.some((item) => item.status === 'imported' || item.status === 'preprocessed' || item.status === 'analyzed')) {
    const recognitionPercent = recognitionProgress && recognitionProgress.totalBatches > 0
      ? (recognitionProgress.doneBatches / recognitionProgress.totalBatches) * 100
      : 0;
    const overallPercent = progress?.stage === 'layout'
      ? 35 + progress.percent * 0.3
      : progress?.stage === 'segment'
        ? 65 + progress.percent * 0.2
        : recognitionProgress
          ? 85 + recognitionPercent * 0.15
          : progress
            ? progress.percent * 0.35
            : 5;
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center justify-center px-4 py-10">
        <div className="w-full rounded-2xl border bg-card p-6 shadow-soft sm:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">正在处理资料</h1>
              <p className="mt-1 text-sm text-muted-foreground">系统正在自动完成分析和识别，请不要关闭页面。</p>
            </div>
          </div>
          <div className="mb-3 flex items-center justify-between text-sm">
            <span>{message || '准备开始高精度本地处理…'}</span>
            <span className="font-medium text-primary">{Math.round(Math.min(100, overallPercent))}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.min(100, overallPercent)}%` }} />
          </div>
          <div className="mt-6 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
            <span className={progress ? 'text-foreground' : ''}>① 高清预处理</span>
            <span className={progress?.stage === 'layout' ? 'text-foreground' : ''}>② 版面分析</span>
            <span className={progress?.stage === 'segment' ? 'text-foreground' : ''}>③ 字符分割</span>
            <span className={recognitionProgress ? 'text-foreground' : ''}>④ 深度识别与复核</span>
          </div>
          {recognitionProgress && (
            <p className="mt-4 rounded-lg bg-primary/5 p-3 text-xs leading-5 text-primary">
              正在对每个字符执行多裁剪、多方向识别和结果投票。该步骤会主动放慢处理速度，以减少断笔、粘连和异体字误判；完成后仍会把低置信字符保留在校对面板中。
            </p>
          )}
          {message.startsWith('处理失败') && (
            <Button className="mt-6" onClick={() => void handleBatch()}>重试</Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">本地分析与识别</h1>
        <p className="mt-1 text-sm text-muted-foreground">上传资料后，系统会自动使用高精度本地模式处理；你只需要等待当前步骤完成。</p>
      </div>
      <div className="rounded-2xl border bg-card p-4 shadow-soft">
        <div className="grid gap-3 md:grid-cols-5">
          {workflow.map((step, index) => {
            const done = activeStep > index;
            const active = activeStep === index;
            return (
              <div key={step.key} className="relative flex items-start gap-2 md:block">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? 'bg-emerald-600 text-white' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                  {done ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <div className="md:mt-2">
                  <p className={`text-sm font-medium ${active ? 'text-foreground' : 'text-muted-foreground'}`}>{step.label}</p>
                  <p className="text-xs text-muted-foreground">{active && busy ? '正在处理…' : step.hint}</p>
                </div>
                {index < workflow.length - 1 && <ChevronRight className="absolute right-1 top-2 hidden h-4 w-4 text-muted-foreground md:block" />}
              </div>
            );
          })}
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all duration-500" style={{ width: `${Math.min(100, (activeStep / (workflow.length - 1)) * 100)}%` }} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={page?.id ?? ''}
          onChange={(e) => setCurrentPage(e.target.value)}
          options={pages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}（${p.status}）` }))}
          className="w-72"
          aria-label="选择页面"
        />
        <Button onClick={() => void handleRunAll()} disabled={busy || !page}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          重新运行高精度本地分析
        </Button>
        {page && page.status === 'analyzed' && (
          <Button variant="secondary" onClick={() => document.getElementById('recognize-step')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            下一步：字符识别 →
          </Button>
        )}
        <Button variant="ghost" onClick={() => setView('editor')} disabled={!page || page.status === 'analyzed' || page.chars.length === 0}>
          前往校对 →
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* 固定高精度策略说明 */}
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">高精度本地模式</div>
          <p className="text-xs leading-5 text-muted-foreground">系统自动使用 Sauvola 局部二值化、OpenCV 增强和自动去斜。PDF 按 300 DPI 渲染；未知 DPI 的扫描图按 v7 的 10 px/mm 标定，保持网页画布与 Scribus 坐标一致。</p>
          <div className="rounded bg-primary/5 p-3 text-xs leading-5 text-primary">本地处理：图像不会上传。系统会对每个字符进行多裁剪、多方向识别与投票复核，再进入结果画布校对。</div>
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
                {progress.stage === 'deskew' ? '预处理' : progress.stage === 'layout' ? '版面分析' : '字符分割'} {progress.percent}%
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
