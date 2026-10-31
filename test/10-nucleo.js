'use strict';
/* Suite SAGITARI — núcleo: permisos, guardrails, memoria, tareas, MCP (antes run.js 17-2027).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const {
  fs,
  path,
  tmpDir,
  test,
  eq,
  ok,
  wait,
  waitFor,
  sseResponse,
  fakeFetch,
  evData,
  evNamed,
  noSignal,
  Guardrails,
  describeAction,
  summarizeArgs,
  skills,
  pricingFor,
  memory,
  MEM_DIR,
  checkpoints,
  TASKS_TMP,
  executeTool,
  subagents,
  modelsMod,
  SKILLS_TMP,
  habits,
  opencode,
  protocols,
  ChatKit,
} = require('./comun');

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
  g.approvals.set(d.signature, Date.now() - 1); // caducada
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
  ok(g.checkStep().ok);
  ok(g.checkStep().ok);
  ok(g.checkStep().ok);
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
  ok(g.checkToolCall().ok);
  ok(g.checkToolCall().ok);
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
  g.checkStep();
  g.checkStep();
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
  g.isLoop('t', { x: 1 });
  g.isLoop('t', { x: 2 });
  g.isLoop('t', { x: 1 });
  g.isLoop('t', { x: 2 });
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
  const raw =
    '---\nname: prueba\nversion: 2.1.0\nauthor: Ana\ntools:\n  - run_command\n  - read_file\ndescription: Prueba de parseo\n---\n\nCuerpo de la skill.\n';
  const fm = skills.__test ? skills.__test.parseFrontMatter(raw) : null;
  // parseFrontMatter no está exportado; probamos vía el módulo si existe el hook de test
  if (!fm) {
    console.log('  (skip: parseFrontMatter no exportado)');
    return;
  }
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
  ok(!strict.some((x) => x.overlap > 0), 'nada relevante para recetas de cocina');
});

test('relevantMemories falls back to most important when nothing overlaps', () => {
  const rel = memory.relevantMemories('tema totalmente distinto xyzzy', { minScore: 0.99 });
  ok(rel.length >= 1, 'fallback a importantes');
  ok(rel.every((x) => x.overlap === 0));
});

test('memory update clamps importance and removes work', () => {
  const l = memory.list();
  const id = l[0].id;
  memory.update(id, { importance: 7 });
  eq(memory.list().find((x) => x.id === id).importance, 1, 'clamp a 1');
  memory.remove(id);
  ok(!memory.list().find((x) => x.id === id));
});

/* ---------- memoria v2: migración, fusión y almacén en disco ---------- */

test('memory: un memory.json v1 (array) se migra a v2 fusionando los duplicados', () => {
  const dir = tmpDir('sagi-memv2-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(
    f,
    JSON.stringify([
      { id: 'a', text: 'El usuario se llama Darío', date: '2026-10-12T10:00:00.000Z' },
      { id: 'b', text: 'Recuerda que me llamo Dario', date: '2026-10-13T10:00:00.000Z' },
    ]),
    'utf8',
  );
  memory.__test._resetForTests(f);
  const list = memory.list();
  eq(list.length, 1, 'las dos entradas del usuario quedan en una');
  ok(list[0].origen, 'trae el origen v2');
  ok(fs.existsSync(f + '.bak'), 'se conserva una copia .bak antes de migrar');
  ok(fs.existsSync(f.replace(/\.json$/, '') + '.bak-v1'), 'y el original v1 como .bak-v1');
  const enDisco = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq(enDisco.version, 2, 'el fichero se reescribe en el esquema v2');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json')); // vuelve al almacén de la suite
});

