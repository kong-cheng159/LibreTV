'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from './theme';
import { Icon } from './icon';
import { cn } from '@/lib/utils';

export interface AppSidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}

/**
 * 左侧毛玻璃操作侧栏。
 * 历史 / 下载 / 设置均为独立路由页（不再弹抽屉）。
 */
export function AppSidebar({
  collapsed,
  mobileOpen,
  onToggleCollapse,
  onCloseMobile,
}: AppSidebarProps) {
  const pathname = usePathname();
  const { theme, resolved, setTheme } = useTheme();
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const themeLabel =
    theme === 'system' ? `跟随系统（${resolved === 'dark' ? '深色' : '浅色'}）` : theme === 'dark' ? '曜石深色主题' : '浅色主题';

  const widthClass = collapsed ? 'lg:w-[72px]' : 'lg:w-[220px]';

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/65 backdrop-blur-[2px] lg:hidden transition-opacity',
          mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onCloseMobile}
        aria-hidden={!mobileOpen}
      />

      <aside
        id="app-sidebar"
        className={cn(
          'glass-sidebar z-50 h-full shrink-0 flex flex-col justify-between select-none',
          'fixed inset-y-0 left-0 lg:static lg:inset-auto',
          'w-[220px]',
          widthClass,
          collapsed && 'sidebar-collapsed',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className="p-4">
          <div className="flex items-center justify-between h-10 px-1 mb-5">
            <Link
              href="/"
              onClick={onCloseMobile}
              aria-label="LibreTV 首页"
              className="flex items-center gap-2.5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-lg min-w-0"
            >
              <div className="w-8 h-8 rounded-lg bg-[#111520] border border-white/10 flex items-center justify-center shadow-inner group-hover:border-cyan-400/40 transition-colors shrink-0 dark:bg-[#111520]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/icon-512.png" alt="" className="w-5 h-5 rounded" />
              </div>
              <span className="sidebar-label font-display text-[17px] font-bold tracking-tight brand-gradient leading-none">
                LibreTV
              </span>
            </Link>

            <button
              type="button"
              aria-label="关闭菜单"
              onClick={onCloseMobile}
              className="lg:hidden w-7 h-7 rounded-lg flex items-center justify-center text-muted hover:text-content hover:bg-white/[0.07]"
            >
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>

          <nav className="space-y-1" aria-label="主导航">
            <p className="sidebar-label px-3 pb-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-faint">
              MENU
            </p>

            <SidebarLink href="/" active={pathname === '/'} onNavigate={onCloseMobile} collapsed={collapsed} title="探索 / 首页">
              <Icon name="home" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/' && 'text-accent')} />
              <span className="sidebar-label">探索 / 首页</span>
            </SidebarLink>

            <SidebarLink
              href="/browse"
              active={pathname === '/browse'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="分类浏览"
            >
              <Icon name="filter" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/browse' && 'text-accent')} />
              <span className="sidebar-label">分类浏览</span>
            </SidebarLink>

            {/* 源与系统提到 MENU 上方，独立页不再弹窗 */}
            <SidebarLink
              href="/settings"
              active={pathname === '/settings'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="源与系统设置"
            >
              <Icon name="gear" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/settings' && 'text-accent')} />
              <span className="sidebar-label">源与系统设置</span>
            </SidebarLink>

            <SidebarLink
              href="/live"
              active={pathname === '/live'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="电视直播"
            >
              <Icon name="bolt" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/live' && 'text-accent')} />
              <span className="sidebar-label">电视直播</span>
            </SidebarLink>

            <SidebarLink
              href="/history"
              active={pathname === '/history'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="历史记录"
            >
              <Icon name="clock" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/history' && 'text-accent')} />
              <span className="sidebar-label">历史记录</span>
            </SidebarLink>

            <SidebarLink
              href="/downloads"
              active={pathname === '/downloads'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="下载管理"
            >
              <Icon name="download" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/downloads' && 'text-accent')} />
              <span className="sidebar-label">下载管理</span>
            </SidebarLink>

            <SidebarLink
              href="/local"
              active={pathname === '/local'}
              onNavigate={onCloseMobile}
              collapsed={collapsed}
              title="本地媒体"
            >
              <Icon name="link" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/local' && 'text-accent')} />
              <span className="sidebar-label">本地媒体</span>
            </SidebarLink>
          </nav>
        </div>

        <div className="p-4 border-t border-white/[0.06] space-y-1">
          <p className="sidebar-label px-3 pb-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-faint">
            SYSTEM
          </p>

          <button
            type="button"
            className="sidebar-nav-item"
            title={`主题：${themeLabel}，点击切换`}
            onClick={() => setTheme(nextTheme)}
          >
            {theme === 'system' ? (
              <svg className="w-[18px] h-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            ) : resolved === 'dark' ? (
              <svg className="w-[18px] h-[18px] shrink-0 text-amber-300/90" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            ) : (
              <svg className="w-[18px] h-[18px] shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            )}
            <span className="sidebar-label">{themeLabel}</span>
          </button>

          <SidebarLink
            href="/about"
            active={pathname === '/about'}
            onNavigate={onCloseMobile}
            collapsed={collapsed}
            title="关于 LibreTV"
          >
            <Icon name="alert" className={cn('w-[18px] h-[18px] shrink-0', pathname === '/about' && 'text-accent')} />
            <span className="sidebar-label">关于 LibreTV</span>
          </SidebarLink>

          <button
            type="button"
            title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            onClick={onToggleCollapse}
            className="sidebar-nav-item hidden lg:flex mt-1"
          >
            <Icon
              name="chevronDown"
              className={cn('w-[18px] h-[18px] shrink-0 transition-transform duration-200', collapsed ? 'rotate-90' : '-rotate-90')}
            />
            <span className="sidebar-label">{collapsed ? '展开侧边栏' : '折叠侧边栏'}</span>
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarLink({
  href,
  active,
  onNavigate,
  collapsed,
  title,
  children,
}: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  collapsed: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={collapsed ? title : undefined}
      className={cn('sidebar-nav-item', active && 'active')}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </Link>
  );
}
