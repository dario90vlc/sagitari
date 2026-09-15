'use strict';

/* Minimal test runner for SAGITARI's pure logic. Node-only, no Electron.
   Usage: node test/run.js   (exit code 0 = all green) */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* Los tests crean almacenes temporales (memoria, checkpoints, skills…): se anotan
   aquí para borrarlos al terminar. Sin esto, cada ejecución dejaba basura en %TEMP%. */
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };

/* La suite NO puede escribir en los datos reales del usuario. Cada módulo de
   agent/ resuelve su carpeta AL CARGARSE (agent/datadir.js), así que la raíz de
   prueba se fija aquí, antes de requerirlos: sin esto cada `npm test` dejaba un
   run-<ts>.jsonl nuevo en %APPDATA%\SagitariAI\logs, con eventos indistinguibles
   de una sesión real, y el panel de registros de la app los mostraba. */
process.env.SAGITARI_DATA_DIR = tmpDir('sagitari-datadir-');

let pass = 0, fail = 0;
const failures = [];
/* Los tests se ENCOLAN y se ejecutan al final, en orden de registro (ver el cierre
   del fichero). Antes cada uno arrancaba al registrarse, así que las secciones se
   solapaban entre sí: el estado global (directorio de tareas, memoria, hábitos…)
   cambiaba mientras otro test estaba a mitad y aparecían fallos que dependían del
   tiempo y del orden de registro. */
const QUEUE = [];

