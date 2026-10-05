'use strict';

/* Tests para agent/checkpoints.js — checkpoints de una ejecución del agente.
   AÍSLAN el almacén en una carpeta temporal: nunca tocan los checkpoints reales.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const fs = require('fs');
const os = require('os');

const cp = require(path.join(__dirname, '..', '..', 'agent', 'checkpoints.js'));

const { _resetForTests, ALL_STATUS, LIVE_STATUS, ARCHIVED_STATUS } = cp.__test;

const TMP = path.join(os.tmpdir(), 'sagitari-test-cp-' + process.pid + '-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
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
  try {
    for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
  } catch {}
  _resetForTests(TMP);
}

console.log('checkpoints.js — estados');

test('ALL_STATUS incluye los estados vivos y archivados', () => {
  assertOk(Array.isArray(ALL_STATUS) && ALL_STATUS.length > 0, 'ALL_STATUS');
  for (const s of LIVE_STATUS) assertOk(ALL_STATUS.includes(s), 'falta ' + s);
  for (const s of ARCHIVED_STATUS) assertOk(ALL_STATUS.includes(s), 'falta ' + s);
});

test('«running» es un estado vivo', () => {
  assertOk(LIVE_STATUS.includes('running'), 'running debe estar vivo');
});

console.log('checkpoints.js — newRun');

test('crea una ejecución con objetivo', () => {
  limpiar();
  const r = cp.newRun({ goal: 'arreglar el bug' });
  assertOk(r, 'debe devolver la ejecución');
  assertEqual(r.goal, 'arreglar el bug');
  assertEqual(r.status, 'running');
});

test('la ejecución nace con identificador', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  assertOk(r.runId, 'debe tener runId');
});

test('dos ejecuciones no comparten identificador', () => {
  limpiar();
  assertOk(cp.newRun({ goal: 'a' }).runId !== cp.newRun({ goal: 'b' }).runId, 'los id deben diferir');
});

console.log('checkpoints.js — persistencia');

test('guarda y vuelve a leer la ejecución', () => {
  limpiar();
  const r = cp.newRun({ goal: 'mi tarea' });
  cp.save(r);
  const leido = cp.read(r.runId);
  assertOk(leido, 'debe poder leerse');
  assertEqual(leido.goal, 'mi tarea');
});

test('list devuelve las ejecuciones guardadas', () => {
  limpiar();
  const r = cp.newRun({ goal: 'listada' });
  cp.save(r);
  const l = cp.list();
  assertOk(Array.isArray(l), 'debe ser una lista');
  assertOk(
    l.some((x) => x && x.runId === r.runId),
    'debe aparecer la ejecución guardada: ' + JSON.stringify(l).slice(0, 200),
  );
});

test('read de un id inexistente no revienta', () => {
  limpiar();
  const r = cp.read('no-existe');
  assertOk(r === null || r === undefined || typeof r === 'object', 'debe tolerarlo');
});

console.log('checkpoints.js — ciclo de vida');

test('complete marca la ejecución como terminada', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.complete(r, { ok: true });
  assertOk(ARCHIVED_STATUS.includes(r.status), 'debe quedar archivada, no ' + r.status);
});

test('fail marca la ejecución como fallida', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.fail(r, { error: 'algo petó' });
  assertOk(ARCHIVED_STATUS.includes(r.status), 'debe quedar archivada, no ' + r.status);
});

test('pause y resume devuelven la ejecución a su estado', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.pause(r);
  const pausada = r.status;
  cp.resume(r);
  assertOk(pausada !== r.status, 'resume debe cambiar el estado');
});

test('setStep apunta el paso actual', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.setStep(r, 'VERIFY');
  assertEqual(r.step, 'VERIFY');
});

test('recoverable devuelve una lista', () => {
  limpiar();
  const r = cp.recoverable();
  assertOk(Array.isArray(r), 'debe ser una lista');
});

console.log('checkpoints.js — remove');

test('no deja borrar una tarea que sigue viva', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.save(r);
  const res = cp.remove(r.runId);
  assertEqual(res.ok, false, 'debe negarse mientras corre');
});

test('remove borra una tarea ya terminada', () => {
  limpiar();
  const r = cp.newRun({ goal: 'g' });
  cp.complete(r, { ok: true });
  cp.remove(r.runId);
  const l = cp.list();
  assertOk(!l.some((x) => x && x.runId === r.runId), 'no debe seguir en la lista');
});

// limpieza final
try {
  for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
  fs.rmdirSync(TMP);
} catch {}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
