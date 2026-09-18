'use strict';

/* ============================================================================
   ui-check.js — ¿funciona de verdad la interfaz de SAGITARI?

   El smoke test (`npm run smoke`) sólo comprueba que la ventana se abre. Eso
   NO basta: si un script del renderer revienta al compilar (por ejemplo, dos
   ficheros que declaran el mismo nombre), la ventana se abre igual, el HTML
   estático se ve... y la app no responde a nada. Pasó exactamente eso.

   Esto arranca la app de verdad, se conecta a la ventana por el protocolo de
   depuración de Chromium y comprueba el renderer ya en marcha: iconos, cableado
   de botones, navegación entre vistas, el tema de cada modo y el estado vacío.

   Uso: node scripts/ui-check.js      (exit 0 = interfaz sana)
   ============================================================================ */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const electron = require('electron');   // en un proceso Node normal: la ruta del binario
const APP_DIR = path.join(__dirname, '..');
const TIMEOUT_MS = 25000;
/* Tope por comprobación: una que no responde (hilo del renderer bloqueado) debe
   contar como fallo, no dejar el script esperando para siempre. */
const CHECK_DEADLINE_MS = 8000;

/* La app de prueba vive en su propio directorio de datos (main.js lo deriva de
   --hidden/--test). Se le deja un config mínimo para que la interfaz se vea como
   una instalación configurada: sin proveedor activo la app arranca con la
   bienvenida «ve a Ajustes» y el estado vacío no está visible, que es justo lo
   que se comprueba aquí. No lleva ninguna credencial: el «modelo» es un servidor
   local de mentira (`fakeLlm`), así que las llamadas al modelo no salen a la red
   ni tocan claves reales — y de paso enseñan qué herramientas le ofrece la app
   al modelo, que no viaja por ningún canal de la interfaz. */
const TEST_DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SagitariAI-test');
/* El espacio de trabajo de la instancia de prueba: una carpeta TEMPORAL, no la del
   usuario. La comprobación de la revisión del cambio escribe un archivo de verdad y
   no puede dejar nada en el escritorio de quien ejecuta esto. */
const WS_TEST = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-ui-ws-'));
function seedTestConfig(apiPort) {
  const file = path.join(TEST_DATA_DIR, 'config.json');
  /* Proveedor con lista larga y el modelo en uso al final: es el caso que hace
     desplazarse al menú de modelos, así que las comprobaciones de interfaz se
     enfrentan al mismo escenario que el usuario (lista desplazada, cabecera y pie
     fijos) y no al caso fácil de una sola fila. */
  const modelos = Array.from({ length: 12 }, (_, i) => 'test-model-' + (i + 1));
  const dummy = { providerId: 'ui-check', name: 'Prueba (sin conexión)', baseUrl: 'http://127.0.0.1:' + apiPort + '/v1', apiKey: '', model: 'test-model-10', vision: false };
  // Servidor MCP de prueba: el mismo que usan los tests unitarios. Sin red y sin
  // instalar nada, así que la comprobación de interfaz no depende del entorno.
  const mcpServer = {
    id: 'eco', name: 'Eco de prueba', enabled: true, transport: 'stdio',
    command: process.execPath, args: [path.join(APP_DIR, 'test', 'fixtures', 'mcp-echo-server.js')], env: {},
  };
  /* Y un segundo servidor APAGADO (no arranca nada) cuyo id lleva guion: es el caso en
     el que el id crudo y el nombre expuesto NO coinciden (`mcp__my-server__*` frente a
     `mcp__my_server__*`). Con él la comprobación de la fila de permisos discrimina de
     verdad: con el id crudo, el desplegable de Seguridad no coincidiría con la clave
     que resuelve el motor de permisos. */
  const mcpServerConGuion = {
    id: 'my-server', name: 'Con guion (apagado)', enabled: false, transport: 'stdio',
    command: process.execPath, args: [path.join(APP_DIR, 'test', 'fixtures', 'mcp-echo-server.js')], env: {},
  };
  /* SIEMPRE se reescribe. Este perfil es de las pruebas: dar por bueno lo que
     hubiera dejado otro proceso hacía que el ui-check verificara un estado distinto
     cada vez (llegó a comprobar un menú con 16 modelos y otro activo, donde la
     primera fila de la lista quedaba fuera de la parte visible). */
  try {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      providers: [{ ...dummy, id: 'ui-check', models: modelos }], active: dummy,
      mcp: { enabled: true, servers: [mcpServer, mcpServerConGuion] },
      // el razonamiento se muestra en las comprobaciones de la interfaz: es un ajuste
      // del usuario y hay que verificar que su bloque aparece (y que se apaga solo)
      settings: { showThinking: true, workspace: WS_TEST },
    }, null, 2), 'utf8');
  } catch {}
}

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

/** Puerto libre para no chocar con otra instancia de desarrollo. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

/* Un WAV de mentira con voz y silencios: Chromium lo usa como micrófono
   (--use-file-for-fake-audio-capture), así que el nivel del orbe y la interrupción se
   prueban deterministas, sin hardware y sin tono constante. */
async function vozFalsa() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const sr = 48000, seg = 5, n = sr * seg;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const habla = (t > 1 && t < 2.2) || (t > 3.5 && t < 4.6);   // silencio, voz, silencio, voz
    const v = habla ? Math.sin(2 * Math.PI * 180 * t) * 0.35 : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  const f = path.join(os.tmpdir(), 'sagi-voz-falsa.wav');
  fs.writeFileSync(f, buf);
  return f;
}

/* Un «modelo» de mentira, en local: contesta cada petición con un turno SSE de una línea y
   apunta qué herramientas (`tools`) le ofreció la app. Es la ÚNICA ventana al catálogo real
   que ve el modelo (`allToolDefs`): no viaja por ningún canal de la interfaz, así que sin
   esto el interruptor global sólo se podía comprobar por lo que la app dice de sí misma, no
   por lo que de verdad recibe el modelo. `vistos` guarda un array de nombres por petición. */
function fakeLlm() {
  const vistos = [];
  /* La petición CRUDA, además de los nombres de herramientas: es lo único que el modelo
     recibe de verdad (system prompt, definiciones y el índice de skills), así que es
     donde se puede comprobar el registro con el que se le habla, sin fiarse del código. */
  const cuerpos = [];
  /* GUION: respuestas SSE ya hechas que se sirven en orden antes de caer al «listo» de
     siempre. Permite escenificar un turno con herramientas (p. ej. una delegación) sin
     inventar un servidor aparte: cada petición —incluidas las del SUBAGENTE, que usa el
     mismo proveedor— consume la siguiente. */
  const guion = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let nombres = null;
      try { nombres = (JSON.parse(body).tools || []).map(t => (t.function || {}).name).filter(Boolean); } catch {}
      vistos.push(nombres);      // null = la petición no traía `tools`
      cuerpos.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(guion.length ? guion.shift() : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'listo' } }] }) + '\n\ndata: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, vistos, cuerpos, guion })));
}

/** Una respuesta SSE de una sola frase (o de un tool_call, ver `guionToolCall`). */
function guionTexto(texto) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: texto } }] }) + '\n\ndata: [DONE]\n\n';
}
function guionToolCall(id, name, args) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\ndata: [DONE]\n\n';
}
/** Razonamiento del modelo (`reasoning_content`, como DeepSeek y compañía) + su respuesta. */
function guionRazonamiento(razonamiento, respuesta) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: razonamiento } }] }) + '\n\n'
    + (respuesta ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: respuesta } }] }) + '\n\n' : '')
    + 'data: [DONE]\n\n';
}

