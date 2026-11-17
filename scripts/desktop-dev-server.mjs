import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { ensureNodeSidecar, ensureStandalonePlaceholder, paths } from './desktop-shared.mjs';

/** 避开 Windows 保留段 8032–8131，8080 落在其中，绑定会得到 EACCES。 */
const DEV_PORT = 18080;

function listenError(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(null));
    });
  });
}

const blocked = await listenError(DEV_PORT);
if (blocked) {
  console.error(`127.0.0.1:${DEV_PORT} 无法监听：${blocked.message}`);
  process.exit(1);
}

await ensureNodeSidecar();
await ensureStandalonePlaceholder();

const nextBin = path.join(paths.ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'dev', '-H', '127.0.0.1', '-p', String(DEV_PORT)], {
  stdio: 'inherit',
  cwd: paths.ROOT,
  env: {
    ...process.env,
    PORT: String(DEV_PORT),
    HOSTNAME: '127.0.0.1',
    DESKTOP_MODE: '1',
    DESKTOP_BOOT_TOKEN: 'dev-desktop',
    PASSWORD: 'dev-password',
    PROXY_SECRET: 'dev-desktop-proxy-secret',
    COOKIE_SECURE: 'false',
    LIVE_ALLOW_PRIVATE: '1',
  },
});

function shutdown(code = 0) {
  if (child.exitCode == null && !child.killed) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
child.on('exit', (code) => process.exit(code ?? 0));
