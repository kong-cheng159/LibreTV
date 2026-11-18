'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import type { SourceSearchOutcome } from '@/lib/types';
import { runSourceProbePool, SOURCE_PROBE_CONCURRENCY } from '@/lib/source-probe-pool';

/**
 * 点播源批量探活 hook：
 * - 受控并发（点播源上限 100，客户端 8 路并发，服务端同域最多 3 路）；
 * - 进度实时回传（已完成 / 总数 / 可用数），可随时中止（已完成结果保留）；
 * - 结果写入 store 的 sourceHealth，与搜索过程共用同一份健康度模型
 *   （因此连续失败达阈值会临时停用，与搜索行为一致，不再出现两套「健康度」）。
 */

export interface SourceProbeProgress {
  done: number;
  total: number;
  /** 已完成中可用的数量（能返回搜索结果） */
  ok: number;
  /** 本轮开始时间（用于估算剩余时间） */
  startedAt: number;
}

export function useSourceProbe() {
  const [progress, setProgress] = useState<SourceProbeProgress | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      // 卸载时作废在途轮次，避免结果写回已卸载组件的状态
      runIdRef.current++;
      abortRef.current?.abort();
    },
    []
  );

  /** 中止在途测活：已完成的结果保留 */
  const cancel = useCallback(() => {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
  }, []);

  const probe = useCallback(async (sources: { key: string; url: string }[]) => {
    if (sources.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = ++runIdRef.current;
    const total = sources.length;
    const startedAt = Date.now();
    setProgress({ done: 0, total, ok: 0, startedAt });

    let done = 0;
    let okCount = 0;
    // 进度写回节流：批量测活结果密集到达，避免每个源都触发一次渲染
    let lastFlush = 0;
    const flush = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 150) return;
      lastFlush = now;
      setProgress({ done, total, ok: okCount, startedAt });
    };

    await runSourceProbePool(
      sources,
      async (source, signal) => {
        const result = await api.testSource(source.url, signal);
        return { ok: result.ok, ms: result.ms, error: result.error };
      },
      controller.signal,
      (outcome: SourceSearchOutcome) => {
        if (runIdRef.current !== runId) return;
        done++;
        if (outcome.ok) okCount++;
        // 逐条写入：取消本轮时，已经完成的健康度结果仍然保留。
        useAppStore.getState().recordSourceHealth([outcome]);
        flush();
      }
    );
    if (runIdRef.current !== runId) return undefined;
    abortRef.current = null;
    setProgress(null);
    // 返回汇总供调用方提示；被取消时返回 undefined
    return { total, ok: okCount };
  }, []);

  return { progress, probe, cancel, isProbing: progress !== null, concurrency: SOURCE_PROBE_CONCURRENCY };
}
