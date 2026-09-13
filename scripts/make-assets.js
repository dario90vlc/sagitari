'use strict';
// Builds SAGITARI logo assets from the source PNG using Electron nativeImage.
// Run: npx electron scripts/make-assets.js

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { encodePNG, decodePNG, rgbaFrom } = require('./png-ops');
const { DEFAULT_SIZES, icoEntry, buildIco } = require('./ico');

const SRC = process.argv[2] || path.join(__dirname, '..', 'sagitari_logo_transparente.png');
const OUT = path.join(__dirname, '..', 'renderer', 'assets');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const img = nativeImage.createFromPath(SRC);
    if (img.isEmpty()) throw new Error('No se pudo leer la imagen (o está vacía): ' + SRC);
    const { width: W, height: H } = img.getSize();

    // raw BGRA buffer for alpha analysis
    const buf = img.toBitmap();
    const A = (x, y) => buf[(y * W + x) * 4 + 3];

    // 1) row scan: find the big empty gap between the S-mark and the wordmark
    const rowMax = [];
    for (let y = 0; y < H; y += 2) {
      let m = 0;
      for (let x = 0; x < W; x += 4) { const a = A(x, y); if (a > m) m = a; }
      rowMax[y] = m;
    }
    let lastContent = -1, bestGapStart = -1, bestGapLen = 0;
    for (let y = 0; y < H; y += 2) {
      if (rowMax[y] > 12) {
        if (lastContent >= 0) {
          const gap = y - lastContent;
          if (gap > bestGapLen) { bestGapLen = gap; bestGapStart = lastContent; }
        }
        lastContent = y;
      }
    }
    const markBottom = bestGapStart >= 0 ? bestGapStart + Math.floor(bestGapLen / 2) : H;

    // 2) bounding box of the mark region
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (let y = 0; y < markBottom; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (A(x, y) > 14) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    console.log(`src=${W}x${H} gapStart=${bestGapStart} gapLen=${bestGapLen} markBox=(${minX},${minY})-(${maxX},${maxY})`);

    // 3) pad + square-ify + clamp
    const pad = Math.floor((maxX - minX) * 0.03) + 4;
    let cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
    let cw = Math.min(W - cx, (maxX - minX) + 2 * pad);
    let ch = Math.min(H - cy, (maxY - minY) + 2 * pad);
    if (cw > ch) { cy = Math.max(0, cy - Math.floor((cw - ch) / 2)); ch = Math.min(H - cy, cw); }
    else { cx = Math.max(0, cx - Math.floor((ch - cw) / 2)); cw = Math.min(W - cx, ch); }

    // 4) crop + export
    const mark = img.crop({ x: cx, y: cy, width: cw, height: ch })
      .resize({ width: 512, quality: 'best' });
    fs.writeFileSync(path.join(OUT, 'sagitari-mark.png'), mark.toPNG());

    // full logo (with wordmark) for splash/branding
    fs.copyFileSync(SRC, path.join(OUT, 'logo-full.png'));

    // 5) multi-size → single .ico. Los tamaños pequeños van como BMP/DIB porque
    //    el shell de Windows no pinta las entradas PNG por debajo de 256 px (la
    //    regla está en scripts/ico.js). Los píxeles se sacan decodificando el PNG
    //    de cada tamaño: toBitmap() devuelve alfa PREMULTIPLICADO y oscurecería
    //    los bordes translúcidos del icono.
    const entries = DEFAULT_SIZES.map(s => {
      const dec = decodePNG(mark.resize({ width: s, height: s, quality: 'best' }).toPNG());
      const rgba = dec.ch === 4 ? dec.data : rgbaFrom(dec);
      return { s, data: icoEntry(s, rgba, (size, px) => encodePNG(size, size, px)) };
    });
    const ico = buildIco(entries);
    fs.writeFileSync(path.join(OUT, 'sagitari.ico'), ico);

    console.log(`mark=${cw}x${ch} -> 512px saved`);
    console.log(`ico=${ico.length} bytes with ${DEFAULT_SIZES.length} sizes`);
    console.log('OUT=' + OUT);
    app.exit(0);
  } catch (e) {
    console.error('ERROR: ' + e.message);
    app.exit(1);
  }
});
