import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import {
  getOutboundProxyConfig,
  setOutboundProxyConfig,
  validateOutboundProxyUrl,
} from '@/lib/outbound-proxy';

export const runtime = 'nodejs';

/** 读取当前进程出站代理配置（仅影响本机 Node sidecar / 服务端上游请求） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json(getOutboundProxyConfig());
}

interface PutBody {
  enabled?: boolean;
  url?: string;
}

/** 更新出站代理；立即作用于后续搜索 / 详情 / 代理拉流 */
export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return jsonError('无效的 JSON', 400);
  }

  // 关闭时不强制校验 URL，避免坏地址把「关掉」挡住
  if (typeof body.url === 'string' && body.enabled !== false) {
    const v = validateOutboundProxyUrl(body.url);
    if (!v.ok) return jsonError(v.reason, 400);
  }

  try {
    const next = setOutboundProxyConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
    });
    return NextResponse.json(next);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '配置失败', 400);
  }
}
