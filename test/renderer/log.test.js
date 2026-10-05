'use strict';

/* Tests para main/log.js — registro con niveles.
   Captura la salida de consola para comprobar a dónde va cada nivel.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const log = require(path.join(__dirname, '..', '..', 'main', 'log.js'));

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

/** Ejecuta fn capturando lo que va a cada salida de consola. */
function capturar(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const out = { log: [], warn: [], error: [] };
  console.log = (...a) => out.log.push(a.join(' '));
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.error = (...a) => out.error.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return out;
}

console.log('log.js — niveles');

test('info escribe en la salida normal', () => {
  const o = capturar(() => log.info('hola'));
  assertEqual(o.log.length, 1);
});

test('warn escribe en el canal de avisos', () => {
  const o = capturar(() => log.warn('cuidado'));
  assertEqual(o.warn.length, 1);
});

test('error escribe en el canal de errores', () => {
  const o = capturar(() => log.error('boom'));
  assertEqual(o.error.length, 1);
});

test('debug se calla sin SAGITARI_DEBUG', () => {
  // MIN_LEVEL se fija al cargar el módulo: sin la variable, debug no pasa el filtro.
  if (process.env.SAGITARI_DEBUG) return; // con la variable puesta este test no aplica
  const o = capturar(() => log.debug('detalle'));
  assertEqual(o.log.length, 0);
});

test('cada nivel va SOLO a su canal', () => {
  const o = capturar(() => log.error('solo error'));
  assertEqual(o.log.length, 0);
  assertEqual(o.warn.length, 0);
});

console.log('log.js — formato');

test('la línea lleva el nivel en mayúsculas', () => {
  const o = capturar(() => log.info('hola'));
  assertOk(o.log[0].includes('[INFO]'), 'debe llevar [INFO]: ' + o.log[0]);
});

test('la línea lleva marca de tiempo ISO', () => {
  const o = capturar(() => log.info('hola'));
  assertOk(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(o.log[0]), 'debe llevar fecha: ' + o.log[0]);
});

test('conserva el mensaje', () => {
  const o = capturar(() => log.info('mensaje concreto'));
  assertOk(o.log[0].includes('mensaje concreto'), 'debe conservar el texto');
});

test('serializa los argumentos que no son cadenas', () => {
  const o = capturar(() => log.info({ a: 1 }));
  assertOk(o.log[0].includes('"a":1'), 'debe serializar el objeto: ' + o.log[0]);
});

test('junta varios argumentos en una línea', () => {
  const o = capturar(() => log.info('uno', 'dos'));
  assertOk(o.log[0].includes('uno') && o.log[0].includes('dos'), 'debe juntarlos');
  assertEqual(o.log.length, 1, 'debe ser una sola línea');
});

console.log('log.js — API');

test('expone los cuatro niveles', () => {
  for (const n of ['debug', 'info', 'warn', 'error']) assertOk(typeof log[n] === 'function', n + ' debe ser función');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
