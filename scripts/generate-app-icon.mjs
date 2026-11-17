import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * 生成 / 校验桌面应用主图标 `src-tauri/app-icon.png`。
 *
 * 默认：若已有设计稿 PNG（≥512），则保留不覆盖，仅打印路径。
 * 强制重画程序化底稿：node scripts/generate-app-icon.mjs --force
 * 再执行：npx tauri icon src-tauri/app-icon.png
 */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function clamp(v, a = 0, b = 1) {
  return Math.min(b, Math.max(a, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mix4(c0, c1, t) {
  return [
    mix(c0[0], c1[0], t),
    mix(c0[1], c1[1], t),
    mix(c0[2], c1[2], t),
    mix(c0[3], c1[3], t),
  ];
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax;
  const e0y = by - ay;
  const e1x = cx - bx;
  const e1y = cy - by;
  const e2x = ax - cx;
  const e2y = ay - cy;
  const v0x = px - ax;
  const v0y = py - ay;
  const v1x = px - bx;
  const v1y = py - by;
  const v2x = px - cx;
  const v2y = py - cy;
  const pq0x = v0x - e0x * clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y));
  const pq0y = v0y - e0y * clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y));
  const pq1x = v1x - e1x * clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y));
  const pq1y = v1y - e1y * clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y));
  const pq2x = v2x - e2x * clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y));
  const pq2y = v2y - e2y * clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y));
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d0 = pq0x * pq0x + pq0y * pq0y;
  const d1 = pq1x * pq1x + pq1y * pq1y;
  const d2 = pq2x * pq2x + pq2y * pq2y;
  let d = d0;
  if (d1 < d) d = d1;
  if (d2 < d) d = d2;
  const inside =
    s * (v0x * e0y - v0y * e0x) >= 0 &&
    s * (v1x * e1y - v1y * e1x) >= 0 &&
    s * (v2x * e2y - v2y * e2x) >= 0;
  return Math.sqrt(d) * (inside ? -1 : 1);
}

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r;
  const dy = Math.abs(py - cy) - hh + r;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** 影院深色底 + 青蓝播放三角 + 柔光（超采样）。 */
function createPng(size) {
  const samples = 3;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bgDeep = [6, 8, 15, 255];
  const bgMid = [12, 18, 32, 255];
  const accentTop = [56, 189, 248, 255];
  const accentBot = [6, 182, 212, 255];
  const frame = [30, 58, 78, 255];

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.3;
  const ax = cx - radius * 0.42;
  const ay = cy - radius * 0.7;
  const bx = cx - radius * 0.42;
  const by = cy + radius * 0.7;
  const dx = cx + radius * 0.82;
  const dy = cy;
  const aa = 1.25 / samples;

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const nx = (px - cx) / size;
          const ny = (py - cy) / size;
          const radial = Math.hypot(nx, ny);
          const bgT = clamp(radial * 1.55);
          let color = mix4(bgMid, bgDeep, bgT);

          const glow = Math.exp(-radial * radial * 14) * 0.55;
          color = [
            mix(color[0], 14, glow),
            mix(color[1], 90, glow),
            mix(color[2], 130, glow),
            255,
          ];

          const frameDist = Math.abs(
            sdRoundedRect(px, py, cx, cy, size * 0.34, size * 0.34, size * 0.08)
          );
          const frameAlpha = clamp(1 - frameDist / (size * 0.01));
          if (frameAlpha > 0) color = mix4(color, frame, frameAlpha * 0.45);

          const tri = sdTriangle(px, py, ax, ay, bx, by, dx, dy);
          const triCover = clamp(0.5 - tri / aa);
          if (triCover > 0) {
            const gy = clamp((py - ay) / Math.max(1, by - ay));
            color = mix4(color, mix4(accentTop, accentBot, gy), triCover);
          } else {
            const halo = Math.exp(-Math.max(0, tri) * (18 / size)) * 0.35;
            color = [
              mix(color[0], accentBot[0], halo),
              mix(color[1], accentBot[1], halo),
              mix(color[2], accentBot[2], halo),
              255,
            ];
          }

          r += color[0];
          g += color[1];
          b += color[2];
          a += color[3];
        }
      }
      const n = samples * samples;
      const offset = row + 1 + x * 4;
      raw[offset] = Math.round(r / n);
      raw[offset + 1] = Math.round(g / n);
      raw[offset + 2] = Math.round(b / n);
      raw[offset + 3] = Math.round(a / n);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/app-icon.png');
const force = process.argv.includes('--force');
fs.mkdirSync(path.dirname(out), { recursive: true });

if (!force && fs.existsSync(out) && fs.statSync(out).size > 20_000) {
  console.log(`保留现有设计稿：${out}`);
  console.log('若要重画程序化底稿，请加 --force；完成后执行：npx tauri icon src-tauri/app-icon.png');
  process.exit(0);
}

fs.writeFileSync(out, createPng(1024));
console.log(out);
