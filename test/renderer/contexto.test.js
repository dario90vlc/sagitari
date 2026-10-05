'use strict';

/* Tests para agent/contexto.js — funciones puras de contexto.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const contexto = require(path.join(__dirname, '..', '..', 'agent', 'contexto.js'));

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

console.log('contexto.js — ventanaDe');

test('devuelve ventana para claude', () => {
  assertEqual(contexto.ventanaDe({ model: 'claude-3-5-sonnet' }), 200000);
});

test('devuelve ventana para gpt-4o', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-4o' }), 128000);
});

test('devuelve ventana para gpt-5', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-5' }), 200000);
});

test('devuelve ventana default para modelo desconocido', () => {
  assertEqual(contexto.ventanaDe({ model: 'desconocido' }), 128000);
});

test('el contextWindow explícito gana', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-4o', contextWindow: 64000 }), 64000);
});

test('maneja cfg vacío', () => {
  assertEqual(contexto.ventanaDe({}), 128000);
});

console.log('contexto.js — estimarTokens');

test('estima tokens de un texto', () => {
  const tokens = contexto.estimarTokens('hola mundo');
  assertOk(tokens > 0, 'debe ser mayor que 0');
});

test('estima 0 tokens para texto vacío', () => {
  assertEqual(contexto.estimarTokens(''), 0);
});

test('estima tokens de null como mínimo', () => {
  // JSON.stringify('') === '""' → 2 caracteres → ceil(2/3.6) = 1
  assertEqual(contexto.estimarTokens(null), 1);
});

test('estima tokens de un objeto', () => {
  const tokens = contexto.estimarTokens({ foo: 'bar' });
  assertOk(tokens > 0, 'debe ser mayor que 0');
});

console.log('contexto.js — medir');

test('mide mensajes vacíos', () => {
  const m = contexto.medir([], []);
  assertEqual(m.mensajes, 0);
  assertEqual(m.herramientas, 0);
  assertEqual(m.total, 0);
});

test('mide un mensaje simple', () => {
  const m = contexto.medir([{ role: 'user', content: 'hola' }], []);
  assertOk(m.mensajes > 0, 'debe tener mensajes');
  assertOk(m.caracteres > 0, 'debe tener caracteres');
});

test('mide herramientas', () => {
  const tools = [{ function: { name: 'run_command', description: 'Ejecuta un comando' } }];
  const m = contexto.medir([], tools);
  assertOk(m.herramientas > 0, 'debe tener herramientas');
});

test('mide mensaje con tool_calls', () => {
  const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'run_command' } }] }];
  const m = contexto.medir(messages, []);
  assertOk(m.caracteres > 0, 'debe tener caracteres');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
