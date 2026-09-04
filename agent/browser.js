'use strict';

// Minimal Chrome DevTools Protocol client over raw WebSocket (no puppeteer).
// Works with Chrome and Edge ("msedge.exe").

const { exec } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

function run(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: stdout || '' }));
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor() {
    this.ws = null;
    this.port = 0;
    this.browserExe = null;
    this._id = 0;
    this._pending = new Map();
    this.profileDir = path.join(os.tmpdir(), 'sagitari-cdp-profile');
  }

  async launch(browserArg) {
    if (this.ws) return 'El navegador ya está abierto.';
    const want = (browserArg || 'chrome').toLowerCase();
    let exe = null;
    let used = want;
    const find = (b) => {
      const cands = b === 'edge'
        ? [process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
        : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
           process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'];
      for (const c of cands) { if (c && fs.existsSync(c)) return c; }
      return null;
    };
    exe = find(want);
    if (!exe) { used = want === 'edge' ? 'chrome' : 'edge'; exe = find(used); }
    if (!exe) return 'Error: no encontré Chrome ni Edge instalado en este equipo.';

    // pick a free port
    this.port = 9223 + Math.floor(Math.random() * 500);
    const cmd = `"${exe}" --remote-debugging-port=${this.port} --user-data-dir="${this.profileDir}" --no-first-run --no-default-browser-check` +
      (want !== 'edge' ? ' --restore-last-session=false' : '');
    require('child_process').exec(cmd, { windowsHide: true });
    this.browserExe = exe;
    if (used !== want) this.lastNote = `( pediste ${want}, usé ${used} )`;

    let targets = null;
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      try { targets = await getJSON(`http://127.0.0.1:${this.port}/json`); break; } catch {}
    }
    if (!targets) return 'Error: el navegador no respondió al puerto de depuración.';
    const page = targets.find((t) => t.type === 'page') || targets[0];
    await this.connect(page.webSocketDebuggerUrl);
    return `OK: navegador abierto (${used}, puerto CDP ${this.port}). Pestañas: ${targets.filter(t => t.type === 'page').length}${this.lastNote ? ' ' + this.lastNote : ''}`;
  }

  async connect(url) {
    this.ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('Navegador no iniciado. Usa browser_control action=launch.'));
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }

  async currentSession() {
    const targets = await getJSON(`http://127.0.0.1:${this.port}/json`);
    const page = targets.filter((t) => t.type === 'page').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    if (!page) throw new Error('No hay pestañas abiertas.');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.id, flatten: true });
    return { sessionId, target: page };
  }

  async evalJs(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
    return r.result?.value;
  }

  async screenshot(sessionId) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    return 'data:image/png;base64,' + r.data;
  }

  async findAndClick(selector, text, sessionId) {
    const js = `
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
        let el = null;
        const sel = ${JSON.stringify(selector || null)};
        const txt = ${JSON.stringify(text ? String(text).toLowerCase() : null)};
        if (sel) { el = document.querySelector(sel); }
        else if (txt) {
          const cand = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],[onclick],summary,label,li,span,div')];
          el = cand.find(e => norm(e.innerText || e.value) === txt) || cand.find(e => norm(e.innerText || e.value).includes(txt));
        }
        if (!el) return 'NOT_FOUND';
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`;
    const res = await this.evalJs(js, sessionId);
    if (res === 'NOT_FOUND') return 'Error: no encontré el elemento' + (text ? ` "${text}"` : '') + (selector ? ` (${selector})` : '') + '.';
    const { x, y } = JSON.parse(res);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    }
    return `OK: clic en (${x}, ${y})`;
  }

  async handle(args) {
    const a = args.action;
    try {
      if (a === 'launch') return await this.launch(args.browser);
      if (!this.ws) return 'Error: el navegador no está iniciado. Primero llama a browser_control con action="launch" y una url.';
      const { sessionId, target } = await this.currentSession();

      switch (a) {
        case 'navigate':
          await this.send('Page.navigate', { url: args.url }, sessionId);
          await sleep(1800);
          return `OK: navegando a ${args.url}`;
        case 'click':
          return await this.findAndClick(args.selector, args.text, sessionId);
        case 'type': {
          await this.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return 'NOT_FOUND'; el.focus(); return 'OK'; })()`, sessionId);
          for (const ch of String(args.text ?? '')) {
            await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch }, sessionId);
            await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch }, sessionId);
          }
          return 'OK: texto escrito';
        }
        case 'press': {
          const map = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8, PageDown: 34, PageUp: 33 };
          const winCode = map[args.key];
          const keyDef = winCode ? { windowsVirtualKeyCode: winCode, code: args.key, key: args.key } : { key: args.key, code: args.key };
          await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyDef }, sessionId);
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyDef }, sessionId);
          return `OK: tecla ${args.key}`;
        }
        case 'scroll': {
          const dir = args.direction === 'up' ? -1 : 1;
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: dir * (args.amount || 600)
          }, sessionId);
          return 'OK: scroll';
        }
        case 'content': {
          const expr = args.query
            ? `(() => { const el = document.querySelector(${JSON.stringify(args.query)}); return el ? el.innerText : 'NOT_FOUND'; })()`
            : `document.body.innerText`;
          const txt = await this.evalJs(expr, sessionId);
          if (txt === 'NOT_FOUND') return 'Error: selector no encontrado.';
          const clipped = String(txt).slice(0, 12000);
          return `Título: ${target.title}\nURL: ${target.url}\n\n${clipped}${String(txt).length > 12000 ? '\n...[truncado]' : ''}`;
        }
        case 'eval': {
          const v = await this.evalJs(args.expression, sessionId);
          return 'Resultado: ' + (typeof v === 'string' ? v : JSON.stringify(v));
        }
        case 'screenshot': {
          const dataUrl = await this.screenshot(sessionId);
          return { text: `Captura de ${target.title} (${target.url}). Analízala junto a este resultado.`, images: [dataUrl] };
        }
        case 'tabs': {
          const ts = await getJSON(`http://127.0.0.1:${this.port}/json`);
          return ts.filter(t => t.type === 'page').map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join('\n') || 'Sin pestañas.';
        }
        case 'close': {
          try { await this.send('Browser.close'); } catch {}
          this.ws = null;
          return 'OK: navegador cerrado.';
        }
        default:
          return `Acción desconocida: ${a}`;
      }
    } catch (e) {
      return 'Error: ' + e.message;
    }
  }
}

module.exports = { Browser };
