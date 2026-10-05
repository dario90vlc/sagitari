'use strict';

/* Tests para agent/cambios.js — diff puro de líneas.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const cambios = require(path.join(__dirname, '..', '..', 'agent', 'cambios.js'));

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

console.log('cambios.js — diffLineas');

test('texto idéntico produce solo líneas de contexto', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nb\nc');
  assertOk(Array.isArray(ops), 'debe ser un array');
  assertOk(
    ops.every((o) => o.tipo === ' '),
    'todas deben ser contexto',
  );
});

test('una línea cambiada produce un + y un -', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nX\nc');
  assertOk(
    ops.some((o) => o.tipo === '-'),
    'debe haber una eliminación',
  );
  assertOk(
    ops.some((o) => o.tipo === '+'),
    'debe haber una adición',
  );
});

test('añadir una línea produce un +', () => {
  const ops = cambios.diffLineas('a\nb', 'a\nb\nc');
  assertOk(
    ops.some((o) => o.tipo === '+'),
    'debe haber una adición',
  );
});

test('borrar una línea produce un -', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nc');
  assertOk(
    ops.some((o) => o.tipo === '-'),
    'debe haber una eliminación',
  );
});

test('texto vacío contra vacío no produce cambios', () => {
  const ops = cambios.diffLineas('', '');
  assertOk(Array.isArray(ops), 'debe ser un array');
  assertEqual(ops.filter((o) => o.tipo !== ' ').length, 0);
});

test('los tipos solo son " ", "+" o "-"', () => {
  const ops = cambios.diffLineas('a\nb\nc\nd', 'a\nX\nc\nY');
  assertOk(
    ops.every((o) => [' ', '+', '-'].includes(o.tipo)),
    'tipos válidos',
  );
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
