import type { DownloadTaskEntry } from './db';

export interface DownloadGroup {
  key: string;
  title: string;
  cover?: string;
  tasks: DownloadTaskEntry[];
  finished: number;
  total: number;
  completed: number;
}

function legacyVideoTitle(title: string): string {
  return title.replace(/\s*第\s*\d+\s*[集话期]\s*$/u, '').replace(/\s*[Ee][Pp]?\.?\s*\d+\s*$/u, '').trim() || title;
}

export function downloadTaskGroupKey(task: DownloadTaskEntry): string {
  if (task.sourceKey && task.vodId) return `${task.sourceKey}:${task.vodId}`;
  return `legacy:${(task.videoTitle || legacyVideoTitle(task.title)).toLocaleLowerCase()}`;
}

export function groupDownloadTasks(tasks: DownloadTaskEntry[]): DownloadGroup[] {
  const map = new Map<string, DownloadGroup>();
  for (const task of tasks) {
    const key = downloadTaskGroupKey(task);
    const current = map.get(key) ?? {
      key,
      title: task.videoTitle || legacyVideoTitle(task.title),
      cover: task.cover,
      tasks: [],
      finished: 0,
      total: 0,
      completed: 0,
    };
    current.tasks.push(task);
    current.cover ||= task.cover;
    current.finished += task.finished;
    current.total += task.total;
    if (task.status === 'completed') current.completed += 1;
    map.set(key, current);
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      tasks: group.tasks.sort((a, b) =>
        a.episodeIndex != null && b.episodeIndex != null
          ? a.episodeIndex - b.episodeIndex
          : a.createdAt - b.createdAt
      ),
    }))
    .sort((a, b) =>
      Math.max(...b.tasks.map((task) => task.updatedAt)) -
      Math.max(...a.tasks.map((task) => task.updatedAt))
    );
}
