'use strict';

/* Tests para agent/models.js — clasificación de tareas y cadena de fallback.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const models = require(path.join(__dirname, '..', '..', 'agent', 'models.js'));

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

console.log('models.js — CATEGORIES');

test('CATEGORIES es un array con las categorías esperadas', () => {
  assertOk(Array.isArray(models.CATEGORIES), 'debe ser un array');
  assertOk(models.CATEGORIES.includes('simple'), 'debe incluir simple');
  assertOk(models.CATEGORIES.includes('coding'), 'debe incluir coding');
  assertOk(models.CATEGORIES.includes('reasoning'), 'debe incluir reasoning');
  assertOk(models.CATEGORIES.includes('vision'), 'debe incluir vision');
  assertOk(models.CATEGORIES.includes('browser'), 'debe incluir browser');
  assertOk(models.CATEGORIES.includes('research'), 'debe incluir research');
  assertOk(models.CATEGORIES.includes('complex'), 'debe incluir complex');
});

console.log('models.js — classify');

test('clasifica una tarea de código como coding', () => {
  assertEqual(models.classify('arregla el bug de la función'), 'coding');
});

test('clasifica una tarea de navegación como browser', () => {
  assertEqual(models.classify('navega a la web y rellena el formulario'), 'browser');
});

test('clasifica una tarea de investigación como research', () => {
  assertEqual(models.classify('investiga y compara las fuentes'), 'research');
});

test('clasifica una tarea de razonamiento como reasoning', () => {
  assertEqual(models.classify('razona la estrategia y decide'), 'reasoning');
});

test('clasifica una tarea con imagen como vision', () => {
  assertEqual(models.classify('describe esto', { hasImage: true }), 'vision');
});

test('clasifica una tarea larga como complex', () => {
  assertEqual(models.classify('x'.repeat(300)), 'complex');
});

test('clasifica una tarea simple como simple', () => {
  assertEqual(models.classify('hola'), 'simple');
});

test('maneja goal vacío', () => {
  assertEqual(models.classify(''), 'simple');
});

test('maneja goal null', () => {
  assertEqual(models.classify(null), 'simple');
});

console.log('models.js — fallbackChain');

test('devuelve array vacío sin proveedores', () => {
  const chain = models.fallbackChain({}, 'simple');
  assertOk(Array.isArray(chain), 'debe ser un array');
  assertEqual(chain.length, 0);
});

test('incluye el proveedor activo como primario', () => {
  const config = {
    providers: [{ id: 'p1', name: 'Proveedor 1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }],
    active: { providerId: 'p1', model: 'gpt-4o' },
  };
  const chain = models.fallbackChain(config, 'simple');
  assertEqual(chain.length, 1);
  assertEqual(chain[0].providerId, 'p1');
  assertEqual(chain[0].role, 'primary');
});

test('cada entrada lleva su formato de protocolo', () => {
  const config = {
    providers: [{ id: 'p1', name: 'Proveedor 1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }],
    active: { providerId: 'p1', model: 'gpt-4o' },
  };
  const chain = models.fallbackChain(config, 'simple');
  assertOk(chain[0].format, 'debe llevar format');
});

test('no duplica el proveedor activo si está en la cadena manual', () => {
  const config = {
    providers: [{ id: 'p1', name: 'Proveedor 1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] }],
    active: { providerId: 'p1', model: 'gpt-4o' },
    fallbackChain: ['p1'],
  };
  const chain = models.fallbackChain(config, 'simple');
  assertEqual(chain.length, 1);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
