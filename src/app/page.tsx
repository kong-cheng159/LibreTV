'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell';
import { WatchlistSection } from '@/components/watchlist-section';
import { RecommendSection } from '@/components/douban-section';
import { VideoCard } from '@/components/video-card';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { api } from '@/lib/client-api';
import type { SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { buildWatchUrl, cn, formatDisableTtl, validateSourceUrl } from '@/lib/utils';
import { addSearchHistory, db } from '@/lib/db';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';

/**
 * 首页：搜索（URL ?s= 驱动，可后退/分享）+ 豆瓣推荐。
 * 搜索结果按源平铺展示，点击直接进入 /watch（不再先聚合再下拉选源）。
 */
/** 搜索结果分批渲染的批大小：一次挂载上千张卡片会明显掉帧 */
const RESULT_PAGE_SIZE = 60;

/** 读观看历史不能拖死跳转：WebView 下 IndexedDB 偶发挂起 */
function readHistoryEpisodeIndex(id: string, timeoutMs = 250): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (index: number) => {
      if (done) return;
      done = true;
      resolve(index);
    };
    const timer = window.setTimeout(() => finish(0), timeoutMs);
    db.history
      .get(id)
      .then((hist) => {
        window.clearTimeout(timer);
        if (hist && Number.isFinite(hist.episodeIndex) && hist.episodeIndex >= 0) {
          finish(hist.episodeIndex);
        } else {
          finish(0);
        }
      })
      .catch(() => {
        window.clearTimeout(timer);
        finish(0);
      });
  });
}

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const urlQuery = searchParams.get('s') || '';
  // 精确订阅所需字段（对齐 live 页的做法）：搜索流式期间逐源写健康度、
  // 打开设置抽屉/历史面板等无关 store 变化，都不应触发首页整树重渲染
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const [input, setInput] = useState(urlQuery);
  /** 流式搜索中已结算的源（data 就绪前用于增量渲染） */
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // URL 驱动搜索：?s= 变化时回填输入框
  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  // 源名回显：失败/停用提示里显示友好名称而非裸 key
  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

  const selectedSources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      // 自动停用期内的源不参与搜索（到期自动恢复）
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      // 所属订阅被整体停用的源同样跳过（无损：各源勾选状态保留，重新启用即恢复）
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);
  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );
  // 来自已关闭订阅的源：勾选状态还在，但本次搜索用不到，必须明确告知
  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) => !isSourceDisabled({ sourceHealth }, key) && isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, selectedKeys, yellowFilter],
    // 与 runSearch 的截断规则保持一致：顶栏搜索 / 手动构造长链接不会绕过上限
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(urlQuery.slice(0, 100), selectedSources, yellowFilter, {
        signal,
        // 逐源结算即更新：结果边搜边渲染，同时滚动健康度
        onSource: (outcome) => {
          setStreamedOutcomes((prev) => [...prev, outcome]);
          for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
            toast(
              ev.permanent
                ? `「${sourceName(ev.key)}」多次失败，已停止参与搜索，可在设置中恢复`
                : `「${sourceName(ev.key)}」连续超时/失败，已停用 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        },
      });
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    // 5 分钟内从播放页返回时直接使用缓存，不重新搜索（服务端另有 60s 结果缓存兜底）
    staleTime: 300_000,
  });

  // 最近搜索改为搜索框下拉（聚焦展开、按输入过滤），不再常驻首屏
  const searchHistory = useSearchHistory(input);

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;
  // 聚合数据未就绪时，用已结算源的结果增量渲染（健康源不再等坏源超时）
  const streamedList = useMemo(
    () => streamedOutcomes.flatMap((o) => o.list),
    [streamedOutcomes]
  );
  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );
  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));
  // 分批渲染：新一次搜索时重置回首批
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const visibleList = useMemo(() => list.slice(0, visibleCount), [list, visibleCount]);
  useEffect(() => setVisibleCount(RESULT_PAGE_SIZE), [urlQuery]);

  /** 点击结果：短超时读历史集数后立刻进播放页（不阻塞在 IndexedDB 上） */
  const openPlay = (item: SearchResultItem) => {
    const openKey = `${item.sourceKey}_${item.vodId}`;
    const source = resolveSource(
      { customAPIs, envSources },
      item.sourceKey,
      { url: item.sourceUrl, name: item.sourceName }
    );
    if (!source) {
      toast('点播源配置不存在，请在设置中重新添加', 'error');
      return;
    }
    addSearchHistory(item.name).catch(() => {});
    void (async () => {
      const index = await readHistoryEpisodeIndex(openKey);
      const href = buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index,
        title: item.name,
        sourceUrl: item.sourceUrl || source.url,
      });
      // 桌面 WebView 里优先硬跳，避免偶发软路由不切换页面
      window.location.assign(href);
    })();
  };

  return (
    <AppShell fill>
      <main className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* 搜索区固定：历史下拉叠在滚动内容之上，推荐/结果单独滚动 */}
        <section
          className={cn(
            'shell shrink-0 relative z-30 pt-6 sm:pt-10 flex flex-col',
            urlQuery ? 'pb-4 items-stretch' : 'pb-5 sm:pb-6 items-center text-center'
          )}
        >
          {!urlQuery ? (
            <header className="mb-7 max-w-2xl animate-reveal-up">
              <p className="text-[11px] font-semibold tracking-[0.22em] uppercase text-accent/90 mb-2.5">
                Watch freely
              </p>
              <h1 className="font-display text-2xl sm:text-[34px] font-bold tracking-tight text-content mb-2.5">
                搜一部想看的
              </h1>
              <p className="text-[13px] sm:text-sm text-muted leading-relaxed">
                多源聚合搜索，点开就能播。源与进度都在本机。
              </p>
            </header>
          ) : (
            <h1 className="sr-only">LibreTV 视频搜索</h1>
          )}

          <div
            ref={searchHistory.containerRef}
            className="relative w-full max-w-[640px] animate-reveal-up reveal-delay-1"
          >
            <form
              className="w-full"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(input);
              }}
            >
              <div
                className={cn(
                  'search-shell flex items-center gap-2 p-1.5',
                  searchHistory.visible && 'rounded-b-none'
                )}
              >
                <div className="pl-3.5 text-muted flex items-center pointer-events-none">
                  <Icon name="search" className="w-4 h-4" />
                </div>
                <input
                  ref={inputRef}
                  className="w-full bg-transparent border-none outline-none text-sm text-content placeholder:text-faint py-2 px-1"
                  placeholder="输入影片名称..."
                  value={input}
                  maxLength={100}
                  onChange={(e) => {
                    setInput(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-label="搜索影片"
                  aria-expanded={searchHistory.visible}
                  aria-controls="home-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `home-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {input && (
                  <button
                    type="button"
                    className="shrink-0 p-1.5 rounded-full text-muted hover:text-content hover:bg-white/10 transition-colors"
                    onClick={() => {
                      setInput('');
                      searchHistory.resetActive();
                      inputRef.current?.focus();
                    }}
                    aria-label="清空"
                    title="清空"
                  >
                    <Icon name="close" className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="submit"
                  className="btn-gradient text-white text-[13.5px] font-medium px-5 py-2.5 rounded-[10px] flex items-center gap-1.5 shrink-0"
                >
                  <Icon name="search" className="w-3.5 h-3.5" />
                  <span>搜索</span>
                </button>
              </div>
            </form>

            {searchHistory.visible && (
              <SearchHistoryDropdown
                id="home-search-history"
                matches={searchHistory.matches}
                activeIndex={searchHistory.activeIndex}
                onPick={pickHistory}
                onRemove={searchHistory.remove}
                onClearAll={searchHistory.clearAll}
              />
            )}
          </div>
        </section>

        {!urlQuery ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden animate-reveal-up reveal-delay-2">
            <WatchlistSection />
            <RecommendSection
              className="flex-1 min-h-0"
              footer={<SiteFooter />}
              onPick={(title) => {
                setInput(title);
                runSearch(title);
              }}
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
            <div className="shell pb-16 sm:pb-20">
              <section aria-label="搜索结果" className="mb-10">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm text-muted">
                    “<span className="text-content">{urlQuery}</span>” 的搜索结果
                    {isSearching ? (
                      <span className="text-faint">
                        （已就绪 {streamedOutcomes.length}/{selectedSources.length} 个源…）
                      </span>
                    ) : (
                      searchQuery.data && (
                        <span className="text-faint">
                          （{list.length} 条结果{failures.length > 0 && `，${failures.length} 个源失败`}）
                        </span>
                      )
                    )}
                  </h2>
                </div>

                {failures.length > 0 && (
                  <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 flex flex-wrap gap-x-3 gap-y-1">
                    <span className="text-faint">{isSearching ? '以下源暂时无响应：' : '部分点播源请求失败：'}</span>
                    {failures.map((f) => (
                      <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : 'text-faint'}>
                        {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                        {f.timedOut ? ' 超时' : ''}
                      </span>
                    ))}
                  </div>
                )}

                {disabledSources.length > 0 && (
                  <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                    {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，
                    长期停用的需在设置中手动恢复）：{disabledSources.map((key) => sourceName(key)).join('、')}
                  </div>
                )}

                {offSubscriptionSources.length > 0 && (
                  <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                    {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                    {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
                  </div>
                )}

                {selectedSources.length === 0 ? (
                  <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
                ) : list.length > 0 ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                      {visibleList.map((item) => (
                        <VideoCard
                          key={`${item.sourceKey}_${item.vodId}`}
                          item={item}
                          sources={selectedSources}
                          onClick={() => openPlay(item)}
                        />
                      ))}
                    </div>
                    {list.length > visibleCount && (
                      <div className="flex justify-center mt-4">
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}
                        >
                          加载更多（还有 {list.length - visibleCount} 条）
                        </button>
                      </div>
                    )}
                  </>
                ) : isSearching ? (
                  <ResultsSkeleton />
                ) : (
                  <EmptyState
                    icon="search"
                    title="没有找到匹配的结果"
                    description="请尝试其他关键词或更换点播源"
                    className="!py-16"
                  />
                )}
              </section>
            </div>
            <SiteFooter />
          </div>
        )}
      </main>
    </AppShell>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        // 结构对齐真实结果卡（左侧缩略图 + 右侧文字块），避免占位与真实卡片形状不符
        <div key={i} className="card flex h-28 overflow-hidden">
          <div className="w-[105px] sm:w-[120px] shrink-0 bg-chip animate-pulse" />
          <div className="flex-1 p-2.5 space-y-2">
            <div className="h-4 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
            <div className="h-3 w-full rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 无点播源 / 未勾选点播源时的引导（替代旧版首屏静默空白） */
function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '先添加一个点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>打开左侧「源与系统设置」，勾选要参与搜索的点播源后重新搜索。</>
        ) : (
          <>
            LibreTV 不内置任何采集站。打开左侧「源与系统设置 → 添加 API」，填入一个
            Apple CMS 采集站地址（如 <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>），
            勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}
