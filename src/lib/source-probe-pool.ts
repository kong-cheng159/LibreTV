import type { SourceSearchOutcome } from './types';

export const SOURCE_PROBE_CONCURRENCY = 8;

export interface ProbeSource {
  key: string;
  url: string;
}

/** 受控并发探测池；AbortSignal 终止后不再领取新任务，也不提交在途结果。 */
export async function runSourceProbePool(
  sources: ProbeSource[],
  test: (source: ProbeSource, signal: AbortSignal) => Promise<Omit<SourceSearchOutcome, 'sourceKey' | 'list'>>,
  signal: AbortSignal,
  onOutcome: (outcome: SourceSearchOutcome) => void,
  concurrency = SOURCE_PROBE_CONCURRENCY
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (signal.aborted) return;
      const index = cursor++;
      if (index >= sources.length) return;
      const source = sources[index];
      try {
        const result = await test(source, signal);
        if (signal.aborted) return;
        onOutcome({ sourceKey: source.key, ...result, list: [] });
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        onOutcome({
          sourceKey: source.key,
          ok: false,
          error: error instanceof Error ? error.message : '测试失败',
          list: [],
        });
      }
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), sources.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}
