import { spawn } from 'node:child_process';
import path from 'node:path';
import { paths } from './desktop-shared.mjs';

const tauriBin = path.join(
  paths.ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
);

const child = spawn(`"${tauriBin}" dev`, {
  stdio: 'inherit',
  cwd: paths.ROOT,
  shell: true,
});

child.on('exit', (code) => process.exit(code ?? 1));
