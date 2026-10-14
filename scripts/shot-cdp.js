'use strict';

/* ============================================================================
   shot-cdp.js — capturas de la interfaz de SAGITARI por el protocolo de
   depuración de Chromium (CDP).

   Por qué CDP y no PrintWindow: los píxeles son exactos (sin marco de ventana,
   sin composición del escritorio, sin dependencia de que la ventana esté
   visible) y se puede cambiar de vista con el mismo proceso.

   Uso:
     node scripts/shot-cdp.js [dir] [vistas] [ancho] [alto] [--demo]

   vistas: lista separada por comas (chat, tasks, projects, agents, equipo,
   memory, skills, mcp, tools, history, settings, apariencia, seguridad) o
   «all». Por defecto: chat. `apariencia` y `seguridad` son los dos paneles de
   Ajustes que la galería enseña: `settings` entra por la vista y estos dos
   además pulsan su pestaña.

   --demo siembra contenido de verdad antes de fotografiar: la conversación del
   chat (con las funciones del renderer) y el equipo del modo EQUIPO (con sus
   propios eventos `team_*`). Sin ella, shots/chat.png es el estado vacío y
   shots/equipo.png es «Sin equipo en esta conversación»: ninguno enseña la
   interfaz.
   ============================================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const APP_DIR = path.join(__dirname, '..');
const TODAS = [
  'chat',
  'tasks',
  'projects',
  'agents',
  'equipo',
  'memory',
  'skills',
  'mcp',
  'tools',
  'history',
  'settings',
  'apariencia',
  'seguridad',
  'slash',
  'diffs',
];

/* Dos vistas NO son secciones del menú sino paneles de Ajustes: para llegar a ellas hay
   que entrar en la vista y pulsar su pestaña. La galería las enseña (Apariencia y
   Seguridad son las que un lector busca) y sin esta tabla se fotografiaría la vista de
   Ajustes por defecto con el nombre del panel: la captura parecería buena y no lo sería. */
const SUBVISTAS = {
  settings: { nav: 'settings', sel: '.settab[data-set="model"]', panel: 'model' },
  apariencia: { nav: 'settings', sel: '.settab[data-set="apariencia"]', panel: 'apariencia' },
  seguridad: { nav: 'settings', sel: '.settab[data-set="security"]', panel: 'security' },
};

/* Dos capturas de ESTADO, no de sección: la paleta de órdenes abierta y la revisión del
   cambio con su diff. Se montan sobre el chat con el renderer de verdad —la paleta con
   su propia lista (`ChatKit.COMMANDS`) y el panel con su propio pintor (`pintarDiff`)—,
   no con HTML imitado, por el mismo motivo que la conversación de demostración. */
const SHOT_SLASH = `(function () {
  var nav = document.querySelector('.navitem[data-view="chat"]');
  if (nav) nav.click();
  var i = document.getElementById('chatInput');
  if (!i) return 'NO_INPUT';
  i.value = '/';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.focus();
  return 'OK';
})()`;

const DEMO_DIFF = `[{
  path: 'renderer/styles.css',
  rel: 'renderer/styles.css',
  adds: 6,
  dels: 1,
  hunks: [{
    cabecera: '@@ -1188,6 +1188,12 @@',
    lineas: [
      { tipo: 'ctx', texto: '  box-shadow: 0 0 8px var(--warn);' },
      { tipo: 'ctx', texto: '}' },
      { tipo: 'del', texto: '.dot.custom { /* sin regla: el punto salía invisible */ }' },
      { tipo: 'add', texto: '.dot.custom {' },
      { tipo: 'add', texto: '  background: var(--vio2);' },
      { tipo: 'add', texto: '  box-shadow: 0 0 8px var(--vio2);' },
      { tipo: 'add', texto: '}' }
    ]
  }]
}, {
  path: 'SAGITARI.md',
  rel: 'SAGITARI.md',
  adds: 3,
  dels: 0,
  noReversible: true,
  hunks: [{
    cabecera: '@@ -0,0 +1,3 @@',
    lineas: [
      { tipo: 'add', texto: '# Reglas del proyecto' },
      { tipo: 'add', texto: 'Las pruebas se lanzan con npm test.' },
      { tipo: 'add', texto: 'No toques la carpeta de datos.' }
    ]
  }]
}]`;