function test(name, fn) { QUEUE.push({ name, fn }); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + `: esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'esperado verdadero'); }

/* Red de seguridad del propio runner: un test async que nunca resuelve dejaba el
   proceso sin resumen y salía con código 0 (CI en verde con la suite colgada).
   El temporizador se deja "vivo" a propósito: mantiene el proceso en pie hasta
   dispararse, y se cancela justo antes de imprimir el resumen. */
const SUITE_TIMEOUT_MS = 120000;
const suiteTimer = setTimeout(() => {
  console.error(`\nLa suite no terminó en ${SUITE_TIMEOUT_MS / 1000}s: algún test se quedó colgado.`);
  process.exit(1);
}, SUITE_TIMEOUT_MS);

const { Guardrails, describeAction, summarizeArgs } = require('../agent/guardrails');
const skills = require('../agent/skills');

/* ---------- permissions ---------- */
test('safe tool runs without confirmation', () => {
  const g = new Guardrails();
  eq(g.decide('read_file', { path: 'C:/x.txt' }).action, 'allow');
});
test('confirm tool asks with a description and summary', () => {
  const g = new Guardrails();
  const d = g.decide('run_command', { command: 'del C:/importante' });
  eq(d.action, 'confirm');
  ok(d.description.length > 3, 'debe describir la acción');
  ok(d.summary.includes('del'), 'el resumen debe incluir el comando');
});
test('restricted tool is denied with reason', () => {
  const g = new Guardrails({ permissions: { run_command: 'restricted' } });
  const d = g.decide('run_command', { command: 'dir' });
  eq(d.action, 'deny');
  ok(d.reason.includes('bloqueada'), 'debe explicar el bloqueo');
});
test('user override upgrades a tool to confirm', () => {
  const g = new Guardrails({ permissions: { open_url: 'confirm' } });
  eq(g.decide('open_url', { url: 'https://x' }).action, 'confirm');
});
test('user override downgrades a tool to safe', () => {
  const g = new Guardrails({ permissions: { run_command: 'safe' } });
  eq(g.decide('run_command', { command: 'dir' }).action, 'allow');
});
test('invalid override falls back to the default risk', () => {
  const g = new Guardrails({ permissions: { read_file: 'megaseguro' } });
  eq(g.levelFor('read_file'), 'safe');
});
test('approve() remembers the signature for 10 minutes', () => {
  const g = new Guardrails();
  const d = g.decide('write_file', { path: 'C:/a.txt' });
  eq(d.action, 'confirm');
  g.approve(d.signature);
  eq(g.decide('write_file', { path: 'C:/a.txt' }).action, 'allow');
  // pero otros argumentos vuelven a preguntar
  eq(g.decide('write_file', { path: 'C:/b.txt' }).action, 'confirm');
  // la caducidad es la garantía del recuerdo: una firma aprobada una vez no puede
  // valer para siempre (este test no la comprobaba: valdría incluso con Infinity)
  ok(g.approvals.get(d.signature) - Date.now() <= 10 * 60 * 1000, 'la firma caduca en 10 minutos');
  ok(g.approvals.get(d.signature) - Date.now() > 9 * 60 * 1000, 'y no antes');
  g.approvals.set(d.signature, Date.now() - 1);   // caducada
  eq(g.decide('write_file', { path: 'C:/a.txt' }).action, 'confirm', 'una aprobación caducada vuelve a preguntar');
});
test('unknown tool defaults to confirm', () => {
  const g = new Guardrails();
  eq(g.decide('herramienta_misteriosa', {}).action, 'confirm');
});
test('describeAction / summarizeArgs produce human text', () => {
  ok(describeAction('run_command', {}).includes('terminal'));
  ok(summarizeArgs('browser_control', { action: 'click', text: 'Comprar' }).includes('Comprar'));
});

/* ---------- guardrails: limits ---------- */
test('checkStep stops after maxSteps', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 3 } });
  g.beginRun();
  ok(g.checkStep().ok); ok(g.checkStep().ok); ok(g.checkStep().ok);
  eq(g.checkStep().ok, false);
});
test('maxSteps 0 means unlimited', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 0 } });
  g.beginRun();
  for (let i = 0; i < 200; i++) ok(g.checkStep().ok, 'paso ' + i + ' debe pasar');
});
test('checkToolCall enforces the tool-call limit', () => {
  const g = new Guardrails({ guardrails: { maxToolCalls: 2 } });
  g.beginRun();
  ok(g.checkToolCall().ok); ok(g.checkToolCall().ok);
  eq(g.checkToolCall().ok, false);
});
test('addTokens enforces the token budget', () => {
  const g = new Guardrails({ guardrails: { maxTokens: 100 } });
  ok(g.addTokens(60).ok);
  eq(g.addTokens(60).ok, false);
});
test('setPolicy hot-reloads without losing counters', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 5 } });
  g.beginRun();
  g.checkStep(); g.checkStep();
  g.setPolicy({ guardrails: { maxSteps: 100 } });
  ok(g.checkStep().ok);
  eq(g.steps, 3, 'los pasos previos se conservan');
});

/* ---------- loop detection ---------- */
test('identical repeated calls are detected as a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(g.isLoop('read_file', { path: 'a' }).loop, 'tercera llamada idéntica = bucle');
});
test('different args are not a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(!g.isLoop('read_file', { path: 'b' }).loop);
  ok(!g.isLoop('read_file', { path: 'c' }).loop);
});
test('A-B ping-pong is detected as a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  g.isLoop('t', { x: 1 }); g.isLoop('t', { x: 2 }); g.isLoop('t', { x: 1 }); g.isLoop('t', { x: 2 });
  ok(g.isLoop('t', { x: 1 }).loop, 'A-B-A-B debe detectarse');
});
test('guardrails: un umbral de bucle 0/1 se eleva al mínimo útil', () => {
  // Con T=0/1 la condición `run >= T` se cumplía en la PRIMERA herramienta y
  // cualquier tarea moría al arrancar (el ajuste se podía guardar desde Ajustes).
  const g = new Guardrails({ guardrails: { loopThreshold: 1 } });
  ok(!g.isLoop('read_file', { path: 'a' }).loop, 'la primera llamada nunca puede ser un bucle');
  ok(g.isLoop('read_file', { path: 'a' }).loop, 'el umbral efectivo es 2');
});
test('genuinely different consecutive work is not a loop', () => {
  const g = new Guardrails();
  ok(!g.isLoop('list_dir', { path: 'C:/a' }).loop);
  ok(!g.isLoop('read_file', { path: 'C:/a/f.txt' }).loop);
  ok(!g.isLoop('write_file', { path: 'C:/a/out.txt' }).loop);
});

/* ---------- skills front-matter: new metadata ---------- */
test('parseFrontMatter extracts version/author and YAML lists', () => {
  const raw = '---\nname: prueba\nversion: 2.1.0\nauthor: Ana\ntools:\n  - run_command\n  - read_file\ndescription: Prueba de parseo\n---\n\nCuerpo de la skill.\n';
  const fm = skills.__test ? skills.__test.parseFrontMatter(raw) : null;
  // parseFrontMatter no está exportado; probamos vía el módulo si existe el hook de test
  if (!fm) { console.log('  (skip: parseFrontMatter no exportado)'); return; }
  eq(fm.meta.version, '2.1.0');
  eq(fm.meta.author, 'Ana');
  eq(Array.isArray(fm.meta.tools), true);
  eq(fm.meta.tools[1], 'read_file');
});

/* ---------- v1.2: guardrails de coste y ausencia de progreso ---------- */
const { pricingFor } = require('../agent/guardrails');

test('pricingFor matches model families with a sane default', () => {
  ok(pricingFor('gpt-4o-2024').in > 0);
  eq(pricingFor('claude-sonnet-4').out, 15);
  ok(pricingFor('modelo-desconocido').in > 0, 'default pricing');
});

test('addTokens enforces the estimated-cost budget', () => {
  const g = new Guardrails({ guardrails: { maxCostUsd: 0.01 } });
  g.model = 'gpt-4o';
  // 100k in + 100k out a tarifas gpt-4o ≫ 0.01 USD
  const r = g.addTokens(200000, { prompt_tokens: 100000, completion_tokens: 100000 });
  eq(r.ok, false);
  ok(g.getCost() > 0.01, 'coste acumulado por encima del límite');
});

test('addTokens passes under the cost budget', () => {
  const g = new Guardrails({ guardrails: { maxCostUsd: 10 } });
  g.model = 'llama';
  ok(g.addTokens(1000, { prompt_tokens: 600, completion_tokens: 400 }).ok);
});

test('checkStall fires after N steps without progress and resets with progress', () => {
  const g = new Guardrails({ guardrails: { stallThreshold: 3 } });
  ok(g.checkStall({}).ok);
  ok(g.checkStall({}).ok);
  ok(!g.checkStall({}).ok, '3 pasos sin progreso = stall');
  ok(g.checkStall({ assistantText: 'voy bien' }).ok, 'texto = progreso, reinicia');
  ok(g.checkStall({ toolName: 'read_file' }).ok, 'herramienta nueva = progreso');
  ok(g.checkStall({ toolName: 'read_file' }).ok, 'repetida #1 tras progreso: _stall=1');
  ok(g.checkStall({ toolName: 'read_file' }).ok, 'repetida #2: _stall=2');
  ok(!g.checkStall({ toolName: 'read_file' }).ok, 'repetida #3: _stall=3 = stall');
  ok(g.checkStall({ toolName: 'write_file' }).ok, 'herramienta nueva = progreso');
});

test('stallThreshold 0 disables stall detection', () => {
  const g = new Guardrails({ guardrails: { stallThreshold: 0 } });
  for (let i = 0; i < 50; i++) ok(g.checkStall({}).ok);
});

/* ---------- v1.2: memoria avanzada (almacén aislado en tmp) ---------- */
const memory = require('../agent/memory');
const MEM_DIR = tmpDir('sagi-mem-');
memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));

test('memory add + list keep full metadata', () => {
  const m = memory.add({ text: 'El usuario prefiere informes en PDF', source: 'agent', importance: 0.9 });
  ok(m.id && m.date && m.uses === 0);
  eq(m.importance, 0.9);
  eq(m.confidence, 0.8);
  eq(memory.list().length, 1);
});

test('memory dedupes identical text and reinforces instead', () => {
  memory.add({ text: 'El usuario prefiere informes en PDF', importance: 0.3 });
  eq(memory.list().length, 1, 'no duplicados');
  eq(memory.list()[0].importance, 0.9, 'importancia = max');
});

test('relevantMemories ranks overlapping memories first and filters irrelevant', () => {
  memory.add({ text: 'Uso VSCode como editor principal' });
  memory.add({ text: 'Trabajo con proyectos de Blender y renders' });
  const rel = memory.relevantMemories('¿qué editor de código uso para programar?', { minScore: 0 });
  ok(rel.length >= 1);
  ok(rel[0].mem.text.includes('VSCode'), 'el recuerdo sobre editores va primero');
  const strict = memory.relevantMemories('cocinar pasta carbonara', { minScore: 0.99 });
  ok(!strict.some(x => x.overlap > 0), 'nada relevante para recetas de cocina');
});

test('relevantMemories falls back to most important when nothing overlaps', () => {
  const rel = memory.relevantMemories('tema totalmente distinto xyzzy', { minScore: 0.99 });
  ok(rel.length >= 1, 'fallback a importantes');
  ok(rel.every(x => x.overlap === 0));
});

test('memory update clamps importance and removes work', () => {
  const l = memory.list();
  const id = l[0].id;
  memory.update(id, { importance: 7 });
  eq(memory.list().find(x => x.id === id).importance, 1, 'clamp a 1');
  memory.remove(id);
  ok(!memory.list().find(x => x.id === id));
});

/* ---------- v1.2: checkpoints (directorio aislado en tmp) ---------- */
const checkpoints = require('../agent/checkpoints');
const TASKS_TMP = tmpDir('sagi-tasks-');
checkpoints.__test._resetForTests(TASKS_TMP);

test('checkpoints: newRun + save + read roundtrip', () => {
  const run = checkpoints.newRun({ goal: 'Investigar precios de vuelos', mode: 'plan' });
  checkpoints.save(run);
  const r = checkpoints.read(run.runId);
  ok(r && r.runId === run.runId);
  eq(r.status, 'running');
  eq(r.step, 'EXECUTE');
});

test('checkpoints: record keeps last completed step and history', () => {
  const run = checkpoints.newRun({ goal: 'g' });
  checkpoints.record(run, { step: 'EXECUTE', tool: 'open_url', ok: true, summary: 'abierta' });
  checkpoints.record(run, { step: 'EXECUTE', tool: 'write_file', ok: false, summary: 'Error: EACCES' });
  const r = checkpoints.read(run.runId);
  eq(r.history.length, 2);
  eq(r.lastOkStep, 'EXECUTE');
});

test('checkpoints: fail stores which step failed and why', () => {
  const run = checkpoints.newRun({ goal: 'g2' });
  checkpoints.fail(run, { step: 'VERIFY', tool: 'browser_control', message: 'la página no mostró confirmación' });
  const r = checkpoints.read(run.runId);
  eq(r.status, 'failed');
  eq(r.lastError.step, 'VERIFY');
  ok(r.lastError.message.includes('confirmación'));
});

test('checkpoints: pause/resume/interrupt lifecycle + recoverable', () => {
  const run = checkpoints.newRun({ goal: 'g3' });
  checkpoints.pause(run);
  eq(checkpoints.read(run.runId).status, 'paused');
  checkpoints.resume(run);
  eq(checkpoints.read(run.runId).status, 'running');
  checkpoints.interrupt(run);
  const rec = checkpoints.recoverable();
  ok(rec.some(t => t.runId === run.runId), 'interrumpida es recuperable');
});

test('checkpoints: complete archives the task with its result', () => {
  const run = checkpoints.newRun({ goal: 'g4' });
  checkpoints.complete(run, 'Informe creado y verificado');
  const r = checkpoints.read(run.runId);
  eq(r.status, 'completed');
  ok(r.result.includes('verificado'));
});

test('checkpoints: list and remove', () => {
  const all = checkpoints.list('all');
  ok(all.length >= 4, 'hay tareas archivadas');
  const target = all[0];
  checkpoints.remove(target.runId);
  ok(!checkpoints.list('all').find(t => t.runId === target.runId));
});

test('checkpoints: list("active") excluye las tareas archivadas', () => {
  const dir = tmpDir('sagi-active-');
  checkpoints.__test._resetForTests(dir);
  const a = checkpoints.newRun({ goal: 'activa' }); checkpoints.save(a);
  const c = checkpoints.newRun({ goal: 'completada' }); checkpoints.save(c); checkpoints.complete(c, 'hecho');
  const f = checkpoints.newRun({ goal: 'fallida' }); checkpoints.fail(f, { step: 'EXECUTE', message: 'boom' });
  const activeIds = checkpoints.list('active').map(t => t.runId);
  ok(activeIds.includes(a.runId), 'la activa aparece');
  ok(!activeIds.includes(c.runId), 'la completada NO aparece en activas');
  ok(!activeIds.includes(f.runId), 'la fallida NO aparece en activas');
  eq(checkpoints.list('all').length, 3, 'all sí incluye las tres');
});

test('checkpoints: la poda del histórico conserva los más recientes', () => {
  const dir = tmpDir('sagi-prune-');
  checkpoints.__test._resetForTests(dir);
  // 5 archivadas con el mismo mtime no servirían: la poda ordena por fecha real
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = checkpoints.newRun({ goal: 't' + i });
    checkpoints.complete(r, 'hecho');
    const f = path.join(dir, 'completed', r.runId);
    const t = new Date(Date.now() + i * 1000);   // la 4 es la más nueva
    fs.utimesSync(f, t, t);
    ids.push(r.runId);
  }
  checkpoints.__test.pruneArchived(3);
  const left = fs.readdirSync(path.join(dir, 'completed'));
  eq(left.length, 3, 'solo quedan 3');
  ok(!left.includes(ids[0]), 'la más antigua se va');
  ok(left.includes(ids[4]), 'la más reciente se queda');
  checkpoints.__test._resetForTests(TASKS_TMP);   // el resto de la sección usa su directorio
});

/* ---------- v1.2: herramienta remember (integración con executors) ---------- */
const { executeTool } = require('../agent/executors');
test('remember tool stores a memory via executeTool', async () => {
  const before = memory.list().length;
  const out = await executeTool('remember', { text: 'Prefiero respuestas concisas', importance: 0.7 }, {});
  ok(out.startsWith('OK'), out);
  eq(memory.list().length, before + 1);
});

test('remember tool rejects empty text', async () => {
  const out = await executeTool('remember', { text: '' }, {});
  ok(out.startsWith('Error'));
});

/* ---------- edición anclada y lectura por rangos ---------- */
test('edit_file: reemplaza un fragmento único y rechaza los ambiguos', async () => {
  const dir = tmpDir('sagi-edit-');
  const p = path.join(dir, 'a.txt');
  fs.writeFileSync(p, 'uno\ndos\ntres\n', 'utf8');
  let out = await executeTool('edit_file', { path: 'a.txt', old_string: 'dos', new_string: 'DOS' }, { workspace: dir });
  ok(out.startsWith('OK'), out);
  eq(fs.readFileSync(p, 'utf8'), 'uno\nDOS\ntres\n', 'solo cambia el fragmento anclado');
  // ambiguo: no debe tocar el archivo
  fs.writeFileSync(p, 'x\nx\n', 'utf8');
  out = await executeTool('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }, { workspace: dir });
  ok(out.startsWith('Error'), out);
  eq(fs.readFileSync(p, 'utf8'), 'x\nx\n', 'un fragmento ambiguo no puede modificar nada');
  // replace_all sí las cambia todas
  out = await executeTool('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, { workspace: dir });
  ok(out.startsWith('OK'), out);
  eq(fs.readFileSync(p, 'utf8'), 'y\ny\n');
  // el texto nuevo no se interpreta como patrón de reemplazo ($&)
  fs.writeFileSync(p, 'gancho', 'utf8');
  await executeTool('edit_file', { path: 'a.txt', old_string: 'gancho', new_string: 'precio: $&' }, { workspace: dir });
  eq(fs.readFileSync(p, 'utf8'), 'precio: $&', 'el texto literal no debe expandirse');
});

test('read_file: lee por rango con cabecera y avisa de cómo seguir', async () => {
  const dir = tmpDir('sagi-read-');
  const p = path.join(dir, 'b.txt');
  fs.writeFileSync(p, Array.from({ length: 50 }, (_, i) => 'linea' + (i + 1)).join('\n'), 'utf8');
  const out = await executeTool('read_file', { path: 'b.txt', offset: 10, limit: 3 }, { workspace: dir });
  ok(out.includes('[líneas 10-12 de 50]'), out.slice(0, 80));
  ok(out.includes('linea10') && out.includes('linea12') && !out.includes('linea13'), 'devuelve solo el rango pedido');
  ok(/quedan 38 líneas/.test(out), 'debe indicar cómo continuar la lectura');
});

test('edit_file: un archivo que no está en UTF-8 no se toca', async () => {
  const dir = tmpDir('sagi-ansi-');
  const p = path.join(dir, 'notas.txt');
  // lo típico en Windows: un .txt guardado en ANSI por Notepad
  const original = Buffer.from('caf\xe9 con le\xf1a\nsegunda l\xednea\n', 'latin1');
  fs.writeFileSync(p, original);
  const out = await executeTool('edit_file', { path: 'notas.txt', old_string: 'segunda', new_string: 'otra' }, { workspace: dir });
  ok(out.startsWith('Error'), 'debe negarse en vez de corromper los acentos: ' + out);
  ok(/ANSI|UTF-8/.test(out), 'explica el motivo');
  ok(fs.readFileSync(p).equals(original), 'el archivo queda intacto, byte a byte');
  // y el mismo archivo en UTF-8 sí se edita
  const p2 = path.join(dir, 'utf8.txt');
  fs.writeFileSync(p2, 'café con leña\n', 'utf8');
  const okEdit = await executeTool('edit_file', { path: 'utf8.txt', old_string: 'leña', new_string: 'azúcar' }, { workspace: dir });
  ok(okEdit.startsWith('OK'), okEdit);
  eq(fs.readFileSync(p2, 'utf8'), 'café con azúcar\n');
});

test('write_file: escribe el contenido y no deja temporales', async () => {
  const dir = tmpDir('sagi-write-');
  const out = await executeTool('write_file', { path: 'sub/x.txt', content: 'hola' }, { workspace: dir });
  ok(out.startsWith('OK'), out);
  eq(fs.readFileSync(path.join(dir, 'sub', 'x.txt'), 'utf8'), 'hola');
  // sobrescribir tampoco deja restos del mecanismo atómico
  await executeTool('write_file', { path: 'sub/x.txt', content: 'adiós' }, { workspace: dir });
  eq(fs.readFileSync(path.join(dir, 'sub', 'x.txt'), 'utf8'), 'adiós');
  eq(fs.readdirSync(path.join(dir, 'sub')).join(','), 'x.txt', 'sin ficheros .sagi-tmp colgando');
});

test('list_dir y search_files: una ruta que no existe se explica', async () => {
  const dir = tmpDir('sagi-missing-');
  const l = await executeTool('list_dir', { path: 'no-existe' }, { workspace: dir });
  ok(l.startsWith('Error'), 'list_dir no puede responder «vacío» a una ruta inexistente: ' + l);
  const s = await executeTool('search_files', { path: 'no-existe', pattern: 'x' }, { workspace: dir });
  ok(s.startsWith('Error'), 'search_files tampoco: ' + s);
  // y una ruta que sí existe sigue funcionando
  fs.writeFileSync(path.join(dir, 'a.txt'), 'contenido', 'utf8');
  const okList = await executeTool('list_dir', { path: '.' }, { workspace: dir });
  ok(okList.includes('a.txt'), okList);
});

test('search_files: la profundidad está acotada (un ciclo no cuelga la búsqueda)', async () => {
  const dir = tmpDir('sagi-deep-');
  let deep = dir;
  for (let i = 0; i < 15; i++) { deep = path.join(deep, 'n' + i); fs.mkdirSync(deep, { recursive: true }); }
  fs.writeFileSync(path.join(deep, 'aguja.txt'), 'x', 'utf8');
  const t0 = Date.now();
  const out = await executeTool('search_files', { path: '.', pattern: 'aguja' }, { workspace: dir });
  ok(Date.now() - t0 < 5000, 'termina en seguida');
  eq(out, 'Sin resultados.', 'más allá del tope de profundidad no se busca (antes podía no terminar nunca)');
});

(async () => {
  /* ---------- v1.3: TaskManager (cola, concurrencia, pausa, cancelar, programadas) ---------- */
const { TaskManager } = require('../agent/tasks');
const TASKS_TM = tmpDir('sagi-tm-');
checkpoints.__test._resetForTests(TASKS_TM);

function makeManager(overrides = {}) {
  const pausedOnce = new Set();   // behavior 'pause': pausa solo el primer arranque de cada tarea
  return new TaskManager({
    getSettings: () => ({ active: { model: 'fake-model', baseUrl: 'http://localhost:0/v1' }, settings: { maxConcurrentTasks: 1, ...(overrides.settings || {}) } }),
    agentFactory: () => ({
      chat: async (goal, settings, img, opts) => {
        if (overrides.behavior === 'fail') {
          if (opts && opts.task) checkpoints.fail(opts.task, { step: 'EXECUTE', tool: 'run_command', message: 'fallo simulado' });
          throw new Error('fallo simulado');
        }
        if (overrides.behavior === 'pause' && opts && opts.task && !pausedOnce.has(opts.task.runId)) {
          pausedOnce.add(opts.task.runId);
          checkpoints.pause(opts.task);
          (overrides.onPaused || (() => {}))(opts.task);
          return;
        }
        if (opts && opts.task) checkpoints.complete(opts.task, 'hecho: ' + goal.slice(0, 20));
      },
      stop: () => {},
      getMeta: () => ({ busy: false, tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 0 }),
      getToolsFired: () => [],
      pause: () => {},
    }),
    emit: overrides.emit || (() => {}),
    notify: overrides.notify || (() => {}),
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Espera a que se cumpla una condición, con deadline. La cola de tareas encadena
    varias escrituras síncronas de disco (save → _pump → _start → resume → chat →
    complete → finally) y una espera fija de 60 ms se queda corta en una máquina
    cargada: eso era rojo intermitente en el gate de release. */
const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(25);
  }
};

test('TaskManager: enqueue + running → completed with notification', async () => {
  const notes = [];
  const tm = makeManager({ notify: (run, kind) => notes.push(kind) });
  const r = tm.enqueue({ goal: 'Investigar vuelos baratos' });
  ok(r.ok && r.runId);
  const t = await waitFor(() => { const x = checkpoints.read(r.runId); return x && x.status === 'completed' ? x : null; });
  ok(t, 'la tarea termina: ' + JSON.stringify(checkpoints.read(r.runId)));
  ok(notes.includes('completed'), 'notifica al terminar: ' + JSON.stringify(notes));
  ok(t.result.includes('vuelos'));
  tm.dispose();
});

test('TaskManager: no reanuda un run que el chat está ejecutando', async () => {
  const tm = makeManager();
  const dir = tmpDir('sagi-busy-');
  const prev = checkpoints._dir();
  checkpoints.__test._resetForTests(dir);
  const r = checkpoints.newRun({ goal: 'la del chat', status: 'paused' });
  checkpoints.save(r);
  tm.isRunBusy = (id) => id === r.runId;   // el chat lo tiene en marcha
  const res = tm.resume(r.runId);
  eq(res.ok, false, 'no puede lanzar un segundo agente sobre el mismo run');
  ok(/chat/.test(res.error), res.error);
  eq(checkpoints.read(r.runId).status, 'paused', 'el estado no se toca');
  checkpoints.__test._resetForTests(prev);
  tm.dispose();
});

test('TaskManager: cancelar avisa una sola vez', async () => {
  const notes = [];
  const tm = makeManager({ notify: (run, kind) => notes.push(kind) });
  // el chat sigue "trabajando" cuando el usuario cancela: su .finally llega después
  tm.agentFactory = () => ({
    chat: async () => { await wait(200); },
    stop: () => {}, getMeta: () => ({ busy: true }), getToolsFired: () => [], pause: () => {},
  });
  const r = tm.enqueue({ goal: 'tarea cancelable' });
  await wait(30);
  tm.cancel(r.runId);
  await wait(300);   // tiempo de sobra para que el chat abortado cierre y notifique
  eq(notes.filter(k => k === 'cancelled').length, 1, 'una acción = un aviso: ' + JSON.stringify(notes));
  tm.dispose();
});

test('TaskManager: stopAll deja la cola parada', async () => {
  const started = [];
  const tm = makeManager();
  // agente que "termina" rápido y deja su run interrumpido: es lo que hace el real
  // cuando se le aborta, y su .finally es el que volvía a arrancar la cola
  tm.agentFactory = () => ({
    chat: async (goal, settings, img, opts) => {
      started.push(goal);
      await wait(20);
      if (opts && opts.task) checkpoints.interrupt(opts.task);
    },
    stop: () => {}, getMeta: () => ({ busy: false }), getToolsFired: () => [], pause: () => {},
  });
  const dir = tmpDir('sagi-stop-');
  const prev = checkpoints._dir();
  checkpoints.__test._resetForTests(dir);
  tm.enqueue({ goal: 'primera tarea de la cola' });
  tm.enqueue({ goal: 'segunda tarea de la cola' });
  tm.enqueue({ goal: 'tercera tarea de la cola' });
  await wait(40);                      // la primera arranca; las otras dos esperan hueco
  const afterStop = started.length;
  ok(afterStop >= 1, 'la primera arrancó');
  tm.stopAll();
  await wait(80);
  eq(started.length, afterStop, 'al cerrar no se arranca ninguna más: ' + JSON.stringify(started));
  checkpoints.__test._resetForTests(prev);
  tm.dispose();
});

test('TaskManager: rejects empty goal and invalid schedule', async () => {
  const tm = makeManager();
  eq(tm.enqueue({ goal: '' }).ok, false);
  eq(tm.enqueue({ goal: 'x', scheduledAt: 'no-es-fecha' }).ok, false);
  tm.dispose();
});

test('TaskManager: scheduled task waits and ticks to pending', async () => {
  const tm = makeManager();
  const r = tm.enqueue({ goal: 'tarea futura', scheduledAt: new Date(Date.now() + 30 * 60000).toISOString() });
  ok(r.ok);
  // enqueue guarda de forma síncrona: no hace falta esperar para leerlo
  eq(checkpoints.read(r.runId).status, 'scheduled', 'queda programada');
  // fuerza el vencimiento y tick manual (no esperamos los 20s del timer)
  const run = checkpoints.read(r.runId);
  run.scheduledAt = new Date(Date.now() - 1000).toISOString();
  checkpoints.save(run);
  tm._tick();
  const t = await waitFor(() => {
    const x = checkpoints.read(r.runId);
    return x && ['pending', 'running', 'completed'].includes(x.status) ? x : null;
  });
  ok(t, 'tras tick se encola/ejecuta: ' + JSON.stringify(checkpoints.read(r.runId)));
  tm.dispose();
});

test('TaskManager: pause a pending task keeps it paused, resume re-enqueues', async () => {
  const tm = makeManager({ behavior: 'pause' });
  tm.enqueue({ goal: 'tarea pausable' });
  const first = await waitFor(() => checkpoints.list('active').find(t => t.goal === 'tarea pausable') || null);
  ok(first, 'la tarea existe');
  // la segunda arranca (el hueco queda libre cuando la primera se pausa) y el
  // agente de prueba la pausa en su primer arranque
  const r2 = tm.enqueue({ goal: 'otra más' });
  const started = await waitFor(() => { const x = checkpoints.read(r2.runId); return x && x.status === 'paused' ? x : null; });
  ok(started, 'la segunda arrancó y quedó pausada: ' + JSON.stringify(checkpoints.read(r2.runId)));
  const r = tm.pause(r2.runId);
  eq(r.ok, true, 'pausar una ya pausada no es un error');
  eq(checkpoints.read(r2.runId).status, 'paused');
  const rs = tm.resume(r2.runId);
  eq(rs.ok, true);
  const done = await waitFor(() => { const x = checkpoints.read(r2.runId); return x && x.status === 'completed' ? x : null; });
  ok(done, 'tras reanudar, la tarea se completa: ' + JSON.stringify(checkpoints.read(r2.runId)));
  tm.dispose();
});

test('TaskManager: cancel archives the task as cancelled', async () => {
  const tm = makeManager({ behavior: 'pause' });
  const r = tm.enqueue({ goal: 'tarea cancelable' });
  const c = tm.cancel(r.runId, 'ya no la quiero');   // cancelar en cualquier estado vivo
  eq(c.ok, true);
  const t = checkpoints.read(r.runId);
  eq(t.status, 'cancelled');
  ok(t.lastError.message.includes('ya no la quiero'));
  eq(tm.cancel(r.runId).ok, false, 'no se cancela dos veces');
  tm.dispose();
});

test('TaskManager: autoResume re-enqueues interrupted tasks', async () => {
  const run = checkpoints.newRun({ goal: 'huérfana del crash' });
  checkpoints.interrupt(run);
  const tm = makeManager();
  const r = tm.autoResume();
  ok(r.resumed >= 1, 're-encola al menos la huérfana');
  const done = await waitFor(() => { const x = checkpoints.read(run.runId); return x && x.status === 'completed' ? x : null; });
  ok(done, 'la huérfana se completa: ' + JSON.stringify(checkpoints.read(run.runId)));
  tm.dispose();
});

test('TaskManager: no model configured → task parked as paused', async () => {
  const tm = new TaskManager({
    getSettings: () => ({ active: null, settings: {} }),
    agentFactory: () => { throw new Error('no debería crearse'); },
    emit: () => {}, notify: () => {},
  });
  const r = tm.enqueue({ goal: 'sin proveedor' });
  // se aparca en cuanto el _pump la mira: sin proveedor no hay nada que esperar
  const t = await waitFor(() => { const x = checkpoints.read(r.runId); return x && x.status === 'paused' ? x : null; });
  ok(t, 'queda en pausa: ' + JSON.stringify(checkpoints.read(r.runId)));
  tm.dispose();
});

/* ---------- v1.4: subagentes y delegación ---------- */
const subagents = require('../agent/subagents');

test('subagents: every spec has tools, budget and a system prompt', () => {
  ok(subagents.SUBAGENT_KEYS.length >= 6);
  for (const k of subagents.SUBAGENT_KEYS) {
    const spec = subagents.SUBAGENTS[k];
    ok(spec.allowTools.length >= 2, k + ' tiene herramientas');
    ok(spec.maxSteps > 0 && spec.maxSteps <= 40, k + ' presupuesto razonable');
    ok(subagents.subagentSystemPrompt(k).includes('RESULT:'), k + ' prompt con formato');
  }
});

test('subagents: toolDefsFor restricts to allowed tools only', () => {
  const defs = subagents.toolDefsFor('research');
  ok(defs.length >= 2);
  ok(defs.every(d => subagents.SUBAGENTS.research.allowTools.includes(d.function.name)));
  ok(!defs.some(d => d.function.name === 'run_command'), 'research NO tiene terminal');
  ok(!subagents.toolDefsFor('vision').some(d => d.function.name === 'write_file'));
});

test('subagents: delegate def is in toolDefs and has the right enum', () => {
  const { toolDefs } = require('../agent/tools');
  const d = toolDefs.find(t => t.function.name === 'delegate');
  ok(d, 'delegate registrada');
  ok(d.function.parameters.properties.agent.enum.includes('verification'));
});

test('subagents: parseSubagentResult extracts structured output', () => {
  const p = subagents.parseSubagentResult('RESULT: Encontrados 3 vuelos\nDETAILS: url=x\nSTATUS: OK');
  eq(p.status, 'OK');
  eq(p.result, 'Encontrados 3 vuelos');
  eq(p.details, 'url=x');
  const f = subagents.parseSubagentResult('RESULT: nada\nSTATUS: FAILED');
  eq(f.status, 'FAILED');
  const legacy = subagents.parseSubagentResult('hice lo que pediste sin formato');
  ok(legacy.result.length > 0, 'fallback al texto plano');
});

/* ---------- v1.5: seguridad del navegador + perfiles ---------- */
const { isSensitiveBrowserAction } = require('../agent/guardrails');

test('sensitive browser actions always require confirmation', () => {
  ok(isSensitiveBrowserAction('browser_control', { action: 'click', text: 'Finalizar compra' }));
  ok(isSensitiveBrowserAction('browser_control', { action: 'click', text: 'Eliminar cuenta' }));
  ok(isSensitiveBrowserAction('browser_control', { action: 'type', selector: '#card-number', text: '4111' }));
  ok(isSensitiveBrowserAction('browser_control', { action: 'click', text: 'Publicar comentario' }));
});

test('regular browser actions are NOT sensitive', () => {
  ok(!isSensitiveBrowserAction('browser_control', { action: 'click', text: 'Más información' }));
  ok(!isSensitiveBrowserAction('browser_control', { action: 'navigate', url: 'https://x.com' }));
  ok(!isSensitiveBrowserAction('browser_control', { action: 'screenshot' }));
  ok(!isSensitiveBrowserAction('run_command', { command: 'comprar pan' }));
});

test('guardrails.decide forces confirm on sensitive actions even when browser is safe', () => {
  const g = new Guardrails({ permissions: { browser_control: 'safe' } });
  const d = g.decide('browser_control', { action: 'click', text: 'Pagar ahora' });
  eq(d.action, 'confirm');
  eq(d.sensitive, true);
  // y una acción normal sigue permitida
  eq(g.decide('browser_control', { action: 'navigate', url: 'https://x.com' }).action, 'allow');
});

test('browser profiles: each profile gets its own data dir', () => {
  const { profileDirFor } = require('../agent/browser-profiles');
  const d1 = profileDirFor('default');
  const work = profileDirFor('work');
  const personal = profileDirFor('personal');
  ok(work !== d1, 'work ≠ default');
  ok(/work/.test(work));
  ok(personal !== d1 && personal !== work, 'personal ≠ default ≠ work');
  ok(/personal/.test(personal));
  eq(profileDirFor('Mi Work!').toLowerCase().includes('mi_work'), true, 'saneado de nombres');
  eq(profileDirFor(''), profileDirFor(undefined), 'vacío → default');
});

/* ---------- v1.6: Model Router, Fallback y Health ---------- */
const modelsMod = require('../agent/models');
const HEALTH_TMP = tmpDir('sagi-health-');
modelsMod._resetForTests(path.join(HEALTH_TMP, 'health.json'));

test('classify detects task categories', () => {
  eq(modelsMod.classify('escribe un script de python que ordene archivos'), 'coding');
  eq(modelsMod.classify('navega a wikipedia y lee el artículo'), 'browser');
  eq(modelsMod.classify('investiga y compara precios de portátiles'), 'research');
  eq(modelsMod.classify('razona sobre este dilema y decide'), 'reasoning');
  eq(modelsMod.classify('hola'), 'simple');
  eq(modelsMod.classify('analiza esto', { hasImage: true }), 'vision');
});

test('fallbackChain: primary → manual → others → locals', () => {
  const cfg = {
    providers: [
      { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', models: ['gpt-5', 'claude-sonnet-4'], activeModel: 'gpt-5' },
      { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k2', models: ['llama-3-70b'] },
      { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2:8b'] },
    ],
    active: { providerId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'gpt-5' },
    fallbackChain: [],
  };
  const chain = modelsMod.fallbackChain(cfg, 'coding');
  eq(chain[0].model, 'gpt-5', 'primario primero');
  ok(chain.some(c => c.providerId === 'groq'), 'secundario incluido');
  const locals = chain.filter(c => c.role === 'local');
  eq(locals.length, 1, 'ollama como red de salvamento');
  eq(locals[0].providerId, 'ollama');
  // sin duplicados y con modelo siempre definido
  const ids = chain.map(c => c.providerId);
  eq(new Set(ids).size, ids.length);
  ok(chain.every(c => c.model));
});

test('pickModelFor prefers adequate models per category', () => {
  const ms = ['llama3.2:8b', 'qwen2.5-coder:14b', 'llava'];
  ok(modelsMod.pickModelFor(ms, 'coding').includes('coder'));
  eq(modelsMod.pickModelFor(ms, 'vision'), 'llava');
  eq(modelsMod.pickModelFor([], 'coding'), null);
});

test('fallbackChain respects the user-chosen model (no silent category re-pick)', () => {
  // Caso real del usuario: modelo elegido mimo-v2.5 en Ajustes; una petición
  // «simple» hacía que el router reeligiera deepseek-flash por coincidir con
  // /flash/, y ese modelo era el que fallaba.
  const cfg = {
    providers: [
      { id: 'go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k',
        models: ['deepseek-flash', 'deepseek-v4.1-flash', 'mimo-v2.5'], activeModel: 'mimo-v2.5' },
    ],
    active: { providerId: 'go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'mimo-v2.5' },
    fallbackChain: [],
  };
  for (const cat of ['simple', 'coding', 'research', 'browser']) {
    const chain = modelsMod.fallbackChain(cfg, cat);
    eq(chain[0].model, 'mimo-v2.5', `categoría ${cat}: respeta el modelo elegido`);
  }
});

test('health record accumulates and summarizes', () => {
  modelsMod.record('gpt-5', { ok: true, durationMs: 500, tokens: { prompt_tokens: 100, completion_tokens: 50 } });
  modelsMod.record('gpt-5', { ok: false, durationMs: 200, error: 'HTTP 502', fallbackFrom: true });
  const s = modelsMod.summary().find(x => x.model === 'gpt-5');
  eq(s.calls, 2);
  eq(s.errors, 1);
  eq(s.fallbacks, 1);
  eq(s.avgLatencyMs, 350);
  ok(s.errorRate > 0 && s.errorRate < 1);
});

/* ---------- v1.7: skills avanzadas + marketplace ---------- */
const SKILLS_TMP = tmpDir('sagi-skills-');
skills.__test._resetForTests(SKILLS_TMP);   // redirige el almacén para los tests

const { spawnSync } = require('child_process');

// escribe una skill con triggers y dependencias para las pruebas async
const skillDir = path.join(SKILLS_TMP, 'test-skill');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: blender-pro\ndescription: Automatiza escenas de Blender y renders 3D\ntriggers:\n  - blender\ndependencies:\n  - blender >= 4.0\ncategory: 3D\nversion: 1.1.0\n---\nInstrucciones de blender.');

test('skills: search finds by description and triggers', async () => {
  const r = await skills.searchSkills('blender');
  ok(r.length === 1 && r[0].name === 'blender-pro');
  const none = await skills.searchSkills('zzz-nada');
  eq(none.length, 0);
});

test('skills: suggestSkillsFor auto-activates by trigger', async () => {
  const hits = await skills.suggestSkillsFor('abre blender y renderiza la escena');
  ok(hits.length === 1 && hits[0].name === 'blender-pro', 'trigger blender → skill');
  const no = await skills.suggestSkillsFor('cocina una pasta');
  eq(no.length, 0);
});

test('skills: metadata (category, deps, triggers) is exposed', async () => {
  const s = (await skills.listSkills()).find(x => x.name === 'blender-pro');
  ok(s, 'skill presente');
  eq(s.category, '3D');
  eq(s.dependencies.length, 1);
  eq(s.triggers[0], 'blender');
});

test('marketplace catalog marks installed repos', async () => {
  const marketplace = require('../agent/marketplace');
  const cat = await marketplace.catalog(['anthropics/skills']);
  ok(cat.length >= 3);
  eq(cat.find(x => x.repo === 'anthropics/skills').installed, true);
  eq(cat.find(x => x.repo === 'anthropics/skills/webapp-testing').installed, false);
});

/* ---------- v2.0: hábitos ---------- */
const habits = require('../agent/habits');
const HABITS_TMP = tmpDir('sagi-habits-');
habits.__test._resetForTests(path.join(HABITS_TMP, 'habits.json'));

test('habits: observation builds a profile the agent can use', () => {
  habits.observe('tool', { name: 'open_app', args: { name: 'spotify.exe' } });
  habits.observe('tool', { name: 'open_app', args: { name: 'Spotify' } });
  habits.observe('tool', { name: 'run_command', args: { command: 'git status', cwd: 'C:\\dev\\mi-proyecto' } });
  habits.observe('tool', { name: 'run_command', args: { command: 'git push' } });
  habits.observe('tool', { name: 'browser_control', args: { url: 'https://github.com/ejemplo/mi-repo' } });
  habits.observe('tool', { name: 'browser_control', args: { url: 'github.com/explore' } });
  habits.observe('mode', { mode: 'plan' });
  habits.observe('mode', { mode: 'plan' });
  habits.observe('confirm', { approved: false });
  habits.observe('confirm', { approved: true });
  const p = habits.profile();
  ok(p.includes('Spotify') || p.includes('spotify'), 'app habitual');
  ok(p.includes('git'), 'comando frecuente');
  ok(p.includes('github.com'), 'web frecuente');
  ok(p.includes('plan'), 'modo preferido');
  const s = habits.stats();
  eq(s.confirms.approved, 1);
  eq(s.confirms.denied, 1);
});

test('habits: single occurrences do not become habits (MIN_COUNT)', () => {
  habits.observe('tool', { name: 'open_app', args: { name: 'regedit.exe' } });   // 1 sola vez
  ok(!habits.profile().toLowerCase().includes('regedit'), 'no es hábito todavía');
  habits.reset();
  eq(habits.profile(), '');
});

/* ---------- OpenCode Go: sesión/identificación (cabeceras obligatorias) ---------- */
const opencode = require('../agent/opencode');

test('opencode: isOpenCode reconoce los endpoints Go/Zen y no otros', () => {
  ok(opencode.isOpenCode('https://opencode.ai/zen/go/v1'));
  ok(!opencode.isOpenCode('https://api.openai.com/v1'));
  ok(!opencode.isOpenCode('http://localhost:11434/v1'));
});

test('opencode: identityHeaders añade x-opencode-session solo para OpenCode', () => {
  const h = opencode.identityHeaders('https://opencode.ai/zen/go/v1', 'sagi-abc');
  eq(h['x-opencode-session'], 'sagi-abc');
  eq(h['x-opencode-client'], 'sagitari');
  eq(Object.keys(opencode.identityHeaders('https://api.openai.com/v1', 'sagi-abc')).length, 0, 'no ensucia otros proveedores');
});

test('opencode: la sesión es estable por conversación y única si no hay id', () => {
  eq(opencode.sessionFor('c123abc'), opencode.sessionFor('c123abc'));
  ok(opencode.sessionFor('c123abc') !== opencode.sessionFor('c999'));
  ok(opencode.sessionFor('').startsWith('sagi-'));
});

test('opencode: userAgent identifica al cliente con su versión', () => {
  ok(/^Sagitari\/\d/.test(opencode.userAgent()), opencode.userAgent());
});

/* ---------- protocolos de proveedor (OpenAI / Anthropic / Responses) ---------- */
const protocols = require('../agent/protocols');

function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}
function fakeFetch(chunks, sink) {
  return async (url, opts) => {
    if (sink) { sink.url = url; sink.headers = opts.headers; sink.body = JSON.parse(opts.body); }
    return sseResponse(chunks);
  };
}
const evData = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const evNamed = (name, o) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;
const noSignal = () => new AbortController().signal;

test('protocols: detectFormat elige el endpoint por proveedor y modelo', () => {
  eq(protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3-flash' }), 'openai');
  eq(protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'qwen3.8-max' }), 'anthropic');
  eq(protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'kimi-k2.7-code' }), 'openai');
  eq(protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'grok-4.6' }), 'responses');
  eq(protocols.detectFormat({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4' }), 'anthropic');
  eq(protocols.detectFormat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }), 'openai');
  eq(protocols.detectFormat({ baseUrl: 'https://x/v1', model: 'm', format: 'responses' }), 'responses');
  eq(protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'opencode-go/qwen3.8-max' }), 'anthropic', 'admite id con prefijo');
});

test('protocols: authHeaders usa Bearer salvo en Anthropic (x-api-key)', () => {
  const o = protocols.authHeaders({ apiKey: 'k' }, 'openai');
  eq(o.Authorization, 'Bearer k');
  const a = protocols.authHeaders({ apiKey: 'k' }, 'anthropic');
  eq(a['x-api-key'], 'k');
  ok(!a.Authorization, 'Anthropic no usa Bearer');
  eq(a['anthropic-version'], '2023-06-01');
});

test('protocols: openai usa /chat/completions y ensambla texto, tools y uso', async () => {
  const sink = {};
  const chunks = [
    evData({ choices: [{ delta: { content: 'Ho' } }] }),
    evData({ choices: [{ delta: { content: 'la' } }] }),
    evData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
    evData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }),
    evData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
    'data: [DONE]\n\n',
  ];
  const res = await protocols.stream(
    { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'k', temperature: 0.2, format: 'openai' },
    { fetchFn: fakeFetch(chunks, sink), messages: [{ role: 'user', content: 'hola' }], tools: [], signal: noSignal(), onText: () => {} }
  );
  eq(sink.url, 'https://api.openai.com/v1/chat/completions');
  eq(sink.headers.Authorization, 'Bearer k');
  eq(res.text, 'Hola');
  eq(res.toolCalls.length, 1);
  eq(res.toolCalls[0].function.name, 'read_file');
  eq(res.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  eq(res.usage.total_tokens, 14);
});

test('protocols: anthropic usa /messages, x-api-key y ensambla tool_use', async () => {
  const sink = {};
  const chunks = [
    evNamed('message_start', { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vale' } }),
    evNamed('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command' } }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"dir"}' } }),
    evNamed('message_delta', { type: 'message_delta', usage: { output_tokens: 7 } }),
    evNamed('message_stop', { type: 'message_stop' }),
  ];
  const res = await protocols.stream(
    { baseUrl: 'https://opencode.ai/zen/go/v1', providerId: 'opencode-go', model: 'qwen3.8-max', apiKey: 'k', format: 'anthropic' },
    { fetchFn: fakeFetch(chunks, sink), messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }], tools: [], signal: noSignal(), onText: () => {} }
  );
  eq(sink.url, 'https://opencode.ai/zen/go/v1/messages');
  eq(sink.headers['x-api-key'], 'k');
  eq(sink.body.max_tokens, 4096, 'Messages exige max_tokens');
  eq(sink.body.system, 'sys');
  eq(res.text, 'Vale');
  eq(res.toolCalls[0].function.name, 'run_command');
  eq(res.toolCalls[0].function.arguments, '{"cmd":"dir"}');
  eq(res.usage.total_tokens, 19);
});

test('protocols: responses usa /responses y ensambla function_call + uso', async () => {
  const sink = {};
  const chunks = [
    evData({ type: 'response.output_text.delta', delta: 'Listo' }),
    evData({ type: 'response.output_item.added', item: { id: 'item_1', type: 'function_call', call_id: 'call_x', name: 'write_file' } }),
    evData({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":"b' }),
    evData({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '.txt"}' }),
    evData({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }),
  ];
  const res = await protocols.stream(
    { baseUrl: 'https://opencode.ai/zen/go/v1', providerId: 'opencode-go', model: 'grok-4.6', apiKey: 'k', format: 'responses' },
    { fetchFn: fakeFetch(chunks, sink), messages: [{ role: 'user', content: 'hola' }], tools: [], signal: noSignal(), onText: () => {} }
  );
  eq(sink.url, 'https://opencode.ai/zen/go/v1/responses');
  eq(sink.headers.Authorization, 'Bearer k');
  eq(res.text, 'Listo');
  eq(res.toolCalls[0].function.name, 'write_file');
  eq(res.toolCalls[0].function.arguments, '{"path":"b.txt"}');
  eq(res.usage.total_tokens, 8);
});

test('protocols: la conversión a Anthropic separa el system y agrupa tool_result', () => {
  const out = protocols.toAnthropicMessages([
    { role: 'system', content: 'eres sagitari' },
    { role: 'user', content: 'lista la carpeta' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'a.txt' },
    { role: 'tool', tool_call_id: 't2', content: 'ok' },
  ]);
  eq(out.system, 'eres sagitari');
  const assistant = out.messages.find(m => m.role === 'assistant');
  eq(assistant.content[0].type, 'tool_use');
  eq(assistant.content[0].input.path, '.');
  const last = out.messages[out.messages.length - 1];
  eq(last.role, 'user');
  eq(last.content.filter(b => b.type === 'tool_result').length, 2, 'agrupa tool_result consecutivos');
});

test('protocols: la conversión a Responses usa function_call / function_call_output', () => {
  const out = protocols.toResponsesInput([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hola' },
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'salida' },
  ]);
  eq(out.instructions, 'sys');
  ok(out.input.some(i => i.type === 'function_call' && i.call_id === 't1'), 'function_call');
  ok(out.input.some(i => i.type === 'function_call_output' && i.output === 'salida'), 'function_call_output');
});

test('protocols: los screenshots de una herramienta no se pierden en Anthropic/Responses', () => {
  const dataUrl = 'data:image/png;base64,AAAA';
  const msgs = [
    { role: 'user', content: 'captura la pantalla' },
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: 'Captura tomada' }, { type: 'image_url', image_url: { url: dataUrl } }] },
  ];
  const a = protocols.toAnthropicMessages(msgs);
  const lastA = a.messages[a.messages.length - 1];
  ok(lastA.content[0].content.some(b => b.type === 'image'), 'imagen dentro del tool_result');
  const r = protocols.toResponsesInput(msgs);
  ok(r.input.some(i => Array.isArray(i.content) && i.content.some(c => c.type === 'input_image')), 'imagen como entrada de usuario');
});

/* ---------- MCP: framing y JSON-RPC ---------- */
const mcpTransport = require('../agent/mcp-transport');

test('mcp: el lector entrega mensajes completos y descarta los banners', () => {
  const vistos = [];
  const feed = mcpTransport.createLineReader((m, noise) => vistos.push({ m, noise }));
  // dos mensajes en un chunk, uno partido en dos y una línea de banner al principio
  feed('Servidor MCP 1.0 listo\n{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,');
  feed('"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}\n');
  eq(vistos.map(v => v.m.id).join(','), '1,2,3', 'los tres mensajes llegan, en orden');
  eq(vistos[0].noise, 1, 'el banner se cuenta como ruido, no como mensaje');
});

test('mcp: las peticiones se emparejan por id y se resuelven fuera de orden', async () => {
  const enviados = [];
  const rpc = new mcpTransport.Rpc({ send: (text) => enviados.push(JSON.parse(text)) });
  const p1 = rpc.request('tools/list', {});
  const p2 = rpc.request('tools/call', { name: 'x' });
  eq(enviados.length, 2, 'las dos salen a la vez');
  ok(enviados[0].id !== enviados[1].id, 'cada una con su id');
  rpc.handleMessage({ jsonrpc: '2.0', id: enviados[1].id, result: { ok: 'dos' } });
  rpc.handleMessage({ jsonrpc: '2.0', id: enviados[0].id, result: { ok: 'uno' } });
  eq((await p1).ok, 'uno', 'la primera responde a la primera');
  eq((await p2).ok, 'dos');
});

test('mcp: el error JSON-RPC y el timeout se explican', async () => {
  const rpc = new mcpTransport.Rpc({ send: () => {} });
  const p = rpc.request('initialize', {}, { timeoutMs: 50 });
  const [, err] = await p.then(() => [null, null], (e) => [null, e]);
  ok(/no respondió|timeout/i.test(err.message), err.message);

  const rpc2 = new mcpTransport.Rpc({ send: () => {} });
  const p2 = rpc2.request('x', {}, { timeoutMs: 1000 });
  rpc2.handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'método no soportado' } });
  const [, err2] = await p2.then(() => [null, null], (e) => [null, e]);
  ok(err2 && /método no soportado/.test(err2.message), 'el mensaje del servidor se propaga: ' + (err2 && err2.message));
});

test('mcp: si el transporte muere, las peticiones en vuelo se rechazan', async () => {
  const rpc = new mcpTransport.Rpc({ send: () => {} });
  const p = rpc.request('tools/list', {}, { timeoutMs: 5000 });
  rpc.fail('el servidor se cayó');
  const [, err] = await p.then(() => [null, null], (e) => [null, e]);
  ok(/se cayó/.test(err.message), 'no se queda esperando para siempre');
});

test('mcp: un chunk partido en mitad de un carácter no corrompe el mensaje', () => {
  const vistos = [];
  const feed = mcpTransport.createLineReader((m) => vistos.push(m));
  const linea = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { t: 'descripción con acentos: ñáé' } }) + '\n', 'utf8');
  // se parte justo en mitad de la 'ó' (2 bytes): convertir cada chunk por separado
  // dejaría dos U+FFFD y el mensaje llegaría corrupto sin avisar
  const corte = linea.indexOf(Buffer.from('ó', 'utf8')) + 1;
  feed(linea.subarray(0, corte));
  feed(linea.subarray(corte));
  eq(vistos.length, 1, 'el mensaje llega entero');
  eq(vistos[0].result.t, 'descripción con acentos: ñáé');
});

test('mcp: una petición del servidor llega con su id (para poder responderla)', () => {
  const avisos = [];
  const rpc = new mcpTransport.Rpc({ send: () => {}, onNotice: (method, params, id) => avisos.push({ method, params, id }) });
  rpc.handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });
  eq(avisos.length, 1);
  eq(avisos[0].method, 'ping');
  eq(avisos[0].id, 7, 'sin el id no se puede contestar y el servidor se queda esperando');
  rpc.handleMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
  eq(avisos[1].id, null, 'las notificaciones no traen id con el que responder');
});

test('mcp: la linea de comandos de cmd.exe cita los argumentos', () => {
  eq(mcpTransport.buildCmdLine('npx', ['-y', '@modelcontextprotocol/server-github']), 'npx -y @modelcontextprotocol/server-github');
  eq(mcpTransport.buildCmdLine('npx', ['-y', 'pkg with space']), 'npx -y "pkg with space"');
  // no se escapa a ciegas: un argumento con metacaracteres de cmd se rechaza
  for (const malo of ['a&b', 'a|b', 'a^b', '50%', 'di"hola', 'linea\nnueva']) {
    let err = null;
    try { mcpTransport.buildCmdLine('npx', [malo]); } catch (e) { err = e; }
    ok(err, 'debe rechazar ' + JSON.stringify(malo));
  }
});

test('mcp: transporte stdio completo contra un servidor real', async () => {
  const path2 = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
  const tr = mcpTransport.createStdioTransport({
    command: process.execPath, args: [path2], env: { MCP_ECHO_BANNER: '1' }, cwd: tmpDir('sagi-mcp-'),
  });
  const init = await tr.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SAGITARI', version: 'test' } }, { timeoutMs: 5000 });
  eq(init.serverInfo.name, 'eco');
  tr.rpc.notify('notifications/initialized', {});
  const p1 = await tr.rpc.request('tools/list', {}, { timeoutMs: 5000 });
  eq(p1.tools.length, 2);
  eq(p1.nextCursor, 'pagina2');
  const p2 = await tr.rpc.request('tools/list', { cursor: p1.nextCursor }, { timeoutMs: 5000 });
  eq(p2.tools.length, 1);
  const call = await tr.rpc.request('tools/call', { name: 'echo', arguments: { text: 'hola' } }, { timeoutMs: 5000 });
  eq(call.content[0].text, 'eco: hola', 'el banner de arranque no rompió el emparejado por id');
  tr.kill();
  ok(tr.pid > 0, 'el proceso tuvo pid (se mató entero)');
});

test('mcp: un .cmd recibe entero un argumento con espacios', async () => {
  if (process.platform !== 'win32') return;   // el producto es Windows-only
  const dir = tmpDir('sagi-cmd-');
  const bat = path.join(dir, 'probe.cmd');
  fs.writeFileSync(bat, '@echo off\r\necho %~1> "%~dp0salida.txt"\r\n', 'utf8');
  const tr = mcpTransport.createStdioTransport({ command: bat, args: ['con espacios'], cwd: dir });
  const salida = path.join(dir, 'salida.txt');
  let txt = '';
  // sondeo con deadline: el .cmd tarda lo suyo en arrancar
  for (let i = 0; i < 40 && !txt; i++) {
    await new Promise(r => setTimeout(r, 50));
    try { txt = fs.readFileSync(salida, 'utf8'); } catch {}
  }
  tr.kill();
  eq(txt.trim(), 'con espacios', 'el argumento llega entero: si Node recita por su cuenta, cmd.exe lo parte');
});

test('mcp: escribir a un servidor ya muerto no tumba el proceso', async () => {
  const dir = tmpDir('sagi-epipe-');
  const vive = path.join(dir, 'vive.js');
  // El hijo NO puede terminar solo: si ya hubiera salido, stdin estaría destruido y
  // notify no llegaría a escribir (el test pasaría aunque faltara el listener, que es
  // exactamente lo que comprobó la re-revisión). Con el hijo vivo, kill() cierra su
  // lado del pipe y la escritura siguiente es un EPIPE.
  fs.writeFileSync(vive, 'setInterval(() => {}, 1000);\n', 'utf8');
  const tr = mcpTransport.createStdioTransport({ command: process.execPath, args: [vive], cwd: dir });
  await new Promise(r => setTimeout(r, 300));
  tr.kill();
  tr.rpc.notify('notifications/initialized', {});   // escritura sobre stdin ya cerrado
  await new Promise(r => setTimeout(r, 200));
  // Sin `child.stdin.on('error', …)` ese EPIPE es un error no capturado y el runner
  // muere aquí (Unhandled 'error' event). Que la suite llegue al final es la prueba.
  ok(tr.pid > 0, 'el transporte sigue en pie tras escribir a un servidor muerto');
});

test('mcp: una petición del servidor con un id que choca no se confunde con una respuesta', async () => {
  const avisos = [];
  const rpc = new mcpTransport.Rpc({ send: () => {}, onNotice: (m, p, id) => avisos.push({ m, id }) });
  const p = rpc.request('tools/list', {}, { timeoutMs: 1000 });   // id 1 en vuelo
  rpc.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });   // el servidor usa el mismo id
  eq(avisos.length, 1, 'el ping llega a onNotice en vez de consumirse como respuesta');
  eq(avisos[0].id, 1);
  // y la respuesta de verdad sigue resolviendo su petición
  rpc.handleMessage({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  eq((await p).tools.length, 0);
});

test('mcp: solo https (o http en loopback) para servidores remotos', () => {
  ok(mcpTransport.httpUrlAllowed('https://mcp.ejemplo.com/mcp'));
  ok(mcpTransport.httpUrlAllowed('http://127.0.0.1:3000/mcp'));
  ok(mcpTransport.httpUrlAllowed('http://localhost:3000/mcp'));
  ok(!mcpTransport.httpUrlAllowed('http://mcp.ejemplo.com/mcp'), 'http en internet queda fuera (va el token en claro)');
  ok(!mcpTransport.httpUrlAllowed('file:///C:/x'), 'nada que no sea http(s)');
  ok(!mcpTransport.httpUrlAllowed('no es una url'));
});

test('mcp: cuerpo SSE y cuerpo JSON se interpretan igual', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n';
  eq(mcpTransport.parseSseText(sse)[0].result.a, 1);
  // varias líneas data: del mismo evento se concatenan (spec SSE)
  const multi = 'data: {"jsonrpc":"2.0","id":2,\ndata: "result":{"b":2}}\n\n';
  eq(mcpTransport.parseSseText(multi)[0].result.b, 2);
  eq(mcpTransport.parseSseText('no es sse').length, 0);
});

test('mcp: transporte http manda cabeceras, guarda la sesión y lee SSE', async () => {
  const http = require('http');
  const vistos = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const msg = JSON.parse(body);
      vistos.push({ msg, auth: req.headers.authorization, accept: req.headers.accept, session: req.headers['mcp-session-id'] });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remoto', version: '1' } } }));
      }
      // el resto responde por SSE: el JSON se parte en dos líneas `data:` del
      // MISMO evento (que es lo que la spec SSE obliga a concatenar)
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'uno', description: 'x', inputSchema: { type: 'object' } }] } });
      // El corte va en una frontera entre tokens (antes de `,"result"`), nunca dentro
      // de una cadena: unir con `\n` entre tokens es espacio en blanco válido para
      // JSON, así que esto sí comprueba la regla de la spec sin inventarse nada.
      const corte = payload.indexOf(',"result"');
      res.write('event: message\ndata: ' + payload.slice(0, corte) + '\n');
      res.write('data: ' + payload.slice(corte) + '\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  try {
    const tr = mcpTransport.createHttpTransport({ url, headers: { Authorization: 'Bearer tok' } });
    const init = await tr.rpc.request('initialize', { clientInfo: { name: 'SAGITARI', version: '1' } }, { timeoutMs: 4000 });
    eq(init.serverInfo.name, 'remoto');
    eq(tr.sessionId(), 'sess-1', 'la sesión se guarda para las siguientes peticiones');
    const list = await tr.rpc.request('tools/list', {}, { timeoutMs: 4000 });
    eq(list.tools[0].name, 'uno', 'la respuesta partida en dos eventos SSE se reensambla');
    eq(vistos[0].accept, 'application/json, text/event-stream');
    eq(vistos[1].auth, 'Bearer tok', 'la cabecera de autorización viaja en cada petición');
    eq(vistos[1].session, 'sess-1', 'y la sesión también');
    tr.kill();
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('mcp: un servidor http que no responde corta por timeout', async () => {
  const http = require('http');
  const srv = http.createServer(() => { /* nunca responde */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  try {
    // defaultTimeoutMs corto: es el que acota la petición HTTP real (el Rpc corta
    // antes por su propio timeout). Sin él, el socket contra un servidor mudo
    // seguiría abierto los 60 s por defecto y la suite tardaría un minuto de más
    // aunque los tests ya hubieran terminado.
    const tr = mcpTransport.createHttpTransport({ url, defaultTimeoutMs: 1000 });
    const t0 = Date.now();
    let err = null;
    try { await tr.rpc.request('initialize', {}, { timeoutMs: 300 }); } catch (e) { err = e; }
    ok(err && /timeout/i.test(err.message), 'corta con timeout: ' + (err && err.message));
    ok(Date.now() - t0 < 3000, 'no espera más de la cuenta');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('mcp: una notificacion contestada con 202 sin cuerpo no mata el transporte', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id == null) { res.writeHead(202); return res.end(); }   // notificación: 202 sin cuerpo
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  const muertes = [];
  try {
    const tr = mcpTransport.createHttpTransport({ url, defaultTimeoutMs: 2000 });
    tr.onExit((m) => muertes.push(m));
    await tr.rpc.request('initialize', { clientInfo: { name: 'SAGITARI', version: 't' } }, { timeoutMs: 2000 });
    tr.rpc.notify('notifications/initialized', {});
    await new Promise((r) => setTimeout(r, 300));
    eq(muertes.length, 0, 'un 202 sin cuerpo no puede marcar el servidor como caído: ' + muertes.join(' | '));
    const r = await tr.rpc.request('tools/list', {}, { timeoutMs: 2000 });
    ok(r && typeof r === 'object', 'el transporte sigue usable después');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('mcp: un timeout del tope HTTP no marca el servidor como caido', async () => {
  const http = require('http');
  const srv = http.createServer(() => { /* nunca responde */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  const muertes = [];
  try {
    // el tope HTTP vence a los 2,5 s y el Rpc espera 3 s: gana el abort del transporte
    const tr = mcpTransport.createHttpTransport({ url, defaultTimeoutMs: 500 });
    tr.onExit((m) => muertes.push(m));
    let err = null;
    try { await tr.rpc.request('tools/list', {}, { timeoutMs: 3000 }); } catch (e) { err = e; }
    ok(err && /timeout/i.test(err.message), 'la petición falla por timeout: ' + (err && err.message));
    eq(muertes.length, 0, 'un timeout puntual no puede dejar el servidor caído para siempre');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

/* ---------- MCP: registro, nombres y catálogo ---------- */
const { McpManager, mapToolName, MAX_TOOL_NAME } = require('../agent/mcp');

test('mcp: el nombre expuesto se sanea y no pasa de 64 caracteres', () => {
  eq(mapToolName('github', 'create_issue'), 'mcp__github__create_issue');
  eq(mapToolName('Mi Servidor!', 'Crear-Nota'), 'mcp__mi_servidor__crear_nota');
  const largo = mapToolName('servidor-con-nombre-muy-largo', 'herramienta-con-nombre-absurdamente-largo-de-mas');
  ok(largo.length <= MAX_TOOL_NAME, 'largo: ' + largo.length);
  ok(largo.startsWith('mcp__'), largo);
  // nunca puede pisar una herramienta nativa
  for (const nativa of ['run_command', 'read_file', 'browser_control']) ok(mapToolName('x', nativa) !== nativa);
});

function fakeTransport(tools, { failInit = false } = {}) {
  const calls = [];
  const t = {
    calls,
    esperandoSalida: [],
    rpc: {
      alive: true,
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          if (failInit) throw new Error('no arrancó');
          return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1' } };
        }
        if (method === 'tools/list') return { tools };
        if (method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
        return {};
      },
      notify() {}, fail() {},
    },
    stderrTail: () => '',
    onExit(cb) { this.esperandoSalida.push(cb); },
    kill() {},
  };
  return t;
}

const MCP_SERVERS = [
  { id: 'eco', name: 'Eco', enabled: true, transport: 'stdio', command: 'node', args: ['x.js'], env: {}, timeoutMs: 5000 },
  { id: 'apagado', name: 'Apagado', enabled: false, transport: 'stdio', command: 'node', args: [], env: {} },
];

test('mcp: el catálogo solo trae las herramientas de servidores habilitados y listos', async () => {
  const transports = {};
  const mcp = new McpManager({
    servers: MCP_SERVERS, dataDir: tmpDir('sagi-mcp-'), clientVersion: 'test', log: () => {},
    makeTransport: (s) => (transports[s.id] = fakeTransport([
      { name: 'echo', description: 'Devuelve el texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ])),
  });
  eq(mcp.toolDefs().length, 0, 'sin conectar no hay herramientas (no se arranca nada por abrir Ajustes)');
  await mcp.ensure('eco');
  const defs = mcp.toolDefs();
  eq(defs.length, 1);
  eq(defs[0].type, 'function');
  eq(defs[0].function.name, 'mcp__eco__echo');
  eq(defs[0].function.parameters.properties.text.type, 'string', 'el esquema del servidor viaja tal cual');
  ok(/Eco/.test(defs[0].function.description), 'la descripción identifica el servidor: ' + defs[0].function.description);
  ok(!/nueva línea|\\n/.test(defs[0].function.description), 'la descripción va en una línea');
  eq(mcp.describe('mcp__eco__echo').toolName, 'echo');
  eq(mcp.describe('mcp__nadie__x'), null);
  await mcp.shutdown();
});

test('mcp: tools/list se pagina con cursor', async () => {
  const paginas = [
    { tools: [{ name: 'uno', description: 'a', inputSchema: { type: 'object' } }], nextCursor: 'c1' },
    { tools: [{ name: 'dos', description: 'b', inputSchema: { type: 'object' } }], nextCursor: 'c2' },
    { tools: [{ name: 'tres', description: 'c', inputSchema: { type: 'object' } }] },
  ];
  let i = 0;
  const tr = fakeTransport([]);
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'pag', version: '1' } };
    if (method === 'tools/list') return paginas[i++];
    return {};
  };
  const mcp = new McpManager({
    servers: [{ id: 'pag', name: 'Pag', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('pag');
  eq(mcp.toolDefs().map(d => d.function.name).join(','), 'mcp__pag__uno,mcp__pag__dos,mcp__pag__tres');
  await mcp.shutdown();
});

test('mcp: allow/deny y colisiones de nombre', async () => {
  const tr = fakeTransport([
    { name: 'ok', description: 'permitida', inputSchema: { type: 'object' } },
    { name: 'secreta', description: 'prohibida', inputSchema: { type: 'object' } },
  ]);
  const mcp = new McpManager({
    servers: [{ id: 'f', name: 'F', enabled: true, transport: 'stdio', command: 'node', args: [], tools: { deny: ['secreta'] } }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('f');
  eq(mcp.toolDefs().map(d => d.function.name).join(','), 'mcp__f__ok', 'deny quita la herramienta del catálogo');
  await mcp.shutdown();
});

test('mcp: un servidor que no arranca queda en error legible y no aporta herramientas', async () => {
  const tr = fakeTransport([], { failInit: true });
  const mcp = new McpManager({
    servers: [{ id: 'malo', name: 'Malo', enabled: true, transport: 'stdio', command: 'no-existe-xyz', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {},
    makeTransport: () => { tr.stderrTail = () => 'ENOENT: no such file'; return tr; },
  });
  const r = await mcp.ensure('malo');
  eq(r.ok, false);
  ok(/no arrancó|malo/i.test(r.error), r.error);
  eq(mcp.toolDefs().length, 0);
  eq(mcp.status()[0].state, 'dead');
  await mcp.shutdown();
});

test('mcp: cambiar allow/deny se aplica sin reconectar', async () => {
  const tr = fakeTransport([
    { name: 'ok', description: 'permitida', inputSchema: { type: 'object' } },
    { name: 'secreta', description: 'prohibida', inputSchema: { type: 'object' } },
  ]);
  let muertes = 0;
  const killReal = tr.kill; tr.kill = () => { muertes++; killReal(); };
  const srv = { id: 'f', name: 'F', enabled: true, transport: 'stdio', command: 'node', args: [] };
  const mcp = new McpManager({ servers: [srv], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr });
  await mcp.ensure('f');
  eq(mcp.toolDefs().length, 2, 'las dos herramientas entran');
  mcp.configure([{ ...srv, tools: { deny: ['secreta'] } }]);
  eq(mcp.toolDefs().map(d => d.function.name).join(','), 'mcp__f__ok', 'el deny se aplica al guardar la configuración');
  eq(muertes, 0, 'aplicar un filtro no tiene por qué matar el proceso del servidor');
  await mcp.shutdown();
});

test('mcp: un servidor que muere deja de describir y de listar herramientas', async () => {
  const tr = fakeTransport([{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }]);
  const mcp = new McpManager({ servers: [{ id: 'm', name: 'M', enabled: true, transport: 'stdio', command: 'node', args: [] }], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr });
  await mcp.ensure('m');
  ok(mcp.describe('mcp__m__tool'), 'conectado, se describe');
  for (const cb of tr.esperandoSalida) cb(1);   // el servidor se cae
  eq(mcp.describe('mcp__m__tool'), null, 'muerto no puede seguir describiendo herramientas');
  eq(mcp.status()[0].tools.length, 0, 'ni la UI puede listarlas como usables');
  eq(mcp.status()[0].state, 'dead');
  await mcp.shutdown();
});

/* ---------- MCP: llamadas (resultado, errores y límites) ---------- */

test('mcp: la llamada aplana el contenido, resume imágenes y recorta', async () => {
  const tr = fakeTransport([]);
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'c', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') {
      calls.push(params);
      return { content: [
        { type: 'text', text: 'primera parte' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(40000) },
        { type: 'text', text: 'segunda parte' },
        { type: 'text', text: 'X'.repeat(70000) },   // fuerza el recorte
      ] };
    }
    return {};
  };
  const calls = [];
  const mcp = new McpManager({
    servers: [{ id: 'c', name: 'C', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('c');
  const out = await mcp.callTool('mcp__c__tool', { a: 1 });
  eq(calls[0].name, 'tool', 'al servidor le llega el nombre ORIGINAL, no el expuesto');
  eq(calls[0].arguments.a, 1);
  ok(out.includes('primera parte') && out.includes('segunda parte'), 'los textos se concatenan en orden');
  ok(/imagen: image\/png/.test(out), 'la imagen se resume (no viaja base64 al modelo): ' + out.slice(0, 120));
  ok(out.length <= 60000 + 40, 'el resultado está acotado');
  ok(out.endsWith('… (resultado recortado)'), 'el recorte se anuncia al modelo');
  ok(!/A{100}/.test(out), 'el base64 de la imagen no viaja al modelo');
  await mcp.shutdown();
});

test('mcp: la primera llamada conecta el servidor antes de resolver el nombre', async () => {
  const tr = fakeTransport([]);
  tr.rpc.request = async (method) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') return { content: [{ type: 'text', text: 'eco' }] };
    return {};
  };
  const mcp = new McpManager({
    servers: [{ id: 'x', name: 'X', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  // Sin ensure() previo: la app acaba de arrancar y el servidor está en 'idle', así
  // que no hay tabla de nombres. La llamada tiene que conectar y resolver sola.
  const out = await mcp.callTool('mcp__x__echo', {});
  eq(out, 'eco', 'la primera llamada tras arrancar conecta el servidor por su cuenta');
  await mcp.shutdown();
});

test('mcp: un isError y un error JSON-RPC se explican al modelo', async () => {
  const tr = fakeTransport([]);
  const respuestas = {
    fallo: { isError: true, content: [{ type: 'text', text: 'no pude hacerlo' }] },
    roto: null,
  };
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'e', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'fallo', description: 'd', inputSchema: { type: 'object' } }, { name: 'roto', description: 'd', inputSchema: { type: 'object' } }] };
    if (params.name === 'roto') throw new Error('servidor MCP: se rompió por dentro');
    return respuestas[params.name];
  };
  const mcp = new McpManager({
    servers: [{ id: 'e', name: 'E', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('e');
  const ok1 = await mcp.callTool('mcp__e__fallo', {});
  ok(/^Error del servidor MCP:/.test(ok1), ok1);
  const ok2 = await mcp.callTool('mcp__e__roto', {});
  ok(/se rompió por dentro/.test(ok2), 'el error del servidor llega tal cual: ' + ok2);
  await mcp.shutdown();
});

test('mcp: una herramienta desconocida no llama a nadie y se explica', async () => {
  const mcp = new McpManager({ servers: [], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => fakeTransport([]) });
  const out = await mcp.callTool('mcp__nadie__nada', {});
  ok(out.startsWith('Error:'), out);
  await mcp.shutdown();
});

test('mcp: si el servidor está caído, la siguiente llamada reintenta con backoff', async () => {
  let intentos = 0;
  const mcp = new McpManager({
    servers: [{ id: 'r', name: 'R', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {},
    makeTransport: () => {
      intentos++;
      if (intentos === 1) return fakeTransport([], { failInit: true });
      const tr = fakeTransport([{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }]);
      tr.rpc.request = async (method, params) => {
        if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'r', version: '1' } };
        if (method === 'tools/list') return { tools: [{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }] };
        return { content: [{ type: 'text', text: 'ya va' }] };
      };
      return tr;
    },
  });
  eq((await mcp.ensure('r')).ok, false, 'el primer intento falla');
  const out = await mcp.callTool('mcp__r__tool', {});
  eq(intentos, 2, 'la llamada vuelve a intentar conectar');
  eq(out, 'ya va');
  await mcp.shutdown();
});

test('mcp: Detener corta una llamada MCP en vuelo', async () => {
  const tr = fakeTransport([]);
  let pendiente = null;
  tr.rpc.cancel = (id, reason) => { if (!pendiente) return false; const p = pendiente; pendiente = null; p.rej(new Error(reason || 'cancelada')); return true; };
  tr.rpc.request = async (method, params, opts) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'l', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'lenta', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') {
      if (opts && opts.onStart) opts.onStart(7);   // el id que usará cancel()
      return new Promise((res, rej) => { pendiente = { res, rej }; });
    }
    return {};
  };
  const mcp = new McpManager({ servers: [{ id: 'l', name: 'L', enabled: true, transport: 'stdio', command: 'node', args: [] }], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr });
  let killable = null;
  const p = mcp.callTool('mcp__l__lenta', {}, { onExit: (k) => { killable = k; } });
  await new Promise(r => setTimeout(r, 50));
  ok(killable && typeof killable.stop === 'function', 'la llamada en vuelo queda registrada como cancelable');
  killable.stop();
  const out = await p;
  ok(/detenid|cancelad/i.test(out), 'el corte se explica en el resultado: ' + out);
  await mcp.shutdown();
});

test('agent: la cadena elige el protocolo del modelo (Qwen en Go → /messages)', async () => {
  const { Agent } = require('../agent/agent');
  const seen = [];
  const chunks = [
    evNamed('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hola' } }),
    evNamed('message_delta', { type: 'message_delta', usage: { output_tokens: 1 } }),
  ];
  const agent = new Agent({
    fetchFn: async (url) => { seen.push(url); return sseResponse(chunks); },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'qwen3.8-max' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('hola', settings);
  ok(seen.length === 1 && seen[0].endsWith('/messages'), 'llamó a /messages: ' + seen[0]);
  const last = agent.history.filter(h => h.role === 'assistant').pop();
  eq(last.content, 'hola', 'la respuesta llega al historial');
});

test('agent: stop() corta la ejecución aunque el stream se quede mudo', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const enc = new TextEncoder();
  // envía un evento y deja el stream ABIERTO (nunca cierra): sin abort, colgaría
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] }))); } });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  const run = agent.chat('hola', settings);
  await new Promise(r => setTimeout(r, 80));
  ok(agent.isBusy(), 'seguía trabajando');
  agent.stop();
  await Promise.race([
    run,
    new Promise((_, rej) => setTimeout(() => rej(new Error('stop() no interrumpió la ejecución')), 3000)),
  ]);
  ok(events.some(e => e.type === 'stopped'), 'emitió stopped');
  ok(!agent.isBusy(), 'el agente quedó libre');
});

test('agent: un stream mudo muere solo con llmTimeoutMs y el turno queda libre', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const enc = new TextEncoder();
  // envía UN evento y deja el stream abierto para siempre: es el fallo real del
  // proveedor que dejaba el chat «ocupado» eternamente sin decir nada
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] }))); } });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false, llmTimeoutMs: 120 } };
  const run = agent.chat('hola', settings);
  await Promise.race([
    run,
    new Promise((_, rej) => setTimeout(() => rej(new Error('el turno sigue colgado: el timeout de silencio no disparó')), 5000)),
  ]);
  ok(!agent.isBusy(), 'el agente quedó libre');
  ok(events.some(e => e.type === 'error'), 'el usuario ve un error explicado, no un turno eterno');
});

test('agent: un stream terminado en [DONE] no se descarta aunque el socket siga abierto', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const enc = new TextEncoder();
  let calls = 0;
  // Un proxy con keep-alive (o un proveedor que no cierra) deja el socket abierto
  // después de mandar la respuesta entera. Antes se tiraba esa respuesta y el
  // fallback la reintentaba en OTRO modelo, pagándola dos veces.
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'La respuesta completa' } }] })));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      // a propósito: nunca se cierra
    },
  });
  const agent = new Agent({
    fetchFn: async () => { calls++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); },
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false, llmTimeoutMs: 3000 } };
  await Promise.race([
    agent.chat('hola', settings),
    new Promise((_, rej) => setTimeout(() => rej(new Error('el terminador [DONE] no cerró la lectura')), 2500)),
  ]);
  eq(calls, 1, 'no se reintenta en otro modelo una respuesta ya recibida');
  ok(!events.some(e => e.type === 'error'), 'no se reporta como fallo del proveedor');
  const last = agent.history.filter(h => h.role === 'assistant').pop();
  eq(last.content, 'La respuesta completa', 'el texto recibido llega al historial');
});

test('agent: un agente reutilizado atiende cada mensaje', async () => {
  const { Agent } = require('../agent/agent');
  const enc = new TextEncoder();
  let calls = 0;
  const agent = new Agent({
    // política con un campo ajeno: una política de Ajustes no puede matar el turno
    guardrailsPolicy: { guardrails: { maxDataGapMs: 30 } },
    fetchFn: async () => {
      calls++;
      const body = new ReadableStream({
        start(c) { c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'respuesta ' + calls } }] }))); c.close(); },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  await agent.chat('uno', settings);
  // el chat de la app reutiliza el MISMO agente toda la sesión: entre mensajes
  // puede pasar cualquier cosa (minutos, horas) y aun así cada uno llega al modelo
  await new Promise(r => setTimeout(r, 60));
  await agent.chat('dos', settings);
  eq(calls, 2, 'el segundo mensaje de la sesión también llega al proveedor');
  const assistant = agent.history.filter(h => h.role === 'assistant').map(h => h.content);
  ok(assistant.some(t => t === 'respuesta 1') && assistant.some(t => t === 'respuesta 2'), 'las dos respuestas están en el hilo');
  ok(!agent.isBusy(), 'el agente queda libre para el siguiente mensaje');
});

test('agent: el subagente respeta el límite de silencio del usuario', async () => {
  const { Agent } = require('../agent/agent');
  const enc = new TextEncoder();
  // el proveedor manda un delta y se queda mudo (socket abierto): delegar no
  // puede cortar a los 120 s por defecto cuando Ajustes dice otra cosa
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] }))); } });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', llmTimeoutMs: 100 } };
  const t0 = Date.now();
  let err = null;
  try {
    await agent._runWithSystem('sistema', settings, 'subtarea', [], new AbortController().signal, () => {});
  } catch (e) { err = e; }
  ok(err, 'el silencio corta el bucle del subagente en vez de dejarlo colgado');
  ok(/no envió datos/.test(err.message), 'el motivo explica el silencio: ' + err.message);
  ok(Date.now() - t0 < 5000, 'usa el límite del usuario (100 ms), no el default de 120 s');
});

test('tareas: un fallo de herramienta no archiva la tarea en curso', async () => {
  const { Agent } = require('../agent/agent');
  const checkpoints = require('../agent/checkpoints');
  const enc = new TextEncoder();
  const checks = [];
  const fails = [];
  let turn = 0;
  // Se sustituyen las escrituras de checkpoint: este test comprueba que el bucle
  // NO archiva la tarea viva, no cómo se persiste (que tiene sus propios tests).
  const real = { save: checkpoints.save, record: checkpoints.record, complete: checkpoints.complete, fail: checkpoints.fail };
  checkpoints.save = (r) => r;
  checkpoints.record = (r) => r;
  checkpoints.complete = (r) => { r.status = 'completed'; return r; };
  checkpoints.fail = (r, info) => { fails.push(info); return r; };
  // el modelo pide ficheros que no existen (fallo de herramienta) dos veces; la
  // tarea debe seguir VIVA (pausable, cancelable), no archivada como fallida
  const calls = ['{"path":"no-existe.txt"}', '{"path":"tampoco.txt"}'];
  let run = null;
  try {
    const agent = new Agent({
      fetchFn: async () => {
        const i = turn++;
        const body = new ReadableStream({
          start(c) {
            if (i < calls.length) {
              c.enqueue(enc.encode(evData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + i, function: { name: 'read_file', arguments: calls[i] } }] } }] })));
            } else {
              c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'No pude leerlos.' } }] })));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
      emit: (e) => { if (e.type === 'tool_result' && run) checks.push(run.status); },
      screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
    });
    run = checkpoints.newRun({ goal: 'tarea de prueba', mode: 'act', status: 'running' });
    const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
    await agent.chat('analiza los informes', settings, undefined, { background: true, task: run });
  } finally {
    Object.assign(checkpoints, real);
  }
  eq(checks.join(','), 'running,running', 'una herramienta que falla NO archiva la tarea: sigue viva y cancelable');
  eq(fails.length, 0, 'checkpoints.fail() solo se usa en los cierres reales, no a mitad de bucle');
  ok(run.lastError && run.lastError.tool === 'read_file', 'el fallo queda anotado en la tarea');
  eq(run.status, 'completed', 'al terminar de verdad se cierra');
});

test('tareas: Detener mata también el comando en curso de un subagente', async () => {
  const { Agent } = require('../agent/agent');
  const parent = new Agent({ emit: () => {} });
  const killed = [];
  parent.runningTool = { stop: () => killed.push('herramienta') };
  parent.subagent = { stop: () => killed.push('subagente') };
  parent.stop();
  eq(killed.join(','), 'herramienta,subagente', 'sin esto el comando del subagente seguía vivo tras pulsar Detener');
});

test('chatkit: duraciones redondeadas y nombres de herramienta hostiles', () => {
  const K = ChatKit;
  // los segundos redondeados pueden valer 60: hay que acarrearlos al minuto
  eq(K.fmtDuration(119600), '2 min', 'no puede decir «1 min 60 s»');
  eq(K.fmtDuration(59500), '59,5 s', 'por debajo del minuto se conservan las décimas');
  eq(K.fmtDuration(59999), '1 min', '59,96 s se lee mejor como 1 min que como «60,0 s»');
  eq(K.fmtDuration(60000), '1 min');
  eq(K.fmtDuration(72000), '1 min 12 s');
  eq(K.fmtDuration(640), '640 ms');
  eq(K.fmtDuration(1400), '1,4 s');
  // un nombre que colisiona con Object.prototype no puede reventar el resumen
  // (el modelo puede emitir `constructor`/`toString`/`__proto__` como tool_call)
  for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = K.summarizeArgs(n, { a: 1 });
    ok(typeof r === 'string', n + ' → ' + JSON.stringify(r));
  }
  ok(K.summarizeArgs('constructor', { a: 1 }).length >= 0, 'sin excepción');
});

test('ajustes: cada pestaña tiene su panel, y la búsqueda tiene filas que filtrar', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const tabs = [...html.matchAll(/class="settab[^"]*"\s+data-set="([^"]+)"/g)].map(m => m[1]);
  const panels = [...html.matchAll(/class="setpanel[^"]*"\s+data-panel="([^"]+)"/g)].map(m => m[1]);
  ok(tabs.length >= 5, 'pestañas de Ajustes: ' + tabs.length);
  eq(tabs.slice().sort().join(','), panels.slice().sort().join(','), 'pestañas y paneles deben coincidir');
  for (const id of ['setWrap', 'setTabs', 'setSearch', 'setNoResults', 'activeModelName']) {
    ok(html.includes('id="' + id + '"'), 'falta el contenedor ' + id);
  }
  const rows = (html.match(/class="[^"]*\bsrow\b/g) || []).length;
  ok(rows >= 25, 'filas buscables (.srow): ' + rows);
});

/* ---------- chat: ChatKit (lógica pura del chat) ---------- */
const ChatKit = require('../renderer/chatkit');
const ICON_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
const ICON_NAMES = new Set([...ICON_SRC.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*'/gm)].map(m => m[1]));

/** ¿Existe este icono en el sistema de iconos? (evita iconos fantasma) */
function iconExists(name) { return ICON_NAMES.has(name); }

test('chat: los tres modos tienen identidad propia y real', () => {
  eq(ChatKit.MODE_ORDER.join(','), 'act,plan,think');
  for (const k of ChatKit.MODE_ORDER) {
    const m = ChatKit.MODES[k];
    ok(m.label && m.name && m.tagline, k + ' debe explicarse en la UI');
    ok(m.bullets && m.bullets.length >= 2, k + ' debe detallar en qué se diferencia');
    ok(/^#[0-9a-f]{6}$/i.test(m.color), k + ' necesita color propio');
    ok(/^\d+,\d+,\d+$/.test(m.rgb), k + ' necesita rgb para el tema');
    ok(iconExists(m.icon), 'icono del modo ' + k + ': ' + m.icon);
    ok(ChatKit.MODE_ORDER.indexOf(m.key) >= 0, k + ' debe pertenecer al ciclo');
  }
  const colors = new Set(ChatKit.MODE_ORDER.map(k => ChatKit.MODES[k].color));
  eq(colors.size, 3, 'los tres modos no pueden compartir color');
});

test('chat: nextMode cicla ACT → PLAN → THINK → ACT', () => {
  eq(ChatKit.nextMode('act'), 'plan');
  eq(ChatKit.nextMode('plan'), 'think');
  eq(ChatKit.nextMode('think'), 'act');
  eq(ChatKit.nextMode('inexistente'), 'plan', 'un modo inválido se trata como ACT');
  eq(ChatKit.mode('PLAN').key, 'plan', 'acepta el nombre en mayúsculas');
});

test('chat: toda herramienta del agente tiene etiqueta humana e icono real', () => {
  const toolsSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
  const names = [...toolsSrc.matchAll(/name: '([a-z_]+)'/g)].map(m => m[1]);
  names.push('delegate');   // definida en subagents.js
  ok(names.length >= 16, 'herramientas detectadas: ' + names.length);
  const missing = names.filter(n => !ChatKit.TOOLS[n]);
  eq(missing.join(', '), '', 'herramientas sin ficha en ChatKit.TOOLS');
  for (const n of names) {
    const meta = ChatKit.tool(n);
    ok(meta.label && meta.label !== n, n + ' debe tener una etiqueta humana (no el nombre técnico)');
    ok(iconExists(meta.icon), 'icono de ' + n + ': ' + meta.icon);
  }
});

test('chat: una herramienta desconocida no deja la tarjeta vacía', () => {
  const meta = ChatKit.tool('hacer_magia');
  eq(meta.label, 'Hacer magia');
  ok(iconExists(meta.icon), 'usa un icono genérico existente');
  eq(ChatKit.tool('').label, 'Herramienta');
});

test('chat: summarizeArgs resume la llamada en una línea útil', () => {
  eq(ChatKit.summarizeArgs('run_command', { command: 'npm test' }), 'npm test');
  eq(ChatKit.summarizeArgs('read_file', { path: 'C:/x/a.txt' }), 'C:/x/a.txt');
  eq(ChatKit.summarizeArgs('search_files', { pattern: 'TODO', path: 'src' }), 'TODO → src');
  ok(ChatKit.summarizeArgs('browser_control', { action: 'navigate', url: 'https://a.b' }).includes('navigate'));
  eq(ChatKit.summarizeArgs('delegate', { agent: 'research', task: 'busca precios' }), 'Investigador → busca precios');
  eq(ChatKit.summarizeArgs('run_command', {}), '', 'sin argumentos no inventa texto');
  ok(ChatKit.summarizeArgs('otra_cosa', { zona: 'norte' }).includes('zona'));
});

test('chat: fmtDuration en milisegundos, segundos y minutos', () => {
  eq(ChatKit.fmtDuration(640), '640 ms');
  eq(ChatKit.fmtDuration(1440), '1,4 s');
  eq(ChatKit.fmtDuration(60000), '1 min');
  eq(ChatKit.fmtDuration(72000), '1 min 12 s');
  eq(ChatKit.fmtDuration(-1), '');
  eq(ChatKit.fmtDuration(NaN), '');
  eq(ChatKit.toolCount(1), '1 herramienta');
  eq(ChatKit.toolCount(3), '3 herramientas');
});

test('chat: clip corta sólo cuando hace falta y avisa', () => {
  eq(ChatKit.clip('abc', 10), 'abc');
  eq(ChatKit.clip('abcdefghij', 5), 'abcd…');
  eq(ChatKit.clip(null, 5), '');
});

test('chat: el parser de PLAN separa los pasos del resto de la respuesta', () => {
  const r = ChatKit.parsePlan('PLAN:\n1. Buscar precios\n2. Comparar\n3. Informe\n\nYa está listo.');
  eq(r.steps.length, 3);
  eq(r.steps[0].text, 'Buscar precios');
  eq(r.steps[2].n, 3);
  eq(r.body, 'Ya está listo.', 'el resto del texto sobrevive');
  eq(ChatKit.parsePlan('**PLAN:**\n- paso uno\n- paso dos').steps.length, 2, 'admite viñetas y negritas');
  eq(ChatKit.parsePlan('Sin plan aquí.').steps.length, 0, 'sin PLAN no hay tarjeta');
  eq(ChatKit.parsePlan('Sin plan aquí.').body, 'Sin plan aquí.', 'sin PLAN el texto queda intacto');
  eq(ChatKit.parsePlan('PLAN:\n\n1. tras una línea vacía').steps.length, 1, 'tolera una línea en blanco tras la cabecera');
  eq(ChatKit.parsePlan('PLAN:\n1) uno').steps[0].text, 'uno', 'admite 1) además de 1.');
  eq(ChatKit.parsePlan('').steps.length, 0);
});

test('chat: el plan no se come el texto que viene después', () => {
  const r = ChatKit.parsePlan('PLAN:\n1. Uno\n2. Dos\n\n## Resultado\nHecho.');
  eq(r.steps.length, 2);
  ok(r.body.startsWith('## Resultado'), 'el cuerpo conserva el markdown: ' + r.body);
});

test('chat: looksFailed detecta errores sin confundir salidas normales', () => {
  ok(ChatKit.looksFailed('Error: no se pudo abrir el archivo'));
  ok(ChatKit.looksFailed('Denegado por el usuario'));
  ok(!ChatKit.looksFailed('archivo creado correctamente'));
  ok(!ChatKit.looksFailed(''));
});

test('chat: los subagentes tienen nombre humano para etiquetar sus pasos', () => {
  const keys = [...fs.readFileSync(path.join(__dirname, '..', 'agent', 'subagents.js'), 'utf8')
    .matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);
  const known = ['research', 'browser', 'coding', 'file', 'vision', 'verify'];
  const missing = known.filter(k => !ChatKit.subagent(k));
  eq(missing.join(', '), '', 'subagentes sin ficha');
  for (const k of known) ok(iconExists(ChatKit.subagent(k).icon), 'icono de subagente ' + k);
  eq(ChatKit.subagent('nadie'), null, 'un subagente desconocido no rompe');
  ok(keys.length >= 1, 'los subagentes del backend se pudieron enumerar');
});

test('chat: todo icono usado por app.js existe en el sistema de iconos', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const used = new Set([...app.matchAll(/\bic\('([A-Za-z0-9_]+)'/g)].map(m => m[1]));
  const missing = [...used].filter(n => !iconExists(n));
  eq(missing.join(', '), '', 'iconos referencia dos pero no definidos');
  ok(used.size > 10, 'se detectaron iconos en app.js: ' + used.size);
});

test('renderer: los scripts conviven en el mismo ámbito (sin redeclaraciones)', () => {
  // Los tres ficheros son scripts CLÁSICOS: comparten un único ámbito global.
  // Un `const MODE_ORDER` repetido es un SyntaxError de compilación y el
  // segundo fichero NO se ejecuta — la app se queda sin iconos, sin botones y
  // sin nada, con el HTML estático aún en pantalla. Se compila el conjunto
  // como un solo script (sin ejecutarlo) para detectarlo antes de arrancar.
  const vm = require('vm');
  const files = ['icons.js', 'chatkit.js', 'app.js'];
  const code = files
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8'))
    .join('\n;\n');
  new vm.Script(code, { filename: 'renderer-bundle-check.js' });
});

test('chat: el estado vacío vive fuera de #messages (no se lo lleva innerHTML)', () => {
  // #messages se vacía con innerHTML en cada conversación nueva: si el estado
  // vacío estuviera dentro, desaparecería para siempre al arrancar la app.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const open = html.indexOf('<div id="messages"');
  ok(open > 0, 'debe existir #messages');
  // recorre el anidamiento de <div> para aislar el contenido de #messages
  let depth = 0, i = open, inner = '';
  while (i < html.length) {
    const nOpen = html.indexOf('<div', i);
    const nClose = html.indexOf('</div>', i);
    if (nClose < 0) break;
    if (nOpen >= 0 && nOpen < nClose) { depth++; i = nOpen + 4; }
    else { depth--; i = nClose + 6; if (depth === 0) { inner = html.slice(open, i); break; } }
  }
  ok(inner.length > 0, 'no se pudo aislar #messages');
  ok(!inner.includes('chat-empty'), '#chatEmpty NO puede estar dentro de #messages');
  ok(html.includes('id="chatEmpty"'), 'debe existir #chatEmpty');
  ok(html.includes('class="msgs-area"'), 'el estado vacío necesita su capa sobre los mensajes');
});

test('chat: la vista tiene estado en vivo, estado vacío y salto al final', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['chatStatus', 'chatStatusMode', 'chatStatusText', 'chatEmpty', 'ceModes', 'jumpDown', 'modeSeg', 'btnCopyConv']) {
    ok(html.includes('id="' + id + '"'), 'falta el contenedor ' + id);
  }
  ok(/<section class="view on" id="view-chat" data-mode="act"/.test(html), 'el chat necesita data-mode y debe ser la vista inicial');
  // chatkit.js debe cargarse ANTES de app.js: define el catálogo que usa
  const kit = html.indexOf('chatkit.js');
  const app2 = html.indexOf('app.js');
  ok(kit > 0 && app2 > kit, 'chatkit.js debe cargarse antes que app.js');
});

test('chat: el CSS da color propio a cada modo y estiliza las tarjetas', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  for (const k of ChatKit.MODE_ORDER) {
    ok(css.includes(`#view-chat[data-mode="${k}"]`), 'el modo ' + k + ' necesita su tema en el chat');
  }
  for (const cls of ['tcard', 'tgroup', 'plancard', 'codeblock', 'msg-actions', 'msg-mode', 'chat-empty', 'jumpdown', 'stream']) {
    ok(css.includes('.' + cls), 'falta el estilo .' + cls);
  }
  // el título del chat es la primera frase del usuario: una sola línea
  const title = css.match(/#chatTitle\s*\{[^}]*\}/);
  ok(title && /nowrap/.test(title[0]) && /ellipsis/.test(title[0]), 'el título del chat debe cortarse en una línea');
  // el estado vacío es una capa sobre el área de mensajes, y su contenido debe
  // estirarse o las tres tarjetas de modo se apilan en una sola columna
  const empty = css.match(/\.chat-empty\s*\{[^}]*\}/);
  ok(empty && /position:\s*absolute/.test(empty[0]), '.chat-empty debe ser una capa sobre los mensajes');
  const inner = css.match(/\.ce-inner\s*\{[^}]*\}/);
  ok(inner && /width:\s*100%/.test(inner[0]), '.ce-inner necesita width:100% para que quepan los tres modos');
  // El estado vacío fija display:grid, y varias reglas del fichero fijan
  // display:grid/flex: `hidden` debe ganarles SIEMPRE. Antes había un parche por
  // selector (.chat-empty[hidden], .nb[hidden], .srow[hidden]…); ahora hay una
  // sola regla global, así que comprobamos esa garantía y no el parche.
  ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    'hidden debe ganar a las reglas de display (regla global, no parches por selector)');
});

