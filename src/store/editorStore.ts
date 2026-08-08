/**
 * 校对编辑器状态：选中集、视图变换（左右栏联动）、撤销/重做命令栈。
 * 共享约定：所有校对修改必须经 EditCommand 走 apply()，禁止直接改 page 数据；
 * 栈深 ≥100，每次变更同步写 idb，刷新后可恢复。
 */
import { create } from 'zustand';
import { UNDO_LIMIT } from '@/lib/constants';
import { computeCenterOnPoint } from '@/ui/canvasOverlay';
import type { BorderRect, CharItem, Page, TagRect, TreeLine, TreeNode } from '@/model/types';
import { loadUndoStack, saveUndoStack } from '@/storage/db';
import { learnManualCorrection } from '@/recognize/memory';
import { useProjectStore } from './projectStore';

/** 编辑命令（before/after 保证可逆） */
export type EditCommand =
  | { type: 'char.update'; charId: string; before: Partial<CharItem>; after: Partial<CharItem> }
  | { type: 'char.add'; char: CharItem }
  | { type: 'char.addMany'; chars: CharItem[] }
  | { type: 'char.remove'; char: CharItem }
  | { type: 'char.batchMove'; ids: string[]; dx: number; dy: number }
  | { type: 'char.batchBbox'; before: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }>; after: Record<string, { cx: number; cy: number; bbox: [number, number, number, number] }> }
  | { type: 'char.batchResize'; ids: string[]; beforePts: Record<string, number>; pt?: number; afterPts?: Record<string, number> }
  | { type: 'line.update'; id: string; before: Record<string, number>; after: Record<string, number> }
  | { type: 'line.batchMove'; ids: string[]; dx: number; dy: number }
  | { type: 'line.add'; line: TreeLine }
  | { type: 'line.remove'; line: TreeLine }
  | { type: 'node.update'; id: string; before: Record<string, number>; after: Record<string, number> }
  | { type: 'node.batchMove'; ids: string[]; dx: number; dy: number }
  | { type: 'node.add'; node: TreeNode }
  | { type: 'node.remove'; node: TreeNode }
  | { type: 'rect.update'; id: string; before: Record<string, number>; after: Record<string, number> }
  | { type: 'rect.batchMove'; ids: string[]; dx: number; dy: number }
  | { type: 'rect.add'; rect: BorderRect | TagRect; kind: 'border' | 'tag' }
  | { type: 'rect.remove'; rect: BorderRect | TagRect; kind: 'border' | 'tag' };

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export type OverlayMode = 'split' | 'overlay';

interface EditorState {
  selectedCharIds: string[];
  selectedLineIds: string[];
  selectedNodeIds: string[];
  selectedRectIds: string[];
  transform: ViewTransform;
  /** 校对操作区视口尺寸，用于低置信跳转居中 */
  canvasViewSize: { w: number; h: number };
  overlayMode: OverlayMode;
  overlayOpacity: number;
  /** 低置信面板当前索引（Tab 逐条跳转） */
  lowConfCursor: number;
  /** 低置信列表悬停预览（未选中时操作区跟随） */
  lowConfHoverId: string | null;
  /** 校对操作区标尺与参考线 */
  showRulers: boolean;
  /** 框选矩形（图像坐标），供原图区同步高亮 */
  rubberBand: { x0: number; y0: number; x1: number; y1: number } | null;
  undoStack: EditCommand[];
  redoStack: EditCommand[];
  /** 当前撤销栈对应的页面 */
  stackPageId: string | null;

