'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { Dropdown, type DropdownOption } from './dropdown';
import { Icon, type IconName } from './icon';
import { LiveSourceManager } from './live-source-manager';
import {
  HealthBadge,
  SearchInput,
  SectionTitle,
  SelectRow,
  TestBadge,
  ToggleRow,
  Switch,
  useSourceTests,
  type TestState,
} from './settings-shared';
import { loadCacheSettings, saveCacheSettings, getCacheSummary, clearVideoCache, type CacheSummary } from '@/lib/video-cache';
import { EmptyState, Spinner } from './states';
import { useSourceProbe } from './use-source-probe';
import { allLiveSources, isSourceDisabled, keyBelongsToSubscription, resolveSource, subKeyPrefix, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { saveTextFile, UserCancelledError } from '@/lib/save-text-file';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth } from './auth';
import { api } from '@/lib/client-api';
import { DesktopUpdaterPanel } from './desktop-updater';
import {
  AUTO_REFRESH_MAX_FAIL_STREAK,
  importLocalSourceListFile,
  isLocalSourceListId,
  LOCAL_SOURCE_LIST_PREFIX,
  syncSourceSubscription,
} from '@/lib/subscription-sync';
import { parseSubscriptionUrls } from '@/lib/source-list';
import { describeParseStats } from '@/lib/tvbox-parser';

/**
 * 设置抽屉：顶部两级导航。
 * - 一级按性质分组：源管理 / 偏好设置 / 数据；
 * - 二级为该分组下的具体面板，每次只渲染一类内容，避免源很多时长距离滚动。
 * 选中位置记忆到 localStorage，再次打开回到上次所在面板。
 */

type PrimaryTab = 'sources' | 'prefs' | 'data';
type SecondaryTab = 'vod' | 'live' | 'subs' | 'playback' | 'image' | 'home' | 'network' | 'io' | 'update';

const PRIMARY_TABS: { id: PrimaryTab; label: string; icon: IconName }[] = [
  { id: 'sources', label: '源管理', icon: 'link' },
  { id: 'prefs', label: '偏好设置', icon: 'gear' },
  { id: 'data', label: '数据', icon: 'download' },
];

const SECONDARY_TABS: Record<PrimaryTab, { id: SecondaryTab; label: string }[]> = {
  sources: [
    { id: 'vod', label: '点播源' },
    { id: 'live', label: '直播源' },
    { id: 'subs', label: '数据源订阅' },
  ],
  prefs: [
    { id: 'playback', label: '播放与过滤' },
    { id: 'image', label: '封面图加载' },
    { id: 'home', label: '首页与内容' },
    { id: 'network', label: '网络代理' },
  ],
  data: [{ id: 'io', label: '配置导入导出' }],
};

function dataSecondaryTabs(): { id: SecondaryTab; label: string }[] {
  const tabs: { id: SecondaryTab; label: string }[] = [{ id: 'io', label: '配置导入导出' }];
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    tabs.push({ id: 'update', label: '桌面更新' });
  }
  return tabs;
}

const TAB_STORAGE_KEY = 'libretv-settings-tab';

/**
 * 设置工作区。
 * - page：桌面左侧分类轨 + 右侧玻璃内容台（影院控制台）
 * - drawer：窄宽堆叠 Tab（旧 Header 抽屉兼容）
 */
export function SettingsWorkspace({
  className,
  layout = 'drawer',
}: {
  className?: string;
  layout?: 'page' | 'drawer';
}) {
  const [primary, setPrimary] = useState<PrimaryTab>('sources');
  const [secondary, setSecondary] = useState<Record<PrimaryTab, SecondaryTab>>({
    sources: 'vod',
    prefs: 'playback',
    data: 'io',
  });

  // 挂载后读取上次位置（不在渲染期读 localStorage，避免 SSR/hydration 不一致）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        primary?: PrimaryTab;
        secondary?: Partial<Record<PrimaryTab, SecondaryTab>>;
      };
      // 旧版把「数据源订阅」放在「数据」下，现已迁至「源管理」：自动重定向到新位置
      const migratedSubs = saved.secondary?.data === 'subs';
      const targetPrimary = migratedSubs && saved.primary === 'data' ? 'sources' : saved.primary;
      if (targetPrimary && SECONDARY_TABS[targetPrimary]) setPrimary(targetPrimary);
      setSecondary((prev) => {
        const next = { ...prev };
        if (migratedSubs) next.sources = 'subs';
        for (const key of Object.keys(SECONDARY_TABS) as PrimaryTab[]) {
          const v = saved.secondary?.[key];
          if (v && SECONDARY_TABS[key].some((t) => t.id === v)) next[key] = v;
        }
        return next;
      });
    } catch {
      /* 本地记录损坏时忽略，回到默认面板 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ primary, secondary }));
    } catch {
      /* 隐私模式等无法写入时忽略 */
    }
  }, [primary, secondary]);

  const current = secondary[primary];
  const secondaryTabs = primary === 'data' ? dataSecondaryTabs() : SECONDARY_TABS[primary];
  const panel = (
    <>
      {current === 'vod' && <VodSourcesPanel />}
      {current === 'live' && <LiveSourceManager />}
      {current === 'playback' && <PlaybackPanel />}
      {current === 'image' && <ImagePanel />}
      {current === 'home' && <HomePanel />}
      {current === 'network' && <NetworkProxyPanel />}
      {current === 'subs' && <SourceSubscriptions />}
      {current === 'io' && <ConfigIoPanel />}
      {current === 'update' && <DesktopUpdaterPanel />}
    </>
  );

  if (layout === 'page') {
    return (
      <div
        className={cn(
          'h-full min-h-0 grid grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)] gap-4 lg:gap-6',
          // 移动：分类轨在上，内容台占剩余高度；桌面：两列同高
          'grid-rows-[auto_minmax(0,1fr)] lg:grid-rows-1',
          className
        )}
      >
        <aside className="shrink-0 space-y-3 lg:space-y-4">
          <nav
            className="hidden lg:flex flex-col gap-1 p-2 rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-md"
            aria-label="设置分类"
          >
            {PRIMARY_TABS.map((t) => {
              const active = t.id === primary;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPrimary(t.id)}
                  className={cn(
                    'relative flex items-center gap-2.5 w-full rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-white/[0.09] text-content shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                      : 'text-muted hover:text-content hover:bg-white/[0.04]'
                  )}
                  aria-current={active ? 'page' : undefined}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full"
                      style={{ background: 'var(--accent-gradient)' }}
                    />
                  )}
                  <Icon name={t.icon} className={cn('w-4 h-4 shrink-0', active && 'text-accent')} />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="lg:hidden segmented-track w-full" role="tablist" aria-label="设置分类">
            {PRIMARY_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === primary}
                className={cn('tab-pill flex-1 justify-center gap-1.5 inline-flex items-center', t.id === primary && 'active')}
                onClick={() => setPrimary(t.id)}
              >
                <Icon name={t.icon} className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </div>
        </aside>

        {/* 仅内容台内部滚动：二级 Tab 固定，面板区域滚 */}
        <section className="settings-stage min-w-0 min-h-0 flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.025] backdrop-blur-md shadow-[0_20px_50px_-28px_rgba(0,0,0,0.85)] overflow-hidden">
          {secondaryTabs.length > 1 && (
            <div className="shrink-0 px-4 sm:px-5 pt-4 pb-3 border-b border-white/[0.06]">
              <div className="segmented-track w-full sm:w-auto" role="tablist" aria-label="设置项">
                {secondaryTabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === current}
                    className={cn('tab-pill', t.id === current && 'active')}
                    onClick={() => setSecondary((prev) => ({ ...prev, [primary]: t.id }))}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* 面板自管内部滚动：标题/搜索固定，列表区滚动 */}
          <div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-5 lg:p-6 flex flex-col">
            <div className="h-full min-h-0 flex flex-col overflow-hidden">{panel}</div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-2 mb-4">
        <TabRow tabs={PRIMARY_TABS} value={primary} onChange={setPrimary} variant="primary" ariaLabel="设置分类" />
        {secondaryTabs.length > 1 && (
          <TabRow
            tabs={secondaryTabs}
            value={current}
            onChange={(id) => setSecondary((prev) => ({ ...prev, [primary]: id }))}
            variant="secondary"
            ariaLabel="设置项"
          />
        )}
      </div>
      {panel}
    </div>
  );
}

/** @deprecated 侧栏已改为 /settings 独立页；保留供旧 Header 兼容 */
export function SourceManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title="设置" mobileFull>
      <SettingsWorkspace layout="drawer" />
    </Drawer>
  );
}

