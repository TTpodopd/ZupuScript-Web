/**
 * IndexedDB 封装（idb）：projects / pages / undoStacks / auditLogs / recognizeCache / blobs / keystore。
 * 项目元数据、字符表、图元表、撤销栈均持久化在此（L3 层）。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_AUDIT,
  STORE_BLOBS,
  STORE_CACHE,
  STORE_KEYSTORE,
  STORE_PAGES,
  STORE_PROJECTS,
  STORE_UNDO,
} from '@/lib/constants';
import type { Page, Project } from '@/model/types';
import type { EditCommand } from '@/store/editorStore';
import type { AuditEntry } from '@/privacy/audit';
import type { EncryptedKeyRecord } from '@/privacy/keystore';

export interface UndoRecord {
  pageId: string;
  undoStack: EditCommand[];
  redoStack: EditCommand[];
}

export interface CacheRecord {
  /** 缓存键：provider+model+图像哈希 */
  key: string;
  items: unknown;
  createdAt: number;
}

interface ZupuDB extends DBSchema {
  [STORE_PROJECTS]: { key: string; value: Project };
  [STORE_PAGES]: { key: string; value: Page; indexes: { byProject: string } };
  [STORE_UNDO]: { key: string; value: UndoRecord };
  [STORE_AUDIT]: { key: string; value: AuditEntry; indexes: { byTime: number } };
  [STORE_CACHE]: { key: string; value: CacheRecord };
  [STORE_BLOBS]: { key: string; value: Blob };
  [STORE_KEYSTORE]: { key: string; value: EncryptedKeyRecord };
}

let dbPromise: Promise<IDBPDatabase<ZupuDB>> | null = null;

/** 全应用唯一的数据库句柄（其他模块一律经此获取，避免重复 openDB 导致 upgrade 竞争） */
export function getDB(): Promise<IDBPDatabase<ZupuDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ZupuDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        const pages = db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
        pages.createIndex('byProject', 'projectId');
        db.createObjectStore(STORE_UNDO, { keyPath: 'pageId' });
        const audit = db.createObjectStore(STORE_AUDIT, { keyPath: 'id' });
        audit.createIndex('byTime', 'ts');
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
        db.createObjectStore(STORE_BLOBS);
        db.createObjectStore(STORE_KEYSTORE, { keyPath: 'providerId' });
      },
    });
  }
  return dbPromise;
}

/* ---------- projects ---------- */
export async function saveProject(project: Project): Promise<void> {
  await (await getDB()).put(STORE_PROJECTS, project);
}

export async function listProjects(): Promise<Project[]> {
  const all = await (await getDB()).getAll(STORE_PROJECTS);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProjectRecord(projectId: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_PROJECTS, projectId);
  const pageIds = await db.getAllKeysFromIndex(STORE_PAGES, 'byProject', projectId);
  const tx = db.transaction([STORE_PAGES, STORE_UNDO], 'readwrite');
  for (const pid of pageIds) {
    await tx.objectStore(STORE_PAGES).delete(pid as string);
    await tx.objectStore(STORE_UNDO).delete(pid as string);
  }
  await tx.done;
}

/* ---------- pages ---------- */
export async function savePage(page: Page): Promise<void> {
  await (await getDB()).put(STORE_PAGES, page);
}

export async function getPage(pageId: string): Promise<Page | undefined> {
  return (await getDB()).get(STORE_PAGES, pageId);
}

export async function listPagesOfProject(projectId: string): Promise<Page[]> {
  const pages = await (await getDB()).getAllFromIndex(STORE_PAGES, 'byProject', projectId);
  return pages.sort((a, b) => a.index - b.index);
}

export async function deletePageRecord(pageId: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_PAGES, pageId);
  await db.delete(STORE_UNDO, pageId);
}

/* ---------- 撤销栈（刷新后可恢复，F6.7） ---------- */
export async function saveUndoStack(record: UndoRecord): Promise<void> {
  await (await getDB()).put(STORE_UNDO, record);
}

export async function loadUndoStack(pageId: string): Promise<UndoRecord | undefined> {
  return (await getDB()).get(STORE_UNDO, pageId);
}

/* ---------- 识别结果缓存（相同图像哈希不重复请求，9.5 成本控制） ---------- */
export async function getCache(key: string): Promise<CacheRecord | undefined> {
  return (await getDB()).get(STORE_CACHE, key);
}

export async function setCache(record: CacheRecord): Promise<void> {
  await (await getDB()).put(STORE_CACHE, record);
}

/* ---------- Blob 兜底存储（Safari OPFS 受限时降级） ---------- */
export async function putBlob(key: string, blob: Blob): Promise<void> {
  await (await getDB()).put(STORE_BLOBS, blob, key);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return (await getDB()).get(STORE_BLOBS, key);
}

export async function deleteBlob(key: string): Promise<void> {
  await (await getDB()).delete(STORE_BLOBS, key);
}

/* ---------- keystore 底层 ---------- */
export async function putKeyRecord(record: EncryptedKeyRecord): Promise<void> {
  await (await getDB()).put(STORE_KEYSTORE, record);
}

export async function getKeyRecord(providerId: string): Promise<EncryptedKeyRecord | undefined> {
  return (await getDB()).get(STORE_KEYSTORE, providerId);
}

export async function deleteKeyRecord(providerId: string): Promise<void> {
  await (await getDB()).delete(STORE_KEYSTORE, providerId);
}

/* ---------- 一键清空（P1.5 / A9） ---------- */
export async function clearAllStores(): Promise<void> {
  const db = await getDB();
  const stores = [
    STORE_PROJECTS,
    STORE_PAGES,
    STORE_UNDO,
    STORE_AUDIT,
    STORE_CACHE,
    STORE_BLOBS,
    STORE_KEYSTORE,
  ] as const;
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) {
    await tx.objectStore(s).clear();
  }
  await tx.done;
}

/** 估算占用空间（项目列表显示用） */
export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}
