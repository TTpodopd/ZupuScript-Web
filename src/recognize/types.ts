/**
 * 识别层契约（ARCHITECTURE 3.2）：Provider 抽象、请求/结果类型。
 * 网络出网只允许发生在 orchestrator.ts（经 Provider），禁止任何遥测/埋点。
 */
import type { CharNote, PrivacyMode } from '@/model/types';

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'custom' | 'local';

export interface ProviderConfig {
  provider: ProviderId;
  /** 来自 privacy/keystore，绝不进 .zpproj.json */
  apiKey?: string;
  /** custom 必填；其余用默认 */
  endpoint?: string;
  /** 可选无状态 Edge 代理，默认空 */
  proxyUrl?: string;
  model: string;
  /** ≤5 */
  concurrency: number;
  /** 默认 60000 */
  timeoutMs: number;
  /** 默认 3，指数退避 */
  maxRetries: number;
}

/** B 模式：一张拼图对应一批 */
export interface GridBatch {
  batchIndex: number;
  /** 10×10 编号网格 PNG（base64，无 data: 前缀），编号已打乱 */
  imageBase64Png: string;
  /** ids[显示编号] = 批内字符下标 */
  ids: number[];
}

export interface RecognizeBatchRequest {
  mode: 'B' | 'C';
  /** B 模式拼图 */
  batch?: GridBatch;
  /** C 模式整页图（base64，无 data: 前缀） */
  pageImageBase64?: string;
  /** C 模式提示用的行列描述 */
  pageHint?: string;
  /** 二次综合校验时附带的初次模型输出，不改变图像坐标。 */
  promptOverride?: string;
  signal: AbortSignal;
}

export interface RecognizedItem {
  id: number;
  char: string | null;
  confidence: number;
  note?: CharNote;
  /** 规范简化字（可选，由模型返回供消歧用） */
  simplified?: string;
  /** 形近候选字（可选，看不清时模型返回 1-3 个候选） */
  candidates?: string[];
}

/** C 模式返回项：带相对坐标用于与本地分割匹配校验 */
export interface RecognizedPageItem extends RecognizedItem {
  /** 相对坐标 0..1 */
  rx: number;
  ry: number;
}

export interface RecognizeBatchResult {
  /** 数量守恒：必须等于输入格数 */
  items: RecognizedItem[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface RecognizePageResult {
  items: RecognizedPageItem[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  id: ProviderId;
  label: string;
  needsKey: boolean;
  defaultEndpoint: string;
  defaultModel: string;
  /** B 模式：识别一张编号拼图 */
  recognize(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizeBatchResult>;
  /** C 模式：整页识别（默认实现可复用 recognize，provider 可自行覆盖） */
  recognizePageImage?(req: RecognizeBatchRequest, cfg: ProviderConfig): Promise<RecognizePageResult>;
  testConnection?(cfg: ProviderConfig): Promise<void>;
  /** 粗略成本估算（元/字），用于调用前预估 */
  estimateCost(charCount: number): number;
}

export interface RecognizeProgress {
  totalBatches: number;
  doneBatches: number;
  failedBatches: number;
  recognizedChars: number;
  totalChars: number;
  costCny: number;
  message: string;
}

export interface RecognizePageOutcome {
  /** 写回识别结果后的字符表（未修改坐标） */
  updatedCount: number;
  batches: number;
  failedBatches: number;
  costCny: number;
  usage: { promptTokens: number; completionTokens: number };
  mode: PrivacyMode;
}
