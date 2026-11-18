/**
 * 出站 HTTP(S) 代理（服务端）：搜索 / 详情 / 代理拉流等上游请求可经本地 Clash 等转发。
 * Node 默认不认 Windows「系统代理」，因此用显式配置 + undici ProxyAgent。
 *
 * 走代理时连接层只连到代理地址，真实目标由代理解析；目标 URL 仍先过 SSRF 预检。
 */

import { ProxyAgent } from 'undici';
import { isDesktopMode } from './desktop-mode';

export interface OutboundProxyConfig {
  enabled: boolean;
  /** 例：http://127.0.0.1:7890 */
  url: string;
}

const DEFAULT_URL = 'http://127.0.0.1:7890';

let current: OutboundProxyConfig = {
  enabled: false,
  url: DEFAULT_URL,
};

function hostIsLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

function hostIsPrivateLan(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m) {
    const n = Number(m[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

/** 校验用户填写的代理地址；返回归一化 URL */
export function validateOutboundProxyUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: '请填写代理地址' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: '代理地址不是合法 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http:// 或 https:// 代理（SOCKS 请用 Clash 的 HTTP 端口）' };
  }
  if (!parsed.hostname) return { ok: false, reason: '缺少主机名' };
  const host = parsed.hostname;
  if (hostIsLoopback(host)) {
    // ok
  } else if (isDesktopMode() && hostIsPrivateLan(host)) {
    // 桌面端允许局域网网关代理
  } else if (!isDesktopMode() && hostIsPrivateLan(host)) {
    return { ok: false, reason: '服务器部署仅允许本机回环代理（127.0.0.1 / localhost）' };
  } else {
    return { ok: false, reason: '代理主机须为本机或局域网地址，避免把出站指到不可信节点' };
  }
  // 去掉尾部斜杠，保持稳定
  const url = `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  return { ok: true, url };
}

export function getOutboundProxyConfig(): OutboundProxyConfig {
  return { ...current };
}

export function setOutboundProxyConfig(next: Partial<OutboundProxyConfig>): OutboundProxyConfig {
  let url = current.url;
  if (typeof next.url === 'string') {
    const v = validateOutboundProxyUrl(next.url || DEFAULT_URL);
    if (v.ok) {
      url = v.url;
    } else if (next.enabled !== false) {
      // 关闭代理时不因坏地址失败，保证随时能关掉
      throw new Error(v.reason);
    }
  }

  if (next.enabled === true) {
    const v = validateOutboundProxyUrl(url);
    if (!v.ok) throw new Error(v.reason);
    current = { enabled: true, url: v.url };
  } else if (next.enabled === false) {
    current = { enabled: false, url };
  } else if (typeof next.url === 'string') {
    current = { ...current, url };
  }
  return getOutboundProxyConfig();
}

/** 从环境变量初始化一次（Docker / 手动启动时可设 HTTP_PROXY） */
export function bootstrapOutboundProxyFromEnv(): void {
  const raw =
    process.env.LIBRETV_HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    '';
  if (!raw.trim()) return;
  const v = validateOutboundProxyUrl(raw);
  if (!v.ok) return;
  current = { enabled: true, url: v.url };
}

bootstrapOutboundProxyFromEnv();

/**
 * 若已启用出站代理，返回 ProxyAgent；否则 null（调用方继续用 SSRF Agent）。
 * 每次请求新建，用完 close，避免跨请求串状态。
 */
export function createOutboundProxyAgent(): ProxyAgent | null {
  if (!current.enabled) return null;
  const v = validateOutboundProxyUrl(current.url);
  if (!v.ok) return null;
  return new ProxyAgent(v.url);
}

export const DEFAULT_OUTBOUND_PROXY_URL = DEFAULT_URL;
