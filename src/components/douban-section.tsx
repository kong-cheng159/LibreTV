'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { mergeRecommendationPages, nextRecommendationOffset, RECOMMEND_PAGE_SIZE } from '@/lib/recommendation-pages';
import { DoubanCard } from './video-card';

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 首页推荐区：数据源由设置决定（豆瓣热门 / Bangumi 新番放送 / 影视热榜） */
export function RecommendSection({
  onPick,
  className,
  footer,
}: {
  onPick: (title: string) => void;
  className?: string;
  /** 滚到底部时显示（如页脚），挂在海报列表滚动区内 */
  footer?: ReactNode;
}) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);

  if (!doubanEnabled) {
    return footer ? <div className={className}>{footer}</div> : null;
  }
  if (recommendSource === 'bangumi') {
    return <BangumiView onPick={onPick} className={className} footer={footer} />;
  }
  if (recommendSource === 'hot-list') {
    return <HotListView onPick={onPick} className={className} footer={footer} />;
  }
  return <DoubanView onPick={onPick} className={className} footer={footer} />;
}

function SectionChrome({
  title,
  eyebrow,
  count,
  children,
}: {
  title: string;
  eyebrow: string;
  /** 数量徽章，如「10 部影片」 */
  count?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <span className="block text-[10.5px] font-semibold tracking-[0.18em] uppercase text-faint mb-1">
          {eyebrow}
        </span>
        <div className="flex items-center gap-3">
          <h2 className="section-title">{title}</h2>
          {count && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/[0.05] text-muted border border-white/[0.06] tabular-nums dark:bg-white/[0.05]">
              {count}
            </span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** 标题/Tab 固定，海报区滚动；无背景色 */
function RecommendShell({
  className,
  toolbar,
  children,
  footer,
}: {
  className?: string;
  toolbar: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className={cn('h-full min-h-0 flex flex-col overflow-hidden', className)} aria-label="推荐">
      <div className="shell shrink-0 relative z-20 pb-4 space-y-4">{toolbar}</div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
        <div className="shell pb-10">{children}</div>
        {footer}
      </div>
    </section>
  );
}

/**
 * 豆瓣推荐：影视切换 + 标签筛选。
 * 首批 50 条，滚动接近列表末尾时获取下一批真实数据；分类之间隔离缓存。
 */
function DoubanView({
  onPick,
  className,
  footer,
}: {
  onPick: (title: string) => void;
  className?: string;
  footer?: ReactNode;
}) {
  const [type, setType] = useState<'movie' | 'tv'>('movie');
  const [tag, setTag] = useState('热门');
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    queryKey: ['douban-scroll', type, tag, RECOMMEND_PAGE_SIZE],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.douban(type, tag, pageParam, RECOMMEND_PAGE_SIZE, signal),
    getNextPageParam: (last, pages, offset) => nextRecommendationOffset(last, pages, offset),
    retry: false,
  });

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;
  const items = useMemo(() => mergeRecommendationPages(query.data?.pages ?? []), [query.data]);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;

  useEffect(() => {
    const target = loadMoreRef.current;
    const root = scrollRef.current;
    if (!target || !hasNextPage || isFetching || isFetchNextPageError || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage({ cancelRefetch: false });
      },
      { root: root ?? null, rootMargin: '600px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, type, tag]);

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    setTag('热门');
  };

  return (
    <section className={cn('h-full min-h-0 flex flex-col overflow-hidden', className)} aria-label="影视推荐">
      <div className="shell shrink-0 relative z-20 pb-4 space-y-4">
        <SectionChrome
          title="正在热映"
          eyebrow="Douban"
          count={items.length > 0 ? `${items.length} 部影片` : undefined}
        >
          <div className="segmented-track self-start" role="tablist" aria-label="影视类型">
            <button
              type="button"
              role="tab"
              className={cn('tab-pill', type === 'movie' && 'active')}
              aria-selected={type === 'movie'}
              onClick={() => switchType('movie')}
            >
              电影
            </button>
            <button
              type="button"
              role="tab"
              className={cn('tab-pill', type === 'tv' && 'active')}
              aria-selected={type === 'tv'}
              onClick={() => switchType('tv')}
            >
              剧集
            </button>
          </div>
        </SectionChrome>
        <div className="segmented-track max-w-full" role="tablist" aria-label="分类标签">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className={cn('tab-pill', t === tag && 'active')}
              aria-selected={t === tag}
              onClick={() => setTag(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin"
      >
        <div className="shell pb-10">
          {query.isError && items.length === 0 ? (
            <div className="text-center text-sm text-faint py-8">
              <p>推荐内容加载失败</p>
              <button className="btn-ghost btn-sm mt-2" onClick={() => void query.refetch()}>
                重试
              </button>
            </div>
          ) : query.isLoading ? (
            <GridSkeleton />
          ) : items.length === 0 ? (
            <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
          ) : (
            <div data-recommendation-grid className="poster-grid">
              {items.map((item) => (
                <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div ref={loadMoreRef} data-recommendation-more className="text-center text-sm text-muted py-6">
              {query.isFetchingNextPage ? (
                <p role="status">正在加载更多推荐...</p>
              ) : query.isFetchNextPageError ? (
                <div role="status">
                  <p>加载更多失败，已加载内容仍可浏览</p>
                  <button
                    className="btn-ghost btn-sm mt-2"
                    onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
                  >
                    重试加载更多
                  </button>
                </div>
              ) : query.hasNextPage ? (
                <button className="btn-ghost btn-sm" onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>
                  加载更多
                </button>
              ) : (
                <p role="status">已显示全部 {items.length} 部推荐</p>
              )}
            </div>
          )}
        </div>
        {footer}
      </div>
    </section>
  );
}

/** Bangumi 每日放送：星期筛选，一次拉全量无分页 */
function BangumiView({
  onPick,
  className,
  footer,
}: {
  onPick: (title: string) => void;
  className?: string;
  footer?: ReactNode;
}) {
  const [weekday, setWeekday] = useState<number | 'all'>('all');

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
  });

  let items: DoubanItem[] = [];
  if (query.data) {
    items =
      weekday === 'all'
        ? query.data.days.flatMap((d) => d.items)
        : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  return (
    <RecommendShell
      className={className}
      footer={footer}
      toolbar={
        <>
          <SectionChrome
            title="本周新番"
            eyebrow="Bangumi"
            count={items.length > 0 ? `${items.length} 部` : undefined}
          />
          <div className="segmented-track max-w-full" role="tablist" aria-label="放送日">
            <button
              type="button"
              role="tab"
              className={cn('tab-pill', weekday === 'all' && 'active')}
              aria-selected={weekday === 'all'}
              onClick={() => setWeekday('all')}
            >
              全部
            </button>
            {WEEKDAYS.map((name, i) => (
              <button
                key={name}
                type="button"
                role="tab"
                className={cn('tab-pill', weekday === i + 1 && 'active')}
                aria-selected={weekday === i + 1}
                onClick={() => setWeekday(i + 1)}
              >
                {name}
              </button>
            ))}
          </div>
        </>
      }
    >
      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="poster-grid">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </RecommendShell>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/** 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧 */
function HotListView({
  onPick,
  className,
  footer,
}: {
  onPick: (title: string) => void;
  className?: string;
  footer?: ReactNode;
}) {
  const [listId, setListId] = useState(HOT_LISTS[0].id);

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
  });

  const items = query.data?.items ?? [];

  return (
    <RecommendShell
      className={className}
      footer={footer}
      toolbar={
        <SectionChrome
          title="热播榜单"
          eyebrow="Charts"
          count={items.length > 0 ? `${items.length} 部影片` : undefined}
        >
          <div className="segmented-track" role="tablist" aria-label="榜单分类">
            {HOT_LISTS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="tab"
                className={cn('tab-pill', listId === l.id && 'active')}
                aria-selected={listId === l.id}
                onClick={() => setListId(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </SectionChrome>
      }
    >
      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="poster-grid">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </RecommendShell>
  );
}

function GridSkeleton() {
  return (
    <div className="poster-grid">
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-xl bg-chip animate-pulse" />
          <div className="h-3 mt-2.5 rounded bg-chip animate-pulse w-4/5" />
        </div>
      ))}
    </div>
  );
}
