'use strict';

/* Tests para agent/repomap.js — símbolos y reglas de ignorado del mapa.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const repomap = require(path.join(__dirname, '..', '..', 'agent', 'repomap.js'));

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

console.log('repomap.js — simbolosDe');

test('extrae una función de JS', () => {
  const s = repomap.simbolosDe('function miFuncion() {}', '.js');
  assertOk(Array.isArray(s), 'debe ser un array');
  assertOk(
    s.some((x) => x.name === 'miFuncion'),
    'debe encontrar miFuncion',
  );
  assertOk(
    s.some((x) => x.kind === 'función'),
    'debe marcar el tipo función',
  );
});

test('extrae una clase de JS', () => {
  const s = repomap.simbolosDe('class MiClase {}', '.js');
  assertOk(
    s.some((x) => x.name === 'MiClase'),
    'debe encontrar MiClase',
  );
});

test('devuelve array vacío para extensión desconocida', () => {
  const s = repomap.simbolosDe('contenido', '.xyz');
  assertEqual(s.length, 0);
});

test('maneja texto vacío', () => {
  const s = repomap.simbolosDe('', '.js');
  assertOk(Array.isArray(s), 'debe ser un array');
});

test('ignora líneas de comentario', () => {
  const s = repomap.simbolosDe('// function comentada() {}', '.js');
  assertEqual(s.length, 0);
});

console.log('repomap.js — ignoradoPorRegla');

test('devuelve false sin reglas', () => {
  assertEqual(repomap.ignoradoPorRegla('src/index.js', []), false);
});

test('devuelve un booleano', () => {
  const r = repomap.ignoradoPorRegla('node_modules/x/index.js', []);
  assertOk(typeof r === 'boolean', 'debe ser booleano');
});

console.log('repomap.js — constantes');

test('MAX_FICHEROS es un número positivo', () => {
  assertOk(typeof repomap.MAX_FICHEROS === 'number' && repomap.MAX_FICHEROS > 0, 'MAX_FICHEROS');
});

test('IGNORADOS está definido y no vacío', () => {
  const ig = repomap.IGNORADOS;
  assertOk(ig, 'debe estar definido');
  const n = ig instanceof Set ? ig.size : Array.isArray(ig) ? ig.length : Object.keys(ig).length;
  assertOk(n > 0, 'no debe estar vacío');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
