'use strict';

/* Tests para agent/proyecto.js — detección de perfil y comprobación de sintaxis.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const proyecto = require(path.join(__dirname, '..', '..', 'agent', 'proyecto.js'));

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

console.log('proyecto.js — extensionesCubiertas');

test('devuelve un array no vacío', () => {
  const ext = proyecto.extensionesCubiertas();
  assertOk(Array.isArray(ext), 'debe ser un array');
  assertOk(ext.length > 0, 'no debe estar vacío');
});

test('incluye .js', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.js'), 'debe incluir .js');
});

test('incluye .json', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.json'), 'debe incluir .json');
});

test('incluye .py', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.py'), 'debe incluir .py');
});

console.log('proyecto.js — comprobacionSintaxis');

test('devuelve null para extensión desconocida', () => {
  assertEqual(proyecto.comprobacionSintaxis('archivo.xyz'), null);
});

test('devuelve null para ruta vacía', () => {
  assertEqual(proyecto.comprobacionSintaxis(''), null);
});

test('devuelve comprobación para .js', () => {
  const c = proyecto.comprobacionSintaxis('index.js');
  assertOk(c, 'debe devolver una comprobación');
  assertOk(c.etiqueta, 'debe tener etiqueta');
});

test('devuelve comprobación JSON para .json', () => {
  const c = proyecto.comprobacionSintaxis('package.json');
  assertOk(c, 'debe devolver una comprobación');
  assertEqual(c.json, true);
});

test('es insensible a mayúsculas en la extensión', () => {
  const c = proyecto.comprobacionSintaxis('INDEX.JS');
  assertOk(c, 'debe reconocer la extensión en mayúsculas');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
