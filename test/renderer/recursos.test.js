'use strict';

/* Tests para agent/recursos.js — límites de concurrencia por recurso compartido.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const recursos = require(path.join(__dirname, '..', '..', 'agent', 'recursos.js'));

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

console.log('recursos.js — LIMITES');

test('LIMITES tiene los recursos esperados', () => {
  for (const r of ['navegador', 'disco', 'terminal', 'escritorio', 'mcp', 'general']) {
    assertOk(typeof recursos.LIMITES[r] === 'number', 'debe definir ' + r);
  }
});

test('el navegador y el disco son de uno en uno', () => {
  assertEqual(recursos.LIMITES.navegador, 1);
  assertEqual(recursos.LIMITES.disco, 1);
});

test('los límites son positivos', () => {
  for (const [k, v] of Object.entries(recursos.LIMITES)) assertOk(v > 0, k + ' debe ser positivo');
});

console.log('recursos.js — paraHerramienta');

test('browser_control usa el navegador', () => {
  assertEqual(recursos.paraHerramienta('browser_control').join(','), 'navegador');
});

test('write_file usa el disco', () => {
  assertEqual(recursos.paraHerramienta('write_file').join(','), 'disco');
});

test('run_command usa la terminal', () => {
  assertEqual(recursos.paraHerramienta('run_command').join(','), 'terminal');
});

test('una herramienta MCP usa mcp', () => {
  assertEqual(recursos.paraHerramienta('mcp__servidor__herramienta').join(','), 'mcp');
});

test('una herramienta desconocida cae en general', () => {
  assertEqual(recursos.paraHerramienta('herramienta_inventada').join(','), 'general');
});

test('read_file no necesita recurso compartido', () => {
  assertEqual(recursos.paraHerramienta('read_file').length, 0);
});

test('maneja nombre vacío', () => {
  assertOk(Array.isArray(recursos.paraHerramienta('')), 'debe devolver un array');
});

console.log('recursos.js — Recursos');

test('Recursos es una clase instanciable', () => {
  const r = new recursos.Recursos();
  assertOk(r instanceof recursos.Recursos, 'debe instanciarse');
});

test('acepta límites personalizados', () => {
  const r = new recursos.Recursos({ terminal: 5 });
  assertEqual(r.limites.terminal, 5);
  assertEqual(r.limites.disco, 1, 'los no indicados conservan el valor por defecto');
});

test('la instancia compartida existe', () => {
  assertOk(recursos.recursos instanceof recursos.Recursos, 'debe haber una instancia única');
});

test('expone adquirir, con, estado y configurar', () => {
  const r = new recursos.Recursos();
  assertOk(typeof r.adquirir === 'function', 'adquirir debe ser función');
  assertOk(typeof r.con === 'function', 'con debe ser función');
  assertOk(typeof r.estado === 'function', 'estado debe ser función');
  assertOk(typeof r.configurar === 'function', 'configurar debe ser función');
});

test('estado informa de los recursos libres', () => {
  const r = new recursos.Recursos();
  const e = r.estado();
  assertOk(e, 'debe devolver un estado');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