const SHOT_DIFFS = `(function () {
  var nav = document.querySelector('.navitem[data-view="chat"]');
  if (nav) nav.click();
  if (typeof pintarDiff !== 'function') return 'NO_PAINTER';
  var l = document.getElementById('diffList');
  var p = document.getElementById('diffPanel');
  if (!l || !p) return 'NO_PANEL';
  pintarDiff(${DEMO_DIFF}, l);
  p.hidden = false;
  return 'OK';
})()`;

/* Conversación de demostración, dibujada con las propias funciones del renderer
   (bubble, scroll) para que la captura enseñe el markdown, el código y el
   espaciado reales, no un HTML imitado. */
const DEMO_CHAT = `(function () {
  var log = document.getElementById('messages');
  if (!log) return 'NO_CONTAINER';
  if (typeof bubble !== 'function') return 'NO_BUBBLE_FN';
  log.innerHTML = '';
  var say = function (role, html) { bubble(role).innerHTML = html; };
  say('user', 'Ayúdame a organizar mi carpeta de Descargas: quiero separar instaladores, documentos e imágenes.');
  say('ai', 'He revisado <b>Descargas</b>: 214 archivos. Mi plan:<br><br>1. Crear <b>Instaladores</b>, <b>Documentos</b> e <b>Imágenes</b>.<br>2. Clasificar por extensión: <code>.exe/.msi</code> → Instaladores · <code>.pdf/.docx</code> → Documentos · <code>.png/.jpg</code> → Imágenes.<br>3. Ejecutar y darte un resumen.<br><br>¿Confirmas?');
  say('ai', 'Hecho. <b>214 archivos</b> clasificados sin perder ninguno:<br><br>• <b>Instaladores</b> → 38&nbsp;&nbsp;• <b>Documentos</b> → 121&nbsp;&nbsp;• <b>Imágenes</b> → 55<br><br>Tiempo total: <b>42 s</b>. ¿Quieres que mueva los instaladores de más de 1 GB a la Papelera?');
  return 'OK';
})()`;

/* El equipo del modo EQUIPO no se puede sembrar desde el perfil: su estado se ACUMULA de
   los eventos `team_*` del turno y no sobrevive al reinicio (renderer/40-vistas.js). Así
   que se siembra por donde entra de verdad, `equipoEvento`, con un encargo a medias: un
   compañero trabajando, otro esperando un permiso y otro que ya cerró su parte. Nada de
   HTML imitado —la vista, las tarjetas, el buzón, el tablero, el rail y la insignia los
   pinta la propia app—, y el orden y los nombres son los del producto (los especialistas
   de secuencia del registro). */
const DEMO_EQUIPO = `(function () {
  if (typeof equipoEvento !== 'function') return 'NO_EVENTO';
  var t = Date.now();
  equipoEvento({ type: 'team_start', ts: t, miembros: [
    { id: 'm1', spec: 'research', name: 'Investigador' },
    { id: 'm2', spec: 'coding', name: 'Programador' },
    { id: 'm3', spec: 'file', name: 'Archivador' }
  ]});
  equipoEvento({ type: 'team_member', id: 'm1', estado: 'trabajando', tarea: 'Recopilar las ventas de Q3 en la carpeta Informes', expect: 'cifras por producto y por mes' });
  equipoEvento({ type: 'team_member', id: 'm2', estado: 'esperando', tarea: 'Dibujar la evolución trimestral con los datos unificados', expect: 'un PNG en Informes/graficos', atencion: 'ejecutar Python y escribir el PNG' });
  equipoEvento({ type: 'team_member', id: 'm3', estado: 'terminado', tarea: 'Unificar los CSV de las tres delegaciones', expect: 'un solo fichero sin duplicados' });
  equipoEvento({ type: 'team_done', id: 'm3', ok: true, resumen: '12 CSV unificados en ventas-Q3.csv (4.812 filas).', evidencia: 'Informes/ventas-Q3.csv' });
  equipoEvento({ type: 'team_message', de: 'lider', para: 'm1', texto: 'Separa por producto y por mes; el detalle de suscripciones va aparte.', ts: t + 1000 });
  equipoEvento({ type: 'team_message', de: 'm1', para: 'lider', texto: 'Hecho: 4.812 filas. El resumen está en el tablero.', ts: t + 2000 });
  equipoEvento({ type: 'team_message', de: 'lider', para: 'm2', texto: 'Usa el CSV unificado, no toques los originales.', ts: t + 3000 });
  equipoEvento({ type: 'team_message', de: 'm2', para: 'lider', texto: 'Necesito permiso para ejecutar Python y guardar el PNG.', ts: t + 4000 });
  equipoEvento({ type: 'team_board', ts: t + 5000, items: [
    { quien: 'm3', que: 'Unificar los CSV de las delegaciones', estado: 'completed', nota: 'ventas-Q3.csv · 12 ficheros' },
    { quien: 'm1', que: 'Extraer las ventas de Q3', estado: 'completed', nota: '4.812 filas' },
    { quien: 'm2', que: 'Gráfico de evolución', estado: 'in_progress', nota: 'Informes/graficos/Q3.png' },
    { quien: 'lider', que: 'Redactar el informe final', estado: 'pending', nota: '' }
  ]});
  /* El permiso pendiente de m2 se cuenta por donde lo cuenta la app: la insignia del rail
     y de la tarjeta salen de aquí, no de un número escrito a mano. */
  if (typeof equipoPermiso === 'function') equipoPermiso(undefined, 'm2', 1);
  return 'OK';
})()`;

