'use client';

import { AppShell } from '@/components/app-shell';
import { DownloadPageAnchor } from '@/components/download-slot';

/**
 * 下载页：壳层锁高；页头固定，任务列表在锚点内滚动。
 */
export default function DownloadsPage() {
  return (
    <AppShell fill>
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <header className="shell shrink-0 pt-5 sm:pt-7 pb-4 max-w-3xl w-full">
          <p className="text-[10.5px] font-semibold tracking-[0.18em] uppercase text-faint mb-1">Library</p>
          <h1 className="section-title">下载管理</h1>
          <p className="mt-1.5 text-sm text-muted">任务队列、断点续传与保存位置</p>
        </header>
        <div className="shell flex-1 min-h-0 pb-4 sm:pb-5 max-w-3xl w-full overflow-hidden flex flex-col">
          <DownloadPageAnchor className="h-full min-h-0 flex flex-col overflow-hidden" />
        </div>
      </main>
    </AppShell>
  );
}