/** Comprobaciones sobre la ventana viva. `true` = bien. */
const CHECKS = {
  'renderer sin errores de carga (nada roto antes de arrancar)': 'typeof window.ChatKit === "object" && typeof window.SAGI_ICONS === "object"',
  'iconos inyectados en toda la interfaz': 'document.querySelectorAll("[data-i] svg").length >= 25',
  'ningún icono se quedó sin dibujo': '[...document.querySelectorAll("[data-i]")].every(e => e.querySelector("svg"))',
  'los iconos tienen trazo real (no el punto de reserva)': '[...document.querySelectorAll("[data-i] svg")].filter(s => s.innerHTML.length > 20).length >= 20',
  'sidebar: 4 grupos y 10 secciones (sin Inicio)': 'document.querySelectorAll(".navgroup").length === 4 && document.querySelectorAll(".navitem").length === 10',
  'la sección MCP es propia: el ítem del sidebar abre su vista y contiene la lista': '(function(){ const b = document.querySelector(\'.navitem[data-view="mcp"]\'); if (!b) return false; b.click(); const v = document.querySelector("#view-mcp"); const list = document.querySelector("#mcpList"); return !!v && v.classList.contains("on") && b.classList.contains("on") && !!list && v.contains(list) && !document.querySelector("#setTabs .settab[data-set=mcp]"); })()',
  'Alt+0 sigue sin cambiar de vista': '(function(){ const antes = [...document.querySelectorAll(".view.on")].map(v => v.id).join(","); window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", altKey: true, bubbles: true })); return [...document.querySelectorAll(".view.on")].map(v => v.id).join(",") === antes; })()',
  'Alt+7 sigue abriendo Herramientas': '(function(){ document.querySelector(\'[data-view="chat"]\').click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "7", altKey: true, bubbles: true })); return document.querySelector("#view-tools").classList.contains("on"); })()',
  'controles de ventana cableados': '["#btnClose","#btnMin","#btnMax"].every(s => { const e = document.querySelector(s); return e && typeof e.onclick === "function"; })',
  'la navegación responde': '(function(){ document.querySelector(\'[data-view="tasks"]\').click(); const ok1 = document.querySelector("#view-tasks").classList.contains("on"); document.querySelector(\'[data-view="chat"]\').click(); return ok1 && document.querySelector("#view-chat").classList.contains("on"); })()',
  'el selector de modo tiene los tres, con icono': 'document.querySelectorAll("#modeSeg button").length === 3 && [...document.querySelectorAll("#modeSeg button")].every(b => b.querySelector("svg"))',
  'el chat queda teñido con su modo': '/^(act|plan|think)$/.test(document.querySelector("#view-chat").dataset.mode)',
  'el compositor del chat está cableado': 'typeof document.querySelector("#chatSend").onclick === "function" && typeof document.querySelector("#btnCopyConv").onclick === "function"',
  'la interfaz no ha registrado ningún error propio': 'Array.isArray(window.__errores) && window.__errores.length === 0',
};

const EVENTS = [
  ['conversación nueva deja el estado vacío visible', '(function(){ document.querySelector("#btnClear").click(); return true; })()'],
];

const AFTER = {
  'el estado vacío sigue existiendo tras vaciar los mensajes': '!document.querySelector("#chatEmpty").hidden && document.querySelector("#messages").children.length === 0',
  'ofrece los tres modos, en fila': '(function(){ const c = [...document.querySelectorAll("#ceModes .ce-mode")]; return c.length === 3 && new Set(c.map(x => Math.round(x.getBoundingClientRect().top))).size === 1 && c[0].getBoundingClientRect().width > 120; })()',
  'sin vista Inicio: la app abre directamente en Chat': '(function(){ return !document.querySelector("#view-home") && document.querySelector("#view-chat").classList.contains("on"); })()',
  'no pisa el compositor': '(function(){ const e = document.querySelector("#chatEmpty").getBoundingClientRect(); const c = document.querySelector("#chatWrap .composer").getBoundingClientRect(); return e.bottom <= c.top + 1; })()',
  'cambiar de modo se refleja en la vista': '(function(){ const b = [...document.querySelectorAll("#modeSeg button")].find(x => x.dataset.m === "think"); b.click(); return true; })()',
};

