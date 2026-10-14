'use strict';

/* Tests para agent/memory.js — funciones puras tokenize y scoreAgainst.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const memory = require(path.join(__dirname, '..', '..', 'agent', 'memory.js'));

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

console.log('memory.js — tokenize');

test('tokeniza un texto simple', () => {
  const tokens = memory.tokenize('hola mundo');
  assertOk(Array.isArray(tokens), 'debe devolver un array');
  assertOk(tokens.includes('hola'), 'debe incluir hola');
  assertOk(tokens.includes('mundo'), 'debe incluir mundo');
});

test('tokeniza un texto con mayúsculas', () => {
  const tokens = memory.tokenize('Hola Mundo');
  assertOk(tokens.includes('hola'), 'debe incluir hola en minúsculas');
  assertOk(tokens.includes('mundo'), 'debe incluir mundo en minúsculas');
});

test('tokeniza un texto con puntuación', () => {
  const tokens = memory.tokenize('¡Hola, mundo!');
  assertOk(tokens.includes('hola'), 'debe incluir hola sin puntuación');
  assertOk(tokens.includes('mundo'), 'debe incluir mundo sin puntuación');
});

test('tokeniza un texto vacío', () => {
  const tokens = memory.tokenize('');
  assertOk(Array.isArray(tokens), 'debe devolver un array');
  assertEqual(tokens.length, 0);
});

test('tokeniza un texto null', () => {
  const tokens = memory.tokenize(null);
  assertOk(Array.isArray(tokens), 'debe devolver un array');
  assertEqual(tokens.length, 0);
});

test('tokeniza igual que siempre (la suite de scoring depende de esto)', () => {
  const t = memory.tokenize('El usuario prefiere informes en PDF');
  assertOk(t.includes('usuario') && t.includes('informes') && t.includes('pdf'));
});

console.log('memory.js — scoreAgainst');

test('scoreAgainst devuelve un objeto con score y overlap', () => {
  const result = memory.scoreAgainst('hola mundo', ['hola', 'mundo']);
  assertOk(typeof result === 'object', 'debe devolver un objeto');
  assertOk('score' in result, 'debe tener score');
  assertOk('overlap' in result, 'debe tener overlap');
});

test('scoreAgainst devuelve overlap 0 para texto vacío', () => {
  const result = memory.scoreAgainst('', ['hola', 'mundo']);
  assertEqual(result.overlap, 0);
});

test('scoreAgainst devuelve overlap 0 para tokens vacíos', () => {
  const result = memory.scoreAgainst('hola mundo', []);
  assertEqual(result.overlap, 0);
});

test('scoreAgainst da más overlap para más coincidencias', () => {
  const result1 = memory.scoreAgainst('hola mundo', ['hola']);
  const result2 = memory.scoreAgainst('hola mundo', ['hola', 'mundo']);
  assertOk(result2.overlap >= result1.overlap, 'más coincidencias = más o igual overlap');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
