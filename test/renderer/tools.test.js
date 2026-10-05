'use strict';

/* Tests para agent/tools.js — catálogo de herramientas y niveles de riesgo.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const tools = require(path.join(__dirname, '..', '..', 'agent', 'tools.js'));

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

console.log('tools.js — niveles de riesgo');

test('todas las herramientas tienen nivel de riesgo', () => {
  const defs = tools.defs || tools.default || tools;
  const list = Array.isArray(defs) ? defs : defs.tools || defs.defs || [];
  for (const def of list) {
    const name = def.function?.name || def.name;
    assertOk(name, 'la herramienta debe tener nombre');
    const risk = tools.RISK?.[name] || def.risk;
    assertOk(risk, `la herramienta ${name} debe tener nivel de riesgo`);
  }
});

test('los niveles de riesgo son válidos', () => {
  const validos = ['safe', 'confirm', 'restricted'];
  const RISK = tools.RISK || {};
  for (const [name, risk] of Object.entries(RISK)) {
    assertOk(validos.includes(risk), `el nivel de riesgo de ${name} (${risk}) debe ser uno de: ${validos.join(', ')}`);
  }
});

test('run_command es confirm', () => {
  assertEqual(tools.RISK.run_command, 'confirm');
});

test('read_file es safe', () => {
  assertEqual(tools.RISK.read_file, 'safe');
});

test('write_file es confirm', () => {
  assertEqual(tools.RISK.write_file, 'confirm');
});

test('browser_control es confirm', () => {
  assertEqual(tools.RISK.browser_control, 'confirm');
});

console.log('tools.js — estructura de herramientas');

test('las herramientas tienen descripción', () => {
  const defs = tools.defs || tools.default || tools;
  const list = Array.isArray(defs) ? defs : defs.tools || defs.defs || [];
  for (const def of list) {
    const name = def.function?.name || def.name;
    const desc = def.function?.description || def.description;
    assertOk(desc, `la herramienta ${name} debe tener descripción`);
  }
});

test('las herramientas tienen parámetros', () => {
  const defs = tools.defs || tools.default || tools;
  const list = Array.isArray(defs) ? defs : defs.tools || defs.defs || [];
  for (const def of list) {
    const name = def.function?.name || def.name;
    const params = def.function?.parameters || def.parameters;
    assertOk(params, `la herramienta ${name} debe tener parámetros`);
    assertOk(params.type === 'object', `los parámetros de ${name} deben ser un objeto`);
  }
});

test('las herramientas requieren al menos un parámetro', () => {
  const defs = tools.defs || tools.default || tools;
  const list = Array.isArray(defs) ? defs : defs.tools || defs.defs || [];
  for (const def of list) {
    const name = def.function?.name || def.name;
    const required = def.function?.parameters?.required || def.parameters?.required || [];
    assertOk(required.length > 0, `la herramienta ${name} debe requerir al menos un parámetro`);
  }
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
