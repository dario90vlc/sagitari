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

/* La app de prueba vive en su propio directorio de datos (main.js lo deriva de
   --hidden/--test). Se le deja un config mínimo para que la interfaz se vea como
   una instalación configurada: sin proveedor activo la app arranca con la
   bienvenida «ve a Ajustes» y el estado vacío no está visible, que es justo lo
   que se comprueba aquí. No lleva ninguna credencial: el endpoint apunta a un
   puerto local cerrado, así que cualquier llamada al modelo falla al instante
   sin tocar la red ni las claves reales. */
const TEST_DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SagitariAI-test');
function seedTestConfig() {
  const file = path.join(TEST_DATA_DIR, 'config.json');
  /* Proveedor con lista larga y el modelo en uso al final: es el caso que hace
     desplazarse al menú de modelos, así que las comprobaciones de interfaz se
     enfrentan al mismo escenario que el usuario (lista desplazada, cabecera y pie
     fijos) y no al caso fácil de una sola fila. */
  const modelos = Array.from({ length: 12 }, (_, i) => 'test-model-' + (i + 1));
  const dummy = { providerId: 'ui-check', name: 'Prueba (sin conexión)', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'test-model-10', vision: false };
  /* SIEMPRE se reescribe. Este perfil es de las pruebas: dar por bueno lo que
     hubiera dejado otro proceso hacía que el ui-check verificara un estado distinto
     cada vez (llegó a comprobar un menú con 16 modelos y otro activo, donde la
     primera fila de la lista quedaba fuera de la parte visible). */
  try {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers: [{ ...dummy, id: 'ui-check', models: modelos }], active: dummy }, null, 2), 'utf8');
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

/** Comprobaciones sobre la ventana viva. `true` = bien. */
const CHECKS = {
  'renderer sin errores de carga (nada roto antes de arrancar)': 'typeof window.ChatKit === "object" && typeof window.SAGI_ICONS === "object"',
  'iconos inyectados en toda la interfaz': 'document.querySelectorAll("[data-i] svg").length >= 25',
  'ningún icono se quedó sin dibujo': '[...document.querySelectorAll("[data-i]")].every(e => e.querySelector("svg"))',
  'los iconos tienen trazo real (no el punto de reserva)': '[...document.querySelectorAll("[data-i] svg")].filter(s => s.innerHTML.length > 20).length >= 20',
  'sidebar: 4 grupos y 9 secciones (sin Inicio)': 'document.querySelectorAll(".navgroup").length === 4 && document.querySelectorAll(".navitem").length === 9',
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
  seedTestConfig();
  const port = await freePort();
  // --hidden: la ventana NO se muestra. Antes se abría y se cerraba sola durante
  // probar.bat, y eso se ve idéntico a «la app se cierra sola».
  const child = spawn(electron, ['--remote-debugging-port=' + port, '--hidden', '.'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
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
    pending.set(myId, (m) => res(m.result && m.result.result ? m.result.result.value : undefined));
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  /* Comando CDP cualquiera (se usa para emular el tamaño mínimo de ventana). */
  const cmd = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, (m) => res(m.result));
    ws.send(JSON.stringify({ id: myId, method, params }));
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
  ws.close();
  done(failed ? 1 : 0);
})().catch((e) => {
  console.error('UI-CHECK::{"ok":false,"error":' + JSON.stringify(String(e && e.message || e)) + '}');
  process.exit(1);
});