  setSelection: (ids: string[]) => void;
  /** 框选：同时选中字符、线段、节点与装饰矩形 */
  setRegionSelection: (charIds: string[], lineIds: string[], nodeIds: string[], rectIds: string[]) => void;
  setSelectedLine: (id: string | null) => void;
  setSelectedNode: (id: string | null) => void;
  setSelectedRect: (id: string | null) => void;
  setTransform: (t: Partial<ViewTransform>) => void;
  setCanvasViewSize: (size: { w: number; h: number }) => void;
  /** 将字符居中到校对操作区视口（保持当前缩放，仅平移） */
  centerOnChar: (cx: number, cy: number) => void;
  setOverlayMode: (m: OverlayMode) => void;
  setOverlayOpacity: (v: number) => void;
  setLowConfCursor: (i: number) => void;
  setLowConfHoverId: (id: string | null) => void;
  setShowRulers: (v: boolean) => void;
  setRubberBand: (band: { x0: number; y0: number; x1: number; y1: number } | null) => void;

  loadStacks: (pageId: string) => Promise<void>;
  apply: (cmd: EditCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

/** 对 Page 应用/回滚一条命令（纯函数，返回新 Page 补丁） */
function applyCommandToPage(page: Page, cmd: EditCommand, direction: 'do' | 'undo'): Page {
  const p: Page = { ...page };
  switch (cmd.type) {
    case 'char.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.chars = p.chars.map((c) => (c.id === cmd.charId ? { ...c, ...patch } : c));
      break;
    }
    case 'char.add': {
      p.chars = direction === 'do' ? [...p.chars, cmd.char] : p.chars.filter((c) => c.id !== cmd.char.id);
      break;
    }
    case 'char.addMany': {
      const ids = new Set(cmd.chars.map((char) => char.id));
      p.chars = direction === 'do' ? [...p.chars, ...cmd.chars] : p.chars.filter((char) => !ids.has(char.id));
      break;
    }
    case 'char.remove': {
      p.chars = direction === 'do' ? p.chars.filter((c) => c.id !== cmd.char.id) : [...p.chars, cmd.char];
      break;
    }
    case 'char.batchMove': {
      const sign = direction === 'do' ? 1 : -1;
      const idSet = new Set(cmd.ids);
      p.chars = p.chars.map((c) =>
        idSet.has(c.id)
          ? {
              ...c,
              cx: c.cx + sign * cmd.dx,
              cy: c.cy + sign * cmd.dy,
              bbox: [c.bbox[0] + sign * cmd.dx, c.bbox[1] + sign * cmd.dy, c.bbox[2] + sign * cmd.dx, c.bbox[3] + sign * cmd.dy],
              edited: true,
            }
          : c,
      );
      break;
    }
    case 'char.batchBbox': {
      p.chars = p.chars.map((c) => {
        const patch = direction === 'do' ? cmd.after[c.id] : cmd.before[c.id];
        return patch ? { ...c, ...patch, edited: true } : c;
      });
      break;
    }
    case 'char.batchResize': {
      const idSet = new Set(cmd.ids);
      p.chars = p.chars.map((c) => {
        if (!idSet.has(c.id)) return c;
        const pt =
          direction === 'do'
            ? (cmd.afterPts?.[c.id] ?? cmd.pt ?? c.pt)
            : (cmd.beforePts[c.id] ?? c.pt);
        return { ...c, pt, edited: true };
      });
      break;
    }
    case 'line.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.treeLines = p.treeLines.map((l) => (l.id === cmd.id ? { ...l, ...patch } : l));
      break;
    }
    case 'line.batchMove': {
      const sign = direction === 'do' ? 1 : -1;
      const idSet = new Set(cmd.ids);
      p.treeLines = p.treeLines.map((l) =>
        idSet.has(l.id)
          ? {
              ...l,
              x1: l.x1 + sign * cmd.dx,
              y1: l.y1 + sign * cmd.dy,
              x2: l.x2 + sign * cmd.dx,
              y2: l.y2 + sign * cmd.dy,
            }
          : l,
      );
      break;
    }
    case 'line.add': {
      p.treeLines = direction === 'do' ? [...p.treeLines, cmd.line] : p.treeLines.filter((line) => line.id !== cmd.line.id);
      break;
    }
    case 'line.remove': {
      p.treeLines = direction === 'do' ? p.treeLines.filter((line) => line.id !== cmd.line.id) : [...p.treeLines, cmd.line];
      break;
    }
    case 'node.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.treeNodes = p.treeNodes.map((n) => (n.id === cmd.id ? { ...n, ...patch } : n));
      break;
    }
    case 'node.batchMove': {
      const sign = direction === 'do' ? 1 : -1;
      const idSet = new Set(cmd.ids);
      p.treeNodes = p.treeNodes.map((n) =>
        idSet.has(n.id) ? { ...n, cx: n.cx + sign * cmd.dx, cy: n.cy + sign * cmd.dy } : n,
      );
      break;
    }
    case 'node.add': {
      p.treeNodes = direction === 'do' ? [...p.treeNodes, cmd.node] : p.treeNodes.filter((node) => node.id !== cmd.node.id);
      break;
    }
    case 'node.remove': {
      p.treeNodes = direction === 'do' ? p.treeNodes.filter((node) => node.id !== cmd.node.id) : [...p.treeNodes, cmd.node];
      break;
    }
    case 'rect.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.borderRects = p.borderRects.map((r) => (r.id === cmd.id ? { ...r, ...patch } : r));
      p.tagRects = p.tagRects.map((r) => (r.id === cmd.id ? { ...r, ...patch } : r));
      break;
    }
    case 'rect.batchMove': {
      const sign = direction === 'do' ? 1 : -1;
      const idSet = new Set(cmd.ids);
      p.borderRects = p.borderRects.map((r) => (idSet.has(r.id) ? { ...r, x: r.x + sign * cmd.dx, y: r.y + sign * cmd.dy } : r));
      p.tagRects = p.tagRects.map((r) => (idSet.has(r.id) ? { ...r, x: r.x + sign * cmd.dx, y: r.y + sign * cmd.dy } : r));
      break;
    }
    case 'rect.add': {
      if (cmd.kind === 'border') {
        p.borderRects = direction === 'do' ? [...p.borderRects, cmd.rect] : p.borderRects.filter((rect) => rect.id !== cmd.rect.id);
      } else {
        p.tagRects = direction === 'do' ? [...p.tagRects, cmd.rect] : p.tagRects.filter((rect) => rect.id !== cmd.rect.id);
      }
      break;
    }
    case 'rect.remove': {
      if (cmd.kind === 'border') {
        p.borderRects = direction === 'do' ? p.borderRects.filter((rect) => rect.id !== cmd.rect.id) : [...p.borderRects, cmd.rect];
      } else {
        p.tagRects = direction === 'do' ? p.tagRects.filter((rect) => rect.id !== cmd.rect.id) : [...p.tagRects, cmd.rect];
      }
      break;
    }
  }
  return p;
}

