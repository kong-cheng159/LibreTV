'use client';

import { api, ApiError } from './client-api';
import { useAppStore } from './store';

/**
 * 把本地偏好里的出站代理同步到 Node sidecar。
 * 未登录 / 未配置密码时静默跳过（服务端仍可读环境变量 HTTP_PROXY）。
 */
export async function syncOutboundProxyToServer(): Promise<void> {
  const { outboundProxyEnabled, outboundProxyUrl } = useAppStore.getState();
  try {
    // 关闭只推 enabled:false，不附带 URL，避免校验失败导致关不掉
    if (!outboundProxyEnabled) {
      await api.outboundProxy.put({ enabled: false });
      return;
    }
    await api.outboundProxy.put({
      enabled: true,
      url: outboundProxyUrl || 'http://127.0.0.1:7890',
    });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 503)) return;
    throw e;
  }
}
