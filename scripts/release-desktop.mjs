import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });
    let output = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (output += chunk));
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code ?? 1}`));
    });
  });
}

function usage() {
  console.log(`用法：
  npm run release:desktop -- patch
  npm run release:desktop -- minor
  npm run release:desktop -- major
  npm run release:desktop -- 2.24.0

该命令会：检查工作区 → 更新版本 → 运行检查 → 提交 → 打 tag → 推送。
推送 v* tag 后，GitHub Actions 自动生成签名安装包和 latest.json。`);
}

const requested = process.argv[2];
if (!requested || requested === '--help' || requested === '-h') {
  usage();
  process.exit(requested ? 0 : 1);
}
if (!/^(patch|minor|major|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(requested)) {
  throw new Error(`无效版本参数：${requested}`);
}

const branch = await run('git', ['branch', '--show-current'], { capture: true });
if (!branch) throw new Error('当前处于 detached HEAD，不能执行一键发版');

const dirty = await run('git', ['status', '--porcelain'], { capture: true });
if (dirty) {
  throw new Error('工作区存在未提交修改。请先提交或暂存处理后再发版。');
}

await run('git', ['fetch', 'origin', branch]);
const localHead = await run('git', ['rev-parse', 'HEAD'], { capture: true });
const remoteHead = await run('git', ['rev-parse', `origin/${branch}`], { capture: true });
if (localHead !== remoteHead) {
  throw new Error(`本地 ${branch} 与 origin/${branch} 不一致，请先同步后再发版`);
}

// 先验证再改版本，检查失败时不会在工作区留下半成品版本号。
await run('npm', ['run', 'typecheck']);
await run('npm', ['test']);

// 只改文件，不让 npm 自己提交或打 tag；桌面端版本随后由共享脚本统一同步。
await run('npm', ['version', requested, '--no-git-tag-version']);
await run('node', ['-e', "import('./scripts/desktop-shared.mjs').then(m => m.syncDesktopVersion())"]);

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version);
const tag = `v${version}`;

try {
  await run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { capture: true });
  throw new Error(`tag ${tag} 已存在`);
} catch (error) {
  if (error instanceof Error && error.message === `tag ${tag} 已存在`) throw error;
}

await run('git', ['add', '--', ...VERSION_FILES]);
await run('git', ['commit', '-m', `release: ${tag}`]);
await run('git', ['tag', '-a', tag, '-m', `LibreTV ${version}`]);

console.log(`\n正在推送 ${branch} 和 ${tag}，GitHub Actions 将开始桌面热更新构建……`);
await run('git', ['push', 'origin', branch, tag]);
console.log(`\n已完成：${tag}`);
console.log('可在 GitHub Actions 查看 desktop-updater 工作流；成功后客户端即可检测到更新。');
