import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const BINARIES_DIR = path.join(TAURI_DIR, 'binaries');
const STANDALONE_DIR = path.join(TAURI_DIR, 'resources', 'standalone');

/** 与 Dockerfile 的 Node 22 主版本对齐，固定补丁号以便安装包可复现。 */
export const NODE_VERSION = 'v22.23.5';
export const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

export function assertWindowsX64() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `第一期桌面安装包只支持 Windows x64，当前是 ${process.platform}/${process.arch}`
    );
  }
}

export function nodeBinaryPath() {
  return path.join(BINARIES_DIR, `node-${TARGET_TRIPLE}.exe`);
}

/** 把 package.json 的版本写入 Tauri 配置。必须在启动 `tauri build` 之前调用。 */
export async function syncDesktopVersion() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`package.json version 不是合法的 x.y.z：${version}`);
  }

  const confPath = path.join(TAURI_DIR, 'tauri.conf.json');
  const confRaw = await fs.readFile(confPath, 'utf8');
  const confNext = confRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (confNext === confRaw && !confRaw.includes(`"version": "${version}"`)) {
    throw new Error('未能在 tauri.conf.json 中找到 version 字段');
  }
  if (confNext !== confRaw) await fs.writeFile(confPath, confNext);

  const cargoPath = path.join(TAURI_DIR, 'Cargo.toml');
  const cargoRaw = await fs.readFile(cargoPath, 'utf8');
  const cargoNext = cargoRaw.replace(/(\[package\][\s\S]*?^version = ")[^"]+(")/m, `$1${version}$2`);
  if (cargoNext === cargoRaw && !cargoRaw.includes(`version = "${version}"`)) {
    throw new Error('未能在 Cargo.toml 的 [package] 中找到 version');
  }
  if (cargoNext !== cargoRaw) await fs.writeFile(cargoPath, cargoNext);
  return version;
}

/** 下载官方 Node 单文件。已有相同版本则跳过。 */
export async function ensureNodeSidecar() {
  assertWindowsX64();
  await fs.mkdir(BINARIES_DIR, { recursive: true });
  const target = nodeBinaryPath();
  const versionFile = `${target}.version`;
  let current = '';
  try {
    current = (await fs.readFile(versionFile, 'utf8')).trim();
  } catch {
    current = '';
  }
  if (current === NODE_VERSION) {
    try {
      const stat = await fs.stat(target);
      if (stat.size > 30 * 1024 * 1024) {
        console.log(`Node sidecar 已存在：${NODE_VERSION}`);
        return target;
      }
    } catch {
      // 继续下载
    }
  }

  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
  const tmp = `${target}.download`;
  console.log(`下载 Node sidecar ${NODE_VERSION}`);
  console.log(url);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`下载 Node 失败：HTTP ${res.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const stat = await fs.stat(tmp);
  if (stat.size < 30 * 1024 * 1024) {
    await fs.rm(tmp, { force: true });
    throw new Error(`下载到的 node.exe 过小（${stat.size} 字节），已中止`);
  }
  await fs.rm(target, { force: true });
  await fs.rename(tmp, target);
  await fs.writeFile(versionFile, `${NODE_VERSION}\n`);
  console.log(`已保存 ${target}`);
  return target;
}

/** 让 `tauri dev` 在还没有 standalone 产物时也能通过资源路径检查。 */
export async function ensureStandalonePlaceholder() {
  await fs.mkdir(STANDALONE_DIR, { recursive: true });
  const serverJs = path.join(STANDALONE_DIR, 'server.js');
  const readme = path.join(STANDALONE_DIR, 'README.txt');
  try {
    await fs.access(serverJs);
    return;
  } catch {
    // 尚未打过 standalone
  }
  try {
    await fs.access(readme);
  } catch {
    await fs.writeFile(
      readme,
      '占位文件。npm run desktop:prepare 会用 Next.js standalone 产物替换此目录。\n'
    );
  }
}

/**
 * standalone 目录里会带上一份 package.json。终端如果停在这个目录，
 * npm 会在这里找 Tauri 配置并失败。把桌面脚本指回仓库根目录的入口。
 */
export async function retargetDesktopScripts(standaloneDir) {
  const pkgPath = path.join(standaloneDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch {
    return;
  }
  const script = (file) => `node ${JSON.stringify(path.join(ROOT, 'scripts', file))}`;
  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    'desktop:dev': script('desktop-dev.mjs'),
    'desktop:prepare': script('prepare-sidecar.mjs'),
    'desktop:build': script('desktop-build.mjs'),
  };
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Next standalone 偶发写出空的 app-paths-manifest（{}），安装后 /api/* 全 404，
 * 桌面壳 wait_for_server 超时。用完整构建目录里的 server 清单覆盖。
 */
async function syncStandaloneServerManifests(standaloneDir) {
  const srcServer = path.join(ROOT, '.next', 'server');
  const destServer = path.join(standaloneDir, '.next', 'server');
  const names = [
    'app-paths-manifest.json',
    'pages-manifest.json',
    'functions-config-manifest.json',
    'middleware-manifest.json',
  ];
  for (const name of names) {
    const from = path.join(srcServer, name);
    const to = path.join(destServer, name);
    try {
      await fs.access(from);
      await fs.copyFile(from, to);
    } catch {
      // 个别清单可能不存在，跳过
    }
  }

  const manifestPath = path.join(destServer, 'app-paths-manifest.json');
  let raw = '{}';
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`缺少 ${manifestPath}`);
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error(`无法解析 ${manifestPath}`);
  }
  const keys = map && typeof map === 'object' ? Object.keys(map) : [];
  if (keys.length === 0) {
    throw new Error(
      'standalone 的 app-paths-manifest 为空：桌面安装后 API 会全部 404。请清理 .next 后重新 npm run desktop:prepare / desktop:build'
    );
  }
  if (!keys.some((k) => k.includes('/api/status'))) {
    throw new Error(
      `standalone 路由清单缺少 /api/status（当前 ${keys.length} 条）。请清理 .next 后重新构建`
    );
  }
  console.log(`standalone 路由清单已校验：${keys.length} 条（含 /api/status）`);
}

/** 把 Next standalone 与静态资源组装到 Tauri 资源目录。 */
export async function copyStandalone() {
  const standaloneSrc = path.join(ROOT, '.next', 'standalone');
  await retargetDesktopScripts(standaloneSrc);
  const staticSrc = path.join(ROOT, '.next', 'static');
  const publicSrc = path.join(ROOT, 'public');
  await fs.access(path.join(standaloneSrc, 'server.js'));
  await fs.access(staticSrc);
  await fs.rm(STANDALONE_DIR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(STANDALONE_DIR), { recursive: true });
  await fs.cp(standaloneSrc, STANDALONE_DIR, { recursive: true });
  await fs.cp(staticSrc, path.join(STANDALONE_DIR, '.next', 'static'), { recursive: true });
  try {
    await fs.access(publicSrc);
    await fs.cp(publicSrc, path.join(STANDALONE_DIR, 'public'), { recursive: true });
  } catch {
    // public 可空
  }
  // 先同步清单，再做存在性检查，避免空清单被打进安装包
  await syncStandaloneServerManifests(STANDALONE_DIR);
  await fs.access(path.join(STANDALONE_DIR, 'server.js'));
  await fs.access(path.join(STANDALONE_DIR, '.next', 'static'));
  console.log(`standalone 已组装到 ${STANDALONE_DIR}`);
}

export const paths = { ROOT, TAURI_DIR, STANDALONE_DIR };
