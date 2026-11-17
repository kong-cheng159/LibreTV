import { describe, expect, it } from 'vitest';
import { seekRatioFromClientX, seekTimeFromClientX } from './progress-seek';

describe('progress-seek', () => {
  const rect = { left: 100, width: 200 };

  it('映射到 0–1，并夹紧越界', () => {
    expect(seekRatioFromClientX(100, rect)).toBe(0);
    expect(seekRatioFromClientX(200, rect)).toBe(0.5);
    expect(seekRatioFromClientX(300, rect)).toBe(1);
    expect(seekRatioFromClientX(50, rect)).toBe(0);
    expect(seekRatioFromClientX(400, rect)).toBe(1);
  });

  it('无效几何返回 0', () => {
    expect(seekRatioFromClientX(150, { left: 0, width: 0 })).toBe(0);
  });

  it('按时长换算秒数', () => {
    expect(seekTimeFromClientX(200, rect, 120)).toBe(60);
    expect(seekTimeFromClientX(200, rect, 0)).toBeNull();
  });
});
