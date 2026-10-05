'use strict';

/* Tests para agent/habits.js — perfil de hábitos del usuario.
   AÍSLAN el almacén en un archivo temporal: nunca tocan los hábitos reales.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const fs = require('fs');
const os = require('os');

const habits = require(path.join(__dirname, '..', '..', 'agent', 'habits.js'));

const { _resetForTests, MAX_ENTRIES, FORGET_DAYS } = habits.__test;

const TMP = path.join(os.tmpdir(), 'sagitari-test-habits-' + process.pid + '-' + Date.now() + '.json');
_resetForTests(TMP);

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

function limpiar() {
  for (const f of [TMP, TMP + '.bak']) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  _resetForTests(TMP);
}

console.log('habits.js — almacén vacío');

test('stats de un almacén vacío trae las listas vacías', () => {
  limpiar();
  const s = habits.stats();
  assertOk(s && typeof s === 'object', 'debe devolver un objeto');
  assertOk(Array.isArray(s.tools), 'tools debe ser una lista');
  assertEqual(s.tools.length, 0);
});

test('profile de un almacén vacío no inventa nada', () => {
  limpiar();
  const p = habits.profile();
  assertOk(typeof p === 'string', 'debe devolver una cadena');
});

console.log('habits.js — observe');

test('registra el uso de una herramienta', () => {
  limpiar();
  habits.observe('tool', { name: 'run_command' });
  const s = habits.stats();
  assertOk(
    s.tools.some((t) => t.name === 'run_command'),
    'debe aparecer run_command',
  );
});

test('cuenta las repeticiones', () => {
  limpiar();
  habits.observe('tool', { name: 'run_command' });
  habits.observe('tool', { name: 'run_command' });
  const s = habits.stats();
  const t = s.tools.find((x) => x.name === 'run_command');
  assertEqual(t.count, 2);
});

test('el perfil menciona una herramienta ya repetida', () => {
  limpiar();
  // Un hábito empieza a contar a partir de la SEGUNDA vez (MIN_COUNT).
  habits.observe('tool', { name: 'edit_file' });
  habits.observe('tool', { name: 'edit_file' });
  assertOk(habits.profile().includes('edit_file'), 'el perfil debe mencionarla');
});

test('una sola vez no basta para ser un hábito', () => {
  limpiar();
  habits.observe('tool', { name: 'edit_file' });
  assertOk(!habits.profile().includes('edit_file'), 'una vez no debería contar como hábito');
});

test('registra la carpeta que se lista', () => {
  limpiar();
  habits.observe('tool', { name: 'list_dir', args: { path: 'C:\\proyecto\\src' } });
  const s = habits.stats();
  assertOk(
    s.folders.some((f) => f.name === 'C:\\proyecto\\src'),
    'debe registrar la carpeta listada, no su padre: ' + JSON.stringify(s.folders),
  );
});

test('registra la carpeta que CONTIENE un archivo leído', () => {
  limpiar();
  habits.observe('tool', { name: 'read_file', args: { path: 'C:\\proyecto\\src\\index.js' } });
  const s = habits.stats();
  assertOk(
    s.folders.some((f) => f.name === 'C:\\proyecto\\src'),
    'debe registrar la carpeta contenedora: ' + JSON.stringify(s.folders),
  );
});

test('registra un comando frecuente', () => {
  limpiar();
  habits.observe('tool', { name: 'run_command', args: { command: 'git status' } });
  const s = habits.stats();
  assertOk(
    s.commands.some((c) => c.name === 'git'),
    'debe registrar git, no la línea entera: ' + JSON.stringify(s.commands),
  );
});

test('ignora un tipo de evento desconocido sin reventar', () => {
  limpiar();
  habits.observe('tipo_inventado', { name: 'x' });
  assertOk(true, 'no debe lanzar');
});

test('reset deja el almacén vacío', () => {
  limpiar();
  habits.observe('tool', { name: 'run_command' });
  habits.reset();
  const s = habits.stats();
  assertEqual(s.tools.length, 0);
});

console.log('habits.js — constantes');

test('MAX_ENTRIES y FORGET_DAYS son números positivos', () => {
  assertOk(typeof MAX_ENTRIES === 'number' && MAX_ENTRIES > 0, 'MAX_ENTRIES');
  assertOk(typeof FORGET_DAYS === 'number' && FORGET_DAYS > 0, 'FORGET_DAYS');
});

// limpieza final
limpiar();

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