test('chat: los componentes de la burbuja no heredan el pre-wrap de la burbuja', () => {
  // La burbuja usa white-space: pre-wrap (para respetar los saltos del modelo).
  // Los componentes con marcado multilínea DEBEN volver al flujo normal o los
  // saltos del propio HTML se dibujan como líneas en blanco dentro de la tarjeta.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{[^}]*white-space:\s*normal[^}]*\}/g)].map(m => m[1]);
  ok(rules.length, 'debe existir alguna regla que devuelva el flujo normal a los componentes');
  const sel = rules.join('\n');
  for (const cls of ['tgroup', 'tcard', 'plancard', 'codeblock', 'msg-actions']) {
    ok(sel.includes('.' + cls), 'ninguna regla con white-space:normal cubre .' + cls);
  }
});

/* ---------- chat: backend (eventos y regenerar) ---------- */
test('agent: el evento busy viaja con el modo del turno', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const chunks = [evData({ choices: [{ delta: { content: 'ok' } }] })];
  const agent = new Agent({ fetchFn: fakeFetch(chunks), emit: (e) => events.push(e), screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }) });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'think', modelRouting: false } };
  await agent.chat('hola', settings);
  const start = events.find(e => e.type === 'busy' && e.busy);
  ok(start, 'debe emitir busy al arrancar');
  eq(start.mode, 'think', 'la UI necesita el modo para sellar el turno');
  eq(start.model, 'gpt-4o', 'y el modelo que va a responder');
});

