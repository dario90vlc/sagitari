'use strict';

/* Tests para agent/comandos.js — funciones puras de seguridad de comandos.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const comandos = require(path.join(__dirname, '..', '..', 'agent', 'comandos.js'));

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

console.log('comandos.js — clasificar');

test('clasifica git status como normal', () => {
  const c = comandos.clasificar('git status');
  assertEqual(c.nivel, 'normal');
});

test('clasifica format C: como prohibido', () => {
  const c = comandos.clasificar('format C:');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica rm -rf / como prohibido', () => {
  const c = comandos.clasificar('rm -rf /');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica del /s /q C:\\ como prohibido', () => {
  const c = comandos.clasificar('del /s /q C:\\');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica echo hola como normal', () => {
  const c = comandos.clasificar('echo hola');
  assertEqual(c.nivel, 'normal');
});

test('clasifica comando vacío como normal', () => {
  const c = comandos.clasificar('');
  assertEqual(c.nivel, 'normal');
});

console.log('comandos.js — esSeguro');

test('git status es seguro', () => {
  assertEqual(comandos.esSeguro('git status'), true);
});

test('format C: no es seguro', () => {
  assertEqual(comandos.esSeguro('format C:'), false);
});

test('rm -rf / no es seguro', () => {
  assertEqual(comandos.esSeguro('rm -rf /'), false);
});

test('echo hola es seguro', () => {
  assertEqual(comandos.esSeguro('echo hola'), true);
});

console.log('comandos.js — compuesta');

test('git status no es compuesta', () => {
  assertEqual(comandos.compuesta('git status'), false);
});

test('git status && git push es compuesta', () => {
  assertEqual(comandos.compuesta('git status && git push'), true);
});

test('echo hola | grep test es compuesta', () => {
  assertEqual(comandos.compuesta('echo hola | grep test'), true);
});

test('comando vacío no es compuesta', () => {
  assertEqual(comandos.compuesta(''), false);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
