import Dexie, { type EntityTable } from 'dexie';
import type { SourceConfig } from './types';
// 仅类型引入：store.ts 运行时会引用本模块，反向只取类型不会形成运行时循环
import type { LiveProbeEntry } from './store';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';

/**
 * IndexedDB 持久化（替代旧版 localStorage 数据库）：
 * - 观看历史不再冗余存储全集 URL 列表（旧版长剧 × 50 条极易撑爆 5MB 配额），
 *   只存定位信息（sourceKey+vodId+index），进入播放页时按需重新拉详情，
 *   顺带免费获得「剧集更新同步」能力。
 * - v2：直播测活缓存从 localStorage（随 zustand persist 整体重写）迁入独立表，
 *   高频写入不再拖累设置快照的序列化。
 */

export interface HistoryEntry {
  /** 主键：`${sourceKey}_${vodId}` */
  id: string;
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  title: string;
  pic?: string;
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  timestamp: number;
}

export interface ProgressEntry {
  key: string; // `${sourceKey}_${vodId}_${episodeIndex}`
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SearchHistoryEntry {
  text: string;
  timestamp: number;
}

export interface SegmentMetaEntry {
  /** Cache Storage 中的 key（归一化的分片绝对地址，或同源代理地址） */
  key: string;
  /** 所属剧集：`${source}:${vodId}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  bytes: number;
  /** 预取时记录的真实耗时（毫秒），loader 命中缓存时合成进 hls.js stats 防 ABR 误判 */
  costMs: number;
  lastAccess: number;
}

export type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadTaskEntry {
  id: string;
  /** 播放页 m3u8 地址（直连或代理形式，入队时的原样） */
  url: string;
  /** 影片级元数据：用于下载中心按影片分组；均为可选以兼容旧记录。 */
  videoTitle?: string;
  cover?: string;
  sourceKey?: string;
  vodId?: string;
  episodeIndex?: number;
  episodeTitle?: string;
  totalEpisodes?: number;
  title: string;
  /** 输出格式 */
  format: 'TS' | 'MP4';
  status: DownloadStatus;
  /**
   * 是否已确认落盘：FS Access 直写为 true；内存聚合只能「发起」浏览器下载、
   * 拿不到任何回执，故为 false（issue #977）。旧记录没有这个字段，
   * 按 undefined 处理——等同已完成，不再补判。
   */
  savedToDisk?: boolean;
  finished: number;
  total: number;
  errorNum: number;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  estimatedSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  outputPath?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export const db = new Dexie('libretv') as Dexie & {
  history: EntityTable<HistoryEntry, 'id'>;
  progress: EntityTable<ProgressEntry, 'key'>;
  searchHistory: EntityTable<SearchHistoryEntry, 'text'>;
  liveProbe: EntityTable<LiveProbeEntry & { url: string }, 'url'>;
  segmentMeta: EntityTable<SegmentMetaEntry, 'key'>;
  downloads: EntityTable<DownloadTaskEntry, 'id'>;
};

db.version(1).stores({
  history: 'id, timestamp',
  progress: 'key, updatedAt',
  searchHistory: 'text, timestamp',
});

// v2 仅新增表；Dexie 会自动继承低版本的表结构
db.version(2).stores({
  liveProbe: 'url',
});

// v3：视频片段缓存元数据（Cache Storage 存字节、这里存 LRU 索引）与离线下载任务
db.version(3).stores({
  segmentMeta: 'key, episodeKey, lastAccess',
  downloads: 'id, createdAt',
});

export const MAX_HISTORY = 100;
export const MAX_SEARCH_HISTORY = 10;

export async function upsertHistory(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
  const id = `${entry.sourceKey}_${entry.vodId}`;
  const existing = await db.history.get(id);
  const merged: HistoryEntry = {
    ...existing,
    ...entry,
    id,
    playbackPosition: entry.playbackPosition > 10 ? entry.playbackPosition : existing?.playbackPosition ?? 0,
    duration: entry.duration || existing?.duration || 0,
    timestamp: Date.now(),
  };
  await db.history.put(merged);
  // 淘汰最旧记录
  const count = await db.history.count();
  if (count > MAX_HISTORY) {
    const oldest = await db.history.orderBy('timestamp').limit(count - MAX_HISTORY).toArray();
    await db.history.bulkDelete(oldest.map((o) => o.id));
  }
}

export async function updateHistoryProgress(
  sourceKey: string,
  vodId: string,
  position: number,
  duration: number
): Promise<void> {
  const id = `${sourceKey}_${vodId}`;
  const existing = await db.history.get(id);
  if (!existing) return;
  if (Math.abs(existing.playbackPosition - position) < 2 && Math.abs(existing.duration - duration) < 2) return;
  await db.history.update(id, {
    playbackPosition: position,
    duration,
    timestamp: Date.now(),
  });
}

export async function removeHistory(sourceKey: string, vodId: string): Promise<void> {
  await db.history.delete(`${sourceKey}_${vodId}`);
}

export async function clearAllHistory(): Promise<void> {
  // 一并清进度表：否则从历史重新打开时可能取到已清空的旧进度
  await Promise.all([db.history.clear(), db.progress.clear()]);
}

export function progressKeyOf(sourceKey: string, vodId: string, episodeIndex: number): string {
  return `${sourceKey}_${vodId}_${episodeIndex}`;
}

export async function saveProgress(sourceKey: string, vodId: string, episodeIndex: number, position: number, duration: number): Promise<void> {
  if (!duration || position < 1) return;
  await db.progress.put({
    key: progressKeyOf(sourceKey, vodId, episodeIndex),
    position,
    duration,
    updatedAt: Date.now(),
  });
}

export async function clearProgress(sourceKey: string, vodId: string, episodeIndex: number): Promise<void> {
  await db.progress.delete(progressKeyOf(sourceKey, vodId, episodeIndex));
}

export async function addSearchHistory(text: string): Promise<void> {
  const t = text.trim().slice(0, 50);
  if (!t) return;
  await db.searchHistory.put({ text: t, timestamp: Date.now() });
  const count = await db.searchHistory.count();
  if (count > MAX_SEARCH_HISTORY) {
    const oldest = await db.searchHistory.orderBy('timestamp').limit(count - MAX_SEARCH_HISTORY).toArray();
    await db.searchHistory.bulkDelete(oldest.map((o) => o.text));
  }
}

export async function removeSearchHistory(text: string): Promise<void> {
  await db.searchHistory.delete(text);
}

export async function clearSearchHistory(): Promise<void> {
  await db.searchHistory.clear();
}

/** 撤销「清空搜索记录」：按原时间戳回填，保持原有顺序 */
export async function restoreSearchHistory(entries: SearchHistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.searchHistory.bulkPut(entries);
}

// —— 直播测活缓存（TTL 过滤由调用方负责，本层只管存取） ——

export async function loadLiveProbeResults(): Promise<Record<string, LiveProbeEntry>> {
  const rows = await db.liveProbe.toArray();
  const out: Record<string, LiveProbeEntry> = {};
  for (const r of rows) out[r.url] = r;
  return out;
}

export async function saveLiveProbeResults(entries: Record<string, LiveProbeEntry>): Promise<void> {
  const rows = Object.entries(entries).map(([url, e]) => ({ ...e, url }));
  if (rows.length > 0) await db.liveProbe.bulkPut(rows);
}

export async function clearLiveProbeResultsDb(): Promise<void> {
  await db.liveProbe.clear();
}

/** 当前配置导出格式版本（2.1 起含进度 / 下载队列 / 测活 / 搜索历史） */
export const CONFIG_EXPORT_VERSION = '2.1.0';

function asJsonString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJsonArray<T>(raw: unknown): T[] | null {
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

// —— 配置导入导出（兼容旧版 LibreTV-Settings；2.1 起补全 IndexedDB 表） ——

export async function exportConfig(): Promise<string> {
  // 导出前 flush：把节流缓冲中的最新设置落盘，避免导出的是 800ms 前的旧快照
  flushPendingPersist();
  const [history, progress, searchHistory, liveProbe, downloads] = await Promise.all([
    db.history.toArray(),
    db.progress.toArray(),
    db.searchHistory.toArray(),
    db.liveProbe.toArray(),
    db.downloads.toArray(),
  ]);
  const settings = localStorage.getItem(PERSIST_KEY);

  // 下载队列只带走元数据；进行中任务导入后标 paused，且不保证文件仍在
  const downloadMeta = downloads.map((d) => ({
    ...d,
    status:
      d.status === 'downloading' || d.status === 'waiting' || d.status === 'paused'
        ? ('paused' as const)
        : d.status,
    savedToDisk: false,
  }));

  const data: Record<string, unknown> = {
    viewingHistory: JSON.stringify(history),
    playbackProgress: JSON.stringify(progress),
    searchHistory: JSON.stringify(searchHistory),
    liveProbe: JSON.stringify(liveProbe),
    downloads: JSON.stringify(downloadMeta),
  };
  if (settings) data[PERSIST_KEY] = settings;

  return JSON.stringify({
    name: 'LibreTV-Settings',
    time: Date.now().toString(),
    cfgVer: CONFIG_EXPORT_VERSION,
    data,
  });
}

export async function importConfig(content: string): Promise<void> {
  const config = JSON.parse(content) as {
    name?: string;
    data?: Record<string, unknown>;
  };
  if (config.name !== 'LibreTV-Settings') throw new Error('配置文件格式不正确');
  const data = config.data || {};

  const settingsRaw = asJsonString(data[PERSIST_KEY]);
  if (settingsRaw) {
    // 关键：先 flush 节流缓冲中的旧状态再写导入配置，否则缓冲会在
    // 之后 flush 时用导入前的旧状态覆盖刚写入的配置（导入静默丢失）
    flushPendingPersist();
    localStorage.setItem(PERSIST_KEY, settingsRaw);
  }

  const historyRaw = asJsonString(data['viewingHistory']);
  if (historyRaw) {
    const legacy = parseJsonArray<Record<string, unknown>>(historyRaw) ?? [];
    const looksModern = legacy.some(
      (item) => typeof item.id === 'string' && typeof item.sourceKey === 'string'
    );
    if (looksModern) {
      await db.history.clear();
      const rows: HistoryEntry[] = [];
      for (const item of legacy.slice(0, MAX_HISTORY)) {
        const sourceKey = String(item.sourceKey || '');
        const vodId = String(item.vodId || '');
        if (!sourceKey || !vodId) continue;
        rows.push({
          id: String(item.id || `${sourceKey}_${vodId}`),
          sourceKey,
          sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : undefined,
          vodId,
          title: String(item.title || '未知视频'),
          pic: typeof item.pic === 'string' ? item.pic : undefined,
          episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
          totalEpisodes: typeof item.totalEpisodes === 'number' ? item.totalEpisodes : 0,
          playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
          duration: typeof item.duration === 'number' ? item.duration : 0,
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
        });
      }
      if (rows.length > 0) await db.history.bulkPut(rows);
    } else {
      // 兼容旧版历史结构（含全集 URL 列表），只迁移定位信息
      for (const item of legacy.slice(0, MAX_HISTORY)) {
        const sourceKey = String(item.sourceCode || item.sourceName || '');
        const vodId = String(item.vod_id || '');
        const title = String(item.title || '未知视频');
        if (!sourceKey || !vodId) continue;
        const totalEpisodes = Array.isArray(item.episodes) ? item.episodes.length : 0;
        await upsertHistory({
          sourceKey,
          vodId,
          title,
          episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
          totalEpisodes,
          playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
          duration: typeof item.duration === 'number' ? item.duration : 0,
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
        });
      }
    }
  }

  const progressRows = parseJsonArray<ProgressEntry>(data['playbackProgress']);
  if (progressRows) {
    await db.progress.clear();
    const cleaned = progressRows.filter((r) => r && typeof r.key === 'string');
    if (cleaned.length > 0) await db.progress.bulkPut(cleaned);
  }

  const searchRows = parseJsonArray<SearchHistoryEntry>(data['searchHistory']);
  if (searchRows) {
    await db.searchHistory.clear();
    const cleaned = searchRows
      .filter((r) => r && typeof r.text === 'string' && r.text.trim())
      .slice(0, MAX_SEARCH_HISTORY);
    if (cleaned.length > 0) await db.searchHistory.bulkPut(cleaned);
  }

  const probeRows = parseJsonArray<(LiveProbeEntry & { url: string })>(data['liveProbe']);
  if (probeRows) {
    await db.liveProbe.clear();
    const cleaned = probeRows.filter((r) => r && typeof r.url === 'string');
    if (cleaned.length > 0) await db.liveProbe.bulkPut(cleaned);
  }

  const downloadRows = parseJsonArray<DownloadTaskEntry>(data['downloads']);
  if (downloadRows) {
    await db.downloads.clear();
    const cleaned: DownloadTaskEntry[] = downloadRows
      .filter((r) => r && typeof r.id === 'string' && typeof r.url === 'string')
      .map((r) => ({
        ...r,
        status:
          r.status === 'downloading' || r.status === 'waiting'
            ? 'paused'
            : r.status === 'paused' || r.status === 'completed' || r.status === 'error'
              ? r.status
              : 'paused',
        savedToDisk: false,
        finished: typeof r.finished === 'number' ? r.finished : 0,
        total: typeof r.total === 'number' ? r.total : 0,
        errorNum: typeof r.errorNum === 'number' ? r.errorNum : 0,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
        updatedAt: Date.now(),
        format: r.format === 'MP4' ? 'MP4' : 'TS',
      }));
    if (cleaned.length > 0) await db.downloads.bulkPut(cleaned);
  }
}

export type { SourceConfig };
