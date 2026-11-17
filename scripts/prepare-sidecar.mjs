import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  copyStandalone,
  ensureNodeSidecar,
  nodeBinaryPath,
  paths,
  syncDesktopVersion,
} from './desktop-shared.mjs';

const version = await syncDesktopVersion();
console.log(`桌面版本号已对齐 package.json：${version}`);

const nodeExe = await ensureNodeSidecar();
const nextBin = path.join(paths.ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
console.log(`使用 ${nodeBinaryPath()} 构建 Next standalone`);
execFileSync(nodeExe, [nextBin, 'build'], {
  stdio: 'inherit',
  cwd: paths.ROOT,
  env: {
    ...process.env,
    DESKTOP_BUILD: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

await copyStandalone();
