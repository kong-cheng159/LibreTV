export type PlaybackFailureStage =
  | 'manifest'
  | 'key'
  | 'segment'
  | 'network'
  | 'cors'
  | 'decode'
  | 'codec'
  | 'timeout'
  | 'unknown';

const SENSITIVE_QUERY = /^(token|access_token|auth|authorization|key|sign|signature|expires?|credential|password|pwd|session|cookie)$/i;

/** 复制诊断时保留定位所需的主机和路径，但移除查询参数中的凭据。 */
export function sanitizePlaybackUrl(input: string): string {
  try {
    const base = typeof location === 'undefined' ? 'http://localhost' : location.origin;
    const url = new URL(input, base);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (url.pathname === '/api/proxy') {
      const nested = url.searchParams.get('url');
      if (nested) url.searchParams.set('url', sanitizePlaybackUrl(nested));
    }
    return url.toString();
  } catch {
    return input.replace(/([?&](?:token|auth|key|sign|signature|password|session)=)[^&#]*/gi, '$1[redacted]');
  }
}

export function classifyPlaybackFailure(type?: string, details?: string): PlaybackFailureStage {
  const value = `${type ?? ''} ${details ?? ''}`.toLowerCase();
  if (value.includes('manifest') || value.includes('level')) return 'manifest';
  if (value.includes('key')) return 'key';
  if (value.includes('frag') || value.includes('segment')) return 'segment';
  if (value.includes('timeout') || value.includes('stalled')) return 'timeout';
  if (value.includes('cors')) return 'cors';
  if (value.includes('codec')) return 'codec';
  if (value.includes('media') || value.includes('decode') || value.includes('bufferappend')) return 'decode';
  if (value.includes('network') || value.includes('loaderror')) return 'network';
  return 'unknown';
}

export function formatDiagnosticRate(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '未知';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}
