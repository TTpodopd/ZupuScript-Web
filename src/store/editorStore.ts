/**
 * 校对编辑器状态：选中集、视图变换（左右栏联动）、撤销/重做命令栈。
 * 共享约定：所有校对修改必须经 EditCommand 走 apply()，禁止直接改 page 数据；
 * 栈深 ≥100，每次变更同步写 idb，刷新后可恢复。
 */
import { create } from 'zustand';
import { UNDO_LIMIT } from '@/lib/constants';
import type { CharItem, Page } from '@/model/types';
import { loadUndoStack, saveUndoStack } from '@/storage/db';
import { useProjectStore } from './projectStore';

/** 编辑命令（before/after 保证可逆） */
export type EditCommand =
  | { type: 'char.update'; charId: string; before: Partial<CharItem>; after: Partial<CharItem> }
  | { type: 'char.add'; char: CharItem }
  | { type: 'char.remove'; char: CharItem }
  | { type: 'char.batchMove'; ids: string[]; dx: number; dy: number }
  | { type: 'char.batchResize'; ids: string[]; beforePts: Record<string, number>; pt: number }
  | { type: 'line.update'; id: string; before: Record<string, number>; after: Record<string, number> }
  | { type: 'node.update'; id: string; before: Record<string, number>; after: Record<string, number> }
  | { type: 'rect.update'; id: string; before: Record<string, number>; after: Record<string, number> };

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export type OverlayMode = 'split' | 'overlay';

interface EditorState {
  selectedCharIds: string[];
  selectedLineId: string | null;
  selectedNodeId: string | null;
  transform: ViewTransform;
  overlayMode: OverlayMode;
  overlayOpacity: number;
  /** 低置信面板当前索引（Tab 逐条跳转） */
  lowConfCursor: number;
  undoStack: EditCommand[];
  redoStack: EditCommand[];
  /** 当前撤销栈对应的页面 */
  stackPageId: string | null;

  setSelection: (ids: string[]) => void;
  setSelectedLine: (id: string | null) => void;
  setSelectedNode: (id: string | null) => void;
  setTransform: (t: Partial<ViewTransform>) => void;
  setOverlayMode: (m: OverlayMode) => void;
  setOverlayOpacity: (v: number) => void;
  setLowConfCursor: (i: number) => void;

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
    case 'char.batchResize': {
      const idSet = new Set(cmd.ids);
      p.chars = p.chars.map((c) =>
        idSet.has(c.id)
          ? { ...c, pt: direction === 'do' ? cmd.pt : cmd.beforePts[c.id] ?? c.pt, edited: true }
          : c,
      );
      break;
    }
    case 'line.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.treeLines = p.treeLines.map((l) => (l.id === cmd.id ? { ...l, ...patch } : l));
      break;
    }
    case 'node.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.treeNodes = p.treeNodes.map((n) => (n.id === cmd.id ? { ...n, ...patch } : n));
      break;
    }
    case 'rect.update': {
      const patch = direction === 'do' ? cmd.after : cmd.before;
      p.borderRects = p.borderRects.map((r) => (r.id === cmd.id ? { ...r, ...patch } : r));
      p.tagRects = p.tagRects.map((r) => (r.id === cmd.id ? { ...r, ...patch } : r));
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
  selectedLineId: null,
  selectedNodeId: null,
  transform: { scale: 0.2, offsetX: 0, offsetY: 0 },
  overlayMode: 'split',
  overlayOpacity: 0.5,
  lowConfCursor: 0,
  undoStack: [],
  redoStack: [],
  stackPageId: null,

  setSelection: (ids) => set({ selectedCharIds: ids, selectedLineId: null, selectedNodeId: null }),
  setSelectedLine: (id) => set({ selectedLineId: id, selectedCharIds: id ? [] : get().selectedCharIds, selectedNodeId: null }),
  setSelectedNode: (id) => set({ selectedNodeId: id, selectedCharIds: id ? [] : get().selectedCharIds, selectedLineId: null }),
  setTransform: (t) => set((s) => ({ transform: { ...s.transform, ...t } })),
  setOverlayMode: (m) => set({ overlayMode: m }),
  setOverlayOpacity: (v) => set({ overlayOpacity: v }),
  setLowConfCursor: (i) => set({ lowConfCursor: i }),

  loadStacks: async (pageId) => {
    if (get().stackPageId === pageId) return;
    const record = await loadUndoStack(pageId);
    set({
      stackPageId: pageId,
      undoStack: record?.undoStack ?? [],
      redoStack: record?.redoStack ?? [],
      selectedCharIds: [],
      selectedLineId: null,
      selectedNodeId: null,
      lowConfCursor: 0,
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