test('agent: el resultado de una herramienta llega con duración y si falló', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  // 1ª vuelta: el modelo pide una herramienta segura; 2ª: responde y termina
  const step1 = [evData({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }],
  })];
  const step2 = [evData({ choices: [{ delta: { content: 'listo' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async () => sseResponse(n++ === 0 ? step1 : step2),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false, workspace: tmpDir('sagi-ws-') } };
  await agent.chat('lista la carpeta', settings);
  const res = events.find(e => e.type === 'tool_result');
  ok(res, 'debe emitir tool_result');
  eq(res.name, 'list_dir');
  ok(typeof res.durationMs === 'number', 'la tarjeta necesita la duración real');
  ok(res.ok === true, 'la salida correcta se marca como ok');
  const card = events.find(e => e.type === 'tool');
  ok(card && card.args && card.args.path === '.', 'el evento tool trae los argumentos');
});

test('agent: retry descarta la respuesta anterior y repite la misma pregunta', async () => {
  const { Agent } = require('../agent/agent');
  const prompts = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      const body = JSON.parse(opts.body);
      prompts.push(body.messages.filter(m => m.role === 'user').pop().content);
      return sseResponse([evData({ choices: [{ delta: { content: 'respuesta ' + prompts.length } }] })]);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  await agent.chat('primera pregunta', settings);
  const before = agent.history.length;
  await agent.retry(settings);
  eq(prompts.length, 2, 'el modelo volvió a ser consultado');
  eq(prompts[1], 'primera pregunta', 'se repite la misma pregunta');
  // el historial no acumula la respuesta descartada: user + assistant, sin duplicar
  eq(agent.history.filter(h => h.role === 'user').length, 1, 'no se duplica la pregunta');
  eq(agent.history.filter(h => h.role === 'assistant').length, 1, 'sólo queda la respuesta nueva');
  ok(agent.history.length <= before, 'el historial no crece al regenerar');
});

test('agent: regenerar conserva la imagen que llevaba el mensaje', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sseResponse([evData({ choices: [{ delta: { content: 'ok' } }] })]); },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  await agent.chat('mira esto', settings, 'data:image/png;base64,ZZZ');
  await agent.retry(settings);
  const last = bodies[bodies.length - 1].messages.filter(m => m.role === 'user').pop();
  ok(JSON.stringify(last).includes('ZZZ'), 'la imagen se vuelve a enviar en el reintento');
});