/** 抽屉用一级/二级导航条 */
function TabRow<T extends string>({
  tabs,
  value,
  onChange,
  variant,
  ariaLabel,
}: {
  tabs: { id: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
  variant: 'primary' | 'secondary';
  ariaLabel: string;
}) {
  const move = (dir: 1 | -1) => {
    const idx = tabs.findIndex((t) => t.id === value);
    onChange(tabs[(idx + dir + tabs.length) % tabs.length].id);
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex w-full gap-1', variant === 'primary' && 'p-0.5 bg-chip rounded-lg')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={cn(
              'flex-1 min-w-0 inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md transition-colors',
              variant === 'primary'
                ? cn(
                    'px-2 py-1.5 text-xs',
                    active ? 'bg-surface-raised text-accent font-medium shadow-sm' : 'text-muted hover:text-content'
                  )
                : cn(
                    'px-2.5 py-1 text-xs',
                    active ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )
            )}
            onClick={() => onChange(t.id)}
          >
            {t.icon && <Icon name={t.icon} className="w-3.5 h-3.5" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// —— 点播源面板 ——

type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

// 与直播源面板保持同一组筛选项与顺序：先状态（已启用 / 已停用），后来源（来自订阅 / 手动添加）
const VOD_FILTERS: { id: VodFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

function VodSourcesPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');
  const { tests, runTest } = useSourceTests();
  const { progress, probe, cancel, isProbing, concurrency } = useSourceProbe();

  const envKeys = useMemo(() => new Set(store.envSources.map((s) => s.key)), [store.envSources]);
  const all = useMemo(() => [...store.envSources, ...store.customAPIs], [store.envSources, store.customAPIs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      const fromSub = s.key.startsWith('sub_');
      // 已启用 = 勾选中且当前未被自动停用（即真正在参与搜索的源）
      if (filter === 'enabled' && !(store.selectedKeys.includes(s.key) && !isSourceDisabled(store, s.key))) return false;
      if (filter === 'disabled' && !isSourceDisabled(store, s.key)) return false;
      if (filter === 'sub' && !fromSub) return false;
      // 手动添加 = 既非订阅导入、也非部署者预置
      if (filter === 'manual' && (fromSub || envKeys.has(s.key))) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
    });
  }, [all, query, filter, store, envKeys]);

  const visibleKeys = filtered.map((s) => s.key);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => store.selectedKeys.includes(k));

  const toggleAll = () => {
    if (allSelected) {
      store.setSelectedKeys(store.selectedKeys.filter((k) => !visibleKeys.includes(k)));
      return;
    }
    // 成人过滤开启时成人源不可勾选，与行内复选框保持一致
    const eligible = filtered.filter((s) => !(s.isAdult && store.yellowFilter)).map((s) => s.key);
    const skipped = filtered.length - eligible.length;
    store.setSelectedKeys([...new Set([...store.selectedKeys, ...eligible])]);
    if (skipped > 0) toast(`已启用 ${eligible.length} 个；${skipped} 个成人源因过滤开启被跳过`, 'info');
  };

  const runAll = async () => {
    if (isProbing) {
      cancel();
      return;
    }
    const result = await probe(filtered.map((s) => ({ key: s.key, url: s.url })));
    if (!result) return; // 被取消则无汇总
    toast(`测活完成：${result.ok}/${result.total} 个可用`, result.ok === result.total ? 'success' : 'info');
  };

  /** 一键恢复被自动停用的源（仅「已停用」筛选下提供） */
  const restoreAll = () => {
    const keys = filtered.filter((s) => isSourceDisabled(store, s.key)).map((s) => s.key);
    if (keys.length === 0) return;
    keys.forEach((k) => useAppStore.getState().clearSourceHealth(k));
    toast(`已恢复 ${keys.length} 个源`, 'success');
  };

  const empty = store.envSources.length === 0 && store.customAPIs.length === 0;

  const enabledCount = all.filter((s) => store.selectedKeys.includes(s.key)).length;

  return (
    <section className="h-full min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-content tracking-tight">点播源</h3>
            {!empty && (
              <p className="mt-1 text-xs text-faint tabular-nums">
                共 {all.length} 个 · 已启用 {enabledCount}
                {filtered.length !== all.length && ` · 筛选显示 ${filtered.length}`}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-gradient inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-[10px] shrink-0 self-start sm:self-auto"
            onClick={() => setEditing('__new__')}
          >
            <Icon name="plus" className="w-3.5 h-3.5" />
            添加 API
          </button>
        </div>

        <SourceForm
          visible={editing === '__new__'}
          onCancel={() => setEditing(null)}
          onSubmit={(data) => {
            store.addCustomApi(data);
            setEditing(null);
          }}
        />

        {!empty && (
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 sm:p-3.5 space-y-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索名称或地址" />
            <div className="flex flex-wrap items-center gap-1.5">
              {VOD_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors',
                    filter === f.id
                      ? 'bg-accent/15 text-accent ring-1 ring-accent/25'
                      : 'text-muted hover:text-content hover:bg-white/[0.05]'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2.5 mt-0.5 border-t border-white/[0.05]">
              <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? '全部停用' : '全部启用'}
              </button>
              <button className="btn-ghost btn-sm" onClick={runAll} disabled={filtered.length === 0}>
                {isProbing ? '取消测活' : '批量测活'}
              </button>
              {filter === 'disabled' && (
                <button className="btn-ghost btn-sm" onClick={restoreAll} disabled={filtered.length === 0}>
                  全部恢复
                </button>
              )}
            </div>
            {progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {progress.done}/{progress.total} · 可用 {progress.ok}
                  {formatEta(progress.done, progress.total, progress.startedAt)} · {concurrency} 路并发
                </span>
                <button className="btn-ghost btn-sm shrink-0" onClick={cancel}>
                  取消
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin mt-4">
        {empty && editing !== '__new__' ? (
          <EmptyState
            icon="link"
            title="还没有添加任何点播源"
            description="添加一个 Apple CMS 采集站 API 即可开始搜索影片；也可到「数据源订阅」一次导入点播源与直播源"
            action={
              <button className="btn-gradient text-sm font-medium px-4 py-2 rounded-[10px]" onClick={() => setEditing('__new__')}>
                添加第一个点播源
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState variant="plain" title="没有符合条件的源" />
        ) : (
          <ul className="space-y-2 pb-1">
            {filtered.map((source) => (
              <VodSourceRow
                key={source.key}
                api={source}
                isEnv={envKeys.has(source.key)}
                editing={editing === source.key}
                onEdit={setEditing}
                onCancelEdit={() => setEditing(null)}
                onUpdate={(data) => {
                  store.updateCustomApi(source.key, data);
                  setEditing(null);
                }}
                testState={tests[source.key]}
                onTest={() =>
                  runTest(source.key, async () => {
                    const r = await api.testSource(source.url);
                    useAppStore.getState().recordSourceHealth([
                      { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] },
                    ]);
                    return r;
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatEta(done: number, total: number, startedAt: number): string {
  if (done <= 0 || done >= total) return '';
  const elapsed = Date.now() - startedAt;
  const remainSec = Math.max(0, Math.round((elapsed / done) * (total - done) / 1000));
  return remainSec > 0 ? ` · 约 ${remainSec}s` : '';
}

/** 单条点播源行：勾选 / 名称标签 / 健康度 / 探活 / 编辑删除（订阅源与预置源按来源限制操作） */
function VodSourceRow({
  api,
  isEnv,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  testState,
  onTest,
}: {
  api: SourceConfig;
  isEnv: boolean;
  editing: boolean;
  onEdit: (key: string) => void;
  onCancelEdit: () => void;
  onUpdate: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
  testState?: TestState;
  onTest: () => void;
}) {
  const selected = useAppStore((s) => s.selectedKeys.includes(api.key));
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const toast = useToast().toast;
  const fromSubscription = api.key.startsWith('sub_');
  const adultBlocked = !!api.isAdult && yellowFilter;

  const remove = () => {
    const snapshot = useAppStore.getState().removeCustomApi(api.key);
    if (!snapshot) return;
    // 轻操作：不做确认弹窗，给 6 秒撤销窗口
    toast(`已移除「${api.name}」`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          const ok = useAppStore.getState().restoreCustomApi(snapshot);
          toast(ok ? '已恢复' : '恢复失败：该源位置已被重新占用', ok ? 'success' : 'warning');
        },
      },
    });
  };

  if (editing) {
    return (
      <li className="rounded-xl border border-accent/25 bg-white/[0.04] p-3.5">
        <SourceForm visible initial={api} onCancel={onCancelEdit} onSubmit={onUpdate} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'group rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 sm:px-3.5 sm:py-3',
        'transition-[background-color,border-color,opacity] duration-200',
        'hover:bg-white/[0.055] hover:border-white/[0.1]',
        // 未勾选 = 不参与搜索：整行淡显，长列表里才能一眼扫出哪些没启用
        !selected && 'opacity-55'
      )}
    >
      <div className="flex items-center gap-2.5 sm:gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent shrink-0"
          checked={selected}
          onChange={() => useAppStore.getState().toggleSourceSelected(api.key)}
          disabled={adultBlocked}
          title={adultBlocked ? '成人内容过滤开启中，需先关闭过滤才能启用此源' : undefined}
          aria-label={`选择 ${api.name}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-content truncate flex items-center gap-1.5 flex-wrap">
            <span className="truncate">{api.name}</span>
            {api.isAdult && <span className="text-pink-400 text-[11px] shrink-0">(18+)</span>}
            {isEnv && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.06] text-faint shrink-0">
                预置
              </span>
            )}
            {fromSubscription && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-accent/12 text-accent shrink-0"
                title="来自数据源订阅，重新同步时此源的名称/地址会以订阅内容为准"
              >
                订阅
              </span>
            )}
          </div>
          <div className="text-[11px] sm:text-xs text-faint truncate mt-0.5 font-mono tracking-tight">{api.url}</div>
        </div>
        <HealthBadge sourceKey={api.key} />
        <TestBadge
          state={testState}
          onTest={onTest}
          title="测试可用性（搜索耗时与结果量）"
          badgeWhenOk={({ ms }) => `✓ ${ms}ms`}
        />
        {!isEnv &&
          (fromSubscription ? (
            // 订阅源由远端列表管理：编辑会被下次同步覆盖、删除会复活，故置为禁用态并说明去处
            <>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独编辑"
                title="该源来自订阅，修改会在下次同步时被覆盖；请修改远端订阅后重新同步"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独删除"
                title="该源来自订阅，单独删除会在下次同步时恢复；请到「数据源订阅」删除整个订阅"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                onClick={() => onEdit(api.key)}
                aria-label="编辑"
                title="编辑"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                onClick={remove}
                aria-label="删除"
                title="移除（可在提示中撤销）"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ))}
      </div>
    </li>
  );
}

// —— 偏好设置面板 ——

function PlaybackPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [clearMarksOpen, setClearMarksOpen] = useState(false);
  const markCount = Object.keys(store.skipMarks).length;
  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
      <SectionTitle title="播放与过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="广告切片过滤"
          description="剔除播放列表中的广告分片段落（按分片 URL 特征、片头插入与长片间超短中插识别，不动 DISCONTINUITY 时间轴）"
          checked={store.adFilter}
          onChange={(v) => store.updateSettings({ adFilter: v })}
        />
        <ToggleRow
          label="自动连播"
          description="单集播放结束后自动播放下一集"
          checked={store.autoplayNext}
          onChange={(v) => store.updateSettings({ autoplayNext: v })}
        />
        <ToggleRow
          label="隐私模式"
          description="开启后不再写入观看历史、播放进度、搜索历史、直播最近观看和追剧行为；已有记录不会被删除，关闭后可继续使用。"
          checked={store.privacyMode}
          onChange={(v) => store.updateSettings({ privacyMode: v })}
        />
        <ToggleRow
          label="自动跳过片段"
          description="命中片头/中段标记时跳到片段末尾，命中片尾标记时结束本集（是否连播下一集由「自动连播」决定）；关闭后三类都只显示跳过按钮（标记在播放页「跳过标记」中设置）"
          checked={store.autoSkipSegments}
          onChange={(v) => store.updateSettings({ autoSkipSegments: v })}
        />
        <ToggleRow
          label="音量增强"
          description="音量拉到 100% 仍偏小时用：经 Web Audio 增益链把输出再放大约 1.8 倍并软限幅防破音。增益与音量滑块相乘，会让所有档位的响度整体抬高，故默认关闭。跨域直连且未开启 CORS 的直播流受浏览器限制不生效（走代理或 hls.js 的源正常）"
          checked={store.volumeBoost}
          onChange={(v) => store.updateSettings({ volumeBoost: v })}
        />
        <ToggleRow
          label="底部细进度条"
          description="控制栏收起后，在画面底边常驻一条 3px 进度线，不开控件也能瞄一眼进度。关闭后鼠标移开即完全隐藏（全屏观影不留任何控件），需要看进度时把鼠标移回画面即可"
          checked={store.miniProgressBar}
          onChange={(v) => store.updateSettings({ miniProgressBar: v })}
        />
      </div>

      {markCount > 0 && (
        <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-line">
          <div className="min-w-0">
            <div className="text-sm text-content">跳过片段标记</div>
            <div className="text-xs text-faint">已记录 {markCount} 部；在播放页「跳过标记」中设置，可逐剧关闭</div>
          </div>
          <button className="btn-ghost btn-sm shrink-0" onClick={() => setClearMarksOpen(true)}>
            清除全部
          </button>
        </div>
      )}

      <ConfirmDialog
        open={clearMarksOpen}
        danger
        title="清除全部跳过片段？"
        message={`将删除已记录的 ${markCount} 部剧的跳过片段，之后播放不再自动跳过；可重新在播放页标记。`}
        confirmLabel="清除全部"
        onCancel={() => setClearMarksOpen(false)}
        onConfirm={() => {
          store.clearAllSkipMarks();
          setClearMarksOpen(false);
          toast('已清除全部跳过片段标记', 'success');
        }}
      />

      <VideoCachePanel />
    </section>
  );
}

/** 片段缓存：开启/关闭 + 用量展示 + 清理（数据在浏览器本地，独立于配置导出） */
function VideoCachePanel() {
  const [enabled, setEnabled] = useState(() => loadCacheSettings().enabled);
  const [summary, setSummary] = useState<CacheSummary>({ segments: 0, bytes: 0, episodes: 0 });
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    void getCacheSummary().then(setSummary);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="space-y-3 pt-3 mt-3 border-t border-line">
      <ToggleRow
        label="片段本地缓存"
        description="暂停或观看时把后续分片缓存到浏览器本地，二次播放与断网卡顿时直接命中（存储于本机，不计入配置导出）"
        checked={enabled}
        onChange={(v) => {
          const next = saveCacheSettings({ enabled: v });
          setEnabled(next.enabled);
        }}
      />
      <div className="flex items-center justify-between text-xs text-faint">
        <span>
          已缓存 {summary.segments} 个分片 · {formatBytes(summary.bytes)} · {summary.episodes} 集
        </span>
        <button
          type="button"
          className="px-2 py-1 rounded bg-chip text-content hover:bg-hover transition-colors disabled:opacity-50"
          disabled={clearing || summary.segments === 0}
          onClick={async () => {
            setClearing(true);
            await clearVideoCache();
            refresh();
            setClearing(false);
          }}
        >
          清理缓存
        </button>
      </div>
    </div>
  );
}

function ImagePanel() {
  const store = useAppStore();
  const mode = store.imageProxyMode;
  const description: Record<'direct' | 'proxy' | 'custom', string> = {
    direct: '原站直连；豆瓣封面自动换公共镜像，仍失败回退内置代理。最省服务器流量',
    proxy: '封面优先经本站服务器转发并伪装来源，失败自动回退公共镜像/直连。最稳定，消耗服务器流量',
    custom: '使用你填写的模板转发封面图',
  };
  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
      <SectionTitle title="封面图加载" />
      <div className="space-y-2">
        <SelectRow
          label="加载方式"
          value={mode}
          description={description[mode]}
          onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
          options={[
            { value: 'direct', label: '直连优先', hint: '最省服务器流量' },
            { value: 'proxy', label: '内置代理', hint: '最稳定' },
            { value: 'custom', label: '自定义', hint: '自建转发模板' },
          ]}
        />
        {mode === 'custom' && <CustomProxyInput />}
      </div>
    </section>
  );
}

/**
 * 自定义代理模板输入：本地即时回显 + 300ms 防抖写 store。
 * 直接每次按键写 store 会让全站封面 URL 重算并触发一轮图片重载（模板输入时缩略图持续闪烁）。
 */
function CustomProxyInput() {
  const value = useAppStore((s) => s.customImageProxy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(value);

  // 外部值变化（如导入配置）时同步回显
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => updateSettings({ customImageProxy: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, value, updateSettings]);

  return (
    <input
      className="input w-full"
      aria-label="自定义代理模板"
      placeholder="代理模板，如 https://p.example.com/?url={url}"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function HomePanel() {
  const store = useAppStore();
  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
      <SectionTitle title="首页与内容过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="成人内容过滤"
          description="过滤“伦理片”等分类的结果"
          checked={store.yellowFilter}
          onChange={(v) => store.updateSettings({ yellowFilter: v })}
        />
        <ToggleRow
          label="首页推荐"
          description="在首页展示推荐内容"
          checked={store.doubanEnabled}
          onChange={(v) => store.updateSettings({ doubanEnabled: v })}
        />
        <SelectRow
          label="推荐数据源"
          value={store.recommendSource}
          onChange={(v) => store.updateSettings({ recommendSource: v as 'douban' | 'bangumi' | 'hot-list' })}
          options={[
            { value: 'douban', label: '豆瓣', hint: '热门电影与剧集' },
            { value: 'bangumi', label: 'Bangumi', hint: '每日新番放送（免 key）' },
            { value: 'hot-list', label: '影视榜单', hint: '豆瓣周榜 / 百度热播' },
          ]}
        />
      </div>
    </section>
  );
}

/**
 * 出站代理：Node 侧搜索/详情/拉流不走 Windows「系统代理」，
 * 需在此填写 Clash 等本地 HTTP 端口并同步到 sidecar。
 * 关闭路径单独推 enabled:false，不被坏地址挡住。
 */
function NetworkProxyPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [draftUrl, setDraftUrl] = useState(store.outboundProxyUrl);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => setDraftUrl(store.outboundProxyUrl), [store.outboundProxyUrl]);

  const disableProxy = async () => {
    if (saving) return;
    setSaving(true);
    const prev = store.outboundProxyEnabled;
    try {
      await api.outboundProxy.put({ enabled: false });
      store.updateSettings({ outboundProxyEnabled: false });
      toast('已关闭出站代理', 'success');
    } catch (e) {
      store.updateSettings({ outboundProxyEnabled: prev });
      toast(e instanceof Error ? e.message : '关闭失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const enableProxy = async (url: string) => {
    if (saving) return;
    const nextUrl = url.trim() || 'http://127.0.0.1:7890';
    setSaving(true);
    const prevEnabled = store.outboundProxyEnabled;
    const prevUrl = store.outboundProxyUrl;
    try {
      await api.outboundProxy.put({ enabled: true, url: nextUrl });
      store.updateSettings({ outboundProxyEnabled: true, outboundProxyUrl: nextUrl });
      setDraftUrl(nextUrl);
      toast('已启用出站代理', 'success');
    } catch (e) {
      store.updateSettings({ outboundProxyEnabled: prevEnabled, outboundProxyUrl: prevUrl });
      toast(e instanceof Error ? e.message : '启用失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveUrl = async (url: string) => {
    if (saving) return;
    const nextUrl = url.trim() || 'http://127.0.0.1:7890';
    if (nextUrl === store.outboundProxyUrl && store.outboundProxyEnabled) return;
    if (!store.outboundProxyEnabled) {
      store.updateSettings({ outboundProxyUrl: nextUrl });
      setDraftUrl(nextUrl);
      return;
    }
    setSaving(true);
    const prevUrl = store.outboundProxyUrl;
    try {
      await api.outboundProxy.put({ enabled: true, url: nextUrl });
      store.updateSettings({ outboundProxyUrl: nextUrl });
      setDraftUrl(nextUrl);
      toast('代理地址已更新', 'success');
    } catch (e) {
      store.updateSettings({ outboundProxyUrl: prevUrl });
      setDraftUrl(prevUrl);
      toast(e instanceof Error ? e.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
      <SectionTitle
        title="网络代理"
        hint={store.outboundProxyEnabled ? '当前：已启用' : '当前：已关闭'}
      />
      <div className="space-y-3">
        <ToggleRow
          label="启用出站代理"
          description="搜索、详情、封面与拉流等由本机 Node 发出的请求将经下方 HTTP 代理转发。适用于 Clash / V2RayN 等；请填 HTTP 端口（常见 7890），不要用 SOCKS。可随时关闭开关恢复直连。"
          checked={store.outboundProxyEnabled}
          onChange={(v) => {
            if (v) void enableProxy(draftUrl);
            else void disableProxy();
          }}
        />
        <div className="space-y-2">
          <label className="block text-sm text-content" htmlFor="outbound-proxy-url">
            代理地址
          </label>
          <input
            id="outbound-proxy-url"
            className="input w-full"
            placeholder="http://127.0.0.1:7890"
            value={draftUrl}
            disabled={saving}
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={() => {
              void saveUrl(draftUrl);
            }}
          />
          <p className="text-xs text-faint">
            推荐本机回环地址。也可启动时设置环境变量 HTTP_PROXY / LIBRETV_HTTP_PROXY（界面关闭后仍以界面为准，直到重启进程才重新读环境变量）。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {store.outboundProxyEnabled ? (
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={saving}
              onClick={() => {
                void disableProxy();
              }}
            >
              {saving ? '处理中…' : '关闭代理'}
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={saving}
              onClick={() => {
                void enableProxy(draftUrl);
              }}
            >
              {saving ? '处理中…' : '启用代理'}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={saving || !store.outboundProxyEnabled}
            onClick={() => {
              void saveUrl(draftUrl);
            }}
          >
            保存地址
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={testing || saving || !store.outboundProxyEnabled}
            onClick={async () => {
              setTesting(true);
              try {
                await api.outboundProxy.put({
                  enabled: true,
                  url: draftUrl.trim() || 'http://127.0.0.1:7890',
                });
                const r = await api.outboundProxy.test();
                if (r.ok) toast(`代理连通正常${r.status ? `（HTTP ${r.status}）` : ''}`, 'success');
                else toast(r.error || '代理探测失败，请检查 Clash 是否开启允许局域网/系统代理端口', 'error');
              } catch (e) {
                toast(e instanceof Error ? e.message : '探测失败', 'error');
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? '探测中…' : '测试连通'}
          </button>
        </div>
      </div>
    </section>
  );
}

// —— 数据面板 ——

/**
 * 自动刷新周期选项。值统一用字符串（Dropdown 的 value 是 string），
 * `off` = 纯手动，保持这个功能对存量用户的默认无感。
 */
const REFRESH_OPTIONS: DropdownOption[] = [
  { value: 'off', label: '手动', hint: '只在点 ⟳ 时同步' },
  { value: '1', label: '每天', hint: '打开站点时检查' },
  { value: '3', label: '每 3 天' },
  { value: '7', label: '每 7 天' },
  { value: '14', label: '每 14 天' },
  { value: '30', label: '每 30 天' },
];

/**
 * 数据源订阅 / 分享：
 * - 订阅：填入远程订阅地址（LibreTV-SourceList JSON、TVBOX 配置 JSON 或接口目录 JSON，
 *   由服务端自动识别），一次拉取点播源与直播源，可随时重新同步；
 * - 批量：文本框支持多行 / 逗号 / 分号粘贴多条地址，逐个同步后汇总结果；
 * - 自动刷新：每个订阅可单独设周期（默认手动），到期才在打开站点时静默同步；
 * - 分享：把当前点播源 + 直播源导出为同格式 JSON 文件，托管到任意位置即可被他人订阅。
 */
function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const [subUrl, setSubUrl] = useState('');
  // 每个订阅独立的同步状态，允许多个订阅并行同步（此前单值状态会串台）
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 批量导入进度：仅多条订阅时展示 */
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    done: number;
    ok: number;
    fail: number;
    current?: string;
  } | null>(null);
  const batchCancelRef = useRef(false);

  const importFromFile = async (file: File) => {
    setImportingFile(true);
    try {
      const { vodCount, liveCount, stats, name } = await importLocalSourceListFile(file);
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel =
        stats?.format === 'tvbox'
          ? '（TVBOX 配置）'
          : stats?.format === 'source-catalog'
            ? '（接口源列表）'
            : '';
      toast(
        `已从「${name || file.name}」导入 ${vodCount} 个点播源、${liveCount} 个直播源${formatLabel}${detail ? `；${detail}` : ''}`,
        'success'
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setImportingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const sync = async (url: string, opts?: { silent?: boolean }) => {
    if (isLocalSourceListId(url)) {
      if (!opts?.silent) toast('本地导入的订阅无法在线同步，请重新选择 JSON 文件导入', 'info');
      return { ok: false as const, message: '本地订阅请重新导入文件' };
    }
    setSyncing((prev) => new Set(prev).add(url));
    try {
      const { vodCount, liveCount, stats } = await syncSourceSubscription(url);
      // 如实说明跳过/截断情况，避免用户疑惑「配置里站点很多，为何只导入了个位数」
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel =
        stats?.format === 'tvbox'
          ? '（TVBOX 配置）'
          : stats?.format === 'source-catalog'
            ? '（接口源列表）'
            : '';
      if (!opts?.silent) {
        toast(`已同步 ${vodCount} 个点播源、${liveCount} 个直播源${formatLabel}${detail ? `；${detail}` : ''}`, 'success');
      }
      return { ok: true as const, vodCount, liveCount };
    } catch (err) {
      if (!opts?.silent) {
        toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
      }
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : '订阅同步失败',
      };
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  };

  /** 单条或批量：按换行/逗号/分号解析，逐个同步后汇总提示 */
  const addAndSync = async () => {
    const { urls, invalid } = parseSubscriptionUrls(subUrl);
    if (urls.length === 0) {
      toast(
        invalid.length > 0
          ? '没有合法订阅地址（需以 http:// 或 https:// 开头）'
          : '请填写订阅地址',
        'warning'
      );
      return;
    }
    if (invalid.length > 0) {
      toast(`已忽略 ${invalid.length} 条非法地址，继续订阅其余 ${urls.length} 条`, 'warning');
    }

    if (urls.length === 1) {
      const result = await sync(urls[0]);
      if (result.ok) setSubUrl('');
      return;
    }

    batchCancelRef.current = false;
    setBatchProgress({ total: urls.length, done: 0, ok: 0, fail: 0 });

    let okCount = 0;
    let failCount = 0;
    let vodTotal = 0;
    let liveTotal = 0;
    let cancelled = false;
    for (const url of urls) {
      if (batchCancelRef.current) {
        cancelled = true;
        break;
      }
      setBatchProgress((prev) => (prev ? { ...prev, current: url } : prev));
      const result = await sync(url, { silent: true });
      if (result.ok) {
        okCount += 1;
        vodTotal += result.vodCount;
        liveTotal += result.liveCount;
      } else {
        failCount += 1;
      }
      setBatchProgress((prev) =>
        prev
          ? {
              ...prev,
              done: prev.done + 1,
              ok: okCount,
              fail: failCount,
              current: undefined,
            }
          : prev
      );
    }

    setBatchProgress(null);
    if (okCount > 0) setSubUrl('');
    if (cancelled) {
      toast(
        `已取消批量订阅：成功 ${okCount}、失败 ${failCount}、未处理 ${urls.length - okCount - failCount}`,
        'info'
      );
    } else if (failCount === 0) {
      toast(`已批量订阅 ${okCount} 条（合计 ${vodTotal} 点播 / ${liveTotal} 直播）`, 'success');
    } else if (okCount === 0) {
      toast(`批量订阅全部失败（${failCount} 条）`, 'error');
    } else {
      toast(`批量订阅完成：成功 ${okCount}、失败 ${failCount}（合计 ${vodTotal} 点播 / ${liveTotal} 直播）`, 'warning');
    }
  };

  const pendingUrls = useMemo(() => parseSubscriptionUrls(subUrl).urls, [subUrl]);

  // 发布状态：进行中 + 上一次的发布结果（链接、粘贴板来源与条数）
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{
    url: string;
    provider: string;
    sources: number;
    liveSources: number;
  } | null>(null);

  /**
   * 发布当前「已勾选启用」的源：只把真正在参与搜索的源发出去
   * （未勾选的、以及被自动停用的都排除）。注意这与「导出数据源」的全量语义不同。
   */
  const publish = async () => {
    const seen = new Set<string>();
    const sources = store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => !!s && validateSourceUrl(s.url) && !isSourceDisabled(store, s.key))
      .filter((s) => {
        const key = s.url.replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ name, url }) => ({ name, url }));

    const liveSeen = new Set<string>();
    const liveSources = allLiveSources(store)
      .filter((s) => store.liveSelectedUrls.includes(s.url))
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    if (sources.length === 0 && liveSources.length === 0) {
      toast('没有已勾选启用的源可发布', 'warning');
      return;
    }

    setPublishing(true);
    try {
      const result = await api.publishSourceList({ name: 'LibreTV-SourceList', sources, liveSources });
      setPublished(result);
      toast(`已发布 ${result.sources} 个点播源、${result.liveSources} 个直播源到 ${result.provider}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const copyPublished = () => {
    if (!published) return;
    copyToClipboard(published.url).then((ok) =>
      ok ? toast('订阅链接已复制', 'success') : toast('复制失败，请手动选中复制', 'warning'),
    );
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    // 直播源：预置 + 手动 + 订阅导入，按 URL 去重
    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LibreTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${sources.length} 个点播源、${liveSources.length} 个直播源，托管后即可被他人订阅`, 'success');
  };

  const deleteImpact = (url: string) => {
    const prefix = subKeyPrefix(url);
    return {
      vod: store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, prefix)).length,
      live: store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(url)).length,
    };
  };

  return (
    <section className="h-full min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 space-y-3">
        <SectionTitle
          title="数据源订阅 / 分享"
          extra={
            <div className="flex items-center gap-1.5 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="选择源列表 JSON 文件"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFromFile(file);
                }}
              />
              <button
                className="btn-ghost btn-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={importingFile || syncing.size > 0}
                title="导入 LibreTV 源列表 / TVBOX 配置 / 接口目录 JSON 文件"
              >
                {importingFile ? '导入中…' : '导入 JSON'}
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={exportSources}
                disabled={
                  store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
                  0
                }
              >
                导出数据源
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={() => void publish()}
                disabled={publishing}
                title="把当前已勾选启用的源上传到公开粘贴板，生成可直接订阅的链接"
              >
                {publishing ? '发布中…' : '发布为链接'}
              </button>
            </div>
          }
        />

        {published && (
          <div className="rounded-lg border border-line bg-chip/60 p-2.5">
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={published.url}
                className="input flex-1 min-w-0 !py-1.5 text-xs"
                aria-label="已发布的订阅地址"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="btn-ghost btn-sm shrink-0" onClick={copyPublished}>
                复制
              </button>
              <button
                className="btn-ghost btn-sm shrink-0"
                onClick={() => {
                  setSubUrl(published.url);
                  void sync(published.url);
                }}
              >
                直接订阅
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-faint leading-relaxed">
              已发布到 {published.provider}（{published.sources} 个点播源、{published.liveSources} 个直播源）。
              链接内容公开可读，粘贴板也可能随时清理——长期使用建议自行托管。
            </p>
          </div>
        )}

        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 sm:p-3.5 space-y-2">
          <div className="flex gap-2 items-start">
            <textarea
              className="input flex-1 min-w-0 min-h-[4.5rem] resize-y"
              rows={3}
              placeholder={'订阅地址，支持批量：每行一条，或用逗号 / 分号分隔\n（LibreTV 源列表或 TVBOX 配置的 JSON URL）'}
              value={subUrl}
              onChange={(e) => setSubUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void addAndSync();
                }
              }}
              aria-label="订阅地址，支持批量粘贴"
            />
            <button
              className="btn-primary btn-sm shrink-0"
              disabled={!subUrl.trim() || syncing.size > 0}
              onClick={() => void addAndSync()}
              title="Ctrl / ⌘ + Enter 也可提交"
            >
              {batchProgress
                ? `导入中 ${batchProgress.done}/${batchProgress.total}`
                : syncing.size > 0
                  ? '同步中…'
                  : pendingUrls.length > 1
                    ? `批量订阅 (${pendingUrls.length})`
                    : '订阅'}
            </button>
          </div>
          <p className="text-[11px] text-faint leading-relaxed">
            可一次粘贴多条地址；Ctrl / ⌘ + Enter 提交。重复地址会自动去重。也可点「导入 JSON」选择本地源列表文件（需含 sources / liveSources，不是采集站接口返回的 list）。
          </p>
          {batchProgress && (
            <div className="space-y-1.5 pt-1 border-t border-white/[0.05]">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={batchProgress.total} aria-valuenow={batchProgress.done}>
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{
                      width: `${Math.round((batchProgress.done / Math.max(1, batchProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {batchProgress.done}/{batchProgress.total}
                  {batchProgress.ok > 0 || batchProgress.fail > 0
                    ? ` · 成功 ${batchProgress.ok}${batchProgress.fail > 0 ? ` · 失败 ${batchProgress.fail}` : ''}`
                    : ''}
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-sm shrink-0"
                  onClick={() => {
                    batchCancelRef.current = true;
                  }}
                >
                  取消
                </button>
              </div>
              {batchProgress.current && (
                <p className="text-[11px] text-faint truncate" title={batchProgress.current}>
                  正在导入：{batchProgress.current}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin mt-4">
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint">
          一份订阅可同时下发点播源与直播源，支持 LibreTV 源列表与 TVBOX 配置（仅导入可直接使用的接口，Spider 类站点自动跳过）；
          可用「导入 JSON」读本地文件，或「导出数据源」后托管到任意 URL 再订阅。
        </p>
      ) : (
        <ul className="space-y-2 pb-1">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(sub.url)).length;
            const isSyncing = syncing.has(sub.url);
            const isLocal = isLocalSourceListId(sub.url);
            // 自动刷新状态：暂停（连续失败触顶）> 距下次刷新 > 未设周期不提示
            const paused = Boolean(
              sub.refreshDays && (sub.failStreak ?? 0) >= AUTO_REFRESH_MAX_FAIL_STREAK
            );
            const nextAt =
              sub.refreshDays && sub.lastSync ? sub.lastSync + sub.refreshDays * 86_400_000 : undefined;
            const remainingMs = nextAt ? nextAt - Date.now() : 0;
            const localFileLabel = isLocal ? sub.url.slice(LOCAL_SOURCE_LIST_PREFIX.length) : '';
            return (
              <li
                key={sub.url}
                className={cn(
                  'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
                  // 与源列表的「未勾选」用同一套停用观感：淡显 + 徽章说明
                  sub.enabled === false && 'opacity-70'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content truncate flex items-center gap-1.5">
                      <span className="truncate">{sub.name || (isLocal ? localFileLabel : hostnameOf(sub.url))}</span>
                      {isLocal && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.06] text-faint shrink-0">
                          本地文件
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-faint truncate">
                      {isLocal ? localFileLabel || sub.url : sub.url}
                      {sub.lastSync && ` · 同步于 ${formatRelativeTime(sub.lastSync)}`}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">点播 {vodCount}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">直播 {liveCount}</span>
                      {sub.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">已停用</span>
                      )}
                      {sub.lastStatus === 'error' ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger"
                          title={sub.lastError}
                        >
                          上次同步失败
                        </span>
                      ) : sub.lastStatus === 'ok' && sub.lastCounts ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">
                          上次导入 {sub.lastCounts.vod} 点播 / {sub.lastCounts.live} 直播
                        </span>
                      ) : null}
                    </div>
                    {sub.lastStatus === 'error' && sub.lastError && (
                      <p className="text-[11px] text-danger mt-1 break-all">{sub.lastError}</p>
                    )}
                    {/* 本地文件不可远程刷新；在线订阅可设自动刷新周期 */}
                    {isLocal ? (
                      <p className="mt-1.5 text-[11px] text-faint">更新请重新「导入 JSON」（同名文件会覆盖本组）</p>
                    ) : (
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px] text-faint">
                        <Icon name="clock" className="w-3 h-3 shrink-0" />
                        <span>自动刷新</span>
                        <Dropdown
                          value={sub.refreshDays ? String(sub.refreshDays) : 'off'}
                          onChange={(v) =>
                            store.setSubscriptionRefreshDays(sub.url, v === 'off' ? undefined : Number(v))
                          }
                          options={REFRESH_OPTIONS}
                          ariaLabel="自动刷新周期"
                          className="[&>button]:!py-0.5 [&>button]:!pl-2 [&>button]:!pr-1.5 [&>button]:text-[11px]"
                        />
                        {paused ? (
                          <span className="text-warning">
                            已暂停：连续失败 {sub.failStreak} 次，手动同步成功即恢复
                          </span>
                        ) : remainingMs > 0 ? (
                          <span>约 {Math.max(1, Math.ceil(remainingMs / 86_400_000))} 天后刷新</span>
                        ) : sub.refreshDays ? (
                          <span>下次打开站点时刷新</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={sub.enabled !== false}
                    onChange={(v) => store.setSubscriptionEnabled(sub.url, v)}
                    label={sub.enabled === false ? '启用该订阅' : '停用该订阅'}
                    title={
                      sub.enabled === false
                        ? '当前已停用（其源不参与搜索），点击启用'
                        : '停用后该订阅下的源暂不参与搜索；已导入的数据与各源勾选状态都保留'
                    }
                  />
                  {!isLocal && (
                    <button
                      className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                      disabled={isSyncing}
                      onClick={() => sync(sub.url)}
                      aria-label="重新同步"
                      title="重新同步（以远端列表为准，整体替换该订阅名下的点播源与直播源）"
                    >
                      {isSyncing ? (
                        <Spinner size="sm" />
                      ) : (
                        <Icon name="refresh" className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setPendingDelete(sub.url)}
                    aria-label="删除订阅"
                    title="删除订阅及其导入的点播源与直播源（保留收藏的频道）"
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      </div>

      {/* 重操作：删除订阅会级联移除其导入的源，先确认并说明影响面 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除该订阅？"
        message={
          pendingDelete
            ? (() => {
                const impact = deleteImpact(pendingDelete);
                const parts: string[] = [];
                if (impact.vod > 0) parts.push(`${impact.vod} 个点播源`);
                if (impact.live > 0) parts.push(`${impact.live} 个直播源`);
                return parts.length > 0
                  ? `将同时删除该订阅导入的 ${parts.join(' 与 ')}；你收藏的频道会保留。`
                  : '该订阅当前未导入任何源，删除后不影响其他数据。';
              })()
            : undefined
        }
        confirmLabel="删除订阅"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const url = pendingDelete;
          if (url) useAppStore.getState().removeSubscription(url);
          setPendingDelete(null);
          toast('订阅已删除', 'success');
        }}
      />
    </section>
  );
}

/** 配置导入导出（导出受登录门控；导入前先解析预览再确认，避免误覆盖） */
function ConfigIoPanel() {
  const { toast } = useToast();
  const { verified, openLogin } = useAuth();
  const [pending, setPending] = useState<{ file: File; summary: string } | null>(null);

  const doExport = async () => {
    if (verified === false) {
      openLogin();
      return;
    }
    try {
      const filename = `LibreTV-Settings_${Date.now()}.json`;
      const result = await saveTextFile({
        filename,
        getContents: () => exportConfig(),
        extensions: ['json'],
      });
      if (result.path) {
        toast(`配置已保存到 ${result.path}`, 'success');
      } else {
        toast('配置已导出', 'success');
      }
    } catch (err) {
      if (err instanceof UserCancelledError) return;
      toast(err instanceof Error ? err.message : '导出失败', 'error');
    }
  };

  const pickImport = async (file: File) => {
    try {
      const summary = summarizeConfig(await file.text());
      setPending({ file, summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await importConfig(await pending.file.text());
      setPending(null);
      toast('配置导入成功，即将刷新页面', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin">
      <SectionTitle
        title="配置导入导出"
        hint="导出/导入含源与偏好、观看历史、播放进度、搜索历史、直播测活与下载队列元数据"
      />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 text-xs" onClick={doExport}>
          导出配置
        </button>
        <label className="btn-ghost flex-1 text-xs cursor-pointer">
          导入配置
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* 重操作：导入会覆盖全部配置，先确认并展示将导入的内容概要 */}
      <ConfirmDialog
        open={pending !== null}
        danger
        title="导入配置并覆盖当前数据？"
        message={pending ? `${pending.summary}。导入后将立即刷新页面，当前设备上的配置与观看历史会被覆盖。` : undefined}
        confirmLabel="导入并覆盖"
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    </section>
  );
}

/** 解析配置文件概要（宽松，仅用于导入前预览） */
function summarizeConfig(text: string): string {
  let cfg: { name?: string; data?: Record<string, unknown> };
  try {
    cfg = JSON.parse(text) as { name?: string; data?: Record<string, unknown> };
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (cfg.name !== 'LibreTV-Settings') throw new Error('不是 LibreTV 的配置文件');

  const parts: string[] = [];
  const settingsRaw = cfg.data?.[PERSIST_KEY];
  if (typeof settingsRaw === 'string') {
    try {
      const state = (JSON.parse(settingsRaw) as { state?: Record<string, unknown> }).state ?? {};
      const vod = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
      const live = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
      const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
      parts.push(`${vod} 个点播源`, `${live} 个直播源`, `${subs} 个订阅`);
    } catch {
      /* 设置片段损坏时忽略该部分统计 */
    }
  }
  const countArrayField = (key: string, label: string) => {
    const raw = cfg.data?.[key];
    if (raw == null) return;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) parts.push(`${parsed.length} ${label}`);
    } catch {
      /* 忽略 */
    }
  };
  countArrayField('viewingHistory', '条观看历史');
  countArrayField('playbackProgress', '条播放进度');
  countArrayField('searchHistory', '条搜索历史');
  countArrayField('liveProbe', '条直播测活');
  countArrayField('downloads', '条下载任务');
  return parts.length > 0 ? `该文件包含 ${parts.join('、')}` : '该文件未包含可导入的数据';
}

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast('请输入 API 名称和链接', 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast('API 链接需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip mb-2">
    <input
      className="input w-full"
      aria-label="点播源名称"
      placeholder="名称"
      value={name}
      onChange={(e) => setName(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="API 地址"
      placeholder="API 地址，如 https://example.com/api.php/provide/vod"
      value={url}
      onChange={(e) => setUrl(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="详情页地址（可选）"
      placeholder="详情页地址（可选），如 https://example.com"
      value={detail}
      onChange={(e) => setDetail(e.target.value)}
    />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-pink-500"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        标记为成人内容源（受成人过滤控制）
      </label>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {initial ? '更新' : '添加'}
        </button>
      </div>
    </div>
  );
}