(async () => {
  // El modelo de mentira primero: su puerto va en el config que se siembra.
  const llm = await fakeLlm();
  seedTestConfig(llm.port);
  const port = await freePort();
  // --hidden: la ventana NO se muestra. Antes se abría y se cerraba sola durante
  // probar.bat, y eso se ve idéntico a «la app se cierra sola».
  /* --use-fake-device-for-media-stream: micrófono sintético, para que las comprobaciones
     de permiso, de nivel y de interrupción no dependan del hardware de quien ejecute esto.
     El WAV de mentira sustituye al tono constante de la tarea anterior: con voz y
     silencios de verdad, la interrupción y el nivel se pueden comprobar. */
  const wavFalso = await vozFalsa();
  const child = spawn(electron, ['--remote-debugging-port=' + port, '--hidden',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wavFalso, '.'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });
  /* Salir ANTES de que la instancia de prueba muera de verdad dejaba vivo un
     proceso que aún sujetaba cosas (el bloqueo de instancia única, el
     navegador). El lanzamiento siguiente se encontraba el terreno ocupado.
     Ahora esperamos a su salida real; si se resiste, lo forzamos. */
  const done = (code) => {
    let salido = false;
    const salir = () => { if (!salido) { salido = true; process.exit(code); } };
    try { llm.srv.close(); } catch {}
    try { fs.rmSync(WS_TEST, { recursive: true, force: true }); } catch {}
    child.once('exit', salir);
    try { child.kill(); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} salir(); }, 4000);
  };

  let page = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (!page && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
      page = list.find(p => p.type === 'page' && /index\.html/.test(p.url));
    } catch {}
  }
  if (!page) {
    const abierta = /ya está abierta/i.test(childOut);
    const motivo = abierta
      ? 'hay otra instancia de SAGITARI abierta: ciérrala y vuelve a intentarlo'
      : 'la ventana no respondió';
    console.error('UI-CHECK::' + JSON.stringify({ ok: false, error: motivo }));
    if (abierta) console.error('SAGITARI ya se está ejecutando. Ciérralo (o usa el icono de la bandeja) antes de probar.');
    return done(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  let terminado = false;   // el veredicto final ya está dado: no lo pisa el cierre
  const pending = new Map();
  const scriptErrors = [];
  /* Sólo cuentan los errores de SCRIPT (un fichero que no compila, una función
     que no existe...). Un aviso de red o del sistema de audio no dice nada
     sobre si la interfaz está viva, y contarlo volvía el check inestable. */
  const isScriptError = (t) => /uncaught|syntaxerror|referenceerror|typeerror|is not defined|is not a function|cannot read|unexpected token/i.test(String(t || ''));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      scriptErrors.push((d.exception && d.exception.description) || d.text || 'excepción');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = (m.params.args || []).map(a => a.value || a.description || '').join(' ');
      if (isScriptError(text)) scriptErrors.push(text.slice(0, 160));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const evaluate = (expr) => new Promise((res) => {
    const myId = ++id;
    // deadline: si el renderer deja de responder (bucle en su hilo, IPC colgado,
    // proceso muerto) la comprobación se resuelve como fallo en vez de dejar el
    // job colgado para siempre — que es justo lo que este script debe detectar.
    const timer = setTimeout(() => { pending.delete(myId); res(undefined); }, CHECK_DEADLINE_MS);
    pending.set(myId, (m) => { clearTimeout(timer); res(m.result && m.result.result ? m.result.result.value : undefined); });
    // awaitPromise: las comprobaciones que consultan el estado por IPC son async
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  /* Comando CDP cualquiera (se usa para emular el tamaño mínimo de ventana). */
  const cmd = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    const timer = setTimeout(() => { pending.delete(myId); res(undefined); }, CHECK_DEADLINE_MS);
    pending.set(myId, (m) => { clearTimeout(timer); res(m.result); });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  /* Si el renderer se cae a mitad, sin esto el script se quedaba esperando una
     respuesta que ya no podía llegar (y la CI, 360 min de job). */
  ws.on('close', () => {
    if (terminado) return;
    console.error('UI-CHECK::{"ok":false,"error":"la interfaz cerró la conexión antes de terminar"}');
    done(1);
  });
  ws.on('error', (e) => {
    if (terminado) return;
    console.error('UI-CHECK::{"ok":false,"error":' + JSON.stringify('websocket: ' + ((e && e.message) || e)) + '}');
    done(1);
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1200));           // deja terminar el arranque del renderer
  await ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
  await new Promise((r) => setTimeout(r, 300));

  let failed = 0;
  /* Una comprobación se repite una vez antes de darla por fallida: tras un
     cambio de vista o un IPC recién resuelto el layout puede tardar un frame.
     Un fallo real falla las dos veces. */
  const judge = async (name, expr) => {
    let v = await evaluate(expr);
    if (v !== true) { await new Promise(r => setTimeout(r, 500)); v = await evaluate(expr); }
    if (v === true) { console.log('  ok   ' + name); return true; }
    failed++;
    console.log('  FALLO ' + name + '  ->  ' + JSON.stringify(v));
    return false;
  };

  for (const [name, expr] of Object.entries(CHECKS)) await judge(name, expr);
  // escenario: conversación nueva
  for (const [, expr] of EVENTS) await evaluate(expr);
  await new Promise(r => setTimeout(r, 900));
  for (const [name, expr] of Object.entries(AFTER)) await judge(name, expr);
  // el cambio de modo debe haber teñido la vista
  await judge('el modo elegido tiñe el chat',
    '(function(){ for (let i = 0; i < 40; i++) {} return document.querySelector("#view-chat").dataset.mode === "think"; })()');
  /* ---- regresiones de la auditoría de UI (verificadas sobre la app viva) ---- */
  // El atributo `hidden` era anulado por reglas con display:grid/flex/inline-flex
  await judge('los elementos ocultos con [hidden] no se pintan',
    '(function(){ return ["#jumpDown","#attachStrip","#chStatus"].every(function(s){ var e = document.querySelector(s); return !e || !e.hidden || getComputedStyle(e).display === "none"; }); })()');
  // Sin @keyframes blink los indicadores de actividad quedaban estáticos
  await judge('los indicadores de actividad tienen animación real',
    '(function(){ for (var i = 0; i < document.styleSheets.length; i++) { var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; } for (var j = 0; j < rules.length; j++) { if (rules[j].type === CSSRule.KEYFRAMES_RULE && rules[j].name === "blink") return true; } } return false; })()');
  // Alt+0 mapeaba a una vista inexistente y dejaba la app en blanco
  await judge('Alt+0 no deja la app sin vista activa',
    '(function(){ window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", altKey: true, bubbles: true })); var on = document.querySelector(".view.on"); return !!on && on.id === "view-chat"; })()');
  // Los atajos no deben dispararse mientras se escribe en un campo
  await judge('los atajos no saltan de vista escribiendo en el chat',
    '(function(){ var input = document.querySelector("#chatInput"); input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "4", altKey: true, bubbles: true })); var on = document.querySelector(".view.on"); var ok = !!on && on.id === "view-chat"; input.blur(); return ok; })()');
  /* ---- actualizaciones: una instalación que se quedó a medias se puede reintentar ----
     El motor la recuerda en disco y el siguiente arranque la anuncia (para instalar hay
     que cerrar la app, así que es el único momento en que se le puede contar). Aquí se
     comprueba que la tarjeta la pinta con su botón: sin esto el usuario se quedaba en
     «se cierra, aparece una terminal, no pasa nada» y sin forma de volver a intentarlo. */
  await judge('la tarjeta de actualizaciones ofrece reintentar una instalación a medias',
    '(function(){ if (typeof renderUpdate !== "function") return "renderUpdate no accesible"; var antes = JSON.stringify(updState); renderUpdate({ kind: "nsis", current: "3.2.0", latest: "3.2.1", available: true, ready: null, pending: { version: "3.2.1", path: "C:\\\\Temp\\\\sagitari-update\\\\SAGITARI-Setup-3.2.1.exe", exists: true } }); var b = document.querySelector("#updInstallBtn"), lbl = document.querySelector("#updInstallLabel"), nota = document.querySelector("#updNote"); var ok = !b.hidden && !b.disabled && lbl.textContent === "Reintentar la instalación" && !nota.hidden && /3\\.2\\.1/.test(nota.textContent); renderUpdate(JSON.parse(antes)); return ok; })()');
  await judge('si el instalador pendiente ya no está, la tarjeta invita a descargarla otra vez',
    '(function(){ if (typeof renderUpdate !== "function") return "renderUpdate no accesible"; var antes = JSON.stringify(updState); renderUpdate({ kind: "nsis", current: "3.2.0", latest: "3.2.1", available: true, ready: null, pending: { version: "3.2.1", path: "C:\\\\Temp\\\\ya-no-esta.exe", exists: false } }); var dl = document.querySelector("#updDownloadBtn"), nota = document.querySelector("#updNote"); var ok = !dl.hidden && !nota.hidden && /vuelve a descargar|descarga la actualización otra vez/i.test(nota.textContent) && /no llegó a completarse/.test(nota.textContent); renderUpdate(JSON.parse(antes)); return ok; })()');
  /* ---- selector de modelo: el clic tiene que llegar al menú ----
     Comprueba el recorrido completo del selector (abrir → pulsar una fila →
     menú cerrado y píldora actualizada) con eventos de ENTRADA del navegador en
     vez de `.click()`, que se salta el reparto de eventos y por eso no veía nada.

     Lo que ESTE check no puede cubrir: el reparto de zonas de arrastre de la
     ventana. Los eventos inyectados por CDP entran directamente en el renderer y
     no pasan por el hit-test del sistema, así que un elemento dentro de una zona
     `-webkit-app-region: drag` recibe el clic inyectado aunque para el ratón real
     esté muerto (le pasó al menú de modelos: se abría y no respondía). Eso sólo se
     detecta con un clic físico en una ventana visible: ver el comentario de
     `.side` en styles.css. */
  const pulsarConRaton = async (selector) => {
    const pos = await evaluate(`(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; var r = e.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`);
    if (!pos) return false;
    const { x, y } = JSON.parse(pos);
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 450));
    return true;
  };
  await pulsarConRaton('#sideStatusBtn');
  const menuAbierto = await evaluate('!document.querySelector("#modelMenu").hidden');
  const destino = await evaluate(`(function(){
    /* Se elige una fila que esté DENTRO de la parte visible del menú y que el
       hit-test del navegador confirme. Con la lista desplazada (el modelo en uso va
       marcado y se desplaza a la vista), la primera fila del proveedor puede quedar
       por encima del área visible: pulsar sus coordenadas cae fuera del menú, en la
       barra lateral — eso cerraba el menú como «clic fuera» y además cambiaba de
       vista, tirando las comprobaciones siguientes. */
    var m = document.querySelector('#modelMenu').getBoundingClientRect();
    var filas = [...document.querySelectorAll('#modelMenu [data-model]')];
    var orden = filas.filter(function(r){ return !r.classList.contains('on'); }).concat(filas);
    for (var i = 0; i < orden.length; i++) {
      var b = orden[i].getBoundingClientRect();
      if (b.top < m.top || b.bottom > m.bottom) continue;
      var hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
      if (hit && hit.closest('[data-model]') === orden[i]) return orden[i].dataset.model;
    }
    return null;
  })()`);
  const pulsado = destino ? await pulsarConRaton('#modelMenu [data-model="' + destino + '"]') : false;
  const menuCerrado = await evaluate('document.querySelector("#modelMenu").hidden');
  const pildora = await evaluate('document.querySelector("#stModel").textContent');
  if (menuAbierto && destino && pulsado && menuCerrado && pildora === destino) {
    console.log('  ok   el selector de modelo responde al ratón real (' + destino + ')');
  } else {
    failed++;
    console.log('  FALLO el selector de modelo no responde al ratón real  ->  ' + JSON.stringify({ menuAbierto, destino, pulsado, menuCerrado, pildora }));
  }
  /* ---- el menú de modelos también con el teclado (antes solo con ratón) ----
     El botón anuncia aria-haspopup="listbox": si no se puede elegir sin ratón, la
     promesa de accesibilidad es falsa. Se comprueba sobre la interfaz viva. */
  await judge('el menú de modelos se navega con el teclado',
    '(function(){'
    + ' var b = document.querySelector("#sideStatusBtn"), m = document.querySelector("#modelMenu");'
    + ' if (!b || !m) return false;'
    + ' if (m.hidden) b.click();'            // abrir solo si estaba cerrado
    + ' if (m.hidden) return false;'
    + ' b.focus();'
    + ' if (!b.contains(document.activeElement)) return false;'
    + ' var kv = function (k) { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); };'
    + ' var hl = function () { return m.querySelectorAll(".sm-item.hl"); };'
    + ' kv("ArrowDown");'
    + ' if (hl().length !== 1) return false;'
    + ' var uno = hl()[0];'
    + ' kv("ArrowDown");'
    + ' if (hl().length !== 1 || hl()[0] === uno) return false;'
    + ' kv("End");'
    + ' if (hl().length !== 1) return false;'
    + ' kv("ArrowUp");'
    + ' if (hl().length !== 1) return false;'
    + ' kv("Escape");'
    + ' return m.hidden === true;'
    + '})()');
  /* ---- desplegables propios: el popup del sistema no se puede tematizar ----
     El popup de un <select> lo dibuja Windows (claro, con su tipografía) y no hay
     CSS que lo alcance; por eso cada select lleva encima un control de la app. Se
     comprueba que TODOS están mejorados, que la lista se pinta con las clases de los
     menús, que elegir escribe en el select nativo y propaga `change` —el contrato
     del que vive el resto del código— y que los campos de fecha piden tema oscuro
     (así el calendario del sistema sale oscuro). */
  /* Un `evaluate` cuya expresión lanza devuelve undefined: si eso pasaba (p. ej. al
     desactivar la mejora para probar esta misma comprobación) el JSON.parse reventaba
     el arnés entero en vez de contar un fallo. */
  const jsonDe = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const selects = jsonDe(await evaluate('JSON.stringify({ total: document.querySelectorAll("select").length, mejorados: [...document.querySelectorAll("select")].filter(s => s.dataset.csel === "1" && s.closest(".csel") && s.closest(".csel").querySelector(".csel-btn") && s.closest(".csel").querySelector(".csel-menu")).length })')) || { total: -1, mejorados: -1 };
  await evaluate('document.querySelector(\'[data-view="tasks"]\').click()');
  await new Promise(r => setTimeout(r, 400));
  await pulsarConRaton('.csel[data-csel-de="taskMode"] .csel-btn');
  const listaModo = jsonDe(await evaluate(`JSON.stringify({
    abierto: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? !document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu').hidden : false,
    filas: [...document.querySelectorAll('.csel[data-csel-de="taskMode"] .sm-item .sm-name')].map(f => f.textContent),
    opciones: [...(document.querySelector('#taskMode') || { options: [] }).options].map(o => o.textContent.trim()),
    clases: (document.querySelector('.csel[data-csel-de="taskMode"] .sm-item') || {}).className || '',
    fondo: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? getComputedStyle(document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu')).backgroundImage.slice(0, 21) : ''
  })`)) || {};
  await pulsarConRaton('.csel[data-csel-de="taskMode"] .sm-item:nth-child(2)');
  const elegido = jsonDe(await evaluate(`JSON.stringify({
    valor: (document.querySelector('#taskMode') || {}).value,
    etiqueta: (document.querySelector('.csel[data-csel-de="taskMode"] .csel-label') || {}).textContent,
    cerrado: (document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') || {}).hidden
  })`)) || {};
  const fechaOscura = await evaluate('getComputedStyle(document.querySelector("#taskWhen")).colorScheme === "dark"') === true;
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  await new Promise(r => setTimeout(r, 300));
  const selectsOk = selects.total > 0 && selects.total === selects.mejorados
    && listaModo.abierto === true && (listaModo.filas || []).join(',') === (listaModo.opciones || []).join(',') && listaModo.filas.length > 0
    && /sm-item/.test(listaModo.clases) && /linear-gradient/.test(listaModo.fondo)
    && elegido.valor === 'plan' && elegido.etiqueta === 'Plan' && elegido.cerrado === true && fechaOscura;
  if (selectsOk) console.log('  ok   los desplegables son de la app (lista propia, elegir propaga change, fecha en oscuro)');
  else { failed++; console.log('  FALLO los desplegables nativos siguen a la vista  ->  ' + JSON.stringify({ selects, listaModo, elegido, fechaOscura })); }
  // Tamaño mínimo real de la ventana (main.js: minWidth 1000 x minHeight 620):
  // el compositor quedaba 60px fuera de pantalla porque el grid se dimensionaba
  // por contenido en vez de por la altura disponible
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1000, height: 620, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 700));
  await judge('a 1000x620 el compositor sigue dentro de la ventana',
    '(function(){ var c = document.querySelector("#composer"); return !!c && c.getBoundingClientRect().bottom <= innerHeight + 1; })()');
  /* Estar DENTRO de la ventana no basta: el mobiliario del compositor no encoge,
     y en el ancho mínimo el campo de texto llegó a quedarse en 8px (0 útiles)
     mientras el compositor seguía «dentro». Se mide el ancho ÚTIL real del campo,
     que es lo que el usuario necesita para escribir. */
  await judge('a 1000x620 el campo de texto conserva ancho útil',
    '(function(){ var i = document.querySelector("#chatInput"); if (!i) return false; var r = i.getBoundingClientRect(); var cs = getComputedStyle(i); return r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) >= 140; })()');
  await judge('a 1000x620 el chat no provoca scroll de página',
    '(function(){ return document.documentElement.scrollHeight <= innerHeight + 1; })()');
  await cmd('Emulation.clearDeviceMetricsOverride', {});

  /* ---- MCP: la sección existe, el formulario abre y el estado se pinta ----
     Sobre la app viva y con un servidor de verdad (el de eco de los tests): lo que
     se comprueba es el recorrido completo, no que los elementos existan. */
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise(r => setTimeout(r, 400));
  await judge('la sección MCP muestra el servidor de prueba', '(function(){ var rows = document.querySelectorAll("#mcpList .mcprow"); return rows.length >= 1 && /Eco de prueba/.test(document.querySelector("#mcpList").textContent); })()');
  await judge('el formulario de MCP abre y tiene los campos', '(function(){ document.querySelector("#mcpNew").click(); var c = document.querySelector("#mcpFormCard"); return c.classList.contains("on") && getComputedStyle(c).display !== "none" && !!document.querySelector("#mcpCommand") && !!document.querySelector("#mcpUrl"); })()');
  // se cierra para no interferir con las comprobaciones siguientes de la sección
  await evaluate('document.querySelector("#mcpCancel").click()');
  await judge('cambiar a URL remota oculta el comando local', '(function(){ var t = document.querySelector("#mcpTransport"); t.value = "http"; t.dispatchEvent(new Event("change", { bubbles: true })); var ok1 = document.querySelector("#mcpStdioRows").hidden && !document.querySelector("#mcpHttpRows").hidden; t.value = "stdio"; t.dispatchEvent(new Event("change", { bubbles: true })); return ok1 && !document.querySelector("#mcpStdioRows").hidden; })()');
  // El flujo de importación tiene su propia entrada (window.prompt NO existe en Electron):
  // se comprueba que abre y que un JSON inválido se explica en el aviso del panel.
  await evaluate('document.querySelector("#mcpPaste").click()');
  await judge('la caja de pegar JSON abre', '(function(){ var b = document.querySelector("#mcpPasteBox"); return !!b && !b.hidden && !!document.querySelector("#mcpPasteText"); })()');
  await evaluate('(function(){ document.querySelector("#mcpPasteText").value = "no es json"; document.querySelector("#mcpPasteGo").click(); return true; })()');
  await new Promise(r => setTimeout(r, 600));
  await judge('un JSON inválido se explica en el aviso de la sección', '(function(){ return /Error/.test(document.querySelector("#mcpMsg").textContent); })()');
  await evaluate('(function(){ document.querySelector("#mcpPasteCancel").click(); return true; })()');
  // el botón Probar habla con el servidor de prueba y trae sus herramientas reales
  await evaluate('(function(){ var b = document.querySelector("#mcpList .mcprow [data-mcp=\\"test\\"]"); if (b) b.click(); return true; })()');
  await new Promise(r => setTimeout(r, 2500));
  await judge('probar el servidor trae sus herramientas reales',
    '(function(){ var t = document.querySelector("#mcpList").textContent; return /echo/.test(t) && /Listo/.test(t); })()');
  // ---- las OTRAS dos superficies del mismo dato: Herramientas y Seguridad ----
  await evaluate('document.querySelector(\'[data-view="tools"]\').click()');
  await new Promise(r => setTimeout(r, 600));
  await judge('la vista Herramientas muestra el grupo con las herramientas MCP',
    '(function(){ var g = document.querySelector("#toolsGrid"); return !!g && /Servidores MCP/.test(g.textContent) && /echo/.test(g.textContent); })()');
  await evaluate('document.querySelector(\'[data-view="settings"]\').click(); document.querySelector(\'#setTabs .settab[data-set="security"]\').click()');
  await new Promise(r => setTimeout(r, 600));
  await judge('Seguridad tiene una fila de permiso para el servidor MCP',
    '(function(){ var p = document.querySelector("#permList"); return !!p && /MCP/.test(p.textContent) && !!p.querySelector(\'select[data-tool="mcp__eco__*"]\'); })()');
  await judge('la fila de permiso usa la MISMA clave que resuelve el motor de permisos',
    '(async function(){ const l = await window.sagitari.mcpList(); const s = (l.servers || [])[0]; if (!s || !s.permKey) return false; return !!document.querySelector("#permList select[data-tool=\\"" + s.permKey + "\\"]"); })()');
  /* La de arriba pasa también con un id sin guion, donde id crudo y slug coinciden; esta
     usa el servidor `my-server` (id con guion), que es el caso que se rompía: la clave del
     desplegable tiene que ser la del nombre expuesto, y la del id crudo no puede existir. */
  await judge('con un id con guion, la fila de permiso usa el slug del nombre expuesto',
    '(async function(){ const l = await window.sagitari.mcpList(); const s = (l.servers || []).find(x => x.id === "my-server"); if (!s || s.permKey !== "mcp__my_server__*") return false; const q = (k) => !!document.querySelector("#permList select[data-tool=\\"" + k + "\\"]"); return q(s.permKey) && !q("mcp__my-server__*"); })()');
  // ---- el interruptor global apaga y enciende el catálogo (de punta a punta) ----
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise(r => setTimeout(r, 400));
  /* Y lo que de verdad recibe el MODELO, que no viaja por ningún canal de la interfaz: se
     mira la petición que la app le manda al modelo de mentira. */
  const pedirAlModelo = async () => {
    const antes = llm.vistos.length;
    const libre = async () => (await evaluate('(async function(){ return !(await window.sagitari.getAgentsLive()).running; })()')) === true;
    // con el agente ocupado, enviar sólo detendría el turno anterior
    for (let i = 0; i < 40 && !(await libre()); i++) await new Promise(r => setTimeout(r, 200));
    await evaluate('document.querySelector(\'[data-view="chat"]\').click(); document.querySelector("#chatInput").value = "hola"; document.querySelector("#chatSend").click()');
    const limite = Date.now() + 10000;
    while (llm.vistos.length === antes && Date.now() < limite) await new Promise(r => setTimeout(r, 150));
    const llegadas = llm.vistos.slice(antes);
    for (let i = 0; i < 40 && !(await libre()); i++) await new Promise(r => setTimeout(r, 200));
    return llegadas;
  };
  const nombresDe = (peticiones) => [...new Set(peticiones.flat().filter(Boolean))];
  const mcpDe = (nombres) => nombres.filter(n => n.startsWith('mcp__'));
  await evaluate('document.querySelector("#mcpGlobal").click()');
  await new Promise(r => setTimeout(r, 1500));
  await judge('con el interruptor apagado el catálogo no ofrece herramientas MCP',
    '(async function(){ const l = await window.sagitari.mcpList(); document.querySelector(\'[data-view="tools"]\').click(); await new Promise(r => setTimeout(r, 500)); const g = document.querySelector("#toolsGrid"); const sinGrupo = !!g && !/Servidores MCP/.test(g.textContent); document.querySelector(\'.navitem[data-view="mcp"]\').click(); return l.enabled === false && sinGrupo; })()');
  const sinMcp = nombresDe(await pedirAlModelo());
  if (sinMcp.length && !mcpDe(sinMcp).length) {
    console.log('  ok   con el interruptor apagado la petición al modelo no lleva herramientas MCP (' + sinMcp.length + ' nativas)');
  } else {
    failed++;
    console.log('  FALLO la petición al modelo sigue llevando herramientas MCP con el interruptor apagado  ->  ' + JSON.stringify({ ofrecidas: sinMcp.length, mcp: mcpDe(sinMcp) }));
  }
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise(r => setTimeout(r, 400));
  await evaluate('document.querySelector("#mcpGlobal").click()');
  await new Promise(r => setTimeout(r, 2500));
  await judge('al reencender, el catálogo vuelve a ofrecer las herramientas MCP',
    '(async function(){ const l = await window.sagitari.mcpList(); document.querySelector(\'[data-view="tools"]\').click(); await new Promise(r => setTimeout(r, 500)); const g = document.querySelector("#toolsGrid"); const conGrupo = !!g && /Servidores MCP/.test(g.textContent) && /echo/.test(g.textContent); document.querySelector(\'.navitem[data-view="mcp"]\').click(); return l.enabled === true && conGrupo; })()');
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  const conMcp = nombresDe(await pedirAlModelo());
  if (mcpDe(conMcp).includes('mcp__eco__echo')) {
    console.log('  ok   al reencender, el modelo vuelve a recibir las herramientas MCP (' + mcpDe(conMcp).join(', ') + ')');
  } else {
    failed++;
    console.log('  FALLO el modelo no recibe las herramientas MCP al reencender  ->  ' + JSON.stringify({ ofrecidas: conMcp.length, mcp: mcpDe(conMcp) }));
  }
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* El registro con el que se le habla al modelo: TODO lo que recibe —system prompt,
     definiciones de herramientas y el índice de skills— va sin emojis y con la regla de
     estilo escrita, porque el modelo copia lo que ve y el usuario no quiere un asistente
     que adorne el texto con caritas. Se mira la petición CRUDA (la última, que ya lleva
     las herramientas MCP), que es lo único que el modelo recibe de verdad. */
  const cuerpoModelo = llm.cuerpos[llm.cuerpos.length - 1] || '';
  const pictograma = /\p{Extended_Pictographic}/u;
  const emojisEnviados = [...new Set(cuerpoModelo.match(/.\p{Extended_Pictographic}/gu) || [])];
  if (/NADA de emojis/.test(cuerpoModelo) && !emojisEnviados.length) {
    console.log('  ok   la petición al modelo va sin emojis y declara la regla de estilo');
  } else {
    failed++;
    console.log('  FALLO la petición al modelo ' + (emojisEnviados.length
      ? 'lleva emojis: ' + JSON.stringify(emojisEnviados.slice(0, 6))
      : 'no declara la regla de estilo'));
  }

  /* El prompt en la petición CRUDA: lo estable delante y lo volátil al final, para que el
     proveedor pueda cachear el prefijo. La memoria cambia en cada turno; si viaja en medio
     del prompt, el caché se rompe desde ahí. */
  const iGuia = cuerpoModelo.indexOf('DELEGACIÓN');
  const iWs = cuerpoModelo.indexOf('ESPACIO DE TRABAJO');
  const iMem = cuerpoModelo.indexOf('MEMORIA del usuario');
  if (iGuia > 0 && iWs > 0 && iMem > 0 && iMem > iGuia && iMem > iWs) {
    console.log('  ok   el prompt va con lo estable delante y lo volátil al final (caché de prefijo)');
  } else {
    failed++;
    console.log('  FALLO el orden del prompt no deja cachear el prefijo  ->  ' + JSON.stringify({ iGuia, iWs, iMem }));
  }

  /* ---- DELEGACIÓN en la interfaz (de punta a punta, con el modelo de mentira) ----
     Tres turnos: el orquestador delega en el investigador, el subagente cierra con su
     RESULT/EVIDENCE y el orquestador responde. El texto interno del subagente lleva una
     marca irrepetible: si esa marca aparece en la RESPUESTA (quitando el grupo de
     herramientas), es que se ha colado en la burbuja —y con el modo voz se leería en voz
     alta—, que es justo el defecto que esta comprobación vigila. Solo aparece en su
     tarjeta de delegación, que es donde el usuario quiere leerla. */
  const MARCA_SUB = 'prueba-interna-999';
  // El agente elegido es el VERIFICADOR a propósito: su clave real (`verification`)
  // no estaba en el catálogo de etiquetas de la interfaz (`verify`), así que su ficha
  // no resolvía y leer `.label` de la nada tumbaba el manejador de eventos.
  llm.guion.push(
    guionToolCall('d1', 'delegate', { agent: 'verification', task: 'comprueba el informe de vuelos', expect: 'una URL con el precio' }),
    guionTexto('RESULT: 3 vuelos hallados\nDETAILS: 180 EUR ida y vuelta\nEVIDENCE: ' + MARCA_SUB + '\nSTATUS: OK'),
    guionTexto('Tienes tres vuelos a Roma desde 180 EUR.')
  );
  const esperar = async (expr, ms) => {
    const limite = Date.now() + ms;
    for (;;) {
      if (await evaluate(expr) === true) return true;
      if (Date.now() > limite) return false;
      await new Promise(r => setTimeout(r, 250));
    }
  };
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#chatInput").value = "investiga vuelos a Roma"; document.querySelector("#chatSend").click()');
  const llegoLaTarjeta = await esperar('!!document.querySelector(".tcard.dcard")', 25000);
  if (llegoLaTarjeta) {
    console.log('  ok   la delegación pinta su tarjeta en el chat');
  } else {
    failed++;
    console.log('  FALLO la delegación no dejó tarjeta en el chat (guion: ' + llm.guion.length + ' respuestas sin usar)');
  }
  await judge('la tarjeta de la delegación trae estado y evidencia',
    '(function(){ var c = document.querySelector(".tcard.dcard"); if (!c) return false; var t = c.textContent || ""; return /Verificador/.test(t) && /OK/.test(t) && t.indexOf(' + JSON.stringify(MARCA_SUB) + ') >= 0; })()');
  /* El tablero del equipo: la delegación se ve EN VIVO (una fila por subtarea, con su
     criterio) y se resuelve al acabar. Se comprueba aquí y no en el test unitario porque
     es lo único que cierra la pregunta «¿quién está trabajando ahora mismo?». */
  await judge('el tablero del equipo enseña la delegación en vivo y la cierra',
    '(function(){ var g = document.querySelector(".tgroup.team"); if (!g) return false; if (!/Equipo/.test(g.textContent || "")) return false; var chips = g.querySelectorAll(".toolchip"); if (chips.length !== 1) return false; var c = chips[0]; if (c.classList.contains("run")) return false; if (!(c.classList.contains("done") || c.classList.contains("err"))) return false; var t = c.textContent || ""; return /Verificador/.test(t) && /comprueba el informe de vuelos/.test(t); })()');
  await judge('Ajustes deja fijar el tope de subagentes por turno',
    '(async function(){ var el = document.querySelector("#grDelegations"); return !!el && Number(el.value) === 8; })()');

  await judge('el texto interno del subagente NO entra en la respuesta',
    '(function(){ var ms = document.querySelectorAll(".msg.ai"); var last = ms[ms.length - 1]; if (!last) return false; var copia = last.cloneNode(true); copia.querySelectorAll(".tgroup").forEach(function(g){ g.remove(); }); var t = copia.textContent || ""; return t.indexOf(' + JSON.stringify(MARCA_SUB) + ') < 0 && /Roma/.test(t); })()');

  /* ---- v2.3: razonamiento visible (Ajustes ▸ Agente ▸ Conversación) ----
     El modelo de mentira manda `reasoning_content`, como DeepSeek y compañía. Se
     comprueba lo que VE el usuario: un bloque propio encima de la respuesta, plegado
     en cuanto el agente empieza a contestar, que no se cuela en la respuesta —y por
     tanto no se leería en voz alta— y que desaparece si apaga el ajuste. En el mismo
     turno se fuerza UNA herramienta que falla (leer un archivo que no existe): antes,
     con el grupo plegado, un fallo dentro era invisible hasta abrirlo a mano. */
  const MARCA_RAZON = 'prueba-razonamiento-777';
  await evaluate('document.querySelector("#btnClear").click()');   // conversación limpia: el separador de día se cuenta desde cero
  await new Promise(r => setTimeout(r, 600));
  llm.guion.push(
    guionToolCall('r1', 'read_file', { path: 'no-existe-jamas-sagitari.txt' }),
    guionRazonamiento(MARCA_RAZON + ': ese archivo no está; lo digo tal cual.', 'Listo: no había tal archivo.')
  );
  const aiAntes = await evaluate('document.querySelectorAll(".msg.ai").length');
  await evaluate('document.querySelector("#chatInput").value = "mira ese archivo"; document.querySelector("#chatSend").click()');
  const llegoRazon = await esperar('document.querySelectorAll(".msg.ai").length > ' + aiAntes + ' && !!document.querySelector(".msg.ai:last-child .thinkblock")', 25000);
  if (llegoRazon) console.log('  ok   el razonamiento del modelo se pinta en su propio bloque');
  else { failed++; console.log('  FALLO no apareció el bloque de razonamiento (guion: ' + llm.guion.length + ' respuestas sin usar)'); }
  await judge('el bloque trae el razonamiento, su duración, su botón de copiar y queda plegado',
    '(function(){ const b = document.querySelector(".msg.ai:last-child .thinkblock"); if (!b) return { bloque: false }; const cuerpo = b.querySelector(".think-body"); const r = { marca: !!cuerpo && cuerpo.textContent.indexOf(' + JSON.stringify(MARCA_RAZON) + ') >= 0, meta: b.querySelector(".th-meta").textContent, copiar: !!b.querySelector(".th-copy"), plegado: !b.classList.contains("open") }; return (r.marca && r.copiar && r.plegado && /^pensó/.test(r.meta)) ? true : r; })()');
  await judge('el razonamiento NO entra en la respuesta (ni se leería en voz alta)',
    '(function(){ const m = document.querySelector(".msg.ai:last-child"); if (!m) return false; const c = m.querySelector(".bubble").cloneNode(true); c.querySelectorAll(".thinkblock,.tgroup").forEach(x => x.remove()); const t = c.textContent || ""; return t.indexOf(' + JSON.stringify(MARCA_RAZON) + ') < 0 && /no había tal archivo/.test(t); })()');
  await judge('la cabecera del grupo avisa del fallo con el grupo plegado',
    '(function(){ const g = document.querySelector(".msg.ai:last-child .tgroup:not(.team)"); if (!g) return false; const f = g.querySelector(".tg-fails"); return !!f && !f.hidden && /1 fallo/.test(f.textContent) && g.classList.contains("has-fails"); })()');
  /* El separador de día: antes lo estampaba CADA respuesta del agente (doce veces en una
     tarde, entre la pregunta y la respuesta). Se mide contando: uno al empezar el hilo y
     el MISMO número después de otro turno, que es exactamente lo que fallaba. */
  const dias1 = await evaluate('document.querySelectorAll("#messages .day").length');
  if (dias1 >= 1) console.log('  ok   el hilo estampa su separador de día al empezar');
  else { failed++; console.log('  FALLO el hilo no tiene separador de día'); }

  /* El interruptor de Ajustes manda de verdad: apagado, el siguiente turno no trae
     bloque (el agente ni lo pide), y al volver a encenderlo vuelve a aparecer. Se deja
     ENCENDIDO al terminar: el ajuste persiste en la configuración de la prueba. */
  const enviarYEsperar = async (marca) => {
    // el turno anterior tiene que haber cerrado del todo: con el agente ocupado, el envío
    // se descarta (a propósito) y la espera se quedaría mirando un turno que no existe
    await esperar('(async function(){ return !(await window.sagitari.getAgentsLive()).running; })()', 15000);
    const n = await evaluate('document.querySelectorAll(".msg.ai").length');
    await evaluate('document.querySelector("#chatInput").value = ' + JSON.stringify(marca) + '; document.querySelector("#chatSend").click()');
    const ok = await esperar('document.querySelectorAll(".msg.ai").length > ' + n + ' && /no había tal archivo/.test(document.querySelector(".msg.ai:last-child").textContent)', 25000);
    return ok;
  };
  await evaluate('document.querySelector(\'[data-view="settings"]\').click()');
  await evaluate('document.querySelector(\'.settab[data-set="agent"]\').click()');
  const apagadoOk = await evaluate('(async function(){ const sw = document.querySelector("#swThinking"); if (!sw || !sw.classList.contains("on")) return false; sw.click(); await new Promise(r => setTimeout(r, 400)); return !sw.classList.contains("on"); })()');
  if (apagadoOk) console.log('  ok   el interruptor del razonamiento se apaga en Ajustes');
  else { failed++; console.log('  FALLO no se pudo apagar el razonamiento en Ajustes'); }
  llm.guion.push(guionRazonamiento(MARCA_RAZON + ': esto NO debería verse.', 'Listo: no había tal archivo.'));
  await enviarYEsperar('otra vez, sin razonamiento visible');
  await judge('con el ajuste apagado el turno no trae bloque de razonamiento',
    '!document.querySelector(".msg.ai:last-child .thinkblock")');
  await judge('y el turno nuevo tampoco añade otro separador de día',
    'document.querySelectorAll("#messages .day").length === ' + dias1);
  const encendidoOk = await evaluate('(async function(){ const sw = document.querySelector("#swThinking"); sw.click(); await new Promise(r => setTimeout(r, 400)); return sw.classList.contains("on"); })()');
  llm.guion.push(guionRazonamiento(MARCA_RAZON + ': vuelvo a pensar a la vista.', 'Listo: no había tal archivo.'));
  const envio3 = await enviarYEsperar('y ahora otra vez, con razonamiento visible');
  await judge('al volver a encenderlo el bloque reaparece',
    '(function(){ const b = document.querySelector(".msg.ai:last-child .thinkblock"); if (!b) return { encendido: document.querySelector("#swThinking").classList.contains("on"), envio: ' + JSON.stringify(envio3) + ', turnos: document.querySelectorAll(".msg.ai").length, bloques: document.querySelectorAll(".msg.ai .thinkblock").length }; return (b.querySelector(".think-body").textContent || "").indexOf(' + JSON.stringify(MARCA_RAZON) + ') >= 0; })()');
  if (!encendidoOk) { failed++; console.log('  FALLO el interruptor no vuelve a encender el razonamiento'); }
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* ---- v2.4: la revisión del CAMBIO antes de cerrar (de punta a punta) ----
     El modelo de mentira escribe un archivo y el orquestador contesta. Antes de aceptar
     ese cierre, la app delega la revisión en su Revisor. Se comprueba en la ventana viva
     lo que el usuario ve (la tarjeta con el informe y el cierre final) y, en Node, lo que
     de verdad recibió el modelo y qué hay en el disco — sin creerse a la app. */
  const MARCA_REV = 'prueba-revision-555';
  const archivoRev = 'revision-' + Date.now() + '.js';
  await evaluate('document.querySelector("#btnClear").click()');
  await new Promise(r => setTimeout(r, 600));
  llm.guion.push(
    guionToolCall('w1', 'write_file', { path: archivoRev, content: 'function revisado() { return 42; }\n' }),
    guionTexto('He creado ' + archivoRev + '.'),
    guionTexto('RESULT: ' + MARCA_REV + ' sin hallazgos bloqueantes\nDETAILS: un archivo, un añadido\nSTATUS: OK'),
    guionTexto('Listo: el archivo está y pasa la revisión.')
  );
  await evaluate('document.querySelector("#chatInput").value = "crea un módulo de prueba"; document.querySelector("#chatSend").click()');
  /* Escribir en el disco pide permiso (y está bien que lo pida): aquí se concede, que es
     lo que haría el usuario. Si no apareciera la barra, la escritura no llegaría y la
     comprobación del archivo en el disco lo diría. */
  let permitido = false;
  for (let i = 0; i < 40 && !permitido; i++) {
    const visible = await evaluate('(function(){ const b = document.querySelector("#confirmBar"); return !!b && !b.hidden; })()');
    if (visible) { await evaluate('document.querySelector("#confirmOk").click()'); permitido = true; }
    else await new Promise(r => setTimeout(r, 250));
  }
  const llegoRevision = await esperar('!!document.querySelector(".tcard.dcard") && /Revisor/.test(document.querySelector("#messages").textContent)', 25000);
  if (llegoRevision) console.log('  ok   la revisión del cambio deja su tarjeta en el chat');
  else { failed++; console.log('  FALLO el Revisor no llegó a pintar su tarjeta (guion: ' + llm.guion.length + ' respuestas sin usar)'); }
  // la tarjeta de la revisión se pinta al ACABAR la delegación: el cierre del modelo viene después
  const llegoCierreRev = await esperar('/pasa la revisi[oó]n/.test(document.querySelector("#messages").textContent)', 25000);
  if (!llegoCierreRev) { failed++; console.log('  FALLO el turno no cerró con la respuesta del modelo tras la revisión'); }
  /* El cierre se busca en las ÚLTIMAS burbujas sin el grupo de herramientas ni el
     razonamiento: el texto del turno y las tarjetas comparten burbuja, así que leer el
     `.textContent` crudo de la última mezcla las dos cosas. */
  await judge('el revisor deja su informe y el cierre final es el del modelo',
    '(function(){ const cards = [...document.querySelectorAll(".tcard.dcard")]; const rev = cards.find(c => /Revisor/.test(c.textContent || "")); if (!rev) return { tarjeta: false }; const conTexto = [...document.querySelectorAll(".msg.ai")].slice(-2).map(m => { const c = m.cloneNode(true); c.querySelectorAll(".tgroup,.thinkblock").forEach(x => x.remove()); return c.textContent || ""; }).join(" | "); return (new RegExp(' + JSON.stringify(MARCA_REV) + ').test(rev.textContent || "") && /sin hallazgos bloqueantes/.test(rev.textContent || "") && /pasa la revisi[oó]n/.test(conTexto)) ? true : { informe: (rev.textContent || "").slice(0, 110), cierre: conTexto.slice(0, 160) }; })()');
  await judge('Ajustes trae la revisión del cambio activada (y es apagable)',
    '(function(){ const sw = document.querySelector("#swRevisar"); return !!sw && sw.classList.contains("on"); })()');
  /* En Node: el diff del turno tiene que haber llegado AL MODELO y el archivo tiene que
     estar en el disco. La primera es la prueba de que la revisión no es decorado; la
     segunda, de que el permiso y la escritura atómica funcionaron de verdad. */
  const cuerpoRev = llm.cuerpos.map(String).find(b => b.indexOf('DIFF DEL TURNO') >= 0);
  if (cuerpoRev && /\+ function revisado/.test(cuerpoRev)) {
    console.log('  ok   el diff del turno llega al agente de revisión');
  } else {
    failed++;
    console.log('  FALLO el revisor no recibió el diff del turno');
  }
  if (fs.existsSync(path.join(WS_TEST, archivoRev))) {
    console.log('  ok   el archivo escrito existe en el espacio de trabajo');
  } else {
    failed++;
    console.log('  FALLO la escritura no llegó al disco (permiso concedido: ' + permitido + ')');
  }
  if (llm.guion.length) { failed++; console.log('  FALLO el turno de revisión consumió un guion distinto (quedan ' + llm.guion.length + ')'); }
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* El modo voz necesita micrófono y dos canales nuevos. Se prueba con el dispositivo
     de mentira de Chromium (--use-fake-device-for-media-stream), así que pasa también
     en una máquina sin micrófono, como el runner de CI. */
  await judge('el micrófono se concede a la app y solo a ella',
    '(async function(){ const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const ok = !!s && s.getAudioTracks().length === 1; s.getTracks().forEach(t => t.stop()); return ok; })()');
  await judge('el modo voz se abre y se cierra por IPC',
    '(async function(){ const a = await window.sagitari.voiceOpen(); const b = await window.sagitari.voiceClose(); return !!(a && a.ok) && !!(b && b.ok); })()');

  /* El orbe del modo voz: vive en el renderer y se pinta a mano en un canvas. Se
     comprueban sus dos piezas frágiles. El suavizado, porque es lo que evita que el
     orbe tiemble (sube rápido, baja despacio); y el dibujo, porque además de pintar
     tiene que CAMBIAR DE CARA con el estado y dejar el borde del lienzo SIN pintar:
     si el halo llegara al borde se vería un cuadrado tenue sobre el panel. */
  await judge('el suavizado del orbe sube rápido y baja despacio',
    '(function(){ const o = window.OrbKit; if (!o) return false; let v = 0; v = o.smoothLevel(v, 1, 0.05); const subida = v; v = o.smoothLevel(v, 0, 0.05); const bajada = subida - v; return subida > 0.4 && bajada < subida / 2; })()');
  /* El borde se mira en OCHO puntos (esquinas y **medios de lado**), no en uno: el punto
     más cercano al halo es el medio del lado, así que mirar solo la esquina deja un punto
     ciego enorme —los dos halos defectuosos de las maquetas (R*1.6 y R*1.75) cabían dentro—
     y la comprobación no cazaría justo la regresión que vigila. Lo cazó la revisión. */
  await judge('la malla del orbe pinta, cambia de cara y no corta el halo en el borde',
    '(function(){ const o = window.OrbKit; if (!o) return false; const c = document.createElement("canvas"); c.width = 200; c.height = 200; const ctx = c.getContext("2d"); const cuenta = () => { const d = ctx.getImageData(0, 0, 200, 200).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n; }; o.draw(ctx, 200, 200, 0.6, "oyendo", 1.2); const a = cuenta(); o.draw(ctx, 200, 200, 0.6, "escuchando", 1.2); const b = cuenta(); o.draw(ctx, 200, 200, 0.6, "pensando", 1.2); const e = cuenta(); const alfa = (x, y) => ctx.getImageData(x, y, 1, 1).data[3]; const borde = [alfa(0, 0), alfa(199, 0), alfa(0, 199), alfa(199, 199), alfa(100, 0), alfa(0, 100), alfa(199, 100), alfa(100, 199)]; return a > 500 && b > 500 && e > 500 && Math.abs(a - b) > 50 && borde.every((v) => v === 0); })()');

  /* El panel del modo voz: se abre, se cierra con Esc y no deja rastro cuando está cerrado. */
  await judge('el modo voz abre con el micro y cierra con Esc',
    '(async function(){ const vm = window.VoiceMode; if (!vm) return false; await vm.abrir(); const abierto = vm.abierto() && !document.querySelector("#voiceMode").hidden; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(r => setTimeout(r, 60)); const cerrado = !vm.abierto() && document.querySelector("#voiceMode").hidden; return abierto && cerrado; })()');

  /* ---- modo voz: voz sintética, sin micrófono y sin depender del hardware ----
     Lo que ocurre EN LA PÁGINA se comprueba con `judge`; lo que tiene que LLEGAR AL
     MODELO se comprueba aquí, en Node, mirando las peticiones que recibe el modelo de
     mentira (el mismo patrón que usan las comprobaciones del catálogo MCP). */
  /* El orbe tiene que LATIR, no sólo pintar: en reposo ya hay ~32.000 píxeles con algo de
     alfa, así que contarlos no distingue una cosa de la otra (la voz añadía un 1,9 %). Se
     cuentan los píxeles BRILLANTES (alfa > 60) y se exige que la voz inyectada multiplique
     el reposo. Con `prefers-reduced-motion` el bucle pisa el nivel a propósito y sólo dibuja
     el de fondo, así que ahí se mide la regla donde vive: el dibujo directo. */
  /* El orbe tiene que NOTAR el nivel, no sólo pintar: en reposo ya hay ~32.000 píxeles con
     algo de alfa, así que contarlos no distingue nada (la voz añadía un 1,9 %). Se cuentan
     los BRILLANTES (alfa > 60): ~916 en reposo frente a ~5.146 con voz. Se mide sobre el
     dibujo directo, no en el lienzo de la app, para que valga también con
     prefers-reduced-motion (allí el bucle pisa el nivel a propósito). */
  await judge('el orbe late con la voz inyectada',
    '(function(){ const o = window.OrbKit; if (!o) return false; const c = document.createElement("canvas"); c.width = 380; c.height = 380; const ctx = c.getContext("2d"); const brillantes = function (nivel) { o.draw(ctx, 380, 380, nivel, "oyendo", 1.2); const d = ctx.getImageData(0, 0, 380, 380).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 60) n++; return n; }; const reposo = brillantes(0.05); const voz = brillantes(0.7); return reposo > 0 && voz > reposo * 1.5; })()');

  await judge('el permiso de una herramienta se contesta diciendo «sí»',
    '(function(){ let hecho = false; window.VoiceMode.pedirConfirmacion({ texto: "¿Borro la carpeta?", si: function(){ hecho = true; }, no: function(){} }); window.VoiceMode.handle({ type: "final", text: "sí" }); return hecho && window.VoiceMode.estado() !== "confirmando"; })()');
  /* Interrumpir de verdad, por la función de la app: el estado lo pone ELLA, no la
     comprobación (antes se fijaba «oyendo» a mano y la comprobación se contestaba sola). */
  await judge('interrumpir mientras habla vuelve a escuchar',
    '(async function(){ window.VoiceMode.handle({ type: "state", state: "hablando" }); await new Promise(r => setTimeout(r, 60)); await window.VoiceMode.interrumpir(); return window.VoiceMode.estado() === "oyendo"; })()');

  /* Las tres que se juzgan por lo que llega al modelo: se dispara un final y se espera
     a que el modelo de mentira reciba (o no reciba) una petición nueva. El final entra por
     `voiceEvent`, que es el punto único del proceso principal (`VoiceManager.ingest`): ahí
     vive el filtro de basura, así que sólo por ahí se puede comprobar que el ruido que se
     inventa el motor no llega al agente. Llamando a `VoiceMode.handle` desde la página el
     filtro se saltaría y la comprobación mediría una tubería que la app no tiene. */
  /* Esperar a que el agente esté libre: desde que el modo voz no envía con el turno
     ocupado (a propósito), disparar un dictado mientras trabaja lo dejaría sin enviar. */
  await evaluate('window.VoiceMode.abrir()');   // el manager del proceso principal nace al abrir el modo
  for (let i = 0; i < 60; i++) { const libre = await evaluate('(async function(){ return !(await window.sagitari.getAgentsLive()).running; })()'); if (libre === true) break; await new Promise((r) => setTimeout(r, 250)); }
  const vozDice = async (texto) => {
    const antes = llm.vistos.length;
    await evaluate('window.sagitari.voiceEvent({ type: "final", text: ' + JSON.stringify(texto) + ' })');
    const limite = Date.now() + 8000;
    while (llm.vistos.length === antes && Date.now() < limite) await new Promise(r => setTimeout(r, 150));
    return llm.vistos.length > antes;
  };
  if (await vozDice('recuérdame llamar a Álvaro')) console.log('  ok   una frase dictada llega al agente por el mismo camino del chat');
  else { failed++; console.log('  FALLO una frase dictada no llegó al agente'); }
  if (!(await vozDice('Gracias por ver el vídeo'))) console.log('  ok   la basura no llega al agente');
  else { failed++; console.log('  FALLO la basura llegó al agente'); }
  if (!(await vozDice('adiós'))) console.log('  ok   decir «adiós» cierra el modo y no envía nada');
  else { failed++; console.log('  FALLO «adiós» envió algo al agente'); }

  /* El panel tapa el chat: la respuesta tiene que ser legible ahí también (el modelo de
     mentira contesta «listo» a todo). */
  await judge('la respuesta del agente queda legible en el panel',
    '(function(){ const h = document.querySelector("#vmHistorial"); return !!h && /listo/i.test(h.textContent); })()');

  /* La app de prueba arranca OCULTA (--hidden) y su modelo de mentira responde «listo» a
     todo: si además hablara, el usuario oiría una voz salida de la nada, sin ventana que
     la explique (pasó, y se cazó con una sonda de procesos). El perfil de prueba deja el
     TTS encendido a propósito, así que esta comprobación falla si alguien quita el
     silencio de los arranques automatizados: con el silencio puesto, la app responde que
     no habla y no llega a lanzar ninguna síntesis. */
  await judge('un arranque de prueba no saca voz por los altavoces',
    '(async function(){ const r = await window.sagitari.speak("esto no debe sonar"); return !!r && r.ok === false; })()');

  // errores que la propia interfaz haya detectado (red de seguridad del renderer)
  const propios = await evaluate('Array.isArray(window.__errores) ? window.__errores.slice(0, 5) : null');
  if (Array.isArray(propios) && propios.length) {
    failed++;
    console.log('  FALLO errores detectados por la propia interfaz:');
    propios.forEach(e => console.log('        · ' + String(e).slice(0, 160)));
  } else console.log('  ok   ningún error detectado por la propia interfaz');
  // errores de script en el renderer
  if (scriptErrors.length) {
    failed++;
    console.log('  FALLO el renderer lanzó errores de script:');
    [...new Set(scriptErrors)].slice(0, 4).forEach(e => console.log('        · ' + e));
  } else console.log('  ok   el renderer no lanzó ningún error de script');

  console.log('');
  console.log('UI-CHECK::' + JSON.stringify({ ok: failed === 0, fallos: failed }));
  if (failed) console.error(failed + ' comprobación(es) de interfaz fallaron');
  terminado = true;   // veredicto dado: el cierre del socket ya no decide nada
  ws.close();
  done(failed ? 1 : 0);
})().catch((e) => {
  console.error('UI-CHECK::{"ok":false,"error":' + JSON.stringify(String(e && e.message || e)) + '}');
  process.exit(1);
});
