'use strict';

/* Tests para agent/instrucciones.js — reglas del proyecto (AGENTS.md y compañía).
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const instrucciones = require(path.join(__dirname, '..', '..', 'agent', 'instrucciones.js'));

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

console.log('instrucciones.js — NOMBRES');

test('NOMBRES es un array no vacío', () => {
  assertOk(Array.isArray(instrucciones.NOMBRES), 'debe ser un array');
  assertOk(instrucciones.NOMBRES.length > 0, 'no debe estar vacío');
});

test('NOMBRES incluye AGENTS.md', () => {
  assertOk(instrucciones.NOMBRES.includes('AGENTS.md'), 'debe incluir AGENTS.md');
});

test('NOMBRES incluye SAGITARI.md', () => {
  assertOk(instrucciones.NOMBRES.includes('SAGITARI.md'), 'debe incluir SAGITARI.md');
});

console.log('instrucciones.js — candidatas');

test('devuelve un array', () => {
  const c = instrucciones.candidatas('C:\\ws');
  assertOk(Array.isArray(c), 'debe ser un array');
});

test('incluye las rutas del proyecto', () => {
  const c = instrucciones.candidatas('C:\\ws');
  assertOk(c.length > 0, 'debe haber candidatas');
  assertOk(
    c.some((x) => x.donde === 'proyecto'),
    'debe haber candidatas de proyecto',
  );
});

test('cada candidata lleva ruta, donde y etiqueta', () => {
  const c = instrucciones.candidatas('C:\\ws');
  for (const x of c) {
    assertOk(x.ruta, 'debe tener ruta');
    assertOk(x.donde, 'debe tener donde');
    assertOk(x.etiqueta, 'debe tener etiqueta');
  }
});

test('sin workspace solo devuelve la global si existe', () => {
  const c = instrucciones.candidatas('');
  assertOk(Array.isArray(c), 'debe ser un array');
  assertEqual(c.filter((x) => x.donde === 'proyecto').length, 0);
});

console.log('instrucciones.js — hay');

test('hay devuelve un booleano', () => {
  const r = instrucciones.hay('C:\\ruta\\que\\no\\existe\\seguro');
  assertOk(typeof r === 'boolean', 'debe ser booleano');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
