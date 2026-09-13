'use strict';

/* Codificador de iconos (.ico) de SAGITARI.

   Un .ico puede guardar cada tamaño como PNG o como BMP/DIB clásico. El shell de
   Windows NO dibuja las entradas PNG por debajo de 256 px: cuando el Explorador,
   la barra de tareas o el menú Inicio necesitan 16, 32, 48 o 64 px y solo hay una
   entrada PNG, caen al icono genérico del ejecutable. Eso es exactamente lo que
   dejaba el logo de Electron en la barra de tareas.

   Por eso aquí los tamaños grandes van como PNG (comprimen mucho y sí se pintan) y
   los pequeños como BMP/DIB, que Windows pinta siempre. Los topes están en
   PNG_MIN_SIZE y DEFAULT_SIZES: si hay que cambiarlos, se cambian aquí y los usan
   tanto scripts/png-ops.js como scripts/make-assets.js.

   Módulo puro: no depende de Electron ni ejecuta nada al importarlo. */

/** A partir de este tamaño la entrada se guarda como PNG; por debajo, como BMP. */
const PNG_MIN_SIZE = 128;

/** Tamaños que lleva el icono, de mayor a menor (el 256 primero). */
const DEFAULT_SIZES = [256, 128, 64, 48, 32, 16];

/** Fila de la máscara AND: 1 bit por píxel, rellenada a múltiplo de 4 bytes. */
function maskRowBytes(size) {
  return ((Math.ceil(size / 8) + 3) >> 2) << 2;
}

/** Longitud de la entrada DIB de un cuadrado de `size` píxeles. */
function dibLength(size) {
  return 40 + size * size * 4 + maskRowBytes(size) * size;
}

/**
 * Entrada BMP/DIB de un icono: BITMAPINFOHEADER + XOR + máscara AND.
 *
 * El XOR va en BGRA y de abajo arriba (como cualquier DIB), y su alfa es RECTA,
 * nunca premultiplicada: con alfa premultiplicado los bordes translúcidos se
 * oscurecen al pintarlos. Ojo: nativeImage.toBitmap() de Electron SÍ devuelve
 * alfa premultiplicado, así que no sirve tal cual para alimentar esto.
 *
 * La máscara AND se deja a ceros a propósito: con 32 bpp manda el canal alfa.
 *
 * @param {Buffer} rgba píxeles RGBA rectos, de arriba abajo, `size * size * 4` bytes
 */
function dibEntry(rgba, size) {
  const W = size, H = size;
  const need = W * H * 4;
  if (!Buffer.isBuffer(rgba) || rgba.length < need) {
    throw new Error('dibEntry: se esperaban ' + need + ' bytes RGBA y hay ' + (rgba ? rgba.length : 0));
  }

  const xor = Buffer.alloc(need);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;      // el DIB se escribe de abajo arriba
    const dst = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      xor[dst + x] = rgba[src + x + 2];       // B
      xor[dst + x + 1] = rgba[src + x + 1];   // G
      xor[dst + x + 2] = rgba[src + x];       // R
      xor[dst + x + 3] = rgba[src + x + 3];   // A
    }
  }
  const mask = Buffer.alloc(maskRowBytes(W) * H);

  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);                       // biSize
  hdr.writeInt32LE(W, 4);                         // biWidth
  hdr.writeInt32LE(H * 2, 8);                     // biHeight: XOR + máscara
  hdr.writeUInt16LE(1, 12);                       // biPlanes
  hdr.writeUInt16LE(32, 14);                      // biBitCount
  hdr.writeUInt32LE(0, 16);                       // biCompression: BI_RGB
  hdr.writeUInt32LE(xor.length + mask.length, 20);// biSizeImage

  return Buffer.concat([hdr, xor, mask]);
}

/**
 * Blob de una entrada del icono, en el formato que Windows espera para ese tamaño.
 *
 * @param {number} size lado en píxeles
 * @param {Buffer} rgba píxeles RGBA rectos
 * @param {(size:number, rgba:Buffer) => Buffer} encodePng codificador PNG a usar
 */
function icoEntry(size, rgba, encodePng) {
  if (size >= PNG_MIN_SIZE) {
    if (typeof encodePng !== 'function') throw new Error('icoEntry: falta el codificador PNG para ' + size + 'px');
    return encodePng(size, rgba);
  }
  return dibEntry(rgba, size);
}

/** Contenedor .ico a partir de entradas `[{ s, data }]`. */
function buildIco(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('buildIco: sin entradas');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                     // reservado
  header.writeUInt16LE(1, 2);                     // tipo: icono
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const blobs = [];
  entries.forEach(({ s, data }, i) => {
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e);          // 256 se codifica como 0
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt8(0, e + 2);                     // colores de paleta
    dir.writeUInt8(0, e + 3);                     // reservado
    dir.writeUInt16LE(1, e + 4);                  // planos
    dir.writeUInt16LE(32, e + 6);                 // bits por píxel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
    blobs.push(data);
  });

  return Buffer.concat([header, dir, ...blobs]);
}

/** Lee un .ico y describe cada entrada. Lanza si el contenedor no es coherente. */
function parseIco(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) throw new Error('ICO vacío o ilegible');
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('no es un fichero ICO');
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) throw new Error('directorio del ICO truncado');
    const size = buf[e] || 256;
    const dataSize = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (offset + dataSize > buf.length) throw new Error('la entrada de ' + size + 'px se sale del archivo');

    const head = buf.toString('hex', offset, offset + 4);
    const format = head === '89504e47' ? 'png' : head === '28000000' ? 'bmp' : 'desconocido';
    const row = {
      size,
      height: buf[e + 1] || 256,
      planes: buf.readUInt16LE(e + 4),
      bpp: buf.readUInt16LE(e + 6),
      dataSize,
      offset,
      format,
      dib: null,
    };
    if (format === 'bmp') {
      row.dib = {
        biSize: buf.readUInt32LE(offset),
        biWidth: buf.readInt32LE(offset + 4),
        biHeight: buf.readInt32LE(offset + 8),
        biBitCount: buf.readUInt16LE(offset + 14),
        biCompression: buf.readUInt32LE(offset + 16),
        biSizeImage: buf.readUInt32LE(offset + 20),
      };
    }
    out.push(row);
  }
  return out;
}

module.exports = { PNG_MIN_SIZE, DEFAULT_SIZES, maskRowBytes, dibLength, dibEntry, icoEntry, buildIco, parseIco };
