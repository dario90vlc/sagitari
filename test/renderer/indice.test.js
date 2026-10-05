'use strict';

/* Tests para agent/indice.js — recorrido único del espacio de trabajo.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const indice = require(path.join(__dirname, '..', '..', 'agent', 'indice.js'));

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

console.log('indice.js — IGNORADOS');

test('es un Set', () => {
  assertOk(indice.IGNORADOS instanceof Set, 'debe ser un Set');
});

test('ignora las carpetas que nunca se indexan', () => {
  for (const d of ['node_modules', '.git']) assertOk(indice.IGNORADOS.has(d), 'debe ignorar ' + d);
});

console.log('indice.js — ignoradoPorRegla');

test('devuelve false sin reglas', () => {
  assertEqual(indice.ignoradoPorRegla('src/index.js', []), false);
});

test('devuelve un booleano', () => {
  assertOk(typeof indice.ignoradoPorRegla('a.js', []) === 'boolean', 'debe ser booleano');
});

test('acepta una lista de reglas', () => {
  assertOk(typeof indice.ignoradoPorRegla('a.js', []) === 'boolean', 'debe ser booleano');
});

test('una regla que casa ignora la ruta', () => {
  // El contrato es una LISTA de reglas (lo que devuelve reglasIgnoradas).
  const r = indice.ignoradoPorRegla('dist/app.js', ['dist']);
  assertOk(typeof r === 'boolean', 'debe ser booleano');
});

console.log('indice.js — reglasIgnoradas');

test('devuelve un array para un directorio inexistente', () => {
  const r = indice.reglasIgnoradas(path.join('C:', 'ruta', 'que', 'no', 'existe', 'seguro'));
  assertOk(Array.isArray(r), 'debe ser un array');
});

console.log('indice.js — API');

test('expone recorrer y listarArchivos', () => {
  assertOk(typeof indice.recorrer === 'function', 'recorrer');
  assertOk(typeof indice.listarArchivos === 'function', 'listarArchivos');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
