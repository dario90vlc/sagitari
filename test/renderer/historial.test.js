'use strict';

/* Tests para agent/historial.js — funciones puras de historial y transcripción.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const { MAX_HISTORY, MAX_TRANSCRIPT, trimHistory, payloadMessages, recortarTranscripcion, newConfirmId } = require(
  path.join(__dirname, '..', '..', 'agent', 'historial.js'),
);

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

console.log('historial.js — trimHistory');

test('devuelve el historial completo si está dentro del límite', () => {
  const h = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola' },
  ];
  assertEqual(trimHistory(h).length, 2);
});

test('recorta el historial al límite', () => {
  const h = Array(50).fill({ role: 'user', content: 'x' });
  assertEqual(trimHistory(h).length, MAX_HISTORY);
});

test('no parte un intercambio de herramientas', () => {
  const h = [
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'run_command' } }] },
    { role: 'tool', tool_call_id: '1', content: 'resultado' },
    { role: 'user', content: 'hola' },
  ];
  const trimmed = trimHistory(h, 2);
  assertEqual(trimmed[0].role, 'user', 'el primer mensaje debe ser user, no tool');
});

test('MAX_HISTORY es 40', () => {
  assertEqual(MAX_HISTORY, 40);
});

console.log('historial.js — payloadMessages');

test('convierte historial simple correctamente', () => {
  const h = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola' },
  ];
  const msgs = payloadMessages(h);
  assertEqual(msgs.length, 2);
  assertEqual(msgs[0].role, 'user');
  assertEqual(msgs[1].role, 'assistant');
});

test('descarta tool huérfano (sin assistant previo)', () => {
  const h = [
    { role: 'tool', tool_call_id: '1', content: 'resultado' },
    { role: 'user', content: 'hola' },
  ];
  const msgs = payloadMessages(h);
  assertEqual(msgs.length, 1, 'solo debe quedar el user');
  assertEqual(msgs[0].role, 'user');
});

test('mantiene pares assistant-tool completos', () => {
  const h = [
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'run_command' } }] },
    { role: 'tool', tool_call_id: '1', content: 'resultado' },
  ];
  const msgs = payloadMessages(h);
  assertEqual(msgs.length, 2);
  assertEqual(msgs[0].role, 'assistant');
  assertEqual(msgs[1].role, 'tool');
});

test('descarta tool_call sin respuesta', () => {
  const h = [{ role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'run_command' } }] }];
  const msgs = payloadMessages(h);
  assertEqual(msgs.length, 0, 'no debe haber mensajes');
});

console.log('historial.js — recortarTranscripcion');

test('devuelve texto corto sin cambios', () => {
  assertEqual(recortarTranscripcion('hola'), 'hola');
});

test('recorta texto largo por el medio', () => {
  const largo = 'x'.repeat(20000);
  const corto = recortarTranscripcion(largo);
  assertOk(corto.length < largo.length, 'debe ser más corto');
  assertOk(corto.includes('se omite parte'), 'debe tener el marcador');
});

test('MAX_TRANSCRIPT es 15000', () => {
  assertEqual(MAX_TRANSCRIPT, 15000);
});

console.log('historial.js — newConfirmId');

test('genera ids únicos', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(newConfirmId('c'));
  assertEqual(ids.size, 100, 'todos deben ser únicos');
});

test('el id empieza con el prefijo', () => {
  assertOk(newConfirmId('c').startsWith('c'));
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
