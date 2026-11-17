import { NextResponse } from 'next/server';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { desktopBootAuthorized, isDesktopMode } from '@/lib/desktop-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 桌面壳的一次性登录入口。
 * 只在 DESKTOP_MODE=1 且启动令牌匹配时签发真正的 ltv_session，然后跳回首页。
 * Docker / 普通 next start 不设置 DESKTOP_MODE，这里保持 404。
 */
export async function GET(req: Request) {
  if (!isDesktopMode()) {
    return new NextResponse(null, { status: 404 });
  }

  const token = new URL(req.url).searchParams.get('t');
  if (!desktopBootAuthorized(token)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { token: session, expiresAt } = signSession();
  const port = process.env.PORT || '8080';
  const res = NextResponse.redirect(`http://127.0.0.1:${port}/`);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
  });
  return res;
}
