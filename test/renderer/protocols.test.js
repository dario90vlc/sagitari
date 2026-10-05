'use strict';

/* Tests para agent/protocols.js — funciones puras de protocolos de proveedor.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const protocols = require(path.join(__dirname, '..', '..', 'agent', 'protocols.js'));

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

console.log('protocols.js — detectFormat');

test('detecta formato openai por defecto', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' }), 'openai');
});

test('detecta formato anthropic para modelos anthropic', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet' }), 'anthropic');
});

test('detecta formato responses para modelos openai recientes', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://opencode.ai', model: 'gpt-5.6-luna' }), 'responses');
});

test('detecta formato openai para modelos no listados', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' }), 'openai');
});

test('detecta formato anthropic para modelos minimax', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://opencode.ai', model: 'minimax-m3' }), 'anthropic');
});

test('detecta formato responses para grok', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://opencode.ai', model: 'grok-4.6' }), 'responses');
});

test('usa el formato proporcionado si está especificado', () => {
  assertEqual(protocols.detectFormat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4', format: 'anthropic' }), 'anthropic');
});

console.log('protocols.js — authHeaders');

test('genera header Bearer para openai', () => {
  const headers = protocols.authHeaders({ apiKey: 'sk-test123' }, 'openai');
  assertEqual(headers.Authorization, 'Bearer sk-test123');
});

test('genera header x-api-key para anthropic', () => {
  const headers = protocols.authHeaders({ apiKey: 'sk-ant-test123' }, 'anthropic');
  assertEqual(headers['x-api-key'], 'sk-ant-test123');
});

test('incluye content-type en los headers', () => {
  const headers = protocols.authHeaders({ apiKey: 'test' }, 'openai');
  assertEqual(headers['Content-Type'], 'application/json');
});

console.log('protocols.js — buildBodyOpenAI');

test('construye body para openai con messages', () => {
  const body = protocols.buildBodyOpenAI({ model: 'gpt-4', temperature: 0.5 }, [{ role: 'user', content: 'hola' }], []);
  assertEqual(body.model, 'gpt-4');
  assertEqual(body.messages.length, 1);
  assertEqual(body.messages[0].role, 'user');
});

test('construye body para anthropic con system', () => {
  const body = protocols.buildBodyAnthropic(
    { model: 'claude-3-5-sonnet', system: 'Eres un asistente' },
    [{ role: 'user', content: 'hola' }],
    [],
  );
  assertEqual(body.model, 'claude-3-5-sonnet');
  assertOk(body, 'debe construir el body');
  assertOk(body.messages, 'debe incluir messages');
});

test('construye body para responses con instructions', () => {
  const body = protocols.buildBodyResponses({ model: 'gpt-5', instructions: 'Eres un asistente' }, [{ role: 'user', content: 'hola' }], []);
  assertEqual(body.model, 'gpt-5');
  assertOk(body, 'debe construir el body');
});

test('incluye tools en el body cuando se proporcionan', () => {
  const tools = [{ type: 'function', function: { name: 'run_command', description: 'Ejecuta un comando' } }];
  const body = protocols.buildBodyOpenAI({ model: 'gpt-4' }, [{ role: 'user', content: 'hola' }], tools);
  assertOk(body.tools, 'debe incluir tools');
  assertEqual(body.tools.length, 1);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
