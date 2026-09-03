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

/** 设置里「本地模型」分组的固定 id */
export const LOCAL_MODEL_CONNECTION_ID = 'local-engine';

export const LOCAL_MODEL_CONNECTION: ModelConnection = {
  id: LOCAL_MODEL_CONNECTION_ID,
  kind: 'local',
  name: '本地模型',
  description: 'Tesseract 本地 OCR + 本地 CV 算法，图像不出本机，不调用任何云端接口。',
  provider: 'local',
  endpoint: '',
  proxyUrl: '',
  models: [{ id: 'local-tesseract', name: 'Tesseract（chi_tra）' }],
  expanded: true,
};

export interface ProviderSettings {
  provider: ProviderId;
  model: string;
  endpoint: string;
  proxyUrl: string;
}

export interface ModelEntry {
  /** Stable UI identity; independent from the editable API model id. */
  uiKey?: string;
  id: string;
  name: string;
}

export interface ModelConnection {
  id: string;
  kind: 'official' | 'compatible' | 'local';
  name: string;
  description: string;
  provider: ProviderId;
  endpoint: string;
  proxyUrl: string;
  models: ModelEntry[];
  expanded: boolean;
}

export const DEFAULT_MODEL_CONNECTIONS: ModelConnection[] = [
  {
    id: 'official-gemini',
    kind: 'official',
    name: 'Gemini API',
    description: 'Google Gemini 多模态模型。',
    provider: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com',
    proxyUrl: '',
    models: [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }],
    expanded: false,
  },
  {
    id: 'official-openai',
    kind: 'official',
    name: 'OpenAI API',
    description: 'OpenAI 官方多模态模型。',
    provider: 'openai',
    endpoint: 'https://api.openai.com',
    proxyUrl: '',
    models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }],
    expanded: false,
  },
  {
    id: 'official-anthropic',
    kind: 'official',
    name: 'Anthropic API',
    description: 'Claude 多模态模型。',
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    proxyUrl: '',
    models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    expanded: false,
  },
  {
    id: 'official-deepseek',
    kind: 'official',
    name: 'DeepSeek API',
    description: 'DeepSeek 官方 OpenAI 兼容接口。保存 Key 后加密存于本机，下次打开无需重填。',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    proxyUrl: '',
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    expanded: false,
  },
  {
    id: 'compatible-default',
    kind: 'compatible',
    name: '自定义分组',
    description: '云赛、OpenAI、New API 等 OpenAI 协议兼容服务。',
    provider: 'custom',
    endpoint: '',
    proxyUrl: '',
    models: [{ id: 'qwen-vl-max', name: 'qwen-vl-max' }],
    expanded: false,
  },
];

function ensureModelUiKeys(connections: ModelConnection[]): ModelConnection[] {
  return connections.map((connection) => {
    const used = new Set<string>();
    const models = connection.models.map((model, index) => {
      let uiKey = model.uiKey && !used.has(model.uiKey) ? model.uiKey : connection.id + '-model-' + index;
      while (used.has(uiKey)) uiKey = uiKey + '-' + index;
      used.add(uiKey);
      return { ...model, uiKey };
    });
    return { ...connection, models };
  });
}

function ensureLocalConnection(connections: ModelConnection[]): ModelConnection[] {
  const rest = connections
    .filter((c) => c.id !== LOCAL_MODEL_CONNECTION_ID)
    .map((c) => ({ ...c, expanded: false }));
  return ensureModelUiKeys([LOCAL_MODEL_CONNECTION, ...rest]);
}

