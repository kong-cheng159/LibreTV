import { afterEach, describe, expect, it, vi } from 'vitest';

describe('validateOutboundProxyUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('接受本机 HTTP 代理', async () => {
    const { validateOutboundProxyUrl } = await import('./outbound-proxy');
    expect(validateOutboundProxyUrl('http://127.0.0.1:7890')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:7890',
    });
    expect(validateOutboundProxyUrl('http://localhost:7890/')).toEqual({
      ok: true,
      url: 'http://localhost:7890',
    });
  });

  it('拒绝 SOCKS 与公网主机', async () => {
    const { validateOutboundProxyUrl } = await import('./outbound-proxy');
    expect(validateOutboundProxyUrl('socks5://127.0.0.1:1080').ok).toBe(false);
    expect(validateOutboundProxyUrl('http://8.8.8.8:7890').ok).toBe(false);
  });

  it('非桌面模式拒绝局域网代理', async () => {
    vi.stubEnv('DESKTOP_MODE', '');
    const { validateOutboundProxyUrl } = await import('./outbound-proxy');
    expect(validateOutboundProxyUrl('http://192.168.1.1:7890').ok).toBe(false);
  });

  it('桌面模式允许局域网代理', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const { validateOutboundProxyUrl } = await import('./outbound-proxy');
    expect(validateOutboundProxyUrl('http://192.168.1.1:7890')).toEqual({
      ok: true,
      url: 'http://192.168.1.1:7890',
    });
  });

  it('关闭代理不被坏地址挡住', async () => {
    const { setOutboundProxyConfig, getOutboundProxyConfig } = await import('./outbound-proxy');
    setOutboundProxyConfig({ enabled: true, url: 'http://127.0.0.1:7890' });
    expect(getOutboundProxyConfig().enabled).toBe(true);
    expect(() => setOutboundProxyConfig({ enabled: false, url: 'not-a-url' })).not.toThrow();
    expect(getOutboundProxyConfig().enabled).toBe(false);
  });
});
