'use strict';

/* Tests para agent/contexto.js — funciones puras de contexto.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const contexto = require(path.join(__dirname, '..', '..', 'agent', 'contexto.js'));

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

console.log('contexto.js — ventanaDe');

test('devuelve ventana para claude', () => {
  assertEqual(contexto.ventanaDe({ model: 'claude-3-5-sonnet' }), 200000);
});

test('devuelve ventana para gpt-4o', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-4o' }), 128000);
});

test('devuelve ventana para gpt-5', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-5' }), 200000);
});

test('devuelve ventana default para modelo desconocido', () => {
  assertEqual(contexto.ventanaDe({ model: 'desconocido' }), 128000);
});

test('el contextWindow explícito gana', () => {
  assertEqual(contexto.ventanaDe({ model: 'gpt-4o', contextWindow: 64000 }), 64000);
});

test('maneja cfg vacío', () => {
  assertEqual(contexto.ventanaDe({}), 128000);
});

console.log('contexto.js — estimarTokens');

test('estima tokens de un texto', () => {
  const tokens = contexto.estimarTokens('hola mundo');
  assertOk(tokens > 0, 'debe ser mayor que 0');
});

test('estima 0 tokens para texto vacío', () => {
  assertEqual(contexto.estimarTokens(''), 0);
});

test('estima tokens de null como mínimo', () => {
  // JSON.stringify('') === '""' → 2 caracteres → ceil(2/3.6) = 1
  assertEqual(contexto.estimarTokens(null), 1);
});

test('estima tokens de un objeto', () => {
  const tokens = contexto.estimarTokens({ foo: 'bar' });
  assertOk(tokens > 0, 'debe ser mayor que 0');
});

console.log('contexto.js — medir');

test('mide mensajes vacíos', () => {
  const m = contexto.medir([], []);
  assertEqual(m.mensajes, 0);
  assertEqual(m.herramientas, 0);
  assertEqual(m.total, 0);
});

test('mide un mensaje simple', () => {
  const m = contexto.medir([{ role: 'user', content: 'hola' }], []);
  assertOk(m.mensajes > 0, 'debe tener mensajes');
  assertOk(m.caracteres > 0, 'debe tener caracteres');
});

test('mide herramientas', () => {
  const tools = [{ function: { name: 'run_command', description: 'Ejecuta un comando' } }];
  const m = contexto.medir([], tools);
  assertOk(m.herramientas > 0, 'debe tener herramientas');
});

test('mide mensaje con tool_calls', () => {
  const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'run_command' } }] }];
  const m = contexto.medir(messages, []);
  assertOk(m.caracteres > 0, 'debe tener caracteres');
});

test('recortarMensajes no deja el envío sin la petición del usuario (turno largo)', () => {
  /* Un turno con UN mensaje de usuario y muchos pasos con herramientas supera el tope:
     el recorte quitaba bloques hasta dejar SOLO el prompt del sistema, así que el
     modelo recibía la conversación sin la pregunta. */
  const grande = 'x'.repeat(4000);
  const mensajes = [
    { role: 'system', content: 'SISTEMA' },
    { role: 'user', content: 'Petición del usuario' },
  ];
  for (let i = 0; i < 10; i++) {
    mensajes.push({ role: 'assistant', content: grande + ' paso ' + i });
    mensajes.push({ role: 'tool', content: grande + ' resultado ' + i });
  }
  const r = contexto.recortarMensajes(mensajes, [], { model: 'x', contextWindow: 8000, maxTokens: 4096 });
  assertOk(
    r.messages.some((m) => String(m.content).includes('Petición del usuario')),
    'la petición del usuario no puede desaparecer del envío: quedaron ' + r.messages.length + ' mensaje(s)',
  );
});

test('recortarMensajes suelta turnos antiguos y conserva el turno en curso', () => {
  const grande = 'x'.repeat(4000);
  const mensajes = [{ role: 'system', content: 'SISTEMA' }];
  for (let t = 1; t <= 6; t++) {
    mensajes.push({ role: 'user', content: 'petición ' + t }, { role: 'assistant', content: grande }, { role: 'tool', content: grande });
  }
  const r = contexto.recortarMensajes(mensajes, [], { model: 'x', contextWindow: 8000, maxTokens: 4096 });
  assertOk(r.quitados > 0, 'con ese tamaño tiene que soltar bloques: ' + JSON.stringify(r.messages.map((m) => m.role)));
  assertEqual(r.messages[0].role, 'system', 'el sistema sigue primero:');
  assertEqual(r.messages[1].role, 'user', 'el envío continúa por una petición del usuario (no por una respuesta):');
  assertOk(
    r.messages.some((m) => m.role === 'user' && String(m.content) === 'petición 6'),
    'el turno en curso viaja entero: ' + JSON.stringify(r.messages.filter((m) => m.role === 'user').map((m) => m.content)),
  );
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
