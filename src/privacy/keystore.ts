/**
 * API Key 保管（P1.6）：
 * - 仅存本地，用用户口令经 Web Crypto AES-GCM 加密后写入 IndexedDB；
 * - 支持「仅本次会话」不落盘（内存 Map，关页即消）；
 * - 密钥绝不写入 .zpproj.json、审计日志、URL。
 */
import { deleteKeyRecord, getKeyRecord, putKeyRecord } from '@/storage/db';

export interface EncryptedKeyRecord {
  providerId: string;
  /** base64(iv) / base64(ciphertext) / base64(salt) */
  iv: string;
  ciphertext: string;
  salt: string;
  updatedAt: number;
}

/** 仅会话密钥（不落盘） */
const sessionKeys = new Map<string, string>();

const PBKDF2_ITERATIONS = 210_000;

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 保存密钥。
 * @param sessionOnly true = 仅本次会话不落盘；false = 用口令 AES-GCM 加密后持久化。
 */
export async function saveApiKey(
  providerId: string,
  plaintext: string,
  passphrase?: string,
  sessionOnly = false,
): Promise<void> {
  if (sessionOnly) {
    sessionKeys.set(providerId, plaintext);
    await deleteKeyRecord(providerId).catch(() => undefined);
    return;
  }
  if (!passphrase) throw new Error('持久化保存密钥需要设置口令');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  const record: EncryptedKeyRecord = {
    providerId,
    iv: bufToB64(iv),
    ciphertext: bufToB64(ct),
    salt: bufToB64(salt),
    updatedAt: Date.now(),
  };
  await putKeyRecord(record);
}

/** 读取密钥：先查会话内存，再尝试用口令解密持久化记录 */
export async function loadApiKey(providerId: string, passphrase?: string): Promise<string | null> {
  const session = sessionKeys.get(providerId);
  if (session) return session;
  const record = await getKeyRecord(providerId);
  if (!record) return null;
  if (!passphrase) return null; // 需要口令才能解密
  try {
    const key = await deriveKey(passphrase, b64ToBuf(record.salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(record.iv) as BufferSource },
      key,
      b64ToBuf(record.ciphertext) as BufferSource,
    );
    const text = new TextDecoder().decode(pt);
    sessionKeys.set(providerId, text); // 本次会话内缓存明文，避免反复解密
    return text;
  } catch {
    throw new Error('口令错误或密钥数据已损坏');
  }
}

/** 是否已保存（不含明文判断，仅判断记录存在） */
export async function hasApiKey(providerId: string): Promise<boolean> {
  if (sessionKeys.has(providerId)) return true;
  return (await getKeyRecord(providerId)) !== undefined;
}

/** 销毁指定或全部密钥（P1.5 一键清空会调用 destroyAllApiKeys） */
export async function destroyApiKey(providerId: string): Promise<void> {
  sessionKeys.delete(providerId);
  await deleteKeyRecord(providerId).catch(() => undefined);
}

export function destroySessionKeys(): void {
  sessionKeys.clear();
}