test('memory: la migración de las dos entradas REALES del perfil deja una sola', () => {
  /* Copia literal de %APPDATA%/SagitariAI/memory.json del 14 oct 2026: las dos entradas
     dicen lo mismo («El usuario se llama Darío» / «Recuerda que me llamo Dario») y la
     aceptación de la fase 1 es que queden en UNA, con los usos sumados. */
  const dir = tmpDir('sagi-memreal-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(
    f,
    JSON.stringify([
      {
        id: 'mmu5rk15nr5hq',
        text: 'El usuario se llama Darío.',
        date: '2026-09-17T16:48:15.323Z',
        lastUsed: '2026-10-01T10:58:25.849Z',
        uses: 53,
        importance: 0.8,
        confidence: 0.8,
        source: 'agent',
      },
      {
        id: 'mmtxa7yco1m8n',
        text: 'Recuerda que me llamo Dario',
        date: '2026-09-11T18:20:48.936Z',
        lastUsed: '2026-10-01T10:58:25.849Z',
        uses: 49,
        importance: 1,
        confidence: 0.8,
        source: 'user',
      },
    ]),
    'utf8',
  );
  memory.__test._resetForTests(f);
  const vivos = memory.list();
  const tapados = memory.listTrash();
  eq(vivos.length + tapados.length, 1, 'un solo hecho (vivo o en la papelera)');
  const enDisco = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq(enDisco.version, 2);
  eq(enDisco.hechos.length, 1, 'el fichero migrado tiene un hecho, no dos');
  eq(enDisco.hechos[0].uses, 103, '53 + 49 usos, más el refuerzo de la propia fusión');
  eq(enDisco.hechos[0].text, 'El usuario se llama Darío.', 'gana el texto del dato más reciente');
  eq(enDisco.hechos[0].importance, 1, 'gana la importancia mayor');
  eq(enDisco.hechos[0].origen, 'herramienta', 'el `source: agent` de la v1 se traduce a origen');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: añadir un hecho parecido lo consolida en vez de duplicarlo', () => {
  const dir = tmpDir('sagi-memcon-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const a = memory.add({ text: 'Prefiero informes en PDF', importance: 0.5 });
  const b = memory.add({ text: 'Prefiero los informes en PDF', importance: 0.7 });
  eq(memory.list().length, 1, 'no hay dos entradas parecidas');
  ok(b.fusionado, 'se informa de la fusión');
  eq(b.antes.id, a.id, 'se puede deshacer sobre el hecho anterior');
  eq(memory.list()[0].importance, 0.7, 'gana la importancia mayor');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* Sonda de la auditoría (defecto alto): cuatro hechos v1 distintos se quedaban en DOS al
   migrar, porque la fusión decidía por parecido de texto («prefiero el café» con
   «prefiero el té», «…en Windows» con «…en Linux»). La migración tiene que usar el valor. */
test('memory: la migración v1 no fusiona hechos distintos que se parecen', () => {
  const dir = tmpDir('sagi-memmig4-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(
    f,
    JSON.stringify([
      { id: 'c1', text: 'Prefiero el café' },
      { id: 'c2', text: 'Prefiero el té' },
      { id: 'w1', text: 'El usuario usa VS Code en Windows' },
      { id: 'w2', text: 'El usuario usa VS Code en Linux' },
    ]),
    'utf8',
  );
  memory.__test._resetForTests(f);
  const textos = memory.list().map((m) => m.text);
  eq(textos.length, 4, 'ningún hecho distinto se pierde al migrar: ' + JSON.stringify(textos));
  ok(textos.includes('Prefiero el café') && textos.includes('Prefiero el té'), 'las dos preferencias siguen');
  ok(
    textos.includes('El usuario usa VS Code en Windows') && textos.includes('El usuario usa VS Code en Linux'),
    'y los dos sistemas también: ' + JSON.stringify(textos),
  );
  eq(memory.listTrash().length, 0, 'la migración no manda nada a la papelera');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* ---------- memoria v2: el valor manda en la fusión ----------
   La similitud léxica sola fusionaba «prefiero el té» con «prefiero el café» y el primero
   desaparecía sin rastro. Aquí se fija la regla: mismo dato → se consolida; valor distinto
   de un dato único (nombre, idioma, dónde vives) → sustituye mandando el viejo a la
   PAPELERA; valor distinto de algo que admite varios (preferencias) → conviven. */

test('memory: el mismo dato escrito de otra forma se consolida, no se duplica', () => {
  const dir = tmpDir('sagi-memmismo-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const a = memory.add({ text: 'El usuario se llama Darío' });
  const b = memory.add({ text: 'Me llamo Dario' });
  eq(memory.list().length, 1, 'un solo nombre: ' + JSON.stringify(memory.list().map((m) => m.text)));
  ok(b.fusionado, 'se informa de la fusión');
  eq(b.antes.id, a.id, 'sobre el hecho anterior');
  eq(memory.list()[0].text, 'Me llamo Dario', 'gana el texto reciente');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: el mismo dato escrito de otra forma se consolida aunque el texto nuevo no tenga clave', () => {
  /* «Recuerda que…» impide que `claveHecho` reconozca el dato, así que cae al recurso sin
     clave: ahí `mismoHecho` lo empareja con el nombre ya guardado (antes solo miraba la
     huella y quedaban dos hechos vivos). */
  const dir = tmpDir('sagi-memclave-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const a = memory.add({ text: 'El usuario se llama Darío' });
  const b = memory.add({ text: 'Recuerda que me llamo Dario' });
  eq(memory.list().length, 1, 'un solo nombre: ' + JSON.stringify(memory.list().map((m) => m.text)));
  ok(b.fusionado, 'se informa de la fusión');
  eq(b.antes.id, a.id, 'sobre el hecho anterior');
  eq(memory.list()[0].text, 'Recuerda que me llamo Dario', 'gana el texto reciente');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: dos preferencias distintas no se fusionan y no se pierde ninguna', () => {
  const dir = tmpDir('sagi-memdist-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Prefiero el té' });
  memory.add({ text: 'Prefiero el café' });
  const vivos = memory.list();
  eq(vivos.length, 2, 'las dos preferencias siguen ahí: ' + JSON.stringify(vivos.map((m) => m.text)));
  eq(memory.listTrash().length, 0, 'ninguna se tira por parecerse a la otra');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: una preferencia no se pierde al decir una contraria de otro objeto', () => {
  const dir = tmpDir('sagi-memgjust-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Al usuario le gusta el té' });
  memory.add({ text: 'No me gusta el café' });
  const textos = memory.list().map((m) => m.text);
  ok(textos.includes('Al usuario le gusta el té'), 'el té sigue: ' + JSON.stringify(textos));
  ok(textos.includes('No me gusta el café'), 'y el café también: ' + JSON.stringify(textos));
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: corregir el valor de un dato único sustituye y el viejo va a la papelera', () => {
  const dir = tmpDir('sagi-memsust-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const a = memory.add({ text: 'Vivo en Barcelona' });
  const b = memory.add({ text: 'Vivo en Madrid' });
  const vivos = memory.list();
  eq(vivos.length, 1, 'un solo sitio donde vives: ' + JSON.stringify(vivos.map((m) => m.text)));
  eq(vivos[0].text, 'Vivo en Madrid', 'gana el dato nuevo');
  ok(b.sustituido, 'se informa de que sustituye a otro hecho');
  eq(b.antes.id, a.id, 'y de cuál (para poder deshacer)');
  const pap = memory.listTrash();
  eq(pap.length, 1, 'el viejo NO se borra: queda en la papelera');
  eq(pap[0].text, 'Vivo en Barcelona');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: la polaridad invertida del mismo objeto sustituye, no duplica', () => {
  const dir = tmpDir('sagi-mempol-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Me gusta el té' });
  memory.add({ text: 'No me gusta el té' });
  const vivos = memory.list();
  eq(vivos.length, 1, 'una sola versión: ' + JSON.stringify(vivos.map((m) => m.text)));
  eq(vivos[0].text, 'No me gusta el té', 'gana la última');
  eq(memory.listTrash().length, 1, 'la versión anterior queda recuperable');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: dos datos distintos que se parecen («vive en» / «trabaja en») no se pisan', () => {
  const dir = tmpDir('sagi-memotro-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'El usuario vive en Madrid' });
  memory.add({ text: 'El usuario trabaja en Madrid' });
  const textos = memory
    .list()
    .map((m) => m.text)
    .sort();
  eq(textos.length, 2, 'conviven los dos, no se fusionan por parecerse: ' + JSON.stringify(textos));
  eq(memory.listTrash().length, 0, 'y ninguno se tira');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* Sonda de la auditoría (defecto medio): con «me gusta el té» y «me gusta el café» vivos,
   «no me gusta el té» se comparaba con el PRIMERO del mismo predicado (el café), así que
   la contradicción del té se quedaba viva y los tres viajaban al prompt. */
test('memory: la contradicción se resuelve sobre el hecho del MISMO objeto, no sobre el primero del predicado', () => {
  const dir = tmpDir('sagi-memcontra-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Al usuario le gusta el té' });
  memory.add({ text: 'Al usuario le gusta el café' });
  memory.add({ text: 'Al usuario no le gusta el té' });
  const vivos = memory.list().map((m) => m.text);
  eq(vivos.length, 2, 'la contradicción del té se resuelve: ' + JSON.stringify(vivos));
  ok(vivos.includes('Al usuario le gusta el café'), 'el café (otro objeto) no se toca: ' + JSON.stringify(vivos));
  ok(vivos.includes('Al usuario no le gusta el té'), 'gana la última versión del té');
  ok(!vivos.includes('Al usuario le gusta el té'), 'y la versión vieja no convive con su contraria');
  const tapados = memory.listTrash().map((m) => m.text);
  eq(tapados.length, 1, 'lo sustituido queda recuperable: ' + JSON.stringify(tapados));
  eq(tapados[0], 'Al usuario le gusta el té');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* Sonda de la auditoría (defecto medio): dos hechos sin clave reconocible se fusionaban
   por parecido léxico y el recurso dejaba SOLO el texto nuevo, sin papelera. */
test('memory: dos hechos sin clave no se fusionan por parecerse (no se pierde ninguno)', () => {
  const dir = tmpDir('sagi-mempnpm-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Usa siempre pnpm para instalar dependencias' });
  memory.add({ text: 'Usa siempre npm para instalar dependencias' });
  const textos = memory.list().map((m) => m.text).sort();
  eq(textos.length, 2, 'conviven los dos: ' + JSON.stringify(textos));
  eq(memory.listTrash().length, 0, 'y ninguno se tira por parecerse');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: sin clave, el mismo dato escrito con otros acentos se deduplica por huella', () => {
  const dir = tmpDir('sagi-memhuella-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Usa el tema oscuro en la configuración' });
  memory.add({ text: 'Usa el tema oscuro en la configuracion' });
  eq(memory.list().length, 1, 'una sola entrada: ' + JSON.stringify(memory.list().map((m) => m.text)));
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: el techo del almacén no borra en silencio (lo que sobra va a la papelera)', () => {
  const dir = tmpDir('sagi-memtecho-');
  const f = path.join(dir, 'memory.json');
  const hechos = [];
  const ahora = new Date().toISOString();
  for (let i = 0; i < memory.__test.MAX_MEMORIES; i++) hechos.push({ id: 'm' + i, text: 'Hecho ' + i, date: ahora, lastUsed: ahora });
  fs.writeFileSync(f, JSON.stringify({ version: 2, hechos }), 'utf8');
  memory.__test._resetForTests(f);
  memory.add({ text: 'Un hecho más que desborda el techo' });
  eq(memory.list().length, memory.__test.MAX_MEMORIES, 'la lista viva se queda en el techo');
  eq(memory.listTrash().length, 1, 'y lo que sobra está en la papelera, no borrado');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* ---------- memoria v2: un almacén que no se puede leer NO se pisa ----------
   Un error de E/S (fichero bloqueado por antivirus u otro proceso, EBUSY/EPERM típicos de
   Windows) dejaba la memoria vacía todo el proceso y la siguiente escritura machacaba
   memory.json. Ahora el almacén se declara no disponible (la vista lo dice y ofrece
   «Restaurar copia»), se reintenta la lectura y NUNCA se escribe encima. */

test('memory: un error de E/S al leer no vacía la memoria ni deja pisar el fichero', () => {
  const dir = tmpDir('sagi-memio-');
  const f = path.join(dir, 'memory.json');
  /* Un fichero que existe pero no se puede leer como texto: un DIRECTORIO con ese nombre
     (readFileSync lanza EISDIR, igual que un EBUSY: no es ENOENT, así que no es «no hay
     memoria»). */
  fs.mkdirSync(f);
  fs.writeFileSync(path.join(f, 'dentro.txt'), 'no tocar', 'utf8');
  memory.__test._resetForTests(f);

  eq(memory.list().length, 0, 'sin poder leerlo no hay hechos que enseñar');
  const est = memory.estado();
  eq(est.ok, false, 'el almacén se declara no disponible: ' + JSON.stringify(est));
  ok(/no se pudo leer/.test(est.error), 'y dice por qué: ' + est.error);

  eq(memory.add({ text: 'Un hecho nuevo' }), null, 'no se acepta un hecho que no se puede guardar');
  eq(memory.wipe().ok, false, 'olvidarlo todo tampoco: escribir sería perder lo que no hemos leído');
  eq(fs.readdirSync(f).join(','), 'dentro.txt', 'el almacén original sigue intacto');

  /* Cuando el problema desaparece, la lectura se reintenta sola y la memoria vuelve. */
  fs.rmSync(f, { recursive: true, force: true });
  fs.writeFileSync(f, JSON.stringify({ version: 2, hechos: [{ id: 'ok1', text: 'Hecho de antes' }] }), 'utf8');
  eq(memory.list().length, 1, 'el reintento recupera lo que había: ' + JSON.stringify(memory.list().map((m) => m.text)));
  eq(memory.estado().ok, true, 'y el almacén vuelve a estar disponible');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: un memory.json ilegible no se disfraza de memoria vacía (avisa y conserva)', () => {
  const dir = tmpDir('sagi-memcor-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{{{', 'utf8');
  memory.__test._resetForTests(f);

  eq(memory.list().length, 0);
  const est = memory.estado();
  eq(est.ok, false, 'el almacén avisa en vez de fingir que no sabe nada: ' + JSON.stringify(est));
  ok(/interpretar/.test(est.error), 'con el motivo: ' + est.error);
  ok(
    fs.readdirSync(dir).some((n) => /^memory\.corrupt-\d+\.json$/.test(n)),
    'el fichero ilegible se conserva aparte',
  );
  /* El original está a salvo en cuarentena: escribir de nuevo no borra nada, y el
     almacén vuelve a estar disponible en cuanto hay algo que guardar. */
  const m = memory.add({ text: 'Un hecho escrito después' });
  ok(m && m.id, 'se puede volver a escribir');
  eq(memory.estado().ok, true, 'y el almacén vuelve a estar disponible');
  eq(memory.list().length, 1);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* Sonda de la auditoría (defecto alto): cuando la cuarentena NO pudo conservar el original
   ilegible, el almacén seguía aceptando escrituras: `cache` se quedaba en una lista vacía
   y `save()` reescribía el fichero, pisando el original que seguía en su sitio sin poder
   leerse. La cuarentena se fuerza a fallar (renameSync no puede mover el fichero), que es
   exactamente el caso «no se pudo conservar». */
test('memory: un memory.json ilegible que NO se pudo conservar bloquea cualquier escritura', () => {
  const dir = tmpDir('sagi-memroto-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{{{', 'utf8');
  const renameReal = fs.renameSync;
  fs.renameSync = () => {
    const e = new Error('EPERM: no se pudo mover el fichero');
    e.code = 'EPERM';
    throw e;
  };
  try {
    memory.__test._resetForTests(f);
    eq(memory.list().length, 0, 'no se inventa una memoria vacía que no es cierta');
    const est = memory.estado();
    eq(est.ok, false, 'el almacén se declara no disponible: ' + JSON.stringify(est));
    eq(est.bloqueado, true, 'y marca el bloqueo de escritura: ' + JSON.stringify(est));
    eq(memory.add({ text: 'No se debe guardar' }), null, 'no se acepta un hecho');
    eq(memory.wipe().ok, false, 'olvidarlo todo tampoco');
    eq(memory.trashEmpty().ok, false, 'ni se toca la papelera');
    eq(
      fs.readdirSync(dir).filter((n) => /\.(tmp|bak)$/.test(n)).length,
      0,
      'no se intenta escribir nada: ' + JSON.stringify(fs.readdirSync(dir)),
    );
    eq(fs.readFileSync(f, 'utf8'), '{{{', 'y el original ilegible sigue intacto');
  } finally {
    fs.renameSync = renameReal;
  }
  /* Con una copia buena, restaurar es la salida: repone el almacén y vuelve a escribirse. */
  fs.writeFileSync(f + '.bak', JSON.stringify({ version: 2, hechos: [{ id: 'c1', text: 'Hecho rescatado' }] }), 'utf8');
  const r = memory.restaurarCopia();
  ok(r.ok, 'se restaura la copia: ' + r.error);
  eq(memory.estado().ok, true, 'el almacén vuelve a estar disponible');
  ok(memory.list().some((x) => /Hecho rescatado/.test(x.text)), 'con el hecho de la copia');
  ok(memory.add({ text: 'Ya se puede escribir' }), 'y se vuelve a poder guardar');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: la bandeja no admite propuestas sin texto', () => {
  const dir = tmpDir('sagi-memtrayvacio-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  eq(memory.trayProponer([{ texto: '' }, { texto: '   ' }, {}]).length, 0, 'nada que aprobar');
  eq(memory.trayList().length, 0, 'una propuesta sin texto no es una propuesta');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: la bandeja no se recorta por detrás: al llenarse deja de admitir propuestas', () => {
  const dir = tmpDir('sagi-memtraylleno-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const tope = memory.__test.MAX_BANDEJA;
  const props = [];
  for (let i = 0; i < tope + 2; i++) props.push({ texto: 'Propuesta distinta número ' + i });
  memory.trayProponer(props);
  const lista = memory.trayList();
  eq(lista.length, tope, 'la bandeja se queda en su tope');
  eq(lista[0].texto, 'Propuesta distinta número 0', 'y no se tira la más antigua por detrás');
  eq(lista[tope - 1].texto, 'Propuesta distinta número ' + (tope - 1), 'ni se cuela una de más');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: ni el hecho ni la frase de la que salió guardan una clave', () => {
  const dir = tmpDir('sagi-memsec-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const clave = 'sk-abcdefgh12345678';
  const m = memory.add({ text: 'Mi token de la API es ' + clave, origenTexto: 'recuerda que mi token es ' + clave });
  ok(m && !m.text.includes(clave), 'el hecho no guarda la clave: ' + m.text);
  ok(!m.origenTexto.includes(clave), 'ni la frase literal: ' + m.origenTexto);
  memory.trayProponer([{ texto: 'Mi clave es ' + clave, origenTexto: 'mi clave es ' + clave }]);
  const p = memory.trayList()[0];
  ok(!(p.texto + p.origenTexto).includes(clave), 'la bandeja tampoco: ' + JSON.stringify(p));
  ok(!JSON.stringify(memory.exportar()).includes(clave), 'y el volcado de exportación tampoco');
  /* La redacción enmascara patrones, no recorta: un hecho largo se guarda entero (la
     lista de recortes de runlog es para el registro, no para la memoria). */
  const larga = 'El usuario prefiere que le explique las cosas con detalle: ' + 'x'.repeat(300);
  eq(memory.add({ text: larga }).text, larga, 'un hecho largo se guarda completo');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

/* ---------- memoria v2: olvido no destructivo, papelera y copias ---------- */

test('memory: olvidar mueve a la papelera, no borra', () => {
  const dir = tmpDir('sagi-mempap-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const años = new Date(Date.now() - 400 * 86400000).toISOString();
  const h = memory.add({ text: 'Dato antiquísimo sin usar', importance: 0.9 });
  memory.update(h.id, {}); // asegura que el almacén está cargado
  // se falsifica la antigüedad por la puerta de tests: el hecho lleva 400 días sin usarse
  const almacen = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  almacen.hechos[0].lastUsed = años;
  almacen.hechos[0].date = años;
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(almacen), 'utf8');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.prune();
  eq(memory.list().length, 0, 'sale de la lista de activos');
  eq(memory.listTrash().length, 1, 'pero está en la papelera');
  const r = memory.restore(h.id);
  ok(r.ok, 'se puede restaurar');
  eq(memory.list().length, 1, 'vuelve a los activos');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: borrar un hecho lo manda a la papelera y se puede deshacer', () => {
  const dir = tmpDir('sagi-membor-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const h = memory.add({ text: 'Un dato que voy a borrar', importance: 0.6 });
  eq(memory.remove(h.id).ok, true);
  ok(!memory.list().some((m) => m.id === h.id), 'sale de la lista viva');
  eq(memory.listTrash().length, 1, 'no se borró: está en la papelera');
  eq(memory.restore(h.id).ok, true);
  ok(
    memory.list().some((m) => m.id === h.id),
    'vuelve con deshacer',
  );
  eq(memory.listTrash().length, 0);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: exportar incluye activos y papelera, y wipe lo borra todo (bandeja incluida)', () => {
  const dir = tmpDir('sagi-memexp-');
  const f = path.join(dir, 'memory.json');
  const ft = path.join(dir, 'memory-tray.json');
  memory.__test._resetForTests(f);
  memory.__test._resetTray(ft);
  memory.add({ text: 'Un hecho para exportar' });
  memory.add({ text: 'Otro hecho exportable' });
  memory.remove(memory.list()[0].id);
  memory.proponerDeTurno('me llamo Darío', { convId: 'c1' });
  ok(memory.trayList().length === 1, 'la bandeja tiene una propuesta antes de olvidarlo todo');
  const exp = memory.exportar();
  eq(exp.version, 2);
  eq(exp.hechos.length, 1, 'los vivos');
  eq(exp.papelera.length, 1, 'y los de la papelera: el volcado no filtra nada');
  ok(exp.hechos[0].origen, 'el volcado lleva el origen');
  eq(JSON.parse(JSON.stringify(exp)).version, 2, 'serializable tal cual a JSON');
  const w = memory.wipe();
  ok(w.ok);
  eq(memory.list().length, 0);
  eq(memory.listTrash().length, 0);
  /* «Olvídalo todo» promete hechos, papelera y bandeja: la bandeja también se vacía (y,
     en el router, el perfil de hábitos: `habits.reset()` desde `memory:wipe`). */
  eq(memory.trayList().length, 0, 'la bandeja queda vacía');
  eq(JSON.parse(fs.readFileSync(ft, 'utf8')).propuestas.length, 0, 'y en disco no queda ninguna propuesta');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: vaciar la papelera borra de verdad lo que había dentro', () => {
  const dir = tmpDir('sagi-memvac-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const años = new Date(Date.now() - 400 * 86400000).toISOString();
  memory.add({ text: 'Dato que se olvidará del todo' });
  const almacen = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  almacen.hechos[0].lastUsed = años;
  almacen.hechos[0].date = años;
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(almacen), 'utf8');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.prune(); // lo mueve a la papelera
  const r = memory.trashEmpty();
  ok(r.ok);
  eq(r.borradas, 1);
  eq(memory.listTrash().length, 0);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: restaurar copia recupera el almacén y conserva el fichero roto', () => {
  const dir = tmpDir('sagi-memres-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{ esto no es JSON', 'utf8'); // el almacén ilegible de partida
  fs.writeFileSync(f.replace(/\.json$/, '') + '.bak-v1', JSON.stringify([{ id: 'a', text: 'Hecho rescatado de la copia' }]), 'utf8');
  memory.__test._resetForTests(f);
  memory.list(); // carga: como no se puede leer, dispara la cuarentena
  const r = memory.restaurarCopia();
  ok(r.ok, 'se restaura');
  ok(r.restaurado >= 1, 'trae al menos un hecho');
  ok(/bak-v1|corrupt/.test(r.origen), 'dice de dónde salió: ' + r.origen);
  ok(
    memory.list().some((m) => /Hecho rescatado/.test(m.text)),
    'el hecho está en la memoria',
  );
  const rotos = fs.readdirSync(dir).filter((n) => n.startsWith('memory.json.roto-'));
  ok(rotos.length >= 1, 'el fichero ilegible se conserva como .roto-…');
  eq(memory.list().length, 1, 'una segunda lectura no explota');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: sin ninguna copia, restaurar avisa en vez de inventarse la memoria', () => {
  const dir = tmpDir('sagi-memsin-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, 'roto del todo', 'utf8');
  memory.__test._resetForTests(f);
  const r = memory.restaurarCopia();
  eq(r.ok, false);
  ok(/copia/.test(r.error), 'el error habla de la copia: ' + r.error);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: restaurar copia usa la copia fresca cuando la hay', () => {
  const dir = tmpDir('sagi-memres3-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{ roto', 'utf8');
  fs.writeFileSync(f + '.bak', JSON.stringify({ version: 2, hechos: [{ text: 'Lo último que sabía' }] }), 'utf8');
  fs.writeFileSync(f.replace(/\.json$/, '') + '.bak-v1', JSON.stringify([{ text: 'Lo antiguo' }]), 'utf8');
  memory.__test._resetForTests(f);
  const r = memory.restaurarCopia();
  ok(r.ok);
  ok(/memory\.json\.bak$/.test(r.origen), 'usa la copia fresca: ' + r.origen);
  ok(
    memory.list().some((m) => /Lo último/.test(m.text)),
    'no vuelve al estado de la migración',
  );
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: una copia ilegible no impide recuperar la siguiente', () => {
  const dir = tmpDir('sagi-memres4-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{ roto', 'utf8');
  fs.writeFileSync(f + '.bak', 'también roto', 'utf8'); // la copia más reciente está rota
  fs.writeFileSync(f.replace(/\.json$/, '') + '.bak-v1', JSON.stringify([{ text: 'Hecho del original v1' }]), 'utf8');
  memory.__test._resetForTests(f);
  const r = memory.restaurarCopia();
  ok(r.ok, 'se recupera igual: ' + r.error);
  ok(/bak-v1/.test(r.origen), 'baja a la copia v1: ' + r.origen);
  ok(memory.list().some((m) => /original v1/.test(m.text)));
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* ---------- memoria v2: identidad siempre presente ---------- */

test('relevantMemories incluye siempre los hechos de identidad', () => {
  const dir = tmpDir('sagi-memid-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  // el de Blender entra primero en la lista; la identidad tiene que adelantársele
  memory.add({ text: 'Trabajo con proyectos de Blender y renders' });
  memory.add({ text: 'El usuario se llama Darío', etiquetas: ['identidad'] });
  const rel = memory.relevantMemories('cuéntame un chiste de cocina', { minScore: 0.99, limit: 1 });
  eq(rel.length, 1, 'el tope manda');
  ok(/se llama Darío/.test(rel[0].mem.text), 'la identidad entra aunque no solape y sin hueco de sobra');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

/* ---------- memoria v2: bandeja de aprobación y extracción al cerrar turno ---------- */

test('memory: la bandeja propone, acepta y descarta', () => {
  const dir = tmpDir('sagi-memtray-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const props = memory.proponerDeTurno('recuerda que me llamo Darío', { convId: 'c1', convTitulo: 'Prueba' });
  eq(props.length, 1, 'la frase propone un hecho');
  eq(props[0].origen, 'mensaje');
  eq(props[0].convId, 'c1', 'la propuesta recuerda de qué conversación salió');
  eq(memory.trayList().length, 1);
  const r = memory.trayAceptar(props[0].id);
  ok(r.ok, 'se acepta');
  eq(memory.trayList().length, 0, 'sale de la bandeja');
  ok(
    memory.list().some((m) => m.text.includes('Darío')),
    'entra en la memoria',
  );
  ok(
    memory.list().some((m) => (m.etiquetas || []).includes('identidad')),
    'la etiqueta viaja con el hecho',
  );
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: descartar una propuesta la quita sin guardarla', () => {
  const dir = tmpDir('sagi-memdis-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const props = memory.proponerDeTurno('prefiero las respuestas cortas');
  eq(props.length, 1);
  memory.trayDescartar(props[0].id);
  eq(memory.trayList().length, 0);
  eq(memory.list().length, 0, 'no se guardó nada');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: con guardar-sin-preguntar la propuesta se guarda sola', () => {
  const dir = tmpDir('sagi-memauto-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const guardados = memory.proponerDeTurno('me llamo Darío', { autoGuardar: true });
  eq(memory.trayList().length, 0, 'no pasa por la bandeja');
  eq(guardados.length, 1);
  eq(memory.list().length, 1);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: aceptar una propuesta parecida a un hecho vivo lo consolida, no lo duplica', () => {
  const dir = tmpDir('sagi-memtrayf-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'El usuario prefiere informes en PDF', importance: 0.9 });
  const props = memory.proponerDeTurno('prefiero los informes en PDF');
  eq(props.length, 1);
  memory.trayAceptar(props[0].id);
  eq(memory.list().length, 1, 'sigue habiendo un solo hecho');
  eq(memory.list()[0].text, 'El usuario prefiere los informes en PDF', 'gana el texto recién aprobado');
  eq(memory.list()[0].importance, 0.9, 'consolidar no rebaja la importancia que ya tenía');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: proponerDeTurno no repite lo que ya sabe', () => {
  const dir = tmpDir('sagi-memdup-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  eq(memory.proponerDeTurno('me llamo Darío').length, 1);
  eq(memory.proponerDeTurno('me llamo Darío').length, 0, 'ya está en la bandeja');
  eq(memory.trayList().length, 1);
  memory.trayAceptar(memory.trayList()[0].id);
  eq(memory.proponerDeTurno('me llamo Darío').length, 0, 'y ya vive en la memoria');
  eq(memory.trayList().length, 0);
  eq(memory.list().length, 1);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: el evento propuesta avisa una vez por propuesta nueva', () => {
  const dir = tmpDir('sagi-memevento-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const vistas = [];
  const escucha = (p) => vistas.push(p);
  memory.on('propuesta', escucha);
  memory.proponerDeTurno('me llamo Darío');
  memory.proponerDeTurno('me llamo Darío'); // ya está en la bandeja: no vuelve a avisar
  memory.proponerDeTurno('prefiero el té');
  memory.off('propuesta', escucha);
  memory.proponerDeTurno('trabajo en C:\\proyectos\\web'); // nadie escucha
  eq(vistas.length, 2, 'una vez por propuesta nueva');
  eq(vistas[0].texto, 'El usuario se llama Darío');
  eq(vistas[0].etiquetas.join(','), 'identidad');
  eq(vistas[0].origen, 'mensaje');
  ok(
    memory.trayList().some((p) => p.id === vistas[0].id),
    'el aviso lleva la propuesta que está en la bandeja',
  );
  for (const id of memory.trayList().map((p) => p.id)) memory.trayDescartar(id);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('ipc-chat: el cierre de turno propone memoria con el interruptor encendido', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc-chat.js'), 'utf8');
  ok(/proponerDeTurno\(/.test(src), 'el router llama a proponerDeTurno');
  ok(/memoryLearn/.test(src), 'respeta el interruptor de aprendizaje');
  ok(/memoryAutoSave/.test(src), 'respeta el guardar-sin-preguntar');
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
  ok(
    rec.some((t) => t.runId === run.runId),
    'interrumpida es recuperable',
  );
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
  ok(!checkpoints.list('all').find((t) => t.runId === target.runId));
});

test('checkpoints: list("active") excluye las tareas archivadas', () => {
  const dir = tmpDir('sagi-active-');
  checkpoints.__test._resetForTests(dir);
  const a = checkpoints.newRun({ goal: 'activa' });
  checkpoints.save(a);
  const c = checkpoints.newRun({ goal: 'completada' });
  checkpoints.save(c);
  checkpoints.complete(c, 'hecho');
  const f = checkpoints.newRun({ goal: 'fallida' });
  checkpoints.fail(f, { step: 'EXECUTE', message: 'boom' });
  const activeIds = checkpoints.list('active').map((t) => t.runId);
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
    const t = new Date(Date.now() + i * 1000); // la 4 es la más nueva
    fs.utimesSync(f, t, t);
    ids.push(r.runId);
  }
  checkpoints.__test.pruneArchived(3);
  const left = fs.readdirSync(path.join(dir, 'completed'));
  eq(left.length, 3, 'solo quedan 3');
  ok(!left.includes(ids[0]), 'la más antigua se va');
  ok(left.includes(ids[4]), 'la más reciente se queda');
  checkpoints.__test._resetForTests(TASKS_TMP); // el resto de la sección usa su directorio
});

/* ---------- v1.2: herramienta remember (integración con executors) ----------
   `remember` respeta el ajuste «Guardar sin preguntar»: apagado (lo normal) el recuerdo
   cae en «Recién aprendido» y espera al usuario; encendido, se guarda directo. */

test('remember: con «guardar sin preguntar» apagado la propuesta espera en la bandeja', async () => {
  const dir = tmpDir('sagi-remember-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  const antes = memory.list().length;
  const out = await executeTool('remember', { text: 'Prefiero respuestas concisas', importance: 0.7 }, {});
  ok(out.startsWith('OK'), out);
  eq(memory.list().length, antes, 'sin el visto bueno del usuario no entra en la memoria');
  const bandeja = memory.trayList();
  eq(bandeja.length, 1, 'espera en «Recién aprendido»');
  eq(bandeja[0].texto, 'Prefiero respuestas concisas');
  memory.trayDescartar(bandeja[0].id);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('remember: con «guardar sin preguntar» encendido se guarda directo', async () => {
  const dir = tmpDir('sagi-rememberauto-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  const antes = memory.list().length;
  const out = await executeTool(
    'remember',
    { text: 'Prefiero respuestas concisas', importance: 0.7 },
    { settings: { settings: { memoryAutoSave: true } } },
  );
  ok(out.startsWith('OK'), out);
  eq(memory.list().length, antes + 1, 'entra directo, sin pasar por la bandeja');
  eq(memory.trayList().length, 0);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('remember: la descripción de la herramienta cuenta lo que el almacén hace de verdad', () => {
  /* La descripción prometía «el sistema los fusiona y se queda con el reciente», que no
     era cierto para un cambio de valor (quedaban dos hechos contradictorios) ni para las
     preferencias (se perdía una). Ahora el almacén sustituye el mismo dato (mandando el
     viejo a la papelera) y deja convivir los datos distintos: la descripción lo dice. */
  const def = require('../agent/tools').toolDefs.find((t) => t.function && t.function.name === 'remember');
  ok(def, 'no encontré la herramienta remember');
  const desc = def.function.description;
  ok(/papelera/.test(desc), 'dice a dónde va el dato viejo: ' + desc);
  ok(/se guardan los dos/.test(desc), 'y que un dato distinto no borra el otro: ' + desc);
  ok(!/se queda con el reciente\./.test(desc), 'ya no promete una fusión solo por parecerse: ' + desc);
});

test('remember tool rejects empty text', async () => {
  const dir = tmpDir('sagi-remembervacio-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  for (const texto of ['', '   ']) {
    const out = await executeTool('remember', { text: texto }, {});
    ok(out.startsWith('Error'), out);
  }
  eq(memory.trayList().length, 0, 'una propuesta sin texto no llega a la bandeja');
  eq(memory.list().length, 0, 'ni a la memoria');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
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
  for (let i = 0; i < 15; i++) {
    deep = path.join(deep, 'n' + i);
    fs.mkdirSync(deep, { recursive: true });
  }
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
  const pausedOnce = new Set(); // behavior 'pause': pausa solo el primer arranque de cada tarea
  return new TaskManager({
    getSettings: () => ({
      active: { model: 'fake-model', baseUrl: 'http://localhost:0/v1' },
      settings: { maxConcurrentTasks: 1, ...(overrides.settings || {}) },
    }),
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
  const t = await waitFor(() => {
    const x = checkpoints.read(r.runId);
    return x && x.status === 'completed' ? x : null;
  });
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
  tm.isRunBusy = (id) => id === r.runId; // el chat lo tiene en marcha
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
    chat: async () => {
      await wait(200);
    },
    stop: () => {},
    getMeta: () => ({ busy: true }),
    getToolsFired: () => [],
    pause: () => {},
  });
  const r = tm.enqueue({ goal: 'tarea cancelable' });
  await wait(30);
  tm.cancel(r.runId);
  await wait(300); // tiempo de sobra para que el chat abortado cierre y notifique
  eq(notes.filter((k) => k === 'cancelled').length, 1, 'una acción = un aviso: ' + JSON.stringify(notes));
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
    stop: () => {},
    getMeta: () => ({ busy: false }),
    getToolsFired: () => [],
    pause: () => {},
  });
  const dir = tmpDir('sagi-stop-');
  const prev = checkpoints._dir();
  checkpoints.__test._resetForTests(dir);
  tm.enqueue({ goal: 'primera tarea de la cola' });
  tm.enqueue({ goal: 'segunda tarea de la cola' });
  tm.enqueue({ goal: 'tercera tarea de la cola' });
  await wait(40); // la primera arranca; las otras dos esperan hueco
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
  const first = await waitFor(() => checkpoints.list('active').find((t) => t.goal === 'tarea pausable') || null);
  ok(first, 'la tarea existe');
  // la segunda arranca (el hueco queda libre cuando la primera se pausa) y el
  // agente de prueba la pausa en su primer arranque
  const r2 = tm.enqueue({ goal: 'otra más' });
  const started = await waitFor(() => {
    const x = checkpoints.read(r2.runId);
    return x && x.status === 'paused' ? x : null;
  });
  ok(started, 'la segunda arrancó y quedó pausada: ' + JSON.stringify(checkpoints.read(r2.runId)));
  const r = tm.pause(r2.runId);
  eq(r.ok, true, 'pausar una ya pausada no es un error');
  eq(checkpoints.read(r2.runId).status, 'paused');
  const rs = tm.resume(r2.runId);
  eq(rs.ok, true);
  const done = await waitFor(() => {
    const x = checkpoints.read(r2.runId);
    return x && x.status === 'completed' ? x : null;
  });
  ok(done, 'tras reanudar, la tarea se completa: ' + JSON.stringify(checkpoints.read(r2.runId)));
  tm.dispose();
});

test('TaskManager: cancel archives the task as cancelled', async () => {
  const tm = makeManager({ behavior: 'pause' });
  const r = tm.enqueue({ goal: 'tarea cancelable' });
  const c = tm.cancel(r.runId, 'ya no la quiero'); // cancelar en cualquier estado vivo
  eq(c.ok, true);
  const t = checkpoints.read(r.runId);
  eq(t.status, 'cancelled');
  ok(t.lastError.message.includes('ya no la quiero'));
  eq(tm.cancel(r.runId).ok, false, 'no se cancela dos veces');
  tm.dispose();
});

test('TaskManager: autoResume re-enqueues interrupted tasks', async () => {
  /* Una TAREA de fondo: los turnos del CHAT interrumpidos NO se reanudan solos (esperan a
     que el usuario lo pida, que es lo que le dice el aviso del guardarraíl). */
  const run = checkpoints.newRun({ goal: 'huérfana del crash', origin: 'background' });
  checkpoints.interrupt(run);
  const tm = makeManager();
  const r = tm.autoResume();
  ok(r.resumed >= 1, 're-encola al menos la huérfana');
  const done = await waitFor(() => {
    const x = checkpoints.read(run.runId);
    return x && x.status === 'completed' ? x : null;
  });
  ok(done, 'la huérfana se completa: ' + JSON.stringify(checkpoints.read(run.runId)));
  tm.dispose();
});

test('TaskManager: no model configured → task parked as paused', async () => {
  const tm = new TaskManager({
    getSettings: () => ({ active: null, settings: {} }),
    agentFactory: () => {
      throw new Error('no debería crearse');
    },
    emit: () => {},
    notify: () => {},
  });
  const r = tm.enqueue({ goal: 'sin proveedor' });
  // se aparca en cuanto el _pump la mira: sin proveedor no hay nada que esperar
  const t = await waitFor(() => {
    const x = checkpoints.read(r.runId);
    return x && x.status === 'paused' ? x : null;
  });
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
  ok(defs.every((d) => subagents.SUBAGENTS.research.allowTools.includes(d.function.name)));
  ok(!defs.some((d) => d.function.name === 'run_command'), 'research NO tiene terminal');
  ok(!subagents.toolDefsFor('vision').some((d) => d.function.name === 'write_file'));
});

test('subagents: delegate def is in toolDefs and has the right enum', () => {
  const { toolDefs } = require('../agent/tools');
  const d = toolDefs.find((t) => t.function.name === 'delegate');
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

test('fallbackChain: primario → manual → locales (el automático es opt-in)', () => {
  const cfg = {
    providers: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'k',
        models: ['gpt-5', 'claude-sonnet-4'],
        activeModel: 'gpt-5',
      },
      { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k2', models: ['llama-3-70b'] },
      { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2:8b'] },
    ],
    active: { providerId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'gpt-5' },
    fallbackChain: [],
  };
  const chain = modelsMod.fallbackChain(cfg, 'coding');
  eq(chain[0].model, 'gpt-5', 'primario primero');
  /* Un proveedor guardado que el usuario NO eligió no puede responder en su lugar:
     la petición entera (prompt, resultados, archivos) iría a un tercero que no
     escogió. El README promete que el modelo elegido manda. */
  ok(!chain.some((c) => c.providerId === 'groq'), 'un guardado que no está en el fallbackChain no entra en silencio');
  const locals = chain.filter((c) => c.role === 'local');
  eq(locals.length, 1, 'ollama como red de salvamento');
  eq(locals[0].providerId, 'ollama');
  // con el opt-in explícito, el resto de guardados vuelve a entrar
  const conAuto = modelsMod.fallbackChain({ ...cfg, settings: { fallbackAutomatico: true } }, 'coding');
  ok(
    conAuto.some((c) => c.providerId === 'groq'),
    'con fallbackAutomatico los demás guardados entran como secundarios',
  );
  // sin duplicados y con modelo siempre definido
  const ids = conAuto.map((c) => c.providerId);
  eq(new Set(ids).size, ids.length);
  ok(conAuto.every((c) => c.model));
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
      {
        id: 'go',
        name: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'k',
        models: ['deepseek-flash', 'deepseek-v4.1-flash', 'mimo-v2.5'],
        activeModel: 'mimo-v2.5',
      },
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
  const s = modelsMod.summary().find((x) => x.model === 'gpt-5');
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
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: blender-pro\ndescription: Automatiza escenas de Blender y renders 3D\ntriggers:\n  - blender\ndependencies:\n  - blender >= 4.0\ncategory: 3D\nversion: 1.1.0\n---\nInstrucciones de blender.',
);

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
  const s = (await skills.listSkills()).find((x) => x.name === 'blender-pro');
  ok(s, 'skill presente');
  eq(s.category, '3D');
  eq(s.dependencies.length, 1);
  eq(s.triggers[0], 'blender');
  eq(s.dir, path.join(SKILLS_TMP, 'test-skill'), 'cada skill sabe en qué carpeta vive (references/, scripts/)');
});

test('marketplace catalog marks installed repos', async () => {
  const marketplace = require('../agent/marketplace');
  const cat = await marketplace.catalog(['anthropics/skills']);
  ok(cat.length >= 3);
  eq(cat.find((x) => x.repo === 'anthropics/skills').installed, true);
  eq(cat.find((x) => x.repo === 'anthropics/skills/webapp-testing').installed, false);
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
  habits.observe('tool', { name: 'open_app', args: { name: 'regedit.exe' } }); // 1 sola vez
  ok(!habits.profile().toLowerCase().includes('regedit'), 'no es hábito todavía');
  habits.reset();
  eq(habits.profile(), '');
});

test('habits: cada categoría real del perfil la cubre exactamente una etiqueta de olvido', () => {
  const areas = Object.values(habits.__test.OLVIDO_AREAS);
  const cubiertas = areas.reduce((todas, claves) => todas.concat(claves), []);
  eq(new Set(cubiertas).size, cubiertas.length, 'ninguna clave real puede estar en dos etiquetas');
  const reales = habits.__test.CATEGORIAS_REALES;
  ok(reales.length > 0, 'el perfil observa algo');
  for (const k of reales) ok(cubiertas.includes(k), 'sin etiqueta de olvido para «' + k + '» (el usuario no podría olvidarla)');
  eq(cubiertas.length, reales.length, 'ni etiquetas de más ni de menos');
  eq(Object.keys(habits.__test.OLVIDO_AREAS).length, 7, 'siete categorías y «todo»');
});

test('habits: olvidar una categoría borra solo esa categoría', () => {
  habits.reset();
  habits.observe('tool', { name: 'open_app', args: { name: 'spotify.exe' } });
  habits.observe('tool', { name: 'run_command', args: { command: 'git status' } });
  const r = habits.olvidar('aplicaciones');
  ok(r.ok, 'devuelve ok');
  eq(r.borradas, 1, 'dice cuántos usos olvidó');
  const s = habits.stats();
  eq(s.apps.length, 0, 'se olvidaron las apps');
  ok(
    s.commands.some((c) => c.name === 'git'),
    'los comandos siguen ahí',
  );
  habits.reset();
});

test('habits: olvidar una categoría desconocida no rompe', () => {
  const r = habits.olvidar('inventada');
  eq(r.ok, false);
  eq(r.error, 'categoria desconocida');
  eq(habits.olvidar('apps').ok, false, 'la clave interna en inglés tampoco vale');
  habits.reset();
});

test('habits: olvidar las webs no toca los modos ni los permisos', () => {
  habits.reset();
  habits.observe('tool', { name: 'browser_control', args: { url: 'https://github.com/x/y' } });
  habits.observe('tool', { name: 'browser_control', args: { url: 'https://github.com/a/b' } });
  habits.observe('mode', { mode: 'plan' });
  habits.observe('mode', { mode: 'plan' });
  habits.observe('confirm', { approved: true });
  ok(habits.olvidar('webs').ok);
  const s = habits.stats();
  eq(s.sites.length, 0, 'las webs se olvidan');
  eq(s.modes.plan, 2, 'los modos siguen');
  eq(s.confirms.approved, 1, 'los permisos siguen');
  ok(habits.olvidar('todo').ok, 'olvidarlo todo vale');
  eq(habits.stats().modes.plan, undefined, 'y deja el perfil vacío');
  habits.reset();
});

test('habits: olvidar herramientas, comandos y carpetas va por separado', () => {
  habits.reset();
  habits.observe('tool', { name: 'write_file', args: { path: 'C:/proyectos/web/index.html' } });
  habits.observe('tool', { name: 'run_command', args: { command: 'git status', cwd: 'C:/proyectos/web' } });
  ok(habits.olvidar('carpetas').ok);
  const sinCarpetas = habits.stats();
  eq(sinCarpetas.folders.length, 0, 'las carpetas se olvidan');
  ok(
    sinCarpetas.commands.some((c) => c.name === 'git'),
    'los comandos siguen',
  );
  ok(
    sinCarpetas.tools.some((t) => t.name === 'run_command'),
    'las herramientas siguen',
  );
  ok(habits.olvidar('comandos').ok);
  eq(habits.stats().commands.length, 0, 'los comandos se olvidan');
  ok(habits.olvidar('herramientas').ok);
  eq(habits.stats().tools.length, 0, 'las herramientas se olvidan');
  habits.reset();
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
  eq(
    protocols.detectFormat({ baseUrl: 'https://opencode.ai/zen/go/v1', model: 'opencode-go/qwen3.8-max' }),
    'anthropic',
    'admite id con prefijo',
  );
});

test('contexto: mide lo que se manda y suelta lo viejo cuando ya no cabe', () => {
  const contexto = require('../agent/contexto');

  // La medida: los mensajes Y las herramientas. Las definiciones de herramientas son
  // miles de tokens que nadie cuenta y que se pagan en cada paso.
  const herramientas = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'lee un archivo del proyecto',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
  ];
  const m = contexto.medir([{ role: 'user', content: 'hola' }], herramientas);
  ok(m.herramientas > 0, 'las herramientas cuentan: ' + m.herramientas + ' tokens');
  eq(m.total, m.mensajes + m.herramientas, 'y el total es mensajes + herramientas');
  ok(
    contexto.estimarTokens('x'.repeat(360)) === 100,
    'la estimación es por caracteres (≈3,6 por token): ' + contexto.estimarTokens('x'.repeat(360)),
  );
  eq(contexto.medir([], []).total, 0, 'sin nada, cero');

  // La ventana: por familia de modelo, y se puede forzar
  eq(contexto.ventanaDe({ model: 'claude-sonnet-4' }), 200000, 'un Claude tiene 200k');
  eq(contexto.ventanaDe({ model: 'gpt-4o' }), 128000);
  eq(contexto.ventanaDe({ model: 'lo-que-sea' }), 128000, 'sin dato se asume 128k (avisar antes es mejor que quedarse corto)');
  eq(contexto.ventanaDe({ model: 'lo-que-sea', contextWindow: 32000 }), 32000, 'y el usuario puede fijarla');

  // Los tres tramos
  const grande = [
    { role: 'system', content: 'x'.repeat(1000) },
    { role: 'user', content: 'y'.repeat(1000) },
  ];
  eq(contexto.presupuesto({ messages: grande, tools: [], cfg: { model: 'gpt-4o' } }).estado, 'hola', 'un prompt pequeño va holgado');
  const medio = [{ role: 'user', content: 'y'.repeat(128000 * 0.65 * 3.6) }];
  eq(contexto.presupuesto({ messages: medio, tools: [], cfg: { model: 'gpt-4o' } }).estado, 'ajustado', 'al 65% ya va ajustado');
  const lleno = [{ role: 'user', content: 'y'.repeat(128000 * 0.9 * 3.6) }];
  const pl = contexto.presupuesto({ messages: lleno, tools: [], cfg: { model: 'gpt-4o' } });
  eq(pl.estado, 'apretado', 'al 90% está apretado');
  ok(pl.libre >= 0, 'y el sitio libre no se va a negativo');
  eq(
    contexto.notaPresupuesto({ estado: 'hola', uso: 0.1 }),
    '',
    'con sitio de sobra no se le dice nada al modelo: no hay nada que hacer con ese dato',
  );
  ok(
    /PRESUPUESTO DE CONTEXTO/.test(contexto.notaPresupuesto(pl)),
    'y apretado se le dice qué hacer (leer por tramos, no repetir), no solo cuánto queda',
  );

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
  const sueltos = rec.messages.filter(
    (x) =>
      x.role === 'tool' && !rec.messages.some((y) => y.role === 'assistant' && (y.tool_calls || []).some((c) => c.id === x.tool_call_id)),
  );
  eq(sueltos.length, 0, 'y no queda ningún resultado de herramienta huérfano (el proveedor rechazaría la petición)');
  eq(rec.messages[1].role, 'user', 'la conversación recortada empieza por el usuario');
  ok(rec.messages.length >= 7, 'se conserva una cola suficiente para seguir trabajando: ' + rec.messages.length + ' mensajes');
  const corta = [
    { role: 'system', content: 'reglas' },
    { role: 'user', content: 'hola' },
  ];
  eq(contexto.recortarMensajes(corta, [], { model: 'claude-sonnet-4' }).quitados, 0, 'si cabe, no se suelta nada');
  const sinSistema = contexto.recortarMensajes([{ role: 'user', content: 'y'.repeat(500000) }], [], { model: 'gpt-4o' });
  ok(sinSistema.quitados >= 0, 'sin nada que soltar tampoco se rompe');
});

test('protocolos: la caché de prompt se marca donde toca y se puede apagar', () => {
  const protocolos = require('../agent/protocols');
  const messages = [
    { role: 'system', content: 'eres sagitari' },
    { role: 'user', content: 'hola' },
  ];
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
  ok(
    !sin.system[0] || !sin.system[0].cache_control,
    'con el ajuste apagado no se marca nada (hay proveedores compatibles que rechazan el campo)',
  );
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
  const base = {
    active: { name: 'x', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-sonnet-4' },
    settings: { mode: 'act', modelRouting: false },
  };
  const { chain } = agent._chainFor(base, 'hola');
  eq(chain[0].cachePrompt, true, 'la cadena lleva el ajuste (activo por defecto)');
  const sinCache = agent._chainFor({ ...base, settings: { ...base.settings, promptCache: false } }, 'hola');
  eq(sinCache.chain[0].cachePrompt, false, 'y se puede apagar desde Ajustes');

  // …y se ve en el cuerpo real que se manda al proveedor
  await agent._streamOnce(
    { ...base.active, format: 'anthropic', cachePrompt: true },
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hola' },
    ],
    new AbortController().signal,
  );
  ok(
    Array.isArray(sink.body.system) && sink.body.system[0].cache_control,
    'el cuerpo enviado lleva el punto de caché: ' + JSON.stringify(sink.body.system).slice(0, 80),
  );
  await agent._streamOnce(
    { ...base.active, format: 'anthropic', cachePrompt: false },
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hola' },
    ],
    new AbortController().signal,
  );
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
    { fetchFn: fakeFetch(chunks, sink), messages: [{ role: 'user', content: 'hola' }], tools: [], signal: noSignal(), onText: () => {} },
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
    evNamed('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command' },
    }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }),
    evNamed('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"dir"}' } }),
    evNamed('message_delta', { type: 'message_delta', usage: { output_tokens: 7 } }),
    evNamed('message_stop', { type: 'message_stop' }),
  ];
  const res = await protocols.stream(
    { baseUrl: 'https://opencode.ai/zen/go/v1', providerId: 'opencode-go', model: 'qwen3.8-max', apiKey: 'k', format: 'anthropic' },
    {
      fetchFn: fakeFetch(chunks, sink),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hola' },
      ],
      tools: [],
      signal: noSignal(),
      onText: () => {},
    },
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
    { fetchFn: fakeFetch(chunks, sink), messages: [{ role: 'user', content: 'hola' }], tools: [], signal: noSignal(), onText: () => {} },
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
  const assistant = out.messages.find((m) => m.role === 'assistant');
  eq(assistant.content[0].type, 'tool_use');
  eq(assistant.content[0].input.path, '.');
  const last = out.messages[out.messages.length - 1];
  eq(last.role, 'user');
  eq(last.content.filter((b) => b.type === 'tool_result').length, 2, 'agrupa tool_result consecutivos');
});

test('protocols: la conversión a Responses usa function_call / function_call_output', () => {
  const out = protocols.toResponsesInput([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hola' },
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'salida' },
  ]);
  eq(out.instructions, 'sys');
  ok(
    out.input.some((i) => i.type === 'function_call' && i.call_id === 't1'),
    'function_call',
  );
  ok(
    out.input.some((i) => i.type === 'function_call_output' && i.output === 'salida'),
    'function_call_output',
  );
});

test('protocols: los screenshots de una herramienta no se pierden en Anthropic/Responses', () => {
  const dataUrl = 'data:image/png;base64,AAAA';
  const msgs = [
    { role: 'user', content: 'captura la pantalla' },
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'screenshot', arguments: '{}' } }] },
    {
      role: 'tool',
      tool_call_id: 't1',
      content: [
        { type: 'text', text: 'Captura tomada' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
  const a = protocols.toAnthropicMessages(msgs);
  const lastA = a.messages[a.messages.length - 1];
  ok(
    lastA.content[0].content.some((b) => b.type === 'image'),
    'imagen dentro del tool_result',
  );
  const r = protocols.toResponsesInput(msgs);
  ok(
    r.input.some((i) => Array.isArray(i.content) && i.content.some((c) => c.type === 'input_image')),
    'imagen como entrada de usuario',
  );
});

/* ---------- MCP: framing y JSON-RPC ---------- */
const mcpTransport = require('../agent/mcp-transport');

test('mcp: el lector entrega mensajes completos y descarta los banners', () => {
  const vistos = [];
  const feed = mcpTransport.createLineReader((m, noise) => vistos.push({ m, noise }));
  // dos mensajes en un chunk, uno partido en dos y una línea de banner al principio
  feed('Servidor MCP 1.0 listo\n{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,');
  feed('"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}\n');
  eq(vistos.map((v) => v.m.id).join(','), '1,2,3', 'los tres mensajes llegan, en orden');
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
  const [, err] = await p.then(
    () => [null, null],
    (e) => [null, e],
  );
  ok(/no respondió|timeout/i.test(err.message), err.message);

  const rpc2 = new mcpTransport.Rpc({ send: () => {} });
  const p2 = rpc2.request('x', {}, { timeoutMs: 1000 });
  rpc2.handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'método no soportado' } });
  const [, err2] = await p2.then(
    () => [null, null],
    (e) => [null, e],
  );
  ok(err2 && /método no soportado/.test(err2.message), 'el mensaje del servidor se propaga: ' + (err2 && err2.message));
});

test('mcp: si el transporte muere, las peticiones en vuelo se rechazan', async () => {
  const rpc = new mcpTransport.Rpc({ send: () => {} });
  const p = rpc.request('tools/list', {}, { timeoutMs: 5000 });
  rpc.fail('el servidor se cayó');
  const [, err] = await p.then(
    () => [null, null],
    (e) => [null, e],
  );
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
    try {
      mcpTransport.buildCmdLine('npx', [malo]);
    } catch (e) {
      err = e;
    }
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
  eq(
    mcpTransport.buscarEnPath(process.platform === 'win32' ? 'node.exe' : 'node', { env }),
    exeFalso,
    'la búsqueda en el PATH encuentra el ejecutable',
  );
  eq(
    mcpTransport.buscarEnPath(process.platform === 'win32' ? 'node.exe' : 'node', { env: { PATH: '' } }),
    null,
    'y con el PATH vacío no inventa nada',
  );
});

test('mcp: sin Node en el equipo se levanta con el Node que la app trae dentro', () => {
  const r = mcpTransport.resolveCommand('node', ['servidor.js'], {
    env: { PATH: '' },
    esElectron: true,
    execPath: 'C:\\Apps\\SAGITARI.exe',
  });
  eq(r.file, 'C:\\Apps\\SAGITARI.exe', 'el propio ejecutable de la app hace de Node');
  eq(r.env.ELECTRON_RUN_AS_NODE, '1', 'con la marca que lo arranca como Node en vez de como app');
  eq(r.argv.length, 1, 'y los argumentos del servidor llegan tal cual');
});

test('mcp: sin Node ni app Electron el error dice qué hacer', () => {
  let err = null;
  try {
    mcpTransport.resolveCommand('node', ['x.js'], { env: { PATH: '' }, esElectron: false });
  } catch (e) {
    err = e;
  }
  ok(err && /Node\.js/.test(err.message), 'se explica que falta Node.js: ' + (err && err.message));
});

test('mcp: «npx» sin Node.js avisa en claro en vez de morir dentro de cmd.exe', () => {
  let err = null;
  try {
    mcpTransport.resolveCommand('npx', ['-y', 'paquete'], { env: { PATH: '' } });
  } catch (e) {
    err = e;
  }
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
    command: process.execPath,
    args: [rutaEco],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    cwd: tmpDir('sagi-mcp-env-'),
  });
  const init = await tr.rpc.request(
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SAGITARI', version: 'test' } },
    { timeoutMs: 5000 },
  );
  ok(init && init.serverInfo, 'el servidor arranca igual con ese entorno: ' + JSON.stringify(init && init.serverInfo));
  tr.kill();
});

test('mcp: transporte stdio completo contra un servidor real', async () => {
  const path2 = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
  const tr = mcpTransport.createStdioTransport({
    command: process.execPath,
    args: [path2],
    env: { MCP_ECHO_BANNER: '1' },
    cwd: tmpDir('sagi-mcp-'),
  });
  const init = await tr.rpc.request(
    'initialize',
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SAGITARI', version: 'test' } },
    { timeoutMs: 5000 },
  );
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
  if (process.platform !== 'win32') return; // el producto es Windows-only
  const dir = tmpDir('sagi-cmd-');
  const bat = path.join(dir, 'probe.cmd');
  fs.writeFileSync(bat, '@echo off\r\necho %~1> "%~dp0salida.txt"\r\n', 'utf8');
  const tr = mcpTransport.createStdioTransport({ command: bat, args: ['con espacios'], cwd: dir });
  const salida = path.join(dir, 'salida.txt');
  let txt = '';
  // sondeo con deadline: el .cmd tarda lo suyo en arrancar
  for (let i = 0; i < 40 && !txt; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      txt = fs.readFileSync(salida, 'utf8');
    } catch {}
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
  await new Promise((r) => setTimeout(r, 300));
  tr.kill();
  tr.rpc.notify('notifications/initialized', {}); // escritura sobre stdin ya cerrado
  await new Promise((r) => setTimeout(r, 200));
  // Sin `child.stdin.on('error', …)` ese EPIPE es un error no capturado y el runner
  // muere aquí (Unhandled 'error' event). Que la suite llegue al final es la prueba.
  ok(tr.pid > 0, 'el transporte sigue en pie tras escribir a un servidor muerto');
});

test('mcp: una petición del servidor con un id que choca no se confunde con una respuesta', async () => {
  const avisos = [];
  const rpc = new mcpTransport.Rpc({ send: () => {}, onNotice: (m, p, id) => avisos.push({ m, id }) });
  const p = rpc.request('tools/list', {}, { timeoutMs: 1000 }); // id 1 en vuelo
  rpc.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }); // el servidor usa el mismo id
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
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      vistos.push({ msg, auth: req.headers.authorization, accept: req.headers.accept, session: req.headers['mcp-session-id'] });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remoto', version: '1' } },
          }),
        );
      }
      // el resto responde por SSE: el JSON se parte en dos líneas `data:` del
      // MISMO evento (que es lo que la spec SSE obliga a concatenar)
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: 'uno', description: 'x', inputSchema: { type: 'object' } }] },
      });
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
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('mcp: un servidor http que no responde corta por timeout', async () => {
  const http = require('http');
  const srv = http.createServer(() => {
    /* nunca responde */
  });
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
    try {
      await tr.rpc.request('initialize', {}, { timeoutMs: 300 });
    } catch (e) {
      err = e;
    }
    ok(err && /timeout/i.test(err.message), 'corta con timeout: ' + (err && err.message));
    ok(Date.now() - t0 < 3000, 'no espera más de la cuenta');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('mcp: una notificacion contestada con 202 sin cuerpo no mata el transporte', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id == null) {
        res.writeHead(202);
        return res.end();
      } // notificación: 202 sin cuerpo
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
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('mcp: un timeout del tope HTTP no marca el servidor como caido', async () => {
  const http = require('http');
  const srv = http.createServer(() => {
    /* nunca responde */
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  const muertes = [];
  try {
    // el tope HTTP vence a los 2,5 s y el Rpc espera 3 s: gana el abort del transporte
    const tr = mcpTransport.createHttpTransport({ url, defaultTimeoutMs: 500 });
    tr.onExit((m) => muertes.push(m));
    let err = null;
    try {
      await tr.rpc.request('tools/list', {}, { timeoutMs: 3000 });
    } catch (e) {
      err = e;
    }
    ok(err && /timeout/i.test(err.message), 'la petición falla por timeout: ' + (err && err.message));
    eq(muertes.length, 0, 'un timeout puntual no puede dejar el servidor caído para siempre');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

/* ---------- MCP: credenciales de la URL y topes de tamaño ---------- */
test('mcp: el userinfo se traduce a cabecera Basic y no viaja en la URL a fetch', async () => {
  let capt = null;
  const fetchFn = async (u, opts) => {
    capt = { u, headers: opts.headers, redirect: opts.redirect };
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  // `https` con userinfo: antes, `fetch` lo rechazaba («Request cannot be constructed
  // from a URL that includes credentials») y el token acababa en el mensaje de error.
  const tr = mcpTransport.createHttpTransport({ url: 'https://usuario:token-secreto@ejemplo.com/mcp', fetchFn });
  const r = await tr.rpc.request('initialize', {}, { timeoutMs: 2000 });
  eq(r.ok, true, 'la URL con userinfo por fin conecta');
  eq(capt.u, 'https://ejemplo.com/mcp', 'la URL que ve fetch no lleva credenciales');
  eq(capt.headers.Authorization, 'Basic ' + Buffer.from('usuario:token-secreto').toString('base64'), 'el userinfo viaja como Basic');
  eq(capt.redirect, 'error', 'no se siguen redirecciones: las cabeceras secretas no pueden saltar de origen');
});

test('mcp: una cabecera Authorization manual manda sobre el userinfo', async () => {
  let capt = null;
  const fetchFn = async (u, opts) => {
    capt = opts.headers;
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const tr = mcpTransport.createHttpTransport({
    url: 'https://usuario:otro@ejemplo.com/mcp',
    headers: { Authorization: 'Bearer manual' },
    fetchFn,
  });
  await tr.rpc.request('initialize', {}, { timeoutMs: 2000 });
  eq(capt.Authorization, 'Bearer manual', 'lo que puso el usuario no se pisa con el userinfo');
});

test('mcp: un 302 no arrastra las cabeceras secretas a otro origen', async () => {
  const http = require('http');
  const destino = [];
  const atacante = http.createServer((req, res) => {
    destino.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => atacante.listen(0, '127.0.0.1', r));
  const malo = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:' + atacante.address().port + '/mcp' });
    res.end();
  });
  await new Promise((r) => malo.listen(0, '127.0.0.1', r));
  try {
    const tr = mcpTransport.createHttpTransport({
      url: 'http://127.0.0.1:' + malo.address().port + '/mcp',
      headers: { Authorization: 'Bearer secreto' },
      defaultTimeoutMs: 2000,
    });
    let err = null;
    try {
      await tr.rpc.request('initialize', {}, { timeoutMs: 2000 });
    } catch (e) {
      err = e;
    }
    eq(destino.length, 0, 'el otro origen no recibe nada (ni la cabecera con el token)');
    ok(err, 'la petición falla en vez de seguir la redirección');
  } finally {
    malo.closeAllConnections?.();
    malo.close();
    atacante.closeAllConnections?.();
    atacante.close();
  }
});

test('mcp: un cuerpo http desmedido corta la conexión en vez de comerse la memoria', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('A'.repeat(mcpTransport.MAX_MESSAGE_BYTES + 1024));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const muertes = [];
  try {
    const tr = mcpTransport.createHttpTransport({ url: 'http://127.0.0.1:' + srv.address().port + '/mcp', defaultTimeoutMs: 4000 });
    tr.onExit((m) => muertes.push(m));
    let err = null;
    try {
      await tr.rpc.request('initialize', {}, { timeoutMs: 4000 });
    } catch (e) {
      err = e;
    }
    ok(err, 'la petición falla');
    ok(muertes.length === 1 && /pasó de/.test(muertes[0]), 'el motivo explica el tope: ' + muertes.join(' | '));
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('mcp: un mensaje stdio desmedido mata el transporte con un error claro', async () => {
  const dir = tmpDir('sagi-mcp-big-');
  const script = path.join(dir, 'grande.js');
  fs.writeFileSync(
    script,
    "process.stdout.write('x'.repeat(" + (mcpTransport.MAX_MESSAGE_BYTES + 4096) + '));\nsetInterval(() => {}, 1000);\n',
    'utf8',
  );
  const tr = mcpTransport.createStdioTransport({ command: process.execPath, args: [script], cwd: dir });
  const muertes = [];
  tr.onExit((m) => muertes.push(m));
  // sondeo con deadline: el hijo tiene que escribir y el lector, cortar
  for (let i = 0; i < 200 && !muertes.length; i++) await new Promise((r) => setTimeout(r, 25));
  tr.kill();
  ok(muertes.length === 1, 'el desborde mata el transporte una sola vez');
  ok(/pasó de/.test(muertes[0]), 'el motivo explica el tope: ' + muertes[0]);
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
      notify() {},
      fail() {},
    },
    stderrTail: () => '',
    onExit(cb) {
      this.esperandoSalida.push(cb);
    },
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
    servers: MCP_SERVERS,
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 'test',
    log: () => {},
    makeTransport: (s) =>
      (transports[s.id] = fakeTransport([
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
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
  });
  await mcp.ensure('pag');
  eq(
    mcp
      .toolDefs()
      .map((d) => d.function.name)
      .join(','),
    'mcp__pag__uno,mcp__pag__dos,mcp__pag__tres',
  );
  await mcp.shutdown();
});

test('mcp: allow/deny y colisiones de nombre', async () => {
  const tr = fakeTransport([
    { name: 'ok', description: 'permitida', inputSchema: { type: 'object' } },
    { name: 'secreta', description: 'prohibida', inputSchema: { type: 'object' } },
  ]);
  const mcp = new McpManager({
    servers: [{ id: 'f', name: 'F', enabled: true, transport: 'stdio', command: 'node', args: [], tools: { deny: ['secreta'] } }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
  });
  await mcp.ensure('f');
  eq(
    mcp
      .toolDefs()
      .map((d) => d.function.name)
      .join(','),
    'mcp__f__ok',
    'deny quita la herramienta del catálogo',
  );
  await mcp.shutdown();
});

test('mcp: un servidor que no arranca queda en error legible y no aporta herramientas', async () => {
  const tr = fakeTransport([], { failInit: true });
  const mcp = new McpManager({
    servers: [{ id: 'malo', name: 'Malo', enabled: true, transport: 'stdio', command: 'no-existe-xyz', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => {
      tr.stderrTail = () => 'ENOENT: no such file';
      return tr;
    },
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
  const killReal = tr.kill;
  tr.kill = () => {
    muertes++;
    killReal();
  };
  const srv = { id: 'f', name: 'F', enabled: true, transport: 'stdio', command: 'node', args: [] };
  const mcp = new McpManager({ servers: [srv], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr });
  await mcp.ensure('f');
  eq(mcp.toolDefs().length, 2, 'las dos herramientas entran');
  mcp.configure([{ ...srv, tools: { deny: ['secreta'] } }]);
  eq(
    mcp
      .toolDefs()
      .map((d) => d.function.name)
      .join(','),
    'mcp__f__ok',
    'el deny se aplica al guardar la configuración',
  );
  eq(muertes, 0, 'aplicar un filtro no tiene por qué matar el proceso del servidor');
  await mcp.shutdown();
});

test('mcp: un servidor que muere deja de describir y de listar herramientas', async () => {
  const tr = fakeTransport([{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }]);
  const mcp = new McpManager({
    servers: [{ id: 'm', name: 'M', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
  });
  await mcp.ensure('m');
  ok(mcp.describe('mcp__m__tool'), 'conectado, se describe');
  for (const cb of tr.esperandoSalida) cb(1); // el servidor se cae
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
      return {
        content: [
          { type: 'text', text: 'primera parte' },
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(40000) },
          { type: 'text', text: 'segunda parte' },
          { type: 'text', text: 'X'.repeat(70000) }, // fuerza el recorte
        ],
      };
    }
    return {};
  };
  const calls = [];
  const mcp = new McpManager({
    servers: [{ id: 'c', name: 'C', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
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
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
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
    if (method === 'tools/list')
      return {
        tools: [
          { name: 'fallo', description: 'd', inputSchema: { type: 'object' } },
          { name: 'roto', description: 'd', inputSchema: { type: 'object' } },
        ],
      };
    if (params.name === 'roto') throw new Error('servidor MCP: se rompió por dentro');
    return respuestas[params.name];
  };
  const mcp = new McpManager({
    servers: [{ id: 'e', name: 'E', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
  });
  await mcp.ensure('e');
  const ok1 = await mcp.callTool('mcp__e__fallo', {});
  ok(/^Error: el servidor MCP/.test(ok1), ok1);
  const ok2 = await mcp.callTool('mcp__e__roto', {});
  ok(/se rompió por dentro/.test(ok2), 'el error del servidor llega tal cual: ' + ok2);
  await mcp.shutdown();
});

test('mcp: una herramienta desconocida no llama a nadie y se explica', async () => {
  const mcp = new McpManager({
    servers: [],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => fakeTransport([]),
  });
  const out = await mcp.callTool('mcp__nadie__nada', {});
  ok(out.startsWith('Error:'), out);
  await mcp.shutdown();
});

test('mcp: si el servidor está caído, la siguiente llamada reintenta con backoff', async () => {
  let intentos = 0;
  const mcp = new McpManager({
    servers: [{ id: 'r', name: 'R', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
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
  tr.rpc.cancel = (id, reason) => {
    if (!pendiente) return false;
    const p = pendiente;
    pendiente = null;
    p.rej(new Error(reason || 'cancelada'));
    return true;
  };
  tr.rpc.request = async (method, params, opts) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'l', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'lenta', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') {
      if (opts && opts.onStart) opts.onStart(7); // el id que usará cancel()
      return new Promise((res, rej) => {
        pendiente = { res, rej };
      });
    }
    return {};
  };
  const mcp = new McpManager({
    servers: [{ id: 'l', name: 'L', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'),
    clientVersion: 't',
    log: () => {},
    makeTransport: () => tr,
  });
  let killable = null;
  const p = mcp.callTool(
    'mcp__l__lenta',
    {},
    {
      onExit: (k) => {
        killable = k;
      },
    },
  );
  await new Promise((r) => setTimeout(r, 50));
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
  ])
    ok(validateServer(malo).ok === false, 'debe rechazar ' + JSON.stringify(malo).slice(0, 90));
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
  const r = parseMcpImport(
    JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } },
        remoto: { url: 'https://mcp.ejemplo.com/mcp', headers: { Authorization: 'Bearer t' } },
        roto: { command: '' },
      },
    }),
  );
  ok(r.ok, JSON.stringify(r));
  eq(
    r.servers
      .map((s) => s.id)
      .sort()
      .join(','),
    'github,remoto',
    'la entrada inválida se descarta',
  );
  eq(r.servers.find((s) => s.id === 'github').transport, 'stdio');
  eq(r.servers.find((s) => s.id === 'remoto').transport, 'http');
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
    fetchFn: async (url) => {
      seen.push(url);
      return sseResponse(chunks);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'qwen3.8-max' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('hola', settings);
  ok(seen.length === 1 && seen[0].endsWith('/messages'), 'llamó a /messages: ' + seen[0]);
  const last = agent.history.filter((h) => h.role === 'assistant').pop();
  eq(last.content, 'hola', 'la respuesta llega al historial');
});

test('agent: stop() corta la ejecución aunque el stream se quede mudo', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const enc = new TextEncoder();
  // envía un evento y deja el stream ABIERTO (nunca cierra): sin abort, colgaría
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] })));
    },
  });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  const run = agent.chat('hola', settings);
  await new Promise((r) => setTimeout(r, 80));
  ok(agent.isBusy(), 'seguía trabajando');
  agent.stop();
  await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('stop() no interrumpió la ejecución')), 3000))]);
  ok(
    events.some((e) => e.type === 'stopped'),
    'emitió stopped',
  );
  ok(!agent.isBusy(), 'el agente quedó libre');
});

test('agent: un stream mudo muere solo con llmTimeoutMs y el turno queda libre', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const enc = new TextEncoder();
  // envía UN evento y deja el stream abierto para siempre: es el fallo real del
  // proveedor que dejaba el chat «ocupado» eternamente sin decir nada
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] })));
    },
  });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false, llmTimeoutMs: 120 },
  };
  const run = agent.chat('hola', settings);
  await Promise.race([
    run,
    new Promise((_, rej) => setTimeout(() => rej(new Error('el turno sigue colgado: el timeout de silencio no disparó')), 5000)),
  ]);
  ok(!agent.isBusy(), 'el agente quedó libre');
  ok(
    events.some((e) => e.type === 'error'),
    'el usuario ve un error explicado, no un turno eterno',
  );
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
    fetchFn: async () => {
      calls++;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false, llmTimeoutMs: 3000 },
  };
  await Promise.race([
    agent.chat('hola', settings),
    new Promise((_, rej) => setTimeout(() => rej(new Error('el terminador [DONE] no cerró la lectura')), 2500)),
  ]);
  eq(calls, 1, 'no se reintenta en otro modelo una respuesta ya recibida');
  ok(!events.some((e) => e.type === 'error'), 'no se reporta como fallo del proveedor');
  const last = agent.history.filter((h) => h.role === 'assistant').pop();
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
        start(c) {
          c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'respuesta ' + calls } }] })));
          c.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('uno', settings);
  // el chat de la app reutiliza el MISMO agente toda la sesión: entre mensajes
  // puede pasar cualquier cosa (minutos, horas) y aun así cada uno llega al modelo
  await new Promise((r) => setTimeout(r, 60));
  await agent.chat('dos', settings);
  eq(calls, 2, 'el segundo mensaje de la sesión también llega al proveedor');
  const assistant = agent.history.filter((h) => h.role === 'assistant').map((h) => h.content);
  ok(assistant.some((t) => t === 'respuesta 1') && assistant.some((t) => t === 'respuesta 2'), 'las dos respuestas están en el hilo');
  ok(!agent.isBusy(), 'el agente queda libre para el siguiente mensaje');
});

