'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { SmartImage } from './smart-image';
import { db } from '@/lib/db';
import { buildWatchUrl, cn } from '@/lib/utils';
import { resolveSource, useAppStore, type WatchlistEntry } from '@/lib/store';

/**
 * 首页「我的追剧」：横向海报行，点击进入播放页（集数优先读观看历史）。
 */
export function WatchlistSection({ className }: { className?: string }) {
  const watchlist = useAppStore((s) => s.watchlist);
  const ids = useMemo(() => watchlist.map((w) => w.id), [watchlist]);

  const historyById = useLiveQuery(
    async () => {
      if (ids.length === 0) return {} as Record<string, { episodeIndex: number }>;
      const rows = await db.history.bulkGet(ids);
      const map: Record<string, { episodeIndex: number }> = {};
      for (let i = 0; i < ids.length; i++) {
        const row = rows[i];
        if (row) map[ids[i]] = { episodeIndex: row.episodeIndex };
      }
      return map;
    },
    [ids.join('|')]
  );

  if (watchlist.length === 0) return null;

  return (
    <section className={cn('shell py-3 sm:py-4 shrink-0', className)} aria-label="我的追剧">
      <h2 className="section-title text-left mb-3">我的追剧</h2>
      <ul className="flex gap-3 overflow-x-auto scrollbar-thin pb-1 overscroll-x-contain">
        {watchlist.map((entry) => (
          <WatchlistCard
            key={entry.id}
            entry={entry}
            episodeIndex={historyById?.[entry.id]?.episodeIndex ?? 0}
          />
        ))}
      </ul>
    </section>
  );
}

function WatchlistCard({
  entry,
  episodeIndex,
}: {
  entry: WatchlistEntry;
  episodeIndex: number;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const [imgFailed, setImgFailed] = useState(false);

  const source = resolveSource({ customAPIs, envSources }, entry.sourceKey, {
    url: entry.sourceUrl,
  });

  const href = buildWatchUrl({
    sourceKey: entry.sourceKey,
    vodId: entry.vodId,
    index: episodeIndex,
    title: entry.title,
    sourceUrl: source?.url ?? entry.sourceUrl,
    detail: source?.detail,
  });

  return (
    <li className="shrink-0 w-[132px] sm:w-[148px]">
      <Link
        href={href}
        className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-xl"
      >
        <div className="poster-card-frame aspect-[2/3] w-full">
          {entry.pic && !imgFailed ? (
            <SmartImage
              url={entry.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="poster-artwork"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-chip">
              <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 4v16m10-16v16M7 8h10M7 12h10"
                />
              </svg>
            </div>
          )}
        </div>
        <div className="pt-2 px-0.5">
          <div className="text-[13px] font-medium text-content line-clamp-2 leading-snug" title={entry.title}>
            {entry.title}
          </div>
          {entry.totalEpisodes != null && entry.totalEpisodes > 1 && (
            <p className="text-[11px] text-faint mt-0.5">共 {entry.totalEpisodes} 集</p>
          )}
        </div>
      </Link>
    </li>
  );
}