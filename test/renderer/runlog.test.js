'use strict';

/* Tests para agent/runlog.js — redacción de secretos en el registro de ejecución.
   Sin spawn: se ejecuta directo con node. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const runlog = require(path.join(__dirname, '..', '..', 'agent', 'runlog.js'));

let passed = 0;
let failed = 0;
const pendientes = []; // tests que tocan disco (el fichero se abre de forma asíncrona)

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

/** Igual que `test` pero asíncrono. NO arranca al registrarse: los tests de disco comparten
    el estado del módulo (LOG_DIR, el stream), así que se ejecutan en serie al final. */
function testAsync(name, fn) {
  pendientes.push({ name, fn });
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('runlog.js — redactToolArgs');

test('redacta apiKey', () => {
  const r = runlog.redactToolArgs('run_command', { apiKey: 'sk-1234567890abcdef' });
  assertEqual(r.apiKey, '[REDACTED]');
});

test('redacta password', () => {
  const r = runlog.redactToolArgs('run_command', { password: 'secreto' });
  assertEqual(r.password, '[REDACTED]');
});

test('redacta token', () => {
  const r = runlog.redactToolArgs('run_command', { token: 'abc123' });
  assertEqual(r.token, '[REDACTED]');
});

test('conserva los campos inocentes', () => {
  const r = runlog.redactToolArgs('run_command', { command: 'echo hola', path: 'C:/x' });
  assertEqual(r.command, 'echo hola');
  assertEqual(r.path, 'C:/x');
});

test('devuelve la entrada tal cual si no es objeto', () => {
  assertEqual(runlog.redactToolArgs('x', null), null);
  assertEqual(runlog.redactToolArgs('x', 'texto'), 'texto');
});

test('no muta el objeto original', () => {
  const args = { apiKey: 'sk-1234567890abcdef' };
  runlog.redactToolArgs('run_command', args);
  assertEqual(args.apiKey, 'sk-1234567890abcdef', 'el original no debe cambiar');
});

console.log('runlog.js — redactEvent');

test('redacta los args del evento', () => {
  const r = runlog.redactEvent({ tool: 'run_command', args: { apiKey: 'sk-abcdefghijklmnop' } });
  assertEqual(r.args.apiKey, '[REDACTED]');
});

test('redacta secretos dentro del mensaje de error', () => {
  const r = runlog.redactEvent({ tool: 'x', error: 'fallo con apiKey sk-abcdefghijklmnop' });
  assertOk(!r.error.includes('sk-abcdefghijklmnop'), 'el secreto no debe sobrevivir');
});

test('conserva los campos inocentes del evento', () => {
  const r = runlog.redactEvent({ tool: 'run_command', step: 3 });
  assertEqual(r.tool, 'run_command');
  assertEqual(r.step, 3);
});

test('devuelve la entrada tal cual si no es objeto', () => {
  assertEqual(runlog.redactEvent(null), null);
});

console.log('runlog.js — estructura');

test('LOG_DIR está definido', () => {
  assertOk(runlog.LOG_DIR, 'debe estar definido');
});

test('log, readRecent, currentLogFile y close son funciones', () => {
  assertOk(typeof runlog.log === 'function', 'log');
  assertOk(typeof runlog.readRecent === 'function', 'readRecent');
  assertOk(typeof runlog.currentLogFile === 'function', 'currentLogFile');
  assertOk(typeof runlog.close === 'function', 'close');
});

console.log('runlog.js — el fichero no guarda texto entero (ninguna clave se libra)');

/* El registro en disco no puede ser un vertedero: el texto COMPLETO de una edición
   (`old_string`/`new_string` de edit_file y de apply_patch) duplicaba el fichero en cada
   línea. Se mide donde se ve de verdad: en el .jsonl. */
/* Windows: el `.jsonl` lo mantiene abierto el stream del log hasta que el sistema suelta
   el descriptor, y eso ocurre DESPUÉS de `close()`, que solo pide el cierre. Borrar la
   carpeta sin esperar falla con ENOTEMPTY y el error salía como si el test no midiera lo
   que dice medir (era el fallo intermitente de esta suite en la CI: depende de cuándo
   suelte el descriptor). Se reintenta hasta que se suelte. */
async function borrarCuandoSeLibre(dir) {
  for (let i = 0; i < 100; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (e.code !== 'ENOTEMPTY' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true }); // último intento: si falla, que se vea
}

async function conLog(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-runlog-'));
  runlog.__test._resetForTests({ dir });
  try {
    fn();
    runlog.close(); // el fichero se abre de forma asíncrona: hay que dejarle abrirlo
    for (let i = 0; i < 100; i++) {
      const hay = fs.readdirSync(dir).some((f) => f.endsWith('.jsonl') && fs.statSync(path.join(dir, f)).size > 0);
      if (hay) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return runlog.readRecent(50);
  } finally {
    runlog.close();
    runlog.__test._resetForTests({});
    await borrarCuandoSeLibre(dir);
  }
}

testAsync('old_string/new_string de edit_file no llegan enteros al fichero', async () => {
  const largo = 'x'.repeat(900);
  const evs = await conLog(() =>
    runlog.log({ agent: 'sagitari', event: 'tool', tool: 'edit_file', args: { path: 'config.js', old_string: largo, new_string: largo } }),
  );
  const args = evs[evs.length - 1].args;
  assertOk(String(args.old_string).length < 400, 'se recorta: ' + String(args.old_string).length);
  assertOk(/truncado/.test(String(args.new_string)), 'y se dice que se recortó');
});

testAsync('el tope vale para una clave que nadie ha listado', async () => {
  const evs = await conLog(() =>
    runlog.log({ agent: 'sagitari', event: 'tool', tool: 'herramienta_nueva', args: { campo_jamas_visto: 'y'.repeat(900) } }),
  );
  assertOk(String(evs[evs.length - 1].args.campo_jamas_visto).length < 400, 'no depende de recordar la clave');
});

testAsync('el tope llega también a las claves anidadas de apply_patch', async () => {
  const evs = await conLog(() =>
    runlog.log({
      agent: 'sagitari',
      event: 'tool',
      tool: 'apply_patch',
      args: { changes: [{ path: 'a.js', old_string: 'z'.repeat(900), new_string: 'nuevo' }] },
    }),
  );
  const c = evs[evs.length - 1].args.changes[0];
  assertOk(String(c.old_string).length < 400, 'los cambios anidados se recortan igual');
  assertEqual(c.new_string, 'nuevo', 'lo corto se conserva tal cual');
});

testAsync('los secretos siguen fuera aunque la cadena sea corta', async () => {
  const evs = await conLog(() =>
    runlog.log({ agent: 'sagitari', event: 'tool', tool: 'herramienta_nueva', args: { campo_jamas_visto: 'api sk-ABCDEFGHIJKLMNOP' } }),
  );
  assertOk(!/sk-ABCDEF/.test(String(evs[evs.length - 1].args.campo_jamas_visto)), 'el filtro de patrones no depende de la clave');
});

test('el recorte por lista de claves sigue intacto para quien reutiliza redactToolArgs', () => {
  const largo = 'w'.repeat(900);
  const r = runlog.redactToolArgs('write_file', { path: 'a.txt', content: largo });
  assertOk(String(r.content).endsWith('…[truncado]'), 'content se recorta sin pasar por el fichero');
  assertEqual(runlog.redactToolArgs('write_file', { path: 'a.txt' }).path, 'a.txt', 'lo corto se queda igual');
});

/* El resumen espera a los tests de disco (en serie: comparten el almacén del módulo) y
   luego termina el proceso: el runner del renderer espera la promesa exportada. */
module.exports = (async () => {
  for (const t of pendientes) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(`       ${e.message}`);
    }
  }
  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
})();