test('agent: el subagente respeta el límite de silencio del usuario', async () => {
  const { Agent } = require('../agent/agent');
  const enc = new TextEncoder();
  // el proveedor manda un delta y se queda mudo (socket abierto): delegar no
  // puede cortar a los 120 s por defecto cuando Ajustes dice otra cosa
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'x' } }] })));
    },
  });
  const agent = new Agent({
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', llmTimeoutMs: 100 },
  };
  const t0 = Date.now();
  let err = null;
  try {
    await agent._runWithSystem('sistema', settings, 'subtarea', [], new AbortController().signal, () => {});
  } catch (e) {
    err = e;
  }
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
  checkpoints.complete = (r) => {
    r.status = 'completed';
    return r;
  };
  checkpoints.fail = (r, info) => {
    fails.push(info);
    return r;
  };
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
              c.enqueue(
                enc.encode(
                  evData({
                    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + i, function: { name: 'read_file', arguments: calls[i] } }] } }],
                  }),
                ),
              );
            } else {
              c.enqueue(enc.encode(evData({ choices: [{ delta: { content: 'No pude leerlos.' } }] })));
            }
            c.enqueue(enc.encode('data: [DONE]\n\n'));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
      emit: (e) => {
        if (e.type === 'tool_result' && run) checks.push(run.status);
      },
      screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA', w: 1, h: 1 }),
    });
    run = checkpoints.newRun({ goal: 'tarea de prueba', mode: 'act', status: 'running' });
    const settings = {
      active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
      settings: { mode: 'act', modelRouting: false },
    };
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
  // los killables viven en runningTools (el campo suelto runningTool se eliminó
  // por muerto): el contrato es el registro, no la ranura antigua
  parent.runningTools.set('cmd', { stop: () => killed.push('herramienta') });
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
  const tabs = [...html.matchAll(/class="settab[^"]*"\s+data-set="([^"]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/class="setpanel[^"]*"\s+data-panel="([^"]+)"/g)].map((m) => m[1]);
  ok(tabs.length >= 5, 'pestañas de Ajustes: ' + tabs.length);
  eq(tabs.slice().sort().join(','), panels.slice().sort().join(','), 'pestañas y paneles deben coincidir');
  for (const id of ['setWrap', 'setTabs', 'setSearch', 'setNoResults', 'activeModelName']) {
    ok(html.includes('id="' + id + '"'), 'falta el contenedor ' + id);
  }
  const rows = (html.match(/class="[^"]*\bsrow\b/g) || []).length;
  ok(rows >= 25, 'filas buscables (.srow): ' + rows);
});

