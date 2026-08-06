/**
 * 设置状态：隐私模式、Provider 配置、并发/超时/重试、预算护栏、UI 偏好、批处理队列（P1 预留）。
 * 非敏感配置持久化到 localStorage；API Key 一律走 privacy/keystore，绝不进此 store。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_PAGE_BUDGET_CNY,
  DEFAULT_PROJECT_BUDGET_CNY,
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
} from '@/lib/constants';
import type { PrivacyMode } from '@/model/types';
import type { ProviderId } from '@/recognize/types';

export interface ProviderSettings {
  provider: ProviderId;
  model: string;
  endpoint: string;
  proxyUrl: string;
}

/** 批处理队列任务（P1 预留类型，极简实现只顺序跑本地分析） */
export interface BatchTask {
  pageId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  error?: string;
}

interface SettingsState {
  privacyMode: PrivacyMode;
  provider: ProviderSettings;
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  pageBudgetCny: number;
  projectBudgetCny: number;
  /** 本次会话累计成本（元） */
  sessionCostCny: number;
  darkMode: boolean;
  batchQueue: BatchTask[];

  setPrivacyMode: (m: PrivacyMode) => void;
  setProvider: (patch: Partial<ProviderSettings>) => void;
  setConcurrency: (n: number) => void;
  setTimeoutMs: (n: number) => void;
  setMaxRetries: (n: number) => void;
  setPageBudgetCny: (n: number) => void;
  setProjectBudgetCny: (n: number) => void;
  addSessionCost: (n: number) => void;
  toggleDarkMode: () => void;
  setBatchQueue: (q: BatchTask[]) => void;
  updateBatchTask: (pageId: string, patch: Partial<BatchTask>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      privacyMode: 'B',
      provider: { provider: 'gemini', model: 'gemini-2.0-flash', endpoint: '', proxyUrl: '' },
      concurrency: 3,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      pageBudgetCny: DEFAULT_PAGE_BUDGET_CNY,
      projectBudgetCny: DEFAULT_PROJECT_BUDGET_CNY,
      sessionCostCny: 0,
      darkMode: false,
      batchQueue: [],

      setPrivacyMode: (m) => set({ privacyMode: m }),
      setProvider: (patch) => set((s) => ({ provider: { ...s.provider, ...patch } })),
      setConcurrency: (n) => set({ concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n) || 1)) }),
      setTimeoutMs: (n) => set({ timeoutMs: Math.max(5000, n) }),
      setMaxRetries: (n) => set({ maxRetries: Math.max(0, Math.min(5, Math.floor(n))) }),
      setPageBudgetCny: (n) => set({ pageBudgetCny: Math.max(0, n) }),
      setProjectBudgetCny: (n) => set({ projectBudgetCny: Math.max(0, n) }),
      addSessionCost: (n) => set((s) => ({ sessionCostCny: s.sessionCostCny + n })),
      toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
      setBatchQueue: (q) => set({ batchQueue: q }),
      updateBatchTask: (pageId, patch) =>
        set((s) => ({
          batchQueue: s.batchQueue.map((t) => (t.pageId === pageId ? { ...t, ...patch } : t)),
        })),
    }),
    {
      name: 'zupuscript-settings',
      // 密钥不在此 store，无需过滤；但仍显式排除批处理队列等瞬态
      partialize: (s) => ({
        privacyMode: s.privacyMode,
        provider: s.provider,
        concurrency: s.concurrency,
        timeoutMs: s.timeoutMs,
        maxRetries: s.maxRetries,
        pageBudgetCny: s.pageBudgetCny,
        projectBudgetCny: s.projectBudgetCny,
        darkMode: s.darkMode,
      }),
    },
  ),
);
