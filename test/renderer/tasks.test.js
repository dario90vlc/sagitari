'use strict';

/* Tests para agent/tasks.js — prompt de reanudación de una tarea.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const tasks = require(path.join(__dirname, '..', '..', 'agent', 'tasks.js'));

const { buildResumePrompt, MAX_ATTEMPTS, RETRY_BACKOFF_MS } = tasks.__test;

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

console.log('tasks.js — buildResumePrompt');

test('sin historial devuelve el objetivo tal cual', () => {
  const r = buildResumePrompt({ goal: 'arreglar el bug' });
  assertEqual(r, 'arreglar el bug');
});

test('con historial devuelve un prompt de reanudación', () => {
  const r = buildResumePrompt({
    goal: 'arreglar el bug',
    history: [{ step: 1, tool: 'read_file', ok: true, summary: 'leí el archivo' }],
  });
  assertOk(r.includes('[REANUDACIÓN]'), 'debe marcar la reanudación');
  assertOk(r.includes('arreglar el bug'), 'debe incluir el objetivo');
});

test('resume los pasos hechos con su marca', () => {
  const r = buildResumePrompt({
    goal: 'g',
    history: [
      { step: 1, tool: 'read_file', ok: true, summary: 'ok uno' },
      { step: 2, tool: 'write_file', ok: false, summary: 'falló dos' },
    ],
  });
  assertOk(r.includes('read_file'), 'debe mencionar la herramienta');
  assertOk(r.includes('FALLÓ'), 'debe marcar el fallo');
});

test('no arrastra prompts de reanudación previos', () => {
  const r = buildResumePrompt({
    goal: 'g',
    history: [
      { step: 1, tool: 'x', ok: true, summary: '[REANUDACIÓN] prompt viejo' },
      { step: 2, tool: 'y', ok: true, summary: 'paso nuevo' },
    ],
  });
  const veces = (r.match(/\[REANUDACIÓN\]/g) || []).length;
  assertEqual(veces, 1, 'solo la cabecera');
});

test('incluye el plan pendiente', () => {
  const r = buildResumePrompt({
    goal: 'g',
    history: [{ step: 1, tool: 'x', ok: true, summary: 'hecho' }],
    plan: [{ text: 'paso pendiente uno' }],
  });
  assertOk(r.includes('paso pendiente uno'), 'debe incluir el plan pendiente');
});

test('no incluye pasos ya completados del plan', () => {
  const r = buildResumePrompt({
    goal: 'g',
    history: [{ step: 1, tool: 'x', ok: true, summary: 'hecho' }],
    plan: [{ text: 'paso terminado', done: true }],
  });
  assertOk(!r.includes('paso terminado'), 'no debe incluir el paso hecho');
});

test('maneja historial vacío como primer arranque', () => {
  const r = buildResumePrompt({ goal: 'mi objetivo', history: [] });
  assertEqual(r, 'mi objetivo');
});

test('maneja run sin plan', () => {
  const r = buildResumePrompt({ goal: 'g', history: [{ step: 1, ok: true, summary: 'x' }] });
  assertOk(typeof r === 'string', 'debe devolver una cadena');
});

console.log('tasks.js — constantes');

test('MAX_ATTEMPTS es un número positivo', () => {
  assertOk(typeof MAX_ATTEMPTS === 'number' && MAX_ATTEMPTS > 0, 'MAX_ATTEMPTS');
});

test('RETRY_BACKOFF_MS es un número positivo', () => {
  assertOk(typeof RETRY_BACKOFF_MS === 'number' && RETRY_BACKOFF_MS > 0, 'RETRY_BACKOFF_MS');
});

test('TaskManager es una clase', () => {
  assertOk(typeof tasks.TaskManager === 'function', 'debe ser una función/clase');
});

test('TICK_MS es un número positivo', () => {
  assertOk(typeof tasks.TICK_MS === 'number' && tasks.TICK_MS > 0, 'TICK_MS');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
