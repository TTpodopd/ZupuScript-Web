/**
 * 校对画布（F6.3–F6.8）：Canvas 2D + 离屏缓存重建层；
 * 点选就地编辑、拖拽挪位、框选批量平移、线段端点/节点圆心拖拽。
 * 所有修改一律经 editorStore.apply(EditCommand)，保证撤销栈与 idb 同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CharItem, Page } from '@/model/types';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { PREVIEW_FONT_FAMILY, PREVIEW_FONT_SCALE, ptToPx } from '@/verify/preview';
import { uuid } from '@/lib/utils';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { drawSelectionOverlay, computeFitCenterTransform, collectRegionSelection, unionCharBboxes, hitBboxResizeHandle, cursorForBboxHandle, resizeBboxByHandle, scaleBboxesInUnion, bboxCenter, type BboxResizeHandle, type FitMode } from '@/ui/canvasOverlay';
import {
  RULER_SIZE,
  buildSelectionRulerGuides,
  drawCanvasCrosshair,
  drawHorizontalRuler,
  drawVerticalRuler,
} from '@/ui/canvasRuler';
import { isRenderableSolidBorderRect } from '@/layout/detect';
import { drawBorderBar, drawTagBlock } from '@/layout/borderBar';

interface EditPopup {
  charId: string;
  /** 屏幕坐标 */
  sx: number;
  sy: number;
  text: string;
  pt: number;
}

interface CharDragOrigin {
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
}

