'use strict';

/* Tests para agent/browser-profiles.js — perfiles de navegador aislados.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const perfiles = require(path.join(__dirname, '..', '..', 'agent', 'browser-profiles.js'));

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

console.log('browser-profiles.js — profileId');

test('devuelve un id legible', () => {
  const id = perfiles.profileId('mi perfil');
  assertOk(id.startsWith('mi_perfil'), 'debe empezar por el slug, no ' + id);
});

test('es estable para el mismo nombre', () => {
  assertEqual(perfiles.profileId('trabajo'), perfiles.profileId('trabajo'));
});

test('nombres parecidos no colapsan al mismo id', () => {
  assertOk(perfiles.profileId('mi perfil') !== perfiles.profileId('mi_perfil'), 'no deben coincidir');
});

test('maneja nombre vacío', () => {
  const id = perfiles.profileId('');
  assertOk(typeof id === 'string', 'debe ser una cadena');
});

test('un nombre con ruta no escapa de la carpeta de perfiles', () => {
  // El slug puede conservar puntos («.._.._fuera»), pero nunca como SEGMENTO de
  // ruta suelto, así que el resultado sigue dentro de la base. Eso es lo que
  // importa: que un nombre no pueda sacar el perfil de su carpeta.
  const base = path.resolve(perfiles.PROFILE_BASE).toLowerCase();
  for (const nombre of ['../../fuera', '..', 'C:\\Windows', 'a/b', 'a\\b', '']) {
    const dir = path.resolve(perfiles.profileDirFor(nombre)).toLowerCase();
    const dentro = dir === base || dir.startsWith(base + path.sep);
    assertOk(dentro, '«' + nombre + '» escapó a ' + dir);
  }
});

console.log('browser-profiles.js — profileDirFor');

test('la carpeta cuelga de la base de perfiles', () => {
  const dir = perfiles.profileDirFor('trabajo');
  assertOk(typeof dir === 'string' && dir.length > 0, 'debe ser una ruta');
  assertOk(dir.includes('browser-profiles'), 'debe estar bajo browser-profiles');
});

test('perfiles distintos usan carpetas distintas', () => {
  assertOk(perfiles.profileDirFor('a') !== perfiles.profileDirFor('b'), 'deben diferir');
});

console.log('browser-profiles.js — legacyDirFor');

test('devuelve la carpeta antigua del perfil', () => {
  const dir = perfiles.legacyDirFor('trabajo');
  assertOk(typeof dir === 'string' && dir.length > 0, 'debe ser una ruta');
});

console.log('browser-profiles.js — API');

test('ensureProfileDir es una función', () => {
  assertOk(typeof perfiles.ensureProfileDir === 'function', 'ensureProfileDir');
});

test('PROFILE_BASE es una ruta', () => {
  assertOk(typeof perfiles.PROFILE_BASE === 'string' && perfiles.PROFILE_BASE.length > 0, 'PROFILE_BASE');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
