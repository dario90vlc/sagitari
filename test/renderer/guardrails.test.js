'use strict';

/* Tests para agent/guardrails.js — funciones puras de guardrails y permisos.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const guardrails = require(path.join(__dirname, '..', '..', 'agent', 'guardrails.js'));

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

console.log('guardrails.js — pricingFor');

test('devuelve pricing para gpt-5', () => {
  const p = guardrails.pricingFor('gpt-5', null);
  assertEqual(p.in, 1.25);
  assertEqual(p.out, 10);
});

test('devuelve pricing para claude-sonnet', () => {
  const p = guardrails.pricingFor('claude-sonnet', null);
  assertEqual(p.in, 3);
  assertEqual(p.out, 15);
});

test('devuelve pricing default para modelo desconocido', () => {
  const p = guardrails.pricingFor('modelo-desconocido', null);
  assertEqual(p.in, 1);
  assertEqual(p.out, 3);
});

test('el override del usuario gana', () => {
  const p = guardrails.pricingFor('gpt-5', { in: 5, out: 50 });
  assertEqual(p.in, 5);
  assertEqual(p.out, 50);
});

test('maneja modelo null/undefined', () => {
  const p = guardrails.pricingFor(null, null);
  assertEqual(p.in, 1);
  assertEqual(p.out, 3);
});

console.log('guardrails.js — summarizeArgs');

test('resume argumentos de run_command', () => {
  const s = guardrails.summarizeArgs('run_command', { command: 'dir /b' });
  assertEqual(s, 'dir /b');
});

test('resume argumentos de write_file', () => {
  const s = guardrails.summarizeArgs('write_file', { path: 'C:\\test.txt' });
  assertEqual(s, 'C:\\test.txt');
});

test('resume argumentos de browser_control', () => {
  const s = guardrails.summarizeArgs('browser_control', { action: 'navigate', url: 'https://example.com' });
  assertOk(s.includes('navigate'), 'debe incluir action');
  assertOk(s.includes('https://example.com'), 'debe incluir url');
});

test('resume argumentos de open_app', () => {
  const s = guardrails.summarizeArgs('open_app', { name: 'notepad' });
  assertEqual(s, 'notepad');
});

test('resume argumentos de open_url', () => {
  const s = guardrails.summarizeArgs('open_url', { url: 'https://example.com' });
  assertEqual(s, 'https://example.com');
});

test('resume argumentos de clipboard', () => {
  const s = guardrails.summarizeArgs('clipboard', { action: 'write' });
  assertEqual(s, 'escribir en el portapapeles');
});

test('resume argumentos de window_manage', () => {
  const s = guardrails.summarizeArgs('window_manage', { action: 'minimize' });
  assertEqual(s, 'minimize');
});

test('resume argumentos de herramienta desconocida', () => {
  const s = guardrails.summarizeArgs('herramienta-desconocida', { foo: 'bar' });
  assertOk(s.includes('foo'), 'debe incluir las claves');
});

test('maneja argumentos vacíos', () => {
  const s = guardrails.summarizeArgs('run_command', {});
  assertEqual(s, '');
});

test('maneja argumentos null', () => {
  const s = guardrails.summarizeArgs('run_command', null);
  assertEqual(s, '');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
