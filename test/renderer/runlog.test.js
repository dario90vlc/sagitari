'use strict';

/* Tests para agent/runlog.js — redacción de secretos en el registro de ejecución.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const runlog = require(path.join(__dirname, '..', '..', 'agent', 'runlog.js'));

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

console.log('runlog.js — redactToolArgs');

test('redacta apiKey', () => {
  const r = runlog.redactToolArgs('run_command', { apiKey: 'sk-1234567890abcdef' });
  assertEqual(r.apiKey, '[REDACTED]');
});

test('redacta password', () => {
  const r = runlog.redactToolArgs('run_command', { password: 'secreto' });
  assertEqual(r.password, '[REDACTED]');
});

test('redacta token', () => {
  const r = runlog.redactToolArgs('run_command', { token: 'abc123' });
  assertEqual(r.token, '[REDACTED]');
});

test('conserva los campos inocentes', () => {
  const r = runlog.redactToolArgs('run_command', { command: 'echo hola', path: 'C:/x' });
  assertEqual(r.command, 'echo hola');
  assertEqual(r.path, 'C:/x');
});

test('devuelve la entrada tal cual si no es objeto', () => {
  assertEqual(runlog.redactToolArgs('x', null), null);
  assertEqual(runlog.redactToolArgs('x', 'texto'), 'texto');
});

test('no muta el objeto original', () => {
  const args = { apiKey: 'sk-1234567890abcdef' };
  runlog.redactToolArgs('run_command', args);
  assertEqual(args.apiKey, 'sk-1234567890abcdef', 'el original no debe cambiar');
});

console.log('runlog.js — redactEvent');

test('redacta los args del evento', () => {
  const r = runlog.redactEvent({ tool: 'run_command', args: { apiKey: 'sk-abcdefghijklmnop' } });
  assertEqual(r.args.apiKey, '[REDACTED]');
});

test('redacta secretos dentro del mensaje de error', () => {
  const r = runlog.redactEvent({ tool: 'x', error: 'fallo con apiKey sk-abcdefghijklmnop' });
  assertOk(!r.error.includes('sk-abcdefghijklmnop'), 'el secreto no debe sobrevivir');
});

test('conserva los campos inocentes del evento', () => {
  const r = runlog.redactEvent({ tool: 'run_command', step: 3 });
  assertEqual(r.tool, 'run_command');
  assertEqual(r.step, 3);
});

test('devuelve la entrada tal cual si no es objeto', () => {
  assertEqual(runlog.redactEvent(null), null);
});

console.log('runlog.js — estructura');

test('LOG_DIR está definido', () => {
  assertOk(runlog.LOG_DIR, 'debe estar definido');
});

test('log, readRecent, currentLogFile y close son funciones', () => {
  assertOk(typeof runlog.log === 'function', 'log');
  assertOk(typeof runlog.readRecent === 'function', 'readRecent');
  assertOk(typeof runlog.currentLogFile === 'function', 'currentLogFile');
  assertOk(typeof runlog.close === 'function', 'close');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
