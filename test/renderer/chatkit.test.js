'use strict';

/* Tests del renderer sin spawn: carga chatkit.js en jsdom y verifica aserciones.
   Sin node:test ni Vitest: ambos spawnean procesos y el sandbox de Windows
   los bloquea (EPERM). Este script se ejecuta directo con node. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CHATKIT_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'chatkit.js'), 'utf8');

function cargarChatKit() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  /* El renderer carga los diccionarios y i18n.js ANTES que chatkit.js: sus etiquetas
     son claves que se resuelven al leerlas. Sin ellos, la ventana no tendría idioma. */
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'i18n-es.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'i18n-en.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'i18n.js'), 'utf8'));
  const fn = new Function('window', 'console', CHATKIT_SRC);
  fn(dom.window, console);
  return dom.window.ChatKit;
}

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

function assertMatch(value, regex, msg) {
  if (!regex.test(value)) throw new Error(`${msg || ''} ${JSON.stringify(value)} no cumple ${regex}`);
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('ChatKit — modos');

test('los cuatro modos tienen identidad propia', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.mode('act').key, 'act');
  assertEqual(ChatKit.mode('plan').key, 'plan');
  assertEqual(ChatKit.mode('think').key, 'think');
  assertEqual(ChatKit.mode('equipo').key, 'equipo');
});

test('cada modo tiene color, icono y lema', () => {
  const ChatKit = cargarChatKit();
  for (const key of ['act', 'plan', 'think', 'equipo']) {
    const m = ChatKit.mode(key);
    assertMatch(m.color, /^#[0-9a-f]{6}$/i, `color de ${key}:`);
    assertOk(m.icon, `icon de ${key}`);
    assertOk(m.tagline, `tagline de ${key}`);
  }
});

test('la cara de PLAN no promete ejecución y remite a ACT', () => {
  // PLAN es solo lectura (agent/agent.js soloLectura): su lema no puede decir que
  // ejecuta nada; dibuja el plan y remite a ACT para aplicarlo.
  const ChatKit = cargarChatKit();
  const m = ChatKit.mode('plan');
  const texto = [m.tagline, ...m.bullets].join(' · ');
  assertMatch(texto, /ACT/, 'la cara del modo PLAN debe remitir a ACT:');
  assertOk(!/ejec[úu]t|marcarse/i.test(texto), `PLAN no puede prometer que ejecuta: ${texto}`);
});

test('el modo por defecto es act', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.mode(null).key, 'act');
  assertEqual(ChatKit.mode(undefined).key, 'act');
  assertEqual(ChatKit.mode('').key, 'act');
});

test('un modo desconocido cae a act', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.mode('inventado').key, 'act');
});

console.log('ChatKit — herramientas');

test('conoce las herramientas principales', () => {
  const ChatKit = cargarChatKit();
  for (const name of ['run_command', 'read_file', 'write_file', 'edit_file', 'browser_control', 'screenshot']) {
    assertOk(ChatKit.tool(name), `falta ${name}`);
  }
});

test('cada herramienta tiene etiqueta humana e icono', () => {
  const ChatKit = cargarChatKit();
  for (const name of ['run_command', 'read_file', 'write_file', 'browser_control']) {
    const t = ChatKit.tool(name);
    assertOk(t.label, `label de ${name}`);
    assertOk(t.icon, `icon de ${name}`);
  }
});

test('una herramienta desconocida devuelve un objeto válido', () => {
  const ChatKit = cargarChatKit();
  const t = ChatKit.tool('inventada');
  assertOk(t);
  assertOk(t.label);
});

console.log('ChatKit — utilidades');

test('fmtDuration formatea ms a texto legible', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.fmtDuration(500), '500 ms');
  assertEqual(ChatKit.fmtDuration(1500), '1,5 s');
  assertEqual(ChatKit.fmtDuration(65000), '1 min 5 s');
});

test('subagent devuelve null con id vacío', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.subagent(''), null);
});

test('subagent resuelve etiquetas conocidas', () => {
  const ChatKit = cargarChatKit();
  assertEqual(ChatKit.subagent('verification').label, 'Verificador');
});

/* Un 402 de OpenCode Go llega con «Endpoint is unavailable»: el modelo se ha caído
   arriba. Antes caía en «El turno falló — revisa Ajustes», que manda a mirar la clave
   cuando no hay nada que arreglar aquí. Medido con longcat-2.5-preview-free. */
test('un 402 del proveedor se explica como modelo no disponible', () => {
  const ChatKit = cargarChatKit();
  const r = ChatKit.explainError('HTTP 402 de OpenCode Go: {"error":{"message":"Upstream request failed: Endpoint is unavailable."}}');
  assertEqual(r.texto, 'Ese modelo no está disponible ahora mismo', 'texto:');
  assertMatch(r.pista, /del proveedor, no de tu clave/, 'la pista quita la culpa al usuario:');
});

test('un 401 sigue hablando de la credencial', () => {
  const ChatKit = cargarChatKit();
  const r = ChatKit.explainError('HTTP 401 de OpenCode Go: {"error":{"message":"Invalid credential"}}');
  assertEqual(r.texto, 'El proveedor rechazó la credencial', 'texto:');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
