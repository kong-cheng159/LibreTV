'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { useDownloadSlot } from './download-slot';
import { db, type DownloadStatus, type DownloadTaskEntry } from '@/lib/db';
import { PauseResumeController, clearDownloadChunks, runDownloadJob, supportsChunkCache, type DownloadProgress } from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import { detectSavingCapability, pickSaveTarget, releaseSavedBlob, triggerBrowserDownload, type SaveTarget } from '@/lib/download-saver';
import { Switch } from './settings-shared';
import { cn } from '@/lib/utils';
import { groupDownloadTasks } from '@/lib/download-groups';

const MAX_CONCURRENT_DOWNLOADS = 3;
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  videoTitle?: string;
  cover?: string;
  sourceKey?: string;
  vodId?: string;
  episodeIndex?: number;
  episodeTitle?: string;
  totalEpisodes?: number;
  format?: 'TS' | 'MP4';
}

interface RunningHandle { abort: AbortController; pause: PauseResumeController }
function taskProgress(task: DownloadTaskEntry): number {
  if (task.status === 'completed') return 100;
  return task.total > 0 ? Math.min(100, Math.round((task.finished / task.total) * 100)) : 0;
}
function formatBytes(bytes?: number): string {
  if (bytes == null || bytes < 0) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '未知';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export function DownloadManager({ isOpen, onClose, portalTarget = null }: { isOpen: boolean; onClose: () => void; portalTarget?: HTMLElement | null }) {
  const panelVisible = isOpen || !!portalTarget;
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'fs-access' | 'memory'>('memory');
  const [chunkCache, setChunkCache] = useState(true);
  const [proxy, setProxy] = useState(false);
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = useRef(new Map<string, RunningHandle>());
  const saveTargets = useRef(new Map<string, SaveTarget>());
  const savedTargets = useRef(new Map<string, SaveTarget>());

  const refresh = useCallback(() => { void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks); }, []);
  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);
  useEffect(() => setProxy(loadDownloadSettings().proxy), []);

  const scheduleNextRef = useRef<() => void>(() => {});
  const startTask = useCallback(async (entry: DownloadTaskEntry) => {
    if (running.current.has(entry.id)) return;
    const abort = new AbortController();
    const pause = new PauseResumeController();
    running.current.set(entry.id, { abort, pause });
    const startedAt = entry.startedAt ?? Date.now();
    await updateEntry(entry.id, { status: 'downloading', startedAt, errorMessage: undefined });
    const target = saveTargets.current.get(entry.id) ?? {
      kind: 'memory' as const, filename: '',
      write: async () => { throw new Error('保存位置已失效，请点击「继续」重新选择'); },
      close: async () => {}, abort: async () => {}, savedUrl: () => null,
    };
    const savedToDisk = target.kind === 'fs';
    let lastPersistAt = 0;
    let lastSampleAt = Date.now();
    let lastSampleBytes = entry.downloadedBytes ?? 0;
    let smoothedSpeed = entry.bytesPerSecond ?? 0;
    const onProgress = (progress: DownloadProgress) => {
      const status: DownloadStatus = progress.status === 'done' ? 'completed' : progress.status === 'error' ? 'error' : 'downloading';
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - lastSampleAt) / 1000);
      const deltaBytes = Math.max(0, progress.downloadedBytes - lastSampleBytes);
      if (deltaBytes > 0 && elapsed >= 0.25) {
        const instant = deltaBytes / elapsed;
        smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.65 + instant * 0.35 : instant;
        lastSampleAt = now;
        lastSampleBytes = progress.downloadedBytes;
      }
      const estimatedTotal = progress.totalBytes
        ?? (progress.current > 0 ? progress.downloadedBytes / progress.current * progress.total : undefined);
      const remaining = estimatedTotal && smoothedSpeed > 0
        ? Math.max(0, (estimatedTotal - progress.downloadedBytes) / smoothedSpeed)
        : undefined;
      const patch: Partial<DownloadTaskEntry> = {
        finished: progress.current,
        total: progress.total,
        status,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes ?? estimatedTotal,
        bytesPerSecond: status === 'downloading' ? smoothedSpeed : 0,
        estimatedSeconds: status === 'downloading' ? remaining : 0,
        ...(status === 'completed' ? { savedToDisk, completedAt: now, outputPath: target.kind === 'fs' ? target.filename : undefined } : null),
      };
      setTasks((prev) => prev.map((task) => task.id === entry.id ? { ...task, ...patch } : task));
      if (progress.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
      lastPersistAt = now;
      void db.downloads.update(entry.id, { ...patch, updatedAt: now });
    };
    void runDownloadJob({ taskId: entry.id, url: entry.url, title: entry.title, format: entry.format, signal: abort.signal, pause, proxy, onProgress, target })
      .then(async () => {
        if (!savedToDisk && target.savedUrl()) savedTargets.current.set(entry.id, target);
        saveTargets.current.delete(entry.id);
        await updateEntry(entry.id, { status: 'completed', savedToDisk, completedAt: Date.now(), bytesPerSecond: 0, estimatedSeconds: 0, outputPath: target.kind === 'fs' ? target.filename : undefined });
        void clearDownloadChunks(entry.id);
        toast(savedToDisk ? `《${entry.title}》已保存` : `《${entry.title}》已生成，请确认浏览器已保存`, 'success');
      })
      .catch(async (error: Error) => {
        if (abort.signal.aborted) return;
        await updateEntry(entry.id, { status: 'error', errorMessage: error.message, bytesPerSecond: 0, estimatedSeconds: undefined, errorNum: (entry.errorNum ?? 0) + 1 });
        toast(`《${entry.title}》下载失败：${error.message}`, 'error');
      })
      .finally(() => { running.current.delete(entry.id); scheduleNextRef.current(); });
  }, [proxy, toast, updateEntry]);

  const scheduleNext = useCallback(() => {
    void (async () => {
      const room = MAX_CONCURRENT_DOWNLOADS - running.current.size;
      if (room <= 0) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      const waiting = all.filter((task) => task.status === 'waiting' && !running.current.has(task.id) && saveTargets.current.has(task.id));
      for (const task of waiting.slice(0, room)) void startTask(task);
    })();
  }, [startTask]);
  scheduleNextRef.current = scheduleNext;

  useEffect(() => {
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      if (!supportsChunkCache()) { toast('当前环境不支持下载缓存（需通过 HTTPS 访问），无法下载', 'error'); return; }
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try { saveTargets.current.set(id, await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`)); }
        catch (error) { if (error instanceof Error && error.message.includes('取消')) toast('已取消下载', 'info'); return; }
        const entry: DownloadTaskEntry = {
          id, url: detail.url, title: detail.title, videoTitle: detail.videoTitle, cover: detail.cover,
          sourceKey: detail.sourceKey, vodId: detail.vodId, episodeIndex: detail.episodeIndex,
          episodeTitle: detail.episodeTitle, totalEpisodes: detail.totalEpisodes, format,
          status: 'waiting', finished: 0, total: 0, errorNum: 0, createdAt: Date.now(), updatedAt: Date.now(),
        };
        await db.downloads.put(entry);
        refresh(); scheduleNextRef.current();
        toast(`《${detail.title}》已加入下载队列`, 'success');
      })();
    };
    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TASK_EVENT, onAdd);
  }, [refresh, toast]);

  useEffect(() => {
    if (!panelVisible) return;
    setCapability(detectSavingCapability()); setChunkCache(supportsChunkCache());
    setProxy(loadDownloadSettings().proxy); refresh(); scheduleNext();
  }, [panelVisible, refresh, scheduleNext]);

  const chooseTarget = async (entry: DownloadTaskEntry): Promise<boolean> => {
    try { saveTargets.current.set(entry.id, await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`)); return true; }
    catch (error) { if (error instanceof Error && error.message.includes('取消')) toast('已取消', 'info'); return false; }
  };
  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && entry.status === 'downloading') { handle.pause.pause(); await updateEntry(entry.id, { status: 'paused' }); return; }
    if (handle && entry.status === 'paused') { handle.pause.resume(); await updateEntry(entry.id, { status: 'downloading' }); return; }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      if (!saveTargets.current.has(entry.id) && !(await chooseTarget(entry))) return;
      await updateEntry(entry.id, { status: 'waiting' }); scheduleNext();
    }
  };
  const onResave = (entry: DownloadTaskEntry) => {
    const target = savedTargets.current.get(entry.id); const url = target?.savedUrl();
    if (!target || !url) { toast('暂存数据已失效，请重新下载', 'error'); return; }
    triggerBrowserDownload(url, target.filename || `${entry.title}.${entry.format.toLowerCase()}`); toast(`已再次发起《${entry.title}》保存`, 'info');
  };
  const onRedownload = async (entry: DownloadTaskEntry) => {
    if (!(await chooseTarget(entry))) return;
    savedTargets.current.delete(entry.id); await updateEntry(entry.id, { status: 'waiting', finished: 0, downloadedBytes: 0, totalBytes: undefined, bytesPerSecond: 0, estimatedSeconds: undefined, startedAt: undefined, completedAt: undefined, errorMessage: undefined, outputPath: undefined }); scheduleNext();
  };
  const removeTasks = useCallback(async (entries: DownloadTaskEntry[]) => {
    for (const entry of entries) {
      running.current.get(entry.id)?.abort.abort(); running.current.delete(entry.id); saveTargets.current.delete(entry.id);
      const pending = savedTargets.current.get(entry.id); if (pending) releaseSavedBlob(pending); savedTargets.current.delete(entry.id);
      await clearDownloadChunks(entry.id); await db.downloads.delete(entry.id);
    }
    refresh(); scheduleNextRef.current();
  }, [refresh]);
  const onDelete = async (entries: DownloadTaskEntry[]) => {
    const label = entries.length > 1 ? `${entries.length} 个任务` : `《${entries[0]?.title ?? ''}》`;
    if (!window.confirm(`确定删除${label}的下载记录？已保存到磁盘的文件不会被删除。`)) return;
    await removeTasks(entries);
    setSelected((current) => { const next = new Set(current); entries.forEach((entry) => next.delete(entry.id)); return next; });
    toast(`已删除${label}`, 'info');
  };

  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== 'completed'), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === 'completed'), [tasks]);
  const visibleTasks = tab === 'active' ? activeTasks : completedTasks;
  const groups = useMemo(() => groupDownloadTasks(visibleTasks), [visibleTasks]);
  const selectedTasks = useMemo(() => tasks.filter((task) => selected.has(task.id)), [selected, tasks]);
  const downloadingCount = tasks.filter((task) => task.status === 'downloading').length;
  const waitingCount = tasks.filter((task) => task.status === 'waiting').length;
  const pausedCount = tasks.filter((task) => task.status === 'paused').length;
  useEffect(() => {
    if (tab !== 'active') return;
    setExpanded((current) => { const next = new Set(current); groups.forEach((group) => next.add(group.key)); return next; });
  }, [groups, tab]);

  const pauseAll = async () => {
    for (const entry of tasks.filter((task) => task.status === 'downloading')) {
      const handle = running.current.get(entry.id);
      if (handle) { handle.pause.pause(); await db.downloads.update(entry.id, { status: 'paused', updatedAt: Date.now() }); }
    }
    refresh();
  };
  const resumeAll = async () => {
    const entries = tasks.filter((task) => task.status === 'paused' && running.current.has(task.id));
    for (const entry of entries) { running.current.get(entry.id)?.pause.resume(); await db.downloads.update(entry.id, { status: 'downloading', updatedAt: Date.now() }); }
    refresh(); if (entries.length === 0) toast('刷新后暂停的任务需要逐个选择保存位置再继续', 'info');
  };
  const statusLabel: Record<DownloadStatus, string> = { waiting: '排队中', downloading: '下载中', paused: '已暂停', completed: '已完成', error: '下载失败' };
  const episodeLabel = (task: DownloadTaskEntry) => task.episodeTitle || (task.episodeIndex != null ? `第 ${task.episodeIndex + 1} 集` : task.title);
  const toggleSelected = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const panel = (
    <div className={portalTarget ? 'h-full min-h-0 flex flex-col overflow-hidden' : 'space-y-3'}>
      <div className="shrink-0 space-y-3 mb-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-xl bg-chip p-1 w-fit">
            <button type="button" className={cn('px-4 py-2 rounded-lg text-sm transition-colors', tab === 'active' ? 'bg-card text-content shadow-sm' : 'text-muted hover:text-content')} onClick={() => { setTab('active'); setEditing(false); }}>下载中 <span className="ml-1 text-xs text-faint">{activeTasks.length}</span></button>
            <button type="button" className={cn('px-4 py-2 rounded-lg text-sm transition-colors', tab === 'completed' ? 'bg-card text-content shadow-sm' : 'text-muted hover:text-content')} onClick={() => { setTab('completed'); setEditing(false); }}>已完成 <span className="ml-1 text-xs text-faint">{completedTasks.length}</span></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {tab === 'active' && downloadingCount > 0 && <button type="button" className="btn-ghost btn-sm" onClick={() => void pauseAll()}>全部暂停</button>}
            {tab === 'active' && pausedCount > 0 && <button type="button" className="btn-ghost btn-sm" onClick={() => void resumeAll()}>全部继续</button>}
            <button type="button" className={cn('btn-ghost btn-sm', editing && '!border-accent !text-accent')} onClick={() => { setEditing((value) => !value); setSelected(new Set()); }}><Icon name="edit" className="w-3.5 h-3.5" />{editing ? '完成' : '管理'}</button>
            <button type="button" className={cn('btn-ghost btn-sm', settingsOpen && '!border-accent !text-accent')} onClick={() => setSettingsOpen((value) => !value)}><Icon name="gear" className="w-3.5 h-3.5" />设置</button>
          </div>
        </div>
        {tab === 'active' && <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {([['正在下载', downloadingCount, 'text-accent'], ['排队等待', waitingCount, 'text-warning'], ['已暂停', pausedCount, 'text-muted']] as const).map(([label, count, color]) => <div key={label} className="card px-3 py-2.5 sm:px-4"><p className="text-[11px] text-faint">{label}</p><p className={cn('mt-0.5 text-xl font-semibold font-display', color)}>{count}</p></div>)}
        </div>}
        {settingsOpen && <div className="card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><p className="text-sm text-content">经服务器中转下载</p><p className="mt-1 text-xs text-faint">{capability === 'fs-access' ? '磁盘直写' : '内存聚合后由浏览器保存'} · {chunkCache ? '支持断点续传' : '当前环境不支持断点缓存'} · 并发上限 {MAX_CONCURRENT_DOWNLOADS}</p></div><Switch checked={proxy} onChange={(next) => { setProxy(saveDownloadSettings({ proxy: next }).proxy); toast(next ? '已开启下载中转' : '已关闭下载中转', 'info'); }} label="经服务器中转下载" /></div>}
        {editing && <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 flex items-center justify-between gap-3"><button type="button" className="text-xs text-accent" onClick={() => setSelected(new Set(visibleTasks.map((task) => task.id)))}>全选当前页</button><div className="flex items-center gap-3"><span className="text-xs text-muted">已选 {selectedTasks.length} 项</span><button type="button" disabled={!selectedTasks.length} className="btn btn-sm bg-danger-solid text-white" onClick={() => void onDelete(selectedTasks)}><Icon name="trash" className="w-3.5 h-3.5" />删除</button></div></div>}
      </div>

      <div className={portalTarget ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin space-y-3 pr-0.5' : 'space-y-3'}>
        {!groups.length && <div className="h-full min-h-56 flex flex-col items-center justify-center text-center text-faint"><div className="w-14 h-14 rounded-2xl bg-chip flex items-center justify-center mb-3"><Icon name={tab === 'active' ? 'download' : 'check'} className="w-7 h-7" /></div><p className="text-sm text-muted">{tab === 'active' ? '暂无下载任务' : '暂无已完成内容'}</p><p className="mt-1 text-xs">{tab === 'active' ? '在播放页点击“下载”即可添加离线内容' : '完成的影片会集中显示在这里'}</p></div>}
        {groups.map((group) => {
          const open = expanded.has(group.key);
          const progress = group.total > 0 ? Math.min(100, Math.round((group.finished / group.total) * 100)) : group.completed === group.tasks.length ? 100 : 0;
          return <section key={group.key} className="card !rounded-2xl">
            <div className="p-3 sm:p-4 flex gap-3 sm:gap-4">
              <div className="w-20 sm:w-24 aspect-[2/3] shrink-0 rounded-lg overflow-hidden bg-chip">{group.cover ? <img src={group.cover} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-faint"><Icon name="download" className="w-7 h-7" /></div>}</div>
              <div className="min-w-0 flex-1 flex flex-col"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="font-medium text-content truncate">{group.title}</h2><p className="mt-1 text-xs text-faint">{group.completed}/{group.tasks.length} 集完成{group.tasks[0]?.totalEpisodes ? ` · 共 ${group.tasks[0].totalEpisodes} 集` : ''}</p></div><div className="flex items-center gap-1 shrink-0">{editing && <input type="checkbox" aria-label={`选择 ${group.title}`} checked={group.tasks.every((task) => selected.has(task.id))} onChange={(event) => setSelected((current) => { const next = new Set(current); group.tasks.forEach((task) => event.target.checked ? next.add(task.id) : next.delete(task.id)); return next; })} className="w-4 h-4" />}<button type="button" aria-label={open ? '收起' : '展开'} className="p-2 rounded-lg hover:bg-hover text-muted" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}><Icon name="chevronDown" className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} /></button></div></div><div className="mt-auto pt-4"><div className="flex items-center justify-between text-xs mb-1.5"><span className="text-muted">总体进度</span><span className="text-content tabular-nums">{progress}%</span></div><div className="h-1.5 rounded-full bg-chip overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} /></div></div></div>
            </div>
            {open && <div className="border-t border-line p-3 sm:p-4 bg-surface/40 grid grid-cols-1 xl:grid-cols-2 gap-2">
              {group.tasks.map((task) => {
                const label = task.status === 'completed' && task.savedToDisk === false ? '待确认保存' : statusLabel[task.status];
                return <div key={task.id} className={cn('rounded-xl border border-line bg-card p-3 flex items-center gap-3', selected.has(task.id) && 'border-accent bg-accent/5')}>
                  {editing && <input type="checkbox" aria-label={`选择 ${episodeLabel(task)}`} checked={selected.has(task.id)} onChange={() => toggleSelected(task.id)} className="w-4 h-4 shrink-0" />}
                  <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="text-sm text-content truncate">{episodeLabel(task)}</p><span className={cn('text-[11px] shrink-0', task.status === 'error' ? 'text-danger' : task.status === 'downloading' ? 'text-accent' : task.status === 'completed' ? 'text-success' : 'text-faint')}>{label}</span></div><div className="mt-1.5 flex items-center gap-2"><div className="h-1 flex-1 rounded-full bg-chip overflow-hidden"><div className={cn('h-full transition-all', task.status === 'error' ? 'bg-danger' : task.status === 'completed' ? 'bg-success' : 'bg-accent')} style={{ width: `${taskProgress(task)}%` }} /></div><span className="text-[10px] text-faint tabular-nums w-8 text-right">{taskProgress(task)}%</span></div><p className="mt-1 text-[10px] text-faint">{task.format}{task.total > 0 && task.status !== 'completed' ? ` · ${task.finished}/${task.total} 分片` : ''}{task.downloadedBytes != null ? ` · ${formatBytes(task.downloadedBytes)}${task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ''}` : ''}</p>{task.status === 'downloading' && <p className="mt-1 text-[10px] text-accent">{formatBytes(task.bytesPerSecond)}/s · 预计剩余 {formatDuration(task.estimatedSeconds)}</p>}{task.status === 'error' && task.errorMessage && <p className="mt-1 text-[10px] text-danger line-clamp-2" title={task.errorMessage}>{task.errorMessage}</p>}{task.status === 'completed' && <p className="mt-1 text-[10px] text-faint">{task.completedAt ? `完成于 ${new Date(task.completedAt).toLocaleString()}` : '已完成'}{task.outputPath ? ` · ${task.outputPath}` : ''}</p>}</div>
                  {!editing && <div className="flex items-center gap-1 shrink-0">{(task.status === 'downloading' || task.status === 'paused' || task.status === 'waiting' || task.status === 'error') && <button type="button" className="btn-ghost btn-sm" onClick={() => void onPauseResume(task)}>{task.status === 'downloading' ? '暂停' : '继续'}</button>}{task.status === 'completed' && task.savedToDisk === false && savedTargets.current.has(task.id) && <button type="button" className="btn-ghost btn-sm" onClick={() => onResave(task)}>保存</button>}{task.status === 'completed' && task.savedToDisk === false && !savedTargets.current.has(task.id) && <button type="button" className="btn-ghost btn-sm" onClick={() => void onRedownload(task)}>重下</button>}<button type="button" aria-label="删除任务" className="p-1.5 rounded-lg text-faint hover:text-danger hover:bg-danger/10" onClick={() => void onDelete([task])}><Icon name="trash" className="w-4 h-4" /></button></div>}
                </div>;
              })}
            </div>}
          </section>;
        })}
      </div>
    </div>
  );
  if (portalTarget) return createPortal(panel, portalTarget);
  return <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-4xl">{panel}</Drawer>;
}

export function enqueueDownload(payload: AddDownloadPayload): void { window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload })); }
export function requestShowDownloadManager(): void { window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT)); }
export function GlobalDownloadManager() {
  const router = useRouter(); const { slot } = useDownloadSlot();
  useEffect(() => { const onShow = () => router.push('/downloads'); window.addEventListener(SHOW_MANAGER_EVENT, onShow); return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow); }, [router]);
  return <DownloadManager isOpen={false} onClose={() => router.push('/')} portalTarget={slot} />;
}
