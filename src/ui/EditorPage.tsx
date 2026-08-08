/**
 * 结果画布（F6.x）：单一结果画布优先，原图/叠加比对作为辅助视图，
 * 叠加模式（红/蓝/黑，透明度可调）、标定面板（F5.5 公式可见、字号可人工覆盖）、
 * 撤销/重做、低置信面板、全键盘操作（F6.9）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainCircuit, ClipboardPaste, Copy, Eye, FileImage, FileText, HelpCircle, Loader2, Redo2, Undo2, UserRoundPlus } from 'lucide-react';
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
import { MM_PER_PT, PT_PER_MM } from '@/lib/constants';
import { calibratePage } from '@/calibrate/calibrate';
import type { BorderRect, CharItem, FontSizes, Page, TagRect, TreeLine, TreeNode } from '@/model/types';
import { getBinaryImage, getImageBitmap } from '@/storage/opfs';
import { countMemoryRecords } from '@/storage/db';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { ptToPx, renderPreviewBinary } from '@/verify/preview';
import { exportProofreadPdf, exportProofreadPng, renderProofreadCanvas } from '@/export/proofreadExport';
import { uuid } from '@/lib/utils';
import LowConfPanel, { useLowConfChars } from './LowConfPanel';
import ProofreadCanvas from './ProofreadCanvas';

/** 左侧原图画布：与右侧共享 transform，天然联动（F6.1） */
function OriginalCanvas({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const transform = useEditorStore((s) => s.transform);
  const setTransform = useEditorStore((s) => s.setTransform);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
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
      ctx.fillStyle = '#e7e5e4';
      ctx.fillRect(0, 0, size.w, size.h);
      if (!bmp) {
        ctx.fillStyle = '#78716c';
        ctx.font = '14px sans-serif';
        ctx.fillText('原图缺失（.zpproj 导入的项目需重新导入图像）', 20, 40);
        return;
      }
      ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    })();
  }, [page.imageKey, transform, size]);

  return (
    <div ref={containerRef} className="canvas-noselect relative h-full w-full overflow-hidden">
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
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/50 px-2 py-1 text-xs text-white">原图</div>
    </div>
  );
}

