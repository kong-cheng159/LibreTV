/**
 * 根据 release/ 里最新的 setup.exe + .sig 生成 latest.json，供 GitHub Release 上传。
 * 用法：node scripts/make-latest-json.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const REPO = 'kong-cheng159/LibreTV';

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version).trim();
const tag = `v${version}`;

const entries = await fs.readdir(RELEASE);
const setup = entries.find(
  (n) => n.toLowerCase().endsWith('-setup.exe') && n.includes(version)
);
if (!setup) {
  throw new Error(`release/ 中找不到含版本 ${version} 的 *-setup.exe`);
}
const sigName = `${setup}.sig`;
if (!entries.includes(sigName)) {
  throw new Error(`缺少签名文件：release/${sigName}（打包时需设置 TAURI_SIGNING_PRIVATE_KEY_PATH）`);
}

const signature = (await fs.readFile(path.join(RELEASE, sigName), 'utf8')).trim();
const url = `https://github.com/${REPO}/releases/download/${tag}/${setup}`;

const latest = {
  version,
  notes: process.env.UPDATER_NOTES?.trim() || `LibreTV ${version} 更新。安装后会保留现有数据。`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url,
    },
  },
};

const out = path.join(RELEASE, 'latest.json');
await fs.writeFile(out, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
console.log(`已写入 ${out}`);
console.log(`Release tag 建议：${tag}`);
console.log('上传文件：');
console.log(`  - ${setup}`);
console.log(`  - ${sigName}`);
console.log('  - latest.json');
