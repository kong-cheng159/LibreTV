import { describe, expect, it, vi } from 'vitest';
import { runSourceProbePool, SOURCE_PROBE_CONCURRENCY } from './source-probe-pool';

const sources = (count: number, host = 'example.com') =>
  Array.from({ length: count }, (_, index) => ({ key: `source-${index}`, url: `https://${host}/${index}` }));

describe('runSourceProbePool', () => {
  it('默认同时在途不超过 8 路', async () => {
    let active = 0;
    let peak = 0;
    const outcomes: string[] = [];
    await runSourceProbePool(
      sources(24),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true, ms: 5 };
      },
      new AbortController().signal,
      (outcome) => outcomes.push(outcome.sourceKey)
    );
    expect(SOURCE_PROBE_CONCURRENCY).toBe(8);
    expect(peak).toBe(8);
    expect(outcomes).toHaveLength(24);
  });

  it('取消后不再领取任务，也不提交在途结果', async () => {
    const controller = new AbortController();
    const completed = vi.fn();
    let started = 0;
    const promise = runSourceProbePool(
      sources(30),
      async (_source, signal) => {
        started++;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return { ok: true, ms: 1 };
      },
      controller.signal,
      completed
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await promise;
    expect(started).toBe(8);
    expect(completed).not.toHaveBeenCalled();
  });

  it('单个失败不会阻断其它源', async () => {
    const results: { key: string; ok: boolean }[] = [];
    await runSourceProbePool(
      sources(3),
      async (source) => {
        if (source.key === 'source-1') throw new Error('不可用');
        return { ok: true, ms: 1 };
      },
      new AbortController().signal,
      (outcome) => results.push({ key: outcome.sourceKey, ok: outcome.ok })
    );
    expect(results).toHaveLength(3);
    expect(results.find((item) => item.key === 'source-1')?.ok).toBe(false);
  });
});
