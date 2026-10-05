'use strict';

/* Tests para agent/exec-util.js — funciones puras de ejecución.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const execUtil = require(path.join(__dirname, '..', '..', 'agent', 'exec-util.js'));

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

console.log('exec-util.js — tipoDeImagen');

test('detecta PNG por sus bytes mágicos', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assertEqual(execUtil.tipoDeImagen(png), 'image/png');
});

test('detecta JPEG por sus bytes mágicos', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assertEqual(execUtil.tipoDeImagen(jpg), 'image/jpeg');
});

test('detecta GIF por sus bytes mágicos', () => {
  const gif = Buffer.from('GIF89a', 'latin1');
  assertEqual(execUtil.tipoDeImagen(gif), 'image/gif');
});

test('detecta WEBP por sus bytes mágicos', () => {
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  assertEqual(execUtil.tipoDeImagen(webp), 'image/webp');
});

test('devuelve null para un buffer corto', () => {
  assertEqual(execUtil.tipoDeImagen(Buffer.from([0x89])), null);
});

test('devuelve null para null', () => {
  assertEqual(execUtil.tipoDeImagen(null), null);
});

test('devuelve null para un texto renombrado a imagen', () => {
  const txt = Buffer.from('esto no es una imagen', 'utf8');
  assertEqual(execUtil.tipoDeImagen(txt), null);
});

console.log('exec-util.js — decodeOut');

test('decodifica UTF-8 válido', () => {
  const buf = Buffer.from('hola mundo', 'utf8');
  assertEqual(execUtil.decodeOut(buf), 'hola mundo');
});

test('decodifica acentos UTF-8', () => {
  const buf = Buffer.from('canción', 'utf8');
  assertEqual(execUtil.decodeOut(buf), 'canción');
});

test('cae a CP850 con bytes que no son UTF-8', () => {
  // 0x82 en CP850 es 'é'; como byte suelto no es UTF-8 válido
  const buf = Buffer.from([0x82]);
  assertEqual(execUtil.decodeOut(buf), 'é');
});

test('acepta una cadena como entrada', () => {
  assertEqual(execUtil.decodeOut('hola'), 'hola');
});

test('maneja null', () => {
  assertEqual(execUtil.decodeOut(null), '');
});

console.log('exec-util.js — openUrlAllowed');

test('acepta http', () => {
  assertEqual(execUtil.openUrlAllowed('http://example.com'), true);
});

test('acepta https', () => {
  assertEqual(execUtil.openUrlAllowed('https://example.com'), true);
});

test('rechaza file://', () => {
  assertEqual(execUtil.openUrlAllowed('file:///C:/Windows/System32/calc.exe'), false);
});

test('rechaza protocolos peligrosos de Windows', () => {
  assertEqual(execUtil.openUrlAllowed('ms-msdt:/id PCWDiagnostic'), false);
  assertEqual(execUtil.openUrlAllowed('search-ms:query=secreto'), false);
});

test('rechaza javascript:', () => {
  assertEqual(execUtil.openUrlAllowed('javascript:alert(1)'), false);
});

test('rechaza una cadena vacía o basura', () => {
  assertEqual(execUtil.openUrlAllowed(''), false);
  assertEqual(execUtil.openUrlAllowed('no es una url'), false);
});

console.log('exec-util.js — constantes');

test('CP850 tiene 128 entradas', () => {
  assertEqual(execUtil.CP850.length, 128);
});

test('UTF8_STRICT es un decodificador estricto', () => {
  assertOk(execUtil.UTF8_STRICT, 'debe estar definido');
  let reventó = false;
  try {
    execUtil.UTF8_STRICT.decode(Buffer.from([0x82]));
  } catch {
    reventó = true;
  }
  assertOk(reventó, 'debe rechazar UTF-8 inválido');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
