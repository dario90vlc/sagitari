'use strict';

/* Tests para main/attachments.js — límites y clasificación de adjuntos.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const adj = require(path.join(__dirname, '..', '..', 'main', 'attachments.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('attachments.js — extOf');

test('devuelve la extensión en minúsculas', () => {
  assertEqual(adj.extOf('C:/fotos/FOTO.PNG'), '.png');
});

test('devuelve cadena vacía sin extensión', () => {
  assertEqual(adj.extOf('LEEME'), '');
});

test('maneja ruta vacía', () => {
  assertEqual(adj.extOf(''), '');
});

console.log('attachments.js — kindOf');

test('reconoce una imagen', () => {
  assertEqual(adj.kindOf('a.png'), 'image');
});

test('reconoce texto', () => {
  assertEqual(adj.kindOf('a.js'), 'text');
});

test('reconoce binario', () => {
  assertEqual(adj.kindOf('a.exe'), 'binary');
});

test('una extensión desconocida no es imagen ni texto', () => {
  const k = adj.kindOf('a.zzz');
  assertOk(k === 'binary' || k === 'unknown', 'debe ser binario o desconocido, no ' + k);
});

console.log('attachments.js — mimeOf');

test('devuelve el MIME de un png', () => {
  assertEqual(adj.mimeOf('a.png'), 'image/png');
});

test('devuelve el MIME de un jpg', () => {
  assertOk(String(adj.mimeOf('a.jpg')).startsWith('image/'), 'debe ser una imagen');
});

console.log('attachments.js — insideDir');

test('un archivo dentro del directorio es de dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws', 'a.js'), path.join('C:', 'ws')), true);
});

test('un archivo fuera del directorio no es de dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'otro', 'a.js'), path.join('C:', 'ws')), false);
});

test('el propio directorio cuenta como dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws'), path.join('C:', 'ws')), true);
});

test('una salida con .. no cuela', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws', '..', 'secreto.txt'), path.join('C:', 'ws')), false);
});

console.log('attachments.js — límites');

test('los topes son números positivos', () => {
  assertOk(adj.MAX_ATTACH_CHARS > 0, 'MAX_ATTACH_CHARS');
  assertOk(adj.MAX_FILE_BYTES > 0, 'MAX_FILE_BYTES');
  assertOk(adj.PROBE_AS_TEXT_BYTES > 0, 'PROBE_AS_TEXT_BYTES');
});

test('TEXT_EXTS, IMG_EXTS y BINARY_EXTS son Sets no vacíos', () => {
  assertOk(adj.TEXT_EXTS instanceof Set && adj.TEXT_EXTS.size > 0, 'TEXT_EXTS');
  assertOk(adj.IMG_EXTS instanceof Set && adj.IMG_EXTS.size > 0, 'IMG_EXTS');
  assertOk(adj.BINARY_EXTS instanceof Set && adj.BINARY_EXTS.size > 0, 'BINARY_EXTS');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