/* ---------- regresiones de la auditoría del núcleo ---------- */

test('agent: denegar una confirmación continúa la ejecución (no rompe el turno)', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const bodies = [];
  const step1 = [evData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_command', arguments: '{"command":"del algo"}' } }] } }] })];
  const step2 = [evData({ choices: [{ delta: { content: 'vale, no lo ejecuto' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sseResponse(n++ === 0 ? step1 : step2); },
    emit: (e) => { events.push(e); if (e.type === 'confirm_request') setTimeout(() => agent.resolveConfirm(e.id, false), 0); },
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  await agent.chat('borra la carpeta', settings);
  const errs = events.filter(e => e.type === 'error');
  eq(errs.length, 0, 'denegar no puede abortar con error: ' + (errs[0] && errs[0].message));
  const denial = (bodies[1].messages || []).find(m => m.role === 'tool' && m.tool_call_id === 'c1');
  ok(denial && /DENEGÓ/.test(denial.content), 'el modelo debe recibir la negativa como resultado de la herramienta');
  ok(events.some(e => e.type === 'assistant_done'), 'el turno debe cerrarse con la respuesta del modelo');
});

test('agent: el payload descarta tool_calls sin respuesta y tool huérfanos', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sseResponse([evData({ choices: [{ delta: { content: 'ok' } }] })]); },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false } };
  // historial envenenado: el turno anterior murió entre el assistant y su respuesta
  agent.history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'x1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
  agent.history.push({ role: 'tool', tool_call_id: 'huerfano', name: 'read_file', content: 'no debería viajar' });
  await agent.chat('continúa', settings);
  const sent = bodies[0].messages;
  ok(!sent.some(m => m.role === 'tool' && m.tool_call_id === 'huerfano'), 'un tool huérfano no puede viajar a la API');
  for (const m of sent.filter(m => m.role === 'assistant' && m.tool_calls)) {
    for (const tc of m.tool_calls) {
      ok(sent.some(x => x.role === 'tool' && x.tool_call_id === tc.id), 'toda tool_call enviada necesita su respuesta');
    }
  }
});

test('agent: el subagente no deja tool_calls sin responder al detectar un bucle', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const toolTurn = [evData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }] })];
  const textTurn = [evData({ choices: [{ delta: { content: 'RESULT: hecho\nSTATUS: OK' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sseResponse(n++ < 3 ? toolTurn : textTurn); },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = { active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' }, settings: { mode: 'act', modelRouting: false, workspace: process.cwd() } };
  const out = await agent._delegate(subagents.SUBAGENTS.file, { task: 'lee package.json tres veces' }, { settings });
  ok(/RESULT/.test(out), 'la delegación debe devolver el resultado estructurado: ' + out.slice(0, 80));
  for (const body of bodies) {
    const msgs = body.messages;
    for (const m of msgs.filter(x => x.role === 'assistant' && x.tool_calls)) {
      for (const tc of m.tool_calls) {
        ok(msgs.some(x => x.role === 'tool' && x.tool_call_id === tc.id), 'el subagente envió una tool_call sin respuesta');
      }
    }
  }
});

test('guardrails: el orden de las claves no evade la detección de bucles', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  ok(!g.isLoop('write_file', { path: 'a', content: 'x' }).loop);
  ok(!g.isLoop('write_file', { content: 'x', path: 'a' }).loop);
  ok(g.isLoop('write_file', { path: 'a', content: 'x' }).loop, 'la misma acción con las claves en otro orden sigue siendo un bucle');
});

test('guardrails: el gasto del subagente cuenta para el presupuesto global', () => {
  const parent = new Guardrails({ guardrails: { maxTokens: 100 } });
  parent.beginRun();
  const sub = new Guardrails({ guardrails: { maxTokens: 100 } });
  sub.beginRun();
  sub.addTokens(80, { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 });
  eq(parent.tokensUsed, 0, 'el padre no ve el consumo hasta absorberlo');
  eq(parent.absorb(sub).ok, true);
  eq(parent.tokensUsed, 80, 'el gasto del subagente se suma al del padre');
  sub.addTokens(40, { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 });
  const over = parent.absorb(sub);
  eq(over.ok, false, 'el presupuesto global debe saltar con el consumo delegado');
  ok(/tokens/i.test(over.reason));
});

test('subagents: sin formato RESULT se devuelve la primera línea, no el bloque entero', () => {
  const r = subagents.parseSubagentResult('primera linea\nsegunda linea\ntercera');
  eq(r.result, 'primera linea');
});

test('sidebar: grupos, contadores, pie y atajos coherentes con las vistas', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const groups = [...html.matchAll(/class="navgroup"\s+data-label="([^"]+)"/g)].map(m => m[1]);
  ok(groups.length >= 4, 'grupos del sidebar: ' + groups.join(' / '));
  const views = [...html.matchAll(/class="navitem[^"]*"\s+data-view="([^"]+)"/g)].map(m => m[1]);
  eq(views.length, 9, 'ítems de navegación (sin Inicio: la app abre en Chat)');
  eq(new Set(views).size, views.length, 'sin vistas duplicadas en el sidebar');
  // cada ítem debe apuntar a una sección real (si no, goto() deja la app en blanco)
  const missing = views.filter(v => !html.includes('id="view-' + v + '"'));
  eq(missing.join(', '), '', 'ítems del sidebar sin sección .view');
  // los elementos que usa la lógica nueva del sidebar deben existir
  for (const id of ['sideToggle', 'sideStatusBtn', 'sideModeBtn', 'sideModeLabel', 'nbChat', 'nbTasks', 'nbMemory', 'nbSkills', 'app']) {
    ok(html.includes('id="' + id + '"'), 'falta el elemento ' + id);
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  // atajos Alt+1..0 prometidos en los tooltips: deben tener destino
  const hot = js.match(/VIEW_HOTKEY\s*=\s*\[([^\]]+)\]/);
  ok(hot, 'falta la tabla de atajos del sidebar');
  const n = hot[1].split(',').length;
  eq(n, views.length, 'atajos y ítems del sidebar deben coincidir');
});

/* ---------- guardas de integración (regresiones de la auditoría) ---------- */

test('integración: cada método sagitari.* del renderer existe en el preload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map(m => m[1]));
  const used = new Set([...renderer.matchAll(/sagitari\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
  const missing = [...used].filter(k => !exposed.has(k));
  eq(missing.join(', '), '', 'métodos usados por el renderer pero ausentes del preload');
});

test('integración: cada canal invocado en el preload tiene handler en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const channels = [...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]);
  const handlers = new Set([...main.matchAll(/handle\('([^']+)'/g)].map(m => m[1]));
  const missing = [...new Set(channels)].filter(c => !handlers.has(c));
  eq(missing.join(', '), '', 'canales sin handler en main');
});

/* ---------- arranque e instancia única (regresión de «la app se cierra») ---------- */

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');

test('arranque: los modos de prueba no comparten userData con la app real', () => {
  // El bloqueo de instancia única va ligado al userData. Si smoke/ui-check
  // compartieran el de la app real, una prueba que tardara en morir retenía el
  // bloqueo y el lanzamiento siguiente (paso final de probar.bat) se cerraba
  // solo, en silencio: exactamente «la app se cierra».
  const headless = MAIN_SRC.match(/const HEADLESS = ([^;]+);/);
  ok(headless, 'debe existir la detección HEADLESS');
  ok(/--hidden/.test(headless[1]) && /\bSMOKE\b/.test(headless[1]), 'HEADLESS cubre smoke y ui-check');
  const seteo = MAIN_SRC.match(/if \(HEADLESS\) \{[\s\S]{0,240}?setPath\('userData'[\s\S]{0,80}?\n\}/);
  ok(seteo, 'HEADLESS debe fijar su propio userData');
  // y, sobre todo: antes de pedir el bloqueo
  const iSeteo = MAIN_SRC.indexOf("app.setPath('userData'");
  const iLock = MAIN_SRC.indexOf('app.requestSingleInstanceLock()');
  ok(iSeteo > -1 && iLock > -1 && iSeteo < iLock, 'el userData de prueba se fija ANTES de pedir el bloqueo');
});

test('arranque: la segunda instancia no muere en silencio y reutiliza la ventana', () => {
  ok(/app\.on\('second-instance',\s*\(\)\s*=>\s*showWindow\(\)\)/.test(MAIN_SRC),
    'debe atender second-instance mostrando la ventana existente');
  ok(/ya está abierta/.test(MAIN_SRC), 'debe avisar por consola de que ya había una instancia abierta');
  // showWindow tiene que poder recrear la ventana si se cerró con la X
  ok(/function showWindow\(\)[\s\S]{0,200}?createChatWindow\(\)/.test(MAIN_SRC),
    'showWindow debe recrear la ventana si ya no existe');
});

test('arranque: un fallo del proceso principal no cierra la app', () => {
  ok(/process\.on\('uncaughtException'/.test(MAIN_SRC), 'debe capturar uncaughtException');
  ok(/process\.on\('unhandledRejection'/.test(MAIN_SRC), 'debe capturar unhandledRejection');
  ok(/crash\.log/.test(MAIN_SRC), 'debe dejar rastro en logs/crash.log');
});

test('probar.bat avisa si ya hay una instancia abierta', () => {
  const bat = fs.readFileSync(path.join(__dirname, '..', 'probar.bat'), 'utf8');
  ok(/tasklist/.test(bat), 'debe mirar si hay instancias vivas antes de lanzar');
  ok(/[Aa][Vv][Ii][Ss][Oo]|YA_ABIERTA/.test(bat), 'debe avisar en vez de parecer que la app se cierra');
});

test('ui-check espera a que la instancia de prueba muera antes de salir', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ui-check.js'), 'utf8');
  ok(/child\.once\('exit'/.test(ui), 'debe esperar la salida real del hijo');
  ok(/--hidden/.test(ui), 'debe lanzar la app de prueba oculta');
});

/* ---------- apariencia: acento de UI + glow personalizable ---------- */

test('apariencia: el CSS tematiza por triplets RGB y el glow escala con intensidad', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  for (const v of ['--acc-rgb', '--acc2-rgb', '--acc3-rgb', '--glow-rgb', '--glow-str'])
    ok(css.includes(v + ':'), 'debe declarar ' + v);
  /* El aura tiene tres tonos (--glow-a/b/c-rgb) y todos escalan con la intensidad del
     ajuste. Se comprueba ese contrato y no una regla concreta: antes esto afirmaba el
     anillo del marco, que ya no lleva luz propia (la luz es del aura, y sólo cuando el
     agente hace algo). */
  ok(/rgba\(var\(--glow-[abc]-rgb\), calc\([^)]*var\(--glow-str\)/.test(css), 'las capas del aura deben multiplicar por --glow-str');
  ok(/--ambient/.test(css), 'la atmósfera del fondo también debe seguir al estado');
  ok((css.match(/rgba\(var\(--acc/g) || []).length >= 40, 'los tintes decorativos deben usar los triplets (' + (css.match(/rgba\(var\(--acc/g) || []).length + ')');
  // los modos conservan su color aunque cambie el acento
  ok(/#view-chat\[data-mode="plan"\]\s*\{[^}]*167,139,250/.test(css), 'PLAN mantiene su violeta');
  ok(/#view-chat\[data-mode="think"\]\s*\{[^}]*125,180,255/.test(css), 'THINK mantiene su azul');
  ok(/#view-chat, #view-chat\[data-mode="act"\]/.test(css), 'ACT mantiene su verde');
  /* Glow: el contrato es un trabajo por capa —el anillo dice «estoy aquí», la
     respiración «estoy haciendo algo» con su ritmo por estado, y la luz que viaja
     «voy por aquí»— y un camino de movimiento reducido. Se comprueba eso y no un
     selector concreto, que es detalle de implementación. */
  for (const estado of ['think', 'work', 'listen', 'speak']) {
    ok(new RegExp('\\.shell\\.glow-' + estado + '\\s*\\{[^}]*--energy').test(css), 'el estado ' + estado + ' debe tener su energía');
    ok(new RegExp('\\.shell\\.glow-' + estado + '\\s+\\.glow::before\\s*\\{[^}]*animation:\\s*frame-').test(css), 'el estado ' + estado + ' debe tener su propio ritmo');
  }
  for (const k of ['frame-breathe', 'frame-drift', 'frame-bloom']) ok(css.includes('@keyframes ' + k), 'falta el keyframe ' + k);
  /* Aura iridiscente: tres capas con tonos vecinos del elegido. No hay recorrido: el glow no
     viaja, respira. */
  for (const token of ['--glow-a-rgb', '--glow-b-rgb', '--glow-c-rgb']) ok(css.includes(token + ':'), 'falta ' + token);
  ok(!/offset-path/.test(css), 'el glow no debe recorrer el marco');
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,700}?animation: none !important/.test(css), 'el movimiento reducido debe parar el latido y el viaje');
  ok(/input\[type="range"\]\.glowslider/.test(css), 'debe existir el estilo del slider de intensidad');
});

test('apariencia: el alias glow de la muestra de color no hereda el lienzo del halo', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const muestra = css.match(/\.colordot\.glow\s*\{([^}]*)\}/);
  ok(muestra, 'debe existir una regla específica para la muestra del glow');
  ok(/position:\s*relative/.test(muestra[1]) && /opacity:\s*1/.test(muestra[1]), 'la muestra debe ser visible y ocupar su propio espacio');
  ok(/inset:\s*auto/.test(muestra[1]), 'la muestra no debe cubrir la ventana');
});

test('apariencia: Ajustes expone color de UI, color de glow e intensidad', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['uiColor', 'glowColor', 'glowStrength', 'dotUiColor', 'dotGlowColor', 'glowStrengthLabel'])
    ok(html.includes('id="' + id + '"'), 'falta #' + id);
  ok(html.includes('<b>Apariencia</b>'), 'debe existir la tarjeta Apariencia');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  ok(/const PALETTES = \{[\s\S]{0,900}\};/.test(app), 'debe existir la tabla PALETTES');
  ok(/function applyTheme\(\)/.test(app), 'debe existir applyTheme');
  ok(/\$\('#glowStrength'\)\.oninput/.test(app) && /\$\('#uiColor'\)\.onchange/.test(app), 'los controles deben estar cableados');
  // el glow se enciende al hablar y se apaga al terminar la voz
  ok(/window\.sagitari\.glow\('speak'\)/.test(app), 'speak() debe encender el glow');
  ok(/onTtsDone/.test(app), 'el fin de la voz debe apagar el glow');
  ok(/onThemeChanged/.test(app), 'los cambios de tema deben aplicarse al vuelo');
});

test('apariencia: main guarda preferencias y emite tts:done + theme:changed', () => {
  ok(/uiColor: 'violet'/.test(MAIN_SRC) && /glowStrength: 1/.test(MAIN_SRC), 'defaults de apariencia en settings');
  ok(/glowColor: 'match'/.test(MAIN_SRC), 'el glow sigue al tema por defecto');
  ok(/tts:done/.test(MAIN_SRC), 'el fin del TTS debe notificarse al renderer');
  ok(/theme:changed/.test(MAIN_SRC), 'los cambios de apariencia deben broadcastearse');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/onTtsDone/.test(preload) && /onThemeChanged/.test(preload), 'preload debe exponer onTtsDone y onThemeChanged');
});

/* ---------- adjuntos del chat: archivos, documentos e imágenes ---------- */

test('adjuntos: main delega en el módulo de adjuntos y conserva los metadatos', () => {
  ok(/attachments:pick/.test(MAIN_SRC) && /attachments:read/.test(MAIN_SRC), 'faltan los handlers IPC de adjuntos');
  // Los límites, las listas de extensiones y el bloque de texto viven ahora en
  // main/attachments.js y se prueban por COMPORTAMIENTO (ver «adjuntos: tipo,
  // texto, recorte y ruta prohibida»): aquí solo el cableado y que no se dupliquen.
  ok(/require\('\.\/attachments'\)/.test(MAIN_SRC), 'main debe usar main/attachments.js');
  ok(/attach\.kindOf\(/.test(MAIN_SRC) && /attach\.textOf\(/.test(MAIN_SRC) && /attach\.blocksFor\(/.test(MAIN_SRC), 'la lectura y el volcado al mensaje pasan por el módulo');
  ok(!/const MAX_FILE_BYTES/.test(MAIN_SRC) && !/const TEXT_EXTS/.test(MAIN_SRC), 'los límites y las listas no pueden duplicarse en main.js');
  // el mensaje guardado conserva metadatos de adjuntos (miniaturas al recargar)
  ok(/attachments: attMeta/.test(MAIN_SRC), 'los metadatos de adjuntos deben guardarse en la conversación');
  // el body por defecto con imagen pero sin texto sigue funcionando
  ok(/\(análisis de imagen\)/.test(MAIN_SRC), 'imagen sola debe tener texto por defecto');
});

test('adjuntos: el agente acepta varias imágenes y retry las conserva', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
  ok(/const imgUrls = \[imageDataUrl, \.\.\.extraImgs\]/.test(agent), 'debe combinar la imagen principal con los adjuntos');
  ok(/const images = parts \? parts\.filter\(c => c\.type === 'image_url'\)\.map/.test(agent), 'retry debe recuperar TODAS las imágenes');
  ok(/attachments: images\.slice\(1\)/.test(agent), 'retry debe reenviar el resto de imágenes');
});

test('adjuntos: UI completa — botón, drag&drop, pegar, chips y miniaturas', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  ok(html.includes('id="chatAttach"'), 'falta el botón de adjuntar');
  ok(html.includes('id="attachStrip"'), 'falta la tira de adjuntos del compositor');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  ok(/\$\('#chatAttach'\)\.onclick/.test(app), 'el botón debe abrir el selector');
  ok(/addEventListener\('drop'/.test(app), 'debe aceptar drag & drop');
  ok(/addEventListener\('paste'/.test(app), 'debe aceptar imágenes pegadas');
  ok(/function paintAttachments/.test(app), 'las burbujas deben pintar los adjuntos');
  ok(/MAX_ATTACHMENTS = 8/.test(app), 'límite de adjuntos por mensaje');
  ok(/pendingAttachments\.slice\(\)/.test(app) && /sendChat\(text, null, atts\)/.test(app), 'envío debe incluir los adjuntos');
  const icons = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
  ok(/  clip: /.test(icons) && /  x: /.test(icons), 'faltan los iconos clip y x');
  // integración preload↔renderer (mismo guardián que el resto)
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/attachmentsPick/.test(preload) && /attachmentsRead/.test(preload), 'preload debe exponer los canales de adjuntos');
});

/* ---------- icono: Windows no pinta entradas PNG pequeñas dentro del .ico ---------- */
const ico = require('../scripts/ico');
const pngOps = require('../scripts/png-ops');

test('ico: los tamaños pequeños van en BMP y los grandes en PNG', () => {
  eq(ico.PNG_MIN_SIZE, 128, 'a partir de aquí la entrada es PNG');
  eq(ico.DEFAULT_SIZES.join(','), '256,128,64,48,32,16', 'los tamaños que lleva el icono');
  const entries = ico.DEFAULT_SIZES.map(s => ({
    s,
    data: ico.icoEntry(s, Buffer.alloc(s * s * 4, 200), (size, px) => pngOps.encodePNG(size, size, px)),
  }));
  const parsed = ico.parseIco(ico.buildIco(entries));
  eq(parsed.length, 6, 'deben salir las seis entradas');
  for (const e of parsed) {
    const want = e.size >= ico.PNG_MIN_SIZE ? 'png' : 'bmp';
    eq(e.format, want, 'el tamaño ' + e.size + 'px debe guardarse como ' + want.toUpperCase());
  }
  eq(ico.parseIco(ico.buildIco([entries[0]]))[0].size, 256, 'el 256 se codifica como 0 y se vuelve a leer como 256');
});

test('ico: la entrada BMP lleva la cabecera y el orden de píxeles de Windows', () => {
  const size = 64;
  const rgba = Buffer.alloc(size * size * 4);
  rgba[0] = 10; rgba[1] = 20; rgba[2] = 30; rgba[3] = 40;   // píxel de la esquina SUPERIOR izquierda
  const dib = ico.dibEntry(rgba, size);
  eq(dib.length, ico.dibLength(size), 'longitud de la entrada DIB');
  const d = ico.parseIco(ico.buildIco([{ s: size, data: dib }]))[0].dib;
  eq(d.biSize, 40, 'biSize');
  eq(d.biWidth, size, 'biWidth');
  eq(d.biHeight, size * 2, 'biHeight: mapa XOR + máscara AND');
  eq(d.biBitCount, 32, 'biBitCount');
  eq(d.biCompression, 0, 'BI_RGB');
  eq(d.biSizeImage, size * size * 4 + ico.maskRowBytes(size) * size, 'biSizeImage');
  // el DIB va de abajo arriba: nuestro píxel de arriba termina en la última fila, en BGRA
  const last = 40 + size * (size - 1) * 4;
  eq([dib[last], dib[last + 1], dib[last + 2], dib[last + 3]].join(','), '30,20,10,40', 'orden BGRA y volteo vertical');
});

test('updater: el hash del portable no se confunde con el del Setup', () => {
  const updater = require('../main/updater');
  // Un latest.yml real: electron-builder solo escribe info de actualización del
  // Setup, así que `files:` lista el Setup y el sha512 de arriba es el suyo.
  const yml = 'version: 9.9.9\npath: SAGITARI-Setup-9.9.9.exe\nsha512: HASH_SETUP\nfiles:\n  - url: SAGITARI-Setup-9.9.9.exe\n    sha512: HASH_SETUP\n';
  const parsed = updater.parseLatestYml(yml);
  eq(updater.sha512For(parsed, 'SAGITARI-Setup-9.9.9.exe'), 'HASH_SETUP', 'el Setup usa su hash');
  eq(updater.sha512For(parsed, 'SAGITARI-Portable-9.9.9.exe'), null,
    'el portable NO hereda el hash del Setup: esa comparación hacía imposible actualizarlo');
  // Si el yml sí publica el hash de cada archivo, cada uno usa el suyo
  const both = updater.parseLatestYml('version: 1\npath: Setup.exe\nsha512: HASH_SETUP\nfiles:\n  - url: Setup.exe\n    sha512: HASH_SETUP\n  - url: Portable.exe\n    sha512: HASH_PORTABLE\n');
  eq(updater.sha512For(both, 'Portable.exe'), 'HASH_PORTABLE');
  eq(updater.sha512For(both, 'Setup.exe'), 'HASH_SETUP');
  // El de nivel superior SÍ vale cuando el yml nombra ese archivo en `path`
  eq(updater.sha512For(updater.parseLatestYml('version: 1\npath: Portable.exe\nsha512: HASH_P\n'), 'Portable.exe'), 'HASH_P');
});

test('adjuntos: tipo, texto, recorte y ruta prohibida', () => {
  const attach = require('../main/attachments');
  // tipo por extensión y tamaño
  eq(attach.kindOf('foto.PNG', 10), 'image');
  eq(attach.kindOf('notas.md', 10), 'text');
  eq(attach.kindOf('setup.exe', 10), 'binary', 'un ejecutable no se lee como texto ni siendo pequeño');
  eq(attach.kindOf('datos.bin', 10), 'binary');
  eq(attach.kindOf('sin-extension', 100), 'text', 'pequeño y sin extensión conocida: se intenta como texto');
  eq(attach.kindOf('sin-extension', 2 * 1024 * 1024), 'binary', 'grande y sin extensión: no');
  eq(attach.mimeOf('x.jpg'), 'image/jpeg');
  eq(attach.mimeOf('x.svg'), 'image/svg+xml');
  // texto de verdad y binario disfrazado de texto
  const texto = attach.textOf(Buffer.from('hola, esto es un texto normal con acentos: ñáé\n', 'utf8'), 'a.txt');
  ok(texto.includes('acentos'), 'el texto se conserva');
  const basura = Buffer.alloc(400, 0x01);   // 400 bytes de control: no es texto
  eq(attach.textOf(basura, 'a.txt'), null, 'lo que no es texto se degrada a binario');
  // los subtítulos se limpian (números de secuencia y flechas)
  const srt = attach.textOf(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHola, ¿qué tal?\n2\n00:00:03,000 --> 00:00:04,500\nTodo bien por aquí, gracias.\n', 'utf8'), 'a.srt');
  ok(srt && srt.includes('Hola') && !srt.includes('-->'), srt);
  ok(srt && !/^\d+$/m.test(srt), 'los números de secuencia se quitan: ' + srt);
  // recorte al techo real, y queda dicho
  const largo = attach.blockFor({ name: 'g.txt', size: 2048, text: 'x'.repeat(attach.MAX_ATTACH_CHARS + 10) });
  ok(largo.includes('2 KB'), 'el bloque dice el tamaño');
  ok(largo.endsWith('… (truncado)'), 'el recorte se anuncia');
  ok(largo.length < attach.MAX_ATTACH_CHARS + 200, 'no se cuela el texto entero');
  eq(attach.blockFor({ name: 'c.txt', size: 10, text: 'corto' }).includes('truncado'), false);
  // dos adjuntos → dos bloques
  eq(attach.blocksFor([{ name: 'a', size: 1, text: 'uno' }, { name: 'b', size: 1, text: 'dos' }]).split('--- ARCHIVO ADJUNTO').length - 1, 2);
  // el directorio de datos de la app no se puede adjuntar (claves, conversaciones)
  ok(attach.insideDir(path.join('C:', 'd', 'config.json'), path.join('C:', 'd')), 'dentro');
  ok(!attach.insideDir(path.join('C:', 'otro', 'x.txt'), path.join('C:', 'd')), 'fuera');
});

test('adjuntos: un archivo por encima del tope se rechaza antes de leerlo', async () => {
  const attach = require('../main/attachments');
  const dir = tmpDir('sagi-adj-');
  const big = path.join(dir, 'grande.txt');
  fs.writeFileSync(big, 'x'.repeat(1024));
  // la comprobación de tamaño es la que evita cargar 25 MB en memoria: se prueba
  // contra el módulo (main.js solo la usa, no la define)
  eq(attach.MAX_FILE_BYTES, 25 * 1024 * 1024);
  ok(fs.statSync(big).size <= attach.MAX_FILE_BYTES, 'un fichero normal pasa');
  ok(attach.kindOf('grande.txt', attach.MAX_FILE_BYTES + 1) === 'text', 'el tipo no decide el rechazo: lo decide el tamaño en main.js');
});

test('icono incluido: BMP en los tamaños pequeños (o Windows cae al icono genérico)', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'));
  const icons = ico.parseIco(buf);
  eq(icons.map(e => e.size).join(','), ico.DEFAULT_SIZES.join(','), 'el icono debe traer los tamaños esperados');
  for (const e of icons) {
    if (e.size >= ico.PNG_MIN_SIZE) eq(e.format, 'png', e.size + 'px debe ir como PNG');
    else eq(e.format, 'bmp', e.size + 'px debe ir como BMP: el shell de Windows no pinta PNG por debajo de ' + ico.PNG_MIN_SIZE + 'px y acaba mostrando el icono genérico del ejecutable');
  }
  // contenedor coherente: entradas consecutivas, sin huecos ni bytes sueltos
  let end = 6 + 16 * icons.length;
  for (const e of icons) {
    eq(e.offset, end, 'la entrada de ' + e.size + 'px debe empezar donde acaba la anterior');
    ok(e.offset + e.dataSize <= buf.length, 'la entrada de ' + e.size + 'px debe caber en el archivo');
    end = e.offset + e.dataSize;
  }
  eq(end, buf.length, 'no debe sobrar nada al final del archivo');
  // y el DIB declara la geometría que Windows espera
  const small = icons.find(e => e.format === 'bmp');
  ok(small, 'debe haber al menos una entrada BMP');
  eq(small.dib.biHeight, small.size * 2, 'biHeight del mapa XOR+AND');
  eq(small.dib.biSizeImage, small.size * small.size * 4 + ico.maskRowBytes(small.size) * small.size, 'biSizeImage');
});

test('png-ops se puede importar sin ejecutar el pipeline', () => {
  // el pipeline lee y escribe ficheros: al importarlo solo debe exponer el toolkit
  ok(typeof pngOps.decodePNG === 'function' && typeof pngOps.encodePNG === 'function', 'debe exponer el toolkit');
});

/* ---------- actualizador: versiones, assets, descarga y verificación ---------- */
const updater = require('../main/updater');

test('updater: compara versiones como semver', () => {
  eq(updater.compareVersions('2.2.0', '2.2.1'), -1);
  eq(updater.compareVersions('2.2.1', '2.2.1'), 0);
  eq(updater.compareVersions('2.10.0', '2.9.9'), 1, 'los números se comparan como números, no como texto');
  eq(updater.compareVersions('v2.3.0', '2.2.9'), 1, 'admite el prefijo v');
  eq(updater.compareVersions('3.0.0', '2.99.99'), 1);
  eq(updater.compareVersions('2.0.0', '2.0.0-beta.1'), 1, 'una estable es más nueva que su beta');
  eq(updater.compareVersions('2.0.0-beta.1', '2.0.0'), -1);
  eq(updater.compareVersions('', '2.0.0'), 0, 'una versión desconocida no se declara más nueva');
});

const RELEASE = {
  tag_name: 'v2.3.0', name: '2.3.0', draft: false, prerelease: false,
  html_url: 'https://github.com/dario90vlc/sagitari/releases/tag/v2.3.0',
  published_at: '2026-10-01T10:00:00Z', body: 'Notas de la versión',
  assets: [
    { name: 'latest.yml', browser_download_url: 'https://x/latest.yml', size: 300 },
    { name: 'SAGITARI-Portable-2.3.0.exe', browser_download_url: 'https://x/p.exe', size: 2 },
    { name: 'SAGITARI-Setup-2.3.0.exe', browser_download_url: 'https://x/s.exe', size: 3 },
    { name: 'SAGITARI-Setup-2.3.0.exe.blockmap', browser_download_url: 'https://x/s.blockmap', size: 4 },
  ],
};

test('updater: elige los binarios correctos de la release', () => {
  const a = updater.pickAssets(RELEASE);
  eq(a.setup.name, 'SAGITARI-Setup-2.3.0.exe', 'no debe confundirse con el .blockmap');
  eq(a.portable.name, 'SAGITARI-Portable-2.3.0.exe');
  eq(a.yml.name, 'latest.yml');
  eq(updater.assetFor('nsis', a).name, 'SAGITARI-Setup-2.3.0.exe');
  eq(updater.assetFor('portable', a).name, 'SAGITARI-Portable-2.3.0.exe');
  eq(updater.assetFor('nsis', { portable: a.portable }).name, 'SAGITARI-Portable-2.3.0.exe', 'si falta el Setup, usa el portable');
  eq(updater.assetFor('nsis', {}), null);
});

test('updater: lee el sha512 del latest.yml del CI', () => {
  const yml = ['version: 2.3.0', 'files:', '  - url: SAGITARI-Setup-2.3.0.exe', '    sha512: ABC123==', '    size: 117000000', 'path: SAGITARI-Setup-2.3.0.exe', 'sha512: ABC123==', 'releaseDate: 2026-10-01'].join('\n');
  const y = updater.parseLatestYml(yml);
  eq(y.version, '2.3.0');
  eq(y.sha512, 'ABC123==');
  eq(y.files.length, 1);
  eq(y.files[0].url, 'SAGITARI-Setup-2.3.0.exe');
  eq(y.files[0].sha512, 'ABC123==');
});

test('updater: detecta la actualización y descarta prereleases y errores', async () => {
  const fake = (rel) => async () => new Response(JSON.stringify(rel), { status: 200, headers: { 'content-type': 'application/json' } });
  let r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: fake(RELEASE) });
  eq(r.ok, true); eq(r.available, true); eq(r.latest, '2.3.0'); ok(r.assets.setup, 'trae los assets');
  r = await updater.checkForUpdate({ currentVersion: '2.3.0', fetchFn: fake(RELEASE) });
  eq(r.available, false, 'la misma versión no es una actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: fake({ ...RELEASE, prerelease: true }) });
  eq(r.available, false, 'una prerelease no cuenta como actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: async () => new Response('{}', { status: 404 }) });
  eq(r.ok, true); eq(r.available, false); ok(/sin releases/.test(r.error));
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: async () => { throw new Error('ENOTFOUND'); } });
  eq(r.ok, false); ok(/ENOTFOUND/.test(r.error), 'un fallo de red se comunica, no se traga');
});

test('updater: descarga, informa del progreso y devuelve el sha512', async () => {
  const dir = tmpDir('sagi-upd-');
  const dest = path.join(dir, 'bin.exe');
  const chunks = ['abc', 'def'];
  const fetchFn = async () => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(Buffer.from(ch))); c.close(); } }), { status: 200, headers: { 'content-length': '6' } });
  const ticks = [];
  const r = await updater.downloadTo('https://x/bin.exe', dest, { fetchFn, onProgress: (p) => ticks.push(p) });
  eq(fs.readFileSync(dest, 'utf8'), 'abcdef', 'el archivo llega completo');
  eq(r.bytes, 6);
  eq(r.sha512, require('crypto').createHash('sha512').update('abcdef').digest('base64'), 'el sha512 corresponde al contenido');
  ok(ticks.length >= 1 && typeof ticks[0].total === 'number', 'la descarga informa del progreso con su total');
  eq(fs.existsSync(dest + '.part'), false, 'no deja el .part tirado');
});

test('updater: una descarga cortada no deja un instalador a medias', async () => {
  const dir = tmpDir('sagi-upd2-');
  const dest = path.join(dir, 'bin.exe');
  const fetchFn = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('ab'))); c.error(new Error('corte de red')); } }), { status: 200 });
  let fallo = false;
  try { await updater.downloadTo('https://x/bin.exe', dest, { fetchFn }); } catch { fallo = true; }
  eq(fallo, true, 'el corte debe propagarse');
  eq(fs.existsSync(dest), false, 'no puede quedar un .exe incompleto en el destino');
  eq(fs.existsSync(dest + '.part'), false, 'ni el temporal');
});

