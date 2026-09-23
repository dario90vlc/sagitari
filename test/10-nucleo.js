'use strict';
/* Suite SAGITARI — núcleo: permisos, guardrails, memoria, tareas, MCP (antes run.js 17-2027).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, tmpDir, test, eq, ok, wait, waitFor, sseResponse, fakeFetch, evData, evNamed, noSignal, Guardrails, describeAction, summarizeArgs, skills, pricingFor, memory, checkpoints, TASKS_TMP, executeTool, subagents, modelsMod, SKILLS_TMP, habits, opencode, protocols, ChatKit, profiles } = require('./comun');

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

test('contexto: mide lo que se manda y suelta lo viejo cuando ya no cabe', () => {
  const contexto = require('../agent/contexto');

  // La medida: los mensajes Y las herramientas. Las definiciones de herramientas son
  // miles de tokens que nadie cuenta y que se pagan en cada paso.
  const herramientas = [{ type: 'function', function: { name: 'read_file', description: 'lee un archivo del proyecto', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const m = contexto.medir([{ role: 'user', content: 'hola' }], herramientas);
  ok(m.herramientas > 0, 'las herramientas cuentan: ' + m.herramientas + ' tokens');
  eq(m.total, m.mensajes + m.herramientas, 'y el total es mensajes + herramientas');
  ok(contexto.estimarTokens('x'.repeat(360)) === 100, 'la estimación es por caracteres (≈3,6 por token): ' + contexto.estimarTokens('x'.repeat(360)));
  eq(contexto.medir([], []).total, 0, 'sin nada, cero');

  // La ventana: por familia de modelo, y se puede forzar
  eq(contexto.ventanaDe({ model: 'claude-sonnet-4' }), 200000, 'un Claude tiene 200k');
  eq(contexto.ventanaDe({ model: 'gpt-4o' }), 128000);
  eq(contexto.ventanaDe({ model: 'lo-que-sea' }), 128000, 'sin dato se asume 128k (avisar antes es mejor que quedarse corto)');
  eq(contexto.ventanaDe({ model: 'lo-que-sea', contextWindow: 32000 }), 32000, 'y el usuario puede fijarla');

  // Los tres tramos
  const grande = [{ role: 'system', content: 'x'.repeat(1000) }, { role: 'user', content: 'y'.repeat(1000) }];
  eq(contexto.presupuesto({ messages: grande, tools: [], cfg: { model: 'gpt-4o' } }).estado, 'hola', 'un prompt pequeño va holgado');
  const medio = [{ role: 'user', content: 'y'.repeat(128000 * 0.65 * 3.6) }];
  eq(contexto.presupuesto({ messages: medio, tools: [], cfg: { model: 'gpt-4o' } }).estado, 'ajustado', 'al 65% ya va ajustado');
  const lleno = [{ role: 'user', content: 'y'.repeat(128000 * 0.9 * 3.6) }];
  const pl = contexto.presupuesto({ messages: lleno, tools: [], cfg: { model: 'gpt-4o' } });
  eq(pl.estado, 'apretado', 'al 90% está apretado');
  ok(pl.libre >= 0, 'y el sitio libre no se va a negativo');
  eq(contexto.notaPresupuesto({ estado: 'hola', uso: 0.1 }), '', 'con sitio de sobra no se le dice nada al modelo: no hay nada que hacer con ese dato');
  ok(/PRESUPUESTO DE CONTEXTO/.test(contexto.notaPresupuesto(pl)), 'y apretado se le dice qué hacer (leer por tramos, no repetir), no solo cuánto queda');

  /* Soltar lo viejo: se sueltan bloques ENTEROS (un assistant con sus tool_result),
     porque soltar el assistant y dejar sus resultados haría que el proveedor rechazara
     la petición. Y el sistema y la cola reciente no se tocan nunca. */
  const conversacion = [{ role: 'system', content: 'reglas' }];
  for (let i = 1; i <= 30; i++) {
    conversacion.push({ role: 'user', content: 'pregunta ' + i });
    conversacion.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, function: { name: 'read_file', arguments: '{}' } }] });
    conversacion.push({ role: 'tool', tool_call_id: 'c' + i, content: 'v'.repeat(15000) });
  }
  const rec = contexto.recortarMensajes(conversacion, [], { model: 'gpt-4o' });
  ok(rec.quitados > 0, 'con el contexto lleno se sueltan bloques: ' + rec.quitados);
  ok(rec.tokensLiberados > 0, 'y se informan los tokens que se dejan de pagar: ' + rec.tokensLiberados);
  eq(rec.messages[0].role, 'system', 'el bloque de sistema se queda (es lo único que no se puede perder)');
  const sueltos = rec.messages.filter(x => x.role === 'tool' && !rec.messages.some(y => y.role === 'assistant' && (y.tool_calls || []).some(c => c.id === x.tool_call_id)));
  eq(sueltos.length, 0, 'y no queda ningún resultado de herramienta huérfano (el proveedor rechazaría la petición)');
  eq(rec.messages[1].role, 'user', 'la conversación recortada empieza por el usuario');
  ok(rec.messages.length >= 7, 'se conserva una cola suficiente para seguir trabajando: ' + rec.messages.length + ' mensajes');
  const corta = [{ role: 'system', content: 'reglas' }, { role: 'user', content: 'hola' }];
  eq(contexto.recortarMensajes(corta, [], { model: 'claude-sonnet-4' }).quitados, 0, 'si cabe, no se suelta nada');
  const sinSistema = contexto.recortarMensajes([{ role: 'user', content: 'y'.repeat(500000) }], [], { model: 'gpt-4o' });
  ok(sinSistema.quitados >= 0, 'sin nada que soltar tampoco se rompe');
});

