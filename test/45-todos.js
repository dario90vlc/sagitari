'use strict';
/* Suite SAGITARI — v2.6 lista de tareas viva (todo_write).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, test, eq, ok, sseResponse, fakeFetch, evData, noSignal, sseTurn, toolTurn, autoApprove, SETTINGS_BASE, ChatKit } = require('./comun');const todos = require('../agent/todos');
const { Agent: AgentCls } = require('../agent/agent');
const traza = require('../main/traza');

const toolCall = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args || {}) } });

/* ---------- módulo puro ---------- */

test('todos: normaliza estados en español y sinónimos', () => {
  const r = todos.normalizar([
    { content: 'Leer el archivo', status: 'hecho' },
    { content: 'Editar', status: 'EN CURSO' },
    { content: 'Verificar', status: 'pendiente' },
  ]);
  ok(r.ok);
  eq(r.todos[0].status, 'completed');
  eq(r.todos[1].status, 'in_progress');
  eq(r.todos[2].status, 'pending');
  eq(r.todos.map(t => t.id).join(','), 'T1,T2,T3');
});

test('todos: una sola in_progress — el resto baja a pending con aviso', () => {
  const r = todos.normalizar([
    { content: 'A', status: 'in_progress' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'in_progress' },
  ]);
  ok(r.ok);
  eq(r.todos.filter(t => t.status === 'in_progress').length, 1);
  ok(/in_progress/.test(r.aviso), 'avisa del ajuste: ' + r.aviso);
});

test('todos: ignora elementos vacíos y duplicados, y avisa', () => {
  const r = todos.normalizar([
    { content: 'A', status: 'pending' },
    { content: '', status: 'pending' },
    null,
    { status: 'pending' },
    { content: 'a', status: 'pending' },   // duplicado (insensible a mayúsculas)
    'no soy objeto',
  ]);
  ok(r.ok);
  eq(r.todos.length, 1);   // solo 'A': sin content, null, duplicada y no-objeto se ignoran
  ok(r.aviso.length > 0);
});

test('todos: recorta la lista al tope y los textos largos', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ content: 'Tarea ' + i, status: 'pending' }));
  const r = todos.normalizar(many);
  eq(r.todos.length, todos.MAX_TAREAS);
  ok(/recort/.test(r.aviso));
  const largo = todos.normalizar([{ content: 'x'.repeat(500), status: 'pending' }]);
  ok(largo.todos[0].content.length <= todos.MAX_TEXTO);
});

test('todos: entrada inservible devuelve error accionable', () => {
  ok(!todos.normalizar(undefined).ok);
  ok(!todos.normalizar(null).ok);
  ok(!todos.normalizar('lista').ok);
  ok(!todos.normalizar({ content: 'x' }).ok);
  ok(/lista/i.test(todos.normalizar('lista').error));
  // status raro → pending, no error (tolerancia)
  eq(todos.normalizar([{ content: 'A', status: 'casi' }]).todos[0].status, 'pending');
});

test('todos: resumen y bloquePrompt', () => {
  const l = todos.normalizar([
    { content: 'Uno', status: 'completed' },
    { content: 'Dos', status: 'in_progress', activeForm: 'Haciendo dos' },
    { content: 'Tres' },
  ]).todos;
  const res = todos.resumen(l);
  ok(/1 de 3/.test(res), res);
  ok(/todo_write/.test(res));
  const bloque = todos.bloquePrompt(l);
  ok(/LISTA DE TAREAS/.test(bloque));
  ok(/\[x\] Uno/.test(bloque), bloque);
  ok(/\[>\] Dos/.test(bloque));
  ok(/\[ \] Tres/.test(bloque));
  eq(todos.bloquePrompt([]), '');
  eq(todos.bloquePrompt(null), '');
  eq(todos.etiquetaActiva(l[1]), 'Haciendo dos');
  eq(todos.etiquetaActiva(l[2]), 'Tres');
});

/* ---------- despacho en el agente ---------- */

test('todo_write: se ejecuta en el agente, guarda la lista y emite el evento', async () => {
  const ev = [];
  const a = new AgentCls({ emit: (e) => ev.push(e) });
  const r = await a._runToolCall(toolCall('todo_write', { todos: [
    { content: 'Paso uno', status: 'completed' },
    { content: 'Paso dos', status: 'in_progress' },
    { content: 'Paso tres', status: 'pending' },
  ] }), { signal: new AbortController().signal, settings: { settings: {} } });
  eq(r.action, 'ok');
  ok(!r.failed, 'sin error: ' + r.text);
  eq(a.todos.length, 3);
  ok(ev.some(e => e.type === 'todos' && e.todos.length === 3), 'evento todos emitido');
  ok(/1 de 3/.test(r.text), 'el resultado le devuelve la lista al modelo: ' + r.text);
  // los contadores del run no se tocan (no es una mutación del sistema)
  eq(a._writes, 0);
  eq(a._cmds, 0);
});