/** 叠加模式画布：原图独有红、重建独有蓝、重合黑，透明度可调（F6.2） */
function OverlayCanvas({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { transform, overlayOpacity } = useEditorStore();
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [diffUrl, setDiffUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'],
  ['Ctrl+C / Ctrl+V', '复制 / 粘贴选中的文字、线段、圆圈或矩形'],
  ['方向键', '微调选中字符 1px'],
  ['Shift+方向键', '微调 10px'],
  ['Delete', '删除选中字符'],
  ['双击字符', '就地编辑文字与字号'],
  ['双击空白', '新增字符'],
  ['Shift+拖拽', '框选多个字符'],
  ['Alt+拖拽 / 右键拖拽', '平移视图'],
  ['滚轮', '缩放（以鼠标为中心）'],
  ['Tab', '跳转到下一个低置信字符'],
];

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
  const { pages, currentPageId, setCurrentPage, updatePage, setView } = useProjectStore();
  const page: Page | undefined = pages.find((p) => p.id === currentPageId) ?? pages[0];
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
    selectedLineId,
    selectedNodeId,
    selectedRectId,
    apply,
    setLowConfCursor,
    lowConfCursor,
    setSelection,
    setSelectedLine,
    setSelectedNode,
    setSelectedRect,
    setTransform,
    transform,
  } = useEditorStore();
  const [showLowConf, setShowLowConf] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [sizeOverrides, setSizeOverrides] = useState<Partial<FontSizes>>({});
  const [memoryCount, setMemoryCount] = useState(0);
  const [canvasExporting, setCanvasExporting] = useState<'png' | 'pdf' | null>(null);
  const [canvasExportMessage, setCanvasExportMessage] = useState('');
  const [clipboard, setClipboard] = useState<CanvasClipboard | null>(null);
  const [showAddName, setShowAddName] = useState(false);
  const [nameDraft, setNameDraft] = useState<NameDraft>({ text: '', orientation: 'v', pt: 12, spacing: 1.25 });
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);
  const [exportPreviewLoading, setExportPreviewLoading] = useState(false);
  const [exportPreviewError, setExportPreviewError] = useState('');
  const lowConf = useLowConfChars(page);

  const hasSelection = selectedCharIds.length > 0 || Boolean(selectedLineId || selectedNodeId || selectedRectId);

  const copySelection = useCallback(() => {
    if (!page) return;
    if (selectedCharIds.length > 0) {
      const items = selectedCharIds
        .map((id) => page.chars.find((char) => char.id === id))
        .filter((char): char is CharItem => Boolean(char));
      if (items.length > 0) setClipboard({ kind: 'chars', items });
      return;
    }
    if (selectedLineId) {
      const item = page.treeLines.find((line) => line.id === selectedLineId);
      if (item) setClipboard({ kind: 'line', item });
      return;
    }
    if (selectedNodeId) {
      const item = page.treeNodes.find((node) => node.id === selectedNodeId);
      if (item) setClipboard({ kind: 'node', item });
      return;
    }
    if (selectedRectId) {
      const border = page.borderRects.find((rect) => rect.id === selectedRectId);
      const tag = page.tagRects.find((rect) => rect.id === selectedRectId);
      if (border) setClipboard({ kind: 'rect', item: border, rectKind: 'border' });
      else if (tag) setClipboard({ kind: 'rect', item: tag, rectKind: 'tag' });
    }
  }, [page, selectedCharIds, selectedLineId, selectedNodeId, selectedRectId]);

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
    if (!showExportPreview || !page) return;
    let cancelled = false;
    setExportPreviewLoading(true);
    setExportPreviewError('');
    setExportPreviewUrl(null);
    void renderProofreadCanvas(page)
      .then((canvas) => {
        if (!cancelled) setExportPreviewUrl(canvas.toDataURL('image/png'));
      })
      .catch((error) => {
        if (!cancelled) setExportPreviewError(error instanceof Error ? error.message : '预览生成失败');
      })
      .finally(() => {
        if (!cancelled) setExportPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, showExportPreview]);

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
          setTransform({ offsetX: 400 - c.cx * transform.scale, offsetY: 300 - c.cy * transform.scale });
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCharIds.length > 0) {
          e.preventDefault();
          for (const id of selectedCharIds) {
            const c = page.chars.find((v) => v.id === id);
            if (c) apply({ type: 'char.remove', char: c });
          }
          setSelection([]);
        } else if (selectedLineId) {
          const line = page.treeLines.find((value) => value.id === selectedLineId);
          if (line) apply({ type: 'line.remove', line });
        } else if (selectedNodeId) {
          const node = page.treeNodes.find((value) => value.id === selectedNodeId);
          if (node) apply({ type: 'node.remove', node });
        } else if (selectedRectId) {
          const border = page.borderRects.find((value) => value.id === selectedRectId);
          const tag = page.tagRects.find((value) => value.id === selectedRectId);
          if (border) apply({ type: 'rect.remove', rect: border, kind: 'border' });
          else if (tag) apply({ type: 'rect.remove', rect: tag, kind: 'tag' });
        }
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const dirs: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (e.key in dirs && selectedCharIds.length > 0) {
        e.preventDefault();
        const [dx, dy] = dirs[e.key];
        apply({ type: 'char.batchMove', ids: selectedCharIds, dx, dy });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, selectedCharIds, selectedLineId, selectedNodeId, selectedRectId, lowConf, lowConfCursor, apply, undo, redo, setSelection, setLowConfCursor, setTransform, transform.scale, clipboard, copySelection, hasSelection, pasteSelection]);

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

  /** 应用字号人工覆盖（F5.5） */
  const applySizeOverrides = () => {
    const { fontSizes, chars } = calibratePage(page, sizeOverrides);
    updatePage(page.id, { fontSizes, chars });
    setSizeOverrides({});
  };

  const openAddNameDialog = () => {
    setNameDraft((draft) => ({ ...draft, text: '', pt: page.fontSizes.body || draft.pt || 12 }));
    setShowAddName(true);
  };

  const addPersonName = () => {
    const glyphs = Array.from(nameDraft.text.replace(/\s+/g, ''));
    if (glyphs.length === 0) return;
    const pxPerMm = page.calibration.pxPerMm > 0 ? page.calibration.pxPerMm : page.source.dpi / 25.4 || 10;
    const fontPx = Math.max(12, ptToPx(nameDraft.pt, pxPerMm));
    const boxSize = Math.max(18, fontPx * 1.08);
    const step = Math.max(boxSize, fontPx * nameDraft.spacing);

    let anchorX = page.source.widthPx / 2;
    let anchorY = page.source.heightPx / 2;
    const selectedChar = page.chars.find((char) => char.id === selectedCharIds[0]);
    const selectedLine = page.treeLines.find((line) => line.id === selectedLineId);
    const selectedNode = page.treeNodes.find((node) => node.id === selectedNodeId);
    const selectedRect = [...page.borderRects, ...page.tagRects].find((rect) => rect.id === selectedRectId);
    if (selectedChar) {
      anchorX = selectedChar.cx + boxSize * 1.4;
      anchorY = selectedChar.cy;
    } else if (selectedNode) {
      anchorX = selectedNode.cx;
      anchorY = selectedNode.cy + selectedNode.r + boxSize;
    } else if (selectedLine) {
      anchorX = (selectedLine.x1 + selectedLine.x2) / 2;
      anchorY = Math.max(selectedLine.y1, selectedLine.y2) + boxSize;
    } else if (selectedRect) {
      anchorX = selectedRect.x + selectedRect.w / 2;
      anchorY = selectedRect.y + selectedRect.h + boxSize;
    }

    const half = boxSize / 2;
    const totalSpan = step * (glyphs.length - 1);
    if (nameDraft.orientation === 'v') {
      anchorX = Math.max(half + 4, Math.min(page.source.widthPx - half - 4, anchorX));
      anchorY = Math.max(half + 4, Math.min(page.source.heightPx - half - 4 - totalSpan, anchorY));
    } else {
      anchorX = Math.max(half + 4, Math.min(page.source.widthPx - half - 4 - totalSpan, anchorX));
      anchorY = Math.max(half + 4, Math.min(page.source.heightPx - half - 4, anchorY));
    }

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
    setShowAddName(false);
    setNameDraft((draft) => ({ ...draft, text: '' }));
  };

  const exportCurrentCanvas = async (kind: 'png' | 'pdf') => {
    setCanvasExporting(kind);
    setCanvasExportMessage('正在生成成果文件…');
    try {
      const filename =
        kind === 'png'
          ? await exportProofreadPng(page)
          : await exportProofreadPdf([page], `${page.source.name.replace(/\.[^.]+$/, '')}_校对成果.pdf`);
      setCanvasExportMessage(`已生成：${filename}`);
    } catch (error) {
      setCanvasExportMessage(error instanceof Error ? error.message : '导出失败');
    } finally {
      setCanvasExporting(null);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-6.25rem)] flex-col sm:h-[calc(100vh-4rem)]">
      {/* 工具栏：编辑、核对、输出分组，窄屏自动换行 */}
      <div className="border-b bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Select
            value={page.id}
            onChange={(e) => setCurrentPage(e.target.value)}
            options={pages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}` }))}
            className="w-56"
            aria-label="选择页面"
          />
          <span className="h-6 w-px bg-border" aria-hidden="true" />
          <div className="flex items-center gap-1" aria-label="编辑操作">
            <Button size="sm" variant="outline" onClick={undo} disabled={!canUndo()} aria-label="撤销" title="撤销">
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={redo} disabled={!canRedo()} aria-label="重做" title="重做">
              <Redo2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={copySelection} disabled={!hasSelection} aria-label="复制选中元素" title="复制选中元素">
              <Copy className="h-4 w-4" />
              复制
            </Button>
            <Button size="sm" variant="outline" onClick={pasteSelection} disabled={!clipboard} aria-label="粘贴元素" title="粘贴元素">
              <ClipboardPaste className="h-4 w-4" />
              粘贴
            </Button>
            <Button size="sm" variant="outline" onClick={openAddNameDialog} aria-label="新增人名" title="新增人名">
              <UserRoundPlus className="h-4 w-4" />
              新增人名
            </Button>
          </div>
          <span className="h-6 w-px bg-border" aria-hidden="true" />
          <Select
            value={overlayMode}
            onChange={(e) => setOverlayMode(e.target.value as 'split' | 'overlay')}
            options={[
              { value: 'split', label: '原图 / 结果' },
              { value: 'overlay', label: '差异核对' },
            ]}
            className="w-32"
            aria-label="显示模式"
          />
          {overlayMode === 'overlay' && (
            <div className="flex w-40 items-center gap-2">
              <span className="text-xs">透明度</span>
              <Slider value={[overlayOpacity]} onValueChange={([v]) => setOverlayOpacity(v)} min={0.1} max={1} step={0.05} />
            </div>
          )}
          <Button size="sm" variant={showLowConf ? 'secondary' : 'outline'} onClick={() => setShowLowConf((v) => !v)}>
            低置信（{lowConf.length}）
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="default"
            onClick={() => setShowExportPreview(true)}
            disabled={page.chars.length === 0 || canvasExporting !== null}
            aria-label="打开导出预览"
            title="打开导出预览"
          >
            <Eye className="h-4 w-4" />
            导出预览
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowHelp(true)} aria-label="快捷键速查表" title="快捷键速查表">
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-3 py-1.5 text-xs">
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">已编辑 {page.chars.filter((c) => c.edited).length}</span>
          <span className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-blue-700" title="本地识别记忆会从人工修正和高置信结果中持续学习">
            <BrainCircuit className="h-3.5 w-3.5" /> 已学习 {memoryCount} 个字形
          </span>
          <span className="text-muted-foreground">已选择 {selectedCharIds.length + (selectedLineId || selectedNodeId || selectedRectId ? 1 : 0)} 个元素</span>
          {canvasExportMessage && <span className="text-muted-foreground">{canvasExportMessage}</span>}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 主画布区 */}
        <div className="flex min-w-0 flex-1">
          {overlayMode === 'split' ? (
            <>
              <div className="relative min-w-0 flex-1 border-r bg-stone-100">
                <OriginalCanvas page={page} />
              </div>
              <div className="relative min-w-0 flex-1 bg-stone-100">
                <ProofreadCanvas page={page} />
              </div>
            </>
          ) : (
            <div className="min-w-0 flex-1">
              <OverlayCanvas page={page} />
            </div>
          )}
        </div>

        {/* 右侧栏：低置信 + 标定 */}
      {showLowConf && (
          <div className="flex w-72 shrink-0 flex-col border-l">
            <div className="min-h-0 flex-1">
              <LowConfPanel page={page} />
            </div>
            <div className="space-y-2 border-t p-3 text-xs">
              <div className="font-medium">标定（F5，公式可查看）</div>
              <div className="text-muted-foreground">
                PX_PER_MM={page.calibration.pxPerMm.toFixed(3)}（已锁定） pt = 字高px / PX_PER_MM / {MM_PER_PT}；线宽
                pt = px / PX_PER_MM × {PT_PER_MM.toFixed(6)}
              </div>
              {(['body', 'title', 'pageno', 'rank'] as const).map((g) => (
                <div key={g} className="flex items-center gap-2">
                  <Label className="w-14">{{ body: '正文', title: '标题', pageno: '页码', rank: '排行' }[g]}</Label>
                  <Input
                    type="number"
                    step={0.5}
                    defaultValue={page.fontSizes[g]}
                    onChange={(e) => setSizeOverrides((o) => ({ ...o, [g]: parseFloat(e.target.value) || undefined }))}
                    className="h-7 w-20"
                    aria-label={`${g} 字号覆盖`}
                  />
                  <span className="text-muted-foreground">pt</span>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={applySizeOverrides} disabled={Object.keys(sizeOverrides).length === 0}>
                应用字号覆盖
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={showExportPreview} onOpenChange={setShowExportPreview}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>导出预览</DialogTitle>
            <DialogDescription>
              {page.source.name} · {page.source.widthPx} × {page.source.heightPx} px
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[18rem] max-h-[65vh] items-center justify-center overflow-auto rounded-lg border bg-stone-100 p-3">
            {exportPreviewLoading && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="正在生成预览" />}
            {!exportPreviewLoading && exportPreviewError && <p className="text-sm text-destructive">{exportPreviewError}</p>}
            {!exportPreviewLoading && !exportPreviewError && exportPreviewUrl && (
              <img src={exportPreviewUrl} alt="校对成果预览" className="h-auto max-h-[60vh] w-auto max-w-full object-contain shadow-soft" />
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => void exportCurrentCanvas('png')} disabled={!exportPreviewUrl || canvasExporting !== null}>
              {canvasExporting === 'png' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
              导出 PNG
            </Button>
            <Button onClick={() => void exportCurrentCanvas('pdf')} disabled={!exportPreviewUrl || canvasExporting !== null}>
              {canvasExporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              导出 PDF
            </Button>
            <Button variant="outline" onClick={() => setShowExportPreview(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 快捷键速查表（F6.9） */}
      <Dialog open={showHelp} onOpenChange={setShowHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>快捷键速查表</DialogTitle>
          </DialogHeader>
          <table className="w-full text-sm">
            <tbody>
              {SHORTCUTS.map(([key, desc]) => (
                <tr key={key} className="border-b last:border-0">
                  <td className="py-1.5 pr-4 font-mono text-xs">{key}</td>
                  <td className="py-1.5">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                  onChange={(e) => setNameDraft({ ...nameDraft, spacing: parseFloat(e.target.value) || 1.25 })}
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