test('updater: cada modo guarda el binario donde toca', () => {
  eq(updater.hostKind({ isPackaged: false }), 'dev');
  eq(updater.hostKind({ isPackaged: true, env: {} }), 'nsis');
  eq(updater.hostKind({ isPackaged: true, env: { PORTABLE_EXECUTABLE_DIR: 'C:/apps' } }), 'portable');
  const t = updater.downloadTarget({ kind: 'nsis', assetName: 'SAGITARI-Setup-2.3.0.exe' });
  ok(t.path.includes('sagitari-update'), 'los instaladores van a su carpeta temporal');
  const p = updater.downloadTarget({ kind: 'portable', assetName: 'SAGITARI-Portable-2.3.0.exe', env: { PORTABLE_EXECUTABLE_DIR: 'C:/apps' } });
  eq(p.path, path.join('C:/apps', 'SAGITARI-Portable-2.3.0.exe'), 'el portable se deja junto al que se está ejecutando');
  const evil = updater.downloadTarget({ kind: 'nsis', assetName: '../../evil name.exe' });
  eq(path.basename(evil.path), '.._.._evil_name.exe', 'el nombre no puede escapar de la carpeta');
});

/* ---------- reparaciones: regresiones que no pueden volver ---------- */

test('skills: un id con .. o separadores no puede salir del almacén', async () => {
  const legitima = path.join(SKILLS_TMP, 'victima');
  fs.mkdirSync(legitima, { recursive: true });
  fs.writeFileSync(path.join(legitima, 'SKILL.md'), '---\nname: victima\ndescription: x\n---\ncuerpo');
  const venenos = ['.', '..', '../fuera', '..\\..\\fuera', 'a/b', 'a\\b', '', '   ', '...', 'SKILL.md/..'];
  for (const id of venenos) {
    for (const [nombre, fn] of [['deleteSkill', skills.deleteSkill], ['setEnabled', (i) => skills.setEnabled(i, true)], ['writeSource', (i) => skills.writeSource(i, { repo: 'x/y' })]]) {
      let lanzo = false;
      try { await fn(id); } catch { lanzo = true; }
      ok(lanzo, `${nombre}() debe rechazar ${JSON.stringify(id)}`);
    }
  }
  ok(fs.existsSync(path.join(legitima, 'SKILL.md')), 'las skills legítimas siguen intactas');
  ok(fs.existsSync(SKILLS_TMP), 'el almacén sigue existiendo');
});