/** 为已持久化设置补全新增的官方分组（如 DeepSeek） */
function migrateConnections(connections: ModelConnection[]): ModelConnection[] {
  let next = [...connections];
  for (const defaults of DEFAULT_MODEL_CONNECTIONS) {
    if (defaults.kind !== 'official') continue;
    if (next.some((c) => c.id === defaults.id)) continue;
    const anchor = next.findIndex((c) => c.id === 'official-anthropic');
    next.splice(anchor >= 0 ? anchor + 1 : next.length, 0, { ...defaults });
  }
  return next;
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
  connections: ModelConnection[];
  activeConnectionId: string;
  activeModelId: string;
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  pageBudgetCny: number;
  projectBudgetCny: number;
  /** 本次会话累计成本（元） */
  sessionCostCny: number;
  darkMode: boolean;
  /** 输出字形：原字形（默认，1:1复刻）或简化字 */
  outputScript: 'original' | 'simplified';
  batchQueue: BatchTask[];

  setPrivacyMode: (m: PrivacyMode) => void;
  setProvider: (patch: Partial<ProviderSettings>) => void;
  setActiveConnection: (connectionId: string) => void;
  setActiveModel: (modelId: string) => void;
  updateConnection: (connectionId: string, patch: Partial<ModelConnection>) => void;
  toggleConnection: (connectionId: string) => void;
  addConnection: (kind?: ModelConnection['kind']) => string;
  removeConnection: (connectionId: string) => void;
  addModel: (connectionId: string) => void;
  removeModel: (connectionId: string, modelUiKey: string) => void;
  updateModel: (connectionId: string, modelUiKey: string, patch: Partial<Omit<ModelEntry, 'uiKey'>>) => void;
  activeConnection: () => ModelConnection | undefined;
  setConcurrency: (n: number) => void;
  setTimeoutMs: (n: number) => void;
  setMaxRetries: (n: number) => void;
  setPageBudgetCny: (n: number) => void;
  setProjectBudgetCny: (n: number) => void;
  addSessionCost: (n: number) => void;
  toggleDarkMode: () => void;
  setOutputScript: (s: 'original' | 'simplified') => void;
  setBatchQueue: (q: BatchTask[]) => void;
  updateBatchTask: (pageId: string, patch: Partial<BatchTask>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // 首次启动（无已存设置）默认选中并使用本地模型：免 API Key、零配置开箱即用；
      // 已有设置经 persist merge 恢复，不受此默认值影响。
      privacyMode: 'A',
      provider: { provider: 'local', model: 'local-tesseract', endpoint: '', proxyUrl: '' },
      connections: ensureLocalConnection(DEFAULT_MODEL_CONNECTIONS),
      activeConnectionId: LOCAL_MODEL_CONNECTION_ID,
      activeModelId: 'local-tesseract',
      concurrency: 3,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      pageBudgetCny: DEFAULT_PAGE_BUDGET_CNY,
      projectBudgetCny: DEFAULT_PROJECT_BUDGET_CNY,
      sessionCostCny: 0,
      darkMode: false,
      outputScript: 'original',
      batchQueue: [],

      setPrivacyMode: (m) => set((s) => {
        const resolved: PrivacyMode = m === 'A' ? 'A' : 'C';
        if (resolved === 'A') {
          const local = s.connections.find((c) => c.id === LOCAL_MODEL_CONNECTION_ID) ?? LOCAL_MODEL_CONNECTION;
          const model = local.models[0]?.id ?? 'local-tesseract';
          return {
            privacyMode: 'A',
            activeConnectionId: local.id,
            activeModelId: model,
            provider: { provider: 'local', model, endpoint: '', proxyUrl: '' },
          };
        }
        if (s.activeConnectionId === LOCAL_MODEL_CONNECTION_ID) {
          const cloud = s.connections.find((c) => c.kind !== 'local') ?? s.connections[0];
          const model = cloud.models[0]?.id ?? '';
          return {
            privacyMode: 'C',
            activeConnectionId: cloud.id,
            activeModelId: model,
            provider: { provider: cloud.provider, model, endpoint: cloud.endpoint, proxyUrl: cloud.proxyUrl },
          };
        }
        return { privacyMode: 'C' };
      }),
      setProvider: (patch) => set((s) => {
        const provider = { ...s.provider, ...patch };
        const active = s.connections.find((c) => c.id === s.activeConnectionId);
        const connections = active
          ? s.connections.map((c) => c.id === active.id
            ? { ...c, provider: provider.provider, endpoint: provider.endpoint, proxyUrl: provider.proxyUrl, models: c.models.some((m) => m.id === provider.model) ? c.models : [...c.models, { id: provider.model, name: provider.model }] }
            : c)
          : s.connections;
        return { provider, connections, activeModelId: provider.model };
      }),
      setActiveConnection: (connectionId) => set((s) => {
        const connection = s.connections.find((c) => c.id === connectionId);
        if (!connection) return s;
        const model = connection.models[0]?.id ?? '';
        const privacyMode: PrivacyMode = connection.kind === 'local' ? 'A' : 'C';
        return {
          activeConnectionId: connectionId,
          activeModelId: model,
          privacyMode,
          provider: { provider: connection.provider, model, endpoint: connection.endpoint, proxyUrl: connection.proxyUrl },
        };
      }),
      setActiveModel: (modelId) => set((s) => {
        const connection = s.connections.find((c) => c.id === s.activeConnectionId);
        if (!connection || !connection.models.some((m) => m.id === modelId)) return s;
        return { activeModelId: modelId, provider: { ...s.provider, provider: connection.provider, model: modelId, endpoint: connection.endpoint, proxyUrl: connection.proxyUrl } };
      }),
      updateConnection: (connectionId, patch) => set((s) => {
        const connections = s.connections.map((c) => c.id === connectionId ? { ...c, ...patch } : c);
        const connection = connections.find((c) => c.id === s.activeConnectionId);
        if (!connection) return { connections };
        const model = connection.models.some((m) => m.id === s.activeModelId) ? s.activeModelId : connection.models[0]?.id ?? '';
        return { connections, activeModelId: model, provider: { provider: connection.provider, model, endpoint: connection.endpoint, proxyUrl: connection.proxyUrl } };
      }),
      toggleConnection: (connectionId) => set((s) => ({ connections: s.connections.map((c) => c.id === connectionId ? { ...c, expanded: !c.expanded } : c) })),
      addConnection: (kind = 'compatible') => {
        const id = `${kind}-${Date.now()}`;
        const connection: ModelConnection = { id, kind, name: kind === 'compatible' ? '新建兼容分组' : '新建官方分组', description: kind === 'compatible' ? 'OpenAI 协议兼容服务。' : '官方模型服务。', provider: kind === 'compatible' ? 'custom' : 'openai', endpoint: '', proxyUrl: '', models: [{ id: `model-${Date.now()}`, name: '' }], expanded: false };
        set((s) => ({ connections: [...s.connections, connection] }));
        return id;
      },
      removeConnection: (connectionId) => set((s) => {
        if (connectionId === LOCAL_MODEL_CONNECTION_ID) return s;
        if (s.connections.length <= 1) return s;
        const connections = s.connections.filter((c) => c.id !== connectionId);
        if (connectionId !== s.activeConnectionId) return { connections };
        const next = connections[0];
        const model = next.models[0]?.id ?? '';
        return { connections, activeConnectionId: next.id, activeModelId: model, provider: { provider: next.provider, model, endpoint: next.endpoint, proxyUrl: next.proxyUrl } };
      }),
      addModel: (connectionId) => set((s) => ({ connections: s.connections.map((c) => c.id === connectionId ? { ...c, models: [...c.models, { id: `model-${Date.now()}-${c.models.length}`, name: '' }] } : c) })),
      removeModel: (connectionId, modelUiKey) => set((s) => ({ connections: s.connections.map((c) => c.id === connectionId ? { ...c, models: c.models.length <= 1 ? c.models : c.models.filter((m, index) => (m.uiKey ?? c.id + '-model-' + index) !== modelUiKey) } : c) })),
      updateModel: (connectionId, modelUiKey, patch) => set((s) => {
        const connection = s.connections.find((c) => c.id === connectionId);
        const previous = connection?.models.find((m, index) => (m.uiKey ?? connection.id + '-model-' + index) === modelUiKey);
        const connections = s.connections.map((c) => c.id === connectionId
          ? { ...c, models: c.models.map((m, index) => (m.uiKey ?? c.id + '-model-' + index) === modelUiKey ? { ...m, ...patch, uiKey: modelUiKey } : m) }
          : c);
        const active = connections.find((c) => c.id === s.activeConnectionId);
        const editingActive = connectionId === s.activeConnectionId && previous?.id === s.activeModelId;
        const nextActiveModelId = editingActive ? patch.id ?? s.activeModelId : s.activeModelId;
        const selected = editingActive
          ? active?.models.find((m) => m.uiKey === modelUiKey)
          : active?.models.find((m) => m.id === nextActiveModelId);
        return active && selected ? { connections, activeModelId: selected.id, provider: { provider: active.provider, model: selected.id, endpoint: active.endpoint, proxyUrl: active.proxyUrl } } : { connections };
      }),
      activeConnection: () => {
        const s = get();
        return s.connections.find((c) => c.id === s.activeConnectionId);
      },
      setConcurrency: (n) => set({ concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n) || 1)) }),
      setTimeoutMs: (n) => set({ timeoutMs: Math.max(5000, n) }),
      setMaxRetries: (n) => set({ maxRetries: Math.max(0, Math.min(5, Math.floor(n))) }),
      setPageBudgetCny: (n) => set({ pageBudgetCny: Math.max(0, n) }),
      setProjectBudgetCny: (n) => set({ projectBudgetCny: Math.max(0, n) }),
      addSessionCost: (n) => set((s) => ({ sessionCostCny: s.sessionCostCny + n })),
      toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
      setOutputScript: (s) => set({ outputScript: s }),
      setBatchQueue: (q) => set({ batchQueue: q }),
      updateBatchTask: (pageId, patch) =>
        set((s) => ({
          batchQueue: s.batchQueue.map((t) => (t.pageId === pageId ? { ...t, ...patch } : t)),
        })),
    }),
    {
      name: 'zupuscript-settings',
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState>;
        const connections = ensureLocalConnection(
          migrateConnections(saved.connections?.length ? saved.connections : current.connections),
        );
        const activeConnectionId = saved.activeConnectionId && connections.some((c) => c.id === saved.activeConnectionId) ? saved.activeConnectionId : current.activeConnectionId;
        const active = connections.find((c) => c.id === activeConnectionId) ?? connections[0];
        const activeModelId = saved.activeModelId && active?.models.some((m) => m.id === saved.activeModelId) ? saved.activeModelId : active?.models[0]?.id ?? current.activeModelId;
        const privacyMode = activeConnectionId === LOCAL_MODEL_CONNECTION_ID
          ? 'A'
          : 'C';
        return {
          ...current,
          ...saved,
          connections,
          activeConnectionId,
          activeModelId,
          privacyMode,
          provider: active ? { provider: active.provider, model: activeModelId, endpoint: active.endpoint, proxyUrl: active.proxyUrl } : current.provider,
        };
      },
      // 密钥不在此 store，无需过滤；但仍显式排除批处理队列等瞬态
      partialize: (s) => ({
        privacyMode: s.privacyMode,
        provider: s.provider,
        connections: s.connections,
        activeConnectionId: s.activeConnectionId,
        activeModelId: s.activeModelId,
        concurrency: s.concurrency,
        timeoutMs: s.timeoutMs,
        maxRetries: s.maxRetries,
        pageBudgetCny: s.pageBudgetCny,
        projectBudgetCny: s.projectBudgetCny,
        darkMode: s.darkMode,
        outputScript: s.outputScript,
      }),
    },
  ),
);
