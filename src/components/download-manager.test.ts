import { describe, expect, it } from 'vitest';
import type { DownloadTaskEntry } from '@/lib/db';
import { downloadTaskGroupKey, groupDownloadTasks } from '@/lib/download-groups';

function task(patch: Partial<DownloadTaskEntry>): DownloadTaskEntry {
  return {
    id: patch.id ?? 'task',
    url: patch.url ?? 'https://example.com/index.m3u8',
    title: patch.title ?? '测试剧 第1集',
    format: 'MP4',
    status: 'waiting',
    finished: 0,
    total: 0,
    errorNum: 0,
    createdAt: patch.createdAt ?? 1,
    updatedAt: patch.updatedAt ?? 1,
    ...patch,
  };
}

describe('下载中心影片分组', () => {
  it('同一来源与影片的多集归为一组并按集数排序', () => {
    const groups = groupDownloadTasks([
      task({ id: '2', sourceKey: 'a', vodId: '10', videoTitle: '测试剧', episodeIndex: 1 }),
      task({ id: '1', sourceKey: 'a', vodId: '10', videoTitle: '测试剧', episodeIndex: 0 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tasks.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('同名但来源或 vodId 不同的影片不会混组', () => {
    const first = task({ sourceKey: 'a', vodId: '10', videoTitle: '同名影片' });
    const second = task({ sourceKey: 'b', vodId: '10', videoTitle: '同名影片' });
    expect(downloadTaskGroupKey(first)).not.toBe(downloadTaskGroupKey(second));
    expect(groupDownloadTasks([first, second])).toHaveLength(2);
  });

  it('旧任务可从末尾集数提取影片名作为后备分组', () => {
    const groups = groupDownloadTasks([
      task({ id: '1', title: '旧版剧 第1集' }),
      task({ id: '2', title: '旧版剧 第2集' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('旧版剧');
  });
});