test('protocolos: la caché de prompt se marca donde toca y se puede apagar', () => {
  const protocolos = require('../agent/protocols');
  const messages = [{ role: 'system', content: 'eres sagitari' }, { role: 'user', content: 'hola' }];
  const tools = [
    { type: 'function', function: { name: 'a', description: 'x', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'b', description: 'y', parameters: { type: 'object' } } },
  ];
  const body = protocolos.buildBodyAnthropic({ model: 'claude-sonnet-4', maxTokens: 100 }, messages, tools);
  eq(Array.isArray(body.system) && body.system[0].type, 'text', 'el sistema viaja como bloque');
  eq(body.system[0].cache_control.type, 'ephemeral', 'marcado para el caché (ahí está el prompt que no cambia)');
  ok(!body.tools[0].cache_control, 'el corte no se pone en la primera herramienta');
  eq(body.tools[1].cache_control.type, 'ephemeral', 'sino en la ÚLTIMA: así se cachea el bloque de herramientas entero');
  ok(body.tools[1].input_schema && body.tools[1].description, 'y las herramientas siguen viajando como antes');

  const sin = protocolos.buildBodyAnthropic({ model: 'claude-sonnet-4', maxTokens: 100, cachePrompt: false }, messages, tools);
  ok(!sin.system[0] || !sin.system[0].cache_control, 'con el ajuste apagado no se marca nada (hay proveedores compatibles que rechazan el campo)');
  ok(!sin.tools[1].cache_control, 'ni en las herramientas');
});

test('agent: el caché de prompt sale en la petición de verdad (y se apaga desde Ajustes)', async () => {
  const { Agent } = require('../agent/agent');
  const sink = {};
  const agent = new Agent({
    fetchFn: fakeFetch([evData({ choices: [{ delta: { content: 'ok' } }] })], sink),
    emit: () => {},
    screenshotFn: async () => ({}),
  });
  // cadena de un proveedor Anthropic: el ajuste tiene que llegar hasta la petición
  const base = { active: { name: 'x', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-sonnet-4' }, settings: { mode: 'act', modelRouting: false } };
  const { chain } = agent._chainFor(base, 'hola');
  eq(chain[0].cachePrompt, true, 'la cadena lleva el ajuste (activo por defecto)');
  const sinCache = agent._chainFor({ ...base, settings: { ...base.settings, promptCache: false } }, 'hola');
  eq(sinCache.chain[0].cachePrompt, false, 'y se puede apagar desde Ajustes');

  // …y se ve en el cuerpo real que se manda al proveedor
  await agent._streamOnce({ ...base.active, format: 'anthropic', cachePrompt: true }, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }], new AbortController().signal);
  ok(Array.isArray(sink.body.system) && sink.body.system[0].cache_control, 'el cuerpo enviado lleva el punto de caché: ' + JSON.stringify(sink.body.system).slice(0, 80));
  await agent._streamOnce({ ...base.active, format: 'anthropic', cachePrompt: false }, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }], new AbortController().signal);
  ok(!sink.body.system[0].cache_control, 'y con el ajuste apagado, no');
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
  // v2.5: el bloque de sistema viaja como bloque de texto MARCADO para el caché de prompt
  // (antes era una cadena suelta): es el prefijo que no cambia entre paso y paso del turno.
  eq(sink.body.system[0].text, 'sys');
  eq(sink.body.system[0].cache_control.type, 'ephemeral');
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

/* Los servidores MCP de stdio se configuran con `"command": "node"` en todos los
   clientes (y es lo que sugiere la propia interfaz). En la app instalada eso dependía de
   que el EQUIPO tuviera Node.js en el PATH: sin él el servidor moría con un «spawn node
   ENOENT» que el usuario no podía arreglar sin saber qué faltaba. Estos tests fijan las
   tres salidas: Node del equipo → el suyo (no se cambia lo que ya funciona), sin Node →
   el que trae la app dentro, y sin ninguno de los dos → un error que dice qué hacer. */
