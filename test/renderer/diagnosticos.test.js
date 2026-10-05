'use strict';

/* Tests para agent/diagnosticos.js — parseo y clasificación de diagnósticos.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const diag = require(path.join(__dirname, '..', '..', 'agent', 'diagnosticos.js'));

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

console.log('diagnosticos.js — aAbsoluta');

test('devuelve null para ruta vacía', () => {
  assertEqual(diag.aAbsoluta('C:\\ws', ''), null);
});

test('resuelve una ruta relativa dentro de la raíz', () => {
  const abs = diag.aAbsoluta('C:\\ws', 'src\\index.js');
  assertOk(abs, 'debe devolver una ruta');
  assertOk(abs.toLowerCase().includes('index.js'), 'debe incluir el archivo');
});

test('rechaza una ruta fuera de la raíz', () => {
  const abs = diag.aAbsoluta('C:\\ws', 'C:\\otro\\sitio\\index.js');
  assertEqual(abs, null);
});

test('quita comillas alrededor de la ruta', () => {
  const abs = diag.aAbsoluta('C:\\ws', '"src\\index.js"');
  assertOk(abs, 'debe aceptar la ruta entre comillas');
});

console.log('diagnosticos.js — parsear');

test('devuelve hallazgos y sinUbicar', () => {
  const r = diag.parsear('', { raiz: 'C:\\ws' });
  assertOk(r && typeof r === 'object', 'debe ser un objeto');
  assertOk(Array.isArray(r.hallazgos), 'hallazgos debe ser un array');
  assertOk(typeof r.sinUbicar === 'number', 'sinUbicar debe ser un número');
});

test('maneja texto null', () => {
  const r = diag.parsear(null, { raiz: 'C:\\ws' });
  assertOk(Array.isArray(r.hallazgos), 'hallazgos debe ser un array');
  assertEqual(r.hallazgos.length, 0);
});

console.log('diagnosticos.js — clasificar');

test('separa nuevos y preexistentes', () => {
  const hallazgos = [
    { archivo: 'C:\\ws\\a.js', linea: 10 },
    { archivo: 'C:\\ws\\a.js', linea: 20 },
  ];
  const r = diag.clasificar(hallazgos, { lineasDe: () => new Set([10]) });
  assertEqual(r.nuevos.length, 1);
  assertEqual(r.preexistentes.length, 1);
  assertEqual(r.nuevos[0].linea, 10);
});

test('sin lineasDe todos son nuevos', () => {
  const hallazgos = [{ archivo: 'C:\\ws\\a.js', linea: 10 }];
  const r = diag.clasificar(hallazgos, {});
  assertEqual(r.nuevos.length, 1);
  assertEqual(r.preexistentes.length, 0);
});

test('maneja lista vacía', () => {
  const r = diag.clasificar([], {});
  assertEqual(r.nuevos.length, 0);
  assertEqual(r.preexistentes.length, 0);
});

test('maneja entrada null', () => {
  const r = diag.clasificar(null, {});
  assertEqual(r.nuevos.length, 0);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