interface LineDragOrigin {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface NodeDragOrigin {
  cx: number;
  cy: number;
}

interface RectDragOrigin {
  x: number;
  y: number;
}

type DragState =
  | {
      kind: 'moveSelection';
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      charOrig: Record<string, CharDragOrigin>;
      lineOrig: Record<string, LineDragOrigin>;
      nodeOrig: Record<string, NodeDragOrigin>;
      rectOrig: Record<string, RectDragOrigin>;
    }
  | {
      kind: 'resizeChars';
      handle: BboxResizeHandle;
      origUnion: [number, number, number, number];
      orig: Record<string, CharDragOrigin>;
    }
  | { kind: 'rubber'; startX: number; startY: number; curX: number; curY: number }
  | { kind: 'lineEndpoint'; lineId: string; end: 'p1' | 'p2'; orig: { x1: number; y1: number; x2: number; y2: number } }
  | { kind: 'moveLine'; lineId: string; startX: number; startY: number; orig: { x1: number; y1: number; x2: number; y2: number } }
  | { kind: 'moveNode'; nodeId: string; dx: number; dy: number; orig: { cx: number; cy: number } }
  | { kind: 'moveRect'; rectId: string; dx: number; dy: number; orig: { x: number; y: number } }
  | { kind: 'pan'; lastX: number; lastY: number }
  | null;

export default function ProofreadCanvas({
  page,
  focusCharId = null,
  fitMode = 'width',
}: {
  page: Page;
  focusCharId?: string | null;
  fitMode?: FitMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const hRulerRef = useRef<HTMLCanvasElement>(null);
  const vRulerRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const cacheKeyRef = useRef<string>('');
  const dragRef = useRef<DragState>(null);
  const lastFitRef = useRef({ pageId: '', w: 0, h: 0 });
  const [popup, setPopup] = useState<EditPopup | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursorImage, setCursorImage] = useState<{ x: number; y: number } | null>(null);

  const {
    selectedCharIds,
    selectedLineIds,
    selectedNodeIds,
    selectedRectIds,
    transform,
    setTransform,
    setSelection,
    setRegionSelection,
    setSelectedLine,
    setSelectedNode,
    setSelectedRect,
    apply,
    rubberBand,
    setRubberBand,
    setCanvasViewSize,
    showRulers,
  } = useEditorStore();

  /* ---------- 容器尺寸监听（画布视口，不含标尺） ---------- */
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize({ w, h });
      setCanvasViewSize({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setCanvasViewSize]);

  /* ---------- 切换页面或视口显著变化时居中适配 ---------- */
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
      computeFitCenterTransform(page.source.widthPx, page.source.heightPx, size.w, size.h, {
        mode: fitMode,
        padding: 0.96,
      }),
    );
  }, [page.id, page.source.widthPx, page.source.heightPx, size.w, size.h, fitMode, setTransform]);

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
    for (const r of page.borderRects) {
      if (isRenderableSolidBorderRect(r, w, h)) drawBorderBar(ctx, r);
      else {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
    }
    for (const r of page.tagRects) drawTagBlock(ctx, r);
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
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.arc(n.cx, n.cy, n.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000000';
    const pxPerMm = page.calibration.pxPerMm || 1;
    for (const c of page.chars) {
      const [x0, y0, x1, y1] = c.bbox;
      if (c.text && c.pt > 0) {
        ctx.font = `500 ${ptToPx(c.pt, pxPerMm) * PREVIEW_FONT_SCALE}px ${PREVIEW_FONT_FAMILY}`;
        ctx.fillStyle = '#000000';
        ctx.fillText(c.text, c.cx, c.cy);
      } else if (c.pt > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }, [page]);

  const rulerGuides = useMemo(
    () =>
      buildSelectionRulerGuides(
        page.chars.filter((c) => selectedCharIds.includes(c.id)).map((c) => ({ cx: c.cx, cy: c.cy, bbox: c.bbox })),
      ),
    [page.chars, selectedCharIds],
  );

  const rulerOptions = useMemo(
    () => ({
      viewW: size.w,
      viewH: size.h,
      pageW: page.source.widthPx,
      pageH: page.source.heightPx,
      transform,
      cursor: cursorImage,
      guides: rulerGuides,
    }),
    [size.w, size.h, page.source.widthPx, page.source.heightPx, transform, cursorImage, rulerGuides],
  );

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

    drawSelectionOverlay(
      ctx,
      page,
      { selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds, rubberBand },
      transform.scale,
      { showLowConf: true, showRubber: true, focusCharId },
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (showRulers) drawCanvasCrosshair(ctx, rulerOptions);
  }, [page, transform, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds, rubberBand, size, rebuildCache, focusCharId, rulerOptions, showRulers]);

  useEffect(() => {
    if (!showRulers) return;
    const hCanvas = hRulerRef.current;
    const vCanvas = vRulerRef.current;
    if (!hCanvas || !vCanvas || size.w <= 0) return;
    hCanvas.width = size.w;
    hCanvas.height = RULER_SIZE;
    vCanvas.width = RULER_SIZE;
    vCanvas.height = size.h;
    const hCtx = hCanvas.getContext('2d');
    const vCtx = vCanvas.getContext('2d');
    if (!hCtx || !vCtx) return;
    drawHorizontalRuler(hCtx, size.w, rulerOptions);
    drawVerticalRuler(vCtx, size.h, rulerOptions);
  }, [size.w, size.h, rulerOptions, showRulers]);

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

  const hitLine = useCallback(
    (x: number, y: number) =>
      page.treeLines.find((line) => {
        const tol = Math.max(6 / transform.scale, line.widthPx);
        if (line.orientation === 'h') {
          return Math.abs(y - line.y1) < tol && x >= Math.min(line.x1, line.x2) - tol && x <= Math.max(line.x1, line.x2) + tol;
        }
        return Math.abs(x - line.x1) < tol && y >= Math.min(line.y1, line.y2) - tol && y <= Math.max(line.y1, line.y2) + tol;
      }) ?? null,
    [page.treeLines, transform.scale],
  );

  const beginMoveSelection = (
    canvas: HTMLCanvasElement,
    x: number,
    y: number,
    charIds: string[],
    lineIds: string[],
    nodeIds: string[],
    rectIds: string[],
  ) => {
    const charIdSet = new Set(charIds);
    const lineIdSet = new Set(lineIds);
    const nodeIdSet = new Set(nodeIds);
    const rectIdSet = new Set(rectIds);
    const charOrig = Object.fromEntries(
      page.chars
        .filter((char) => charIdSet.has(char.id))
        .map((char) => [char.id, { cx: char.cx, cy: char.cy, bbox: [...char.bbox] as [number, number, number, number] }]),
    );
    const lineOrig = Object.fromEntries(
      page.treeLines
        .filter((line) => lineIdSet.has(line.id))
        .map((line) => [line.id, { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 }]),
    );
    const nodeOrig = Object.fromEntries(
      page.treeNodes
        .filter((node) => nodeIdSet.has(node.id))
        .map((node) => [node.id, { cx: node.cx, cy: node.cy }]),
    );
    const rectOrig = Object.fromEntries(
      [...page.borderRects, ...page.tagRects]
        .filter((rect) => rectIdSet.has(rect.id))
        .map((rect) => [rect.id, { x: rect.x, y: rect.y }]),
    );
    if (
      Object.keys(charOrig).length === 0 &&
      Object.keys(lineOrig).length === 0 &&
      Object.keys(nodeOrig).length === 0 &&
      Object.keys(rectOrig).length === 0
    ) {
      return;
    }
    dragRef.current = {
      kind: 'moveSelection',
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      charOrig,
      lineOrig,
      nodeOrig,
      rectOrig,
    };
    canvas.style.cursor = 'grabbing';
  };

  const hasGroupedSelection = () =>
    selectedCharIds.length +
      selectedLineIds.length +
      selectedNodeIds.length +
      selectedRectIds.length >
    1;

  const isInGroupedSelection = (opts: {
    charId?: string;
    lineId?: string;
    nodeId?: string;
    rectId?: string;
  }) => {
    if (opts.charId && selectedCharIds.includes(opts.charId)) return true;
    if (opts.lineId && selectedLineIds.includes(opts.lineId)) return true;
    if (opts.nodeId && selectedNodeIds.includes(opts.nodeId)) return true;
    if (opts.rectId && selectedRectIds.includes(opts.rectId)) return true;
    return false;
  };

  const applyCharBboxPatches = (
    patches: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }>,
  ) => {
    const currentPage = useProjectStore.getState().currentPage();
    if (currentPage?.id !== page.id) return;
    useProjectStore.getState().updatePage(page.id, {
      chars: currentPage.chars.map((char) => {
        const patch = patches[char.id];
        return patch ? { ...char, ...patch } : char;
      }),
    });
  };

  /* ---------- 鼠标交互 ---------- */
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toImage(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2 || e.altKey) {
      dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }
    // 文字定位框缩放（优先于移动）
    if (selectedCharIds.length > 0) {
      const selected = page.chars.filter((c) => selectedCharIds.includes(c.id));
      const union = unionCharBboxes(selected.map((c) => c.bbox));
      if (union) {
        const handle = hitBboxResizeHandle(x, y, union, transform.scale);
        if (handle) {
          const orig = Object.fromEntries(
            selected.map((char) => [
              char.id,
              { cx: char.cx, cy: char.cy, bbox: [...char.bbox] as [number, number, number, number] },
            ]),
          );
          dragRef.current = { kind: 'resizeChars', handle, origUnion: union, orig };
          canvas.style.cursor = cursorForBboxHandle(handle);
          return;
        }
      }
    }
    // 线段端点（仅单选线段时显示）
    if (selectedLineIds.length === 1) {
      const l = page.treeLines.find((v) => v.id === selectedLineIds[0]);
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
    const hitLineItem = hitLine(x, y);
    if (hitLineItem && !hitChar(x, y)) {
      if (isInGroupedSelection({ lineId: hitLineItem.id }) && hasGroupedSelection()) {
        beginMoveSelection(canvas, x, y, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds);
        return;
      }
      setSelectedLine(hitLineItem.id);
      dragRef.current = {
        kind: 'moveLine',
        lineId: hitLineItem.id,
        startX: x,
        startY: y,
        orig: { x1: hitLineItem.x1, y1: hitLineItem.y1, x2: hitLineItem.x2, y2: hitLineItem.y2 },
      };
      canvas.style.cursor = 'grabbing';
      return;
    }
    // 节点圆
    const hitNode = page.treeNodes.find((n) => Math.hypot(x - n.cx, y - n.cy) <= n.r + 6 / transform.scale);
    if (hitNode && !hitChar(x, y)) {
      if (isInGroupedSelection({ nodeId: hitNode.id }) && hasGroupedSelection()) {
        beginMoveSelection(canvas, x, y, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds);
        return;
      }
      setSelectedNode(hitNode.id);
      dragRef.current = { kind: 'moveNode', nodeId: hitNode.id, dx: hitNode.cx - x, dy: hitNode.cy - y, orig: { cx: hitNode.cx, cy: hitNode.cy } };
      return;
    }
    const hitRect = [...page.borderRects, ...page.tagRects].find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (hitRect && !hitChar(x, y)) {
      if (isInGroupedSelection({ rectId: hitRect.id }) && hasGroupedSelection()) {
        beginMoveSelection(canvas, x, y, selectedCharIds, selectedLineIds, selectedNodeIds, selectedRectIds);
        return;
      }
      setSelectedRect(hitRect.id);
      dragRef.current = { kind: 'moveRect', rectId: hitRect.id, dx: hitRect.x - x, dy: hitRect.y - y, orig: { x: hitRect.x, y: hitRect.y } };
      return;
    }
    // 字符
    const c = hitChar(x, y);
    if (c) {
      if (e.ctrlKey || e.metaKey) {
        const next = selectedCharIds.includes(c.id)
          ? selectedCharIds.filter((id) => id !== c.id)
          : [...selectedCharIds, c.id];
        setSelection(next);
        return;
      }
      let movingCharIds = selectedCharIds;
      if (!selectedCharIds.includes(c.id)) {
        movingCharIds = [c.id];
        setRegionSelection([c.id], [], [], []);
      }
      beginMoveSelection(canvas, x, y, movingCharIds, selectedLineIds, selectedNodeIds, selectedRectIds);
      return;
    }
    // 空白：框选
    setRegionSelection([], [], [], []);
    dragRef.current = { kind: 'rubber', startX: x, startY: y, curX: x, curY: y };
    setRubberBand({ x0: x, y0: y, x1: x, y1: y });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const drag = dragRef.current;
    const [x, y] = toImage(e.clientX, e.clientY);
    if (!drag) {
      if (showRulers) setCursorImage({ x, y });
      if (selectedCharIds.length > 0) {
        const selected = page.chars.filter((c) => selectedCharIds.includes(c.id));
        const union = unionCharBboxes(selected.map((c) => c.bbox));
        if (union) {
          const handle = hitBboxResizeHandle(x, y, union, transform.scale);
          if (handle) {
            canvas.style.cursor = cursorForBboxHandle(handle);
            return;
          }
        }
      }
      canvas.style.cursor = hitChar(x, y) || hitLine(x, y) ? 'grab' : 'crosshair';
      return;
    }
    if (drag.kind === 'pan') {
      setTransform({ offsetX: transform.offsetX + e.clientX - drag.lastX, offsetY: transform.offsetY + e.clientY - drag.lastY });
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      return;
    }
    if (showRulers) setCursorImage({ x, y });
    if (drag.kind === 'resizeChars') {
      const ids = Object.keys(drag.orig);
      if (ids.length === 1) {
        const id = ids[0];
        const orig = drag.orig[id];
        const bbox = resizeBboxByHandle(orig.bbox, drag.handle, x, y);
        const [cx, cy] = bboxCenter(bbox);
        applyCharBboxPatches({ [id]: { cx, cy, bbox } });
      } else {
        const newUnion = resizeBboxByHandle(drag.origUnion, drag.handle, x, y);
        applyCharBboxPatches(scaleBboxesInUnion(drag.orig, drag.origUnion, newUnion));
      }
    } else if (drag.kind === 'moveSelection') {
      const dx = Math.round(x - drag.startX);
      const dy = Math.round(y - drag.startY);
      drag.lastX = x;
      drag.lastY = y;
      const currentPage = useProjectStore.getState().currentPage();
      if (currentPage?.id === page.id) {
        useProjectStore.getState().updatePage(page.id, {
          chars: currentPage.chars.map((char) => {
            const origin = drag.charOrig[char.id];
            if (!origin) return char;
            return {
              ...char,
              cx: origin.cx + dx,
              cy: origin.cy + dy,
              bbox: [
                origin.bbox[0] + dx,
                origin.bbox[1] + dy,
                origin.bbox[2] + dx,
                origin.bbox[3] + dy,
              ],
            };
          }),
          treeLines: currentPage.treeLines.map((line) => {
            const origin = drag.lineOrig[line.id];
            if (!origin) return line;
            return {
              ...line,
              x1: origin.x1 + dx,
              y1: origin.y1 + dy,
              x2: origin.x2 + dx,
              y2: origin.y2 + dy,
            };
          }),
          treeNodes: currentPage.treeNodes.map((node) => {
            const origin = drag.nodeOrig[node.id];
            if (!origin) return node;
            return { ...node, cx: origin.cx + dx, cy: origin.cy + dy };
          }),
          borderRects: currentPage.borderRects.map((rect) => {
            const origin = drag.rectOrig[rect.id];
            return origin ? { ...rect, x: origin.x + dx, y: origin.y + dy } : rect;
          }),
          tagRects: currentPage.tagRects.map((rect) => {
            const origin = drag.rectOrig[rect.id];
            return origin ? { ...rect, x: origin.x + dx, y: origin.y + dy } : rect;
          }),
        });
      }
    } else if (drag.kind === 'moveLine') {
      const dx = Math.round(x - drag.startX);
      const dy = Math.round(y - drag.startY);
      const currentPage = useProjectStore.getState().currentPage();
      if (currentPage?.id === page.id) {
        useProjectStore.getState().updatePage(page.id, {
          treeLines: currentPage.treeLines.map((line) =>
            line.id === drag.lineId
              ? {
                  ...line,
                  x1: drag.orig.x1 + dx,
                  y1: drag.orig.y1 + dy,
                  x2: drag.orig.x2 + dx,
                  y2: drag.orig.y2 + dy,
                }
              : line,
          ),
        });
      }
    } else if (drag.kind === 'rubber') {
      drag.curX = x;
      drag.curY = y;
      setRubberBand({ x0: drag.startX, y0: drag.startY, x1: x, y1: y });
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
    } else if (drag.kind === 'moveRect') {
      const nx = x + drag.dx;
      const ny = y + drag.dy;
      useProjectStore.getState().updatePage(page.id, {
        borderRects: page.borderRects.map((v) => (v.id === drag.rectId ? { ...v, x: nx, y: ny } : v)),
        tagRects: page.tagRects.map((v) => (v.id === drag.rectId ? { ...v, x: nx, y: ny } : v)),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    canvas.style.cursor = 'crosshair';
    if (!drag) {
      setRubberBand(null);
      return;
    }
    const [x, y] = toImage(e.clientX, e.clientY);
    if (drag.kind === 'resizeChars') {
      const ids = Object.keys(drag.orig);
      const currentPage = useProjectStore.getState().currentPage();
      if (currentPage?.id === page.id) {
        useProjectStore.getState().updatePage(page.id, {
          chars: currentPage.chars.map((char) => {
            const origin = drag.orig[char.id];
            return origin ? { ...char, cx: origin.cx, cy: origin.cy, bbox: [...origin.bbox] } : char;
          }),
        });
      }
      let after: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }>;
      if (ids.length === 1) {
        const id = ids[0];
        const orig = drag.orig[id];
        const bbox = resizeBboxByHandle(orig.bbox, drag.handle, x, y);
        const [cx, cy] = bboxCenter(bbox);
        after = { [id]: { cx, cy, bbox } };
      } else {
        const newUnion = resizeBboxByHandle(drag.origUnion, drag.handle, x, y);
        after = scaleBboxesInUnion(drag.orig, drag.origUnion, newUnion);
      }
      const before: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> = {};
      for (const id of ids) {
        before[id] = { cx: drag.orig[id].cx, cy: drag.orig[id].cy, bbox: [...drag.orig[id].bbox] };
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        apply({ type: 'char.batchBbox', before, after });
      }
    } else if (drag.kind === 'moveSelection') {
      const dx = Math.round(x - drag.startX);
      const dy = Math.round(y - drag.startY);
      const charIds = Object.keys(drag.charOrig);
      const lineIds = Object.keys(drag.lineOrig);
      const nodeIds = Object.keys(drag.nodeOrig);
      const rectIds = Object.keys(drag.rectOrig);
      const currentPage = useProjectStore.getState().currentPage();
      if (currentPage?.id === page.id) {
        useProjectStore.getState().updatePage(page.id, {
          chars: currentPage.chars.map((char) => {
            const origin = drag.charOrig[char.id];
            return origin ? { ...char, cx: origin.cx, cy: origin.cy, bbox: [...origin.bbox] } : char;
          }),
          treeLines: currentPage.treeLines.map((line) => {
            const origin = drag.lineOrig[line.id];
            return origin ? { ...line, x1: origin.x1, y1: origin.y1, x2: origin.x2, y2: origin.y2 } : line;
          }),
          treeNodes: currentPage.treeNodes.map((node) => {
            const origin = drag.nodeOrig[node.id];
            return origin ? { ...node, cx: origin.cx, cy: origin.cy } : node;
          }),
          borderRects: currentPage.borderRects.map((rect) => {
            const origin = drag.rectOrig[rect.id];
            return origin ? { ...rect, x: origin.x, y: origin.y } : rect;
          }),
          tagRects: currentPage.tagRects.map((rect) => {
            const origin = drag.rectOrig[rect.id];
            return origin ? { ...rect, x: origin.x, y: origin.y } : rect;
          }),
        });
      }
      if (dx !== 0 || dy !== 0) {
        if (charIds.length > 0) apply({ type: 'char.batchMove', ids: charIds, dx, dy });
        if (lineIds.length > 0) apply({ type: 'line.batchMove', ids: lineIds, dx, dy });
        if (nodeIds.length > 0) apply({ type: 'node.batchMove', ids: nodeIds, dx, dy });
        if (rectIds.length > 0) apply({ type: 'rect.batchMove', ids: rectIds, dx, dy });
      }
    } else if (drag.kind === 'rubber') {
      const x0 = Math.min(drag.startX, drag.curX);
      const y0 = Math.min(drag.startY, drag.curY);
      const x1 = Math.max(drag.startX, drag.curX);
      const y1 = Math.max(drag.startY, drag.curY);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const picked = collectRegionSelection(page, x0, y0, x1, y1);
        setRegionSelection(picked.charIds, picked.lineIds, picked.nodeIds, picked.rectIds);
      }
      setRubberBand(null);
    } else if (drag.kind === 'moveLine') {
      const currentPage = useProjectStore.getState().currentPage();
      const cur = currentPage?.treeLines.find((line) => line.id === drag.lineId);
      if (cur) {
        const before = { ...drag.orig };
        const after = { x1: cur.x1, y1: cur.y1, x2: cur.x2, y2: cur.y2 };
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          apply({ type: 'line.update', id: drag.lineId, before, after });
        }
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
    } else if (drag.kind === 'moveRect') {
      const cur = [...page.borderRects, ...page.tagRects].find((r) => r.id === drag.rectId);
      if (cur && (cur.x !== drag.orig.x || cur.y !== drag.orig.y)) {
        apply({ type: 'rect.update', id: drag.rectId, before: { x: drag.orig.x, y: drag.orig.y }, after: { x: cur.x, y: cur.y } });
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

  useEffect(() => {
    if (!showRulers) setCursorImage(null);
  }, [showRulers]);

  return (
    <div
      ref={containerRef}
      className="canvas-noselect grid h-full w-full overflow-hidden bg-[#f3f1ec]"
      style={
        showRulers
          ? { gridTemplateColumns: `${RULER_SIZE}px 1fr`, gridTemplateRows: `${RULER_SIZE}px 1fr` }
          : { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
      }
      aria-label="校对画布"
    >
      {showRulers && (
        <>
          <div className="border-b border-r border-stone-300 bg-[#eceae4]" aria-hidden />
          <canvas ref={hRulerRef} className="block border-b border-stone-300 bg-[#eceae4]" aria-hidden />
          <canvas ref={vRulerRef} className="block border-r border-stone-300 bg-[#eceae4]" aria-hidden />
        </>
      )}
      <div ref={canvasWrapRef} className="relative min-h-0 min-w-0 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setCursorImage(null)}
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
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-black/55 px-2.5 py-1 text-xs font-medium tabular-nums text-white backdrop-blur-sm">
          {Math.round(transform.scale * 100)}%
        </div>
      </div>
    </div>
  );
}
