/**
 * 项目/页面/图元/字符 状态与 CRUD。
 * 共享约定：store 不持有位图，只存元数据 + OPFS imageKey；位图即用即取即释放。
 */
import { create } from 'zustand';
import type { Page, PageStatus, Project } from '@/model/types';
import {
  deletePageRecord,
  deleteProjectRecord,
  listPagesOfProject,
  listProjects,
  savePage,
  saveProject,
} from '@/storage/db';
import { deleteImage } from '@/storage/opfs';
import { debounce, uuid } from '@/lib/utils';

/** 顶层视图（无 react-router，状态驱动切换） */
export type ViewId = 'projects' | 'import' | 'analyze' | 'editor' | 'export';

interface ProjectState {
  view: ViewId;
  projects: Project[];
  /** 当前项目与当前页（编辑器聚焦对象） */
  currentProjectId: string | null;
  currentPageId: string | null;
  /** 当前项目的页面列表（元数据） */
  pages: Page[];
  loaded: boolean;

  setView: (view: ViewId) => void;
  loadFromDB: () => Promise<void>;
  createProject: (name: string) => Project;
  openProject: (projectId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => void;
  addPages: (pages: Page[]) => void;
  updatePage: (pageId: string, patch: Partial<Page>) => void;
  removePage: (pageId: string) => Promise<void>;
  setCurrentPage: (pageId: string) => void;
  setPageStatus: (pageId: string, status: PageStatus) => void;
  currentProject: () => Project | undefined;
  currentPage: () => Page | undefined;
}

/** 持久化（防抖，避免高频编辑抖动写库） */
const persistPage = debounce((page: Page) => {
  void savePage(page);
}, 300);

export const useProjectStore = create<ProjectState>((set, get) => ({
  view: 'projects',
  projects: [],
  currentProjectId: null,
  currentPageId: null,
  pages: [],
  loaded: false,

  setView: (view) => set({ view }),

  loadFromDB: async () => {
    const projects = await listProjects();
    set({ projects, loaded: true });
  },

  createProject: (name) => {
    const now = Date.now();
    const project: Project = { id: uuid(), name, createdAt: now, updatedAt: now, pageIds: [] };
    void saveProject(project);
    set((s) => ({
      projects: [project, ...s.projects],
      currentProjectId: project.id,
      pages: [],
      currentPageId: null,
    }));
    return project;
  },

  openProject: async (projectId) => {
    const pages = await listPagesOfProject(projectId);
    set({ currentProjectId: projectId, pages, currentPageId: pages[0]?.id ?? null });
  },

  removeProject: async (projectId) => {
    const pages = await listPagesOfProject(projectId);
    for (const p of pages) {
      await deleteImage(p.imageKey).catch(() => undefined);
      if (p.binaryKey) await deleteImage(p.binaryKey).catch(() => undefined);
    }
    await deleteProjectRecord(projectId);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      currentProjectId: s.currentProjectId === projectId ? null : s.currentProjectId,
      pages: s.currentProjectId === projectId ? [] : s.pages,
      currentPageId: s.currentProjectId === projectId ? null : s.currentPageId,
      view: s.currentProjectId === projectId ? 'projects' : s.view,
    }));
  },

  renameProject: (projectId, name) => {
    set((s) => {
      const projects = s.projects.map((p) => (p.id === projectId ? { ...p, name, updatedAt: Date.now() } : p));
      const target = projects.find((p) => p.id === projectId);
      if (target) void saveProject(target);
      return { projects };
    });
  },

  addPages: (newPages) => {
    set((s) => {
      const pages = [...s.pages, ...newPages].sort((a, b) => a.index - b.index);
      const projects = s.projects.map((p) =>
        p.id === s.currentProjectId
          ? { ...p, pageIds: pages.map((x) => x.id), updatedAt: Date.now() }
          : p,
      );
      const proj = projects.find((p) => p.id === s.currentProjectId);
      if (proj) void saveProject(proj);
      for (const p of newPages) void savePage(p);
      return {
        pages,
        projects,
        currentPageId: s.currentPageId ?? newPages[0]?.id ?? null,
      };
    });
  },

  updatePage: (pageId, patch) => {
    set((s) => {
      const pages = s.pages.map((p) => (p.id === pageId ? { ...p, ...patch } : p));
      const updated = pages.find((p) => p.id === pageId);
      const project = updated ? s.projects.find((p) => p.id === updated.projectId) : undefined;
      const projects = project
        ? s.projects.map((p) => (p.id === project.id ? { ...p, updatedAt: Date.now() } : p))
        : s.projects;
      if (updated) persistPage(updated);
      const changedProject = project ? projects.find((p) => p.id === project.id) : undefined;
      if (changedProject) void saveProject(changedProject);
      return { pages, projects };
    });
  },

  removePage: async (pageId) => {
    const page = get().pages.find((p) => p.id === pageId);
    if (page) {
      await deleteImage(page.imageKey).catch(() => undefined);
      if (page.binaryKey) await deleteImage(page.binaryKey).catch(() => undefined);
    }
    await deletePageRecord(pageId);
    set((s) => {
      const pages = s.pages.filter((p) => p.id !== pageId);
      const projects = s.projects.map((p) =>
        p.id === s.currentProjectId ? { ...p, pageIds: pages.map((x) => x.id), updatedAt: Date.now() } : p,
      );
      const project = projects.find((p) => p.id === s.currentProjectId);
      if (project) void saveProject(project);
      return {
        pages,
        projects,
        currentPageId: s.currentPageId === pageId ? pages[0]?.id ?? null : s.currentPageId,
      };
    });
  },

  setCurrentPage: (pageId) => set({ currentPageId: pageId }),

  setPageStatus: (pageId, status) => get().updatePage(pageId, { status }),

  currentProject: () => {
    const s = get();
    return s.projects.find((p) => p.id === s.currentProjectId);
  },

  currentPage: () => {
    const s = get();
    return s.pages.find((p) => p.id === s.currentPageId);
  },
}));