function persistStacks(pageId: string, undoStack: EditCommand[], redoStack: EditCommand[]): void {
  void saveUndoStack({ pageId, undoStack, redoStack });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  selectedCharIds: [],
  selectedLineIds: [],
  selectedNodeIds: [],
  selectedRectIds: [],
  transform: { scale: 0.2, offsetX: 0, offsetY: 0 },
  canvasViewSize: { w: 0, h: 0 },
  overlayMode: 'split',
  overlayOpacity: 0.5,
  lowConfCursor: 0,
  lowConfHoverId: null,
  showRulers: false,
  rubberBand: null,
  undoStack: [],
  redoStack: [],
  stackPageId: null,

  setSelection: (ids) =>
    set({ selectedCharIds: ids, selectedLineIds: [], selectedNodeIds: [], selectedRectIds: [] }),
  setRegionSelection: (charIds, lineIds, nodeIds, rectIds) =>
    set({ selectedCharIds: charIds, selectedLineIds: lineIds, selectedNodeIds: nodeIds, selectedRectIds: rectIds }),
  setSelectedLine: (id) =>
    set({
      selectedLineIds: id ? [id] : [],
      selectedCharIds: id ? [] : get().selectedCharIds,
      selectedNodeIds: [],
      selectedRectIds: [],
    }),
  setSelectedNode: (id) =>
    set({
      selectedNodeIds: id ? [id] : [],
      selectedCharIds: id ? [] : get().selectedCharIds,
      selectedLineIds: [],
      selectedRectIds: [],
    }),
  setSelectedRect: (id) =>
    set({
      selectedRectIds: id ? [id] : [],
      selectedCharIds: id ? [] : get().selectedCharIds,
      selectedLineIds: [],
      selectedNodeIds: [],
    }),
  setTransform: (t) => set((s) => ({ transform: { ...s.transform, ...t } })),
  setCanvasViewSize: (size) => set({ canvasViewSize: size }),
  centerOnChar: (cx, cy) => {
    const { canvasViewSize, transform } = get();
    const { w, h } = canvasViewSize;
    if (w <= 0 || h <= 0) return;
    set({ transform: computeCenterOnPoint(cx, cy, w, h, transform.scale) });
  },
  setOverlayMode: (m) => set({ overlayMode: m }),
  setOverlayOpacity: (v) => set({ overlayOpacity: v }),
  setLowConfCursor: (i) => set({ lowConfCursor: i }),
  setLowConfHoverId: (id) => set({ lowConfHoverId: id }),
  setShowRulers: (v) => set({ showRulers: v }),
  setRubberBand: (band) => set({ rubberBand: band }),

  loadStacks: async (pageId) => {
    if (get().stackPageId === pageId) return;
    const record = await loadUndoStack(pageId);
    set({
      stackPageId: pageId,
      undoStack: record?.undoStack ?? [],
      redoStack: record?.redoStack ?? [],
      selectedCharIds: [],
      selectedLineIds: [],
      selectedNodeIds: [],
      selectedRectIds: [],
      lowConfCursor: 0,
      lowConfHoverId: null,
      rubberBand: null,
    });
  },

  apply: (cmd) => {
    const projectStore = useProjectStore.getState();
    const page = projectStore.currentPage();
    if (!page) return;
    let next = applyCommandToPage(page, cmd, 'do');
    // 首次人工修改后状态推进为「已校对」
    if (next.status === 'analyzed' || next.status === 'recognized') {
      next = { ...next, status: 'proofread' };
    }
    projectStore.updatePage(page.id, next);
    if (cmd.type === 'char.update' && typeof cmd.after.text === 'string' && cmd.after.source === 'manual') {
      void learnManualCorrection(next, cmd.charId, cmd.after.text).catch(() => undefined);
    }
    set((s) => {
      const undoStack = [...s.undoStack, cmd].slice(-UNDO_LIMIT);
      persistStacks(page.id, undoStack, []);
      return { undoStack, redoStack: [] };
    });
  },

  undo: () => {
    const projectStore = useProjectStore.getState();
    const page = projectStore.currentPage();
    const s = get();
    if (!page || s.undoStack.length === 0) return;
    const cmd = s.undoStack[s.undoStack.length - 1];
    const next = applyCommandToPage(page, cmd, 'undo');
    projectStore.updatePage(page.id, next);
    const undoStack = s.undoStack.slice(0, -1);
    const redoStack = [...s.redoStack, cmd];
    persistStacks(page.id, undoStack, redoStack);
    set({ undoStack, redoStack });
  },

  redo: () => {
    const projectStore = useProjectStore.getState();
    const page = projectStore.currentPage();
    const s = get();
    if (!page || s.redoStack.length === 0) return;
    const cmd = s.redoStack[s.redoStack.length - 1];
    const next = applyCommandToPage(page, cmd, 'do');
    projectStore.updatePage(page.id, next);
    const redoStack = s.redoStack.slice(0, -1);
    const undoStack = [...s.undoStack, cmd].slice(-UNDO_LIMIT);
    persistStacks(page.id, undoStack, redoStack);
    set({ undoStack, redoStack });
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
}));
