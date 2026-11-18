const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv', 'ogg']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt']);

export function localFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function isLocalVideoFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(localFileExtension(file.name));
}

export function isLocalSubtitleFile(file: Pick<File, 'name'>): boolean {
  return SUBTITLE_EXTENSIONS.has(localFileExtension(file.name));
}

export function localMediaFingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase();
}

/** 优先精确同名，其次匹配“视频名.语言.srt”一类常见字幕命名。 */
export function findMatchingSubtitle<T extends Pick<File, 'name'>>(video: Pick<File, 'name'>, subtitles: T[]): T | undefined {
  const videoStem = stem(video.name);
  return subtitles.find((file) => stem(file.name) === videoStem)
    ?? subtitles.find((file) => stem(file.name).startsWith(`${videoStem}.`));
}
