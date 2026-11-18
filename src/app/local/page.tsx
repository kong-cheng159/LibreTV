'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { useToast } from '@/components/toast';
import { clearProgress, db, progressKeyOf, saveProgress } from '@/lib/db';
import { findMatchingSubtitle, isLocalSubtitleFile, isLocalVideoFile, localMediaFingerprint } from '@/lib/local-media';
import { decodeSubtitleBytes, subtitleFormatOf, subtitleToVtt } from '@/lib/subtitle';
import { useAppStore } from '@/lib/store';
import { cn, formatTime } from '@/lib/utils';

interface LocalEntry {
  file: File;
  fingerprint: string;
}

export default function LocalMediaPage() {
  const { toast } = useToast();
  const privacyMode = useAppStore((s) => s.privacyMode);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoUrlRef = useRef<string | undefined>(undefined);
  const subtitleUrlRef = useRef<string | undefined>(undefined);
  const saveAtRef = useRef(0);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [subtitles, setSubtitles] = useState<File[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [subtitleName, setSubtitleName] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [restorePosition, setRestorePosition] = useState(0);
  const active = entries[activeIndex];

  useEffect(() => {
    directoryInputRef.current?.setAttribute('webkitdirectory', '');
    directoryInputRef.current?.setAttribute('directory', '');
  }, []);

  const importFiles = (files: File[]) => {
    const videos = files.filter(isLocalVideoFile);
    const subtitleFiles = files.filter(isLocalSubtitleFile);
    if (videos.length === 0) {
      toast('没有找到浏览器可识别的视频文件', 'warning');
      return;
    }
    setEntries(videos.map((file) => ({ file, fingerprint: localMediaFingerprint(file) })));
    setSubtitles(subtitleFiles);
    setActiveIndex(0);
  };

  const applySubtitle = async (file: File) => {
    const format = subtitleFormatOf(file.name);
    if (!format) {
      toast('仅支持 SRT、ASS、SSA 和 VTT 字幕', 'warning');
      return;
    }
    try {
      const text = decodeSubtitleBytes(await file.arrayBuffer());
      const blobUrl = URL.createObjectURL(new Blob([subtitleToVtt(text, format)], { type: 'text/vtt' }));
      if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = blobUrl;
      setSubtitleName(file.name);
    } catch {
      toast('字幕加载失败', 'error');
    }
  };

  const clearSubtitle = () => {
    if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
    subtitleUrlRef.current = undefined;
    setSubtitleName('');
  };

  useEffect(() => {
    if (!active) {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = undefined;
      setVideoUrl('');
      clearSubtitle();
      setMediaError('');
      return;
    }
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    const nextUrl = URL.createObjectURL(active.file);
    videoUrlRef.current = nextUrl;
    setVideoUrl(nextUrl);
    if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
    subtitleUrlRef.current = undefined;
    setSubtitleName('');
    setMediaError('');
    setCurrentTime(0);
    setRestorePosition(0);

    let cancelled = false;
    void (async () => {
      const saved = await db.progress.get(progressKeyOf('local', active.fingerprint, 0));
      if (!cancelled && saved?.position && saved.position < saved.duration - 2) {
        setRestorePosition(saved.position);
      }
      const subtitle = findMatchingSubtitle(active.file, subtitles);
      if (!subtitle || cancelled) return;
      try {
        const format = subtitleFormatOf(subtitle.name);
        if (!format) return;
        const text = decodeSubtitleBytes(await subtitle.arrayBuffer());
        const blobUrl = URL.createObjectURL(new Blob([subtitleToVtt(text, format)], { type: 'text/vtt' }));
        if (cancelled) return URL.revokeObjectURL(blobUrl);
        if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
        subtitleUrlRef.current = blobUrl;
        setSubtitleName(subtitle.name);
      } catch {
        toast('同名字幕加载失败', 'warning');
      }
    })();
    return () => { cancelled = true; };
  }, [active, subtitles, toast]);

  useEffect(() => () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video && restorePosition > 0 && video.readyState >= 1) video.currentTime = restorePosition;
  }, [restorePosition, videoUrl]);

  const persistProgress = () => {
    const video = videoRef.current;
    if (!video || !active || privacyMode) return;
    void saveProgress('local', active.fingerprint, 0, video.currentTime, video.duration);
  };

  const sizeText = useMemo(() => {
    if (!active) return '';
    return active.file.size >= 1024 ** 3
      ? `${(active.file.size / 1024 ** 3).toFixed(2)} GB`
      : `${(active.file.size / 1024 ** 2).toFixed(1)} MB`;
  }, [active]);

  return (
    <AppShell fill>
      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <header className="shell shrink-0 pt-5 sm:pt-7 pb-4 w-full">
          <p className="text-[10.5px] font-semibold tracking-[0.18em] uppercase text-faint mb-1">Local Library</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="section-title">本地媒体</h1>
              <p className="mt-1.5 text-sm text-muted">视频直接从本机读取，不上传、不复制到 JavaScript 内存，也不参与远程搜索和换源</p>
            </div>
            <div className="flex gap-2">
              <label className="btn-ghost btn-sm cursor-pointer">
                选择文件
                <input className="sr-only" type="file" multiple accept="video/*,.mkv,.m4v,.mov,.srt,.ass,.ssa,.vtt" onChange={(event) => importFiles([...event.target.files ?? []])} />
              </label>
              <label className="btn-primary btn-sm cursor-pointer">
                选择文件夹
                <input ref={directoryInputRef} className="sr-only" type="file" multiple onChange={(event) => importFiles([...event.target.files ?? []])} />
              </label>
            </div>
          </div>
        </header>

        <div className="shell flex-1 min-h-0 pb-5 w-full grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4 overflow-hidden">
          <section
            className={cn('min-h-0 rounded-xl border bg-black overflow-hidden flex items-center justify-center relative', dragging ? 'border-accent ring-2 ring-accent/30' : 'border-line')}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); importFiles([...event.dataTransfer.files]); }}
          >
            {active && videoUrl ? (
              <video
                ref={videoRef}
                key={videoUrl}
                className="w-full h-full max-h-full object-contain"
                src={videoUrl}
                controls
                autoPlay
                playsInline
                onTimeUpdate={() => {
                  setCurrentTime(videoRef.current?.currentTime ?? 0);
                  if (Date.now() - saveAtRef.current < 5000) return;
                  saveAtRef.current = Date.now();
                  persistProgress();
                }}
                onLoadedMetadata={() => {
                  if (restorePosition > 0 && videoRef.current) videoRef.current.currentTime = restorePosition;
                }}
                onPause={persistProgress}
                onError={() => {
                  const error = videoRef.current?.error;
                  const detail = error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                    ? '浏览器不支持该容器或音视频编码，可转换为 MP4/H.264/AAC 后重试。'
                    : '本地视频读取或解码失败，请检查文件是否完整。';
                  setMediaError(detail);
                }}
                onEnded={() => {
                  if (!privacyMode) void clearProgress('local', active.fingerprint, 0);
                  if (activeIndex < entries.length - 1) setActiveIndex((index) => index + 1);
                }}
              >
                {subtitleUrlRef.current && <track key={subtitleUrlRef.current} kind="subtitles" src={subtitleUrlRef.current} srcLang="zh" label={subtitleName || '本地字幕'} default />}
              </video>
            ) : (
              <div className="p-8 text-center text-white/65">
                <p className="text-lg font-medium text-white">拖放视频或文件夹到这里</p>
                <p className="mt-2 text-sm">可同时选择同目录字幕，系统会自动关联同名文件</p>
              </div>
            )}
            {mediaError && (
              <div className="absolute inset-x-4 bottom-14 rounded-lg border border-danger/40 bg-black/90 p-3 text-sm text-white shadow-xl">
                <p className="font-medium text-danger">无法播放此文件</p>
                <p className="mt-1 text-white/75">{mediaError}</p>
              </div>
            )}
            {dragging && <div className="absolute inset-0 flex items-center justify-center bg-accent/20 text-white font-medium pointer-events-none">松开即可导入</div>}
          </section>

          <aside className="min-h-0 rounded-xl border border-line bg-surface-raised overflow-hidden flex flex-col">
            <div className="p-3 border-b border-line">
              <h2 className="font-medium text-content">临时播放列表</h2>
              <p className="mt-1 text-xs text-faint">{entries.length ? `${entries.length} 个视频` : '尚未选择文件'}</p>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
              {entries.map((entry, index) => (
                <div key={entry.fingerprint} className={cn('flex items-center rounded-lg transition-colors', index === activeIndex ? 'bg-accent/15 text-accent' : 'text-content hover:bg-hover')}>
                  <button type="button" className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => setActiveIndex(index)}>
                    <span className="block truncate text-sm">{entry.file.name}</span>
                    <span className="block mt-0.5 text-[11px] text-faint">{(entry.file.size / 1024 ** 2).toFixed(1)} MB</span>
                  </button>
                  <button
                    type="button"
                    className="mr-1 rounded p-2 text-faint hover:bg-danger/10 hover:text-danger"
                    aria-label={`移除 ${entry.file.name}`}
                    onClick={() => {
                      setEntries((current) => current.filter((_, itemIndex) => itemIndex !== index));
                      setActiveIndex((current) => current > index ? current - 1 : Math.min(current, Math.max(0, entries.length - 2)));
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {active && (
              <div className="border-t border-line p-3 text-xs text-muted space-y-1">
                <p className="truncate text-content" title={active.file.name}>{active.file.name}</p>
                <p>{sizeText} · 修改于 {new Date(active.file.lastModified).toLocaleString()}</p>
                <p>{subtitleName ? `字幕：${subtitleName}` : '未找到同名字幕'}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" className="btn-ghost btn-sm" disabled={activeIndex === 0} onClick={() => setActiveIndex((index) => index - 1)}>上一项</button>
                  <button type="button" className="btn-ghost btn-sm" disabled={activeIndex >= entries.length - 1} onClick={() => setActiveIndex((index) => index + 1)}>下一项</button>
                  <label className="btn-ghost btn-sm cursor-pointer">
                    选择字幕
                    <input className="sr-only" type="file" accept=".srt,.ass,.ssa,.vtt" onChange={(event) => { const file = event.target.files?.[0]; if (file) void applySubtitle(file); event.target.value = ''; }} />
                  </label>
                  {subtitleName && <button type="button" className="btn-ghost btn-sm" onClick={clearSubtitle}>清除字幕</button>}
                </div>
                {privacyMode && <p className="text-accent">隐私模式：不保存本地播放进度</p>}
                <p>当前位置：{formatTime(currentTime)}</p>
              </div>
            )}
          </aside>
        </div>
      </main>
    </AppShell>
  );
}
