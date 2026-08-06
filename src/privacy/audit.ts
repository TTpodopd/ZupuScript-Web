/**
 * 隐私审计日志（P1.4）：仅存本地，记录时间/模式/字符数/目标域名，可导出。
 * 保留最近 30 天。绝不记录图像内容、文字内容或 API Key。
 */
import { AUDIT_RETENTION_DAYS, STORE_AUDIT } from '@/lib/constants';
import type { PrivacyMode } from '@/model/types';
import { getDB } from '@/storage/db';
import { uuid } from '@/lib/utils';

export interface AuditEntry {
  id: string;
  ts: number;
  mode: PrivacyMode;
  provider: string;
  /** 目标域名（仅域名，不含路径与参数） */
  domain: string;
  charCount: number;
  batches: number;
  pageId?: string;
}

/** 写入一条审计记录，并顺便清理过期日志 */
export async function logAudit(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void> {
  const db = await getDB();
  await db.put(STORE_AUDIT, { ...entry, id: uuid(), ts: Date.now() });
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000;
  const tx = db.transaction(STORE_AUDIT, 'readwrite');
  const oldKeys = await tx.store.index('byTime').getAllKeys(IDBKeyRange.upperBound(cutoff));
  for (const k of oldKeys) await tx.store.delete(k);
  await tx.done;
}

export async function listAuditLogs(limit = 500): Promise<AuditEntry[]> {
  const db = await getDB();
  const all = await db.getAll(STORE_AUDIT);
  return (all as AuditEntry[]).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** 导出为可读文本（供用户反馈/自查） */
export function exportAuditText(entries: AuditEntry[]): string {
  const lines = entries.map(
    (e) =>
      `${new Date(e.ts).toISOString()}\t模式${e.mode}\t${e.provider}\t${e.domain}\t字符数=${e.charCount}\t批次=${e.batches}`,
  );
  return ['时间\t模式\t厂商\t域名\t字符数\t批次', ...lines].join('\n');
}

export async function clearAuditLogs(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_AUDIT);
}

/** 本次会话已上行图片数（P1.2 设置面板常驻显示） */
let sessionUploadCount = 0;
export function bumpSessionUploads(n: number): void {
  sessionUploadCount += n;
}
export function getSessionUploads(): number {
  return sessionUploadCount;
}
