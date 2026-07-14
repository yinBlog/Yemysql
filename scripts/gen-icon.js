// 生成 build/icon.ico（256x256，PNG 内嵌的 ICO）—— 蓝色圆角底 + 白色数据库圆柱
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const buf = Buffer.alloc(S * S * 4); // RGBA

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // alpha 混合到已有像素
  const ba = buf[i + 3] / 255, sa = a / 255, oa = sa + ba * (1 - sa);
  if (oa === 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; return; }
  buf[i] = Math.round((r * sa + buf[i] * ba * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * ba * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * ba * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}
function lerp(a, b, t) { return a + (b - a) * t; }

const radius = 52;
function inRoundRect(x, y) {
  const minX = radius, maxX = S - radius, minY = radius, maxY = S - radius;
  let dx = 0, dy = 0;
  if (x < minX) dx = minX - x; else if (x > maxX) dx = x - maxX;
  if (y < minY) dy = minY - y; else if (y > maxY) dy = y - maxY;
  return dx * dx + dy * dy <= radius * radius;
}

// 圆柱参数
const cx = 128, rx = 66, ry = 20, topY = 84, botY = 172;
function ell(x, y, yc) { const a = (x - cx) / rx, b = (y - yc) / ry; return a * a + b * b; }
function inCylinder(x, y) {
  if (Math.abs(x - cx) <= rx && y >= topY && y <= botY) return true;
  if (ell(x, y, topY) <= 1 && y <= topY) return true;       // 顶盖上半
  if (ell(x, y, botY) <= 1 && y >= botY) return true;       // 底盖下半
  return false;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundRect(x, y)) continue;
    // 背景渐变蓝
    const t = y / S;
    set(x, y, Math.round(lerp(59, 29, t)), Math.round(lerp(130, 78, t)), Math.round(lerp(246, 216, t)), 255);
    // 圆柱白色
    if (inCylinder(x, y)) set(x, y, 255, 255, 255, 255);
  }
}
// 凹槽线（前半弧，浅蓝），顶盖开口（浅蓝整圈），形成数据库观感
function drawArc(yc, frontOnly, r, g, b) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = ell(x, y, yc);
    if (v >= 0.86 && v <= 1.0) {
      if (frontOnly && y < yc) continue;
      if (inCylinder(x, y) || y <= topY) set(x, y, r, g, b, 230);
    }
  }
}
drawArc(topY, false, 147, 197, 253);   // 顶部开口圈
drawArc(topY + 30, true, 96, 165, 250); // 凹槽 1
drawArc(topY + 60, true, 96, 165, 250); // 凹槽 2

// ---- PNG 编码 ----
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
]);

// ---- ICO 封装（单个 256 PNG 项）----
const dir = Buffer.alloc(6); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;        // 0 = 256
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([dir, entry, png]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
// 同时写入 src/，随 app 打包，供运行时窗口/任务栏图标使用
fs.writeFileSync(path.join(__dirname, '..', 'src', 'icon.png'), png);
console.log('ICON_DONE size=' + ico.length + ' png=' + png.length);
