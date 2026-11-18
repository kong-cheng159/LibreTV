import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'src-tauri', 'app-icon.png');
const size = 1024;
/** Windows 桌面图标：角必须透明，否则系统仍显示直角底 */
const radius = Math.round(size * 0.22);

const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white"/>` +
    `</svg>`
);

const rounded = await sharp(src)
  .resize(size, size, { fit: 'cover' })
  .ensureAlpha()
  .composite([{ input: svg, blend: 'dest-in' }])
  .png()
  .toBuffer();

await sharp(rounded).png().toFile(src);
const preview = path.join(ROOT, 'src-tauri', 'icons', '_preview-round.png');
await sharp(rounded).resize(256, 256).png().toFile(preview);
console.log('rounded icon written:', src, fs.statSync(src).size);
console.log('preview:', preview);
