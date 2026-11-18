'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { CONTROL_SHOW_CLASS, syncMiniProgressBar } from '@/lib/mini-progress-bar';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { seekTimeFromClientX } from '@/lib/progress-seek';
import { decodeSubtitleBytes, subtitleFormatOf, subtitleToVtt } from '@/lib/subtitle';
import {
  classifyPlaybackFailure,
  formatDiagnosticRate,
  sanitizePlaybackUrl,
  type PlaybackFailureStage,
} from '@/lib/playback-diagnostics';
import { Icon } from '@/components/icon';
import { openInSystemPlayer } from '@/lib/system-player';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

interface PlaybackDiagnostics {
  url: string;
  mode: '直连' | '代理';
  protocol: string;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  hlsLevel: string;
  bufferSeconds: number;
  downloadRate?: number;
  droppedFrames?: number;
  totalFrames?: number;
  fps?: number;
  mediaBitrate?: number;
  decodeErrors: number;
  sourceHealth?: string;
  lastFailure?: { stage: PlaybackFailureStage; type: string; details: string };
  lastRecovery?: string;
}

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /**
   * 音量放大（Web Audio 增益链）：默认 false。
   * 关闭时完全不接入音频链路；播放中改开关由 setBoost 走「直通/增益」切换。
   */
  volumeBoost: boolean;
  /**
   * 底部细进度条（默认 true）：控制栏收起后是否在画面底边常驻一条 3px 进度线。
   * 关闭后收起即完全隐藏。类名同步见 lib/mini-progress-bar.ts。
   */
  miniProgressBar?: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  onQuality?: (height: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 只展开/定位换源面板，不立即自动切换。 */
  onOpenSwitchPanel?: () => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
  sourceHealth?: string;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  volumeBoost,
  miniProgressBar = true,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onOpenSwitchPanel,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
  sourceHealth,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const localSubtitleUrlRef = useRef<string | null>(null);
  const localTrackRef = useRef<HTMLTrackElement | null>(null);
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  /** 手势进行中：画面中央大字号反馈（与顶部 showHint 分流，避免被 timeupdate 顶掉） */
  const [gestureOverlay, setGestureOverlay] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 播放中卡顿缓冲（起播占位图阶段不叠这层，避免双遮罩） */
  const [buffering, setBuffering] = useState(false);
  /** 缓冲超过约 4s：露出换源入口 */
  const [bufferingLong, setBufferingLong] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostics>({
    url,
    mode: url.startsWith('/api/proxy') ? '代理' : '直连',
    protocol: '未知',
    resolution: '未知',
    videoCodec: '未知',
    audioCodec: '未知',
    hlsLevel: '自动',
    bufferSeconds: 0,
    decodeErrors: 0,
  });
  const lastFailureRef = useRef<PlaybackDiagnostics['lastFailure']>(undefined);
  const lastRecoveryRef = useRef<string | undefined>(undefined);
  const decodeErrorsRef = useRef(0);
  const frameSampleRef = useRef<{ frames: number; at: number } | undefined>(undefined);
  const bufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 续播定位提示：可点「从头播放」 */
  const [resumeOffer, setResumeOffer] = useState<number | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
  const ASPECT_MODES = ['default', 'cover', '16:9', '4:3'] as const;
  type AspectMode = (typeof ASPECT_MODES)[number];
  const ASPECT_LABELS: Record<AspectMode, string> = {
    default: '默认',
    cover: '铺满',
    '16:9': '16:9',
    '4:3': '4:3',
  };
  const GESTURE_THRESHOLD_PX = 14;

  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepUntilEndRef = useRef(false);
  const brightnessRef = useRef(1);
  const aspectModeRef = useRef<AspectMode>('default');

  const clearLocalSubtitle = () => {
    localTrackRef.current?.remove();
    localTrackRef.current = null;
    if (localSubtitleUrlRef.current) URL.revokeObjectURL(localSubtitleUrlRef.current);
    localSubtitleUrlRef.current = null;
  };

  const loadLocalSubtitle = async (file: File) => {
    const format = subtitleFormatOf(file.name);
    if (!format) {
      showHint('仅支持 SRT / ASS / SSA / VTT 字幕');
      return;
    }
    const art = artRef.current;
    if (!art?.video) return;
    try {
      const text = decodeSubtitleBytes(await file.arrayBuffer());
      const vtt = subtitleToVtt(text, format);
      clearLocalSubtitle();
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name;
      track.srclang = 'zh';
      track.src = url;
      track.default = true;
      art.video.appendChild(track);
      localSubtitleUrlRef.current = url;
      localTrackRef.current = track;
      track.addEventListener('load', () => {
        for (const item of Array.from(art.video.textTracks as TextTrackList)) item.mode = 'disabled';
        if (track.track) track.track.mode = 'showing';
      }, { once: true });
      showHint(`已加载字幕：${file.name}`);
    } catch (error) {
      showHint(error instanceof Error ? `字幕加载失败：${error.message}` : '字幕加载失败');
    }
  };

  const chooseLocalSubtitle = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.ass,.ssa,.vtt,text/vtt';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void loadLocalSubtitle(file);
    }, { once: true });
    input.click();
  };

  const clearBuffering = () => {
    setBuffering(false);
    setBufferingLong(false);
    if (bufferingTimerRef.current) {
      clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  };

  const markBuffering = () => {
    setBuffering(true);
    if (bufferingTimerRef.current) clearTimeout(bufferingTimerRef.current);
    bufferingTimerRef.current = setTimeout(() => setBufferingLong(true), 4000);
  };

  const dismissResumeOffer = () => {
    setResumeOffer(null);
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  };

  const offerResume = (seconds: number) => {
    setResumeOffer(seconds);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setResumeOffer(null), 10_000);
  };

  const syncRateControl = (art: Artplayer, rate: number) => {
    const label = Number.isInteger(rate) ? `${rate}.0x` : `${rate}x`;
    try {
      art.controls?.update({
        name: 'playback-rate',
        html: label,
        tooltip: `播放速度 ${label}（点击切换）`,
      });
    } catch {
      /* 控件尚未就绪时忽略 */
    }
  };

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource, onOpenSwitchPanel,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode, sourceHealth,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource, onOpenSwitchPanel,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode, sourceHealth,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 某些 HLS 源在 MANIFEST_PARSED 时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  const clearSleepTimer = () => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    sleepUntilEndRef.current = false;
    try {
      artRef.current?.setting?.update?.({ name: 'sleep-timer', tooltip: '关闭' });
    } catch {
      /* 控件尚未就绪 */
    }
  };

  const armSleepTimer = (minutes: number) => {
    clearSleepTimer();
    if (minutes <= 0) return;
    sleepTimerRef.current = setTimeout(() => {
      sleepTimerRef.current = null;
      try {
        artRef.current?.pause();
      } catch {
        /* 忽略 */
      }
      showHint('定时关闭');
    }, minutes * 60_000);
    try {
      artRef.current?.setting?.update?.({ name: 'sleep-timer', tooltip: `${minutes} 分钟` });
    } catch {
      /* 忽略 */
    }
  };

  /** 画面比例：video objectFit + 容器 aspect-ratio，不依赖 ArtPlayer 内置比例（直播/点播行为不一致） */
  const applyAspectMode = (art: Artplayer, mode: AspectMode) => {
    const video = art.video as HTMLVideoElement | undefined;
    const videoWrap = art.template?.$video as HTMLElement | undefined;
    if (!video) return;
    video.style.objectFit = '';
    video.style.width = '';
    video.style.height = '';
    if (videoWrap) {
      videoWrap.style.aspectRatio = '';
      videoWrap.style.width = '';
      videoWrap.style.height = '';
      videoWrap.style.margin = '';
      const filter = brightnessRef.current !== 1 ? `brightness(${brightnessRef.current})` : '';
      videoWrap.style.filter = filter;
    }
    switch (mode) {
      case 'default':
        video.style.objectFit = 'contain';
        break;
      case 'cover':
        video.style.objectFit = 'cover';
        break;
      case '16:9':
        if (videoWrap) {
          videoWrap.style.aspectRatio = '16 / 9';
          videoWrap.style.width = '100%';
          videoWrap.style.margin = '0 auto';
        }
        video.style.objectFit = 'contain';
        video.style.width = '100%';
        video.style.height = '100%';
        break;
      case '4:3':
        if (videoWrap) {
          videoWrap.style.aspectRatio = '4 / 3';
          videoWrap.style.width = '100%';
          videoWrap.style.margin = '0 auto';
        }
        video.style.objectFit = 'contain';
        video.style.width = '100%';
        video.style.height = '100%';
        break;
    }
    aspectModeRef.current = mode;
  };

  const syncAspectControl = (art: Artplayer, mode: AspectMode) => {
    const label = ASPECT_LABELS[mode];
    try {
      art.controls?.update({
        name: 'aspect-ratio',
        html: label,
        tooltip: `画面比例 ${label}（点击切换）`,
      });
    } catch {
      /* 忽略 */
    }
  };

  /** 多码率 HLS：在设置抽屉挂清晰度；单码率时移除避免空菜单 */
  const updateHlsQualitySetting = (hls: Hls) => {
    const art = artRef.current;
    if (!art?.setting) return;
    const levels = hls.levels;
    if (levels.length <= 1) {
      try {
        art.setting.remove('hls-quality');
      } catch {
        /* 尚未添加 */
      }
      return;
    }
    const buildSelector = () => {
      const cur = hls.currentLevel;
      return [
        { html: '自动', value: -1, default: cur === -1 },
        ...levels.map((level, index) => ({
          html: level.height ? `${level.height}P` : `档位 ${index + 1}`,
          value: index,
          default: cur === index,
        })),
      ];
    };
    const tooltipForLevel = (levelIndex: number) => {
      if (levelIndex === -1) return '自动';
      const level = levels[levelIndex];
      return level?.height ? `${level.height}P` : `档位 ${levelIndex + 1}`;
    };
    const option = {
      name: 'hls-quality',
      html: '清晰度',
      width: 150,
      tooltip: tooltipForLevel(hls.currentLevel),
      selector: buildSelector(),
      onSelect(this: Artplayer, item: { html: string | HTMLElement; value?: number }) {
        const level = typeof item.value === 'number' ? item.value : -1;
        const h = hlsRef.current;
        if (!h) return typeof item.html === 'string' ? item.html : '自动';
        h.currentLevel = level;
        h.nextLevel = level;
        const label = tooltipForLevel(level);
        showHint(`清晰度 ${label}`);
        try {
          this.setting.update({
            name: 'hls-quality',
            tooltip: label,
            selector: buildSelector(),
          });
        } catch {
          /* 忽略 */
        }
        return label;
      },
    };
    try {
      art.setting.update(option);
    } catch {
      art.setting.add(option);
    }
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const art = artRef.current;
    const progress = art?.template.$progress;
    if (!progress) return;
    progress.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;`;
      progress.appendChild(el);
    }
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      art.currentTime = seconds;
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    ensurePrefetch(currentMediaUrlRef.current, seconds);
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const art = artRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    setDiagnostics((current) => ({
      ...current,
      url: mediaUrl,
      mode: mediaUrl.startsWith('/api/proxy') ? '代理' : '直连',
      protocol: (() => {
        try { return new URL(mediaUrl, location.href).protocol.replace(':', '').toUpperCase(); }
        catch { return '未知'; }
      })(),
    }));
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;

      // MANIFEST_PARSED 早于 loadedmetadata 的 HLS 源很常见；没有有效时长时
      // 先不消费 restoredRef，等 loadedmetadata/durationchange 后再重试。
      const duration = artRef.current?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = artRef.current?.duration || video.duration || duration;
        let prefetchAnchor = video.currentTime;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (artRef.current) artRef.current.currentTime = saved;
          prefetchAnchor = saved;
          offerResume(saved);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        ensurePrefetch(mediaUrl, prefetchAnchor);
        video.play().catch(() => {});
      } catch {
        // IndexedDB 读取失败时不阻塞播放，后续事件仍可再次尝试恢复。
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => video.addEventListener(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => video.removeEventListener(event, onRestoreEvent));
    };

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // master playlist 的档位高度：多码率源在这里就能拿到上限
      const heights = hls.levels
        .map((level) => level.height)
        .filter((h): h is number => typeof h === 'number' && h > 0);
      if (heights.length > 0) reportQuality(Math.max(...heights));
      updateHlsQualitySetting(hls);
      // 进度恢复改由 restoreAndStart 处理：duration 未就绪时不消费标记，挂事件重试
      void restoreAndStart();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      updateHlsQualitySetting(hls);
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      if (!artRef.current?.setting || hls.audioTracks.length === 0) return;
      const selector = hls.audioTracks.map((track, index) => ({
        html: track.name || track.lang || `音轨 ${index + 1}`,
        value: index,
        default: index === hls.audioTrack,
      }));
      const option = {
        name: 'hls-audio-track',
        html: '音轨',
        width: 170,
        tooltip: selector[hls.audioTrack]?.html ?? '默认',
        selector,
        onSelect(item: { html: string | HTMLElement; value?: number }) {
          if (typeof item.value === 'number') hls.audioTrack = item.value;
          return typeof item.html === 'string' ? item.html : '默认';
        },
      };
      try { artRef.current.setting.update(option); } catch { artRef.current.setting.add(option); }
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 单码率源在 MANIFEST 阶段拿不到 height（清单尚未解析），这里补一次。
    // 注意 data.level 是档位下标，分辨率在 levelInfo 上
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const height = data.levelInfo?.height;
      if (typeof height === 'number') reportQuality(height);
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      lastFailureRef.current = {
        stage: classifyPlaybackFailure(data.type, data.details),
        type: data.type || 'unknown',
        details: data.details || 'unknown',
      };
      if (classifyPlaybackFailure(data.type, data.details) === 'decode') decodeErrorsRef.current += 1;
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            lastRecoveryRef.current = '直连失败，切换代理重试';
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          lastRecoveryRef.current = `${decision.reason}：第 ${decision.attempt} 次重试`;
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          lastRecoveryRef.current = `${decision.reason}：恢复媒体解码${decision.swapAudio ? '并切换音频编码' : ''}`;
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    clearSleepTimer();
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    // 跳过片段按集重置：上一集已处理过不意味新一集也处理过
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    dismissResumeOffer();
    clearBuffering();
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    lastFailureRef.current = undefined;
    lastRecoveryRef.current = undefined;
    decodeErrorsRef.current = 0;
    frameSampleRef.current = undefined;
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    // ArtPlayer 默认 3 秒才隐藏控制栏；桌面失去鼠标悬停后缩短为 0.8 秒。
    // 触屏没有 hover，自动隐藏会让按钮来不及点（issue #937）：改为常驻，
    // 由「点按视频 toggle」收起。CONTROL_HIDE_TIME 是 static，创建后修改立即生效。
    const touchPointer = prefersTouchPointer();
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? TOUCH_CONTROL_HIDE_MS : DESKTOP_CONTROL_HIDE_MS;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      // 对齐点播：开启画中画；截图/AirPlay/网页全屏仍关闭；倍速进设置 + 控制条轮换
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: false,
      aspectRatio: false,
      fullscreen: true,
      fullscreenWeb: false,
      // 恒传 true，不跟设置项走：库的 miniProgressBar 插件只在构造时注册、运行时不可换，
      // 而它正是「控制栏显示时摘掉 art-mini-progress-bar」的唯一维护者。设置项只负责
      // 「关掉时不保留类名」（见下方 control 监听 + 开关变化的 useEffect）。
      // 若这里按设置传 false，播放中把开关拨回「开」就没人再管这个类名，只能手动挂类，
      // 而挂上去就会常驻——同组 CSS 会连带关掉底部渐变遮罩与进度圆点（实测过）。
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: false,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      // 关掉独立倍速按钮后，在设置抽屉里显式挂一档速率（对齐「设置里改倍速」）
      settings: [
        {
          html: '播放速度',
          width: 150,
          tooltip: '1.0x',
          selector: [
            { html: '0.5x', value: 0.5 },
            { html: '0.75x', value: 0.75 },
            { html: '1.0x', value: 1, default: true },
            { html: '1.25x', value: 1.25 },
            { html: '1.5x', value: 1.5 },
            { html: '1.75x', value: 1.75 },
            { html: '2.0x', value: 2 },
          ],
          onSelect(this: Artplayer, item: { html: string | HTMLElement; value?: number }) {
            if (typeof item.value === 'number') this.playbackRate = item.value as 0.5 | 0.75 | 1.0 | 1.25 | 1.5 | 1.75 | 2.0;
            return typeof item.html === 'string' ? item.html : '1.0x';
          },
        },
        {
          name: 'sleep-timer',
          html: '定时关闭',
          width: 150,
          tooltip: '关闭',
          selector: [
            { html: '关闭', value: 0, default: true },
            { html: '15 分钟', value: 15 },
            { html: '30 分钟', value: 30 },
            { html: '60 分钟', value: 60 },
            { html: '播完本集', value: -1 },
          ],
          onSelect(item: { html: string | HTMLElement; value?: number }) {
            const v = item.value ?? 0;
            clearSleepTimer();
            if (v === -1) {
              sleepUntilEndRef.current = true;
              showHint('播完本集后关闭');
              return '播完本集';
            }
            if (v > 0) {
              armSleepTimer(v);
              showHint(`${v} 分钟后关闭`);
              return `${v} 分钟`;
            }
            return '关闭';
          },
        },
      ],
      // 上/下集放在播放键右侧：换集是看剧最高频的动作，不该让用户滚回页面下方找按钮
      // 倍速常驻右侧：设置抽屉里仍可精细选，控制条点一下轮换常用档
      controls: [
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集 (Alt+←)',
          click: () => {
            if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
          },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集 (Alt+→)',
          click: () => {
            if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
          },
        },
        {
          name: 'playback-rate',
          index: 20,
          position: 'right',
          html: '1.0x',
          tooltip: '播放速度 1.0x（点击切换）',
          style: { padding: '0 8px', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
          click: function (this: Artplayer) {
            const rates = PLAYBACK_RATES;
            const cur = this.playbackRate || 1;
            const idx = rates.findIndex((r) => Math.abs(r - cur) < 0.01);
            const next = rates[(idx + 1) % rates.length] ?? 1;
            this.playbackRate = next;
            syncRateControl(this, next);
            showHint(`${Number.isInteger(next) ? `${next}.0` : next}x`);
          },
        },
        {
          name: 'aspect-ratio',
          index: 21,
          position: 'right',
          html: '默认',
          tooltip: '画面比例 默认（点击切换）',
          style: { padding: '0 8px', fontSize: '13px' },
          click: function (this: Artplayer) {
            const idx = ASPECT_MODES.indexOf(aspectModeRef.current);
            const next = ASPECT_MODES[(idx + 1) % ASPECT_MODES.length] ?? 'default';
            applyAspectMode(this, next);
            syncAspectControl(this, next);
            showHint(`画面 ${ASPECT_LABELS[next]}`);
          },
        },
        {
          name: 'local-subtitle',
          index: 22,
          position: 'right',
          html: '字幕',
          tooltip: '加载本地字幕',
          style: { padding: '0 8px', fontSize: '13px' },
          click: chooseLocalSubtitle,
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;
    applyAspectMode(art, aspectModeRef.current);

    // 音量放大：起播后（src 已就绪）才挂 Web Audio 增益图，避免空 src / CORS 误判。
    // 默认关闭（设置项 volumeBoost）：不接入时完全不碰音频链路。
    // 纯附加：不改动 ArtPlayer 的 volume/滑块/快捷键；失败时原样播放。
    art.on('video:playing', () => {
      if (!propsRef.current.volumeBoost) return;
      if (!volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(art.video);
      }
    });

    // 底部细进度条：库插件先按 control 事件挂/摘类，我们紧随其后把类名收敛到
    // 「设置开启 且 控制栏已收起」这一个目标态。本监听注册在构造之后，同一次事件里
    // 跑在插件处理器后面，所以关闭态下刚挂上的类会立刻被摘掉，收起后什么都不留。
    art.on('control', (show: boolean) => {
      syncMiniProgressBar(art.template?.$player?.classList, {
        enabled: propsRef.current.miniProgressBar,
        controlsShown: show,
      });
    });

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    renderSkipMarks();
    art.on('video:durationchange', renderSkipMarks);
    // 全屏切换 / 播放器尺寸变化会重建控件，色带随之被清掉，这里补一次重绘
    art.on('fullscreen', renderSkipMarks);
    art.on('fullscreenWeb', renderSkipMarks);
    art.on('resize', renderSkipMarks);

    /**
     * 倍速跨集保持（issue #955）。
     *
     * 换源会让媒体元素重新走一遍 load 算法，而该算法只动一个播放属性：
     * `playbackRate = defaultPlaybackRate`。所以只要让 defaultPlaybackRate 始终
     * 等于用户选的倍速，这次「归位」就变成空操作——而且一次覆盖全部重载路径：
     * 换集、直连失败转代理、video:error 重建，以及 hls.js 内部
     * recoverMediaError 的 detach/attach（那条路径不经过 setupHls，只在
     * loadEpisode 里补写 playbackRate 是够不着的）。
     *
     * 判断依据：归位时新值必然等于 defaultPlaybackRate，跳过即可。必须跳过——
     * 归位确实会派发 ratechange，无差别同步会把默认值自己写成 1，机制当场失效。
     */
    art.on('video:ratechange', () => {
      const video = art.video;
      if (video && video.playbackRate !== video.defaultPlaybackRate) {
        video.defaultPlaybackRate = video.playbackRate;
      }
      if (video && Number.isFinite(video.playbackRate)) {
        syncRateControl(art, video.playbackRate);
      }
    });

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getCurrentTime: () => {
        const current = artRef.current?.currentTime;
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = artRef.current?.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          artRef.current.currentTime = seconds;
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => artRef.current?.video?.paused ?? true,
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      if (typeof height === 'number' && height > 0) reportQuality(height);
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      playbackStartedRef.current = true;
      setShowPoster(false);
      clearBuffering();
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();
    });
    art.on('video:canplay', () => {
      clearBuffering();
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      clearBuffering();
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }

      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。是否结束由合并后的 autoSkipSegments 控制
      // （片头/中段跳段，片尾结束本集，是否连播下一集仍看 autoplayNext）。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, art.duration);
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:pause', () => {
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放；起播占位阶段不叠缓冲条
      getVideoPrefetcher().setThrottled(true);
      if (playbackStartedRef.current) markBuffering();
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
      if (sleepUntilEndRef.current) {
        sleepUntilEndRef.current = false;
        showHint('定时关闭');
      }
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1(current.currentTime),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1(current.currentTime),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1(current.currentTime));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1(current.currentTime);
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    // 全屏时播放器覆盖整个视口，无法依赖 mouseleave 判断“移出播放器”。
    // 改为按鼠标活动计时：停止移动后快速收起控制栏，移动时立即显示。
    // 悬停在底栏/设置时不得收起——否则对准进度条停住点击时，条会在手下消失导致点空。
    let controlHideTimer: ReturnType<typeof setTimeout> | null = null;
    let hoveringChrome = false;
    let scrubbingProgress = false;
    const scheduleControlHide = () => {
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        if (!art.setting.show && !hoveringChrome && !scrubbingProgress) {
          art.controls.show = false;
        }
      }, DESKTOP_CONTROL_HIDE_MS);
    };
    const showControlsOnPointerMove = () => {
      art.controls.show = true;
      if (hoveringChrome || scrubbingProgress || art.setting.show) {
        if (controlHideTimer) {
          clearTimeout(controlHideTimer);
          controlHideTimer = null;
        }
        return;
      }
      scheduleControlHide();
    };
    const hideControlsOnMouseLeave = () => {
      hoveringChrome = false;
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = null;
      if (!scrubbingProgress) art.controls.show = false;
    };
    const onChromeEnter = () => {
      hoveringChrome = true;
      art.controls.show = true;
      if (controlHideTimer) {
        clearTimeout(controlHideTimer);
        controlHideTimer = null;
      }
    };
    const onChromeLeave = () => {
      hoveringChrome = false;
      scheduleControlHide();
    };
    // 触屏不监听 mousemove/mouseleave，也跳过初始显示：iOS 点按视频的合成事件
    // 序列是 mousemove → click，若 mousemove 先把 show 置 true，紧跟的 ArtPlayer
    // click toggle 会把它翻回 false——控制栏「闪一下即隐」，正是 issue #937 的病灶
    const bottomEl = art.template?.$bottom as HTMLElement | undefined;
    if (!touchPointer) {
      el?.addEventListener('mousemove', showControlsOnPointerMove);
      el?.addEventListener('mouseleave', hideControlsOnMouseLeave);
      bottomEl?.addEventListener('mouseenter', onChromeEnter);
      bottomEl?.addEventListener('mouseleave', onChromeLeave);
      showControlsOnPointerMove();
    }

    // 自管进度条定位：补上 ArtPlayer 在 isMobile 下不挂 click、以及桌面点在圆点上被忽略的缺口。
    const progressEl = art.template?.$progress as HTMLElement | undefined;
    const seekProgressToClientX = (clientX: number) => {
      if (!progressEl) return;
      const next = seekTimeFromClientX(clientX, progressEl.getBoundingClientRect(), art.duration);
      if (next === null) return;
      try {
        art.currentTime = next;
      } catch {
        /* 忽略 */
      }
    };
    const onProgressPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      scrubbingProgress = true;
      art.controls.show = true;
      if (controlHideTimer) {
        clearTimeout(controlHideTimer);
        controlHideTimer = null;
      }
      seekProgressToClientX(e.clientX);
      try {
        progressEl?.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
      // 阻止冒泡到容器手势，避免拖进度被当成画面横滑 seek
      e.stopPropagation();
    };
    const onProgressPointerMove = (e: PointerEvent) => {
      if (!scrubbingProgress) return;
      seekProgressToClientX(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    };
    const onProgressPointerUp = (e: PointerEvent) => {
      if (!scrubbingProgress) return;
      scrubbingProgress = false;
      seekProgressToClientX(e.clientX);
      if (Number.isFinite(art.currentTime)) {
        showHint(`定位 ${formatTime(art.currentTime)}`);
      }
      try {
        progressEl?.releasePointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
      if (!touchPointer && !hoveringChrome && !art.setting.show) scheduleControlHide();
    };
    progressEl?.addEventListener('pointerdown', onProgressPointerDown);
    progressEl?.addEventListener('pointermove', onProgressPointerMove, { passive: false });
    progressEl?.addEventListener('pointerup', onProgressPointerUp);
    progressEl?.addEventListener('pointercancel', onProgressPointerUp);

    let activeGesture: {
      id: number;
      startX: number;
      startY: number;
      half: 'left' | 'right';
      mode: 'seek' | 'brightness' | 'volume' | null;
      baseTime: number;
      baseVolume: number;
      baseBrightness: number;
    } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      if (activeGesture?.mode) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // —— 手势：横向滑动 seek；左半竖滑亮度、右半竖滑音量（避开控制条；与长按 3x 互斥） ——
    const isOnVideoSurface = (target: EventTarget | null) => {
      const node = target as HTMLElement | null;
      if (!node || !el) return false;
      if (!el.contains(node) && node !== el) return false;
      if (node.closest?.('.art-controls, .art-settings')) return false;
      return true;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!isOnVideoSurface(e.target)) return;
      if (art.video?.paused) return;
      if (isLongPress) return;
      activeGesture = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        half: 'left',
        mode: null,
        baseTime: art.currentTime,
        baseVolume: art.volume,
        baseBrightness: brightnessRef.current,
      };
      const rect = el?.getBoundingClientRect();
      if (rect) {
        activeGesture.half = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
      }
      try {
        el?.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!activeGesture || activeGesture.id !== e.pointerId) return;
      if (isLongPress) return;
      const dx = e.clientX - activeGesture.startX;
      const dy = e.clientY - activeGesture.startY;
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      if (!activeGesture.mode) {
        if (Math.hypot(dx, dy) < GESTURE_THRESHOLD_PX) return;
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        activeGesture.mode =
          Math.abs(dx) >= Math.abs(dy)
            ? 'seek'
            : activeGesture.half === 'left'
              ? 'brightness'
              : 'volume';
        activeGesture.baseTime = art.currentTime;
        activeGesture.baseVolume = art.volume;
        activeGesture.baseBrightness = brightnessRef.current;
      }
      e.preventDefault();
      if (activeGesture.mode === 'seek') {
        const dur = art.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const delta = (dx / rect.width) * Math.min(dur, 7200) * 0.35;
        const target = Math.max(0, Math.min(dur, activeGesture.baseTime + delta));
        try {
          art.currentTime = target;
        } catch {
          /* 忽略 */
        }
        setGestureOverlay(`${formatTime(target)} / ${formatTime(dur)}`);
      } else if (activeGesture.mode === 'brightness') {
        const b = Math.max(0.5, Math.min(1.5, activeGesture.baseBrightness - dy * 0.004));
        brightnessRef.current = b;
        const wrap = art.template?.$video as HTMLElement | undefined;
        if (wrap) wrap.style.filter = Math.abs(b - 1) < 0.01 ? '' : `brightness(${b})`;
        setGestureOverlay(`亮度 ${Math.round(b * 100)}%`);
      } else {
        const v = Math.max(0, Math.min(1, activeGesture.baseVolume - dy * 0.004));
        art.volume = v;
        setGestureOverlay(`音量 ${Math.round(v * 100)}%`);
      }
    };

    const endGesture = (e: PointerEvent) => {
      if (!activeGesture || activeGesture.id !== e.pointerId) return;
      if (activeGesture.mode === 'seek' && Number.isFinite(art.currentTime)) {
        showHint(`定位 ${formatTime(art.currentTime)}`);
      }
      activeGesture = null;
      setGestureOverlay('');
      try {
        el?.releasePointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    };

    el?.addEventListener('pointerdown', onPointerDown);
    el?.addEventListener('pointermove', onPointerMove, { passive: false });
    el?.addEventListener('pointerup', endGesture);
    el?.addEventListener('pointercancel', endGesture);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (bufferingTimerRef.current) clearTimeout(bufferingTimerRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      clearSleepTimer();
      el?.removeEventListener('pointerdown', onPointerDown);
      el?.removeEventListener('pointermove', onPointerMove);
      el?.removeEventListener('pointerup', endGesture);
      el?.removeEventListener('pointercancel', endGesture);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      art.video?.removeEventListener('resize', reportVideoHeight);
      el?.removeEventListener('mousemove', showControlsOnPointerMove);
      el?.removeEventListener('mouseleave', hideControlsOnMouseLeave);
      bottomEl?.removeEventListener('mouseenter', onChromeEnter);
      bottomEl?.removeEventListener('mouseleave', onChromeLeave);
      progressEl?.removeEventListener('pointerdown', onProgressPointerDown);
      progressEl?.removeEventListener('pointermove', onProgressPointerMove);
      progressEl?.removeEventListener('pointerup', onProgressPointerUp);
      progressEl?.removeEventListener('pointercancel', onProgressPointerUp);
      if (controlHideTimer) clearTimeout(controlHideTimer);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      clearLocalSubtitle();
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  useEffect(() => {
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  // —— 底部细进度条开关：播放中改设置即时生效，不用重开视频 ——
  // 按「当前可见状态 + 设置」收敛，而不是无条件挂类：控制栏可见时挂着类名虽然不会让
  // 控制栏跳位（库样式里 art-control-show 的规则排在后面），但同组的
  // background-image:none 与 .art-progress-indicator{display:none!important} 会无条件
  // 生效——底部渐变遮罩和进度圆点就这么没了。所以任何时候都不留常驻类名。
  useEffect(() => {
    const player = artRef.current?.template?.$player;
    if (!player) return;
    syncMiniProgressBar(player.classList, {
      enabled: miniProgressBar,
      controlsShown: player.classList.contains(CONTROL_SHOW_CLASS),
    });
  }, [miniProgressBar]);

  // —— 上/下集禁用态：走 ArtPlayer 的 controls API 更新样式，不直接改 DOM ——
  // 直接 querySelector 改 style 在控件重建（切全屏/播放器重绘）后不会恢复，且依赖内部 class 名。
  useEffect(() => {
    const controls = artRef.current?.controls;
    if (!controls) return;
    controls.update({
      name: 'prev-episode',
      style: { opacity: hasPrevEpisode ? '1' : '0.4', pointerEvents: hasPrevEpisode ? 'auto' : 'none' },
    });
    controls.update({
      name: 'next-episode',
      style: { opacity: hasNextEpisode ? '1' : '0.4', pointerEvents: hasNextEpisode ? 'auto' : 'none' },
    });
  }, [hasPrevEpisode, hasNextEpisode, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, art.duration);
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  // 播放信息只在面板打开时刷新，避免常驻轮询引起无意义重渲染。
  useEffect(() => {
    if (!diagnosticsOpen) return;
    const refresh = () => {
      const art = artRef.current;
      const video = art?.video as HTMLVideoElement | undefined;
      const hls = hlsRef.current;
      if (!video) return;
      const current = video.currentTime;
      let bufferSeconds = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= current && video.buffered.end(i) >= current) {
          bufferSeconds = Math.max(0, video.buffered.end(i) - current);
          break;
        }
      }
      const levelIndex = hls?.currentLevel ?? -1;
      const level = levelIndex >= 0 ? hls?.levels[levelIndex] : undefined;
      const quality = video.getVideoPlaybackQuality?.();
      const now = performance.now();
      let fps: number | undefined;
      if (quality) {
        const previous = frameSampleRef.current;
        if (previous && now > previous.at) {
          fps = Math.max(0, (quality.totalVideoFrames - previous.frames) * 1000 / (now - previous.at));
        }
        frameSampleRef.current = { frames: quality.totalVideoFrames, at: now };
      }
      setDiagnostics({
        url: currentMediaUrlRef.current,
        mode: currentMediaUrlRef.current.startsWith('/api/proxy') ? '代理' : '直连',
        protocol: (() => {
          try { return new URL(currentMediaUrlRef.current, location.href).protocol.replace(':', '').toUpperCase(); }
          catch { return '未知'; }
        })(),
        resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '未知',
        videoCodec: level?.videoCodec || '未知',
        audioCodec: level?.audioCodec || '未知',
        hlsLevel: levelIndex < 0 ? '自动' : level?.height ? `${level.height}P（档位 ${levelIndex + 1}）` : `档位 ${levelIndex + 1}`,
        bufferSeconds: round1(bufferSeconds),
        downloadRate: hls?.bandwidthEstimate ? hls.bandwidthEstimate / 8 : undefined,
        droppedFrames: quality?.droppedVideoFrames,
        totalFrames: quality?.totalVideoFrames,
        fps,
        mediaBitrate: level?.bitrate ? level.bitrate / 8 : undefined,
        decodeErrors: decodeErrorsRef.current,
        sourceHealth: propsRef.current.sourceHealth,
        lastFailure: lastFailureRef.current,
        lastRecovery: lastRecoveryRef.current,
      });
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [diagnosticsOpen]);

  const copyDiagnostics = async () => {
    const report = [
      `LibreTV 播放诊断`,
      `标题：${title}`,
      `地址：${sanitizePlaybackUrl(diagnostics.url)}`,
      `连接：${diagnostics.mode} / ${diagnostics.protocol}`,
      `分辨率：${diagnostics.resolution}`,
      `视频编码：${diagnostics.videoCodec}`,
      `音频编码：${diagnostics.audioCodec}`,
      `HLS 清晰度：${diagnostics.hlsLevel}`,
      `缓冲：${diagnostics.bufferSeconds.toFixed(1)} 秒`,
      `下载速度：${formatDiagnosticRate(diagnostics.downloadRate)}`,
      `丢帧：${diagnostics.droppedFrames ?? '未知'} / ${diagnostics.totalFrames ?? '未知'}`,
      `实时帧率：${diagnostics.fps === undefined ? '未知' : `${diagnostics.fps.toFixed(1)} FPS`}`,
      `媒体码率：${formatDiagnosticRate(diagnostics.mediaBitrate)}`,
      `解码错误：${diagnostics.decodeErrors}`,
      `源健康：${diagnostics.sourceHealth ?? '暂无记录'}`,
      `最近错误：${diagnostics.lastFailure ? `${diagnostics.lastFailure.stage} / ${diagnostics.lastFailure.type} / ${diagnostics.lastFailure.details}` : '无'}`,
      `最近恢复：${diagnostics.lastRecovery ?? '无'}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      showHint('诊断信息已复制');
    } catch {
      showHint('复制失败，请检查剪贴板权限');
    }
  };

  const copyPlaybackAddress = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics.url);
      showHint('播放地址已复制');
    } catch {
      showHint('复制失败，请检查剪贴板权限');
    }
  };

  const openSystemPlayer = async () => {
    try {
      const opened = await openInSystemPlayer(propsRef.current.url);
      showHint(opened ? '已交给系统默认播放器' : '系统播放器功能仅桌面客户端可用');
    } catch (cause) {
      showHint(cause instanceof Error ? cause.message : '无法调用系统播放器');
    }
  };

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      <button
        type="button"
        className="absolute right-3 top-3 z-[18] rounded-full bg-black/65 px-3 py-1.5 text-xs text-white transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setDiagnosticsOpen((open) => !open)}
        aria-expanded={diagnosticsOpen}
      >
        播放信息
      </button>
      {diagnosticsOpen && (
        <div className="absolute right-3 top-12 z-[19] w-[min(23rem,calc(100%-1.5rem))] rounded-xl border border-white/15 bg-black/90 p-3 text-xs text-white shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-sm">播放诊断</strong>
            <button type="button" className="rounded bg-white/15 px-2 py-1 hover:bg-white/25" onClick={copyDiagnostics}>复制诊断</button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5">
            <dt className="text-white/55">连接</dt><dd>{diagnostics.mode} · {diagnostics.protocol}</dd>
            <dt className="text-white/55">播放地址</dt><dd className="truncate" title={sanitizePlaybackUrl(diagnostics.url)}>{sanitizePlaybackUrl(diagnostics.url)}</dd>
            <dt className="text-white/55">分辨率</dt><dd>{diagnostics.resolution}</dd>
            <dt className="text-white/55">视频编码</dt><dd>{diagnostics.videoCodec}</dd>
            <dt className="text-white/55">音频编码</dt><dd>{diagnostics.audioCodec}</dd>
            <dt className="text-white/55">HLS 档位</dt><dd>{diagnostics.hlsLevel}</dd>
            <dt className="text-white/55">缓冲时长</dt><dd>{diagnostics.bufferSeconds.toFixed(1)} 秒</dd>
            <dt className="text-white/55">下载速度</dt><dd>{formatDiagnosticRate(diagnostics.downloadRate)}</dd>
            <dt className="text-white/55">丢帧</dt><dd>{diagnostics.droppedFrames ?? '未知'} / {diagnostics.totalFrames ?? '未知'}</dd>
            <dt className="text-white/55">实时帧率</dt><dd>{diagnostics.fps === undefined ? '未知' : `${diagnostics.fps.toFixed(1)} FPS`}</dd>
            <dt className="text-white/55">媒体码率</dt><dd>{formatDiagnosticRate(diagnostics.mediaBitrate)}</dd>
            <dt className="text-white/55">解码错误</dt><dd>{diagnostics.decodeErrors}</dd>
            <dt className="text-white/55">源健康</dt><dd>{diagnostics.sourceHealth ?? '暂无记录'}</dd>
            <dt className="text-white/55">最近错误</dt><dd>{diagnostics.lastFailure ? `${diagnostics.lastFailure.stage} · ${diagnostics.lastFailure.details}` : '无'}</dd>
            <dt className="text-white/55">最近恢复</dt><dd>{diagnostics.lastRecovery ?? '无'}</dd>
          </dl>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
            <button type="button" className="rounded bg-white/15 px-2 py-1.5 hover:bg-white/25" onClick={() => loadEpisode(currentMediaUrlRef.current || propsRef.current.url)}>重试当前线路</button>
            <button
              type="button"
              className="rounded bg-white/15 px-2 py-1.5 hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={(currentMediaUrlRef.current || propsRef.current.url).startsWith('/api/proxy')}
              onClick={() => setupHls(artRef.current.video, `/api/proxy?url=${encodeURIComponent(currentMediaUrlRef.current || propsRef.current.url)}`, false)}
            >
              经代理重试
            </button>
            <button type="button" className="rounded bg-white/15 px-2 py-1.5 hover:bg-white/25" onClick={() => propsRef.current.onRequestSwitchSource?.('手动诊断换源')}>自动换源</button>
            <button type="button" className="rounded bg-white/15 px-2 py-1.5 hover:bg-white/25" onClick={copyPlaybackAddress}>复制播放地址</button>
            <button type="button" className="col-span-2 rounded bg-white/15 px-2 py-1.5 hover:bg-white/25" onClick={() => propsRef.current.onOpenSwitchPanel?.()}>打开换源面板</button>
            <button type="button" className="col-span-2 rounded bg-white/15 px-2 py-1.5 hover:bg-white/25" onClick={openSystemPlayer}>使用系统播放器打开</button>
          </div>
        </div>
      )}
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {!error && gestureOverlay && (
        <div className="absolute inset-0 z-[11] flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl bg-black/80 px-8 py-5 text-xl font-medium text-white tabular-nums shadow-lg">
            {gestureOverlay}
          </div>
        </div>
      )}
      {!error && buffering && !showPoster && (
        <div className="absolute inset-0 z-[9] flex flex-col items-center justify-center gap-3 bg-black/45 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-sm text-white">
            <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" aria-hidden />
            <span>{bufferingLong ? '缓冲较慢…' : '正在缓冲…'}</span>
          </div>
          {bufferingLong && (
            <button
              type="button"
              className="pointer-events-auto rounded-full bg-white/15 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => propsRef.current.onRequestSwitchSource?.('缓冲超时')}
            >
              切换资源
            </button>
          )}
        </div>
      )}
      {!error && resumeOffer !== null && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-sm text-white animate-fade-in">
          <span className="pointer-events-none">已定位到 {formatTime(resumeOffer)}</span>
          <button
            type="button"
            className="shrink-0 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => {
              if (skipTo(0)) showHint('已从头播放');
              dismissResumeOffer();
            }}
          >
            从头播放
          </button>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-white/80 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={dismissResumeOffer}
            aria-label="关闭续播提示"
          >
            <Icon name="close" className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt.type === 'ending') {
              finishBySkip(skipPrompt);
              return;
            }
            const from = artRef.current?.currentTime ?? 0;
            if (skipTo(skipPrompt.end)) {
              handledSegmentsRef.current.add(segmentKey(skipPrompt));
              rememberSkip(from, skipPrompt);
              updateSkipPrompt(null);
              showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
            }
          }}
        >
          {skipPrompt.type === 'ending'
            ? '跳过片尾'
            : skipPrompt.type === 'opening'
              ? '跳过片头'
              : '跳过中段'}
        </button>
      )}
      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 px-4">
          <p className="text-danger text-sm text-center max-w-md">{error}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRequestSwitchSource && (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onRequestSwitchSource('播放失败')}
              >
                切换资源
              </button>
            )}
            <button type="button" className="btn-ghost btn-sm" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      )}
      {(hint || undoSkip) && resumeOffer === null && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white animate-fade-in">
          {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
          <span className="pointer-events-none">
            {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
          </span>
          {undoSkip && (
            <button
              type="button"
              className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={undoLastSkip}
            >
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}
