'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { Icon } from './icon';
import { cn } from '@/lib/utils';

/** 页内轻量搜索条（直播等非首页场景），替代旧 Header 的 showSearch */
export function PageSearchBar({ className }: { className?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const searchHistory = useSearchHistory(query);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    searchHistory.record(q);
  };

  return (
    <form
      className={cn('w-full max-w-xl', className)}
      onSubmit={(e) => {
        e.preventDefault();
        submitSearch(query);
      }}
    >
      <div ref={searchHistory.containerRef} className="relative">
        <div
          className={cn(
            'search-shell flex items-center gap-2 p-1.5',
            searchHistory.visible && 'rounded-b-none'
          )}
        >
          <div className="pl-2.5 text-muted flex items-center pointer-events-none">
            <Icon name="search" className="w-4 h-4" />
          </div>
          <input
            className="w-full bg-transparent border-none outline-none text-sm text-content placeholder:text-faint py-2 px-1"
            aria-label="搜索影片"
            placeholder="搜索影片..."
            value={query}
            maxLength={100}
            onChange={(e) => {
              setQuery(e.target.value);
              searchHistory.resetActive();
            }}
            onFocus={searchHistory.onFocus}
            onKeyDown={(e) => searchHistory.onKeyDown(e, (t) => {
              setQuery(t);
              submitSearch(t);
            })}
            role="combobox"
            aria-expanded={searchHistory.visible}
            aria-controls="page-search-history"
            aria-autocomplete="list"
          />
          <button type="submit" className="btn-gradient text-[13px] font-medium px-4 py-2 rounded-[10px] shrink-0">
            搜索
          </button>
        </div>
        {searchHistory.visible && (
          <SearchHistoryDropdown
            id="page-search-history"
            matches={searchHistory.matches}
            activeIndex={searchHistory.activeIndex}
            onPick={(t) => {
              setQuery(t);
              submitSearch(t);
            }}
            onRemove={searchHistory.remove}
            onClearAll={searchHistory.clearAll}
          />
        )}
      </div>
    </form>
  );
}
