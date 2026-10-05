'use strict';

/* ============================================================================
   shot-cdp.js — capturas de la interfaz de SAGITARI por el protocolo de
   depuración de Chromium (CDP).

   Por qué CDP y no PrintWindow: los píxeles son exactos (sin marco de ventana,
   sin composición del escritorio, sin dependencia de que la ventana esté
   delante) y se puede elegir el viewport y recorrer las vistas.

   DOS REQUISITOS del entorno, ambos documentados abajo:
     1. ELECTRON_RUN_AS_NODE no puede estar definido: con él Electron se
        comporta como Node, `app` no existe y la ventana nunca se abre.
     2. En un sandbox que restringe el token, el binario de Electron sale con
        STATUS_CONTROL_C_EXIT. --no-sandbox --disable-gpu lo arranca. Es una
        herramienta de desarrollo: captura la app del propio usuario, en su
        máquina, sin red.

   Uso:
     node scripts/shot-cdp.js [carpetaSalida] [vistas] [ancho] [alto] [--demo]

   --demo siembra una conversación de verdad antes de fotografiar el chat. Sin
   ella, shots/chat.png es el estado vacío: no enseña la interfaz.

   vistas: lista separada por comas de data-view (chat, tasks, projects, agents,
           memory, skills, mcp, tools, history, settings) o «all». Por defecto:
           chat. Debe coincidir con los .navitem[data-view] de index.html: una
           vista lista aqui y no ahi hace que el clic no encuentre el boton.

   Las capturas van a <carpetaSalida>/<vista>.png
   ============================================================================ */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const electron = require('electron'); // en un proceso Node normal: la ruta del binario
const APP_DIR = path.join(__dirname, '..');
const TEST_DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SagitariAI-test');

const OUT_DIR = path.resolve(process.argv[2] || path.join(APP_DIR, 'shots'));
const VIEWS = (process.argv[3] || 'chat')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WIDTH = Number(process.argv[4] || 1440);
const HEIGHT = Number(process.argv[5] || 900);
/* --demo siembra una conversación de verdad antes de fotografiar el chat: sin
   ella, la captura del chat es el estado vacío, que no enseña la interfaz. */
const DEMO = process.argv.includes('--demo');

const TODAS = ['chat', 'tasks', 'projects', 'agents', 'memory', 'skills', 'mcp', 'tools', 'history', 'settings'];

/* Conversación de demostración, dibujada con las propias funciones del renderer
   (bubble + scroll) para que salga lo que sale de verdad: burbuja, markdown,
   código y espaciado reales, no un HTML imitado. */
const DEMO_CHAT = `(() => {
  const log = document.getElementById('messages');
  if (!log) return 'NO_CONTAINER';
  if (typeof bubble !== 'function') return 'NO_BUBBLE_FN';
  log.innerHTML = '';
  const say = (role, html) => { bubble(role).innerHTML = html; };
  say('user', 'Ayúdame a organizar mi carpeta de Descargas: quiero separar instaladores, documentos e imágenes.');
  say('ai', 'He revisado <b>Descargas</b>: 214 archivos. Mi plan:<br><br>1. Crear <b>Instaladores</b>, <b>Documentos</b> e <b>Imágenes</b>.<br>2. Clasificar por extensión: <code>.exe/.msi</code> → Instaladores · <code>.pdf/.docx</code> → Documentos · <code>.png/.jpg</code> → Imágenes.<br>3. Ejecutar y darte un resumen.<br><br>¿Confirmas?');
  say('user', 'Adelante, ejecuta el plan.');
  say('ai', 'Hecho. <b>214 archivos</b> clasificados sin perder ninguno:<br><br>• <b>Instaladores</b> → 38&nbsp;&nbsp;• <b>Documentos</b> → 121&nbsp;&nbsp;• <b>Imágenes</b> → 55<br><br>Tiempo total: <b>42 s</b>. ¿Quieres que mueva los instaladores de más de 1 GB a la Papelera?');
  const ta = document.getElementById('chatInput');
  if (ta) { ta.value = ''; ta.style.height = 'auto'; }
  if (typeof scroll === 'function') scroll();
  return 'OK msgs=' + log.querySelectorAll('.msg').length;
})()`;

/* Perfil de pruebas: proveedor con lista larga (el caso que desplaza el menú de
   modelos) y un servidor MCP apagado. Sin credenciales: no toca claves reales. */
function seedTestConfig() {
  const modelos = Array.from({ length: 12 }, (_, i) => 'test-model-' + (i + 1));
  const dummy = {
    providerId: 'ui-check',
    name: 'Prueba (sin conexión)',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: '',
    model: 'test-model-10',
    vision: false,
  };
  try {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'config.json'),
      JSON.stringify(
        {
          providers: [{ ...dummy, id: 'ui-check', models: modelos }],
          active: dummy,
          mcp: {
            enabled: true,
            servers: [
              { id: 'eco', name: 'Eco de prueba', enabled: false, transport: 'stdio', command: process.execPath, args: [], env: {} },
            ],
          },
          settings: { showThinking: true, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-shot-ws-')) },
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    console.error('no se pudo sembrar el config de pruebas:', e.message);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

const getJson = (url) =>
  new Promise((res, rej) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarCdp(port, intentos = 80) {
  for (let i = 0; i < intentos; i++) {
    try {
      const v = await getJson(`http://127.0.0.1:${port}/json/version`);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error('el endpoint de depuración no respondió (¿otra instancia de SAGITARI abierta?)');
}

(async () => {
  seedTestConfig();
  const port = await freePort();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* El entorno no debe heredar ELECTRON_RUN_AS_NODE: con él no hay ventana. */
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;

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
  const salir = (code) => {
    if (salido) return;
    salido = true;
    try {
      child.kill();
    } catch {}
    setTimeout(() => process.exit(code), 300);
  };

  child.on('exit', (c) => {
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
        const { res, rej } = pendientes.get(m.id);
        pendientes.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pendientes.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    // Esperar a que el renderer haya pintado de verdad.
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result.value === 'complete') break;
      await sleep(250);
    }
    await sleep(1200);

    const lista = VIEWS[0] === 'all' ? TODAS : VIEWS;
    for (const vista of lista) {
      if (vista === 'chat' && DEMO) {
        // La conversación se siembra con las funciones del renderer, no con HTML
        // imitado: así la captura enseña la burbuja, el markdown y el código reales.
        const r = await send('Runtime.evaluate', { expression: DEMO_CHAT, returnByValue: true });
        const v = r.result && r.result.result && r.result.result.value;
        if (v && v.indexOf('OK') !== 0) console.error('  demo no sembrada:', v);
        await sleep(700);
      }
      const pulso = await send('Runtime.evaluate', {
        expression: `(function(){ var b=document.querySelector('.navitem[data-view="${vista}"]'); if(b){b.click(); return true;} return false; })()`,
        returnByValue: true,
      });
      if (!pulso.result.value) {
        // Sin aviso, la captura sale repetida: se fotografía la vista anterior y se
        // guarda con el nombre de la que no existe, que parece que salió bien.
        console.error('  OMITIDA ' + vista + ': no hay .navitem[data-view="' + vista + '"]');
        continue;
      }
      await sleep(900);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, vista + '.png'), Buffer.from(shot.data, 'base64'));
      console.log('  ' + vista + '.png');
    }

    ws.close();
    salir(0);
  } catch (e) {
    console.error('FALLO:', e.message);
    salir(1);
  }
})();
