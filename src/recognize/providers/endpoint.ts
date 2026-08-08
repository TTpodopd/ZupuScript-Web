import type { ProviderConfig } from '../types';

export function apiBase(cfg: ProviderConfig, fallback: string): string {
  return (cfg.endpoint || fallback).replace(/\/$/, '');
}

export function routeThroughProxy(proxyUrl: string | undefined, targetUrl: string): string {
  if (!proxyUrl) return targetUrl;
  const proxy = new URL(proxyUrl);
  proxy.searchParams.set('target', targetUrl);
  return proxy.toString();
}

export async function testEndpoint(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`连接失败 HTTP ${response.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
}
