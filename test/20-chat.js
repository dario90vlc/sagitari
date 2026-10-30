'use strict';
/* Suite SAGITARI — chat, arranque, apariencia, adjuntos, icono (antes run.js 2028-2763).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const {
  fs,
  path,
  tmpDir,
  test,
  eq,
  ok,
  wait,
  sseResponse,
  fakeFetch,
  evData,
  Guardrails,
  subagents,
  ChatKit,
  MAIN_SRC,
  MAIN_ALL,
  ico,
  readRenderer,
  RENDERER_JS,
} = require('./comun');

/* ---------- chat: ChatKit (lógica pura del chat) ---------- */
const ICON_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
const ICON_NAMES = new Set([...ICON_SRC.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*'/gm)].map((m) => m[1]));

/** ¿Existe este icono en el sistema de iconos? (evita iconos fantasma) */
function iconExists(name) {
  return ICON_NAMES.has(name);
}

test('chat: los cuatro modos tienen identidad propia y real', () => {
  eq(ChatKit.MODE_ORDER.join(','), 'act,plan,think,equipo');
  for (const k of ChatKit.MODE_ORDER) {
    const m = ChatKit.MODES[k];
    ok(m.label && m.name && m.tagline, k + ' debe explicarse en la UI');
    ok(m.bullets && m.bullets.length >= 2, k + ' debe detallar en qué se diferencia');
    ok(/^#[0-9a-f]{6}$/i.test(m.color), k + ' necesita color propio');
    ok(/^\d+,\d+,\d+$/.test(m.rgb), k + ' necesita rgb para el tema');
    ok(iconExists(m.icon), 'icono del modo ' + k + ': ' + m.icon);
    ok(ChatKit.MODE_ORDER.indexOf(m.key) >= 0, k + ' debe pertenecer al ciclo');
  }
  const colors = new Set(ChatKit.MODE_ORDER.map((k) => ChatKit.MODES[k].color));
  eq(colors.size, 4, 'los cuatro modos no pueden compartir color');
});

test('chat: nextMode cicla ACT → PLAN → THINK → EQUIPO → ACT', () => {
  eq(ChatKit.nextMode('act'), 'plan');
  eq(ChatKit.nextMode('plan'), 'think');
  eq(ChatKit.nextMode('think'), 'equipo');
  eq(ChatKit.nextMode('equipo'), 'act');
  eq(ChatKit.nextMode('inexistente'), 'plan', 'un modo inválido se trata como ACT');
  eq(ChatKit.mode('PLAN').key, 'plan', 'acepta el nombre en mayúsculas');
});

test('chat: toda herramienta del agente tiene etiqueta humana e icono real', () => {
  const toolsSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
  const names = [...toolsSrc.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  names.push('delegate'); // definida en subagents.js
  ok(names.length >= 16, 'herramientas detectadas: ' + names.length);
  const missing = names.filter((n) => !ChatKit.TOOLS[n]);
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
  const keys = [...fs.readFileSync(path.join(__dirname, '..', 'agent', 'subagents.js'), 'utf8').matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(
    (m) => m[1],
  );
  // Las claves REALES del registro (antes esta lista decía `verify` y el verificador se
  // quedaba sin etiqueta: la clave del backend es `verification`).
  const known = subagents.SUBAGENT_KEYS;
  const missing = known.filter((k) => !ChatKit.subagent(k));
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
  const used = new Set([...app.matchAll(/\bic\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !iconExists(n));
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
  const files = ['icons.js', 'chatkit.js', ...RENDERER_JS];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8')).join('\n;\n');
  new vm.Script(code, { filename: 'renderer-bundle-check.js' });
});

test('chat: el estado vacío vive fuera de #messages (no se lo lleva innerHTML)', () => {
  // #messages se vacía con innerHTML en cada conversación nueva: si el estado
  // vacío estuviera dentro, desaparecería para siempre al arrancar la app.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const open = html.indexOf('<div id="messages"');
  ok(open > 0, 'debe existir #messages');
  // recorre el anidamiento de <div> para aislar el contenido de #messages
  let depth = 0,
    i = open,
    inner = '';
  while (i < html.length) {
    const nOpen = html.indexOf('<div', i);
    const nClose = html.indexOf('</div>', i);
    if (nClose < 0) break;
    if (nOpen >= 0 && nOpen < nClose) {
      depth++;
      i = nOpen + 4;
    } else {
      depth--;
      i = nClose + 6;
      if (depth === 0) {
        inner = html.slice(open, i);
        break;
      }
    }
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
  /* chatkit.js tiene que cargarse ANTES del renderer partido: define el catálogo que
     usa. Se mira el ORDEN DE LAS ETIQUETAS `<script>`, no la primera aparición del
     nombre en el fichero: un comentario que mencione el fichero (los hay, y ayudan)
     hacía fallar esta comprobación sin que nada estuviera mal. */
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const kit = scripts.indexOf('chatkit.js');
  const app2 = scripts.indexOf('10-chat.js');
  ok(kit >= 0 && app2 > kit, 'chatkit.js debe cargarse antes que el renderer');
});

test('chat: el CSS da color propio a cada modo y estiliza las tarjetas', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  /* El selector va sin comillas fijas: Prettier normaliza a comilla simple y la
     comprobación es del contrato (cada modo tiene su tema), no del formato. */
  for (const k of ChatKit.MODE_ORDER) {
    ok(new RegExp('#view-chat\\[data-mode=["\']' + k + '["\']').test(css), 'el modo ' + k + ' necesita su tema en el chat');
  }
  for (const cls of ['tcard', 'tgroup', 'plancard', 'codeblock', 'msg-actions', 'chat-empty', 'jumpdown', 'stream']) {
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
  ok(
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    'hidden debe ganar a las reglas de display (regla global, no parches por selector)',
  );
});

test('chat: los componentes de la burbuja no heredan el pre-wrap de la burbuja', () => {
  // La burbuja usa white-space: pre-wrap (para respetar los saltos del modelo).
  // Los componentes con marcado multilínea DEBEN volver al flujo normal o los
  // saltos del propio HTML se dibujan como líneas en blanco dentro de la tarjeta.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{[^}]*white-space:\s*normal[^}]*\}/g)].map((m) => m[1]);
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
  const agent = new Agent({
    fetchFn: fakeFetch(chunks),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'think', modelRouting: false },
  };
  await agent.chat('hola', settings);
  const start = events.find((e) => e.type === 'busy' && e.busy);
  ok(start, 'debe emitir busy al arrancar');
  eq(start.mode, 'think', 'la UI necesita el modo para sellar el turno');
  eq(start.model, 'gpt-4o', 'y el modelo que va a responder');
});

test('agent: el resultado de una herramienta llega con duración y si falló', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  // 1ª vuelta: el modelo pide una herramienta segura; 2ª: responde y termina
  const step1 = [
    evData({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }],
    }),
  ];
  const step2 = [evData({ choices: [{ delta: { content: 'listo' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async () => sseResponse(n++ === 0 ? step1 : step2),
    emit: (e) => events.push(e),
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false, workspace: tmpDir('sagi-ws-') },
  };
  await agent.chat('lista la carpeta', settings);
  const res = events.find((e) => e.type === 'tool_result');
  ok(res, 'debe emitir tool_result');
  eq(res.name, 'list_dir');
  ok(typeof res.durationMs === 'number', 'la tarjeta necesita la duración real');
  ok(res.ok === true, 'la salida correcta se marca como ok');
  const card = events.find((e) => e.type === 'tool');
  ok(card && card.args && card.args.path === '.', 'el evento tool trae los argumentos');
});

test('agent: retry descarta la respuesta anterior y repite la misma pregunta', async () => {
  const { Agent } = require('../agent/agent');
  const prompts = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      const body = JSON.parse(opts.body);
      prompts.push(body.messages.filter((m) => m.role === 'user').pop().content);
      return sseResponse([evData({ choices: [{ delta: { content: 'respuesta ' + prompts.length } }] })]);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('primera pregunta', settings);
  const before = agent.history.length;
  await agent.retry(settings);
  eq(prompts.length, 2, 'el modelo volvió a ser consultado');
  eq(prompts[1], 'primera pregunta', 'se repite la misma pregunta');
  // el historial no acumula la respuesta descartada: user + assistant, sin duplicar
  eq(agent.history.filter((h) => h.role === 'user').length, 1, 'no se duplica la pregunta');
  eq(agent.history.filter((h) => h.role === 'assistant').length, 1, 'sólo queda la respuesta nueva');
  ok(agent.history.length <= before, 'el historial no crece al regenerar');
});

test('agent: regenerar conserva la imagen que llevaba el mensaje', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return sseResponse([evData({ choices: [{ delta: { content: 'ok' } }] })]);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('mira esto', settings, 'data:image/png;base64,ZZZ');
  await agent.retry(settings);
  const last = bodies[bodies.length - 1].messages.filter((m) => m.role === 'user').pop();
  ok(JSON.stringify(last).includes('ZZZ'), 'la imagen se vuelve a enviar en el reintento');
});

/* ---------- regresiones de la auditoría del núcleo ---------- */

test('agent: denegar una confirmación continúa la ejecución (no rompe el turno)', async () => {
  const { Agent } = require('../agent/agent');
  const events = [];
  const bodies = [];
  const step1 = [
    evData({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_command', arguments: '{"command":"del algo"}' } }] } },
      ],
    }),
  ];
  const step2 = [evData({ choices: [{ delta: { content: 'vale, no lo ejecuto' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return sseResponse(n++ === 0 ? step1 : step2);
    },
    emit: (e) => {
      events.push(e);
      if (e.type === 'confirm_request') setTimeout(() => agent.resolveConfirm(e.id, false), 0);
    },
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  await agent.chat('borra la carpeta', settings);
  const errs = events.filter((e) => e.type === 'error');
  eq(errs.length, 0, 'denegar no puede abortar con error: ' + (errs[0] && errs[0].message));
  const denial = (bodies[1].messages || []).find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  ok(denial && /DENEGÓ/.test(denial.content), 'el modelo debe recibir la negativa como resultado de la herramienta');
  ok(
    events.some((e) => e.type === 'assistant_done'),
    'el turno debe cerrarse con la respuesta del modelo',
  );
});

test('agent: el payload descarta tool_calls sin respuesta y tool huérfanos', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return sseResponse([evData({ choices: [{ delta: { content: 'ok' } }] })]);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false },
  };
  // historial envenenado: el turno anterior murió entre el assistant y su respuesta
  agent.history.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'x1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  agent.history.push({ role: 'tool', tool_call_id: 'huerfano', name: 'read_file', content: 'no debería viajar' });
  await agent.chat('continúa', settings);
  const sent = bodies[0].messages;
  ok(!sent.some((m) => m.role === 'tool' && m.tool_call_id === 'huerfano'), 'un tool huérfano no puede viajar a la API');
  for (const m of sent.filter((m) => m.role === 'assistant' && m.tool_calls)) {
    for (const tc of m.tool_calls) {
      ok(
        sent.some((x) => x.role === 'tool' && x.tool_call_id === tc.id),
        'toda tool_call enviada necesita su respuesta',
      );
    }
  }
});

test('agent: el subagente no deja tool_calls sin responder al detectar un bucle', async () => {
  const { Agent } = require('../agent/agent');
  const bodies = [];
  const toolTurn = [
    evData({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }],
    }),
  ];
  const textTurn = [evData({ choices: [{ delta: { content: 'RESULT: hecho\nSTATUS: OK' } }] })];
  let n = 0;
  const agent = new Agent({
    fetchFn: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return sseResponse(n++ < 3 ? toolTurn : textTurn);
    },
    emit: () => {},
    screenshotFn: async () => ({ dataUrl: 'data:image/png;base64,AA' }),
  });
  const settings = {
    active: { name: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' },
    settings: { mode: 'act', modelRouting: false, workspace: process.cwd() },
  };
  const out = await agent._delegate(subagents.SUBAGENTS.file, { task: 'lee package.json tres veces' }, { settings });
  ok(/RESULT/.test(out), 'la delegación debe devolver el resultado estructurado: ' + out.slice(0, 80));
  for (const body of bodies) {
    const msgs = body.messages;
    for (const m of msgs.filter((x) => x.role === 'assistant' && x.tool_calls)) {
      for (const tc of m.tool_calls) {
        ok(
          msgs.some((x) => x.role === 'tool' && x.tool_call_id === tc.id),
          'el subagente envió una tool_call sin respuesta',
        );
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
  const groups = [...html.matchAll(/class="navgroup"\s+data-label="([^"]+)"/g)].map((m) => m[1]);
  ok(groups.length >= 4, 'grupos del sidebar: ' + groups.join(' / '));
  const views = [...html.matchAll(/class="navitem[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1]);
  eq(views.length, 11, 'ítems de navegación (sin Inicio: la app abre en Chat)');
  eq(new Set(views).size, views.length, 'sin vistas duplicadas en el sidebar');
  // MCP y Herramientas son hermanas: la sección va en «Conocimiento», justo antes que Tools
  const conocimiento = html.slice(html.indexOf('data-label="Conocimiento"'), html.indexOf('data-label="Sistema"'));
  eq(
    [...conocimiento.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]).join(','),
    'memory,skills,mcp,tools',
    'MCP va en Conocimiento, antes que Herramientas',
  );
  ok(/data-view="mcp"[^>]*title="Servidores MCP"/.test(html), 'el ítem de MCP se llama «Servidores MCP» en el title');
  // cada ítem debe apuntar a una sección real (si no, goto() deja la app en blanco)
  const missing = views.filter((v) => !html.includes('id="view-' + v + '"'));
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
  const keys = hot[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  eq(new Set(keys).size, keys.length, 'sin atajos repetidos');
  /* El tooltip de la barra es una CLAVE (data-i18n-title): se lee la clave y se resuelve
     en el diccionario español, que es el texto que el usuario ve de fábrica. Así se sigue
     midiendo el contrato (la tabla promete lo mismo que los tooltips) sin clavar la prosa.
     «skills» es el único ítem sin clave: su tooltip sigue en el marcado. */
  const dictEs = require('../renderer/i18n-es');
  const promised = [...html.matchAll(/class="navitem[^"]*"\s+data-view="([^"]+)"([^>]*)>/g)]
    .map(([, view, attrs]) => {
      const clave = (attrs.match(/data-i18n-title="([^"]+)"/) || [])[1];
      const title = clave ? dictEs[clave] || '' : (attrs.match(/\stitle="([^"]*)"/) || [])[1] || '';
      const m = title.match(/\(Alt\+(\d+)\)/);
      return m ? [view, m[1]] : null;
    })
    .filter(Boolean);
  eq(promised.length, keys.length, 'los ítems con «(Alt+N)» en el tooltip y la tabla de atajos deben coincidir');
  promised.forEach(([view, num]) => {
    eq(keys[Number(num) - 1], view, 'Alt+' + num + ' debe abrir la vista prometida en el tooltip');
  });
  ok(!keys.includes('mcp'), 'MCP no tiene atajo: no puede estar en VIEW_HOTKEY');
  for (const v of keys) ok(html.includes('id="view-' + v + '"'), 'atajo sin sección: ' + v);
  // compacto: debe estrechar en TODAS las vistas sin rail. La regla del recorte del
  // rail (0,4,0 con sus tres :not) ganaba a .app.compact (0,2,0) y el panel no se
  // estrechaba aunque los iconos sí se centraban. La regla compacta tiene que cubrir
  // EXACTAMENTE el mismo conjunto de vistas que el recorte (chat, agentes y equipo
  // conservan su rail lateral).
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  ok(
    /\.app:not\(\[data-view=["']chat["']\]\):not\(\[data-view=["']agents["']\]\):not\(\[data-view=["']equipo["']\]\)\s*\{\s*grid-template-columns:\s*232px 1fr/.test(
      css,
    ),
    'la regla del recorte del rail excluye chat, agentes y equipo',
  );
  ok(
    /\.app\.compact:not\(\[data-view=["']chat["']\]\):not\(\[data-view=["']agents["']\]\):not\(\[data-view=["']equipo["']\]\)\s*\{\s*grid-template-columns:\s*78px 1fr/.test(
      css,
    ),
    'el compacto debe mandar sobre el recorte del rail en las vistas sin rail',
  );
});

/* ---------- guardas de integración (regresiones de la auditoría) ---------- */

test('integración: cada método sagitari.* del renderer existe en el preload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const renderer = readRenderer();
  const exposed = new Set([...preload.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...renderer.matchAll(/sagitari\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !exposed.has(k));
  eq(missing.join(', '), '', 'métodos usados por el renderer pero ausentes del preload');
});

test('integración: cada canal invocado en el preload tiene handler en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  // Fase 4: los handlers viven repartidos entre main.js y los routers main/ipc-*.js.
  const main = fs
    .readdirSync(path.join(__dirname, '..', 'main'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'main', f), 'utf8'))
    .join('\n');
  const channels = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  const handlers = new Set([...main.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));
  const missing = [...new Set(channels)].filter((c) => !handlers.has(c));
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
  // Y dos cosas, las dos antes del bloqueo: la CARPETA del perfil de pruebas tiene
  // que existir (Chromium crea el fichero del bloqueo antes que el userData, así que
  // un perfil que aún no existe hacía fallar el bloqueo y la app decía «ya está
  // abierta» sin que hubiera ninguna) y el userData tiene que apuntar ahí.
  const iHeadless = MAIN_SRC.indexOf('if (HEADLESS) {');
  const iMkdir = MAIN_SRC.indexOf('fs.mkdirSync(PERFIL', iHeadless);
  const iSeteo = MAIN_SRC.indexOf("app.setPath('userData'", iHeadless);
  const iLock = MAIN_SRC.indexOf('app.requestSingleInstanceLock()');
  ok(iMkdir > -1 && iSeteo > -1, 'HEADLESS debe crear la carpeta y fijar su propio userData');
  ok(iHeadless < iMkdir && iMkdir < iSeteo, 'la carpeta del perfil se crea antes de fijar el userData');
  ok(iSeteo < iLock, 'el userData de prueba se fija ANTES de pedir el bloqueo');
});

test('arranque: la segunda instancia no muere en silencio y reutiliza la ventana', () => {
  ok(
    /app\.on\('second-instance',\s*\(\)\s*=>\s*showWindow\(\)\)/.test(MAIN_SRC),
    'debe atender second-instance mostrando la ventana existente',
  );
  ok(/ya está abierta/.test(MAIN_SRC), 'debe avisar por consola de que ya había una instancia abierta');
  // showWindow vive en main/ventana.js (la fábrica de la ventana), no en main.js
  const ventana = fs.readFileSync(path.join(__dirname, '..', 'main', 'ventana.js'), 'utf8');
  ok(/function showWindow\(\)[\s\S]{0,200}?createChatWindow\(\)/.test(ventana), 'showWindow debe recrear la ventana si ya no existe');
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
  for (const v of ['--acc-rgb', '--acc2-rgb', '--acc3-rgb', '--glow-rgb', '--glow-str']) ok(css.includes(v + ':'), 'debe declarar ' + v);
  /* La luz escala con la intensidad del ajuste. El contrato es del FILO —el pulso ya no
     barre la ventana, así que los tonos a/b/c quedan como paleta del vidrio—: si el nivel
     de los filos dejara de multiplicar por --glow-str, la preferencia del usuario no se
     notaría en la luz. Se comprueba el contrato, no una regla suelta. */
  ok(
    /opacity: calc\(var\(--rim[^)]*\) \* var\(--glow-str/.test(css),
    'el nivel de los filos debe multiplicar por --glow-str',
  );
  ok(
    /rgba\(var\(--rim-rgb\), calc\(0\.95 \* var\(--glow-str, 1\)\)\)/.test(css),
    'el recorrido del filo también escala con la intensidad',
  );
  ok(/--ambient/.test(css), 'la atmósfera del fondo también debe seguir al estado');
  ok(
    (css.match(/rgba\(var\(--acc/g) || []).length >= 40,
    'los tintes decorativos deben usar los triplets (' + (css.match(/rgba\(var\(--acc/g) || []).length + ')',
  );
  // los modos conservan su color aunque cambie el acento (el formateo del triplet
  // no cuenta: la comprobación es del valor, no de los espacios de Prettier)
  ok(/#view-chat\[data-mode=["']plan["']\]\s*\{[^}]*167,\s*139,\s*250/.test(css), 'PLAN mantiene su violeta');
  ok(/#view-chat\[data-mode=["']think["']\]\s*\{[^}]*125,\s*180,\s*255/.test(css), 'THINK mantiene su azul');
  ok(/#view-chat,\s*#view-chat\[data-mode=["']act["']\]/.test(css), 'ACT mantiene su verde');
  /* Glow «borde vivo»: la luz es el FILO de las superficies que trabajan, no una banda
     alrededor de la ventana. Cada estado escribe SUS niveles y cada superficie lee el
     suyo; el dibujo es común y multiplica por `--glow-str`, así que la preferencia del
     usuario se nota en el filo y no sólo en el slider. Se comprueba el contrato, no un
     selector concreto. */
  for (const estado of ['think', 'work', 'pulse']) {
    ok(
      new RegExp('\\.shell\\.glow-' + estado + '\\s*\\{[^}]*--live-window').test(css),
      'el estado ' + estado + ' debe declarar sus niveles de luz',
    );
  }
  for (const nivel of ['--live-window', '--live-side', '--live-com', '--live-rail'])
    ok(css.includes(nivel + ':'), 'falta el nivel ' + nivel + ' (una superficie sin el suyo no se enciende)');
  ok(
    /opacity:\s*calc\(var\(--rim[^)]*\)\s*\*\s*var\(--glow-str/.test(css),
    'el filo es el glow: su nivel tiene que multiplicarse por la intensidad del ajuste',
  );
  ok(
    /\.filo,[\s\S]{0,80}?\.shell \.rcard\s*\{[^}]*overflow:\s*hidden/.test(css),
    'la superficie del recorrido tiene que recortarlo (si no, la barra asoma fuera al aparecer)',
  );
  /* El aura vieja NO puede volver: era una banda de 70px con tres halos girando, y cada
     frame volvía a rasterizar el degradado del filo. Medido en la 4.2: el movimiento
     permanente era el único coste constante de la página. */
  ok(!/glowFlow|halo-[abc]/.test(css), 'el aura de halos girando no vuelve');
  ok(!/@keyframes (giro|reachLife|frame-bloom)/.test(css), 'ni sus keyframes');
  ok(!/@property --(giro|reach)\b/.test(css), 'ni las propiedades registradas que la movían');
  ok(!/offset-path/.test(css), 'el glow no recorre el marco');
  ok(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,900}?\.filo::after[\s\S]{0,200}?animation:\s*none/.test(css),
    'el movimiento reducido debe quitar el recorrido del filo',
  );
  /* Sin foco no hay luz: la ventana de fondo no se ilumina. El pulso sí (su atajo es
     global: existe justo para cuando NO estás mirando). */
  ok(
    /body\.nofocus \.shell\s*\{[^}]*--live-window:\s*0/.test(css) &&
      /body\.nofocus \.shell\.glow-pulse\s*\{[^}]*--live-window:\s*1/.test(css),
    'sin foco el filo se apaga, salvo el pulso',
  );
  ok(/input\[type=["']range["']\]\.glowslider/.test(css), 'debe existir el estilo del slider de intensidad');
});

test('apariencia: la muestra del color de glow es una muestra, no una capa de la ventana', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const muestra = css.match(/\.colordot\.glow\s*\{([^}]*)\}/);
  ok(muestra, 'debe existir una regla específica para la muestra del glow');
  ok(/rgb\(var\(--glow-rgb\)\)/.test(muestra[1]), 'la muestra enseña el color de glow elegido');
  /* Un `inset` en la muestra la estiraba hasta cubrir la ventana con el color del glow
     (pasó): la muestra ocupa lo que ocupa su punto de color, nada más. */
  ok(!/position:\s*(fixed|absolute)/.test(muestra[1]), 'la muestra no puede salirse de su sitio');
  ok(!/inset:\s*0/.test(muestra[1]), 'ni cubrir la ventana');
});

test('apariencia: Ajustes expone color de UI, color de glow e intensidad', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of [
    'uiColor',
    'glowColor',
    'glowStrength',
    'dotUiColor',
    'dotGlowColor',
    'glowStrengthLabel',
    'glassTint',
    'glassTintLabel',
  ])
    ok(html.includes('id="' + id + '"'), 'falta #' + id);
  /* La tarjeta existe y está marcada con su clave; el título en castellano es el del
     diccionario (así la prueba no se ata a la prosa del marcado). */
  const dictEs = require('../renderer/i18n-es');
  ok(/<b[^>]*data-i18n="ajustes\.apariencia\.titulo"/.test(html), 'debe existir la tarjeta Apariencia');
  eq(dictEs['ajustes.apariencia.titulo'], 'Apariencia', 'y su título dice «Apariencia» en castellano');
  const app = readRenderer();
  ok(/const PALETTES = \{[\s\S]{0,1400}\};/.test(app), 'debe existir la tabla PALETTES');
  ok(/function applyTheme\(\)/.test(app), 'debe existir applyTheme');
  ok(/\$\('#glowStrength'\)\.oninput/.test(app) && /\$\('#uiColor'\)\.onchange/.test(app), 'los controles deben estar cableados');
  // tema Aurora: interfaz sobria + espectro en el filo de las superficies
  ok(/aurora:\s*\{ label: 'Aurora'/.test(app), 'PALETTES debe traer aurora');
  ok(/AURORA_GLOW/.test(app), 'el espectro del glow aurora debe estar definido');
  ok(html.includes('value="aurora"'), 'los selects deben ofrecer aurora');
  /* El espectro vive en los tokens `--glow-a/b/c-rgb`, que escriben `applyTheme` y que
     consume el RECORRIDO del filo (y el pulso). Ya no hay capa `.glow` que los pinte:
     si el espectro dejara de escribirse, el recorrido se quedaría de un solo tono. */
  ok(
    /AURORA_GLOW = \{ a: \[141, 159, 255\], b: \[255, 103, 120\], c: \[255, 186, 113\] \}/.test(app),
    'AURORA_GLOW reparte azul, rosa y naranja',
  );
  ok(/auroraGlow \? AURORA_GLOW\.a/.test(app), 'applyTheme vuelca el espectro aurora en el glow');
  const cssAurora = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  // El pulso enciende TODOS los filos a la vez con el mismo dibujo que laterales e
  // inferior: sin veta que cruce la parte superior (el barrido se retiró a petición).
  ok(
    /\.shell\.glow-pulse\s*\{\s*--ambient: 1;[\s\S]{0,220}?--live-rail: 1;/.test(cssAurora),
    'el pulso enciende todos los filos a la vez',
  );
  ok(!/\.shell\.glow-pulse[^{]*::after/.test(cssAurora), 'el pulso no barre la parte superior: la luz es el filo');
  ok(!/\.shell\.glow-aurora/.test(cssAurora), 'la capa del aura aurora ya no existe: el filo es la luz');
  // tricolor real: los 3 tonos nacen a ±42º del elegido (no vecinos), para que
  // se distingan a la vez en vez de fundirse en un solo color
  ok(/_rgb\(gh \+ 42/.test(app) && /_rgb\(gh - 42/.test(app), 'los 3 tonos del glow deben nacer separados ±42º');
  // reequilibrio: acentos calmados y glow suave por defecto (que acaricie, no que invada)
  ok(/Number\(s\.glowStrength\) \|\| 0\.7/.test(app), 'el glow por defecto debe ser suave (0.7)');
  /* Y aplicar dos veces el MISMO estado no puede rehacer nada: el proceso principal emite
     `work` en CADA herramienta del turno, así que sin esta guarda el recorrido volvía a
     empezar y el filo se hundía un momento en cada paso (el parpadeo al aparecer). */
  ok(/if \(pedido === actual && pedido !== 'pulse'\) return;/.test(app), 'el mismo estado repetido no debe reiniciar el recorrido');
  // la rueda sobre el menú abierto (o sus sliders vecinos) no lo cierra: solo
  // se cierra si se desplaza algo FUERA de él (el menú es fixed y quedaría descolgado)
  ok(/cselAbierto\.menu\.contains\(e\.target\)/.test(app), 'el scroll dentro del menú no debe cerrarlo');
  ok(/onThemeChanged/.test(app), 'los cambios de tema deben aplicarse al vuelo');
});

test('apariencia: main guarda preferencias y emite theme:changed', () => {
  ok(/uiColor: 'aurora'/.test(MAIN_SRC) && /glowStrength: 1/.test(MAIN_SRC), 'defaults de apariencia en settings');
  ok(/glowColor: 'match'/.test(MAIN_SRC), 'el glow sigue al tema por defecto');
  ok(/theme:changed/.test(MAIN_ALL), 'los cambios de apariencia deben broadcastearse');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/onThemeChanged/.test(preload), 'preload debe exponer onThemeChanged');
});

test('apariencia: el tinte de vidrio repinta sin encender el glow', () => {
  // El acuse del marco (glow('pulse')) enciende el filo entero —el mismo de laterales e
  // inferior— porque cambió LA LUZ. El vidrio tiñe los paneles (theme:changed lo repinta)
  // y no debe encender el marco. La veta que cruzaba la parte superior ya no existe: el
  // pulso es luz de filo, no barrido.
  const cfgmod = require(path.join(__dirname, '..', 'main', 'ipc-config'));
  const handlers = {};
  const fakeIpc = {
    handle: (name, fn) => {
      handlers[name] = fn;
    },
  };
  const cfgObj = {
    settings: { uiColor: 'aurora', glowColor: 'match', glowStrength: 1, glassTint: 1, glowEnabled: true },
    providers: [],
    active: null,
  };
  const pulsos = [];
  cfgmod.registerConfigIpc(fakeIpc, {
    config: () => cfgObj,
    persistConfig: () => ({ ok: true }),
    glow: (mode) => pulsos.push(mode),
    getWin: () => null,
    isHidden: () => false,
    PRESETS: [],
    listModels: async () => [],
  });
  handlers['settings:set'](null, { glassTint: 0.9 });
  ok(pulsos.filter((m) => m === 'pulse').length === 0, 'mover el tinte de vidrio no debe destellar el glow');
  handlers['settings:set'](null, { glassTint: 1.1 });
  ok(pulsos.filter((m) => m === 'pulse').length === 0, 'ningún tinte, ninguna Excusa: el marco no cambia');
  handlers['settings:set'](null, { glowStrength: 0.7 });
  ok(pulsos.filter((m) => m === 'pulse').length === 1, 'cambiar la intensidad enciende el marco (sin barrido)');
  handlers['settings:set'](null, { uiColor: 'ice' });
  ok(pulsos.filter((m) => m === 'pulse').length === 2, 'cambiar el color de interfaz también acusa');
  ok(cfgObj.settings.glassTint === 1.1, 'el tinte se guarda igual (solo cambia el acuse)');
  /* El aspecto (Holo / Consola / Lienzo) se guarda por el mismo canal: si no estuviera en
     la lista blanca, elegir Consola no sobreviviría a cerrar la app. */
  handlers['settings:set'](null, { uiSkin: 'console' });
  ok(cfgObj.settings.uiSkin === 'console', 'el aspecto elegido se guarda (clave permitida)');
  handlers['settings:set'](null, { uiSkin: 'no-existe' });
  ok(cfgObj.settings.uiSkin === 'console', 'y un valor inventado no pisa el guardado');
});

/* ---------- adjuntos del chat: archivos, documentos e imágenes ---------- */

test('adjuntos: main delega en el módulo de adjuntos y conserva los metadatos', () => {
  const main = MAIN_ALL; // Fase 4: los handlers viven en main/ipc-chat.js
  ok(/attachments:pick/.test(main) && /attachments:read/.test(main), 'faltan los handlers IPC de adjuntos');
  // Los límites, las listas de extensiones y el bloque de texto viven ahora en
  // main/attachments.js y se prueban por COMPORTAMIENTO (ver «adjuntos: tipo,
  // texto, recorte y ruta prohibida»): aquí solo el cableado y que no se dupliquen.
  ok(/require\('\.\/attachments'\)/.test(MAIN_SRC), 'main debe usar main/attachments.js');
  ok(
    /attach\.kindOf\(/.test(main) && /attach\.textOf\(/.test(main) && /attach\.blocksFor\(/.test(main),
    'la lectura y el volcado al mensaje pasan por el módulo',
  );
  ok(
    !/const MAX_FILE_BYTES/.test(MAIN_SRC) && !/const TEXT_EXTS/.test(MAIN_SRC),
    'los límites y las listas no pueden duplicarse en main.js',
  );
  // el mensaje guardado conserva metadatos de adjuntos (miniaturas al recargar)
  ok(/attachments: attMeta/.test(main), 'los metadatos de adjuntos deben guardarse en la conversación');
  // el body por defecto con imagen pero sin texto sigue funcionando
  ok(/\(análisis de imagen\)/.test(main), 'imagen sola debe tener texto por defecto');
});

test('adjuntos: el agente acepta varias imágenes y retry las conserva', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
  ok(/const imgUrls = \[imageDataUrl, \.\.\.extraImgs\]/.test(agent), 'debe combinar la imagen principal con los adjuntos');
  // el encadenado se lee igual con o sin los saltos de línea que mete Prettier
  ok(
    /const images = parts[\s\S]{0,40}?\.filter\([\s\S]{0,40}?\.type === 'image_url'[\s\S]{0,40}?\.map/.test(agent),
    'retry debe recuperar TODAS las imágenes',
  );
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
  ok(
    /pendingAttachments\.slice\(\)/.test(app) && /sendChat\(hiloActual\(\), text, null, atts/.test(app),
    'envío debe incluir los adjuntos',
  );
  const icons = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
  ok(/ {2}clip: /.test(icons) && / {2}x: /.test(icons), 'faltan los iconos clip y x');
  // integración preload↔renderer (mismo guardián que el resto)
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/attachmentsPick/.test(preload) && /attachmentsRead/.test(preload), 'preload debe exponer los canales de adjuntos');
});

/* ---------- icono: Windows no pinta entradas PNG pequeñas dentro del .ico ---------- */
const pngOps = require('../scripts/png-ops');

test('ico: los tamaños pequeños van en BMP y los grandes en PNG', () => {
  eq(ico.PNG_MIN_SIZE, 128, 'a partir de aquí la entrada es PNG');
  eq(ico.DEFAULT_SIZES.join(','), '256,128,64,48,32,16', 'los tamaños que lleva el icono');
  const entries = ico.DEFAULT_SIZES.map((s) => ({
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
  rgba[0] = 10;
  rgba[1] = 20;
  rgba[2] = 30;
  rgba[3] = 40; // píxel de la esquina SUPERIOR izquierda
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
  const yml =
    'version: 9.9.9\npath: SAGITARI-Setup-9.9.9.exe\nsha512: HASH_SETUP\nfiles:\n  - url: SAGITARI-Setup-9.9.9.exe\n    sha512: HASH_SETUP\n';
  const parsed = updater.parseLatestYml(yml);
  eq(updater.sha512For(parsed, 'SAGITARI-Setup-9.9.9.exe'), 'HASH_SETUP', 'el Setup usa su hash');
  eq(
    updater.sha512For(parsed, 'SAGITARI-Portable-9.9.9.exe'),
    null,
    'el portable NO hereda el hash del Setup: esa comparación hacía imposible actualizarlo',
  );
  // Si el yml sí publica el hash de cada archivo, cada uno usa el suyo
  const both = updater.parseLatestYml(
    'version: 1\npath: Setup.exe\nsha512: HASH_SETUP\nfiles:\n  - url: Setup.exe\n    sha512: HASH_SETUP\n  - url: Portable.exe\n    sha512: HASH_PORTABLE\n',
  );
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
  const basura = Buffer.alloc(400, 0x01); // 400 bytes de control: no es texto
  eq(attach.textOf(basura, 'a.txt'), null, 'lo que no es texto se degrada a binario');
  // los subtítulos se limpian (números de secuencia y flechas)
  const srt = attach.textOf(
    Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nHola, ¿qué tal?\n2\n00:00:03,000 --> 00:00:04,500\nTodo bien por aquí, gracias.\n',
      'utf8',
    ),
    'a.srt',
  );
  ok(srt && srt.includes('Hola') && !srt.includes('-->'), srt);
  ok(srt && !/^\d+$/m.test(srt), 'los números de secuencia se quitan: ' + srt);
  // recorte al techo real, y queda dicho
  const largo = attach.blockFor({ name: 'g.txt', size: 2048, text: 'x'.repeat(attach.MAX_ATTACH_CHARS + 10) });
  ok(largo.includes('2 KB'), 'el bloque dice el tamaño');
  ok(largo.endsWith('… (truncado)'), 'el recorte se anuncia');
  ok(largo.length < attach.MAX_ATTACH_CHARS + 200, 'no se cuela el texto entero');
  eq(attach.blockFor({ name: 'c.txt', size: 10, text: 'corto' }).includes('truncado'), false);
  // dos adjuntos → dos bloques
  eq(
    attach
      .blocksFor([
        { name: 'a', size: 1, text: 'uno' },
        { name: 'b', size: 1, text: 'dos' },
      ])
      .split('--- ARCHIVO ADJUNTO').length - 1,
    2,
  );
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

/* Monta el router de chat con el módulo REAL de adjuntos para mirar los dos lados del
   turno: lo que viaja al modelo (`enviado`) y lo que se escribe en conversations.json. */
function montarChatConAdjuntos({ configDir: dirDatos, rutaConvs }) {
  const { registerChatIpc } = require('../main/ipc-chat');
  const attach = require('../main/attachments');
  const handlers = {};
  const conv = { id: 'c1', title: 'Prueba', messages: [], updatedAt: 0 };
  const visto = { enviado: null };
  registerChatIpc(
    { handle: (n, f) => (handlers[n] = f) },
    {
      config: () => ({ settings: {} }),
      runtimes: {
        agentFor: () => ({
          chat: async (body) => {
            visto.enviado = body;
          },
          isBusy: () => false,
        }),
      },
      convsApi: {
        convById: () => conv,
        currentConv: () => conv,
        ensureConv: () => conv,
        saveConvs: () => fs.writeFileSync(rutaConvs, JSON.stringify({ convs: [conv] })),
      },
      getSkills: () => ({ getSkill: async () => null }),
      getGlow: () => () => {},
      getWin: () => null,
      configDir: () => dirDatos,
      onError: () => {},
      dialog: {},
      fsp: fs.promises,
      fs,
      path,
      attach,
    },
  );
  return { handlers, conv, visto };
}

test('adjuntos: el historial guarda la ficha del adjunto, no su texto completo', async () => {
  const dir = tmpDir('sagi-adj-hist-');
  const { handlers, conv, visto } = montarChatConAdjuntos({ configDir: dir, rutaConvs: path.join(dir, 'conversations.json') });
  // Un adjunto por encima del tope por archivo: antes se guardaba el volcado entero
  // (hasta MAX_ADJUNTOS_CHARS) dentro del mensaje del usuario.
  const relleno = 'SECRETO-DEL-ADJUNTO '.repeat(6000);
  await handlers['chat:send'](null, {
    convId: 'c1',
    text: 'resume esto',
    attachments: [{ name: 'notas.txt', kind: 'text', size: relleno.length, text: relleno }],
  });
  // El turno no cambia: el modelo sigue viendo el texto del archivo.
  ok(visto.enviado.includes('SECRETO-DEL-ADJUNTO'), 'el mensaje del turno lleva el texto del adjunto');
  // Lo que se escribe en disco, sí: solo la frase del usuario y la ficha.
  const enDisco = fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8');
  ok(!enDisco.includes('SECRETO-DEL-ADJUNTO'), 'conversations.json no puede llevar el texto del adjunto');
  ok(enDisco.length < 2000, 'el fichero se queda en la ficha (van ' + enDisco.length + ' bytes, el volcado son ' + relleno.length + ')');
  const guardado = conv.messages[conv.messages.length - 1];
  ok(guardado.content.includes('resume esto'), 'la frase del usuario sí se guarda');
  ok(guardado.content.includes('notas.txt'), 'y la ficha del adjunto, con su nombre');
  eq(guardado.attachments.length, 1, 'los metadatos del adjunto siguen ahí (la tarjeta al reabrir)');
  // El renderer recorta la ficha al repintar con esta misma expresión (renderer/40-vistas.js):
  // si la ficha guardada no empezara por el marcador, la burbuja la enseñaría como prosa.
  const pintado = guardado.content.replace(/He adjuntado archivos para que los uses en tu respuesta:\n\n[\s\S]*$/, '').trim();
  eq(pintado, 'resume esto', 'al reabrir, la burbuja enseña la frase y no la ficha');
});

test('adjuntos: al directorio de datos no se llega por un junction', async () => {
  const dir = tmpDir('sagi-adj-junction-');
  const datos = path.join(dir, 'datos');
  const enlace = path.join(dir, 'enlace');
  fs.mkdirSync(datos, { recursive: true });
  fs.writeFileSync(path.join(datos, 'config.json'), '{"apiKey":"sk-secreta"}');
  let hayJunction = true;
  try {
    fs.symlinkSync(datos, enlace, 'junction');
  } catch (e) {
    // Sin permisos para crear el enlace no se puede probar el caso real: se dice y se sigue.
    hayJunction = false;
    console.log('  (junction no disponible aquí: ' + e.message + ')');
  }
  // El directorio de datos se declara por el ENLACE (sin resolver), como cuando la carpeta
  // del perfil está redirigida: ahí `configDir()` y el realpath del fichero no coinciden.
  const { handlers } = montarChatConAdjuntos({ configDir: enlace, rutaConvs: path.join(dir, 'conversations.json') });
  if (hayJunction) {
    const porEnlace = await handlers['attachments:read'](null, path.join(enlace, 'config.json'));
    eq(porEnlace.ok, false, 'el config.json al que se llega por el junction no se puede adjuntar');
    eq(porEnlace.error, 'ruta no permitida', 'y se rechaza por la guarda de rutas, no por otra cosa');
    const porReal = await handlers['attachments:read'](null, path.join(datos, 'config.json'));
    eq(porReal.ok, false, 'tampoco por la ruta real (misma carpeta de datos)');
  }
  // Un fichero de fuera sigue leyéndose: la guarda no se ha vuelto un muro.
  const ajeno = path.join(dir, 'apunte.txt');
  fs.writeFileSync(ajeno, 'hola');
  const fuera = await handlers['attachments:read'](null, ajeno);
  eq(fuera.ok, true, 'un fichero de fuera se sigue pudiendo adjuntar');
});

test('icono incluido: BMP en los tamaños pequeños (o Windows cae al icono genérico)', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'));
  const icons = ico.parseIco(buf);
  eq(icons.map((e) => e.size).join(','), ico.DEFAULT_SIZES.join(','), 'el icono debe traer los tamaños esperados');
  for (const e of icons) {
    if (e.size >= ico.PNG_MIN_SIZE) eq(e.format, 'png', e.size + 'px debe ir como PNG');
    else
      eq(
        e.format,
        'bmp',
        e.size +
          'px debe ir como BMP: el shell de Windows no pinta PNG por debajo de ' +
          ico.PNG_MIN_SIZE +
          'px y acaba mostrando el icono genérico del ejecutable',
      );
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
  const small = icons.find((e) => e.format === 'bmp');
  ok(small, 'debe haber al menos una entrada BMP');
  eq(small.dib.biHeight, small.size * 2, 'biHeight del mapa XOR+AND');
  eq(small.dib.biSizeImage, small.size * small.size * 4 + ico.maskRowBytes(small.size) * small.size, 'biSizeImage');
});

test('png-ops se puede importar sin ejecutar el pipeline', () => {
  // el pipeline lee y escribe ficheros: al importarlo solo debe exponer el toolkit
  ok(typeof pngOps.decodePNG === 'function' && typeof pngOps.encodePNG === 'function', 'debe exponer el toolkit');
});

/* ---------- memoria: aprender de la conversación al cerrar el turno ---------- */

/* El gancho de aprendizaje vive en el router de chat y no en el agente porque es el
   ÚNICO sitio que ve a la vez la frase del usuario, el hilo del que salió y los ajustes
   vivos. Estas pruebas montan el router con dobles (ipcMain, ventana y almacén) para
   comprobar lo que de verdad importa: CUÁNDO se llama, con QUÉ y que nada de esto pueda
   tumbar un turno que ya terminó bien. */
function montarRouterChat({ settings, proponerDeTurno, onError }) {
  const { registerChatIpc } = require('../main/ipc-chat');
  const handlers = {};
  const fakeIpc = {
    handle: (name, fn) => {
      handlers[name] = fn;
    },
  };
  const cfgObj = { settings: { ...settings } };
  /* El hilo ya tiene un mensaje y su título: con el hilo vacío el router estrena el
     título con la primera frase (comportamiento correcto) y la prueba de la procedencia
     mediría otra cosa. */
  const conv = { id: 'c1', title: 'Vuelos a Tánger', messages: [{ role: 'user', content: 'hola' }], updatedAt: 0 };
  registerChatIpc(fakeIpc, {
    config: () => cfgObj,
    runtimes: { agentFor: () => ({ chat: async () => {}, isBusy: () => false }) },
    convsApi: { convById: () => conv, currentConv: () => conv, ensureConv: () => conv, saveConvs: () => {} },
    getSkills: () => ({ getSkill: async () => null }),
    getGlow: () => () => {},
    getWin: () => null,
    configDir: () => tmpDir('sagi-chatdir-'),
    onError: onError || (() => {}),
    dialog: {},
    fsp: {},
    fs,
    path,
    attach: { blocksFor: () => '' },
    memory: () => ({ proponerDeTurno }),
  });
  return { handlers, cfgObj };
}

test('memoria: al cerrar el turno se le pasa la frase del usuario al almacén', async () => {
  const llamadas = [];
  const { handlers, cfgObj } = montarRouterChat({
    settings: { memoryLearn: true, memoryAutoSave: false },
    proponerDeTurno: (texto, opts) => {
      llamadas.push({ texto, opts });
      return [];
    },
  });
  await handlers['chat:send'](null, { convId: 'c1', text: 'Me llamo Darío', attachments: [] });
  await wait(5);
  eq(llamadas.length, 1, 'un cierre de turno → una extracción');
  eq(llamadas[0].texto, 'Me llamo Darío', 'se extrae lo que dijo el usuario, no el prompt montado');
  eq(llamadas[0].opts.convId, 'c1', 'la propuesta sabe de qué conversación salió');
  eq(llamadas[0].opts.convTitulo, 'Vuelos a Tánger', 'y de qué hilo, para poder auditarla');
  eq(llamadas[0].opts.autoGuardar, false, 'por defecto se propone y espera aprobación');

  cfgObj.settings.memoryAutoSave = true;
  await handlers['chat:send'](null, { convId: 'c1', text: 'Prefiero el trato directo', attachments: [] });
  await wait(5);
  eq(llamadas.length, 2, 'el segundo turno también aprende');
  eq(llamadas[1].opts.autoGuardar, true, 'con «guardar sin preguntar» el almacén acepta solo');
});

test('memoria: con el interruptor apagado no se propone nada', async () => {
  const llamadas = [];
  const { handlers } = montarRouterChat({
    settings: { memoryLearn: false },
    proponerDeTurno: (...a) => llamadas.push(a),
  });
  await handlers['chat:send'](null, { convId: 'c1', text: 'Me llamo Darío', attachments: [] });
  await wait(5);
  eq(llamadas.length, 0, 'apagado no es «menos»: es nada');
});

test('memoria: un fallo del almacén no tumba el turno de chat', async () => {
  const errores = [];
  const { handlers } = montarRouterChat({
    settings: { memoryLearn: true },
    proponerDeTurno: () => {
      throw new Error('almacén roto');
    },
    onError: (k, err) => errores.push([k, err && err.message]),
  });
  const r = await handlers['chat:send'](null, { convId: 'c1', text: 'Me llamo Darío', attachments: [] });
  await wait(5);
  eq(r.ok, true, 'el turno sigue siendo un éxito');
  eq(errores.length, 1, 'el fallo se registra donde se ven todos los demás');
  eq(errores[0][0], 'memory:proponer', 'con su etiqueta propia, para poder buscarlo');
});

/* ---------- órdenes de barra: /cost no espera al turno ---------- */

/* `/cost` solo LEE el gasto; `/compact` reescribe el contexto y por eso no puede correr
   con un turno en vuelo. La guarda de «trabajando» estaba delante de las dos, así que
   preguntar el gasto DURANTE un turno —cuando más apetece— rechazaba la orden. */
test('chat:command: /cost responde con un turno en marcha; /compact sigue esperando', async () => {
  const { registerChatIpc } = require('../main/ipc-chat');
  const handlers = {};
  const conv = { id: 'c1', title: 'Gasto', messages: [{ role: 'user', content: 'hola' }], updatedAt: 0 };
  let compactado = 0;
  const agente = {
    isBusy: () => true,
    usageResumen: () => ({ turns: 2, tokens: 12345, costUsd: 0.05 }),
    compact: async () => {
      compactado++;
      return { ok: true, antes: 2, despues: 1 };
    },
  };
  registerChatIpc(
    { handle: (n, f) => (handlers[n] = f) },
    {
      config: () => ({ settings: {} }),
      runtimes: { agentFor: () => agente },
      convsApi: { convById: () => conv, currentConv: () => conv, ensureConv: () => conv, saveConvs: () => {} },
      getSkills: () => ({ getSkill: async () => null }),
      getGlow: () => () => {},
      getWin: () => null,
      configDir: () => tmpDir('sagi-cost-'),
      onError: () => {},
      dialog: {},
      fsp: {},
      fs,
      path,
      attach: { blocksFor: () => '' },
    },
  );
  const cost = await handlers['chat:command'](null, { convId: 'c1', name: 'cost' });
  eq(cost.ok, true, 'el gasto se puede preguntar mientras trabaja: ' + JSON.stringify(cost));
  ok(cost.text.includes('12.345 tokens'), 'y trae la cuenta: ' + cost.text);
  const compact = await handlers['chat:command'](null, { convId: 'c1', name: 'compact' });
  eq(compact.ok, false, 'compactar con un turno en vuelo sigue rechazándose');
  eq(compactado, 0, 'sin compactar nada a medias');
});

/* ---------- consentimiento: la puerta de permisos se ve desde CUALQUIER vista ----------
   El agente pide permiso mientras el usuario puede estar en Tareas, Herramientas o
   Ajustes. La barra vivía dentro de #view-chat: fuera de esa vista no se veía y el
   turno se quedaba esperando a que el usuario adivinara dónde mirar. */
test('consentimiento: la barra de permiso es global y enseña el literal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const app = readRenderer();

  const chat = html.slice(html.indexOf('id="view-chat"'), html.indexOf('</main>'));
  ok(!/id="confirmBar"/.test(chat), 'la barra de permiso NO puede vivir dentro de la vista Chat');
  ok(/id="confirmBar"/.test(html), 'y tiene que existir en el shell');
  ok(/id="confirmCmd"/.test(html), 'el literal necesita su propio sitio (#confirmCmd)');
  ok(/\.confirmbar\s*\{[\s\S]{0,420}?position:\s*fixed/.test(css), 'la barra es un overlay fijo: se ve desde cualquier vista');
  ok(!/\.confirmbar \.cb-txt small\s*\{[^}]*-webkit-line-clamp/.test(css), 'el detalle no puede recortarse a 3 líneas');
  ok(/\.cb-cmd\s*\{[\s\S]{0,420}?font-family:\s*var\(--font-mono\)/.test(css), 'el literal va en monoespaciado');
  ok(/const literal = ev\.summary/.test(app), 'paintConfirm pinta el literal del permiso');
  ok(!/slice\(0, 240\)/.test(app), 'el literal no se corta a 240 caracteres');
  /* La animación de entrada no puede descolocar el centrado (translateX). */
  ok(/@keyframes cbIn\s*\{[\s\S]{0,200}?transform:\s*translate\(-50%/.test(css), 'cbIn conserva el translateX del centrado');
});

/* La fila del glow repetía los 7 nombres del tema justo debajo: 15 chips seguidos
   con el riesgo de teñir la fila equivocada. Por defecto sólo hay 7 + 2. */
test('apariencia: la fila del glow no repite los 7 nombres del tema', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const app = readRenderer();
  ok(/id="glowOtherBtn"/.test(html), 'la fila del glow ofrece «Otro color…»');
  ok(
    /#glowColorTiles:not\(\.open\) \.pal\[data-pal\]:not\(\[data-pal='match'\]\)\s*\{[^}]*display:\s*none/.test(css),
    'los 7 colores se esconden mientras el glow sigue al tema',
  );
  ok(/function syncGlowTiles/.test(app) && /box\.classList\.toggle\('open'/.test(app), 'syncGlowTiles abre y cierra la fila');
  /* «Otro color…» no lleva data-pal: el manejador genérico de .pal no debe
     escribir un valor vacío en el select del ajuste. */
  ok(/if \(!b\.dataset\.pal\) return;/.test(app), 'el chip «Otro color…» no escribe en el select');
});


/* ---------- memoria v2: prefijos, valores con detalle y fallos de disco ---------- */

/* El hecho llega con ruido de conversación («Recuerda que…»). Comparar el texto tal cual
   dejaba vivos el hecho y su contrario, y los dos viajaban al prompt. */
test('memoria: el prefijo conversacional no esconde el hecho ni su contradicción', () => {
  const v2 = require('../agent/memoria-v2');
  const clave = v2.claveHecho('Recuerda que no me gusta el té');
  ok(clave, 'el prefijo es ruido, no parte del hecho');
  eq(clave.pred, 'gusto', 'es un gusto');
  eq(clave.negado, true, 'y está negado');
  eq(
    v2.relacionHechos('me gusta el té', 'Recuerda que no me gusta el té'),
    'contradice',
    'son el mismo objeto con la polaridad invertida: no pueden convivir',
  );
  ok(v2.mismoHecho('me gusta el té', 'Recuerda que me gusta el té'), 'con la misma polaridad es el mismo dato');
});

/* «café con leche» aporta un detalle que el valor corto no tiene: fundirlos borraba
   «con leche» sin pasar por la papelera. Las stopwords de más sí son ruido. */
test('memoria: un valor con detalle no se funde con su versión recortada', () => {
  const v2 = require('../agent/memoria-v2');
  eq(
    v2.relacionHechos('me gusta el café con leche', 'me gusta el café'),
    'cambia',
    'lo que sobra no es relleno: son dos datos distintos',
  );
  ok(v2.mismoValor('los informes en PDF', 'informes en PDF'), '«los» es ruido y se ignora');
  ok(!v2.mismoValor('el café con leche', 'el café'), '«con leche» no es ruido');
});

/* save() devuelve false cuando el disco no acepta la escritura; las operaciones lo
   ignoraban y respondían OK igual (y el router borraba encima el perfil de hábitos). */
test('memoria: un guardado fallido no se canta como hecho ni como borrado', () => {
  const memory = require('../agent/memory');
  const { MEM_DIR } = require('./comun');
  const dir = tmpDir('sagi-mem-fallo-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  try {
    const hecho = memory.add({ text: 'Me gusta el café' });
    ok(hecho && hecho.id, 'con el disco sano el hecho se guarda');
    const id = hecho.id;
    memory.remove(id);
    const renameSync = fs.renameSync;
    fs.renameSync = () => {
      const e = new Error('fichero bloqueado');
      e.code = 'EPERM';
      throw e;
    };
    try {
      eq(memory.add({ text: 'Prefiero el té' }), null, 'add no puede devolver un hecho que no está en disco');
      ok(
        !memory.list().some((m) => m.text === 'Prefiero el té'),
        'y el hecho rechazado no puede quedarse en la memoria de la sesión: ' + JSON.stringify(memory.list().map((m) => m.text)),
      );
      eq(memory.remove(id).ok, false, 'remove no puede decir que borró');
      eq(memory.update(id, { importance: 0.9 }).ok, false, 'update tampoco');
      eq(memory.restore(id).ok, false, 'ni restore');
      eq(memory.trashEmpty().ok, false, 'ni vaciar la papelera');
      const r = memory.wipe();
      eq(r.ok, false, '«Olvídalo todo» no puede responder OK si el disco no lo guardó');
      ok(r.error, 'y explica el motivo');
      ok(
        memory.list().concat(memory.listTrash()).some((m) => m.id === id),
        'y la memoria EN RAM vuelve a lo que hay en el fichero (no se queda vacía): ' +
          JSON.stringify(memory.list().concat(memory.listTrash()).map((m) => m.text)),
      );
    } finally {
      fs.renameSync = renameSync;
    }
  } finally {
    memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
    memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
  }
});

/* «Olvídalo todo» promete hechos Y hábitos: si el guardado del borrado falla, el router
   no puede borrar el perfil (media promesa es peor que ninguna). */
test('memoria: si «olvídalo todo» no se guardó, el router no borra los hábitos', () => {
  const memory = require('../agent/memory');
  const { registerMemoryIpc } = require('../main/ipc-memory');
  const { MEM_DIR } = require('./comun');
  const dir = tmpDir('sagi-mem-router-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  try {
    memory.add({ text: 'Me gusta el café' });
    let resets = 0;
    const handlers = {};
    registerMemoryIpc(
      { handle: (canal, fn) => (handlers[canal] = fn) },
      {
        memory,
        habits: { reset: () => resets++, stats: () => ({}), olvidar: () => ({ ok: true }) },
        models: { summary: () => ({}) },
      },
    );
    const renameSync = fs.renameSync;
    fs.renameSync = () => {
      const e = new Error('fichero bloqueado');
      e.code = 'EPERM';
      throw e;
    };
    try {
      const r = handlers['memory:wipe']();
      eq(r.ok, false, 'el router devuelve el fallo del almacén');
      eq(resets, 0, 'y NO borra los hábitos: media promesa es peor que ninguna');
    } finally {
      fs.renameSync = renameSync;
    }
  } finally {
    memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
    memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
  }
});

/* La bandeja memoizaba un [] ante CUALQUIER error de lectura y el siguiente guardado
   escribía esa lista vacía: las propuestas pendientes desaparecían del fichero. */
test('memoria: una bandeja ilegible se pone en cuarentena y se reintenta', () => {
  const memory = require('../agent/memory');
  const { MEM_DIR } = require('./comun');
  const dir = tmpDir('sagi-mem-tray-');
  const tray = path.join(dir, 'memory-tray.json');
  memory.__test._resetTray(tray);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tray, '{ esto no es json', 'utf8');
    eq(memory.trayList().length, 0, 'lo ilegible no se puede contar como propuestas');
    const cuarentena = fs.readdirSync(dir).filter((f) => /^memory-tray\.corrupt-\d+\.json$/.test(f));
    eq(cuarentena.length, 1, 'el original se conserva aparte (como en habits), no se pierde');
    fs.writeFileSync(tray, JSON.stringify({ version: 2, propuestas: [{ id: 'p1', texto: 'Me llamo Darío', hash: 'h1' }] }), 'utf8');
    eq(memory.trayList().length, 1, 'la lectura se reintenta: el fallo no se memoiza como bandeja vacía');
  } finally {
    memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
  }
});

test('memoria: con la bandeja ilegible, una propuesta nueva no pisa el fichero', () => {
  const memory = require('../agent/memory');
  const { MEM_DIR } = require('./comun');
  const dir = tmpDir('sagi-mem-tray2-');
  const tray = path.join(dir, 'memory-tray.json');
  memory.__test._resetTray(tray);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const vieja = { version: 2, propuestas: [{ id: 'p0', texto: 'Prefiero el té', hash: 'h0' }] };
    fs.writeFileSync(tray, JSON.stringify(vieja), 'utf8');
    const readFileSync = fs.readFileSync;
    fs.readFileSync = (f, ...rest) => {
      if (String(f) === tray) {
        const e = new Error('ocupado');
        e.code = 'EBUSY';
        throw e;
      }
      return readFileSync(f, ...rest);
    };
    try {
      memory.trayProponer([{ texto: 'Me llamo Darío' }]);
    } finally {
      fs.readFileSync = readFileSync;
    }
    const enDisco = JSON.parse(fs.readFileSync(tray, 'utf8'));
    eq(enDisco.propuestas.length, 1, 'la propuesta que ya estaba sigue en el fichero');
    eq(enDisco.propuestas[0].id, 'p0', 'y es la de antes, no la nueva');
    eq(memory.trayList().length, 1, 'al recuperarse la lectura, la bandeja se relee');
  } finally {
    memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
  }
});