/* --demo es una opción, no una posición: si se trata como tal cae en el ancho y
   Emulation.setDeviceMetricsOverride recibe NaN («Invalid parameters»). */
const DEMO = process.argv.includes('--demo');
const args = process.argv.slice(2).filter((a) => a !== '--demo');

const OUT_DIR = path.resolve(args[0] || path.join(APP_DIR, 'shots'));
const VIEWS = (args[1] || 'chat')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WIDTH = Number(args[2] || 1440);
const HEIGHT = Number(args[3] || 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function getJson(url) {
  return new Promise((res, rej) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej);
  });
}

async function esperarCdp(port, intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    try {
      await getJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('el endpoint de depuración no respondió (¿otra instancia de SAGITARI abierta?)');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const port = await freePort();

  const electron = require('electron');
  /* El entorno no debe heredar ELECTRON_RUN_AS_NODE: con él no hay ventana. Y el
     perfil de pruebas tiene que ser escribible: en un sandbox que restringe el
     token, Electron no puede escribir en %APPDATA% y el bloqueo de instancia no
     crea (la app sale con «ya está abierta» sin que haya ninguna). */
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.SAGITARI_TEST_PROFILE = path.join(APP_DIR, '.perfil-shots');
  /* Sembrar un modelo activo en el perfil de capturas. Sin él, Ajustes enseña el asistente
     de primer uso y TAPA sus pestañas —las capturas de Apariencia y de Permisos salían con
     el panel de Modelo, o sea repetidas— y el pie de la app dice «sin modelo» en todas las
     capturas. Se escribe solo si el perfil no tiene proveedor; son los valores del preset
     real y este perfil es de usar y tirar (no se llama a ningún sitio). */
  try {
    const perfil = env.SAGITARI_TEST_PROFILE;
    fs.mkdirSync(perfil, { recursive: true });
    const cfgFile = path.join(perfil, 'config.json');
    const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    if (!Array.isArray(cfg.providers) || !cfg.providers.length) {
      const baseUrl = 'https://opencode.ai/zen/go/v1';
      const apiKey = 'sk-demo';
      cfg.providers = [{ id: 'opencode-go', name: 'OpenCode Go', baseUrl, apiKey, models: ['claude-haiku-5-5', 'gpt-5', 'glm-4-6'] }];
      cfg.active = {
        providerId: 'opencode-go',
        name: 'OpenCode Go',
        baseUrl,
        apiKey,
        model: 'claude-haiku-5-5',
        temperature: 0.7,
        vision: false,
      };
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    }
  } catch (e) {
    console.error('  aviso: no pude sembrar el modelo del perfil de capturas:', e.message);
  }

  const child = spawn(
    electron,
    [
      '--test-visible', // perfil de pruebas CON ventana: una ventana oculta no compone
      '--no-sandbox', // en un sandbox restringido el binario sale con STATUS_CONTROL_C_EXIT
      '--disable-gpu',
      '--remote-debugging-port=' + port,
      '--window-size=' + WIDTH + ',' + HEIGHT,
      '.',
    ],
    { cwd: APP_DIR, stdio: ['ignore', 'ignore', 'ignore'], env },
  );

  let salido = false;
  let quedan = 0; // capturas que faltan: si el proceso muere con todas hechas, no es fallo
  const salir = (code) => {
    if (salido) return;
    salido = true;
    try {
      child.kill();
    } catch {}
    setTimeout(() => process.exit(code), 300);
  };

  child.on('exit', (c) => {
    if (quedan === 0) return; // ya están todas: el proceso se apagó solo, bien
    console.error('Electron salió antes de tiempo con código', c);
    console.error('Si dice «SAGITARI ya está abierta», cierra la app y vuelve a intentarlo.');
    salir(1);
  });

  try {
    await esperarCdp(port);
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no hay página en los objetivos de depuración');

    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    let id = 0;
    const pendientes = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pendientes.has(m.id)) {
        const { res, rej, method } = pendientes.get(m.id);
        pendientes.delete(m.id);
        if (m.error) {
          console.error('  [cdp] error en ' + method + ': ' + m.error.message);
          rej(new Error(method + ': ' + m.error.message));
        } else res(m.result);
      } else if (m.method) {
        console.error('  [cdp] evento ' + m.method + ' ' + JSON.stringify(m.params || {}).slice(0, 160));
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pendientes.set(i, { res, rej, method });
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    /* La vista entra con un desvanecido, así que capturar «a los 900 ms» pillaba algunas a
       media transición: la captura salía lavada, como si la sección no hubiera abierto. Se
       espera a que la vista visible esté OPACA del todo (con tope de tiempo), no a un
       número fijo. */
    const esperarPintado = async () => {
      for (let i = 0; i < 50; i++) {
        const r = await send('Runtime.evaluate', {
          expression:
            "(function(){ var v=document.querySelector('.view.on'); if(!v) return 'OK'; return parseFloat(getComputedStyle(v).opacity || '1') >= 0.999 ? 'OK' : 'ESPERA'; })()",
          returnByValue: true,
        });
        if (r.result && r.result.value === 'OK') break;
        await sleep(100);
      }
      await sleep(250);
    };

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    /* La ventana de la app es TRANSLÚCIDA, así que la captura salía con los píxeles
       semitransparentes: en el visor de imágenes se ve bien (fondo oscuro), pero en el
       README de GitHub —que pinta sobre blanco— las capturas se desvanecían. Aquí se
       pinta la base de la app (--bg0) en la propia página, con `important` para ganar
       a la hoja de estilos, y se le pide a Chrome el mismo fondo opaco. */
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 6, g: 4, b: 15, a: 1 } });
    await send('Runtime.evaluate', {
      expression:
        "for (const el of [document.documentElement, document.body]) if (el) el.style.setProperty('background-color', '#06040f', 'important');",
    });
    console.error('  [cdp] métricas ' + WIDTH + 'x' + HEIGHT + ' ok');

    // Esperar a que el renderer haya pintado de verdad.
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result.value === 'complete') break;
      await sleep(250);
    }
    await sleep(1200);

    const lista = VIEWS[0] === 'all' ? TODAS : VIEWS;
    quedan = lista.length;
    for (const vista of lista) {
      console.error('  [cdp] vista ' + vista);
      /* Las dos capturas de estado se montan sobre el chat con el renderer de verdad y
         no tienen `.navitem` propio: se resuelven aquí y no en el pulso de navegación. */
      if (vista === 'slash' || vista === 'diffs') {
        const r = await send('Runtime.evaluate', {
          expression: vista === 'slash' ? SHOT_SLASH : SHOT_DIFFS,
          returnByValue: true,
        });
        const v = r.result && r.result.value;
        if (v !== 'OK') {
          console.error('  OMITIDA ' + vista + ': ' + String(v));
          quedan--;
          continue;
        }
        await sleep(900);
        /* Un aviso, no un fallo: esto es una herramienta de captura. La paleta se pinta
           tras un viaje de IPC (las skills se piden al proceso principal), así que el
           estado se comprueba DESPUÉS de esperar, no en la misma llamada. */
        const comp = await send('Runtime.evaluate', {
          expression:
            vista === 'slash'
              ? '(function(){ var m=document.getElementById("skillMenu"); return !!m && !m.hidden; })()'
              : '(function(){ var p=document.getElementById("diffPanel"); return !!p && !p.hidden; })()',
          returnByValue: true,
        });
        if (!(comp.result && comp.result.value)) console.error('  aviso: ' + vista + ' no llegó a su estado antes de la captura');
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, vista + '.png'), Buffer.from(shot.data, 'base64'));
        quedan--;
        console.log('  ' + vista + '.png');
        continue;
      }
      if (vista === 'chat' && DEMO) {
        // La conversación se siembra con las funciones del renderer, no con HTML
        // imitado: así la captura enseña la burbuja, el markdown y el código reales.
        const r = await send('Runtime.evaluate', { expression: DEMO_CHAT, returnByValue: true });
        const v = r.result && r.result.value;
        if (v && v.indexOf('OK') !== 0) console.error('  demo no sembrada:', v);
        await sleep(700);
      }
      if (vista === 'equipo' && DEMO) {
        // El equipo se acumula de eventos `team_*` (no vive en el perfil): se siembra por
        // donde entra de verdad y la propia vista lo pinta.
        const r = await send('Runtime.evaluate', { expression: DEMO_EQUIPO, returnByValue: true });
        const v = r.result && r.result.value;
        if (v !== 'OK') console.error('  demo de equipo no sembrada:', v);
        await sleep(700);
      }
      /* Los dos paneles de Ajustes: primero la vista, luego su pestaña. Y antes de entrar,
         se deja GUARDADA la pestaña que se quiere: la vista la restaura al pintarse, así
         que fijarla aquí hace la captura determinista —pulsar la pestaña y esperar dejaba
         a veces el panel de Modelo, y la captura salía con el nombre del otro—. */
      const sub = SUBVISTAS[vista];
      if (sub) {
        await send('Runtime.evaluate', {
          expression: `(function(){ try { localStorage.setItem('sagi.setTab','${sub.panel}'); return 'OK'; } catch(e) { return 'NO_STORE'; } })()`,
          returnByValue: true,
        });
        const nav = await send('Runtime.evaluate', {
          expression: `(function(){ var b=document.querySelector('.navitem[data-view="${sub.nav}"]'); if(!b) return 'NO_NAV'; b.click(); return 'OK'; })()`,
          returnByValue: true,
        });
        if ((nav.result && nav.result.value) !== 'OK') {
          console.error('  OMITIDA ' + vista + ': no hay .navitem[data-view="' + sub.nav + '"]');
          quedan--;
          continue;
        }
        await sleep(700);
        const tab = await send('Runtime.evaluate', {
          expression: `(function(){ var b=document.querySelector('${sub.sel}'); if(!b) return 'NO_TAB'; b.click(); return 'OK'; })()`,
          returnByValue: true,
        });
        if ((tab.result && tab.result.value) !== 'OK') {
          console.error('  OMITIDA ' + vista + ': no hay ' + sub.sel);
          quedan--;
          continue;
        }
        await sleep(900);
        /* La pestaña de Ajustes SE RECUERDA entre arranques, así que una captura puede
           heredar el panel de la anterior y salir con el nombre del otro. Se comprueba el
           panel que está de verdad activo y, si no es el pedido, se vuelve a pulsar la
           pestaña; si aun así no cuadra, NO se guarda nada: una captura equivocada con el
           nombre bueno es peor que no tenerla. */
        const leerPanel = async () => {
          const p = await send('Runtime.evaluate', {
            expression: `(function(){ var p=document.querySelector('#setWrap .setpanel.on'); return p ? p.dataset.panel : 'NONE'; })()`,
            returnByValue: true,
          });
          return p.result && p.result.value;
        };
        let panel = await leerPanel();
        if (panel !== sub.panel) {
          await send('Runtime.evaluate', {
            expression: `(function(){ var b=document.querySelector('${sub.sel}'); if(b) b.click(); return 'OK'; })()`,
            returnByValue: true,
          });
          await sleep(900);
          panel = await leerPanel();
        }
        if (panel !== sub.panel) {
          console.error('  OMITIDA ' + vista + ': el panel se quedó en «' + panel + '» (se pedía «' + sub.panel + '»)');
          quedan--;
          continue;
        }
        await esperarPintado();
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, vista + '.png'), Buffer.from(shot.data, 'base64'));
        quedan--;
        console.log('  ' + vista + '.png (panel «' + panel + '»)');
        continue;
      }
      const pulso = await send('Runtime.evaluate', {
        expression: `(function(){ var b=document.querySelector('.navitem[data-view="${vista}"]'); if(b){b.click(); return true;} return false; })()`,
        returnByValue: true,
      });
      if (!pulso.result.value) {
        // Sin aviso, la captura sale repetida: se fotografía la vista anterior y se
        // guarda con el nombre de la que no existe, que parece que salió bien.
        console.error('  OMITIDA ' + vista + ': no hay .navitem[data-view="' + vista + '"]');
        quedan--;
        continue;
      }
      await sleep(900);
      await esperarPintado();
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, vista + '.png'), Buffer.from(shot.data, 'base64'));
      quedan--;
      console.log('  ' + vista + '.png');
    }

    ws.close();
    salir(0);
  } catch (e) {
    console.error('FALLO:', e.message);
    salir(1);
  }
})();