test('todo_write: entrada rota devuelve error al modelo sin tocar la lista', async () => {
  const a = new AgentCls({ emit: () => {} });
  const r = await a._runToolCall(toolCall('todo_write', {}), { signal: new AbortController().signal, settings: { settings: {} } });
  eq(r.action, 'ok');   // la llamada se resuelve (no es un fallo del bucle)
  ok(r.failed, 'pero marca el fallo para el modelo');
  ok(/todos/i.test(r.text), 'explica el problema: ' + r.text);
  eq(a.todos.length, 0);
});

test('todo_write: es safe y va al catálogo', () => {
  const { RISK, toolDefs } = require('../agent/tools');
  eq(RISK.todo_write, 'safe');
  ok(toolDefs.some(d => d.function.name === 'todo_write'), 'la herramienta existe en el catálogo');
  ok(ChatKit.TOOLS.todo_write, 'el renderer la conoce');
});

/* ---------- integración de turno: llega al modelo ---------- */

test('turno con todo_write: la lista viaja en el prompt del siguiente paso y el evento llega a la UI', async () => {
  const ev = [];
  let calls = 0;
  const fetchFn = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    if (calls === 1) {
      return toolTurn('t1', 'todo_write', { todos: [
        { content: 'Crear el archivo', status: 'in_progress' },
        { content: 'Comprobar', status: 'pending' },
      ] });
    }
    // el SEGUNDO paso lleva la lista en el system prompt
    ok(/LISTA DE TAREAS/.test(body.messages[0].content), 'la lista viaja en el prompt de sistema');
    ok(/\[>\] Crear el archivo/.test(body.messages[0].content), body.messages[0].content.slice(0, 400));
    return sseTurn('Hecho.');
  };
  const a = new AgentCls({ emit: (e) => ev.push(e), fetchFn });
  await a.chat('Haz la tarea', SETTINGS_BASE(), null, { signal: noSignal() });
  ok(ev.some(e => e.type === 'todos'), 'la UI recibió el evento todos');
  eq(a.busy, false);
});

/* ---------- chatkit y traza ---------- */

test('chatkit: todo_write en el catálogo con etiqueta e icono', () => {
  const t = ChatKit.tool('todo_write');
  eq(t.label, 'Lista de tareas');
  eq(t.icon, 'list');
  // resumen de argumentos humano, no el JSON crudo de la lista
  const s = ChatKit.summarizeArgs('todo_write', { todos: [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'pending' },
  ] });
  eq(s, '3 tareas · 1 en curso · 1 hechas');
  ok(!/\{/.test(s), 'sin JSON en la tarjeta');
});

test('todo_write: actualizaciones consecutivas no disparan el guardián de bucles', async () => {
  const a = new AgentCls({ emit: () => {} });
  const ctx = { signal: new AbortController().signal, settings: { settings: {} } };
  // el patrón legítimo de Claude Code: in_progress → completed del mismo paso, tres veces
  const lista = (s1, s2) => ({ todos: [
    { content: 'Paso', status: s1 },
    { content: 'Otro', status: s2 },
  ] });
  const r1 = await a._runToolCall(toolCall('todo_write', lista('in_progress', 'pending')), ctx);
  const r2 = await a._runToolCall(toolCall('todo_write', lista('completed', 'in_progress')), ctx);
  const r3 = await a._runToolCall(toolCall('todo_write', lista('in_progress', 'completed')), ctx);
  for (const [i, r] of [r1, r2, r3].entries()) {
    eq(r.action, 'ok', 'llamada ' + (i + 1));
    ok(!r.failed, 'la ' + (i + 1) + 'ª actualización no se bloquea como bucle: ' + r.text);
  }
  eq(a.todos.length, 2);
});

test('traza: el evento todos se guarda acotado y se ofrece en el rastro del turno', () => {
  traza.trazaNueva();
  try {
    traza.trazaApunta({ type: 'todos', todos: [
      { content: 'x'.repeat(400), status: 'completed' },   // se recorta
      { content: 'Dos', status: 'in_progress', activeForm: 'y'.repeat(400) },
    ] });
    const tt = traza.trazaActual();
    eq(tt.todos.length, 2);
    ok(tt.todos[0].content.length < 400 && /recortado/.test(tt.todos[0].content), 'contenido acotado y avisado');
    eq(tt.todos[1].status, 'in_progress');
    ok(tt.todos[1].activeForm.length < 400 && /recortado/.test(tt.todos[1].activeForm));
  } finally { traza.trazaCerrar(); }
});

test('main: el rastro con solo tareas se guarda en la conversación (la condición incluye tt.todos)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  ok(/tt\.todos && tt\.todos\.length/.test(src), 'la condición del rastro guarda la lista');
});
