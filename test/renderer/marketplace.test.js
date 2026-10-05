'use strict';

/* Tests para agent/marketplace.js — catálogo de skills destacadas.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const marketplace = require(path.join(__dirname, '..', '..', 'agent', 'marketplace.js'));

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

console.log('marketplace.js — FEATURED');

test('es una lista no vacía', () => {
  assertOk(Array.isArray(marketplace.FEATURED), 'debe ser un array');
  assertOk(marketplace.FEATURED.length > 0, 'no debe estar vacío');
});

test('cada entrada tiene repo, categoría y descripción', () => {
  for (const f of marketplace.FEATURED) {
    assertOk(f.repo, 'falta repo en ' + JSON.stringify(f).slice(0, 60));
    assertOk(f.category, 'falta category en ' + f.repo);
    assertOk(f.description, 'falta description en ' + f.repo);
  }
});

test('los repo tienen forma owner/nombre', () => {
  for (const f of marketplace.FEATURED) {
    assertOk(String(f.repo).includes('/'), f.repo + ' no tiene forma owner/nombre');
  }
});

test('no hay repos repetidos', () => {
  const repos = marketplace.FEATURED.map((f) => f.repo);
  assertEqual(new Set(repos).size, repos.length, 'hay repos duplicados');
});

test('ningún repo apunta fuera de GitHub', () => {
  for (const f of marketplace.FEATURED) {
    assertOk(!/^https?:|\.\./.test(f.repo), f.repo + ' debería ser solo owner/nombre');
  }
});

console.log('marketplace.js — API');

test('catalog y searchGitHub son funciones', () => {
  assertOk(typeof marketplace.catalog === 'function', 'catalog');
  assertOk(typeof marketplace.searchGitHub === 'function', 'searchGitHub');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
