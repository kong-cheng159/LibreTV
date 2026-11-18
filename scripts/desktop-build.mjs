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

/** 候选 NSIS 产物目录（Cursor 沙箱可能把 CARGO_TARGET_DIR 指到临时目录） */
function nsisCandidateDirs() {
  return [
    process.env.CARGO_TARGET_DIR
      ? path.join(process.env.CARGO_TARGET_DIR, 'release', 'bundle', 'nsis')
      : null,
    path.join(paths.TAURI_DIR, 'target', 'release', 'bundle', 'nsis'),
  ].filter(Boolean);
}

async function resolveNsisBundleDir() {
  let best = null;
  let bestMtime = -1;
  for (const dir of nsisCandidateDirs()) {
    try {
      const names = await fs.readdir(dir);
      const exe = names.find((n) => n.toLowerCase().endsWith('-setup.exe'));
      if (!exe) continue;
      const st = await fs.stat(path.join(dir, exe));
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = dir;
      }
    } catch {
      /* 目录不存在则跳过 */
    }
  }
  if (!best) {
    throw new Error(`未找到 NSIS 产物目录，已尝试：\n${nsisCandidateDirs().join('\n')}`);
  }
  return best;
}

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

/** 把 NSIS setup.exe / .sig 拷到 release/，便于直接取安装包 */
async function copyInstallersToAppDir() {
  await fs.mkdir(APP_OUT_DIR, { recursive: true });
  const nsisDir = await resolveNsisBundleDir();
  const entries = await fs.readdir(nsisDir);

  const setups = entries.filter(
    (name) => name.toLowerCase().endsWith('.exe') || name.toLowerCase().endsWith('.sig')
  );
  if (!setups.some((name) => name.toLowerCase().endsWith('.exe'))) {
    throw new Error(`NSIS 目录里没有 .exe：${nsisDir}`);
  }

  const copied = [];
  for (const name of setups) {
    const from = path.join(nsisDir, name);
    const to = path.join(APP_OUT_DIR, name);
    await fs.copyFile(from, to);
    copied.push(to);
  }
  console.log(`NSIS 产物来源：${nsisDir}`);
  return copied;
}

const version = await syncDesktopVersion();
console.log(`开始构建 LibreTV ${version} 的 Windows 安装包`);

// tauri build 认 TAURI_SIGNING_PRIVATE_KEY（可为私钥原文或文件路径）
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.warn(
    '未设置 TAURI_SIGNING_PRIVATE_KEY（或 PATH）：安装包可构建，但不会生成 .sig，应用内更新不可用。'
  );
  console.warn('详见 src-tauri/keys/README.txt');
}

try {
  await runTauriBuild();
  const files = await copyInstallersToAppDir();
  console.log(`安装包已复制到 ${APP_OUT_DIR}：`);
  for (const f of files) console.log(`  - ${f}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
