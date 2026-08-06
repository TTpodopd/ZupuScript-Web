/**
 * 校对台（F6.x）：左右分栏联动（左原图、右重建预览，滚动缩放同步）、
 * 叠加模式（红/蓝/黑，透明度可调）、标定面板（F5.5 公式可见、字号可人工覆盖）、
 * 撤销/重做、低置信面板、全键盘操作（F6.9）。
 */
import { useEffect, useRef, useState } from 'react';
import { HelpCircle, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input, Label } from '@/ui/components/ui/input';
import { Select } from '@/ui/components/ui/select';
import { Slider } from '@/ui/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { MM_PER_PT, PT_PER_MM } from '@/lib/constants';
import { calibratePage } from '@/calibrate/calibrate';
import type { FontSizes, Page } from '@/model/types';
import { getBinaryImage, getImageBitmap } from '@/storage/opfs';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { renderPreviewBinary } from '@/verify/preview';
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
    apply,
    setLowConfCursor,
    lowConfCursor,
    setSelection,
    setTransform,
    transform,
  } = useEditorStore();
  const [showLowConf, setShowLowConf] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [sizeOverrides, setSizeOverrides] = useState<Partial<FontSizes>>({});
  const lowConf = useLowConfChars(page);

  useEffect(() => {
    if (page) void loadStacks(page.id);
  }, [page?.id, loadStacks, page]);

  /* ---------- 全键盘操作（F6.9） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
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
  }, [page, selectedCharIds, lowConf, lowConfCursor, apply, undo, redo, setSelection, setLowConfCursor, setTransform, transform.scale]);

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

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Select
          value={page.id}
          onChange={(e) => setCurrentPage(e.target.value)}
          options={pages.map((p) => ({ value: p.id, label: `#${p.index + 1} ${p.source.name}` }))}
          className="w-56"
          aria-label="选择页面"
        />
        <Button size="sm" variant="outline" onClick={undo} disabled={!canUndo()} aria-label="撤销">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={redo} disabled={!canRedo()} aria-label="重做">
          <Redo2 className="h-4 w-4" />
        </Button>
        <Select
          value={overlayMode}
          onChange={(e) => setOverlayMode(e.target.value as 'split' | 'overlay')}
          options={[
            { value: 'split', label: '左右分栏' },
            { value: 'overlay', label: '叠加比对' },
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
        <Button size="sm" variant="ghost" onClick={() => setShowHelp(true)} aria-label="快捷键速查表">
          <HelpCircle className="h-4 w-4" />
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setView('export')}>
          前往导出 →
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 主画布区 */}
        <div className="flex min-w-0 flex-1">
          {overlayMode === 'split' ? (
            <>
              <div className="min-w-0 flex-1 border-r">
                <OriginalCanvas page={page} />
              </div>
              <div className="min-w-0 flex-1">
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
    </div>
  );
}
