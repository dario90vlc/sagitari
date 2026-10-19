'use strict';

/* Tests para main/traza.js — rastro compacto del turno.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const traza = require(path.join(__dirname, '..', '..', 'main', 'traza.js'));

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

console.log('traza.js — clipTraza');

test('no recorta un texto corto', () => {
  assertEqual(traza.clipTraza('hola', 100), 'hola');
});

test('recorta un texto largo y avisa de cuánto falta', () => {
  const r = traza.clipTraza('x'.repeat(50), 10);
  assertOk(r.startsWith('x'.repeat(10)), 'debe empezar por el texto recortado');
  assertOk(r.includes('recortado'), 'debe avisar del recorte');
  assertOk(r.includes('40'), 'debe decir cuántos caracteres faltan');
});

test('maneja null', () => {
  assertEqual(traza.clipTraza(null, 10), '');
});

test('maneja undefined', () => {
  assertEqual(traza.clipTraza(undefined, 10), '');
});

console.log('traza.js — argsTraza');

test('devuelve un objeto para argumentos simples', () => {
  const a = traza.argsTraza({ a: 1, b: 'dos' });
  assertOk(a && typeof a === 'object', 'debe ser un objeto');
});

test('maneja argumentos nulos', () => {
  const a = traza.argsTraza(null);
  assertOk(a === null || typeof a === 'object', 'debe tolerar null');
});

console.log('traza.js — ciclo de vida');

test('trazaNueva deja un rastro vacío listo para usar', () => {
  traza.trazaNueva();
  const t = traza.trazaActual();
  assertOk(t, 'debe haber un rastro actual');
  assertOk(Array.isArray(t.tools), 'debe tener una lista de herramientas');
  assertEqual(t.tools.length, 0, 'recién creado no debe tener herramientas');
});

test('trazaApunta y trazaCerrar son funciones', () => {
  assertOk(typeof traza.trazaApunta === 'function', 'trazaApunta');
  assertOk(typeof traza.trazaCerrar === 'function', 'trazaCerrar');
  assertOk(typeof traza.trazaActual === 'function', 'trazaActual');
});

test('apuntar una herramienta no revienta', () => {
  traza.trazaNueva();
  traza.trazaApunta(null, { name: 'run_command', args: { command: 'echo hola' }, ok: true, ms: 12 });
  assertOk(true, 'no debe lanzar');
});

test('MAX_TRAZA es un número positivo', () => {
  assertOk(typeof traza.MAX_TRAZA === 'number' && traza.MAX_TRAZA > 0, 'MAX_TRAZA');
});

console.log('traza.js — redacción de secretos en el rastro guardado');

/* El rastro se persiste en conversations.json, así que lo que un `run_command` imprima
   no puede quedar en claro: misma máscara que el log (runlog.js), no una copia. */
test('el resultado de una herramienta no guarda una cabecera Authorization', () => {
  traza.trazaNueva('secretos-1');
  traza.trazaApunta('secretos-1', { type: 'tool', name: 'run_command', args: { command: 'curl https://api' } });
  traza.trazaApunta('secretos-1', { type: 'tool_result', name: 'run_command', ok: true, durationMs: 5, result: 'Authorization: Bearer abcdef1234567890' });
  const r = traza.trazaActual('secretos-1').tools[0].result;
  assertOk(!r.includes('abcdef1234567890'), 'el token no puede guardarse: ' + r);
  assertOk(r.includes('[REDACTED]'), 'debe quedar la marca de redacción: ' + r);
});

test('el resultado no guarda una variable de entorno con clave ni un JWT', () => {
  traza.trazaNueva('secretos-2');
  traza.trazaApunta('secretos-2', { type: 'tool', name: 'run_command', args: { command: 'set' } });
  traza.trazaApunta('secretos-2', {
    type: 'tool_result',
    name: 'run_command',
    ok: true,
    durationMs: 5,
    result: 'API_KEY=sk-live1234567890abcdef\ntoken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd1234',
  });
  const r = traza.trazaActual('secretos-2').tools[0].result;
  assertOk(!r.includes('sk-live1234567890abcdef'), 'la clave no puede guardarse: ' + r);
  assertOk(!r.includes('eyJhbGciOiJIUzI1NiJ9'), 'el JWT no puede guardarse: ' + r);
});

test('el razonamiento guardado también va redactado', () => {
  traza.trazaNueva('secretos-3');
  traza.trazaApunta('secretos-3', { type: 'thinking_done', text: 'uso la clave sk-live1234567890abcdef para el curl', durationMs: 3 });
  const r = traza.trazaActual('secretos-3').think.text;
  assertOk(!r.includes('sk-live1234567890abcdef'), 'el razonamiento no puede guardar la clave: ' + r);
  assertOk(r.includes('[REDACTED]'), 'debe quedar la marca de redacción: ' + r);
});

test('un texto normal llega igual al historial', () => {
  const texto = 'carpeta /home/usuario/proyecto lista\nsalida normal sin secretos: 42 filas';
  traza.trazaNueva('secretos-4');
  traza.trazaApunta('secretos-4', { type: 'tool', name: 'run_command', args: { command: 'ls -la /home/usuario/proyecto' } });
  traza.trazaApunta('secretos-4', { type: 'tool_result', name: 'run_command', ok: true, durationMs: 5, result: texto });
  const t = traza.trazaActual('secretos-4').tools[0];
  assertEqual(t.result, texto, 'un texto sin secretos no se toca');
  assertEqual(t.args.command, 'ls -la /home/usuario/proyecto', 'un comando normal no se toca');
});

test('los argumentos con un secreto tampoco se guardan en claro', () => {
  traza.trazaNueva('secretos-5');
  traza.trazaApunta('secretos-5', { type: 'tool', name: 'run_command', args: { command: 'curl -H "Authorization: Bearer abcdef1234567890" https://api' } });
  const r = traza.trazaActual('secretos-5').tools[0].args.command;
  assertOk(!r.includes('abcdef1234567890'), 'el argumento no puede guardar el token: ' + r);
});

test('un resultado vacío no se convierte en el texto "undefined"', () => {
  traza.trazaNueva('secretos-6');
  traza.trazaApunta('secretos-6', { type: 'tool', name: 'run_command', args: {} });
  traza.trazaApunta('secretos-6', { type: 'tool_result', name: 'run_command', ok: true, durationMs: 1 });
  assertEqual(traza.trazaActual('secretos-6').tools[0].result, '', 'sin resultado debe quedar vacío');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
