'use client';

import { AppShell } from '@/components/app-shell';
import { HistoryWorkspace } from '@/components/history-panel';

/**
 * 历史页：壳层锁高；页头与搜索固定，仅列表内部滚动。
 */
export default function HistoryPage() {
  return (
    <AppShell fill>
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <header className="shell shrink-0 pt-5 sm:pt-7 pb-4 max-w-3xl w-full">
          <p className="text-[10.5px] font-semibold tracking-[0.18em] uppercase text-faint mb-1">Library</p>
          <h1 className="section-title">历史记录</h1>
          <p className="mt-1.5 text-sm text-muted">本机观看进度，不会上传到服务器</p>
        </header>
        <div className="shell flex-1 min-h-0 pb-4 sm:pb-5 max-w-3xl w-full">
          <HistoryWorkspace />
        </div>
      </main>
    </AppShell>
  );
}
