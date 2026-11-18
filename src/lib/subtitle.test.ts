import { describe, expect, it } from 'vitest';
import { subtitleFormatOf, subtitleToVtt } from './subtitle';

describe('subtitle', () => {
  it('识别支持的字幕扩展名', () => {
    expect(subtitleFormatOf('电影.SRT')).toBe('srt');
    expect(subtitleFormatOf('电影.ass')).toBe('ass');
    expect(subtitleFormatOf('电影.txt')).toBeNull();
  });

  it('把 SRT 时间轴转换成 WebVTT', () => {
    const result = subtitleToVtt('1\r\n00:00:01,250 --> 00:00:03,500\r\n你好', 'srt');
    expect(result).toContain('WEBVTT');
    expect(result).toContain('00:00:01.250 --> 00:00:03.500');
    expect(result).toContain('你好');
  });

  it('把 ASS Dialogue 转换成 WebVTT 并去掉样式标签', () => {
    const input = '[Events]\nDialogue: 0,0:00:01.20,0:00:03.40,Default,,0,0,0,,{\\b1}第一行\\N第二行';
    const result = subtitleToVtt(input, 'ass');
    expect(result).toContain('00:00:01.200 --> 00:00:03.400');
    expect(result).toContain('第一行\n第二行');
    expect(result).not.toContain('\\b1');
  });
});
