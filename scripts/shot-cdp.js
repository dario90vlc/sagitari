'use strict';

/* ============================================================================
   shot-cdp.js — capturas de la interfaz de SAGITARI por el protocolo de
   depuración de Chromium (CDP).

   Por qué CDP y no PrintWindow: los píxeles son exactos (sin marco de ventana,
   sin composición del escritorio, sin dependencia de que la ventana esté
   visible) y se puede cambiar de vista con el mismo proceso.

   Uso:
     node scripts/shot-cdp.js [dir] [vistas] [ancho] [alto] [--demo]

   vistas: lista separada por comas (chat, tasks, projects, agents, memory,
   skills, mcp, tools, history, settings) o «all». Por defecto: chat.

   --demo siembra una conversación de verdad antes de fotografiar el chat. Sin
   ella, shots/chat.png es el estado vacío: no enseña la interfaz.
   ============================================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const APP_DIR = path.join(__dirname, '..');
const TODAS = ['chat', 'tasks', 'projects', 'agents', 'memory', 'skills', 'mcp', 'tools', 'history', 'settings'];

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

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
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
        quedan--;
        continue;
      }
      await sleep(900);
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
