/**
 * 结果画布（F6.x）：单一结果画布优先，原图/叠加比对作为辅助视图，
 * 叠加模式（红/蓝/黑，透明度可调）、标定面板（F5.5 公式可见、字号可人工覆盖）、
 * 撤销/重做、低置信面板、全键盘操作（F6.9）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, ClipboardPaste, Copy, Eye, FileImage, FileText, Loader2, Redo2, Undo2, UserRoundPlus } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { Slider } from '@/ui/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { medianPtAllChars } from '@/calibrate/calibrate';
import type { BorderRect, CharItem, Page, TagRect, TreeLine, TreeNode } from '@/model/types';
import { getBinaryImage, getImageBitmap } from '@/storage/opfs';
import { countMemoryRecords } from '@/storage/db';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { ptToPx, renderPreviewBinary } from '@/verify/preview';
import { exportProofreadPdf, exportProofreadPagePdf, exportProofreadPng, exportProofreadPngZip } from '@/export/proofreadExport';
import { ExportPreviewScroller } from '@/ui/ExportPreviewScroller';
import {
  availableExportModes,
  defaultExportMode,
  exportModeDescription,
  exportModeLabel,
  getExportablePages,
  type ExportMode,
} from '@/export/exportModes';
import { uuid } from '@/lib/utils';
import LowConfPanel, { useLowConfChars } from './LowConfPanel';
import ProofreadCanvas from './ProofreadCanvas';
import { drawSelectionOverlay, computeFitCenterTransform, setCharsBboxSize } from '@/ui/canvasOverlay';

type Point = { x: number; y: number };
type RectBounds = { left: number; top: number; right: number; bottom: number };

function rectsOverlap(a: RectBounds, b: RectBounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 在已有字符之间寻找可完整容纳新增姓名的空白位置。 */
function findEmptyNamePosition(
  page: Page,
  glyphCount: number,
  orientation: 'v' | 'h',
  boxSize: number,
  step: number,
): Point | null {
  const edgePadding = Math.max(8, boxSize * 0.4);
  const charPadding = Math.max(6, boxSize * 0.3);
  const nameWidth = orientation === 'h' ? boxSize + step * (glyphCount - 1) : boxSize;
  const nameHeight = orientation === 'v' ? boxSize + step * (glyphCount - 1) : boxSize;
  const minX = edgePadding + nameWidth / 2;
  const maxX = page.source.widthPx - edgePadding - nameWidth / 2;
  const minY = edgePadding + nameHeight / 2;
  const maxY = page.source.heightPx - edgePadding - nameHeight / 2;
  if (minX > maxX || minY > maxY) return null;

  const occupied = page.chars.map((char) => ({
    left: char.bbox[0] - charPadding,
    top: char.bbox[1] - charPadding,
    right: char.bbox[2] + charPadding,
    bottom: char.bbox[3] + charPadding,
  }));
  const scanStep = Math.max(8, Math.min(boxSize / 2, 24));
  const centerX = page.source.widthPx / 2;
  const centerY = page.source.heightPx / 2;
  const candidates: Array<Point & { distance: number }> = [];

  for (let y = minY; y <= maxY + 0.01; y += scanStep) {
    for (let x = minX; x <= maxX + 0.01; x += scanStep) {
      const bounds = {
        left: x - nameWidth / 2,
        top: y - nameHeight / 2,
        right: x + nameWidth / 2,
        bottom: y + nameHeight / 2,
      };
      if (occupied.some((rect) => rectsOverlap(bounds, rect))) continue;
      candidates.push({ x, y, distance: Math.hypot(x - centerX, y - centerY) });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  return {
    x: best.x - (orientation === 'h' ? step * (glyphCount - 1) / 2 : 0),
    y: best.y - (orientation === 'v' ? step * (glyphCount - 1) / 2 : 0),
  };
}
/** 左侧原图画布：与右侧共享 transform，同步显示选区（F6.1） */
function OriginalCanvas({ page, focusCharId = null }: { page: Page; focusCharId?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transform = useEditorStore((s) => s.transform);
  const setTransform = useEditorStore((s) => s.setTransform);
  const selectedCharIds = useEditorStore((s) => s.selectedCharIds);
  const selectedLineIds = useEditorStore((s) => s.selectedLineIds);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const selectedRectIds = useEditorStore((s) => s.selectedRectIds);
  const rubberBand = useEditorStore((s) => s.rubberBand);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = size.w;
    canvas.height = size.h;
    void (async () => {
      const bmp = await getImageBitmap(page.imageKey);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ebe8e2';
      ctx.fillRect(0, 0, size.w, size.h);
      if (!bmp) {
        ctx.fillStyle = '#78716c';
        ctx.font = '14px sans-serif';
        ctx.fillText('原图缺失（.zpproj 导入的项目需重新导入图像）', 20, 40);
        return;
      }
      ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
      ctx.drawImage(bmp, 0, 0);
      drawSelectionOverlay(
        ctx,
        page,
        { selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds, rubberBand },
        transform.scale,
        { showLowConf: false, showRubber: true, focusCharId },
      );
      bmp.close();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    })();
  }, [page, page.imageKey, transform, size, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds, rubberBand, focusCharId]);

  return (
    <div ref={containerRef} className="canvas-noselect relative h-full w-full overflow-hidden bg-[#ebe8e2]">
      <canvas
        ref={ref}
        className="absolute inset-0"
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const rect = ref.current!.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const newScale = Math.min(4, Math.max(0.02, transform.scale * factor));
          const k = newScale / transform.scale;
          setTransform({ scale: newScale, offsetX: mx - (mx - transform.offsetX) * k, offsetY: my - (my - transform.offsetY) * k });
        }}
        onMouseDown={(e) => {
          const startX = e.clientX;
          const startY = e.clientY;
          const ox = transform.offsetX;
          const oy = transform.offsetY;
          const move = (ev: MouseEvent) => setTransform({ offsetX: ox + ev.clientX - startX, offsetY: oy + ev.clientY - startY });
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
    </div>
  );
}

/** 叠加模式画布：原图独有红、重建独有蓝、重合黑，透明度可调（F6.2） */
function OverlayCanvas({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { transform, overlayOpacity, setTransform } = useEditorStore();
  const lastFitRef = useRef({ pageId: '', w: 0, h: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [diffUrl, setDiffUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    const last = lastFitRef.current;
    const pageChanged = last.pageId !== page.id;
    const sizeChanged =
      last.w <= 0 ||
      Math.abs(size.w - last.w) / last.w > 0.06 ||
      Math.abs(size.h - last.h) / last.h > 0.06;
    if (!pageChanged && !sizeChanged) return;
    lastFitRef.current = { pageId: page.id, w: size.w, h: size.h };
    setTransform(
      computeFitCenterTransform(page.source.widthPx, page.source.heightPx, size.w, size.h, { mode: 'contain' }),
    );
  }, [page.id, page.source.widthPx, page.source.heightPx, size.w, size.h, setTransform]);

  useEffect(() => {
    void (async () => {
      const stored = await getBinaryImage(page.binaryKey);
      if (!stored) {
        setDiffUrl(null);
        return;
      }
      const recon = renderPreviewBinary(page);
      const canvas = document.createElement('canvas');
      canvas.width = stored.width;
      canvas.height = stored.height;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(stored.width, stored.height);
      for (let i = 0, j = 0; j < stored.bin.length; i += 4, j++) {
        const o = stored.bin[j];
        const r = recon[j];
        let v = [255, 255, 255];
        if (o && r) v = [0, 0, 0];
        else if (o) v = [220, 38, 38];
        else if (r) v = [37, 99, 235];
        img.data[i] = v[0];
        img.data[i + 1] = v[1];
        img.data[i + 2] = v[2];
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      setDiffUrl(canvas.toDataURL('image/png'));
    })();
  }, [page]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !diffUrl) return;
    canvas.width = size.w;
    canvas.height = size.h;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#e7e5e4';
      ctx.fillRect(0, 0, size.w, size.h);
      ctx.globalAlpha = overlayOpacity;
      ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
      ctx.drawImage(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    };
    img.src = diffUrl;
  }, [diffUrl, transform, size, overlayOpacity]);

  return (
    <div ref={containerRef} className="canvas-noselect relative h-full w-full overflow-hidden">
      <canvas ref={ref} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
        叠加：红=原图独有 蓝=重建独有 黑=重合
      </div>
    </div>
  );
}

type CanvasClipboard =
  | { kind: 'chars'; items: CharItem[] }
  | { kind: 'line'; item: TreeLine }
  | { kind: 'node'; item: TreeNode }
  | { kind: 'rect'; item: BorderRect | TagRect; rectKind: 'border' | 'tag' };

interface NameDraft {
  text: string;
  orientation: 'v' | 'h';
  pt: number;
  spacing: number;
}

export default function EditorPage() {
  const { pages, currentPageId, setCurrentPage, updatePage, setView, currentProject } = useProjectStore();
  const page: Page | undefined = pages.find((p) => p.id === currentPageId) ?? pages[0];
  const project = currentProject();
  const exportModes = availableExportModes(pages);
  const {
    overlayMode,
    setOverlayMode,
    overlayOpacity,
    setOverlayOpacity,
    loadStacks,
    undo,
    redo,
    canUndo,
    canRedo,
    selectedCharIds,
    selectedLineIds,
    selectedNodeIds,
    selectedRectIds,
    apply,
    setLowConfCursor,
    lowConfCursor,
    setSelection,
    setRegionSelection,
    setSelectedLine,
    setSelectedNode,
    setSelectedRect,
    setTransform,
    transform,
    centerOnChar,
    lowConfHoverId,
    setLowConfHoverId,
    showRulers,
    setShowRulers,
  } = useEditorStore();
  const [showLowConf, setShowLowConf] = useState(true);
  const [selectionPt, setSelectionPt] = useState('');
  const [selectionBoxW, setSelectionBoxW] = useState('');
  const [selectionBoxH, setSelectionBoxH] = useState('');
  const [memoryCount, setMemoryCount] = useState(0);
  const [canvasExporting, setCanvasExporting] = useState<'png' | 'pdf' | null>(null);
  const [canvasExportMessage, setCanvasExportMessage] = useState('');
  const [exportMode, setExportMode] = useState<ExportMode>(() => defaultExportMode(pages));
  const [clipboard, setClipboard] = useState<CanvasClipboard | null>(null);
  const [showAddName, setShowAddName] = useState(false);
  const [nameDraft, setNameDraft] = useState<NameDraft>({ text: '', orientation: 'v', pt: 12, spacing: 1 });
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const previewGenRef = useRef(0);
  const [actionHint, setActionHint] = useState('');
  const [lowConfWidth, setLowConfWidth] = useState(288);
  const lowConfResizeRef = useRef<{ startX: number; startW: number } | null>(null);

  const showActionHint = useCallback((text: string) => setActionHint(text), []);

  const startLowConfResize = (e: React.PointerEvent<HTMLDivElement>) => {
    lowConfResizeRef.current = { startX: e.clientX, startW: lowConfWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveLowConfResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!lowConfResizeRef.current) return;
    const delta = lowConfResizeRef.current.startX - e.clientX;
    setLowConfWidth(Math.min(560, Math.max(220, lowConfResizeRef.current.startW + delta)));
  };

  const endLowConfResize = (e: React.PointerEvent<HTMLDivElement>) => {
    lowConfResizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const exportablePages = useMemo(() => getExportablePages(pages), [pages]);
  const lowConf = useLowConfChars(page);
  const lowConfFocusId = showLowConf ? (lowConfHoverId ?? lowConf[lowConfCursor]?.id ?? null) : null;
  const hasSelection =
    selectedCharIds.length > 0 ||
    selectedLineIds.length > 0 ||
    selectedNodeIds.length > 0 ||
    selectedRectIds.length > 0;

  const copySelection = useCallback(() => {
    if (!page) return;
    if (selectedCharIds.length > 0) {
      const items = selectedCharIds
        .map((id) => page.chars.find((char) => char.id === id))
        .filter((char): char is CharItem => Boolean(char));
      if (items.length > 0) setClipboard({ kind: 'chars', items });
      return;
    }
    if (selectedLineIds.length > 0) {
      const item = page.treeLines.find((line) => line.id === selectedLineIds[0]);
      if (item) setClipboard({ kind: 'line', item });
      return;
    }
    if (selectedNodeIds.length > 0) {
      const item = page.treeNodes.find((node) => node.id === selectedNodeIds[0]);
      if (item) setClipboard({ kind: 'node', item });
      return;
    }
    if (selectedRectIds.length > 0) {
      const border = page.borderRects.find((rect) => rect.id === selectedRectIds[0]);
      const tag = page.tagRects.find((rect) => rect.id === selectedRectIds[0]);
      if (border) setClipboard({ kind: 'rect', item: border, rectKind: 'border' });
      else if (tag) setClipboard({ kind: 'rect', item: tag, rectKind: 'tag' });
    }
  }, [page, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds]);

  const pasteSelection = useCallback(() => {
    if (!page || !clipboard) return;
    const offset = Math.max(16, Math.round(24 / Math.max(0.25, transform.scale)));
    if (clipboard.kind === 'chars') {
      const items = clipboard.items.map((char) => ({
        ...char,
        id: uuid(),
        cx: char.cx + offset,
        cy: char.cy + offset,
        bbox: [
          char.bbox[0] + offset,
          char.bbox[1] + offset,
          char.bbox[2] + offset,
          char.bbox[3] + offset,
        ] as [number, number, number, number],
        conf: 1,
        source: 'manual' as const,
        edited: true,
      }));
      apply({ type: 'char.addMany', chars: items });
      setSelection(items.map((char) => char.id));
      setClipboard({ kind: 'chars', items });
      return;
    }
    if (clipboard.kind === 'line') {
      const item = {
        ...clipboard.item,
        id: uuid(),
        x1: clipboard.item.x1 + offset,
        y1: clipboard.item.y1 + offset,
        x2: clipboard.item.x2 + offset,
        y2: clipboard.item.y2 + offset,
      };
      apply({ type: 'line.add', line: item });
      setSelectedLine(item.id);
      setClipboard({ kind: 'line', item });
      return;
    }
    if (clipboard.kind === 'node') {
      const item = { ...clipboard.item, id: uuid(), cx: clipboard.item.cx + offset, cy: clipboard.item.cy + offset };
      apply({ type: 'node.add', node: item });
      setSelectedNode(item.id);
      setClipboard({ kind: 'node', item });
      return;
    }
    const item = { ...clipboard.item, id: uuid(), x: clipboard.item.x + offset, y: clipboard.item.y + offset };
    apply({ type: 'rect.add', rect: item, kind: clipboard.rectKind });
    setSelectedRect(item.id);
    setClipboard({ kind: 'rect', item, rectKind: clipboard.rectKind });
  }, [apply, clipboard, page, setSelectedLine, setSelectedNode, setSelectedRect, setSelection, transform.scale]);

  useEffect(() => {
    const timer = window.setTimeout(() => void countMemoryRecords().then(setMemoryCount).catch(() => undefined), 250);
    return () => window.clearTimeout(timer);
  }, [page?.id, page?.chars]);

  useEffect(() => {
    if (page) void loadStacks(page.id);
  }, [page?.id, loadStacks, page]);

  useEffect(() => {
    if (!exportModes.includes(exportMode)) {
      setExportMode(defaultExportMode(pages));
    }
  }, [pages.length, exportModes, exportMode]);

  const previewScopeKey = useMemo(() => {
    if (exportMode === 'merged-pdf' || exportMode === 'pages-png-zip') {
      return exportablePages.map((p) => p.id).join(',');
    }
    return page?.id ?? '';
  }, [exportMode, exportablePages, page?.id]);

  const previewPages = useMemo(() => {
    if (exportMode === 'merged-pdf' || exportMode === 'pages-png-zip') return exportablePages;
    return page ? [page] : [];
  }, [exportMode, exportablePages, page]);

  useEffect(() => {
    if (!showExportPreview) return;
    previewGenRef.current += 1;
    setPreviewGeneration(previewGenRef.current);
  }, [showExportPreview, exportMode, previewScopeKey]);

  const handleExportPreviewOpenChange = (open: boolean) => {
    if (!open) previewGenRef.current += 1;
    setShowExportPreview(open);
  };

  /* ---------- 全键盘操作（F6.9） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (!page) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (hasSelection) {
          e.preventDefault();
          copySelection();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        if (clipboard) {
          e.preventDefault();
          pasteSelection();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (lowConf.length > 0) {
          const next = (lowConfCursor + 1) % lowConf.length;
          const c = lowConf[next];
          setLowConfCursor(next);
          setSelection([c.id]);
          centerOnChar(c.cx, c.cy);
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!hasSelection) return;
        e.preventDefault();
        for (const id of selectedCharIds) {
          const c = page.chars.find((v) => v.id === id);
          if (c) apply({ type: 'char.remove', char: c });
        }
        for (const id of selectedLineIds) {
          const line = page.treeLines.find((value) => value.id === id);
          if (line) apply({ type: 'line.remove', line });
        }
        for (const id of selectedNodeIds) {
          const node = page.treeNodes.find((value) => value.id === id);
          if (node) apply({ type: 'node.remove', node });
        }
        for (const id of selectedRectIds) {
          const border = page.borderRects.find((value) => value.id === id);
          const tag = page.tagRects.find((value) => value.id === id);
          if (border) apply({ type: 'rect.remove', rect: border, kind: 'border' });
          else if (tag) apply({ type: 'rect.remove', rect: tag, kind: 'tag' });
        }
        setRegionSelection([], [], [], []);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (e.key in dirs && (selectedCharIds.length > 0 || selectedLineIds.length > 0 || selectedNodeIds.length > 0 || selectedRectIds.length > 0)) {
        e.preventDefault();
        const [dx, dy] = dirs[e.key];
        if (selectedCharIds.length > 0) apply({ type: 'char.batchMove', ids: selectedCharIds, dx, dy });
        if (selectedLineIds.length > 0) apply({ type: 'line.batchMove', ids: selectedLineIds, dx, dy });
        if (selectedNodeIds.length > 0) apply({ type: 'node.batchMove', ids: selectedNodeIds, dx, dy });
        if (selectedRectIds.length > 0) apply({ type: 'rect.batchMove', ids: selectedRectIds, dx, dy });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds, lowConf, lowConfCursor, apply, undo, redo, setSelection, setRegionSelection, setSelectedLine, setSelectedNode, setSelectedRect, setLowConfCursor, centerOnChar, transform.scale, clipboard, copySelection, hasSelection, pasteSelection]);

  const selectedChars = useMemo(
    () => (page ? page.chars.filter((c) => selectedCharIds.includes(c.id)) : []),
    [page, selectedCharIds],
  );

  const selectionPtHint = useMemo(() => {
    if (selectedChars.length === 0) return null;
    const pts = selectedChars.map((c) => c.pt).filter((pt) => pt > 0);
    if (pts.length === 0) return page?.fontSizes.body || 12;
    const avg = pts.reduce((sum, pt) => sum + pt, 0) / pts.length;
    return Math.round(avg * 10) / 10;
  }, [selectedChars, page?.fontSizes.body]);

  const selectionBoxHint = useMemo(() => {
    if (selectedChars.length === 0) return null;
    const widths = selectedChars.map((c) => c.bbox[2] - c.bbox[0]);
    const heights = selectedChars.map((c) => c.bbox[3] - c.bbox[1]);
    const avg = (vals: number[]) => Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    return { w: avg(widths), h: avg(heights) };
  }, [selectedChars]);

  const globalPtHint = useMemo(() => (page ? medianPtAllChars(page.chars) : 0), [page]);

  useEffect(() => {
    if (selectionPtHint != null) setSelectionPt(String(selectionPtHint));
    else setSelectionPt('');
  }, [selectionPtHint, selectedCharIds.join(',')]);

  useEffect(() => {
    if (selectionBoxHint) {
      setSelectionBoxW(String(selectionBoxHint.w));
      setSelectionBoxH(String(selectionBoxHint.h));
    } else {
      setSelectionBoxW('');
      setSelectionBoxH('');
    }
  }, [selectionBoxHint, selectedCharIds.join(',')]);

  const setGlobalFontSize = useCallback(
    (raw: string) => {
      if (!page) return;
      const value = parseFloat(raw);
      if (!(value > 0) || page.chars.length === 0) return;
      if (page.chars.every((c) => Math.abs(c.pt - value) < 0.05)) return;
      const beforePts: Record<string, number> = {};
      for (const c of page.chars) beforePts[c.id] = c.pt;
      apply({ type: 'char.batchResize', ids: page.chars.map((c) => c.id), beforePts, pt: value });
      updatePage(page.id, { fontSizes: { body: value, title: value, pageno: value, rank: value } });
    },
    [page, updatePage, apply],
  );

  if (!page) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        没有可校对的页面。
        <div className="mt-4">
          <Button onClick={() => setView('import')}>前往导入</Button>
        </div>
      </div>
    );
  }

  const applySelectionPt = (pt: number) => {
    if (selectedCharIds.length === 0 || !(pt > 0)) return;
    const beforePts: Record<string, number> = {};
    for (const c of selectedChars) beforePts[c.id] = c.pt;
    if (selectedChars.every((c) => Math.abs(c.pt - pt) < 0.05)) return;
    apply({ type: 'char.batchResize', ids: selectedCharIds, beforePts, pt });
  };

  const handleSelectionPtChange = (raw: string) => {
    setSelectionPt(raw);
    const pt = parseFloat(raw);
    if (pt > 0) applySelectionPt(pt);
  };

  const applySelectionBbox = (width?: number, height?: number) => {
    if (selectedChars.length === 0) return;
    const w = width ?? parseFloat(selectionBoxW);
    const h = height ?? parseFloat(selectionBoxH);
    if (!(w > 0) || !(h > 0)) return;
    const before: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> = {};
    for (const c of selectedChars) {
      before[c.id] = { cx: c.cx, cy: c.cy, bbox: [...c.bbox] };
    }
    const after = setCharsBboxSize(selectedChars, w, h);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      apply({ type: 'char.batchBbox', before, after });
    }
  };

  const handleSelectionBoxWChange = (raw: string) => {
    setSelectionBoxW(raw);
    const w = parseFloat(raw);
    if (w > 0) applySelectionBbox(w, undefined);
  };

  const handleSelectionBoxHChange = (raw: string) => {
    setSelectionBoxH(raw);
    const h = parseFloat(raw);
    if (h > 0) applySelectionBbox(undefined, h);
  };

  const unifySelectionBbox = () => {
    if (!selectionBoxHint || selectedChars.length === 0) return;
    applySelectionBbox(selectionBoxHint.w, selectionBoxHint.h);
    showActionHint(`已将 ${selectedChars.length} 个字符定位框统一为 ${selectionBoxHint.w}×${selectionBoxHint.h} px`);
  };

  const scaleSelectionPt = (factor: number) => {
    if (selectedCharIds.length === 0) return;
    const beforePts: Record<string, number> = {};
    const afterPts: Record<string, number> = {};
    for (const c of selectedChars) {
      beforePts[c.id] = c.pt;
      afterPts[c.id] = Math.max(0.5, Math.round(c.pt * factor * 10) / 10);
    }
    apply({ type: 'char.batchResize', ids: selectedCharIds, beforePts, afterPts });
    const sample = afterPts[selectedCharIds[0]];
    showActionHint(`已将 ${selectedCharIds.length} 个字符字号 ×${factor}（约 ${sample} pt）`);
    if (sample) setSelectionPt(String(sample));
  };

  const bodyCharMetrics = () => {
    const bodyChars = page.chars.filter((char) => char.group === 'body');
    const source = bodyChars.length > 0 ? bodyChars : page.chars;
    const median = (values: number[], fallback: number) => {
      const valid = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
      if (valid.length === 0) return fallback;
      const middle = Math.floor(valid.length / 2);
      return valid.length % 2 === 0 ? (valid[middle - 1] + valid[middle]) / 2 : valid[middle];
    };
    const pt = median(source.map((char) => char.pt), page.fontSizes.body || 12);
    const pxPerMm = page.calibration.pxPerMm > 0 ? page.calibration.pxPerMm : page.source.dpi / 25.4 || 10;
    const fallbackHeight = Math.max(18, ptToPx(pt, pxPerMm) * 1.08);
    const boxHeight = median(source.map((char) => char.bbox[3] - char.bbox[1]), fallbackHeight);
    return { pt, boxHeight };
  };

  const openAddNameDialog = () => {
    const metrics = bodyCharMetrics();
    setNameDraft((draft) => ({ ...draft, text: '', pt: metrics.pt, spacing: 1 }));
    setShowAddName(true);
  };

  const addPersonName = () => {
    const glyphs = Array.from(nameDraft.text.replace(/\s+/g, ''));
    if (glyphs.length === 0) return;
    const metrics = bodyCharMetrics();
    const ptScale = metrics.pt > 0 ? nameDraft.pt / metrics.pt : 1;
    const boxSize = Math.max(6, metrics.boxHeight * ptScale);
    const step = boxSize * Math.max(0.8, nameDraft.spacing);

    const emptyPosition = findEmptyNamePosition(page, glyphs.length, nameDraft.orientation, boxSize, step);
    if (!emptyPosition) {
      showActionHint('当前页面没有足够的空白区域，请先移动部分字符后再新增人名');
      return;
    }
    const { x: anchorX, y: anchorY } = emptyPosition;
    const half = boxSize / 2;

    const chars: CharItem[] = glyphs.map((text, index) => {
      const cx = anchorX + (nameDraft.orientation === 'h' ? index * step : 0);
      const cy = anchorY + (nameDraft.orientation === 'v' ? index * step : 0);
      return {
        id: uuid(),
        text,
        cx,
        cy,
        bbox: [cx - half, cy - half, cx + half, cy + half],
        pt: nameDraft.pt,
        conf: 1,
        note: 'ok',
        source: 'manual',
        edited: true,
        group: 'body',
        kind: 'text',
      };
    });
    apply({ type: 'char.addMany', chars });
    setSelection(chars.map((char) => char.id));
    showActionHint('已在空白区域添加人名，可直接拖动调整位置');
    setShowAddName(false);
    setNameDraft((draft) => ({ ...draft, text: '' }));
  };

  const executeExport = async (format: 'png' | 'pdf') => {
    if (!page || exportablePages.length === 0) return;
    setCanvasExporting(format);
    setCanvasExportMessage('正在生成成果文件…');
    const baseName = project?.name ?? '校对成果';
    try {
      let filename = '';
      if (format === 'png') {
        if (exportMode === 'pages-png-zip') {
          filename = await exportProofreadPngZip(exportablePages, `${baseName}_校对成果`);
        } else {
          filename = await exportProofreadPng(page);
        }
      } else if (exportMode === 'merged-pdf' || exportMode === 'pages-png-zip') {
        filename = await exportProofreadPdf(exportablePages, `${baseName}_校对成果.pdf`);
      } else {
        filename = await exportProofreadPagePdf(page);
      }
      setCanvasExportMessage(`已生成：${filename}`);
    } catch (error) {
      setCanvasExportMessage(error instanceof Error ? error.message : '导出失败');
    } finally {
      setCanvasExporting(null);
    }
  };

  const canExportPng = exportMode === 'page-png' || exportMode === 'page-pdf' || exportMode === 'pages-png-zip';
  const canExportPdf = exportMode === 'page-png' || exportMode === 'page-pdf' || exportMode === 'merged-pdf' || exportMode === 'pages-png-zip';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="relative z-20 shrink-0 border-b bg-card shadow-soft">
        <div className="flex flex-nowrap items-center gap-3 overflow-x-auto px-3 py-2">
          <Select
            value={page.id}
            onChange={(e) => setCurrentPage(e.target.value)}
            onFocus={() => showActionHint('切换当前正在编辑的页面')}
            options={pages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}` }))}
            className="h-8 w-52 text-xs"
            aria-label="选择页面"
          />
          <span className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-9 items-center gap-1 rounded-lg border border-border/70 bg-muted/20 p-0.5" aria-label="编辑操作">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                showActionHint(canUndo() ? '撤销上一步编辑（Ctrl+Z）' : '当前没有可撤销的操作');
                undo();
              }}
              disabled={!canUndo()}
              className="h-8 w-8 p-0"
              title="撤销"
              aria-label="撤销"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                showActionHint(canRedo() ? '重做上一步撤销（Ctrl+Y）' : '当前没有可重做的操作');
                redo();
              }}
              disabled={!canRedo()}
              className="h-8 w-8 p-0"
              title="重做"
              aria-label="重做"
            >
              <Redo2 className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                showActionHint(hasSelection ? '复制选中元素（Ctrl+C）' : '请先选中字符、线段、节点或框');
                copySelection();
              }}
              disabled={!hasSelection}
              className="h-8 w-8 p-0"
              title="复制"
              aria-label="复制"
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                showActionHint(clipboard ? '粘贴到偏移位置（Ctrl+V）' : '剪贴板为空，请先复制');
                pasteSelection();
              }}
              disabled={!clipboard}
              className="h-8 w-8 p-0"
              title="粘贴"
              aria-label="粘贴"
            >
              <ClipboardPaste className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                showActionHint('批量添加竖排或横排人名，生成多个可编辑字符');
                openAddNameDialog();
              }}
              className="h-8 px-2.5"
              aria-label="新增人名"
            >
              <UserRoundPlus className="h-4 w-4" />
              <span className="hidden sm:inline">新增人名</span>
            </Button>
          </div>
          <span className="hidden h-6 w-px bg-border md:block" aria-hidden="true" />
          <div className="flex h-9 items-center gap-1 rounded-lg border border-border/70 bg-muted/20 p-0.5" aria-label="视图工具">
          <Select
              value={overlayMode}
            onChange={(e) => {
              const mode = e.target.value as 'split' | 'overlay';
              setOverlayMode(mode);
              showActionHint(
                mode === 'split'
                  ? '原图 / 结果：左右对照，左侧原图、右侧校对操作区'
                  : '差异核对：红=仅原图、蓝=仅重建、黑=重合，可调透明度',
              );
            }}
            onFocus={() =>
              showActionHint(
                overlayMode === 'split'
                  ? '原图 / 结果：左右对照，左侧原图、右侧校对操作区'
                  : '差异核对：红=仅原图、蓝=仅重建、黑=重合，可调透明度',
              )
            }
            options={[
              { value: 'split', label: '原图 / 结果' },
              { value: 'overlay', label: '差异核对' },
            ]}
            className="h-8 w-32 border-0 bg-transparent text-xs shadow-none"
            aria-label="显示模式"
          />
          {overlayMode === 'overlay' && (
            <div className="flex w-36 items-center gap-2">
              <span className="text-xs text-muted-foreground">透明度</span>
              <Slider
                value={[overlayOpacity]}
                onValueChange={([v]) => setOverlayOpacity(v)}
                onPointerDown={() => showActionHint('调节差异核对层的显示透明度')}
                min={0.1}
                max={1}
                step={0.05}
              />
            </div>
          )}
          <Button
            size="sm"
            variant={showLowConf ? 'secondary' : 'outline'}
            onClick={() => {
              const next = !showLowConf;
              setShowLowConf(next);
              if (!next) setLowConfHoverId(null);
              showActionHint(
                next
                  ? `打开低置信面板（${lowConf.length} 字），Tab 逐条跳转校对`
                  : '关闭低置信面板',
              );
            }}
          >
            低置信 {lowConf.length > 0 ? `(${lowConf.length})` : ''}
          </Button>
          <Button
            size="sm"
            variant={showRulers ? 'secondary' : 'outline'}
            onClick={() => {
              const next = !showRulers;
              setShowRulers(next);
              showActionHint(next ? '已开启校对区标尺与对齐参考线' : '已关闭校对区标尺');
            }}
            aria-pressed={showRulers}
            aria-label="标尺"
          >
            标尺
          </Button>
          </div>
          <div className="flex-1" />
          <div className="flex h-9 items-center gap-1 rounded-lg border border-border/70 bg-muted/20 p-0.5" aria-label="导出工具">
          {exportModes.length > 0 && (
            <Select
              value={exportMode}
              onChange={(e) => {
                const mode = e.target.value as ExportMode;
                setExportMode(mode);
                showActionHint(exportModeDescription(mode, exportablePages.length));
              }}
              onFocus={() => showActionHint(exportModeDescription(exportMode, exportablePages.length))}
              options={exportModes.map((mode) => ({ value: mode, label: exportModeLabel(mode) }))}
              className="h-8 w-36 border-0 bg-transparent text-xs shadow-none"
              aria-label="导出模式"
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              showActionHint('导出当前模式的校对成果为 PNG 文件');
              void executeExport('png');
            }}
            disabled={!canExportPng || page.chars.length === 0 || canvasExporting !== null}
          >
            {canvasExporting === 'png' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
            导出 PNG
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              showActionHint('导出当前模式的校对成果为 PDF 文件');
              void executeExport('pdf');
            }}
            disabled={!canExportPdf || page.chars.length === 0 || canvasExporting !== null}
          >
            {canvasExporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            导出 PDF
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              showActionHint('打开导出预览，可缩放查看或导出');
              setShowExportPreview(true);
            }}
            disabled={page.chars.length === 0 || canvasExporting !== null}
          >
            <Eye className="h-4 w-4" />
            预览
          </Button>
          </div>
        </div>
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/15 px-3 py-2 text-xs leading-normal text-muted-foreground">
          <span>已编辑 <strong className="font-medium text-foreground">{page.chars.filter((c) => c.edited).length}</strong></span>
          <span className="hidden sm:inline">·</span>
          <span className="flex items-center gap-1">
            <BrainCircuit className="h-3.5 w-3.5" />
            已学习 <strong className="font-medium text-foreground">{memoryCount}</strong> 字
          </span>
          <span className="hidden sm:inline">·</span>
          <span>已选 <strong className="font-medium text-foreground">{selectedCharIds.length + selectedLineIds.length + selectedNodeIds.length + selectedRectIds.length}</strong> 个元素</span>
          {page.chars.length > 0 && (
            <label className="flex items-center gap-1 border-l pl-3 text-foreground">
              <span className="whitespace-nowrap">本页字号</span>
              <Input
                type="number"
                step={0.5}
                min={0.5}
                value={globalPtHint || page.fontSizes.rank || page.fontSizes.body}
                onChange={(e) => setGlobalFontSize(e.target.value)}
                className="h-7 w-16 px-2 text-xs"
                aria-label="本页主文字字号 pt"
              />
              <span className="text-muted-foreground">pt</span>
            </label>
          )}
          {selectedCharIds.length > 0 && (
            <label className="flex items-center gap-1 text-foreground">
              <span className="whitespace-nowrap">选区字号</span>
              <Input
                type="number"
                step={0.5}
                min={0.5}
                value={selectionPt}
                onChange={(e) => handleSelectionPtChange(e.target.value)}
                className="h-7 w-16 px-2 text-xs"
                aria-label="选中区域字号 pt"
              />
              <span className="text-muted-foreground">pt</span>
            </label>
          )}
          <div className="ml-auto min-w-0 flex-1 text-right">
            {actionHint && (
              <span className="block truncate text-foreground" title={actionHint}>{actionHint}</span>
            )}
            {canvasExportMessage && (
              <span className="block truncate text-primary" title={canvasExportMessage}>{canvasExportMessage}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {overlayMode === 'split' ? (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col border-b md:border-b-0 md:border-r-2 md:border-primary/15">
                <div className="flex h-10 shrink-0 items-center border-b bg-[#ebe8e2] px-3 text-sm font-semibold leading-none tracking-wide text-muted-foreground">
                  原图参照
                </div>
                <div className="relative min-h-0 flex-1">
                  <OriginalCanvas page={page} focusCharId={lowConfFocusId} />
                </div>
              </div>
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#f3f1ec]">
                <div className="flex h-10 shrink-0 items-center border-b border-primary/10 bg-[#f3f1ec] px-3 text-sm font-semibold leading-none tracking-wide text-foreground">
                  校对操作区
                </div>
                <div className="relative min-h-0 flex-1">
                  <ProofreadCanvas page={page} focusCharId={lowConfFocusId} fitMode="width" />
                </div>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <OverlayCanvas page={page} />
            </div>
          )}
        </div>

        {/* 右侧栏：低置信 + 标定 */}
        {showLowConf && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="拖拽调整低置信面板宽度"
              className="z-10 w-1.5 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/35 active:bg-primary/55"
              onPointerDown={startLowConfResize}
              onPointerMove={moveLowConfResize}
              onPointerUp={endLowConfResize}
              onPointerCancel={endLowConfResize}
            />
            <div className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l bg-[#f7f5f1]" style={{ width: lowConfWidth }}>
              {selectedCharIds.length > 0 && (
                <details className="group hidden shrink-0 border-b border-stone-300/80">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 bg-stone-100/90 px-3 py-2 text-xs font-semibold text-stone-800 marker:content-none">
                    <span>选中区域定位（{selectedCharIds.length} 字）</span>
                    <span className="font-normal tabular-nums text-stone-500">
                      {selectionBoxW}×{selectionBoxH} px
                      <span className="ml-2 inline-block transition-transform group-open:rotate-180">⌄</span>
                    </span>
                  </summary>
                  <div className="space-y-2 px-3 py-2 text-xs text-stone-600">
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="min-w-0 rounded-md border border-stone-200/90 bg-white/70 px-2 py-1">
                        <span className="block text-[11px] text-stone-500">框宽 px</span>
                        <Input
                          type="number"
                          step={1}
                          min={6}
                          value={selectionBoxW}
                          onChange={(e) => handleSelectionBoxWChange(e.target.value)}
                          className="h-7 w-full min-w-0 border-0 bg-transparent px-0 text-xs shadow-none"
                          aria-label="定位框宽度 px"
                        />
                      </label>
                      <label className="min-w-0 rounded-md border border-stone-200/90 bg-white/70 px-2 py-1">
                        <span className="block text-[11px] text-stone-500">框高 px</span>
                        <Input
                          type="number"
                          step={1}
                          min={6}
                          value={selectionBoxH}
                          onChange={(e) => handleSelectionBoxHChange(e.target.value)}
                          className="h-7 w-full min-w-0 border-0 bg-transparent px-0 text-xs shadow-none"
                          aria-label="定位框高度 px"
                        />
                      </label>
                    </div>
                    {selectedCharIds.length > 1 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-full border-stone-200/90 bg-white/70 px-2 text-[11px] text-stone-700"
                        onClick={unifySelectionBbox}
                        title="统一选中字符的定位框尺寸"
                      >
                        统一定位框尺寸
                      </Button>
                    )}
                  </div>
                </details>
              )}
              <div className="min-h-0 flex-1 overflow-hidden">
                <LowConfPanel page={page} />
              </div>
            </div>
          </>
        )}
      </div>

      <Dialog open={showExportPreview} onOpenChange={handleExportPreviewOpenChange}>
        <DialogContent className="flex max-h-[92vh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle>导出预览 · {exportModeLabel(exportMode)}</DialogTitle>
            <DialogDescription>
              {exportModeDescription(exportMode, previewPages.length || exportablePages.length)}
              {previewPages.length > 0 && (
                <> · 共 {previewPages.length} 页，滑动浏览并按需渲染；Ctrl + 滚轮或上方滑块缩放预览内容</>
              )}
            </DialogDescription>
          </DialogHeader>
          {previewPages.length === 0 ? (
            <div className="flex min-h-[12rem] flex-1 items-center justify-center rounded-lg border bg-stone-100 p-3">
              <p className="text-sm text-destructive">没有可预览的页面</p>
            </div>
          ) : (
            <ExportPreviewScroller key={previewGeneration} pages={previewPages} generation={previewGeneration} />
          )}
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 pt-3 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button onClick={() => void executeExport('png')} disabled={previewPages.length === 0 || !canExportPng || canvasExporting !== null}>
              {canvasExporting === 'png' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
              导出 PNG
            </Button>
            <Button onClick={() => void executeExport('pdf')} disabled={previewPages.length === 0 || !canExportPdf || canvasExporting !== null}>
              {canvasExporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              导出 PDF
            </Button>
            <Button variant="outline" onClick={() => handleExportPreviewOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddName} onOpenChange={setShowAddName}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增人名</DialogTitle>
            <DialogDescription>输入姓名后会生成多个独立字符，可继续移动、改单字或删除。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-person-name">姓名</Label>
              <Input
                id="new-person-name"
                value={nameDraft.text}
                onChange={(e) => setNameDraft({ ...nameDraft, text: e.target.value })}
                placeholder="输入姓名"
                maxLength={12}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>排列方向</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={nameDraft.orientation === 'v' ? 'secondary' : 'outline'}
                  onClick={() => setNameDraft({ ...nameDraft, orientation: 'v' })}
                >
                  竖排
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={nameDraft.orientation === 'h' ? 'secondary' : 'outline'}
                  onClick={() => setNameDraft({ ...nameDraft, orientation: 'h' })}
                >
                  横排
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-name-pt">字号 pt</Label>
                <Input
                  id="new-name-pt"
                  type="number"
                  min={1}
                  step={0.5}
                  value={nameDraft.pt}
                  onChange={(e) => setNameDraft({ ...nameDraft, pt: parseFloat(e.target.value) || 12 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-name-spacing">字间距倍率</Label>
                <Input
                  id="new-name-spacing"
                  type="number"
                  min={0.8}
                  max={3}
                  step={0.05}
                  value={nameDraft.spacing}
                  onChange={(e) => setNameDraft({ ...nameDraft, spacing: parseFloat(e.target.value) || 1 })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={addPersonName} disabled={!nameDraft.text.trim()}>
              添加到画布
            </Button>
            <Button variant="outline" onClick={() => setShowAddName(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
