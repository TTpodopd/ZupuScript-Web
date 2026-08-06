/**
 * 校对画布（F6.3–F6.8）：Canvas 2D + 离屏缓存重建层；
 * 点选就地编辑、拖拽挪位、框选批量平移、线段端点/节点圆心拖拽。
 * 所有修改一律经 editorStore.apply(EditCommand)，保证撤销栈与 idb 同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIDENCE_THRESHOLD, PT_PER_MM } from '@/lib/constants';
import type { CharItem, Page } from '@/model/types';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { ptToPx } from '@/verify/preview';
import { uuid } from '@/lib/utils';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';

interface EditPopup {
  charId: string;
  /** 屏幕坐标 */
  sx: number;
  sy: number;
  text: string;
  pt: number;
}

type DragState =
  | { kind: 'moveChars'; startX: number; startY: number; lastX: number; lastY: number }
  | { kind: 'rubber'; startX: number; startY: number; curX: number; curY: number }
  | { kind: 'lineEndpoint'; lineId: string; end: 'p1' | 'p2'; orig: { x1: number; y1: number; x2: number; y2: number } }
  | { kind: 'moveNode'; nodeId: string; dx: number; dy: number; orig: { cx: number; cy: number } }
  | { kind: 'pan'; lastX: number; lastY: number }
  | null;

