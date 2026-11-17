'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell';
import { PageSearchBar } from '@/components/page-search-bar';
import { Dropdown } from '@/components/dropdown';
import { VideoCard } from '@/components/video-card';
import { Spinner, EmptyState } from '@/components/states';
import { useAuth } from '@/components/auth';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import type { SearchResultItem } from '@/lib/types';
import { buildWatchUrl, cn, validateSourceUrl } from '@/lib/utils';

/**
 * 按点播源分类浏览（Apple CMS ac=list / ac=detail）。
 */
export default function BrowsePage() {
  return (
    <Suspense>
      <BrowseContent />
    </Suspense>
  );
}

function BrowseContent() {
  const router = useRouter();
  const { verified } = useAuth();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);

  const [sourceKey, setSourceKey] = useState('');
  const [typeId, setTypeId] = useState('');
  const [page, setPage] = useState(1);
  const listScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sources.length === 0) {
      setSourceKey('');
      return;
    }
    if (!sourceKey || !sources.some((s) => s.key === sourceKey)) {
      setSourceKey(sources[0].key);
    }
  }, [sources, sourceKey]);

  const activeSource = useMemo(
    () => sources.find((s) => s.key === sourceKey),
    [sources, sourceKey]
  );

  const classesQuery = useQuery({
    queryKey: ['catalog-classes', activeSource?.key],
    queryFn: () => api.catalog.classes(activeSource!),
    enabled: verified && !!activeSource,
    staleTime: 5 * 60_000,
  });

  const classes = classesQuery.data?.classes ?? [];

  useEffect(() => {
    setTypeId('');
    setPage(1);
  }, [activeSource?.key]);

  useEffect(() => {
    if (!typeId && classes.length > 0) setTypeId(classes[0].type_id);
  }, [classes, typeId]);

  const listQuery = useQuery({
    queryKey: ['catalog-list', activeSource?.key, typeId, page],
    queryFn: () => api.catalog.detail(activeSource!, typeId, page),
    enabled: verified && !!activeSource && !!typeId,
    staleTime: 60_000,
  });

  const items = listQuery.data?.items ?? [];
  const pagecount = listQuery.data?.pagecount ?? 1;

  // 换源 / 换分类 / 翻页后把列表滚回顶部，避免停在上一页中部
  useEffect(() => {
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [sourceKey, typeId, page]);

  const openItem = useCallback(
    (item: SearchResultItem) => {
      const source = resolveSource(
        { customAPIs, envSources },
        item.sourceKey,
        { url: item.sourceUrl, name: item.sourceName }
      );
      if (!source) return;
      const href = buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index: 0,
        title: item.name,
        sourceUrl: item.sourceUrl || source.url,
      });
      router.push(href);
    },
    [customAPIs, envSources, router]
  );

  if (!verified) {
    return (
      <AppShell fill>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-faint text-sm">等待访问验证...</p>
        </div>
      </AppShell>
    );
  }

  const sourceOptions = sources.map((s) => ({ value: s.key, label: s.name, hint: s.url }));

  return (
    <AppShell fill>
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* 顶栏固定：搜索 + 源/分类；列表单独内滚，避免整页被分类标签撑死 */}
        <div className="relative z-20 shell shrink-0 pt-4 pb-3 space-y-3 border-b border-line/50 bg-page/80 backdrop-blur-md">
          <div className="hidden sm:block">
            <PageSearchBar />
          </div>
          <header>
            <h1 className="text-lg font-semibold text-content">分类浏览</h1>
            <p className="text-xs text-muted mt-1">选择点播源后按站点分类翻页浏览影片</p>
          </header>

          {sources.length > 0 && (
            <>
              <div className="w-full max-w-2xl">
                <Dropdown
                  value={sourceKey}
                  onChange={(v) => setSourceKey(v)}
                  options={sourceOptions}
                  ariaLabel="选择点播源"
                  searchable
                  searchPlaceholder="搜索源名称或地址…"
                />
              </div>

              {classesQuery.isLoading ? (
                <div className="flex justify-center py-2">
                  <Spinner />
                </div>
              ) : classesQuery.isError ? (
                <p className="text-sm text-danger">分类加载失败：{(classesQuery.error as Error).message}</p>
              ) : classes.length === 0 ? null : (
                // 固定三行：28px 行高 ×3 + 8px 间距 ×2 = 100px；不用 calc(*)，避免 Tailwind 任意值未生成
                <div
                  className="flex flex-wrap content-start gap-2 max-h-[100px] overflow-y-auto scrollbar-thin overscroll-contain pr-0.5"
                  role="listbox"
                  aria-label="分类"
                >
                  {classes.map((c) => (
                    <button
                      key={c.type_id}
                      type="button"
                      role="option"
                      aria-selected={typeId === c.type_id}
                      className={cn(
                        'inline-flex items-center h-7 box-border px-3 text-xs leading-none rounded-full border transition-colors shrink-0',
                        typeId === c.type_id
                          ? 'bg-accent/15 border-accent/40 text-accent'
                          : 'bg-chip border-line text-muted hover:text-content hover:border-line-strong'
                      )}
                      onClick={() => {
                        setTypeId(c.type_id);
                        setPage(1);
                      }}
                    >
                      {c.type_name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div
          ref={listScrollRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin"
        >
          <div className="shell py-4 pb-4 space-y-4">
            {sources.length === 0 ? (
              <EmptyState title="暂无可用点播源" description="请在设置中勾选至少一个点播源" />
            ) : classesQuery.isError ? null : classes.length === 0 && !classesQuery.isLoading ? (
              <EmptyState title="该源暂无分类" description="此源可能不支持 ac=list 接口" />
            ) : listQuery.isLoading && items.length === 0 ? (
              <div className="flex justify-center py-12">
                <Spinner size="lg" />
              </div>
            ) : listQuery.isError ? (
              <p className="text-sm text-danger">列表加载失败：{(listQuery.error as Error).message}</p>
            ) : !typeId ? (
              <EmptyState title="请选择分类" description="在上方点选一个分类开始浏览" />
            ) : items.length === 0 ? (
              <EmptyState title="该分类下暂无内容" />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {items.map((item) => (
                  <VideoCard
                    key={`${item.sourceKey}_${item.vodId}`}
                    item={item}
                    sources={sources}
                    onClick={() => openItem(item)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {pagecount > 1 && items.length > 0 && (
          <div className="shell shrink-0 py-3 border-t border-line/50 bg-page/80 backdrop-blur-md flex items-center justify-center gap-3">
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={page <= 1 || listQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span className="text-xs text-muted tabular-nums">
              {page} / {pagecount}
            </span>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={page >= pagecount || listQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </main>
    </AppShell>
  );
}