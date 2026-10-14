'use strict';

/* Tests para main/providers.js — presets de proveedores.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const providers = require(path.join(__dirname, '..', '..', 'main', 'providers.js'));

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

console.log('providers.js — PRESETS');

test('es un array no vacío', () => {
  assertOk(Array.isArray(providers.PRESETS), 'debe ser un array');
  assertOk(providers.PRESETS.length > 0, 'no debe estar vacío');
});

test('cada preset tiene id y name', () => {
  for (const p of providers.PRESETS) {
    assertOk(p.id, 'falta id en ' + JSON.stringify(p).slice(0, 60));
    assertOk(p.name, 'falta name en ' + p.id);
  }
});

test('cada preset trae baseUrl salvo el personalizado', () => {
  // «custom» es el proveedor que define el usuario: no puede traer una URL fija.
  for (const p of providers.PRESETS) {
    if (p.id === 'custom') continue;
    assertOk(p.baseUrl, 'falta baseUrl en ' + p.id);
  }
});

test('los id no se repiten', () => {
  const ids = providers.PRESETS.map((p) => p.id);
  assertEqual(new Set(ids).size, ids.length, 'hay ids duplicados');
});

test('todo preset remoto usa https', () => {
  // Los presets locales (Ollama, LM Studio) van a http://localhost a propósito:
  // no salen del equipo. El resto tiene que ir cifrado.
  for (const p of providers.PRESETS) {
    if (!p.baseUrl) continue;
    const local = /localhost|127\.0\.0\.1/.test(p.baseUrl);
    if (local) continue;
    assertOk(String(p.baseUrl).startsWith('https://'), p.id + ' no usa https: ' + p.baseUrl);
  }
});

test('el formato declarado es uno de los protocolos conocidos', () => {
  const validos = ['openai', 'anthropic', 'responses'];
  for (const p of providers.PRESETS) {
    if (p.format === undefined) continue;
    assertOk(validos.includes(p.format), p.id + ' declara un formato raro: ' + p.format);
  }
});

test('incluye OpenCode Go y Anthropic', () => {
  const ids = providers.PRESETS.map((p) => p.id);
  assertOk(ids.includes('opencode-go'), 'debe incluir opencode-go');
  assertOk(ids.includes('anthropic'), 'debe incluir anthropic');
});

console.log('providers.js — invariantes');

test('el listado de presets es estable (22, con los nuevos)', () => {
  assertEqual(providers.PRESETS.length, 22, 'número de presets');
  const ids = providers.PRESETS.map((p) => p.id);
  assertEqual(ids[ids.length - 1], 'custom', 'custom debe ir el último');
  for (const id of [
    'gemini',
    'deepseek',
    'xai',
    'mistral',
    'moonshot',
    'cerebras',
    'nvidia',
    'sambanova',
    'llamacpp',
    'vllm',
    'jan',
    'koboldcpp',
    'textgen',
    'localai',
  ]) {
    assertOk(ids.includes(id), 'falta el preset ' + id);
  }
});

test('orden: nubes nuevas tras groq y locales nuevos antes de los existentes', () => {
  const ids = providers.PRESETS.map((p) => p.id);
  assertOk(ids.indexOf('groq') < ids.indexOf('gemini'), 'gemini va tras groq');
  assertOk(ids.indexOf('sambanova') < ids.indexOf('llamacpp'), 'los locales nuevos van tras las nubes');
  assertOk(ids.indexOf('localai') < ids.indexOf('ollama'), 'los locales nuevos van antes de ollama');
});

test('invariantes de cada preset', () => {
  for (const p of providers.PRESETS) {
    assertOk(p.id, 'id vacío');
    assertOk(typeof p.name === 'string' && p.name.trim(), p.id + ': name vacío');
    assertOk(['openai', 'anthropic', 'responses'].includes(p.format), p.id + ': format inválido ' + p.format);
    if (p.id === 'custom') continue;
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(p.baseUrl);
    assertOk(/^https?:\/\//i.test(p.baseUrl) || local, p.id + ': baseUrl no es http(s) ni localhost: ' + p.baseUrl);
    if (p.needsKey === false) assertOk(local, p.id + ': needsKey=false pero la base no es localhost: ' + p.baseUrl);
  }
});

console.log('providers.js — isVisionModel');

test('reconoce un modelo con visión', () => {
  assertEqual(providers.isVisionModel('gpt-4o'), true);
});

test('no marca como visión un modelo de texto', () => {
  assertEqual(providers.isVisionModel('deepseek-chat'), false);
});

test('maneja cadena vacía o null', () => {
  assertEqual(providers.isVisionModel(''), false);
  assertEqual(providers.isVisionModel(null), false);
});

console.log('providers.js — estructura');

test('listModels es una función', () => {
  assertOk(typeof providers.listModels === 'function', 'listModels');
});

test('MAX_MODELS_BYTES es un número positivo', () => {
  assertOk(typeof providers.MAX_MODELS_BYTES === 'number' && providers.MAX_MODELS_BYTES > 0, 'MAX_MODELS_BYTES');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
