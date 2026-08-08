/**
 * 分析页：后台自动批处理（预处理 → 版面 → 分割 → 识别），仅展示简洁进度，完成后跳转结果画布。
 */
import { useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { calibratePage } from '@/calibrate/calibrate';
import { pageMmFromPx } from '@/calibrate/calibrate';
import { applyColumnStructure } from '@/segment/columns';
import { mergeLayoutWithGuide, finalizeTagRects } from '@/layout/applyGuide';
import { filterSolidGraphicRects } from '@/layout/graphicBlock';
import { detectTreeLines } from '@/layout/detect';
import { detectArtifacts, detectNodes } from '@/layout/nodes';
import { pagesForBatchProcessing, batchProcessingSignature, inferPageRecognitionSettingsKey } from '@/lib/utils';
import { PDF_STROKE_DILATE_RADIUS } from '@/lib/constants';
import type { BorderLayoutGuide, Page } from '@/model/types';
import { getBinaryImage, getPageImageData, putBinaryImage } from '@/storage/opfs';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { PipelineAPI, ProgressInfo } from '@/workers/pipeline.worker';
import { recognizePage } from '@/recognize/orchestrator';
import { buildProviderConfig, currentRecognitionSettingsKey, describeActiveModel, isLocalRecognitionMode, resolveRecognitionMode } from '@/recognize/buildConfig';
import { analyzeBorderLayoutVision, canUseVisionLayout, formatVisionFallbackMessage } from '@/recognize/layoutVision';
import type { RecognizeProgress } from '@/recognize/types';
import { grantConsent, hasConsented } from '@/privacy/consent';

function createPipeline(): { worker: Worker; api: Comlink.Remote<PipelineAPI> } {
  const worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('error', (event) => {
    console.error('[pipeline-worker]', event.message || event);
  });
  worker.addEventListener('messageerror', (event) => {
    console.error('[pipeline-worker messageerror]', event);
  });
  return { worker, api: Comlink.wrap<PipelineAPI>(worker) };
}

/** 单页四阶段权重：预处理 25% · 版面 25% · 分割 20% · 识别 30% */
const PAGE_PHASE = { preprocess: 0.25, layout: 0.25, segment: 0.2, recognition: 0.3 } as const;

/** 将当前页内进度（0–1）换算为批处理总进度（0–100），保证换页时不回退。 */
function computeBatchOverallPercent(
  batch: { totalPages: number; currentPageIndex: number; phaseBase: number } | null,
  progress: ProgressInfo | null,
  recognitionProgress: RecognizeProgress | null,
): number {
  if (!batch || batch.totalPages <= 0) return 3;

  const { totalPages, currentPageIndex, phaseBase } = batch;
  const pipelineDone = PAGE_PHASE.preprocess + PAGE_PHASE.layout + PAGE_PHASE.segment;
  let pageFraction = phaseBase;

  if (recognitionProgress) {
    const recRatio =
      recognitionProgress.totalBatches > 0
        ? recognitionProgress.doneBatches / recognitionProgress.totalBatches
        : recognitionProgress.totalChars > 0
          ? recognitionProgress.recognizedChars / recognitionProgress.totalChars
          : 0;
    const base = phaseBase > 0 ? phaseBase : pipelineDone;
    pageFraction = base + PAGE_PHASE.recognition * Math.min(1, recRatio);
  } else if (progress) {
    const pct = progress.percent / 100;
    switch (progress.stage) {
      case 'deskew':
      case 'binarize':
      case 'denoise':
        pageFraction = phaseBase + PAGE_PHASE.preprocess * pct;
        break;
      case 'layout':
        pageFraction = phaseBase + PAGE_PHASE.preprocess + PAGE_PHASE.layout * pct;
        break;
      case 'segment':
        pageFraction = phaseBase + PAGE_PHASE.preprocess + PAGE_PHASE.layout + PAGE_PHASE.segment * pct;
        break;
      default:
        break;
    }
  } else if (phaseBase > 0) {
    pageFraction = phaseBase;
  }

  pageFraction = Math.min(1, Math.max(phaseBase, pageFraction));
  const raw = ((currentPageIndex + pageFraction) / totalPages) * 100;
  return Math.min(100, Math.max(0, raw));
}

function recognitionOnlyPhaseBase(): number {
  return PAGE_PHASE.preprocess + PAGE_PHASE.layout + PAGE_PHASE.segment;
}

export default function AnalyzePage() {
  const { pages, currentProjectId, currentPageId, setCurrentPage, updatePage, setView } = useProjectStore();
  const { setBatchQueue, updateBatchTask } = useSettingsStore();
  const page: Page | undefined = pages.find((p) => p.id === currentPageId) ?? pages[0];

  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [recognitionProgress, setRecognitionProgress] = useState<RecognizeProgress | null>(null);
  const [message, setMessage] = useState('');
  const [batchProgress, setBatchProgress] = useState<{ totalPages: number; currentPageIndex: number; phaseBase: number } | null>(null);
  const [lastBatchError, setLastBatchError] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const pipelineRef = useRef<ReturnType<typeof createPipeline> | null>(null);
  const batchStartedRef = useRef<string>('');
  const recognitionSettingsKey = currentRecognitionSettingsKey();
  const cloudMode = !isLocalRecognitionMode();
  const recognizeMode = resolveRecognitionMode();
  const needsCloudConsent = cloudMode && !hasConsented(recognizeMode);
  const pendingCount = pagesForBatchProcessing(pages, recognitionSettingsKey).length;

  const getPipeline = () => {
    if (!pipelineRef.current) pipelineRef.current = createPipeline();
    return pipelineRef.current;
  };
  useEffect(() => () => pipelineRef.current?.worker.terminate(), []);

  /** ① 预处理：原图 → 去斜/二值化/去噪/DPI 归一 → binary 存 OPFS + calibration 锁定 */
  const runPreprocess = async (target: Page): Promise<Uint8Array | null> => {
    setProgress({ stage: 'deskew', percent: 0 });
    setMessage('高清预处理：去斜、二值化、去噪…');
    const image = await getPageImageData(target.imageKey);
    if (!image) {
      setMessage('找不到原图（可能从 .zpproj 导入后尚未重新关联图像）');
      return null;
    }
    const { api } = getPipeline();
    const isPdfSource = target.source.dpi > 0;
    const result = await api.preprocess(
      image,
      {
        targetDpi: isPdfSource ? target.source.dpi : 254,
        sourceDpi: isPdfSource ? target.source.dpi : undefined,
        binarizer: 'sauvola',
        // 禁用 Worker 内 OpenCV 懒加载：10MB WASM 在部分静态托管/CDN 环境会永久挂起（进度卡在 ~11%）
        useOpenCV: false,
        strokeDilate: isPdfSource ? PDF_STROKE_DILATE_RADIUS : 0,
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

  /** ② 版面分析 + 字符分割 + 自动标定（可选：视觉模型先出边框规则再合并） */
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
    const mode = resolveRecognitionMode();
    let borderLayoutGuide: BorderLayoutGuide | undefined;

    // ① 本地 CV 版面分析（始终执行，不依赖云端）
    setProgress({ stage: 'layout', percent: 5 });
    setMessage('本地版面分析：外框、谱系线、节点…');
    const localLayout = await api.analyze(bin as Uint8Array, w, h, Comlink.proxy((p: ProgressInfo) => setProgress(p)));

    let borderRects = localLayout.borderRects;
    let tagRects = localLayout.tagRects;
    let treeLines = localLayout.treeLines;
    let treeNodes = localLayout.treeNodes;
    let artifacts = localLayout.artifacts;

    // ② 可选：使用设置中已选云端模型辅助校正边框
    if (!isLocalRecognitionMode(mode) && hasConsented(mode)) {
      try {
        const { cfg } = await buildProviderConfig();
        if (!canUseVisionLayout(cfg, mode)) throw new Error('skip-vision');
        const modelLabel = describeActiveModel(cfg);
        setMessage(`视觉边框分析（${modelLabel}）…`);
        const vision = await analyzeBorderLayoutVision(
          bin as Uint8Array,
          w,
          h,
          { borderRects, tagRects },
          cfg,
          mode,
          (p) => {
            const pct = p.stage === 'encode' ? 55 : p.stage === 'vision' ? 72 : p.stage === 'done' ? 95 : 60;
            setProgress({ stage: 'layout', percent: pct });
            if (p.message) setMessage(p.message);
          },
        );
        borderLayoutGuide = vision.guide;
        setMessage(`边框规则：${vision.guide.summary.slice(0, 80)}${vision.guide.summary.length > 80 ? '…' : ''}`);
      } catch (err) {
        if (err instanceof Error && err.message !== 'skip-vision') {
          console.warn('[layout-vision]', err);
          setMessage(formatVisionFallbackMessage(err));
        }
      }
    } else if (isLocalRecognitionMode(mode)) {
      setMessage('本地模式：跳过云端视觉边框，继续字符分割…');
    }

    // ③ 按视觉规则文档合并 & 重算谱系线
    if (borderLayoutGuide) {
      const merged = mergeLayoutWithGuide(
        bin as Uint8Array,
        w,
        h,
        { borderRects, tagRects, rectMask: new Uint8Array((bin as Uint8Array).length) },
        borderLayoutGuide,
      );
      borderRects = merged.borderRects;
      tagRects = merged.tagRects;
      treeLines = detectTreeLines(bin as Uint8Array, w, h, merged.rectMask);
      treeNodes = detectNodes(bin as Uint8Array, w, h, treeLines);
      artifacts = detectArtifacts(bin as Uint8Array, w, h, treeLines);
    }

    // ④ 装饰块与文字分流：剔除误分为黑块的文字区
    tagRects = filterSolidGraphicRects(tagRects, bin as Uint8Array, w, h);
    const probeChars = await api.segment(bin as Uint8Array, w, h, treeLines, borderRects);
    tagRects = finalizeTagRects(tagRects, probeChars, bin as Uint8Array, w, h);

    setProgress({ stage: 'segment', percent: 50 });
    const segmented = await api.segment(
      bin as Uint8Array,
      w,
      h,
      treeLines,
      [...borderRects, ...tagRects],
      borderRects,
    );
    const structured = applyColumnStructure(segmented);
    const calibrated = calibratePage(
      { ...target, chars: structured, calibration: { ...target.calibration, pxPerMm: target.calibration.pxPerMm } },
      undefined,
      { data: bin as Uint8Array, width: w, height: h },
    );
    updatePage(target.id, {
      borderRects,
      tagRects,
      treeLines,
      treeNodes,
      artifacts,
      borderLayoutGuide,
      chars: calibrated.chars,
      fontSizes: calibrated.fontSizes,
      status: 'analyzed',
    });
    setProgress({ stage: 'segment', percent: 100 });
    setMessage(
      `分析完成：外框 ${borderRects.length}${borderLayoutGuide ? '（含视觉规则）' : ''}，连线 ${treeLines.length}，节点 ${treeNodes.length}，字符 ${structured.length}`,
    );
  };

  const runRecognition = async (target: Page): Promise<void> => {
    const stored = await getBinaryImage(target.binaryKey);
    if (!stored) throw new Error('找不到预处理结果，无法开始识别');
    const settings = useSettingsStore.getState();
    const mode = resolveRecognitionMode();
    const { cfg } = await buildProviderConfig();
    if (!isLocalRecognitionMode(mode) && !hasConsented(mode)) {
      throw new Error('请先勾选同意云端识别，或在设置中保存 API Key');
    }
    setRecognitionProgress({
      totalBatches: mode === 'C' ? 10 : Math.max(1, Math.ceil(target.chars.length / 12)),
      doneBatches: 0,
      failedBatches: 0,
      recognizedChars: 0,
      totalChars: target.chars.length,
      costCny: 0,
      message: isLocalRecognitionMode(mode)
        ? '本地 OCR 初始化中（首次加载字典需数十秒）…'
        : mode === 'C'
          ? '正在编码整页图像…'
          : '正在识别…',
    });
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
        provider: cfg.provider,
        model: cfg.model,
        batches: result.outcome.batches,
        costEstimateCny: result.outcome.costCny,
        settingsKey: currentRecognitionSettingsKey(),
      },
    });
    settings.addSessionCost(result.outcome.costCny);
  };

  /** 批处理：顺序处理待完成页；切换识别模式后自动重跑识别阶段 */
  const handleBatch = async (options: { force?: boolean } = {}) => {
    if (busy) return;
    const pendingPages = pagesForBatchProcessing(pages, recognitionSettingsKey);
    if (pendingPages.length === 0) return;

    const sig = `${batchProcessingSignature(pages, recognitionSettingsKey)}:${recognitionSettingsKey}`;
    if (!options.force && batchStartedRef.current === sig) return;
    batchStartedRef.current = sig;

    setBusy(true);
    setLastBatchError(null);
    setBatchQueue(pendingPages.map((p) => ({ pageId: p.id, status: 'pending' })));
    setBatchProgress({ totalPages: pendingPages.length, currentPageIndex: 0, phaseBase: 0 });

    if (!isLocalRecognitionMode()) {
      const mode = resolveRecognitionMode();
      if (!hasConsented(mode)) {
        const errMsg = '请先勾选同意云端识别，或在右上角设置中配置 API Key';
        setLastBatchError(errMsg);
        setMessage(`处理失败：${errMsg}`);
        setBusy(false);
        setBatchProgress(null);
        batchStartedRef.current = '';
        return;
      }
      try {
        await buildProviderConfig();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setLastBatchError(errMsg);
        setMessage(`处理失败：${errMsg}`);
        setBusy(false);
        setBatchProgress(null);
        batchStartedRef.current = '';
        return;
      }
    }

    let ok = 0;
    let fail = 0;
    let lastError: string | null = null;

    for (let pageIdx = 0; pageIdx < pendingPages.length; pageIdx++) {
      const p = pendingPages[pageIdx];
      updateBatchTask(p.id, { status: 'running' });
      setCurrentPage(p.id);
      setProgress(null);
      setRecognitionProgress(null);
      setMessage(`正在处理第 ${pageIdx + 1}/${pendingPages.length} 页：${p.source.name}`);
      try {
        let analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        const localMode = isLocalRecognitionMode();
        const needsPreprocess = analyzed.status === 'imported' || !analyzed.binaryKey;
        const needsAnalyze =
          analyzed.status === 'imported'
          || analyzed.status === 'preprocessed'
          || (analyzed.status === 'analyzed' && analyzed.chars.length === 0);
        const needsRecognition =
          analyzed.chars.length === 0
          || analyzed.status === 'analyzed'
          || inferPageRecognitionSettingsKey(analyzed) !== recognitionSettingsKey;
        const recognitionOnly = !needsPreprocess && !needsAnalyze && needsRecognition;

        setBatchProgress({
          totalPages: pendingPages.length,
          currentPageIndex: pageIdx,
          phaseBase: recognitionOnly ? recognitionOnlyPhaseBase() : 0,
        });

        let bin: Uint8Array | null = null;
        if (needsPreprocess) {
          if (localMode) setMessage(`本地模式 · 预处理第 ${pageIdx + 1}/${pendingPages.length} 页…`);
          bin = await runPreprocess(analyzed);
          if (!bin) throw new Error('找不到原图，请返回导入页重新上传');
          analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        } else if (needsAnalyze) {
          const stored = await getBinaryImage(analyzed.binaryKey);
          if (stored) bin = stored.bin;
          else {
            bin = await runPreprocess(analyzed);
            if (!bin) throw new Error('找不到原图，请返回导入页重新上传');
          }
          analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        }

        if (needsAnalyze) {
          if (!bin) {
            const stored = await getBinaryImage(analyzed.binaryKey);
            if (!stored) throw new Error('找不到预处理结果，请重新运行预处理');
            bin = stored.bin;
          }
          await runAnalyze(analyzed, bin);
          analyzed = useProjectStore.getState().pages.find((x) => x.id === p.id)!;
        }

        if (analyzed.chars.length > 0 && needsRecognition) {
          setBatchProgress({
            totalPages: pendingPages.length,
            currentPageIndex: pageIdx,
            phaseBase: recognitionOnly ? recognitionOnlyPhaseBase() : 0,
          });
          setMessage(
            localMode
              ? `本地 OCR 识别第 ${pageIdx + 1}/${pendingPages.length} 页（${analyzed.chars.length} 字）…`
              : `正在识别第 ${pageIdx + 1}/${pendingPages.length} 页：${p.source.name}`,
          );
          await runRecognition(analyzed);
        } else if (analyzed.chars.length === 0) {
          throw new Error('未分割到字符，请检查图像质量或手动调整分析参数');
        }
        updateBatchTask(p.id, { status: 'done' });
        ok++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;
        updateBatchTask(p.id, { status: 'failed', error: errMsg });
        setMessage(`处理失败：${errMsg}`);
        fail++;
      }
    }

    setBatchProgress({ totalPages: pendingPages.length, currentPageIndex: pendingPages.length, phaseBase: 0 });
    if (fail > 0) {
      setLastBatchError(lastError);
      setMessage(`批处理完成：成功 ${ok} 页，失败 ${fail} 页（失败页可单独重试）`);
      batchStartedRef.current = '';
    } else {
      setMessage(`批处理完成：成功 ${ok} 页`);
    }
    setBusy(false);
    setBatchProgress(null);
    if (fail === 0) setView('editor');
  };

  const retryBatch = () => {
    batchStartedRef.current = '';
    void handleBatch({ force: true });
  };

  const startWithConsent = () => {
    grantConsent(recognizeMode);
    retryBatch();
  };

  useEffect(() => {
    if (pendingCount === 0) {
      if (pages.length > 0) setView('editor');
      return;
    }
    if (!page || needsCloudConsent) return;
    void handleBatch();
  }, [currentProjectId, pages, recognitionSettingsKey, pendingCount, needsCloudConsent]);

  const overallPercent = busy
    ? computeBatchOverallPercent(batchProgress, progress, recognitionProgress)
    : lastBatchError
      ? 0
      : needsCloudConsent
        ? 0
        : 0;

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
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center justify-center px-4 py-10">
      <div className="w-full rounded-2xl border bg-card p-6 shadow-soft sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
          </div>
          <div>
            <h1 className="text-xl font-semibold">{busy ? '正在处理资料' : '准备处理资料'}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLocalRecognitionMode()
                ? '本地模式：图像不出本机，完成后自动进入结果画布。'
                : '整页图像将调用已配置的 API 识别，完成后自动进入结果画布。'}
            </p>
          </div>
        </div>

        {needsCloudConsent && !busy ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              使用云端识别（模式 C · 整页上云）前，请确认您了解整页图像将发送至所选 API 提供商。
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              我已了解并同意本次会话使用云端识别
            </label>
            <Button disabled={!consentChecked} onClick={startWithConsent}>
              同意并开始
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {message || (busy ? '正在自动分析和识别…' : lastBatchError ? `处理失败：${lastBatchError}` : '等待开始…')}
              </span>
              {busy && <span className="shrink-0 font-medium text-primary">{Math.round(overallPercent)}%</span>}
            </div>
            {busy && (
              <div className="h-3 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${overallPercent}%` }} />
              </div>
            )}
            {lastBatchError && !busy && (
              <Button className="mt-4" onClick={retryBatch}>
                重试
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
