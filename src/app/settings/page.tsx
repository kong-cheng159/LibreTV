'use client';

import { AppShell } from '@/components/app-shell';
import { SettingsWorkspace } from '@/components/source-manager';

/**
 * 源与系统设置页：壳层锁高，仅右侧内容台内部滚动，避免整页滚走导航。
 */
export default function SettingsPage() {
  return (
    <AppShell fill>
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <header className="shell shrink-0 pt-5 sm:pt-7 pb-4">
          <p className="text-[11px] font-semibold tracking-[0.22em] uppercase text-accent/90 mb-1.5">
            Control Deck
          </p>
          <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-content">
            源与系统设置
          </h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted leading-relaxed">
            管理点播与直播源、播放偏好与本机数据。改完即生效，全部保存在本设备。
          </p>
        </header>

        <div className="shell flex-1 min-h-0 pb-4 sm:pb-5">
          <SettingsWorkspace layout="page" className="h-full min-h-0" />
        </div>
      </main>
    </AppShell>
  );
}
