/**
 * store/settingsStore.ts：首次启动默认选中并使用本地模型。
 * - 场景 A（首次启动，无已存设置）：activeConnection = local-engine、privacyMode = A、provider = local，识别路由为 A 模式（Tesseract）；
 * - 场景 B（老用户，已有云端设置）：persist merge 恢复已存设置，不被新默认值覆盖。
 * 运行：node --experimental-strip-types --no-warnings --loader ./tests/alias-loader.mjs tests/settings-defaults.test.mjs
 */
import { check, eq, section, summary } from './helpers.mjs';

// Node 无原生 localStorage：mock 一个同步存储，zustand persist 可正常 rehydrate。
// 注意：zustand 默认 createJSONStorage(() => window.localStorage) 走 window 全局，
// 只 mock localStorage 不够，必须同时提供 window，否则 persist 短路、api 不挂载。
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? String(backing.get(k)) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
  key: (i) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
};
globalThis.window = { localStorage: globalThis.localStorage };

section('场景 A：首次启动（空 localStorage）默认本地模型');
const { useSettingsStore, LOCAL_MODEL_CONNECTION_ID } = await import('../src/store/settingsStore.ts');
const fresh = useSettingsStore.getState();

eq('activeConnectionId 为本地分组', fresh.activeConnectionId, LOCAL_MODEL_CONNECTION_ID);
eq('activeModelId 为 local-tesseract', fresh.activeModelId, 'local-tesseract');
eq('privacyMode 为 A', fresh.privacyMode, 'A');
eq('provider.provider 为 local', fresh.provider.provider, 'local');
eq('provider.model 为 local-tesseract', fresh.provider.model, 'local-tesseract');
check('connections 首位为本地分组', fresh.connections[0]?.id === LOCAL_MODEL_CONNECTION_ID);
check('本地分组默认展开', fresh.connections[0]?.expanded === true);

section('场景 A：识别路由解析为本地（A 模式）');
const { resolveRecognitionMode, isLocalRecognitionMode, describeActiveModel } = await import('../src/recognize/buildConfig.ts');
eq('resolveRecognitionMode 为 A', resolveRecognitionMode(), 'A');
check('isLocalRecognitionMode 为 true', isLocalRecognitionMode() === true);
eq('describeActiveModel 展示本地模型', describeActiveModel(), '本地模型（Tesseract）');

section('场景 B：老用户已存云端设置不被新默认值覆盖');
// 模拟 v2.0 旧默认（gemini + C 模式）已持久化，再走一次启动时 persist rehydrate
backing.set('zupuscript-settings', JSON.stringify({
  state: {
    privacyMode: 'C',
    provider: { provider: 'gemini', model: 'gemini-2.0-flash', endpoint: '', proxyUrl: '' },
    activeConnectionId: 'official-gemini',
    activeModelId: 'gemini-2.0-flash',
  },
  version: 0,
}));
await useSettingsStore.persist.rehydrate();
const saved = useSettingsStore.getState();

eq('老用户恢复 activeConnectionId = official-gemini', saved.activeConnectionId, 'official-gemini');
eq('老用户恢复 activeModelId = gemini-2.0-flash', saved.activeModelId, 'gemini-2.0-flash');
eq('老用户恢复 privacyMode = C', saved.privacyMode, 'C');
eq('老用户识别路由为 C（整页上云）', resolveRecognitionMode(), 'C');

summary();
