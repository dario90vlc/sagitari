'use strict';

/* Tests para main/traza.js — rastro compacto del turno.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const traza = require(path.join(__dirname, '..', '..', 'main', 'traza.js'));

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

console.log('traza.js — clipTraza');

test('no recorta un texto corto', () => {
  assertEqual(traza.clipTraza('hola', 100), 'hola');
});

test('recorta un texto largo y avisa de cuánto falta', () => {
  const r = traza.clipTraza('x'.repeat(50), 10);
  assertOk(r.startsWith('x'.repeat(10)), 'debe empezar por el texto recortado');
  assertOk(r.includes('recortado'), 'debe avisar del recorte');
  assertOk(r.includes('40'), 'debe decir cuántos caracteres faltan');
});

test('maneja null', () => {
  assertEqual(traza.clipTraza(null, 10), '');
});

test('maneja undefined', () => {
  assertEqual(traza.clipTraza(undefined, 10), '');
});

console.log('traza.js — argsTraza');

test('devuelve un objeto para argumentos simples', () => {
  const a = traza.argsTraza({ a: 1, b: 'dos' });
  assertOk(a && typeof a === 'object', 'debe ser un objeto');
});

test('maneja argumentos nulos', () => {
  const a = traza.argsTraza(null);
  assertOk(a === null || typeof a === 'object', 'debe tolerar null');
});

console.log('traza.js — ciclo de vida');

test('trazaNueva deja un rastro vacío listo para usar', () => {
  traza.trazaNueva();
  const t = traza.trazaActual();
  assertOk(t, 'debe haber un rastro actual');
  assertOk(Array.isArray(t.tools), 'debe tener una lista de herramientas');
  assertEqual(t.tools.length, 0, 'recién creado no debe tener herramientas');
});

test('trazaApunta y trazaCerrar son funciones', () => {
  assertOk(typeof traza.trazaApunta === 'function', 'trazaApunta');
  assertOk(typeof traza.trazaCerrar === 'function', 'trazaCerrar');
  assertOk(typeof traza.trazaActual === 'function', 'trazaActual');
});

test('apuntar una herramienta no revienta', () => {
  traza.trazaNueva();
  traza.trazaApunta({ name: 'run_command', args: { command: 'echo hola' }, ok: true, ms: 12 });
  assertOk(true, 'no debe lanzar');
});

test('MAX_TRAZA es un número positivo', () => {
  assertOk(typeof traza.MAX_TRAZA === 'number' && traza.MAX_TRAZA > 0, 'MAX_TRAZA');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