export default function ProofreadCanvas({ page }: { page: Page }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const cacheKeyRef = useRef<string>('');
  const dragRef = useRef<DragState>(null);
  const [popup, setPopup] = useState<EditPopup | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const {
    selectedCharIds,
    selectedLineId,
    selectedNodeId,
    transform,
    setTransform,
    setSelection,
    setSelectedLine,
    setSelectedNode,
    apply,
  } = useEditorStore();

  /* ---------- 容器尺寸监听 ---------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- 离屏缓存：重建层（F6.8） ---------- */
  const rebuildCache = useCallback(() => {
    const w = page.source.widthPx;
    const h = page.source.heightPx;
    if (w <= 0 || h <= 0) return;
    if (!cacheRef.current) cacheRef.current = document.createElement('canvas');
    const cache = cacheRef.current;
    cache.width = w;
    cache.height = h;
    const ctx = cache.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    for (const r of [...page.borderRects, ...page.tagRects]) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#000000';
    for (const l of page.treeLines) {
      ctx.lineWidth = Math.max(1, l.widthPx);
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    for (const n of page.treeNodes) {
      ctx.lineWidth = Math.max(1, n.strokePx);
      ctx.beginPath();
      ctx.arc(n.cx, n.cy, n.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000000';
    const pxPerMm = page.calibration.pxPerMm || 1;
    for (const c of page.chars) {
      if (!c.text || c.pt <= 0) continue;
      ctx.font = `${ptToPx(c.pt, pxPerMm)}px "Noto Serif CJK SC", "SimSun", serif`;
      ctx.fillText(c.text, c.cx, c.cy);
    }
  }, [page]);

  /* ---------- 渲染 ---------- */
  useEffect(() => {
    const key = JSON.stringify([page.chars, page.treeLines, page.treeNodes, page.borderRects, page.tagRects]);
    if (key !== cacheKeyRef.current) {
      rebuildCache();
      cacheKeyRef.current = key;
    }
    const canvas = canvasRef.current;
    const cache = cacheRef.current;
    if (!canvas || !cache) return;
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e7e5e4';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
    ctx.drawImage(cache, 0, 0);

    // 低置信标红（F4.6）
    ctx.lineWidth = 2 / transform.scale;
    for (const c of page.chars) {
      if (c.conf < CONFIDENCE_THRESHOLD) {
        ctx.strokeStyle = 'rgba(220,38,38,0.9)';
        ctx.strokeRect(c.bbox[0] - 2, c.bbox[1] - 2, c.bbox[2] - c.bbox[0] + 4, c.bbox[3] - c.bbox[1] + 4);
      }
    }
    // 选中高亮
    ctx.strokeStyle = 'rgba(37,99,235,1)';
    for (const c of page.chars) {
      if (selectedCharIds.includes(c.id)) {
        ctx.strokeRect(c.bbox[0] - 3, c.bbox[1] - 3, c.bbox[2] - c.bbox[0] + 6, c.bbox[3] - c.bbox[1] + 6);
      }
    }
    const selLine = page.treeLines.find((l) => l.id === selectedLineId);
    if (selLine) {
      ctx.strokeStyle = 'rgba(37,99,235,1)';
      ctx.lineWidth = Math.max(2 / transform.scale, selLine.widthPx + 4);
      ctx.beginPath();
      ctx.moveTo(selLine.x1, selLine.y1);
      ctx.lineTo(selLine.x2, selLine.y2);
      ctx.stroke();
      // 端点手柄
      ctx.fillStyle = '#2563eb';
      for (const [px, py] of [[selLine.x1, selLine.y1], [selLine.x2, selLine.y2]] as const) {
        ctx.beginPath();
        ctx.arc(px, py, 6 / transform.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const selNode = page.treeNodes.find((n) => n.id === selectedNodeId);
    if (selNode) {
      ctx.strokeStyle = 'rgba(37,99,235,1)';
      ctx.lineWidth = 2 / transform.scale;
      ctx.beginPath();
      ctx.arc(selNode.cx, selNode.cy, selNode.r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 框选矩形
    const drag = dragRef.current;
    if (drag?.kind === 'rubber') {
      ctx.strokeStyle = 'rgba(37,99,235,0.9)';
      ctx.setLineDash([4 / transform.scale, 4 / transform.scale]);
      ctx.strokeRect(
        Math.min(drag.startX, drag.curX),
        Math.min(drag.startY, drag.curY),
        Math.abs(drag.curX - drag.startX),
        Math.abs(drag.curY - drag.startY),
      );
      ctx.setLineDash([]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [page, transform, selectedCharIds, selectedLineId, selectedNodeId, size, rebuildCache]);

  /* ---------- 坐标换算与命中测试 ---------- */
  const toImage = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const rect = canvasRef.current!.getBoundingClientRect();
      return [(clientX - rect.left - transform.offsetX) / transform.scale, (clientY - rect.top - transform.offsetY) / transform.scale];
    },
    [transform],
  );

  const hitChar = useCallback(
    (x: number, y: number): CharItem | null => {
      let best: CharItem | null = null;
      let bestD = Infinity;
      for (const c of page.chars) {
        const [x0, y0, x1, y1] = c.bbox;
        const pad = 4 / transform.scale;
        if (x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad) {
          const d = Math.hypot(x - c.cx, y - c.cy);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      return best;
    },
    [page.chars, transform.scale],
  );

  /* ---------- 鼠标交互 ---------- */
  const onMouseDown = (e: React.MouseEvent) => {
    const [x, y] = toImage(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2 || e.altKey) {
      dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }
    // 线段端点（已选中线段优先）
    if (selectedLineId) {
      const l = page.treeLines.find((v) => v.id === selectedLineId);
      if (l) {
        const tol = 10 / transform.scale;
        if (Math.hypot(x - l.x1, y - l.y1) < tol) {
          dragRef.current = { kind: 'lineEndpoint', lineId: l.id, end: 'p1', orig: { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 } };
          return;
        }
        if (Math.hypot(x - l.x2, y - l.y2) < tol) {
          dragRef.current = { kind: 'lineEndpoint', lineId: l.id, end: 'p2', orig: { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 } };
          return;
        }
      }
    }
    // 线段本体
    const hitLine = page.treeLines.find((l) => {
      const tol = Math.max(6 / transform.scale, l.widthPx);
      if (l.orientation === 'h') {
        return Math.abs(y - l.y1) < tol && x >= Math.min(l.x1, l.x2) - tol && x <= Math.max(l.x1, l.x2) + tol;
      }
      return Math.abs(x - l.x1) < tol && y >= Math.min(l.y1, l.y2) - tol && y <= Math.max(l.y1, l.y2) + tol;
    });
    if (hitLine && !hitChar(x, y)) {
      setSelectedLine(hitLine.id);
      return;
    }
    // 节点圆
    const hitNode = page.treeNodes.find((n) => Math.hypot(x - n.cx, y - n.cy) <= n.r + 6 / transform.scale);
    if (hitNode && !hitChar(x, y)) {
      setSelectedNode(hitNode.id);
      dragRef.current = { kind: 'moveNode', nodeId: hitNode.id, dx: hitNode.cx - x, dy: hitNode.cy - y, orig: { cx: hitNode.cx, cy: hitNode.cy } };
      return;
    }
    // 字符
    const c = hitChar(x, y);
    if (c) {
      if (e.shiftKey) {
        setSelection(selectedCharIds.includes(c.id) ? selectedCharIds.filter((i) => i !== c.id) : [...selectedCharIds, c.id]);
      } else if (!selectedCharIds.includes(c.id)) {
        setSelection([c.id]);
      }
      dragRef.current = { kind: 'moveChars', startX: x, startY: y, lastX: x, lastY: y };
      return;
    }
    // 空白：框选
    setSelection([]);
    dragRef.current = { kind: 'rubber', startX: x, startY: y, curX: x, curY: y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'pan') {
      setTransform({ offsetX: transform.offsetX + e.clientX - drag.lastX, offsetY: transform.offsetY + e.clientY - drag.lastY });
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      return;
    }
    const [x, y] = toImage(e.clientX, e.clientY);
    if (drag.kind === 'moveChars') {
      // 拖动中仅记录最新位置（不落命令），mouseup 时一次性提交 batchMove
      drag.lastX = x;
      drag.lastY = y;
    } else if (drag.kind === 'rubber') {
      drag.curX = x;
      drag.curY = y;
      // 触发重绘
      setTransform({});
    } else if (drag.kind === 'lineEndpoint') {
      // 拖动中直接改数据做实时预览（不进命令栈），mouseup 时一次性提交为单条命令
      const patch = drag.end === 'p1' ? { x1: x, y1: y } : { x2: x, y2: y };
      useProjectStore.getState().updatePage(page.id, {
        treeLines: page.treeLines.map((v) => (v.id === drag.lineId ? { ...v, ...patch } : v)),
      });
    } else if (drag.kind === 'moveNode') {
      const nx = x + drag.dx;
      const ny = y + drag.dy;
      useProjectStore.getState().updatePage(page.id, {
        treeNodes: page.treeNodes.map((v) => (v.id === drag.nodeId ? { ...v, cx: nx, cy: ny } : v)),
      });
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const [x, y] = toImage(e.clientX, e.clientY);
    if (drag.kind === 'moveChars') {
      const dx = Math.round(x - drag.startX);
      const dy = Math.round(y - drag.startY);
      if ((dx !== 0 || dy !== 0) && selectedCharIds.length > 0) {
        apply({ type: 'char.batchMove', ids: selectedCharIds, dx, dy });
      }
    } else if (drag.kind === 'rubber') {
      const x0 = Math.min(drag.startX, drag.curX);
      const y0 = Math.min(drag.startY, drag.curY);
      const x1 = Math.max(drag.startX, drag.curX);
      const y1 = Math.max(drag.startY, drag.curY);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const ids = page.chars
          .filter((c) => c.cx >= x0 && c.cx <= x1 && c.cy >= y0 && c.cy <= y1)
          .map((c) => c.id);
        setSelection(ids);
      }
    } else if (drag.kind === 'lineEndpoint') {
      // 提交整条拖拽为单条撤销命令（after 为绝对值，apply 幂等）
      const cur = page.treeLines.find((v) => v.id === drag.lineId);
      if (cur) {
        const before: Record<string, number> =
          drag.end === 'p1' ? { x1: drag.orig.x1, y1: drag.orig.y1 } : { x2: drag.orig.x2, y2: drag.orig.y2 };
        const after: Record<string, number> =
          drag.end === 'p1' ? { x1: cur.x1, y1: cur.y1 } : { x2: cur.x2, y2: cur.y2 };
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          apply({ type: 'line.update', id: drag.lineId, before, after });
        }
      }
    } else if (drag.kind === 'moveNode') {
      const cur = page.treeNodes.find((v) => v.id === drag.nodeId);
      if (cur && (cur.cx !== drag.orig.cx || cur.cy !== drag.orig.cy)) {
        apply({ type: 'node.update', id: drag.nodeId, before: { cx: drag.orig.cx, cy: drag.orig.cy }, after: { cx: cur.cx, cy: cur.cy } });
      }
    }
  };

  /** 双击：就地编辑字符；双击空白：新增字符（F6.3/F6.4） */
  const onDoubleClick = (e: React.MouseEvent) => {
    const [x, y] = toImage(e.clientX, e.clientY);
    const c = hitChar(x, y);
    const rect = canvasRef.current!.getBoundingClientRect();
    if (c) {
      setPopup({ charId: c.id, sx: e.clientX - rect.left, sy: e.clientY - rect.top, text: c.text ?? '', pt: c.pt });
    } else {
      const newChar: CharItem = {
        id: uuid(),
        text: '',
        cx: x,
        cy: y,
        bbox: [x - 15, y - 15, x + 15, y + 15],
        pt: page.fontSizes.body || 20,
        conf: 1,
        note: 'ok',
        source: 'manual',
        edited: true,
        group: 'body',
        kind: 'text',
      };
      apply({ type: 'char.add', char: newChar });
      setPopup({ charId: newChar.id, sx: e.clientX - rect.left, sy: e.clientY - rect.top, text: '', pt: newChar.pt });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newScale = Math.min(4, Math.max(0.02, transform.scale * factor));
    // 以鼠标为中心缩放
    const k = newScale / transform.scale;
    setTransform({
      scale: newScale,
      offsetX: mx - (mx - transform.offsetX) * k,
      offsetY: my - (my - transform.offsetY) * k,
    });
  };

  const commitPopup = () => {
    if (!popup) return;
    const c = page.chars.find((v) => v.id === popup.charId);
    if (c) {
      apply({
        type: 'char.update',
        charId: c.id,
        before: { text: c.text, pt: c.pt, conf: c.conf, edited: c.edited, source: c.source },
        after: { text: popup.text || null, pt: popup.pt, conf: 1, edited: true, source: 'manual', note: 'ok' },
      });
    }
    setPopup(null);
  };

  return (
    <div ref={containerRef} className="canvas-noselect relative h-full w-full overflow-hidden" aria-label="校对画布">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {popup && (
        <div
          className="absolute z-10 w-56 space-y-2 rounded-md border bg-popover p-3 shadow-lg"
          style={{ left: Math.min(popup.sx, size.w - 240), top: Math.min(popup.sy, size.h - 140) }}
        >
          <div className="text-xs font-medium">编辑字符</div>
          <Input
            value={popup.text}
            onChange={(e) => setPopup({ ...popup, text: e.target.value })}
            maxLength={2}
            autoFocus
            aria-label="字符内容"
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPopup();
              if (e.key === 'Escape') setPopup(null);
            }}
          />
          <Input
            type="number"
            value={popup.pt}
            onChange={(e) => setPopup({ ...popup, pt: parseFloat(e.target.value) || popup.pt })}
            aria-label="字号 pt"
            step={0.5}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={commitPopup}>
              确定
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPopup(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-xs text-white">
        缩放 {(transform.scale * 100).toFixed(0)}% · 双击改字/加字 · 拖动挪位 · Alt+拖动平移 · 滚轮缩放 · 字号换算
        1mm={PT_PER_MM.toFixed(3)}pt
      </div>
    </div>
  );
}
