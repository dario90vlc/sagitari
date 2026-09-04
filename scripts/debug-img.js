'use strict';
const { app, nativeImage } = require('electron');
const SRC = 'C:\\Users\\dario\\Desktop\\sagitari_logo_transparente.png';
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC);
  console.log('isEmpty=' + img.isEmpty());
  const { width: W, height: H } = img.getSize();
  console.log('size=' + W + 'x' + H + ' scaleFactor=' + img.getScaleFactor());
  const buf = img.toBitmap();
  console.log('bufBytes=' + buf.length + ' expected=' + (W * H * 4));
  const A = (x, y) => buf[(y * W + x) * 4 + 3];
  console.log('alpha samples:');
  console.log('  corner(2,2)=' + A(2, 2));
  console.log('  center(768,512)=' + A(768, 512));
  console.log('  mark(768,200)=' + A(768, 200));
  console.log('  wordmark(400,890)=' + A(400, 890));
  console.log('  empty(100,400)=' + A(100, 400));
  // raw PNG IHDR check
  const fs = require('fs');
  const head = fs.readFileSync(SRC).subarray(0, 33);
  console.log('pngIHDR=' + head.readUInt32BE(16) + 'x' + head.readUInt32BE(20) + ' depth=' + head[24] + ' colorType=' + head[25]);
  app.exit(0);
});
