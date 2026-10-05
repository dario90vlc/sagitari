'use strict';

/* Tests para agent/hooks.js — funciones puras de hooks.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const hooks = require(path.join(__dirname, '..', '..', 'agent', 'hooks.js'));

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

console.log('hooks.js — citar');

test('cita una ruta simple', () => {
  assertEqual(hooks.citar('C:\\test.txt'), '"C:\\test.txt"');
});

test('cita una ruta con comillas', () => {
  assertEqual(hooks.citar('C:\\test "file".txt'), '"C:\\test \\"file\\".txt"');
});

test('cita una ruta vacía', () => {
  assertEqual(hooks.citar(''), '""');
});

test('maneja null/undefined', () => {
  // String(null) → "null", String(undefined) → "undefined"
  assertEqual(hooks.citar(null), '"null"');
  assertEqual(hooks.citar(undefined), '"undefined"');
});

console.log('hooks.js — expandir');

test('expande {{file}}', () => {
  const result = hooks.expandir('lint {{file}}', { ws: 'C:\\ws', archivos: ['test.js'] });
  assertOk(result.includes('test.js'), 'debe incluir el archivo');
});

test('expande {{files}}', () => {
  const result = hooks.expandir('lint {{files}}', { ws: 'C:\\ws', archivos: ['a.js', 'b.js'] });
  assertOk(result.includes('a.js'), 'debe incluir a.js');
  assertOk(result.includes('b.js'), 'debe incluir b.js');
});

test('expande {{dir}}', () => {
  const result = hooks.expandir('cd {{dir}}', { ws: 'C:\\ws' });
  assertOk(result.includes('C:\\ws'), 'debe incluir el directorio');
});

test('maneja plantilla sin marcadores', () => {
  const result = hooks.expandir('echo hola', { ws: 'C:\\ws' });
  assertEqual(result, 'echo hola');
});

test('maneja plantilla vacía', () => {
  const result = hooks.expandir('', { ws: 'C:\\ws' });
  assertEqual(result, '');
});

console.log('hooks.js — recortar');

test('recorta texto largo', () => {
  const largo = 'x'.repeat(3000);
  const corto = hooks.recortar(largo, 100);
  assertOk(corto.length < largo.length, 'debe ser más corto');
  assertOk(corto.includes('salida recortada'), 'debe tener el marcador');
});

test('no recorta texto corto', () => {
  const corto = 'hola mundo';
  assertEqual(hooks.recortar(corto, 100), corto);
});

test('maneja texto vacío', () => {
  assertEqual(hooks.recortar(''), '');
});

test('maneja texto null', () => {
  assertEqual(hooks.recortar(null), '');
});

console.log('hooks.js — tieneMarcadores');

test('detecta {{file}}', () => {
  assertEqual(hooks.tieneMarcadores('lint {{file}}'), true);
});

test('detecta {{files}}', () => {
  assertEqual(hooks.tieneMarcadores('lint {{files}}'), true);
});

test('detecta {{dir}}', () => {
  assertEqual(hooks.tieneMarcadores('cd {{dir}}'), true);
});

test('no detecta marcadores en plantilla sin marcadores', () => {
  assertEqual(hooks.tieneMarcadores('echo hola'), false);
});

test('maneja plantilla vacía', () => {
  assertEqual(hooks.tieneMarcadores(''), false);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
