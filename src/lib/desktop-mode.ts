import crypto from 'node:crypto';

/** 桌面壳（Tauri sidecar / desktop:dev）才会设置。Docker 与普通 next start 没有这个变量。 */
export function isDesktopMode(): boolean {
  return process.env.DESKTOP_MODE === '1';
}

/**
 * 校验启动令牌。对 sha256 做恒定时间比较，避免用原文长度走快速返回。
 * 未开启桌面模式，或服务端没有令牌时一律拒绝。
 */
export function desktopBootAuthorized(token: string | null | undefined): boolean {
  if (!isDesktopMode()) return false;
  const expected = process.env.DESKTOP_BOOT_TOKEN || '';
  if (!expected || token == null || token.length === 0) return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
