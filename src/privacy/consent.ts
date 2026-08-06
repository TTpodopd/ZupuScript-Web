/**
 * 隐私同意管理（PRD 7.2/7.3）：
 * - 三级模式 A/B/C，默认 B；
 * - 首次启用云端识别必须显式同意（默认不勾选）；
 * - 强制全本地模式锁（URL 参数 ?local=1 或部署注入 window.__ZUPU_FORCE_LOCAL__）。
 */
import { FORCE_LOCAL_PARAM } from '@/lib/constants';
import type { PrivacyMode } from '@/model/types';

declare global {
  interface Window {
    /** 部署方可在 index.html 之前注入此全局锁死全本地模式（企业内网） */
    __ZUPU_FORCE_LOCAL__?: boolean;
  }
}

/** 是否强制全本地（P1.7） */
export function isForcedLocal(): boolean {
  if (typeof window !== 'undefined' && window.__ZUPU_FORCE_LOCAL__ === true) return true;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    const v = params.get(FORCE_LOCAL_PARAM);
    return v === '1' || v === 'true';
  }
  return false;
}

/** 会话内同意记录（按模式记忆，刷新后需重新确认——更保守的隐私默认） */
const sessionConsent = new Set<PrivacyMode>();

export function hasConsented(mode: PrivacyMode): boolean {
  if (mode === 'A') return true; // 全本地无需同意
  return sessionConsent.has(mode);
}

export function grantConsent(mode: PrivacyMode): void {
  sessionConsent.add(mode);
}

export function revokeConsent(): void {
  sessionConsent.clear();
}

/**
 * 校验当前请求的模式是否允许：
 * 强制本地时 B/C 一律拒绝，调用方应自动降级为 A 并提示用户。
 */
export function assertModeAllowed(mode: PrivacyMode): void {
  if (isForcedLocal() && mode !== 'A') {
    throw new Error('当前部署已锁定全本地模式，禁止使用云端识别');
  }
}
