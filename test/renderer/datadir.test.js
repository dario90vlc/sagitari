'use strict';

/* Tests para agent/datadir.js — raíz de datos única del agente.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const datadir = require(path.join(__dirname, '..', '..', 'agent', 'datadir.js'));

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

console.log('datadir.js — dataDir');

test('devuelve una cadena no vacía', () => {
  const d = datadir.dataDir();
  assertOk(typeof d === 'string' && d.length > 0, 'debe ser una cadena');
});

test('SAGITARI_DATA_DIR manda cuando está puesto', () => {
  const antes = process.env.SAGITARI_DATA_DIR;
  process.env.SAGITARI_DATA_DIR = 'C:\\datos\\de\\prueba';
  try {
    assertEqual(datadir.dataDir(), 'C:\\datos\\de\\prueba');
  } finally {
    if (antes === undefined) delete process.env.SAGITARI_DATA_DIR;
    else process.env.SAGITARI_DATA_DIR = antes;
  }
});

test('sin la variable usa APPDATA/SagitariAI', () => {
  const antesDir = process.env.SAGITARI_DATA_DIR;
  const antesApp = process.env.APPDATA;
  delete process.env.SAGITARI_DATA_DIR;
  process.env.APPDATA = 'C:\\Users\\prueba\\AppData\\Roaming';
  try {
    const d = datadir.dataDir();
    assertOk(d.includes('SagitariAI'), 'debe incluir SagitariAI');
    assertOk(d.startsWith('C:\\Users\\prueba\\AppData\\Roaming'), 'debe colgar de APPDATA');
  } finally {
    if (antesDir !== undefined) process.env.SAGITARI_DATA_DIR = antesDir;
    if (antesApp === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = antesApp;
  }
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
