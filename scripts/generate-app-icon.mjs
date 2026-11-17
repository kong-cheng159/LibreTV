import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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

/** 深色底 + 播放三角，供 `tauri icon` 生成各尺寸图标。 */
function createPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bg = [11, 16, 26, 255];
  const fg = [125, 211, 252, 255];
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.34;
  const ax = cx - radius * 0.45;
  const ay = cy - radius * 0.72;
  const bx = cx - radius * 0.45;
  const by = cy + radius * 0.72;
  const dx = cx + radius * 0.78;
  const dy = cy;
  const v0x = dx - ax;
  const v0y = dy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot11 = v1x * v1x + v1y * v1y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01);

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const v2x = px - ax;
      const v2y = py - ay;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot12 = v1x * v2x + v1y * v2y;
      const u = (dot11 * dot02 - dot01 * dot12) * inv;
      const v = (dot00 * dot12 - dot01 * dot02) * inv;
      const color = u >= 0 && v >= 0 && u + v < 1 ? fg : bg;
      const offset = row + 1 + x * 4;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
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
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, createPng(512));
console.log(out);
