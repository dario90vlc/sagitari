'use strict';
/* Suite SAGITARI — chat, arranque, apariencia, adjuntos, icono (antes run.js 2028-2763).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, os, tmpDir, test, eq, ok, sseResponse, fakeFetch, evData, toolTurn, Guardrails, summarizeArgs, skills, memory, subagents, ChatKit, MAIN_SRC, MAIN_ALL, ico, updater, readRenderer, RENDERER_JS } = require('./comun');


/* ---------- chat: ChatKit (lógica pura del chat) ---------- */
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
  // Las claves REALES del registro (antes esta lista decía `verify` y el verificador se
  // quedaba sin etiqueta: la clave del backend es `verification`).
  const known = subagents.SUBAGENT_KEYS;
  const missing = known.filter(k => !ChatKit.subagent(k));
  eq(missing.join(', '), '', 'subagentes sin ficha');
  for (const k of known) {
    ok(ChatKit.subagent(k).label, 'etiqueta de subagente ' + k);
    ok(iconExists(ChatKit.subagent(k).icon), 'icono de subagente ' + k);
  }
  // Un subagente desconocido ya NO devuelve null: el renderer lee `.label` sobre ese valor y
  // el null tumbaba el manejador de eventos (la verificación no llegaba a pintarse).
  eq(ChatKit.subagent('nadie').label, 'nadie', 'un subagente desconocido cae a su propio nombre');
  eq(ChatKit.subagent(''), null, 'sin clave no hay etiqueta');
  ok(keys.length >= 1, 'los subagentes del backend se pudieron enumerar');
});