test('mcp: un servidor con command «node» usa el Node del equipo cuando existe', () => {
  const dirFalso = tmpDir('sagi-nodepath-');
  const exeFalso = path.join(dirFalso, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(exeFalso, 'x');
  const env = { PATH: dirFalso };
  const r = mcpTransport.resolveCommand('node', ['servidor.js'], { env });
  eq(r.file, exeFalso, 'se usa el Node instalado, no el de la app');
  eq(r.env.ELECTRON_RUN_AS_NODE, undefined, 'y no se le mete el modo Node de Electron');
  eq(mcpTransport.buscarEnPath(process.platform === 'win32' ? 'node.exe' : 'node', { env }), exeFalso, 'la búsqueda en el PATH encuentra el ejecutable');
  eq(mcpTransport.buscarEnPath(process.platform === 'win32' ? 'node.exe' : 'node', { env: { PATH: '' } }), null, 'y con el PATH vacío no inventa nada');
});

test('mcp: sin Node en el equipo se levanta con el Node que la app trae dentro', () => {
  const r = mcpTransport.resolveCommand('node', ['servidor.js'], { env: { PATH: '' }, esElectron: true, execPath: 'C:\\Apps\\SAGITARI.exe' });
  eq(r.file, 'C:\\Apps\\SAGITARI.exe', 'el propio ejecutable de la app hace de Node');
  eq(r.env.ELECTRON_RUN_AS_NODE, '1', 'con la marca que lo arranca como Node en vez de como app');
  eq(r.argv.length, 1, 'y los argumentos del servidor llegan tal cual');
});

test('mcp: sin Node ni app Electron el error dice qué hacer', () => {
  let err = null;
  try { mcpTransport.resolveCommand('node', ['x.js'], { env: { PATH: '' }, esElectron: false }); } catch (e) { err = e; }
  ok(err && /Node\.js/.test(err.message), 'se explica que falta Node.js: ' + (err && err.message));
});

test('mcp: «npx» sin Node.js avisa en claro en vez de morir dentro de cmd.exe', () => {
  let err = null;
  try { mcpTransport.resolveCommand('npx', ['-y', 'paquete'], { env: { PATH: '' } }); } catch (e) { err = e; }
  ok(err && /Node\.js/.test(err.message) && /nodejs\.org/.test(err.message), 'el aviso trae el arreglo concreto: ' + (err && err.message));
  /* Y con Node instalado no cambia nada: sigue saliendo por cmd.exe (en Windows), que es
     la única forma de lanzar los .cmd de npm. */
  const dirFalso = tmpDir('sagi-nodepath2-');
  fs.writeFileSync(path.join(dirFalso, process.platform === 'win32' ? 'node.exe' : 'node'), 'x');
  const r = mcpTransport.resolveCommand('npx', ['-y', 'paquete'], { env: { PATH: dirFalso } });
  if (process.platform === 'win32') ok(r.verbatim && /cmd\.exe$/i.test(r.file), 'con Node presente, npx sale por cmd.exe: ' + r.file);
  else eq(r.file, 'npx', 'fuera de Windows se lanza tal cual');
});

test('mcp: el entorno del resolver no pisa lo que configure el usuario', async () => {
  /* El merge del entorno se comprueba con un servidor de verdad: si el usuario define
     ELECTRON_RUN_AS_NODE por su cuenta, manda él. */
  const rutaEco = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
  const tr = mcpTransport.createStdioTransport({
    command: process.execPath, args: [rutaEco], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpDir('sagi-mcp-env-'),
  });
  const init = await tr.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SAGITARI', version: 'test' } }, { timeoutMs: 5000 });
  ok(init && init.serverInfo, 'el servidor arranca igual con ese entorno: ' + JSON.stringify(init && init.serverInfo));
  tr.kill();
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

test('permisos: el comodin del servidor usa la misma normalizacion que el nombre expuesto', () => {
  const { mapToolName, serverSlug } = require('../agent/mcp');
  for (const id of ['my-server', 'servidor-con-nombre-muy-largo', 'eco']) {
    const nombre = mapToolName(id, 'crear_nota');
    const g = new Guardrails({ permissions: { [`mcp__${serverSlug(id)}__*`]: 'restricted' } });
    eq(g.decide(nombre, {}).action, 'deny', id + ': el comodin debe bloquear ' + nombre);
    // `decide().reason` es el mensaje para el usuario, no el nivel: el nivel se comprueba
    // donde vive (es el mismo dato que consulta decide para negar).
    eq(g.levelFor(nombre), 'restricted', id + ': el comodin resuelve el nivel del servidor');
    const g2 = new Guardrails({ permissions: { [`mcp__${id}__*`]: 'restricted' } });
    /* Con `eco` el id crudo YA es el slug, así que la clave coincide: ese caso fija la
       igualdad de las dos expresiones. En los que discriminan (guion, o más de 16
       caracteres) el id crudo NO puede coincidir, y por eso hay que normalizar. */
    const esperado = serverSlug(id) === id ? 'deny' : 'confirm';
    eq(g2.decide(nombre, {}).action, esperado, id + ': el id CRUDO no puede coincidir (por eso hay que normalizar)');
  }
  eq(serverSlug('my-server'), 'my_server');
  eq(serverSlug('servidor-con-nombre-muy-largo'), 'servidor_con_nom');
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

/* ---------- MCP: configuración del usuario (validación pura, sin Electron) ---------- */

test('mcp: la validacion de un servidor rechaza lo que no puede funcionar', () => {
  const { validateServer } = require('../main/mcp-config');
  const base = { id: 'eco', name: 'Eco', transport: 'stdio', command: 'npx', args: ['-y', 'x'] };
  ok(validateServer(base).ok, 'un servidor stdio válido pasa');
  eq(validateServer({ ...base, id: 'Con Espacios!' }).value.id, 'con_espacios', 'el id se sanea');
  for (const malo of [
    { ...base, id: '' },
    { ...base, id: '../fuera' },
    { ...base, transport: 'carrier-pigeon' },
    { ...base, transport: 'stdio', command: '' },
    { ...base, transport: 'http', url: 'http://mcp.ejemplo.com/mcp' },
    { ...base, transport: 'http', url: 'file:///C:/x' },
    { ...base, transport: 'stdio', timeoutMs: -5 },
    { ...base, command: 'npx', args: ['a', 'b"c'] },
  ]) ok(validateServer(malo).ok === false, 'debe rechazar ' + JSON.stringify(malo).slice(0, 90));
  ok(validateServer({ ...base, transport: 'http', url: 'https://x/mcp' }).ok, 'https remoto vale');
  ok(validateServer({ ...base, transport: 'http', url: 'http://127.0.0.1:9/mcp' }).ok, 'http en localhost vale');
  const conListas = validateServer({ ...base, tools: { allow: 'echo', deny: ['x', '', 2] } });
  eq(conListas.value.tools.allow.join(','), 'echo');
  eq(conListas.value.tools.deny.join(','), 'x');
});

test('mcp: un args que no es lista se rechaza con un mensaje legible', () => {
  const { validateServer } = require('../main/mcp-config');
  const base = { id: 'eco', name: 'Eco', transport: 'stdio', command: 'npx' };
  for (const malo of ['-y paquete', 42, { a: 1 }]) {
    const r = validateServer({ ...base, args: malo });
    eq(r.ok, false, 'debe rechazar args = ' + JSON.stringify(malo));
    ok(/lista/.test(r.error), 'con un motivo entendible: ' + r.error);
  }
  ok(validateServer({ ...base, args: ['-y', 'paquete'] }).ok, 'una lista válida sigue pasando');
});

test('mcp: args nulo o vacío se acepta como lista vacía', () => {
  const { validateServer } = require('../main/mcp-config');
  const base = { id: 'eco', name: 'Eco', transport: 'stdio', command: 'npx' };
  for (const vacio of [null, '', undefined]) {
    const r = validateServer({ ...base, args: vacio });
    ok(r.ok, 'args ' + JSON.stringify(vacio) + ' debe cargar el servidor sin argumentos: ' + r.error);
    eq(r.value.args.join(','), '', 'y quedar como lista vacía');
  }
});

test('mcp: importar el JSON de otro cliente y conservar secretos al guardar', () => {
  const { parseMcpImport, mergeSecrets } = require('../main/mcp-config');
  const r = parseMcpImport(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } },
    remoto: { url: 'https://mcp.ejemplo.com/mcp', headers: { Authorization: 'Bearer t' } },
    roto: { command: '' },
  } }));
  ok(r.ok, JSON.stringify(r));
  eq(r.servers.map(s => s.id).sort().join(','), 'github,remoto', 'la entrada inválida se descarta');
  eq(r.servers.find(s => s.id === 'github').transport, 'stdio');
  eq(r.servers.find(s => s.id === 'remoto').transport, 'http');
  // guardar con el campo de secreto vacío no puede borrar el que ya había
  eq(mergeSecrets({ TOKEN: 'viejo' }, { TOKEN: '' }).TOKEN, 'viejo');
  eq(mergeSecrets({ TOKEN: 'viejo' }, { TOKEN: 'nuevo' }).TOKEN, 'nuevo');
  eq(mergeSecrets({}, { TOKEN: 'nuevo' }).TOKEN, 'nuevo');
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
