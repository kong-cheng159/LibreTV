'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppSidebar } from './app-sidebar';
import { Icon } from './icon';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'libretv-sidebar-collapsed';

/**
 * 全站壳：左侧可折叠侧栏 + 主区环境光晕。
 * 设置 / 历史 / 下载均为独立路由，不再在此挂抽屉。
 */
export function AppShell({
  children,
  className,
  /** 主区不整页滚动，由子页面自己分配内部滚动（设置页等） */
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  // 壳层自己滚主栏：锁住 html/body，避免双滚动条；离开壳（如 /watch）时还原
  useEffect(() => {
    document.documentElement.classList.add('app-shell-lock');
    return () => document.documentElement.classList.remove('app-shell-lock');
  }, []);

  // 路由切换后收起移动端侧栏
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className={cn('h-dvh flex overflow-hidden', className)}>
      <AppSidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapse={toggleCollapse}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div
        className={cn(
          'flex-1 min-w-0 min-h-0 main-ambient-bg flex flex-col overflow-x-hidden',
          fill ? 'overflow-hidden' : 'overflow-y-auto'
        )}
      >
        <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-14 bg-page/80 backdrop-blur-md border-b border-line/60 shrink-0">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="flex items-center gap-2 text-content px-2.5 py-1.5 rounded-lg bg-chip/80 border border-line"
            aria-label="打开菜单"
          >
            <Icon name="menu" className="w-4 h-4" />
            <span className="text-xs font-medium">菜单</span>
          </button>
          <span className="text-sm font-bold brand-gradient">LibreTV</span>
          <div className="w-12" aria-hidden />
        </div>

        {children}
      </div>
    </div>
  );
}
