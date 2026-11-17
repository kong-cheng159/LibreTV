'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionTitle } from './settings-shared';
import { useToast } from './toast';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'available'; version: string; notes: string | null; date: string | null }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

/**
 * 桌面端「检查更新」面板。非 Tauri 环境不渲染。
 * 更新元数据来自 GitHub Release 的 latest.json（需打包时签名）。
 */
export function DesktopUpdaterPanel() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    if (!isTauriRuntime()) return;
    setEnabled(true);
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setCurrentVersion(await getVersion());
      } catch {
        setCurrentVersion('');
      }
    })();
  }, []);

  const check = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setState({ kind: 'checking' });
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const { getVersion } = await import('@tauri-apps/api/app');
      const version = await getVersion();
      setCurrentVersion(version);
      const update = await checkUpdate();
      if (!update) {
        setState({ kind: 'up-to-date', version });
        toast('已是最新版本', 'success');
        return;
      }
      setState({
        kind: 'available',
        version: update.version,
        notes: update.body ?? null,
        date: update.date ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
      toast(`检查更新失败：${message}`, 'error');
    }
  }, [toast]);

  const install = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setState({ kind: 'downloading', percent: 0 });
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      const update = await checkUpdate();
      if (!update) {
        setState({ kind: 'up-to-date', version: currentVersion });
        toast('已是最新版本', 'success');
        return;
      }
      let downloaded = 0;
      let contentLength: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? null;
          setState({ kind: 'downloading', percent: 0 });
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const percent =
            contentLength && contentLength > 0
              ? Math.min(100, Math.round((downloaded / contentLength) * 100))
              : null;
          setState({ kind: 'downloading', percent });
        } else if (event.event === 'Finished') {
          setState({ kind: 'installing' });
        }
      });
      toast('更新已就绪，即将重启…', 'success');
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
      toast(`安装更新失败：${message}`, 'error');
    }
  }, [currentVersion, toast]);

  if (!enabled) return null;

  return (
    <section className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin space-y-3">
      <SectionTitle
        title="桌面更新"
        hint="从 GitHub Release 检查新版本；覆盖安装并保留本机数据"
      />
      <div className="card p-3 space-y-2">
        <p className="text-sm text-content">
          当前版本：<span className="font-mono text-accent">{currentVersion || '…'}</span>
        </p>
        {state.kind === 'available' && (
          <div className="rounded-lg border border-line bg-chip/50 p-2.5 text-xs text-muted space-y-1">
            <p className="text-content text-sm">
              发现新版本 <span className="font-mono text-accent">{state.version}</span>
            </p>
            {state.date && <p>发布于 {state.date}</p>}
            {state.notes && (
              <pre className="whitespace-pre-wrap font-sans text-faint max-h-40 overflow-y-auto">
                {state.notes}
              </pre>
            )}
          </div>
        )}
        {state.kind === 'up-to-date' && (
          <p className="text-xs text-success">已是最新版本（{state.version}）</p>
        )}
        {state.kind === 'downloading' && (
          <p className="text-xs text-muted">
            正在下载更新
            {state.percent != null ? `… ${state.percent}%` : '…'}
          </p>
        )}
        {state.kind === 'installing' && (
          <p className="text-xs text-muted">正在安装并准备重启…</p>
        )}
        {state.kind === 'error' && (
          <p className="text-xs text-danger break-words">{state.message}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn-ghost flex-1 text-xs"
            disabled={state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'installing'}
            onClick={() => void check()}
          >
            {state.kind === 'checking' ? '检查中…' : '检查更新'}
          </button>
          {state.kind === 'available' && (
            <button
              type="button"
              className="btn-primary flex-1 text-xs"
              onClick={() => void install()}
            >
              下载并安装
            </button>
          )}
        </div>
        <p className="text-[11px] text-faint leading-relaxed">
          需在 GitHub Release 发布带签名的安装包与 latest.json。未配置发布通道时检查会失败，不影响日常使用。
        </p>
      </div>
    </section>
  );
}
