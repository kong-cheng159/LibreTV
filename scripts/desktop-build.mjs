import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, syncDesktopVersion } from './desktop-shared.mjs';

/**
 * 安装包落地目录。
 * 不能用根目录 `app/`：Next.js 会优先把它当成 App Router（盖住 src/app），
 * 打出来的 standalone 没有页面/API，安装后启动即挂。
 */
const APP_OUT_DIR = path.join(paths.ROOT, 'release');

/** Tauri NSIS 默认产物位置 */
const NSIS_BUNDLE_DIR = path.join(paths.TAURI_DIR, 'target', 'release', 'bundle', 'nsis');

function runTauriBuild() {
  const tauriBin = path.join(
    paths.ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
  );

  return new Promise((resolve, reject) => {
    const child = spawn(`"${tauriBin}" build --bundles nsis`, {
      stdio: 'inherit',
      cwd: paths.ROOT,
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tauri build 退出码 ${code ?? 1}`));
    });
  });
}

/** 把 NSIS setup.exe 拷到根目录 app/，便于直接取安装包 */
async function copyInstallersToAppDir() {
  await fs.mkdir(APP_OUT_DIR, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(NSIS_BUNDLE_DIR);
  } catch (err) {
    throw new Error(`未找到 NSIS 产物目录：${NSIS_BUNDLE_DIR}\n${err instanceof Error ? err.message : err}`);
  }

  const setups = entries.filter((name) => name.toLowerCase().endsWith('.exe'));
  if (setups.length === 0) {
    throw new Error(`NSIS 目录里没有 .exe：${NSIS_BUNDLE_DIR}`);
  }

  const copied = [];
  for (const name of setups) {
    const from = path.join(NSIS_BUNDLE_DIR, name);
    const to = path.join(APP_OUT_DIR, name);
    await fs.copyFile(from, to);
    copied.push(to);
  }
  return copied;
}

const version = await syncDesktopVersion();
console.log(`开始构建 LibreTV ${version} 的 Windows 安装包`);

try {
  await runTauriBuild();
  const files = await copyInstallersToAppDir();
  console.log(`安装包已复制到 ${APP_OUT_DIR}：`);
  for (const f of files) console.log(`  - ${f}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