test('chat: todo icono usado por el renderer existe en el sistema de iconos', () => {
  const app = readRenderer();
  const used = new Set([...app.matchAll(/\bic\('([A-Za-z0-9_]+)'/g)].map(m => m[1]));
  const missing = [...used].filter(n => !iconExists(n));
  eq(missing.join(', '), '', 'iconos referencia dos pero no definidos');
  ok(used.size > 10, 'se detectaron iconos en el renderer: ' + used.size);
});

test('renderer: los scripts conviven en el mismo ámbito (sin redeclaraciones)', () => {
  // Los cuatro ficheros son scripts CLÁSICOS: comparten un único ámbito global.
  // Un `const MODE_ORDER` repetido es un SyntaxError de compilación y el
  // segundo fichero NO se ejecuta — la app se queda sin iconos, sin botones y
  // sin nada, con el HTML estático aún en pantalla. Se compila el conjunto
  // como un solo script (sin ejecutarlo) para detectarlo antes de arrancar.
  const vm = require('vm');
  const files = ['icons.js', 'chatkit.js', 'orb.js', ...RENDERER_JS];
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
  // chatkit.js debe cargarse ANTES del renderer partido: define el catálogo que usa
  const kit = html.indexOf('chatkit.js');
  const app2 = html.indexOf('10-chat.js');
  ok(kit > 0 && app2 > kit, 'chatkit.js debe cargarse antes que el renderer');
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
  eq(views.length, 10, 'ítems de navegación (sin Inicio: la app abre en Chat)');
  eq(new Set(views).size, views.length, 'sin vistas duplicadas en el sidebar');
  // MCP y Herramientas son hermanas: la sección va en «Conocimiento», justo antes que Tools
  const conocimiento = html.slice(html.indexOf('data-label="Conocimiento"'), html.indexOf('data-label="Sistema"'));
  eq([...conocimiento.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]).join(','), 'memory,skills,mcp,tools',
    'MCP va en Conocimiento, antes que Herramientas');
  ok(/data-view="mcp"[^>]*title="Servidores MCP"/.test(html), 'el ítem de MCP se llama «Servidores MCP» en el title');
  // cada ítem debe apuntar a una sección real (si no, goto() deja la app en blanco)
  const missing = views.filter(v => !html.includes('id="view-' + v + '"'));
  eq(missing.join(', '), '', 'ítems del sidebar sin sección .view');
  // los elementos que usa la lógica nueva del sidebar deben existir
  for (const id of ['sideToggle', 'sideStatusBtn', 'sideModeBtn', 'sideModeLabel', 'nbChat', 'nbTasks', 'nbMemory', 'nbSkills', 'app']) {
    ok(html.includes('id="' + id + '"'), 'falta el elemento ' + id);
  }
  const js = readRenderer();
  // atajos Alt+1..9: la tabla debe cumplir EXACTAMENTE lo que prometen los tooltips.
  // No todos los ítems llevan atajo (MCP no lo tiene): exigir uno por ítem sobraba,
  // lo que no puede haber es un tooltip que prometa una tecla sin destino ni una
  // entrada de la tabla que abra algo distinto de lo prometido.
  const hot = js.match(/VIEW_HOTKEY\s*=\s*\[([^\]]+)\]/);
  ok(hot, 'falta la tabla de atajos del sidebar');
  const keys = hot[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  eq(new Set(keys).size, keys.length, 'sin atajos repetidos');
  const promised = [...html.matchAll(/class="navitem[^"]*"\s+data-view="([^"]+)"\s+title="[^"]*\(Alt\+(\d+)\)"/g)];
  eq(promised.length, keys.length, 'los ítems con «(Alt+N)» en el tooltip y la tabla de atajos deben coincidir');
  promised.forEach(([, view, num]) => {
    eq(keys[Number(num) - 1], view, 'Alt+' + num + ' debe abrir la vista prometida en el tooltip');
  });
  ok(!keys.includes('mcp'), 'MCP no tiene atajo: no puede estar en VIEW_HOTKEY');
  for (const v of keys) ok(html.includes('id="view-' + v + '"'), 'atajo sin sección: ' + v);
  // compacto: debe estrechar en TODAS las vistas. La regla del recorte del rail
  // (0,3,0 por los dos :not) ganaba a .app.compact (0,2,0) y el panel no se
  // estrechaba aunque los iconos sí se centraban.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  ok(/\.app\.compact:not\(\[data-view="chat"\]\):not\(\[data-view="agents"\]\)\s*\{\s*grid-template-columns:\s*78px 1fr/.test(css),
    'el compacto debe mandar sobre el recorte del rail en las vistas sin rail');
});

/* ---------- guardas de integración (regresiones de la auditoría) ---------- */

test('integración: cada método sagitari.* del renderer existe en el preload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const renderer = readRenderer();
  const exposed = new Set([...preload.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map(m => m[1]));
  const used = new Set([...renderer.matchAll(/sagitari\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
  const missing = [...used].filter(k => !exposed.has(k));
  eq(missing.join(', '), '', 'métodos usados por el renderer pero ausentes del preload');
});

test('integración: cada canal invocado en el preload tiene handler en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  // Fase 4: los handlers viven repartidos entre main.js y los routers main/ipc-*.js.
  const main = fs.readdirSync(path.join(__dirname, '..', 'main')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'main', f), 'utf8')).join('\n');
  const channels = [...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]);
  const handlers = new Set([...main.matchAll(/handle\('([^']+)'/g)].map(m => m[1]));
  const missing = [...new Set(channels)].filter(c => !handlers.has(c));
  eq(missing.join(', '), '', 'canales sin handler en main');
});

/* ---------- arranque e instancia única (regresión de «la app se cierra») ---------- */

// Fase 4: los routers main/ipc-*.js también son proceso principal; los tests que
// buscan código extraído (secretos, ajustes, theme) escanean el dominio completo.

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
  /* Glow: el contrato es un trabajo por capas —cada estado pone SU nivel de luz
     (energía + opacidad del filo), el aura vive con su propio movimiento (giro
     del color + respiración del alcance) y el pulso da el acuse— y un camino de
     movimiento reducido. Se comprueba eso y no un selector concreto, que es
     detalle de implementación. */
  for (const estado of ['think', 'work', 'listen', 'speak']) {
    ok(new RegExp('\\.shell\\.glow-' + estado + '\\s*\\{[^}]*--energy').test(css), 'el estado ' + estado + ' debe tener su energía');
    ok(new RegExp('\\.shell\\.glow-' + estado + '\\s+\\.glow\\s*\\{[^}]*opacity:').test(css), 'el estado ' + estado + ' debe tener su nivel de luz');
  }
  for (const k of ['frame-bloom', 'giro', 'reachLife']) ok(css.includes('@keyframes ' + k), 'falta el keyframe ' + k);
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
  for (const id of ['uiColor', 'glowColor', 'glowStrength', 'dotUiColor', 'dotGlowColor', 'glowStrengthLabel', 'glassTint', 'glassTintLabel'])
    ok(html.includes('id="' + id + '"'), 'falta #' + id);
  ok(html.includes('<b>Apariencia</b>'), 'debe existir la tarjeta Apariencia');
  const app = readRenderer();
  ok(/const PALETTES = \{[\s\S]{0,1400}\};/.test(app), 'debe existir la tabla PALETTES');
  ok(/function applyTheme\(\)/.test(app), 'debe existir applyTheme');
  ok(/\$\('#glowStrength'\)\.oninput/.test(app) && /\$\('#uiColor'\)\.onchange/.test(app), 'los controles deben estar cableados');
  // tema Aurora (iOS 27 / Apple Intelligence): interfaz sobria + espectro en el borde
  ok(/aurora:\s*\{ label: 'Aurora'/.test(app), 'PALETTES debe traer aurora');
  ok(/AURORA_GLOW/.test(app), 'el espectro del glow aurora debe estar definido');
  ok(html.includes('value="aurora"'), 'los selects deben ofrecer aurora');
  ok(/glow-aurora/.test(app) && /\.shell\.glow-aurora \.glow::before\s*\{/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8')), 'aurora debe encender el espectro del borde');
  // receta del experimento AppleIntelligenceGlowEffect (jacobamobin, SwiftUI sin
  // shaders): 6 colores fijos + filo nítido + copias desenfocadas, todos a la
  // vez como halos que ondulan (el filo lleva el espectro fijo; la luz del
  // aura rueda por debajo con giro, sin recorrer el marco)
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  for (const hex of ['f5b9ea', 'ffba71', 'ff6778', 'c686ff', '8d9fff', 'bc82f3'])
    ok(css.toLowerCase().includes(hex), 'el espectro aurora debe llevar el color ' + hex);
  ok(/@keyframes giro/.test(css) && /@keyframes reachLife/.test(css), 'la rotación y la respiración del aura deben existir');
  // equilibrio Siri: todos presentes a la vez, el anillo interior reparte los
  // 3 tonos sin que uno tiña todo el marco y el filo nítido lleva el espectro
  // fijo (los 6 hexes de arriba); por debajo, la luz del aura rueda con giro
  ok(/\.shell\.glow-aurora \.glowRing\s*\{/.test(css) && /\.shell\.glow-aurora \.glow::before\s*\{[^}]*f5b9ea/.test(css), 'el anillo y el filo aurora reparten el espectro');
  // RGB continuo y suave: los 3 tonos los fija AURORA_GLOW (azul, rosa,
  // naranja — a la vez, como Siri) y applyTheme los vuelca en
  // --glow-a/b/c-rgb, así que los halos genéricos del aura los pintan y el
  // blur los mezcla
  ok(/AURORA_GLOW = \{ a: \[141, 159, 255\], b: \[255, 103, 120\], c: \[255, 186, 113\] \}/.test(app), 'AURORA_GLOW reparte azul, rosa y naranja');
  ok(/auroraGlow \? AURORA_GLOW\.a/.test(app), 'applyTheme vuelca el espectro aurora en el glow');
  // tricolor real: los 3 tonos nacen a ±42º del elegido (no vecinos), para que
  // se distingan a la vez en vez de fundirse en un solo color
  ok(/_rgb\(gh \+ 42/.test(app) && /_rgb\(gh - 42/.test(app), 'los 3 tonos del glow deben nacer separados ±42º');
  ok(/saturate\(1\.8\)/.test(css), 'el flow debe ir bien saturado');
  // reequilibrio: acentos calmados y glow suave por defecto (que acaricie, no que invada)
  ok(/Number\(s\.glowStrength\) \|\| 0\.7/.test(app), 'el glow por defecto debe ser suave (0.7)');
  // la rueda sobre el menú abierto (o sus sliders vecinos) no lo cierra: solo
  // se cierra si se desplaza algo FUERA de él (el menú es fixed y quedaría descolgado)
  ok(/cselAbierto\.menu\.contains\(e\.target\)/.test(app), 'el scroll dentro del menú no debe cerrarlo');
  // el glow se enciende al hablar y se apaga al terminar la voz
  ok(/window\.sagitari\.glow\('speak'\)/.test(app), 'speak() debe encender el glow');
  ok(/onTtsDone/.test(app), 'el fin de la voz debe apagar el glow');
  ok(/onThemeChanged/.test(app), 'los cambios de tema deben aplicarse al vuelo');
});

test('apariencia: main guarda preferencias y emite tts:done + theme:changed', () => {
  ok(/uiColor: 'violet'/.test(MAIN_SRC) && /glowStrength: 1/.test(MAIN_SRC), 'defaults de apariencia en settings');
  ok(/glowColor: 'match'/.test(MAIN_SRC), 'el glow sigue al tema por defecto');
  ok(/tts:done/.test(MAIN_ALL), 'el fin del TTS debe notificarse al renderer'); // Fase 4: vive en ipc-voz.js
  ok(/theme:changed/.test(MAIN_ALL), 'los cambios de apariencia deben broadcastearse');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/onTtsDone/.test(preload) && /onThemeChanged/.test(preload), 'preload debe exponer onTtsDone y onThemeChanged');
});

/* ---------- adjuntos del chat: archivos, documentos e imágenes ---------- */

test('adjuntos: main delega en el módulo de adjuntos y conserva los metadatos', () => {
  const main = MAIN_ALL; // Fase 4: los handlers viven en main/ipc-chat.js
  ok(/attachments:pick/.test(main) && /attachments:read/.test(main), 'faltan los handlers IPC de adjuntos');
  // Los límites, las listas de extensiones y el bloque de texto viven ahora en
  // main/attachments.js y se prueban por COMPORTAMIENTO (ver «adjuntos: tipo,
  // texto, recorte y ruta prohibida»): aquí solo el cableado y que no se dupliquen.
  ok(/require\('\.\/attachments'\)/.test(MAIN_SRC), 'main debe usar main/attachments.js');
  ok(/attach\.kindOf\(/.test(main) && /attach\.textOf\(/.test(main) && /attach\.blocksFor\(/.test(main), 'la lectura y el volcado al mensaje pasan por el módulo');
  ok(!/const MAX_FILE_BYTES/.test(MAIN_SRC) && !/const TEXT_EXTS/.test(MAIN_SRC), 'los límites y las listas no pueden duplicarse en main.js');
  // el mensaje guardado conserva metadatos de adjuntos (miniaturas al recargar)
  ok(/attachments: attMeta/.test(main), 'los metadatos de adjuntos deben guardarse en la conversación');
  // el body por defecto con imagen pero sin texto sigue funcionando
  ok(/\(análisis de imagen\)/.test(main), 'imagen sola debe tener texto por defecto');
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
  const app = readRenderer();
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
