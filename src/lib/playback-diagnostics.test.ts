import { describe, expect, it } from 'vitest';
import { classifyPlaybackFailure, sanitizePlaybackUrl } from './playback-diagnostics';

describe('播放诊断', () => {
  it('复制地址时脱敏常见鉴权参数，并保留普通参数', () => {
    const result = sanitizePlaybackUrl('https://media.test/v.m3u8?token=secret&quality=1080&sign=abc');
    expect(result).toContain('token=%5Bredacted%5D');
    expect(result).toContain('sign=%5Bredacted%5D');
    expect(result).toContain('quality=1080');
    expect(result).not.toContain('secret');
  });

  it('可以分类常见 HLS 错误阶段', () => {
    expect(classifyPlaybackFailure('networkError', 'manifestLoadError')).toBe('manifest');
    expect(classifyPlaybackFailure('networkError', 'fragLoadError')).toBe('segment');
    expect(classifyPlaybackFailure('mediaError', 'bufferStalledError')).toBe('timeout');
    expect(classifyPlaybackFailure('mediaError', 'bufferAppendError')).toBe('decode');
  });
});