test('contexto: el recorte no suelta la pregunta del turno cuando la puerta añade usuario al final', () => {
  const contexto = require('../agent/contexto');
  const A = (id) => ({ role: 'assistant', content: 'a'.repeat(200), tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"p":1}' } }] });
  const T = (id) => ({ role: 'tool', tool_call_id: id, name: 'read_file', content: 'R'.repeat(3000) });
  const m = [
    { role: 'system', content: 'SISTEMA' },
    { role: 'user', content: 'PREGUNTA-REAL: corrige el bug' },
  ];
  for (let s = 0; s < 10; s++) {
    m.push(A('k' + s));
    m.push(T('k' + s));
  }
  m.push({ role: 'assistant', content: 'hecho' }, { role: 'user', content: 'ANTES DE CERRAR comprueba' });

  /* Sin marca, la frontera es el ÚLTIMO usuario, que aquí es la puerta: la pregunta
     viajaba como turno viejo y se soltaba. La marca es un Symbol del propio mensaje. */
  contexto.marcarTurno(m[1]);
  eq(Object.keys(m[1]).join(','), 'role,content', 'la marca no se enumera (no es un campo del mensaje)');
  ok(!JSON.stringify(m).includes('turno'), 'ni aparece en el JSON que se guarda o se manda');

  const rec = contexto.recortarMensajes(m, [], { model: 'x', contextWindow: 16000, maxTokens: 4096 });
  ok(rec.quitados > 0, 'con el contexto lleno se suelta algo: ' + rec.quitados);
  const usuarios = rec.messages.filter((x) => x.role === 'user').map((x) => String(x.content));
  ok(usuarios.some((t) => t.includes('PREGUNTA-REAL')), 'la pregunta del turno sigue en el envío');
  ok(usuarios.some((t) => t.includes('ANTES DE CERRAR')), 'y el bloque de la puerta también');
  // lo soltado es lo MÁS ANTIGUO: el primer bloque de herramienta ya no viaja
  ok(!rec.messages.some((x) => x.role === 'tool' && x.tool_call_id === 'k0'), 'se suelta el bloque más antiguo');
  const sueltos = rec.messages.filter(
    (x) =>
      x.role === 'tool' && !rec.messages.some((y) => y.role === 'assistant' && (y.tool_calls || []).some((c) => c.id === x.tool_call_id)),
  );
  eq(sueltos.length, 0, 'y sin resultados de herramienta huérfanos');

  /* Sin marca (historiales viejos, compactaciones) se mantiene el comportamiento de
     siempre: la frontera es el último usuario y los turnos viejos se van soltando. */
  const sinMarca = [{ role: 'system', content: 'SISTEMA' }];
  for (let s = 0; s < 10; s++) {
    sinMarca.push({ role: 'user', content: 'viejo ' + s }, A('x' + s), T('x' + s));
  }
  sinMarca.push({ role: 'user', content: 'ULTIMA-PREGUNTA' });
  const rec2 = contexto.recortarMensajes(sinMarca, [], { model: 'x', contextWindow: 16000, maxTokens: 4096 });
  ok(rec2.quitados > 0, 'sin marca también se recorta: ' + rec2.quitados);
  ok(rec2.messages.some((x) => x.role === 'user' && x.content === 'ULTIMA-PREGUNTA'), 'conservando el último usuario');
  ok(!rec2.messages.some((x) => x.role === 'user' && x.content === 'viejo 0'), 'y soltando los turnos viejos');
});

test('contexto: el turno real marca su pregunta y la puerta no la desplaza (agent)', async () => {
  const { Agent } = require('../agent/agent');
  const contexto = require('../agent/contexto');
  const vistas = [];
  const agent = new Agent({ emit: () => {}, screenshotFn: async () => ({}) });
  // el modelo no se llama: se captura lo que se iba a mandar en cada paso
  agent._streamWithFallback = async (chain, messages) => {
    vistas.push(messages);
    return { text: 'hecho' };
  };
  // la puerta de verificación es el camino que empuja instrucciones de usuario al final
  agent._needsVerification = function () {
    if (this._gateUsed) return false;
    this._gateUsed = true;
    return true;
  };
  agent._needsReview = () => false;
  // la cadena del bucle es la que mide el contexto: sin ventana propia se asume 128k
  const cadena = agent._chainFor.bind(agent);
  agent._chainFor = (cfg, texto, opts) => {
    const r = cadena(cfg, texto, opts);
    return { ...r, chain: r.chain.map((c) => ({ ...c, contextWindow: 12000 })) };
  };
  for (let s = 0; s < 12; s++) {
    agent.history.push({ role: 'user', content: 'viejo ' + s });
    agent.history.push({ role: 'assistant', content: 'a'.repeat(200), tool_calls: [{ id: 'v' + s, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    agent.history.push({ role: 'tool', tool_call_id: 'v' + s, name: 'read_file', content: 'R'.repeat(3000) });
  }
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o', contextWindow: 12000 },
    settings: { mode: 'act', modelRouting: false, verifyGate: true, reviewGate: false },
  };
  await agent.chat('PREGUNTA-REAL: corrige el bug', settings);
  eq(vistas.length, 2, 'la puerta pide una ronda extra antes de cerrar');
  const ultimo = vistas[vistas.length - 1];
  const usuarios = ultimo.filter((x) => x.role === 'user').map((x) => String(x.content));
  ok(usuarios.some((t) => t.includes('PREGUNTA-REAL')), 'la pregunta del turno sigue en el envío');
  ok(usuarios.some((t) => t.includes('ANTES DE CERRAR')), 'y el bloque de la puerta');
  const marcado = ultimo.find((x) => x.role === 'user' && contexto.esTurno(x));
  ok(marcado, 'la marca viaja con el mensaje');
  ok(String(marcado.content).includes('PREGUNTA-REAL'), 'y marca LA PREGUNTA, no las instrucciones de la puerta');
  eq(Object.keys(marcado).join(','), 'role,content', 'y no se enumera: no va en el JSON del envío');
  ok(!ultimo.some((x) => x.role === 'tool' && x.tool_call_id === 'v0'), 'lo soltado es lo más antiguo');
});
