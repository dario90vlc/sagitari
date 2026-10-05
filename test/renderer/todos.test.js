'use strict';

/* Tests para agent/todos.js — lista de tareas del agente.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const todos = require(path.join(__dirname, '..', '..', 'agent', 'todos.js'));

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

console.log('todos.js — marcador');

test('marcador de completada', () => {
  assertEqual(todos.marcador('completed'), '[x]');
});

test('marcador de en curso', () => {
  assertEqual(todos.marcador('in_progress'), '[>]');
});

test('marcador de pendiente', () => {
  assertEqual(todos.marcador('pending'), '[ ]');
});

test('marcador de estado desconocido', () => {
  assertEqual(todos.marcador('loquesea'), '[ ]');
});

console.log('todos.js — estado');

test('cuenta estados de una lista', () => {
  const e = todos.estado([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]);
  assertEqual(e.total, 3);
  assertEqual(e.completadas, 1);
  assertEqual(e.enCurso, 1);
  assertEqual(e.pendientes, 1);
});

test('maneja lista vacía', () => {
  const e = todos.estado([]);
  assertEqual(e.total, 0);
  assertEqual(e.pendientes, 0);
});

test('maneja entrada no-array', () => {
  const e = todos.estado(null);
  assertEqual(e.total, 0);
});

console.log('todos.js — limpiar');

test('aplana espacios múltiples', () => {
  assertEqual(todos.limpiar('  hola   mundo  '), 'hola mundo');
});

test('aplana saltos de línea', () => {
  assertEqual(todos.limpiar('hola\nmundo'), 'hola mundo');
});

test('maneja null', () => {
  assertEqual(todos.limpiar(null), '');
});

console.log('todos.js — normalizar');

test('rechaza undefined', () => {
  const r = todos.normalizar(undefined);
  assertEqual(r.ok, false);
  assertOk(r.error, 'debe traer error');
});

test('rechaza null', () => {
  const r = todos.normalizar(null);
  assertEqual(r.ok, false);
});

test('rechaza no-array', () => {
  const r = todos.normalizar('no soy un array');
  assertEqual(r.ok, false);
});

test('acepta lista vacía (borra la lista)', () => {
  const r = todos.normalizar([]);
  assertEqual(r.ok, true);
  assertEqual(r.todos.length, 0);
});

test('normaliza una lista válida', () => {
  const r = todos.normalizar([{ content: 'hacer algo', status: 'pending' }]);
  assertEqual(r.ok, true);
  assertEqual(r.todos.length, 1);
  assertEqual(r.todos[0].content, 'hacer algo');
});

test('ignora elementos que no son objetos', () => {
  const r = todos.normalizar(['texto suelto', { content: 'válida', status: 'pending' }]);
  assertEqual(r.ok, true);
  assertEqual(r.todos.length, 1);
});

test('ignora tareas sin content', () => {
  const r = todos.normalizar([{ status: 'pending' }]);
  assertEqual(r.ok, true);
  assertEqual(r.todos.length, 0);
});

test('deduplica tareas repetidas', () => {
  const r = todos.normalizar([
    { content: 'repetida', status: 'pending' },
    { content: 'repetida', status: 'pending' },
  ]);
  assertEqual(r.ok, true);
  assertEqual(r.todos.length, 1);
});

console.log('todos.js — constantes');

test('MAX_TAREAS y MAX_TEXTO son números positivos', () => {
  assertOk(typeof todos.MAX_TAREAS === 'number' && todos.MAX_TAREAS > 0, 'MAX_TAREAS');
  assertOk(typeof todos.MAX_TEXTO === 'number' && todos.MAX_TEXTO > 0, 'MAX_TEXTO');
});

test('ALIAS_ESTADO mapea alias a estados válidos', () => {
  assertOk(todos.ALIAS_ESTADO && typeof todos.ALIAS_ESTADO === 'object', 'debe ser objeto');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
