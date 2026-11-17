import { afterEach, describe, expect, it } from 'vitest';
import { desktopBootAuthorized, isDesktopMode } from './desktop-mode';

const KEYS = ['DESKTOP_MODE', 'DESKTOP_BOOT_TOKEN'] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('desktopBootAuthorized', () => {
  it('普通部署没有 DESKTOP_MODE 时拒绝，接口因此可以返回 404', () => {
    delete process.env.DESKTOP_MODE;
    process.env.DESKTOP_BOOT_TOKEN = 'secret';
    expect(isDesktopMode()).toBe(false);
    expect(desktopBootAuthorized('secret')).toBe(false);
  });

  it('桌面模式下令牌一致才通过', () => {
    process.env.DESKTOP_MODE = '1';
    process.env.DESKTOP_BOOT_TOKEN = 'secret';
    expect(desktopBootAuthorized('secret')).toBe(true);
    expect(desktopBootAuthorized('other')).toBe(false);
    expect(desktopBootAuthorized('')).toBe(false);
    expect(desktopBootAuthorized(null)).toBe(false);
  });

  it('服务端未配置令牌时拒绝', () => {
    process.env.DESKTOP_MODE = '1';
    delete process.env.DESKTOP_BOOT_TOKEN;
    expect(desktopBootAuthorized('secret')).toBe(false);
  });
});
