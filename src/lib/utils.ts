import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Page } from '@/model/types';

/** shadcn 约定的类名合并工具 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 统一 ID 生成（共享约定：一律 crypto.randomUUID()） */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // 兜底（非安全上下文，如 file:// 旧浏览器）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 防抖 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

/** 自然排序比较（"p2" < "p10"），用于文件夹批量导入（F1.3） */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/** ArrayBuffer → base64（分块避免栈溢出） */
export function arrayBufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return arrayBufferToBase64(buf);
}

/** 触发浏览器下载（UTF-8 无 BOM） */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/** 简单 FNV-1a 哈希（用于识别结果缓存键，非加密用途） */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 异步并发池（限制并发数，用于大模型批量请求） */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** 指数退避等待 */
export function backoffDelay(attempt: number, baseMs = 1000): Promise<void> {
  const ms = baseMs * Math.pow(2, attempt) + Math.random() * 200;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尚未完成识别、需要跑分析管线的页面 */
export function pagesPendingAnalysis(pages: Page[]): Page[] {
  return pages.filter((p) => p.status === 'imported' || p.status === 'preprocessed' || p.status === 'analyzed');
}

/** 切换识别模式后需重新 OCR 的页面（已有分割结果） */
export function pageHasPoorRecognition(page: Page): boolean {
  if (page.chars.length < 8) return false;
  if (page.status !== 'recognized' && page.status !== 'proofread' && page.status !== 'exported') return false;
  const empty = page.chars.filter((c) => !c.text?.trim()).length;
  return empty / page.chars.length >= 0.25;
}

export function pagesNeedingReRecognition(pages: Page[], recognitionSettingsKey: string): Page[] {
  return pages.filter((p) => {
    if (p.chars.length === 0) return false;
    if (p.status !== 'recognized' && p.status !== 'proofread' && p.status !== 'exported') return false;
    if (pageHasPoorRecognition(p)) return true;
    const stored = inferPageRecognitionSettingsKey(p);
    if (!stored) return false;
    return stored !== recognitionSettingsKey;
  });
}

/** 从 recognition 元数据推断设置签名（兼容旧项目无 settingsKey） */
export function inferPageRecognitionSettingsKey(page: Page): string | null {
  const r = page.recognition;
  if (!r) return null;
  if (r.settingsKey) return r.settingsKey;
  if (r.provider === 'local') return `A:local-engine:local-tesseract`;
  return `${r.mode}:${r.provider}:${r.model}`;
}

/** 批处理队列：待分析页 + 模式切换后需重识别的页 */
export function pagesForBatchProcessing(pages: Page[], recognitionSettingsKey: string): Page[] {
  const seen = new Set<string>();
  const out: Page[] = [];
  for (const p of [...pagesPendingAnalysis(pages), ...pagesNeedingReRecognition(pages, recognitionSettingsKey)]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 待分析页面 id 签名，用于判断是否有新增页需要批处理 */
export function pendingAnalysisSignature(pages: Page[]): string {
  return pagesPendingAnalysis(pages)
    .map((p) => p.id)
    .sort()
    .join(',');
}

/** 批处理签名（含识别模式），用于避免重复启动或检测模式切换 */
export function batchProcessingSignature(pages: Page[], recognitionSettingsKey: string): string {
  return pagesForBatchProcessing(pages, recognitionSettingsKey)
    .map((p) => p.id)
    .sort()
    .join(',');
}
