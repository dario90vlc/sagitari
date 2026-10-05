'use strict';

/* Tests para agent/mcp-transport.js — transporte de servidores MCP.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const mt = require(path.join(__dirname, '..', '..', 'agent', 'mcp-transport.js'));

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

console.log('mcp-transport.js — httpUrlAllowed');

test('acepta https', () => {
  assertEqual(mt.httpUrlAllowed('https://ejemplo.com/mcp'), true);
});

test('rechaza http en claro (el token viajaría sin cifrar)', () => {
  assertEqual(mt.httpUrlAllowed('http://ejemplo.com/mcp'), false);
});

test('rechaza file://', () => {
  assertEqual(mt.httpUrlAllowed('file:///C:/secreto'), false);
});

test('rechaza cadena vacía y null', () => {
  assertEqual(mt.httpUrlAllowed(''), false);
  assertEqual(mt.httpUrlAllowed(null), false);
});

test('rechaza basura que no es URL', () => {
  assertEqual(mt.httpUrlAllowed('no es una url'), false);
});

console.log('mcp-transport.js — buildCmdLine');

test('compone comando y argumentos', () => {
  assertEqual(mt.buildCmdLine('node', ['a.js']), 'node a.js');
});

test('cita los argumentos con espacios', () => {
  assertEqual(mt.buildCmdLine('node', ['b c']), 'node "b c"');
});

test('devuelve cadena vacía sin comando', () => {
  assertEqual(mt.buildCmdLine('', []), '');
});

test('maneja argumentos ausentes', () => {
  assertEqual(mt.buildCmdLine('node'), 'node');
});

console.log('mcp-transport.js — parseSseText');

test('extrae los JSON de un flujo SSE', () => {
  const r = mt.parseSseText('data: {"a":1}\n\ndata: [DONE]\n\n');
  assertOk(Array.isArray(r), 'debe ser un array');
  assertEqual(r.length, 1);
  assertEqual(r[0].a, 1);
});

test('ignora la marca [DONE]', () => {
  const r = mt.parseSseText('data: [DONE]\n\n');
  assertEqual(r.length, 0);
});

test('maneja texto vacío', () => {
  const r = mt.parseSseText('');
  assertOk(Array.isArray(r), 'debe ser un array');
});

test('maneja varias líneas data', () => {
  const r = mt.parseSseText('data: {"a":1}\n\ndata: {"b":2}\n\n');
  assertEqual(r.length, 2);
});

console.log('mcp-transport.js — estructura');

test('DEFAULT_TIMEOUT_MS es un número positivo', () => {
  assertOk(typeof mt.DEFAULT_TIMEOUT_MS === 'number' && mt.DEFAULT_TIMEOUT_MS > 0, 'DEFAULT_TIMEOUT_MS');
});

test('expone las piezas del transporte', () => {
  for (const n of ['createLineReader', 'Rpc', 'resolveCommand', 'buscarEnPath', 'createStdioTransport', 'createHttpTransport']) {
    assertOk(mt[n], 'debe exponer ' + n);
  }
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
