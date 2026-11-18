import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { getOutboundProxyConfig } from '@/lib/outbound-proxy';
import { runWithSSRFProtection } from '@/lib/ssrf';

export const runtime = 'nodejs';

/** 用当前出站代理发一次探测请求，确认 Clash 等本地代理可用 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const cfg = getOutboundProxyConfig();
  if (!cfg.enabled) {
    return jsonError('请先启用出站代理', 400);
  }

  try {
    const result = await runWithSSRFProtection({}, async () => {
      // 轻量连通性探测；不要求 200（部分站点对 HEAD 返回 405/301 也算通路）
      const res = await fetch('https://www.baidu.com/', {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: res.status > 0 && res.status < 500, status: res.status };
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : '探测失败';
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
