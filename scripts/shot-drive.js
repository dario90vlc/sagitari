'use strict';
/* Drive SAGITARI's renderer over CDP for README screenshots.
   Stages a demo conversation using the app's own rendering functions. */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9333;

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    ws.on('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
      },
    }));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.error('PAGE_NOT_FOUND', targets.map(t => t.url)); process.exit(1); }
  const c = await connect(page.webSocketDebuggerUrl);

  // Stage a demo conversation with the app's own bubble()/dayStamp()/scroll().
  const chatScript = `
    (() => {
      document.querySelector('[data-view="chat"]')?.click();
      const log = document.getElementById('messages');
      if (!log) return 'NO_CONTAINER';
      if (typeof bubble !== 'function') return 'NO_BUBBLE_FN';
      log.innerHTML = '';
      const say = (role, html) => { const b = bubble(role); b.innerHTML = html; };

      say('user', 'Ayúdame a organizar mi carpeta de Descargas: quiero separar instaladores, documentos e imágenes.');
      say('ai', 'He revisado <b>Descargas</b>: 214 archivos. Mi plan:<br><br>1. Crear <b>Instaladores</b>, <b>Documentos</b> e <b>Imágenes</b>.<br>2. Clasificar por extensión: <code>.exe/.msi</code> → Instaladores · <code>.pdf/.docx</code> → Documentos · <code>.png/.jpg</code> → Imágenes.<br>3. Ejecutar y darte un resumen.<br><br>¿Confirmas?');
      say('user', 'Adelante, ejecuta el plan.');
      say('ai', 'Hecho. <b>214 archivos</b> clasificados sin perder ninguno:<br><br>• <b>Instaladores</b> → 38&nbsp;&nbsp;• <b>Documentos</b> → 121&nbsp;&nbsp;• <b>Imágenes</b> → 55<br><br>Tiempo total: <b>42 s</b>. ¿Quieres que mueva los instaladores de más de 1 GB a la Papelera?');

      const ta = document.getElementById('chatInput');
      if (ta) { ta.value = ''; ta.style.height = 'auto'; }
      scroll();
      return 'OK msgs=' + log.querySelectorAll('.msg').length;
    })()
  `;
  const r1 = await c.send('Runtime.evaluate', { expression: chatScript, returnByValue: true });
  console.log('stage:', JSON.stringify(r1.result && r1.result.result && r1.result.result.value));
  await sleep(500);

  // Land on chat for the capture.
  await c.send('Runtime.evaluate', { expression: `document.querySelector('[data-view="chat"]')?.click()` });
  await sleep(600);

  console.log('DRIVE_OK');
  process.exit(0);
})().catch((e) => { console.error('DRIVE_FAIL', e.message); process.exit(1); });
