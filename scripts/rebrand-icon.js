'use strict';
// Rebranding: mark + ico directos del icono cuadrado (sin recorte: ya va a sangre).
// Run: npx electron scripts/rebrand-icon.js <src-png>
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { encodePNG, decodePNG, rgbaFrom } = require('./png-ops');
const { DEFAULT_SIZES, icoEntry, buildIco } = require('./ico');

const SRC = process.argv[2];
const OUT = path.join(__dirname, '..', 'renderer', 'assets');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    const img = nativeImage.createFromPath(SRC);
    if (img.isEmpty()) throw new Error('vacía: ' + SRC);
    const mark = img.resize({ width: 512, height: 512, quality: 'best' });
    fs.writeFileSync(path.join(OUT, 'sagitari-mark.png'), mark.toPNG());
    const entries = DEFAULT_SIZES.map(s => {
      const dec = decodePNG(mark.resize({ width: s, height: s, quality: 'best' }).toPNG());
      const rgba = dec.ch === 4 ? dec.data : rgbaFrom(dec);
      return { s, data: icoEntry(s, rgba, (size, px) => encodePNG(size, size, px)) };
    });
    const ico = buildIco(entries);
    fs.writeFileSync(path.join(OUT, 'sagitari.ico'), ico);
    console.log('mark 512 + ico ' + ico.length + ' bytes (' + DEFAULT_SIZES.join(',') + ')');
    app.exit(0);
  } catch (e) { console.error('ERROR: ' + e.message); app.exit(1); }
});
