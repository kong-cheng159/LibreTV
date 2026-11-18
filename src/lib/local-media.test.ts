import { describe, expect, it } from 'vitest';
import { findMatchingSubtitle, isLocalVideoFile, localMediaFingerprint } from './local-media';

describe('本地媒体', () => {
  it('按 MIME 或扩展名识别视频', () => {
    expect(isLocalVideoFile({ name: 'a.bin', type: 'video/mp4' })).toBe(true);
    expect(isLocalVideoFile({ name: 'a.mkv', type: '' })).toBe(true);
    expect(isLocalVideoFile({ name: 'a.srt', type: '' })).toBe(false);
  });

  it('文件指纹不包含本地路径', () => {
    expect(localMediaFingerprint({ name: '电影.mp4', size: 123, lastModified: 456 })).toBe('电影.mp4\u0000123\u0000456');
  });

  it('自动关联同名及语言后缀字幕', () => {
    const subtitles = [{ name: '电影.zh-CN.srt' }, { name: '其他.srt' }];
    expect(findMatchingSubtitle({ name: '电影.mp4' }, subtitles)?.name).toBe('电影.zh-CN.srt');
  });
});
