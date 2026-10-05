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
     node scripts/shot-cdp.js [carpetaSalida] [vistas] [ancho] [alto]

   vistas: lista separada por comas de data-view (chat, tasks, tools, memory,
           skills, mcp, history, settings) o «all». Por defecto: chat.

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

const TODAS = ['chat', 'tasks', 'tools', 'memory', 'skills', 'mcp', 'history', 'settings'];

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
      await send('Runtime.evaluate', {
        expression: `(function(){ var b=document.querySelector('.navitem[data-view="${vista}"]'); if(b){b.click(); return true;} return false; })()`,
      });
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
