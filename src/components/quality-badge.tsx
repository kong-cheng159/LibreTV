'use client';

import { cn } from '@/lib/utils';
import { describeQualityBadge } from '@/lib/quality';
import type { QualityEntry } from '@/lib/types';

/**
 * 画质徽章：四态外观与 tooltip 都来自 describeQualityBadge（纯函数，可单测）。
 *
 * 「未探到」与「未知」在数据上都是没有 height，但含义相反：
 * 前者是请求失败可以重试，后者是源站本来就不给信息（单码率/直链）。
 * 所以失败态用琥珀色并渲染为可点击的 button；未知态保持灰 chip 且不可点。
 *
 * variant=overlay：压在封面上的角标，实心底 + 加粗，扫一眼就能看见档位。
 */
export function QualityBadge({
  entry,
  loading,
  onRetry,
  showReason,
  variant = 'default',
  className,
}: {
  entry?: QualityEntry;
  loading?: boolean;
  /** 失败态可重试；不传则失败态退化为普通徽章 */
  onRetry?: () => void;
  /** 就地显示失败原因（超时/防盗链/无资源）：触屏看不到 tooltip，需要可见文案 */
  showReason?: boolean;
  /** overlay = 封面角标（更大、更高对比） */
  variant?: 'default' | 'overlay';
  className?: string;
}) {
  const view = describeQualityBadge(entry, loading);
  if (!view) return null;

  const overlay = variant === 'overlay';
  const base = overlay
    ? 'inline-flex items-center justify-center shrink-0 rounded-md px-2 py-1 text-[11px] sm:text-xs font-bold tracking-wide shadow-md tabular-nums'
    : 'tag font-semibold shrink-0 tabular-nums';

  if (view.kind === 'loading') {
    return (
      <span
        className={cn(
          base,
          overlay ? 'bg-black/75 text-white/80 animate-pulse' : 'bg-chip text-faint animate-pulse',
          className
        )}
        title={view.title}
        aria-label="正在探测画质"
      >
        …
      </span>
    );
  }

  if (view.kind === 'value') {
    const height = entry?.height ?? 0;
    const tone = overlay
      ? height >= 1080
        ? 'bg-accent text-on-accent ring-1 ring-white/25'
        : height >= 720
          ? 'bg-black/85 text-white ring-1 ring-white/20'
          : 'bg-black/70 text-white/90'
      : height >= 1080
        ? 'bg-accent text-on-accent'
        : height >= 720
          ? 'bg-accent/20 text-accent'
          : height > 0 && height < 480
            ? 'bg-chip text-faint'
            : 'bg-chip text-muted';
    return (
      <span className={cn(base, tone, className)} title={view.title}>
        {view.label}
      </span>
    );
  }

  if (view.kind === 'failed' && view.retryable && onRetry) {
    return (
      <button
        type="button"
        // 徽章常嵌在整卡可点击区域里：拦住冒泡，否则点「重试」会变成打开详情
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onRetry();
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          base,
          overlay
            ? 'bg-warning-solid text-white hover:brightness-110 transition-[filter]'
            : 'bg-warning/15 text-warning hover:bg-warning/25 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40',
          className
        )}
        title={view.title}
        aria-label={`本次没测到画质${view.reason ? `（${view.reason}）` : ''}，点击重试`}
      >
        {view.label ?? '未测到'}
        {showReason && view.reason && <span className="ml-0.5 opacity-80">·{view.reason}</span>}
      </button>
    );
  }

  return (
    <span
      className={cn(
        base,
        view.kind === 'failed'
          ? overlay
            ? 'bg-warning-solid text-white'
            : 'bg-warning/15 text-warning'
          : overlay
            ? 'bg-black/70 text-white/80'
            : 'bg-chip text-faint',
        className
      )}
      title={view.title}
    >
      {view.kind === 'failed' ? view.label ?? '未测到' : '未知'}
      {showReason && view.reason && <span className="ml-0.5 opacity-80">·{view.reason}</span>}
    </span>
  );
}