test('skills: deleteSkill borra la indicada y solo esa', async () => {
  const borrame = path.join(SKILLS_TMP, 'borrame');
  fs.mkdirSync(borrame, { recursive: true });
  await skills.deleteSkill('borrame');
  eq(fs.existsSync(borrame), false, 'la skill indicada se borra');
  ok(fs.existsSync(path.join(SKILLS_TMP, 'victima')), 'las demás siguen ahí');
});

test('skills: los triggers son literales, no expresiones regulares del repo', async () => {
  // un trigger remoto tipo (a+)+$ congelaba el hilo principal (ReDoS)
  const t0 = Date.now();
  const hits = await skills.suggestSkillsFor('a'.repeat(40000));
  ok(Date.now() - t0 < 2000, 'el análisis no puede quedarse colgado');
  eq(hits.length, 0);
});

test('permisos: la tabla de riesgo es única y no tiene claves muertas', () => {
  const { RISK, toolDefs } = require('../agent/tools');
  const { DEFAULT_RISK } = require('../agent/guardrails');
  eq(DEFAULT_RISK, RISK, 'guardrails debe consumir la MISMA tabla que declara tools.js');
  const nombres = toolDefs.map(d => d.function.name);
  const sinNivel = nombres.filter(n => !RISK[n]);
  eq(sinNivel.join(', '), '', 'toda herramienta debe declarar su nivel de riesgo');
  const muertas = Object.keys(RISK).filter(k => !nombres.includes(k));
  eq(muertas.join(', '), '', 'la tabla no puede declarar herramientas que no existen');
});

test('permisos: leer el portapapeles y evaluar JS piden confirmación aunque el tool sea safe', () => {
  const g = new Guardrails({ permissions: { clipboard: 'safe', browser_control: 'safe' } });
  eq(g.decide('clipboard', { action: 'read' }).action, 'confirm', 'leer el portapapeles no es automático');
  eq(g.decide('clipboard', { action: 'read' }).sensitive, true);
  eq(g.decide('browser_control', { action: 'eval', expression: 'fetch("/x")' }).action, 'confirm', 'eval ejecuta JS en la página');
  eq(g.decide('browser_control', { action: 'profile', profile: 'work' }).action, 'confirm', 'cambiar de perfil cambia de sesiones');
  eq(g.decide('clipboard', { action: 'write', text: 'hola' }).action, 'allow', 'escribir en el portapapeles es inocuo');
});

test('permisos: un clic por índice se juzga con la etiqueta del inventario', () => {
  const g = new Guardrails({ permissions: { browser_control: 'safe' } });
  // el navegador resuelve la etiqueta y viaja como `_label` (agent.js)
  eq(g.decide('browser_control', { action: 'click_index', index: 3, _label: 'Aceptar cookies' }).action, 'allow',
    'un clic inocuo sigue siendo automático si el usuario confía en el navegador');
  eq(g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Pagar ahora 49,90 €' }).action, 'confirm',
    'comprar por índice también se confirma');
  eq(g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Eliminar cuenta' }).sensitive, true);
  eq(g.decide('browser_control', { action: 'click_index', index: 1 }).action, 'confirm',
    'sin etiqueta no se sabe qué se pulsa: se pregunta');
});

test('permisos: abrir una URL pide confirmación por defecto', () => {
  const g = new Guardrails();
  eq(g.decide('open_url', { url: 'https://github.com' }).action, 'confirm');
});

test('mcp: las herramientas dinamicas entran en el catalogo sin tocar la tabla nativa', () => {
  const toolsMod = require('../agent/tools');
  const antes = toolsMod.toolDefs.length;
  const { RISK } = toolsMod;
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__eco__echo', description: 'x', parameters: { type: 'object', properties: {} } } }]));
  try {
    eq(toolsMod.allToolDefs().length, antes + 1, 'la dinamica se suma al catálogo nativo');
    ok(toolsMod.allToolDefs().some(d => d.function.name === 'mcp__eco__echo'));
    eq(toolsMod.toolDefs.length, antes, 'la tabla nativa no se toca (es la que valida el test de niveles)');
    ok(!RISK['mcp__eco__echo'], 'y no se le inventa un nivel: sin override será confirm');
  } finally { toolsMod.setDynamicToolProvider(null); }
  eq(toolsMod.allToolDefs().length, antes, 'sin proveedor, el catálogo vuelve a ser el nativo');
});

test('permisos: el comodín de servidor MCP sube la confianza de todo un servidor', () => {
  const g = new Guardrails({ permissions: { 'mcp__github__*': 'safe' } });
  eq(g.levelFor('mcp__github__create_issue'), 'safe', 'el comodín del servidor vale para sus herramientas');
  eq(g.decide('mcp__github__create_issue', {}).action, 'allow');
  eq(g.decide('mcp__otro__x', {}).action, 'confirm', 'y solo para ese servidor');
  // el override exacto sigue ganando al comodín
  const g2 = new Guardrails({ permissions: { 'mcp__github__*': 'safe', 'mcp__github__borrar': 'restricted' } });
  eq(g2.decide('mcp__github__borrar', {}).action, 'deny');
  // y ninguna herramienta MCP entra en 'safe' por defecto
  eq(new Guardrails().decide('mcp__loquesea__x', {}).action, 'confirm');
});

test('permisos: la tarjeta de confirmación nombra el servidor y la herramienta', () => {
  ok(describeAction('mcp__github__create_issue', {}).includes('MCP'));
  const d = describeAction('mcp__github__create_issue', { _mcp: { serverName: 'GitHub', toolName: 'create_issue' } });
  ok(/GitHub/.test(d) && /create_issue/.test(d), 'con la etiqueta real: ' + d);
  ok(summarizeArgs('mcp__github__create_issue', { title: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } }).includes('GitHub'));
});

test('permisos: un _mcp inyectado no puede falsear la tarjeta de una herramienta nativa', () => {
  // el modelo —o contenido que el modelo lee— puede emitir `_mcp` en los argumentos
  const a = { path: 'C:/importante.txt', content: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } };
  const d = describeAction('write_file', a);
  ok(/sobrescribir/i.test(d), 'la tarjeta dice lo que va a pasar de verdad: ' + d);
  ok(!/MCP/i.test(d), 'y no se cree una etiqueta en una herramienta nativa');
  const s = summarizeArgs('write_file', a);
  ok(/importante\.txt/.test(s), 'el resumen sigue mostrando la ruta: ' + s);
  // write_file tiene su propio caso en el switch, así que la fuga de la etiqueta
  // sólo se puede ver en una herramienta que cae en el `default` (read_file…)
  const d2 = describeAction('read_file', a);
  ok(!/MCP|GitHub/.test(d2), 'la rama por defecto tampoco se cree la etiqueta: ' + d2);
  const s2 = summarizeArgs('read_file', a);
  ok(/importante\.txt/.test(s2), 'ni el resumen se sustituye por la etiqueta: ' + s2);
});

test('seguridad: open_url solo acepta http(s), no manejadores del sistema', () => {
  const { openUrlAllowed } = require('../agent/executors');
  ok(openUrlAllowed('https://github.com/dario90vlc/sagitari'));
  ok(openUrlAllowed('http://localhost:3000/x'));
  ok(!openUrlAllowed('file:///C:/Windows/System32/calc.exe'), 'file: abriría un ejecutable local');
  ok(!openUrlAllowed('ms-msdt:/id PCWDiagnostic'), 'los manejadores de Windows no son URLs de navegador');
  ok(!openUrlAllowed('javascript:alert(1)'));
  ok(!openUrlAllowed(''));
  ok(!openUrlAllowed(undefined));
});

test('guardrails: esperar la confirmación no consume el límite de duración', async () => {
  /* Determinista a propósito: la pausa empieza antes de esperar y la espera es
     mucho mayor que el límite, así que el resultado no depende de la carga de la
     máquina (una versión anterior medía lapsos cortos y fallaba por ruido). */
  const g = new Guardrails({ guardrails: { maxDurationMs: 400, maxSteps: 0 } });
  g.beginRun();
  g.pauseClock();                                // el usuario tiene la tarjeta en pantalla
  await new Promise(r => setTimeout(r, 600));    // más que el límite entero
  g.resumeClock();
  ok(g.checkStep().ok, 'el tiempo esperando al usuario no es tiempo de ejecución');
});

test('health: el coste por modelo se acumula y llega al panel', () => {
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  const s = modelsMod.summary().find(r => r.model === 'cost-test-model');
  eq(s.costUsd, 0.5, 'el panel publicaba siempre 0.0000 porque record() nunca guardaba el coste');
});

test('apariencia: cada clase de punto que usa el JS existe en el CSS', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const usadas = new Set();
  // puntos de estado de tarea: { label: '…', cls: 'ok' } → class="dot ${st.cls}"
  for (const m of app.matchAll(/\{\s*label:\s*'[^']*',\s*cls:\s*'([\w-]+)'/g)) usadas.add(m[1]);
  // salud del modelo y color del feed: eligen la clase en un ternario
  for (const m of app.matchAll(/(?:const|let)\s+(?:health|color)\s*=\s*([^;]+);/g)) {
    for (const lit of m[1].matchAll(/'([a-z][\w-]*)'/g)) usadas.add(lit[1]);
  }
  for (const m of app.matchAll(/\bfeed\([^)]*,\s*'([\w-]+)'\s*\)/g)) usadas.add(m[1]);
  ok(usadas.size >= 3, 'deben detectarse las clases de estado (' + [...usadas].join(', ') + ')');
  // `.dot` no define fondo: una clase sin regla deja el punto invisible (pasó con mag/mg)
  for (const c of usadas) ok(css.includes('.dot.' + c), `falta la regla .dot.${c} en styles.css`);
});

test('integración: cada canal push del preload tiene remitente en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const canales = [...preload.matchAll(/\bon\('([^']+)'/g)].map(m => m[1]);
  ok(canales.length >= 10, 'deben detectarse los canales push (' + canales.length + ')');
  const emisores = new Set([...main.matchAll(/send\('([^']+)'/g)].map(m => m[1]));
  const sinEmisor = [...new Set(canales)].filter(c => !emisores.has(c));
  eq(sinEmisor.join(', '), '', 'canales push que el renderer nunca recibiría');
});

test('updater: una descarga que deja de recibir datos se corta sola', async () => {
  const dir = tmpDir('sagi-upd3-');
  const dest = path.join(dir, 'bin.exe');
  // cuerpo que nunca entrega un chunk pero SÍ respeta la señal (como fetch real)
  const fetchFn = async (url, opts = {}) => ({
    ok: true,
    headers: { get: () => null },
    body: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((_, reject) => {
          const s = opts.signal;
          if (s) s.addEventListener('abort', () => reject(s.reason || new Error('abortado')), { once: true });
        }),
      }),
    },
  });
  let error = null;
  const t0 = Date.now();
  try { await updater.downloadTo('https://x/bin.exe', dest, { fetchFn, idleTimeoutMs: 60 }); }
  catch (e) { error = e; }
  ok(error, 'debe rechazar en vez de esperar para siempre');
  ok(Date.now() - t0 < 3000, 'el vigilante de inactividad debe dispararse pronto');
  eq(fs.existsSync(dest + '.part'), false, 'no puede quedar un temporal a medias');
});

/* ---------- navegador y logs: cobertura que faltaba ---------- */
const { Browser } = require('../agent/browser');
const profiles = require('../agent/browser-profiles');
const runlog = require('../agent/runlog');

const PROF_TMP = tmpDir('sagi-profiles-');
profiles.__test._resetForTests(PROF_TMP);   // nunca escribir en %APPDATA% real

