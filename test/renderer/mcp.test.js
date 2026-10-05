'use strict';

/* Tests para agent/mcp.js — nombres de herramienta de los servidores MCP.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const mcp = require(path.join(__dirname, '..', '..', 'agent', 'mcp.js'));

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

console.log('mcp.js — serverSlug');

test('convierte un nombre en slug', () => {
  assertEqual(mcp.serverSlug('Mi Servidor MCP!'), 'mi_servidor_mcp');
});

test('recorta a 16 caracteres', () => {
  assertEqual(mcp.serverSlug('a'.repeat(80)).length, 16);
});

test('maneja cadena vacía', () => {
  const s = mcp.serverSlug('');
  assertOk(typeof s === 'string', 'debe ser una cadena');
});

test('no deja caracteres raros', () => {
  const s = mcp.serverSlug('a/b\\c d:e');
  assertOk(/^[a-z0-9_]*$/.test(s), 'slug inválido: ' + s);
});

console.log('mcp.js — mapToolName');

test('compone el nombre con el prefijo mcp__', () => {
  assertEqual(mcp.mapToolName('mi_servidor', 'buscar cosas'), 'mcp__mi_servidor__buscar_cosas');
});

test('el nombre no pasa del tope de la API', () => {
  const n = mcp.mapToolName('s'.repeat(30), 't'.repeat(200));
  assertOk(n.length <= mcp.MAX_TOOL_NAME, 'mide ' + n.length + ', tope ' + mcp.MAX_TOOL_NAME);
});

test('empieza siempre por mcp__', () => {
  const n = mcp.mapToolName('s', 't');
  assertOk(n.startsWith('mcp__'), 'debe empezar por mcp__: ' + n);
});

test('el nombre solo usa letras, números y guion bajo', () => {
  const n = mcp.mapToolName('Mi Servidor', 'Buscar Cosas!');
  assertOk(/^[a-z0-9_]+$/.test(n), 'nombre inválido: ' + n);
});

test('dos servidores distintos dan nombres distintos', () => {
  assertOk(mcp.mapToolName('uno', 'x') !== mcp.mapToolName('dos', 'x'), 'deben diferir');
});

test('dos herramientas distintas del mismo servidor difieren', () => {
  assertOk(mcp.mapToolName('s', 'uno') !== mcp.mapToolName('s', 'dos'), 'deben diferir');
});

console.log('mcp.js — constantes y API');

test('los topes son números positivos', () => {
  assertOk(mcp.MAX_TOOL_NAME > 0, 'MAX_TOOL_NAME');
  assertOk(mcp.DEFAULT_TIMEOUT_MS > 0, 'DEFAULT_TIMEOUT_MS');
  assertOk(mcp.MAX_RESULT_CHARS > 0, 'MAX_RESULT_CHARS');
});

test('McpManager es una clase', () => {
  assertOk(typeof mcp.McpManager === 'function', 'debe ser una función/clase');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
