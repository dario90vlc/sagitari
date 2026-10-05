'use strict';

/* Tests para agent/busqueda.js — tokenización y troceado para búsqueda.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const busqueda = require(path.join(__dirname, '..', '..', 'agent', 'busqueda.js'));

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

console.log('busqueda.js — terminos');

test('devuelve un array de términos', () => {
  const t = busqueda.terminos('hola mundo');
  assertOk(Array.isArray(t), 'debe ser un array');
  assertOk(t.includes('hola'), 'debe incluir hola');
  assertOk(t.includes('mundo'), 'debe incluir mundo');
});

test('quita acentos', () => {
  const t = busqueda.terminos('función');
  assertOk(t.includes('funcion'), 'debe incluir funcion sin acento');
});

test('separa camelCase', () => {
  const t = busqueda.terminos('miFuncionLarga');
  assertOk(t.includes('mifuncionlarga'), 'debe incluir el término completo');
  assertOk(t.includes('funcion'), 'debe incluir la parte separada');
});

test('maneja texto vacío', () => {
  const t = busqueda.terminos('');
  assertOk(Array.isArray(t), 'debe ser un array');
  assertEqual(t.length, 0);
});

test('maneja null', () => {
  const t = busqueda.terminos(null);
  assertOk(Array.isArray(t), 'debe ser un array');
  assertEqual(t.length, 0);
});

console.log('busqueda.js — trocear');

test('trocea un texto largo en varios bloques', () => {
  const texto = Array.from({ length: 120 }, (_, i) => `linea ${i}`).join('\n');
  const trozos = busqueda.trocear(texto, 40);
  assertOk(Array.isArray(trozos), 'debe ser un array');
  assertOk(trozos.length > 1, 'debe haber más de un bloque');
});

test('un texto corto produce un solo bloque', () => {
  const trozos = busqueda.trocear('a\nb\nc', 40);
  assertEqual(trozos.length, 1);
});

test('descarta bloques vacíos', () => {
  const trozos = busqueda.trocear('\n\n\n\n', 40);
  assertEqual(trozos.length, 0);
});

test('cada bloque es un array de líneas', () => {
  const trozos = busqueda.trocear('a\nb\nc', 40);
  assertOk(Array.isArray(trozos[0]), 'el bloque debe ser un array');
});

console.log('busqueda.js — constantes');

test('EXTENSIONES es un Set no vacío', () => {
  assertOk(busqueda.EXTENSIONES instanceof Set, 'debe ser un Set');
  assertOk(busqueda.EXTENSIONES.size > 0, 'no debe estar vacío');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
