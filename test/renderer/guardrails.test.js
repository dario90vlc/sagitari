'use strict';

/* Tests para agent/guardrails.js — funciones puras de guardrails y permisos.
   Sin spawn: se ejecuta directo con node. */

const os = require('os');
const path = require('path');
const guardrails = require(path.join(__dirname, '..', '..', 'agent', 'guardrails.js'));

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

console.log('guardrails.js — pricingFor');

test('devuelve pricing para gpt-5', () => {
  const p = guardrails.pricingFor('gpt-5', null);
  assertEqual(p.in, 1.25);
  assertEqual(p.out, 10);
});

test('devuelve pricing para claude-sonnet', () => {
  const p = guardrails.pricingFor('claude-sonnet', null);
  assertEqual(p.in, 3);
  assertEqual(p.out, 15);
});

test('devuelve pricing default para modelo desconocido', () => {
  const p = guardrails.pricingFor('modelo-desconocido', null);
  assertEqual(p.in, 1);
  assertEqual(p.out, 3);
});

test('el override del usuario gana', () => {
  const p = guardrails.pricingFor('gpt-5', { in: 5, out: 50 });
  assertEqual(p.in, 5);
  assertEqual(p.out, 50);
});

test('maneja modelo null/undefined', () => {
  const p = guardrails.pricingFor(null, null);
  assertEqual(p.in, 1);
  assertEqual(p.out, 3);
});

console.log('guardrails.js — summarizeArgs');

test('resume argumentos de run_command', () => {
  const s = guardrails.summarizeArgs('run_command', { command: 'dir /b' });
  assertEqual(s, 'dir /b');
});

test('resume argumentos de write_file', () => {
  const s = guardrails.summarizeArgs('write_file', { path: 'C:\\test.txt' });
  assertEqual(s, 'C:\\test.txt');
});

test('resume argumentos de browser_control', () => {
  const s = guardrails.summarizeArgs('browser_control', { action: 'navigate', url: 'https://example.com' });
  assertOk(s.includes('navigate'), 'debe incluir action');
  assertOk(s.includes('https://example.com'), 'debe incluir url');
});

test('resume argumentos de open_app', () => {
  const s = guardrails.summarizeArgs('open_app', { name: 'notepad' });
  assertEqual(s, 'notepad');
});

test('resume argumentos de open_url', () => {
  const s = guardrails.summarizeArgs('open_url', { url: 'https://example.com' });
  assertEqual(s, 'https://example.com');
});

test('resume argumentos de clipboard', () => {
  const s = guardrails.summarizeArgs('clipboard', { action: 'write' });
  assertEqual(s, 'escribir en el portapapeles');
});

test('resume argumentos de window_manage', () => {
  const s = guardrails.summarizeArgs('window_manage', { action: 'minimize' });
  assertEqual(s, 'minimize');
});

test('resume argumentos de herramienta desconocida', () => {
  const s = guardrails.summarizeArgs('herramienta-desconocida', { foo: 'bar' });
  assertOk(s.includes('foo'), 'debe incluir las claves');
});

test('maneja argumentos vacíos', () => {
  const s = guardrails.summarizeArgs('run_command', {});
  assertEqual(s, '');
});

test('maneja argumentos null', () => {
  const s = guardrails.summarizeArgs('run_command', null);
  assertEqual(s, '');
});

console.log('guardrails.js — «aceptar todos los cambios» solo abarata el PROYECTO');

/* Lo prometido por el ajuste son los archivos del espacio de trabajo. Una ruta que cae
   fuera (o que no se puede resolver) tiene que seguir pidiendo confirmación: la tarjeta
   es el único sitio donde el usuario ve el destino real. */
const WS_PRUEBA = path.join(os.tmpdir(), 'sagi-guardrails-ws');

test('abarata una escritura relativa dentro del espacio de trabajo', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const d = g.decide('write_file', { path: 'informes/2026.md', content: 'x' }, { workspace: WS_PRUEBA });
  assertEqual(d.action, 'allow');
});

test('abarata una edición con ruta absoluta dentro del espacio de trabajo', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const d = g.decide('edit_file', { path: path.join(WS_PRUEBA, 'src', 'x.js') }, { workspace: WS_PRUEBA });
  assertEqual(d.action, 'allow');
});

test('una ruta absoluta FUERA del espacio de trabajo sigue pidiendo confirmación', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const fuera = path.join(os.tmpdir(), 'otra-carpeta', 'notas.md');
  const d = g.decide('write_file', { path: fuera, content: 'x' }, { workspace: WS_PRUEBA });
  assertEqual(d.action, 'confirm', 'el ajuste es del proyecto, no del disco entero');
});

test('una carpeta VECINA que empieza igual tampoco se abarata', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const vecina = path.join(WS_PRUEBA + '-viejo', 'a.md');
  const d = g.decide('write_file', { path: vecina, content: 'x' }, { workspace: WS_PRUEBA });
  assertEqual(d.action, 'confirm', 'la comparación es por carpeta, no por prefijo de texto');
});

test('una huida con «..» tampoco se abarata', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const d = g.decide('write_file', { path: path.join('..', 'fuera.md'), content: 'x' }, { workspace: path.join(WS_PRUEBA, 'sub') });
  assertEqual(d.action, 'confirm');
});

test('sin espacio de trabajo no se abarata nada', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const d = g.decide('write_file', { path: 'a.md', content: 'x' });
  assertEqual(d.action, 'confirm', 'sin saber dónde está el proyecto, se pregunta');
});

test('apply_patch se abarata solo si TODOS sus cambios son del proyecto', () => {
  const g = new guardrails.Guardrails({ autoEdits: true });
  const dentro = { changes: [{ path: 'a.js', old_string: 'a', new_string: 'b' }] };
  assertEqual(g.decide('apply_patch', dentro, { workspace: WS_PRUEBA }).action, 'allow');
  const mixto = {
    changes: [
      { path: 'a.js', old_string: 'a', new_string: 'b' },
      { path: path.join(os.tmpdir(), 'fuera.js'), old_string: 'a', new_string: 'b' },
    ],
  };
  assertEqual(g.decide('apply_patch', mixto, { workspace: WS_PRUEBA }).action, 'confirm', 'basta un cambio de fuera');
});

test('con el ajuste apagado nada se abarata', () => {
  const g = new guardrails.Guardrails({});
  const d = g.decide('write_file', { path: 'a.md', content: 'x' }, { workspace: WS_PRUEBA });
  assertEqual(d.action, 'confirm');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
