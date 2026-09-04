'use strict';
// Pure-Node PNG toolkit + SAGITARI asset pipeline. No deps, no Electron.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG decode (color types 6/2, depth 8) ----------
function decodePNG(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error('No es un PNG');
  let pos = 8, W = 0, H = 0, depth = 8, colorType = 6, idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      W = chunk.readUInt32BE(0); H = chunk.readUInt32BE(4);
      depth = chunk[8]; colorType = chunk[9];
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('Profundidad ' + depth + ' no soportada');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(W * H * ch);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return { W, H, ch, data: out };
}

// ---------- PNG encode (RGBA) ----------
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(W, H, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // depth 8, RGBA
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- box-average resize ----------
function resize(img, newW, newH) {
  const { W, H, ch, data } = img;
  const out = Buffer.alloc(newW * newH * ch);
  const sx = W / newW, sy = H / newH;
  for (let y = 0; y < newH; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < newW; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      for (let c = 0; c < ch; c++) {
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < H; yy++)
          for (let xx = x0; xx < x1 && xx < W; xx++) { sum += data[(yy * W + xx) * ch + c]; n++; }
        out[(y * newW + x) * ch + c] = Math.round(sum / n);
      }
    }
  }
  return { W: newW, H: newH, ch, data: out };
}

// ---------- ICO builder (PNG entries) ----------
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const blobs = [];
  entries.forEach(({ s, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e);
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---------- pipeline ----------
const SRC = process.argv[2] || 'C:\\Users\\dario\\Desktop\\sagitari_logo_transparente.png';
const OUT = path.join(__dirname, '..', 'renderer', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const img = decodePNG(SRC);
const { W, H, ch, data } = img;
const A = (x, y) => data[(y * W + x) * ch + (ch === 4 ? 3 : 0)];
console.log(`src=${W}x${H} ch=${ch}`);
console.log(`samples: corner=${A(2, 2)} center=${A(768, 512)} mark=${A(768, 200)} word=${A(400, 890)}`);

// 1) split mark vs wordmark: find the two density peaks and cut at the deepest
//    valley between them (this artwork is soft-glow, so rows never hit zero alpha)
const rowSum = new Float64Array(H);
let maxRowSum = 0;
for (let y = 0; y < H; y++) {
  let s = 0;
  for (let x = 0; x < W; x += 2) s += A(x, y);
  rowSum[y] = s;
  if (s > maxRowSum) maxRowSum = s;
}
// smooth over 9 rows
const smooth = new Float64Array(H);
for (let y = 0; y < H; y++) {
  let s = 0, n = 0;
  for (let k = -4; k <= 4; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += rowSum[yy]; n++; } }
  smooth[y] = s / n;
}
const y1 = (() => { let b = 0, bi = 0; for (let y = 0; y < Math.floor(H * 0.6); y++) if (smooth[y] > b) { b = smooth[y]; bi = y; } return bi; })();
const y2 = (() => { let b = 0, bi = -1; for (let y = Math.floor(H * 0.62); y < H; y++) if (smooth[y] > b) { b = smooth[y]; bi = y; } return bi; })();
let markBottom = H;
if (y2 > y1 + 40) {
  let m = Infinity, mi = y1;
  for (let y = y1; y < y2; y++) if (smooth[y] < m) { m = smooth[y]; mi = y; }
  markBottom = mi;
}
console.log(`peak1=${y1} peak2=${y2} valley=${markBottom}`);

// 2) bbox of mark — threshold relative to the strongest alpha found in the mark region
let peakA = 0;
for (let y = 0; y < markBottom; y += 2)
  for (let x = 0; x < W; x += 2) { const a = A(x, y); if (a > peakA) peakA = a; }
const bboxTH = Math.max(20, peakA * 0.18);
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < markBottom; y++)
  for (let x = 0; x < W; x++)
    if (A(x, y) > bboxTH) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
console.log(`peakA=${peakA} bboxTH=${bboxTH.toFixed(0)} markBox=(${minX},${minY})-(${maxX},${maxY})`);

// 3) pad + square + clamp
const pad = Math.floor((maxX - minX) * 0.03) + 4;
let cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
let cw = Math.min(W - cx, maxX - minX + 2 * pad), chh = Math.min(H - cy, maxY - minY + 2 * pad);
if (cw > chh) { cy = Math.max(0, cy - ((cw - chh) >> 1)); chh = Math.min(H - cy, cw); }
else { cx = Math.max(0, cx - ((chh - cw) >> 1)); cw = Math.min(W - cx, chh); }

// 4) crop
const mark = Buffer.alloc(cw * chh * ch);
for (let y = 0; y < chh; y++)
  data.copy(mark, y * cw * ch, ((cy + y) * W + cx) * ch, ((cy + y) * W + cx + cw) * ch);
const markImg = { W: cw, H: chh, ch, data: mark };
fs.writeFileSync(path.join(OUT, 'sagitari-mark.png'), encodePNG(cw, chh, ch === 3 ? rgbaFrom(mark) : mark));
console.log(`mark=${cw}x${chh} saved`);

// full logo copy
fs.copyFileSync(SRC, path.join(OUT, 'logo-full.png'));

// 5b) extract the WORDMARK (name with its original font) from the bottom region
{
  const wy0 = Math.min(H - 1, markBottom + 20);
  let wpeak = 0;
  for (let y = wy0; y < H; y += 2)
    for (let x = 0; x < W; x += 2) { const a = A(x, y); if (a > wpeak) wpeak = a; }
  const wTH = Math.max(18, wpeak * 0.16);
  let wminX = W, wminY = H, wmaxX = 0, wmaxY = 0;
  for (let y = wy0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (A(x, y) > wTH) {
        if (x < wminX) wminX = x; if (x > wmaxX) wmaxX = x;
        if (y < wminY) wminY = y; if (y > wmaxY) wmaxY = y;
      }
  const wpad = Math.floor((wmaxX - wminX) * 0.02) + 3;
  const wx = Math.max(0, wminX - wpad), wy = Math.max(0, wminY - wpad);
  const ww = Math.min(W - wx, wmaxX - wminX + 2 * wpad), wh = Math.min(H - wy, wmaxY - wminY + 2 * wpad);
  const wm = Buffer.alloc(ww * wh * ch);
  for (let y = 0; y < wh; y++)
    data.copy(wm, y * ww * ch, ((wy + y) * W + wx) * ch, ((wy + y) * W + wx + ww) * ch);
  fs.writeFileSync(path.join(OUT, 'sagitari-wordmark.png'), encodePNG(ww, wh, ch === 3 ? rgbaFrom({ W: ww, H: wh, ch, data: wm }) : wm));
  console.log(`wordmark=${ww}x${wh} box=(${wminX},${wminY})-(${wmaxX},${wmaxY}) saved`);
}

// 5) sizes + ico
const sizes = [256, 128, 64, 48, 32, 16];
const entries = sizes.map(s => ({ s, png: encodePNG(s, s, rgbaFrom(resize(markImg, s, s))) }));
fs.writeFileSync(path.join(OUT, 'sagitari.ico'), buildIco(entries));
console.log('ico written (' + entries.reduce((a, e) => a + e.png.length, 0) + ' bytes of PNGs)');
console.log('DONE -> ' + OUT);

function rgbaFrom(bmp) {
  if (bmp.ch === 4) return bmp.data;
  const o = Buffer.alloc(bmp.W * bmp.H * 4);
  for (let i = 0; i < bmp.W * bmp.H; i++) {
    o[i * 4] = bmp.data[i * 3]; o[i * 4 + 1] = bmp.data[i * 3 + 1];
    o[i * 4 + 2] = bmp.data[i * 3 + 2]; o[i * 4 + 3] = 255;
  }
  return o;
}
