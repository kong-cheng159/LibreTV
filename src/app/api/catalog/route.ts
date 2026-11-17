import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, parseClassList, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { CatalogDetailResponse, CatalogListResponse, SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

const CATALOG_CACHE_TTL = 60 * 1000;

function parseSource(raw: string | null): SourceConfig | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as SourceConfig;
    if (!obj?.key || !obj?.name || !/^https?:\/\//.test(obj.url || '')) return null;
    return obj;
  } catch {
    return null;
  }
}

function parsePage(raw: string | null, fallback = 1): number {
  const n = parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(500, n);
}

/**
 * 按源浏览 Apple CMS 分类：无 t 时拉 ac=list；有 t 时拉 ac=detail 分页列表。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const source = parseSource(url.searchParams.get('source'));
  const typeId = (url.searchParams.get('t') || '').trim();
  const page = parsePage(url.searchParams.get('pg'), 1);

  if (!source) {
    return NextResponse.json({ error: '无效的点播源配置' }, { status: 400 });
  }

  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  const base = source.url.replace(/\/+$/, '');

  try {
    if (!typeId) {
      const cacheKey = `catalog:list:${source.url}`;
      const cached = getCache<CatalogListResponse>(cacheKey);
      if (cached) return NextResponse.json(cached);

      const api = `${base}?ac=list`;
      const res = await fetchUpstream(api, { timeoutMs: 8000, headers: cmsRequestHeaders() });
      if (!res.ok) {
        return NextResponse.json({ error: `上游 HTTP ${res.status}` }, { status: 502 });
      }
      const data = await res.json();
      const payload: CatalogListResponse = { classes: parseClassList(data) };
      setCache(cacheKey, payload, CATALOG_CACHE_TTL);
      return NextResponse.json(payload);
    }

    if (!/^[\w-]+$/.test(typeId)) {
      return NextResponse.json({ error: '无效的分类 ID' }, { status: 400 });
    }

    const cacheKey = `catalog:detail:${source.url}|${typeId}|${page}`;
    const cached = getCache<CatalogDetailResponse>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const api = `${base}?ac=detail&t=${encodeURIComponent(typeId)}&pg=${page}`;
    const res = await fetchUpstream(api, { timeoutMs: 8000, headers: cmsRequestHeaders() });
    if (!res.ok) {
      return NextResponse.json({ error: `上游 HTTP ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const items = parseSearchList(data, source);
    const rawPage = parseInt(String((data as { page?: unknown }).page ?? page), 10);
    const rawPageCount = parseInt(String((data as { pagecount?: unknown }).pagecount ?? '1'), 10);
    const payload: CatalogDetailResponse = {
      items,
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : page,
      pagecount: Number.isFinite(rawPageCount) && rawPageCount > 0 ? rawPageCount : 1,
    };
    setCache(cacheKey, payload, CATALOG_CACHE_TTL);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : '请求失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}