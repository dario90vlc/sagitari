'use strict';

/* Tests para agent/opencode.js — identificación del cliente ante OpenCode.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const opencode = require(path.join(__dirname, '..', '..', 'agent', 'opencode.js'));

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

console.log('opencode.js — isOpenCode');

test('reconoce el endpoint de OpenCode', () => {
  assertEqual(opencode.isOpenCode('https://opencode.ai/zen/go/v1'), true);
});

test('rechaza otro proveedor', () => {
  assertEqual(opencode.isOpenCode('https://api.openai.com/v1'), false);
});

test('maneja cadena vacía o null', () => {
  assertEqual(opencode.isOpenCode(''), false);
  assertEqual(opencode.isOpenCode(null), false);
});

console.log('opencode.js — userAgent');

test('el User-Agent lleva el nombre y la versión', () => {
  const ua = opencode.userAgent();
  assertOk(ua.startsWith('Sagitari/'), 'debe empezar por Sagitari/');
  assertOk(ua.length > 'Sagitari/'.length, 'debe llevar versión');
});

console.log('opencode.js — newSessionId / sessionFor');

test('newSessionId devuelve un id estable en formato', () => {
  const id = opencode.newSessionId();
  assertOk(typeof id === 'string' && id.length > 0, 'debe ser una cadena');
  assertOk(id.startsWith('sagi-'), 'debe empezar por sagi-');
});

test('dos sesiones nuevas son distintas', () => {
  assertOk(opencode.newSessionId() !== opencode.newSessionId(), 'deben diferir');
});

test('sessionFor devuelve un id para una conversación', () => {
  const id = opencode.sessionFor('conv-1');
  assertOk(typeof id === 'string' && id.length > 0, 'debe ser una cadena');
});

test('sessionFor es estable para la misma conversación', () => {
  assertEqual(opencode.sessionFor('conv-1'), opencode.sessionFor('conv-1'));
});

test('sessionFor da ids distintos a conversaciones distintas', () => {
  assertOk(opencode.sessionFor('conv-1') !== opencode.sessionFor('conv-2'), 'deben diferir');
});

console.log('opencode.js — identityHeaders');

test('añade las cabeceras de OpenCode', () => {
  const h = opencode.identityHeaders('https://opencode.ai/zen/go/v1', 'sesion-1');
  assertEqual(h['x-opencode-session'], 'sesion-1');
  assertEqual(h['x-opencode-client'], opencode.CLIENT);
});

test('genera sesión si no se le pasa ninguna', () => {
  const h = opencode.identityHeaders('https://opencode.ai/zen/go/v1');
  assertOk(h['x-opencode-session'], 'debe generar una sesión');
});

test('no añade cabeceras para otro proveedor', () => {
  const h = opencode.identityHeaders('https://api.openai.com/v1', 'sesion-1');
  assertEqual(Object.keys(h).length, 0);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
