'use strict';

/* Tests para agent/edicion.js — funciones puras de edición tolerante a espacios.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const edicion = require(path.join(__dirname, '..', '..', 'agent', 'edicion.js'));

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

console.log('edicion.js — lineas');

test('divide texto en líneas', () => {
  const ls = edicion.lineas('hola\nmundo');
  assertEqual(ls.length, 2);
  assertEqual(ls[0].texto, 'hola');
  assertEqual(ls[1].texto, 'mundo');
});

test('maneja texto sin saltos de línea', () => {
  const ls = edicion.lineas('hola');
  assertEqual(ls.length, 1);
  assertEqual(ls[0].texto, 'hola');
});

test('maneja texto vacío', () => {
  const ls = edicion.lineas('');
  assertEqual(ls.length, 1);
  assertEqual(ls[0].texto, '');
});

test('maneja CRLF', () => {
  const ls = edicion.lineas('hola\r\nmundo');
  assertEqual(ls.length, 2);
  assertEqual(ls[0].texto, 'hola\r');
  assertEqual(ls[1].texto, 'mundo');
});

console.log('edicion.js — norm');

test('normaliza una línea con sangría', () => {
  assertEqual(edicion.norm('  hola'), 'hola');
});

test('normaliza una línea con espacios finales', () => {
  assertEqual(edicion.norm('hola  '), 'hola');
});

test('normaliza una línea con CRLF', () => {
  assertEqual(edicion.norm('hola\r'), 'hola');
});

test('normaliza una línea vacía', () => {
  assertEqual(edicion.norm(''), '');
});

test('normaliza una línea con tabuladores', () => {
  assertEqual(edicion.norm('\thola\t'), 'hola');
});

console.log('edicion.js — candidatos');

test('encuentra candidatos en un texto', () => {
  const texto = 'hola\nmundo\nhola\nmundo';
  const cs = edicion.candidatos(texto, 'hola');
  assertOk(cs.length > 0, 'debe encontrar candidatos');
});

test('no encuentra candidatos si no hay coincidencias', () => {
  const texto = 'hola\nmundo';
  const cs = edicion.candidatos(texto, 'inexistente');
  assertEqual(cs.length, 0);
});

test('maneja texto vacío', () => {
  const cs = edicion.candidatos('', 'hola');
  assertEqual(cs.length, 0);
});

test('maneja busca vacía', () => {
  const cs = edicion.candidatos('hola\nmundo', '');
  assertEqual(cs.length, 0);
});

console.log('edicion.js — norm');

test('normaliza una línea con sangría', () => {
  assertEqual(edicion.norm('  hola'), 'hola');
});

test('normaliza una línea con espacios finales', () => {
  assertEqual(edicion.norm('hola  '), 'hola');
});

test('normaliza una línea con CRLF', () => {
  assertEqual(edicion.norm('hola\r'), 'hola');
});

test('normaliza una línea vacía', () => {
  assertEqual(edicion.norm(''), '');
});

test('normaliza una línea con tabuladores', () => {
  assertEqual(edicion.norm('\thola\t'), 'hola');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