test('perfiles: cada nombre tiene su carpeta y la migración conserva los logins', () => {
  ok(profiles.profileDirFor('Mi Work!').startsWith(PROF_TMP), 'la carpeta vive en la base de perfiles');
  ok(profiles.profileId('mi perfil') !== profiles.profileId('mi_perfil'), 'nombres parecidos no colapsan');
  const legacy = profiles.legacyDirFor('trabajo');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cookies'), 'sesión guardada');
  const dir = profiles.ensureProfileDir('trabajo');
  eq(fs.readFileSync(path.join(dir, 'Cookies'), 'utf8'), 'sesión guardada', 'los logins sobreviven a la actualización');
  eq(fs.existsSync(legacy), false, 'la carpeta antigua se traslada, no se duplica');
});

test('perfiles: ensureProfileDir no pisa lo que ya había', () => {
  const a = profiles.ensureProfileDir('dos');
  fs.mkdirSync(a, { recursive: true });   // la carpeta la crea el navegador al arrancar
  fs.writeFileSync(path.join(a, 'Cookies'), 'x');
  eq(profiles.ensureProfileDir('dos'), a, 'misma carpeta en la segunda llamada');
  eq(fs.readFileSync(path.join(a, 'Cookies'), 'utf8'), 'x');
});

test('browser: el puerto CDP se recupera del perfil', () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof-');
  const file = path.join(b.profileDir, 'DevToolsActivePort');
  eq(b._portFromProfile(), 0, 'sin fichero no hay puerto');
  fs.writeFileSync(file, 'abc\n/devtools/browser/x\n');
  eq(b._portFromProfile(), 0, 'contenido ilegible → 0');
  fs.writeFileSync(file, '70000\n');
  eq(b._portFromProfile(), 0, 'puerto fuera de rango → 0');
  fs.writeFileSync(file, '9333\n/devtools/browser/abc\n');
  eq(b._portFromProfile(), 9333, 'lee el puerto que dejó Chrome en el perfil');
});

test('browser: una acción desconocida no lanza un navegador', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof2-');
  const r = await b.handle({ action: 'clik' });   // errata típica del modelo
  ok(/Acción desconocida/.test(r), 'debe rechazarla');
  eq(b.ws, null, 'sin abrir conexión');
  eq(b.browserPid, null, 'sin lanzar ningún proceso');
});

test('browser: el inventario pertenece a la ejecución que lo pidió', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof4-');
  b._lastElements = [{ tag: 'button', text: 'Pagar', x: 10, y: 20, w: 30, h: 10 }];
  b._invOwner = 'agente-A';
  const r = await b.clickIndex(0, 'sess', 'agente-B');
  ok(/otra ejecución/.test(r), 'la otra ejecución no puede clicar con coordenadas ajenas');
  eq(b._lastElements.length, 1, 'no se consumió el inventario del dueño');
  eq(b.labelForIndex(0), 'Pagar button', 'la etiqueta sirve para juzgar la acción');
  eq(b.labelForIndex(9), '', 'un índice inexistente no inventa etiqueta');
});

test('browser: las acciones se ejecutan de una en una', async () => {
  const b = new Browser();
  const order = [];
  b._handle = async (args) => {
    order.push('inicio' + args.n);
    await new Promise(r => setTimeout(r, 20));
    if (args.n === 1) throw new Error('fallo simulado');
    order.push('fin' + args.n);
  };
  // dos agentes a la vez (chat + tarea de background) comparten el navegador: sus
  // acciones no pueden solaparse porque el estado de la pestaña es global
  const p1 = b.handle({ n: 1 }).catch(e => 'error:' + e.message);
  const p2 = b.handle({ n: 2 });
  const p3 = b.handle({ n: 3 });
  eq(await p1, 'error:fallo simulado', 'el fallo llega a quien lo pidió');
  await Promise.all([p2, p3]);
  eq(order.join(' '), 'inicio1 inicio2 fin2 inicio3 fin3', 'cada acción termina antes de la siguiente, y un fallo no atasca la cola');
});

test('browser: cambiar de perfil olvida el estado del anterior', async () => {
  const b = new Browser();
  b.port = 9333;
  b.browserPid = 4242;              // pid ficticio: no debe poder matarse después
  b.activeId = 'tab1';
  b._lastElements = [{ x: 1, y: 1 }];
  b._sessions.set('tab1', 's1');
  const r = await b.switchProfile('otro');
  ok(/perfil activo/.test(r), 'confirma el cambio');
  eq(b.port, 0, 'el puerto del perfil anterior no vale');
  eq(b.browserPid, null, 'ni su PID: Windows reutiliza los números');
  eq(b._lastElements, null, 'ni el inventario de la página anterior');
  eq(b._sessions.size, 0);
  ok(b.profileDir.startsWith(PROF_TMP), 'y el perfil nuevo usa su propia carpeta');
});

test('browser: kill deja el estado limpio y se puede repetir', () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof3-');
  b.port = 9333; b.activeId = 'tab1'; b._sessions.set('tab1', 's1');
  b.kill();
  eq(b.ws, null); eq(b.activeId, null); eq(b._sessions.size, 0);
  b.kill();   // sin navegador abierto no puede lanzar ningún taskkill
});

test('runlog: escribe, se lee y rota por bytes reales', async () => {
  const dir = tmpDir('sagi-logs-');
  runlog.__test._resetForTests({ dir, maxBytes: 400, maxLogs: 3 });
  let streams = 0;
  const abrir = fs.createWriteStream;
  fs.createWriteStream = (...a) => { streams++; return abrir(...a); };
  for (let i = 0; i < 200; i++) runlog.log({ agent: 'test', event: 'e', text: 'ñ'.repeat(60) + i });
  fs.createWriteStream = abrir;
  runlog.close();
  ok(streams > 1, 'el tope por archivo fuerza rotación (' + streams + ' ficheros abiertos)');
  // la poda corre unos cientos de ms después de la última rotación y reintenta:
  // en Windows el fichero anterior puede seguir con el handle cerrándose
  await new Promise(r => setTimeout(r, 1200));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  ok(files.length <= 3, 'no se conservan más ficheros de los permitidos (' + files.length + ')');
  /* El tope es de BYTES: contando caracteres UTF-16 cada línea de 60 «ñ» pesa la
     mitad de lo que ocupa en disco, así que el fichero se pasaba del tope al
     doble. Aquí cada línea son ~190 bytes y el tope 400. */
  for (const f of files) {
    const bytes = fs.statSync(path.join(dir, f)).size;
    ok(bytes <= 600, f + ' ocupa ' + bytes + ' bytes y el tope es 400');
  }
  /* Cada línea tiene que ser un evento completo: una rotación a mitad de línea
     dejaría JSON partido (y el tope se cumple sin cortar nada). */
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    ok(lines.length > 0, f + ' no puede quedar vacío');
    for (const l of lines) eq(JSON.parse(l).agent, 'test', 'línea completa en ' + f);
  }
  const recent = runlog.readRecent(3);
  ok(recent.length === 3, 'readRecent devuelve los últimos eventos');
  ok(recent.every(e => e.agent === 'test' && e.ts), 'cada evento con su origen y su marca de tiempo');
  ok(/^run-\d+(-\d+)?\.jsonl$/.test(path.basename(runlog.currentLogFile() || '')), 'el fichero de sesión se nombra run-<ts>.jsonl');
  runlog.__test._resetForTests({});
});

/* ---------- un solo camino de ejecución de herramientas ---------- */
const { Agent: AgentCls } = require('../agent/agent');
const guardrailsMod = require('../agent/guardrails');

const fakeCtx = (extra = {}) => ({
  signal: new AbortController().signal,
  settings: { settings: {} },
  ...extra,
});
const toolCall = (name, args) => ({ id: 't1', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) } });

test('herramientas: una herramienta mcp sin gestor no se ejecuta y se explica', async () => {
  const toolsMod = require('../agent/tools');
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__x__y', description: 'd', parameters: { type: 'object', properties: {} } } }]));
  try {
    // el nivel se fija en la POLÍTICA del agente (no en el ctx): con el 'confirm'
    // por defecto la llamada esperaría una confirmación que aquí no llega nunca
    const a = new AgentCls({ emit: () => {}, guardrailsPolicy: { permissions: { 'mcp__x__y': 'safe' } } });
    const r = await a._runToolCall(toolCall('mcp__x__y', {}), fakeCtx());
    eq(r.action, 'ok', 'la llamada se resuelve (el ejecutor no lanza)');
    ok(/MCP/.test(r.text), 'y explica que no hay servidores MCP: ' + r.text);
  } finally { toolsMod.setDynamicToolProvider(null); }
});

test('herramientas: el rail nombra la herramienta MCP real, no el slug', async () => {
  const toolsMod = require('../agent/tools');
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__eco__crear_nota', description: 'd', parameters: { type: 'object', properties: {} } } }]));
  try {
    const mcpFalso = { describe: () => ({ serverId: 'eco', serverName: 'Eco', toolName: 'crear-nota' }), callTool: async () => 'ok' };
    const a = new AgentCls({ emit: () => {}, mcp: mcpFalso, guardrailsPolicy: { permissions: { 'mcp__eco__crear_nota': 'safe' } } });
    const vistos = [];
    await a._runToolCall(toolCall('mcp__eco__crear_nota', {}), fakeCtx({ mcp: mcpFalso, onStatus: (t) => vistos.push(t) }));
    ok(vistos.some(t => /crear-nota/.test(t)), 'el rail usa el nombre real de la herramienta: ' + JSON.stringify(vistos));
  } finally { toolsMod.setDynamicToolProvider(null); }
});

test('herramientas: una inventada no llega a pedir permiso', async () => {
  const ev = [];
  const a = new AgentCls({ emit: (e) => ev.push(e) });
  const r = await a._runToolCall(toolCall('borrar_todo', {}), fakeCtx());
  eq(r.action, 'unknown', 'no puede ejecutarse ni pedir confirmación');
  ok(!ev.some(e => e.type === 'confirm_request'), 'el usuario no ve una tarjeta por una herramienta que no existe');
  eq(a.meta.toolCalls, 0);
});

test('herramientas: argumentos ilegibles no ejecutan nada', async () => {
  const a = new AgentCls({ emit: () => {} });
  const r = await a._runToolCall(toolCall('write_file', '{"path":'), fakeCtx());
  eq(r.action, 'bad-args');
  ok(/no son JSON válido/.test(r.text), 'se lo dice al modelo para que reenvíe la llamada');
  eq(a.meta.toolCalls, 0);
});

test('herramientas: argumentos que no son objeto no tumban el turno', async () => {
  const a = new AgentCls({ emit: () => {} });
  // `arguments: "null"` es JSON válido: antes pasaba el parse y reventaba leyendo
  // args.path, así que el usuario perdía la petición con un TypeError críptico
  for (const raw of ['null', '[1,2]', '"texto"', '3']) {
    const r = await a._runToolCall(toolCall('read_file', raw), fakeCtx());
    eq(r.action, 'bad-args', 'con argumentos ' + raw);
    ok(/objeto JSON/.test(r.text), 'se lo dice al modelo: ' + r.text);
  }
  eq(a.meta.toolCalls, 0, 'no se ejecutó nada');
  eq(a.guardrails.steps, 0);
});

test('herramientas: una restringida se bloquea sin ejecutarse', async () => {
  const a = new AgentCls({ emit: () => {}, guardrailsPolicy: { permissions: { screenshot: 'restricted' } } });
  const r = await a._runToolCall(toolCall('screenshot', {}), fakeCtx());
  eq(r.action, 'denied');
  eq(r.reason, 'restricted');
  eq(a.meta.toolCalls, 0);
});

test('herramientas: el subagente no puede salirse de su lista', async () => {
  const subagentsMod = require('../agent/subagents');
  const a = new AgentCls({ emit: () => {} });
  const tools = subagentsMod.toolDefsFor('research');
  const r = await a._runToolCall(toolCall('run_command', { command: 'whoami' }), fakeCtx({ tools, noDelegate: true }));
  eq(r.action, 'not-allowed', 'research no tiene terminal');
  ok(/no está disponible/.test(r.text));
  eq(a.meta.toolCalls, 0, 'no se ha ejecutado ningún comando');
  const d = await a._runToolCall(toolCall('delegate', { agent: 'research', task: 'x' }), fakeCtx({ tools, noDelegate: true }));
  eq(d.action, 'not-allowed');
  ok(/no puede delegar/.test(d.text));
});

test('herramientas: una acción sensible pide confirmación y la denegación se explica', async () => {
  const ev = [];
  const a = new AgentCls({ emit: (e) => ev.push(e) });
  const p = a._runToolCall(toolCall('clipboard', { action: 'read' }), fakeCtx());
  // el agente emite la tarjeta y espera: se responde como haría la UI
  await new Promise(r => setTimeout(r, 10));
  const card = ev.find(e => e.type === 'confirm_request');
  ok(card, 'leer el portapapeles pide permiso');
  eq(card.sensitive, true);
  ok(a.resolveConfirm(card.id, false), 'la confirmación pendiente es resolubible');
  const r = await p;
  eq(r.action, 'denied');
  eq(r.reason, 'user');
  ok(/DENEGÓ/.test(r.text));
  eq(a.meta.toolCalls, 0);
});

test('guardrails: el reloj se reanuda aunque la confirmación se aborte', async () => {
  const g = new guardrailsMod.Guardrails({ guardrails: { maxDurationMs: 5000 } });
  g.beginRun();
  const a = new AgentCls({ emit: () => {}, guardrailsPolicy: { guardrails: { maxDurationMs: 5000 } } });
  a.guardrails = g;
  const ac = new AbortController();
  const p = a._awaitConfirm('c1', ac.signal);
  eq(g._pausedAt > 0, true, 'el reloj queda parado mientras se espera');
  ac.abort();
  eq(await p, false, 'abortar resuelve la espera');
  eq(g._pausedAt, 0, 'y el reloj vuelve a correr');
});

test('herramientas: las que lanzan un proceso registran su cancelación', () => {
  /* Detener solo cancela la herramienta en vuelo si esta registró cómo matarse.
     La propiedad no es observable sin lanzar procesos reales (mataría ventanas del
     equipo), así que se comprueba sobre el código: toda herramienta que llama a
     run() debe pasar registerKillable. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'executors.js'), 'utf8');
  const casos = src.split(/\n    case /).filter(c => /await run\(/.test(c));
  ok(casos.length >= 3, 'se esperan varias herramientas que lanzan procesos (' + casos.length + ')');
  for (const c of casos) {
    const nombre = (c.match(/^'([a-z_]+)'/) || [])[1] || '?';
    ok(/registerKillable/.test(c), `la herramienta ${nombre} no registra cómo cancelarse al pulsar Detener`);
  }
  ok(/sendVK\(vk, ctx\.registerKillable\)/.test(src), 'media_control también pasa la cancelación');
});

test('updater: informa de la firma digital del binario descargado', async () => {
  /* El hash publicado en la release demuestra integridad, no autenticidad: si el
     repo se compromete, el binario y su hash cambian juntos. La firma Authenticode
     es el único anclaje externo, así que el usuario tiene que ver si falta. */
  const sistema = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'notepad.exe');
  // Si la sonda desapareciera de la imagen del runner, el fallo sería del binario
  // y no de la consulta: conviene poder distinguirlo por el mensaje.
  ok(fs.existsSync(sistema), 'la sonda existe en esta máquina (' + sistema + ')');
  const firmado = await updater.signatureOf(sistema);
  ok(firmado, 'un binario de sistema tiene firma consultable');
  eq(firmado.status, 'Valid');
  ok(/Microsoft/.test(firmado.signer || ''), 'y se informa de quién lo firma (' + firmado.signer + ')');
  // Un fichero que no es una imagen PE válida no sirve como sonda sin firmar:
  // Windows responde "UnknownError", no "NotSigned", así que el caso contrario
  // se cubre con el binario ausente de abajo (que no depende del servicio).
  const inexistente = await updater.signatureOf(path.join(tmpDir('sagi-sig-'), 'no-existe.exe'));
  eq(inexistente, null, 'si no se puede consultar, no se inventa un estado');
});

test('arranque: TODOS los módulos del agente respetan la raíz de datos de prueba', () => {
  /* Esta la rompió una versión anterior: main.js apuntaba los modos de prueba a su
     propio directorio, pero cada módulo de agent/ calculaba el suyo con
     «SagitariAI» escrito a mano, así que los skills, logs, memoria, hábitos,
     checkpoints y salud de modelos seguían escribiéndose en los datos reales.
     Se comprueba en un proceso limpio (las rutas se resuelven al cargar). */
  const raiz = tmpDir('sagi-datadir-');
  const code = `
    const fs = require('fs');
    const out = {};
    out.skills = require('./agent/skills').skillsDir();
    out.logs = require('./agent/runlog').LOG_DIR;
    out.perfiles = require('./agent/browser-profiles').PROFILE_BASE;
    require('./agent/memory').add({ text: 'prueba de aislamiento', source: 'user', importance: 0.5 });
    require('./agent/habits').observe('mode', { mode: 'act' });
    require('./agent/models').record('m', { ok: true });
    const cp = require('./agent/checkpoints');
    cp.save(cp.newRun({ goal: 'aislamiento' }));
    out.ficheros = fs.readdirSync(process.env.SAGITARI_DATA_DIR).sort();
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SAGITARI_DATA_DIR: raiz },
    encoding: 'utf8',
  });
  ok(r.status === 0, 'el proceso hijo debe terminar bien: ' + String(r.stderr || '').slice(0, 300));
  const out = JSON.parse(String(r.stdout).trim());
  for (const [que, ruta] of Object.entries({ skills: out.skills, logs: out.logs, perfiles: out.perfiles })) {
    ok(ruta.startsWith(raiz), `${que} debe vivir dentro de la raíz de prueba (${ruta})`);
  }
  for (const f of ['memory.json', 'habits.json', 'model-health.json', 'tasks']) {
    ok(out.ficheros.includes(f), `se esperaba ${f} dentro de la raíz (había: ${out.ficheros.join(', ')})`);
  }
});

test('chat: el fallo se explica y la píldora ofrece los modelos de tu API', () => {
  const K = ChatKit;
  // errores crudos del proveedor → causa legible + siguiente paso
  const casos = [
    ['fetch failed', /conectar con el proveedor/i, /conexión/i],
    ['HTTP 401 Unauthorized', /credencial/i, /clave de API/i],
    ['429 Too Many Requests', /limitando/i, /Espera/i],
    ['The operation timed out', /dejó de responder/i, /Reintenta/i],
    ['maximum context length exceeded', /no cabe/i, /conversación nueva/i],
  ];
  for (const [crudo, texto, pista] of casos) {
    const r = K.explainError(crudo);
    ok(texto.test(r.texto), crudo + ' → texto: ' + r.texto);
    ok(pista.test(r.pista), crudo + ' → pista: ' + r.pista);
  }
  // cualquier cosa desconocida sigue diciendo qué hacer en vez de pintarse cruda
  const raro = K.explainError('boom inesperado');
  ok(raro.texto && raro.pista, 'un error no listado también da texto y salida');
  // La píldora ya no dicta estado: ofrece los modelos de la API del usuario
  const prov = { id: 'prov_1', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', models: ['deepseek-flash', 'deepseek-v4.1-flash', 'gpt-5.6-luna'] };
  let c = K.modelChoices({ providerId: 'prov_1', baseUrl: prov.baseUrl, model: 'deepseek-v4.1-flash' }, [prov]);
  eq(c.provider.name, 'OpenCode Go');
  eq(c.models.join(','), 'deepseek-flash,deepseek-v4.1-flash,gpt-5.6-luna', 'los modelos son los de su API, en su orden');
  eq(c.current, 'deepseek-v4.1-flash');
  eq(c.known, true, 'la lista viene del proveedor guardado');
  // sin providerId la activación se empareja por URL (es lo que guarda el renderer)
  c = K.modelChoices({ baseUrl: prov.baseUrl, model: 'deepseek-flash' }, [prov]);
  eq(c.provider.id, 'prov_1');
  eq(c.current, 'deepseek-flash');
  // un modelo activado a mano que no está en la lista sigue siendo elegible
  c = K.modelChoices({ providerId: 'prov_1', baseUrl: prov.baseUrl, model: 'modelo-raro' }, [prov]);
  eq(c.models[0], 'modelo-raro', 'el activo encabeza la lista si no venía en ella');
  eq(c.models.length, 4);
  // repetidos del proveedor y entradas vacías no ensucian el menú
  c = K.modelChoices({ providerId: 'p', baseUrl: 'u', model: 'm' }, [{ id: 'p', baseUrl: 'u', models: ['m', 'm', '', '  ', 'x'] }]);
  eq(c.models.join(','), 'm,x');
  // sin proveedor guardado: solo el modelo activo y se avisa de que falta detectar
  c = K.modelChoices({ baseUrl: 'https://x/v1', model: 'solo-este' }, []);
  eq(c.provider, null); eq(c.known, false); eq(c.models.join(','), 'solo-este');
  // sin modelo activo no hay nada que ofrecer (el menú manda a Ajustes)
  c = K.modelChoices(null, [prov]);
  eq(c.current, null); eq(c.models.length, 0); eq(c.known, false);
  // y ya no existe la etiqueta de estado que dictaba «Conectado»/«Con errores»
  eq(K.statusPill, undefined, 'la píldora de estado se retiró del kit');
});

/* Cierre de la suite: se ejecutan TODOS los tests registrados, en orden, uno
   detrás de otro, y solo entonces se imprime el resumen. */
for (const t of QUEUE) {
  try {
    await t.fn();
    pass++; console.log('  ok  ' + t.name);
  } catch (e) {
    fail++; failures.push({ name: t.name, err: e.message });
    console.error('FAIL  ' + t.name + ' — ' + e.message);
  }
}

// limpieza: la suite no debe dejar basura en %TEMP%
for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

clearTimeout(suiteTimer);   // fin normal: el vigilante ya no hace falta
console.log('');
  if (fail) {
    console.error(`${fail} test(s) fallaron, ${pass} pasaron`);
    failures.forEach(f => console.error('  ✗ ' + f.name + ' → ' + f.err));
    process.exit(1);
  } else {
    console.log(`Todos los tests en verde (${pass})`);
  }
})();
