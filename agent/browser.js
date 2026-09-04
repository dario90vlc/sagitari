'use strict';

// Minimal Chrome DevTools Protocol client over raw WebSocket (no puppeteer).
// Works with Chrome and Edge ("msedge.exe").
//
// Design goals:
//  - ONE browser instance: launch() reuses an already-running debugged session
//    instead of spawning more windows (the "thousand windows" bug).
//  - Persistent profile: logins/cookies survive between sessions.
//  - Real tab management: new_tab / select_tab / close_tab / tabs, with an
//    "active tab" that every action targets.
//  - Load-aware: navigate waits for document.readyState before returning.
//  - Robust interaction: button finder with fallbacks, real mouse events,
//    proper text clearing/typing, extended keys, waits.

const { exec } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getJSON(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor() {
    this.ws = null;
    this.port = 0;
    this.browserExe = null;
    this.activeId = null;      // targetId of the tab every action targets
    this._id = 0;
    this._pending = new Map();
    // dedicated persistent profile (not tmp): logins survive restarts
    this.profileDir = path.join(process.env.APPDATA || os.homedir(), 'SagitariAI', 'browser-profile');
  }

  // ---------- discovery / connection ----------

  async alive() {
    // A debugged browser on our port answers /json quickly.
    try { const t = await getJSON(`http://127.0.0.1:${this.port}/json`, 1800); return Array.isArray(t) ? t : null; }
    catch { return null; }
  }

  async connect() {
    // Prefer the browser-wide endpoint (supports Target.* + sessions); fall
    // back to a page socket (modern Chrome treats it as a browser socket too).
    let url = null;
    try {
      const v = await getJSON(`http://127.0.0.1:${this.port}/json/version`, 1800);
      if (v && v.webSocketDebuggerUrl) url = v.webSocketDebuggerUrl;
    } catch {}
    if (!url) {
      const pages = await getJSON(`http://127.0.0.1:${this.port}/json`, 1800);
      const page = pages.find((t) => t.type === 'page');
      if (!page) throw new Error('El navegador no tiene pestañas.');
      url = page.webSocketDebuggerUrl;
    }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    this.ws.on('close', () => { if (this.ws) { try { this.ws.close(); } catch {} } this.ws = null; });
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

  async pages() {
    const t = await getJSON(`http://127.0.0.1:${this.port}/json`, 2500);
    return (Array.isArray(t) ? t : []).filter((p) => p.type === 'page' && !p.url.startsWith('devtools://'));
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  // The tab every action operates on: the selected one, or the first alive.
  async currentSession() {
    const list = await this.pages();
    if (!list.length) throw new Error('No hay pestañas abiertas. Usa action=launch o action=new_tab.');
    let page = list.find((p) => p.id === this.activeId);
    if (!page) { page = list[0]; this.activeId = page.id; }
    const sessionId = await this.attach(page.id);
    return { sessionId, target: page };
  }

  // ---------- lifecycle ----------

  async launch(browserArg, url) {
    const want = (browserArg || 'chrome').toLowerCase();

    // 1) Already connected? Just (maybe) navigate — never spawn a second window.
    if (this.ws) {
      if (url) { await this.currentSession(); return this.navigate(url); }
      const n = (await this.pages()).length;
      return `OK: el navegador ya está abierto (${n} pestaña${n === 1 ? '' : 's'}). Usa navigate, new_tab, select_tab…`;
    }

    // 2) A debugged instance on our remembered port is still alive → reconnect.
    if (this.port) {
      const t = await this.alive();
      if (t) {
        await this.connect();
        const pg = t.find((x) => x.type === 'page');
        if (pg) this.activeId = pg.id;
        if (url) return this.navigate(url);
        return `OK: reconectado al navegador abierto (puerto CDP ${this.port}).`;
      }
    }

    // 3) Fresh spawn (the only case where a new window appears).
    const find = (b) => {
      const cands = b === 'edge'
        ? [process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
        : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
           process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'];
      for (const c of cands) { if (c && fs.existsSync(c)) return c; }
      return null;
    };
    let exe = find(want);
    let used = want;
    if (!exe) { used = want === 'edge' ? 'chrome' : 'edge'; exe = find(used); }
    if (!exe) return 'Error: no encontré Chrome ni Edge instalado en este equipo.';

    this.port = 9223 + Math.floor(Math.random() * 500);
    fs.mkdirSync(this.profileDir, { recursive: true });
    const target = url || 'about:blank';
    const cmd = `"${exe}" --remote-debugging-port=${this.port} --user-data-dir="${this.profileDir}"` +
      ` --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble --start-maximized "${target}"`;
    require('child_process').exec(cmd, { windowsHide: true });
    this.browserExe = exe;
    this.activeId = null;

    let ok = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const t = await this.alive();
      if (t) { ok = true; break; }
    }
    if (!ok) return 'Error: el navegador no respondió al puerto de depuración.';
    await this.connect();

    const list = await this.pages();
    if (list.length) {
      this.activeId = list[0].id;
      if (url) { await sleep(600); return this.navigate(url); }
    }
    return `OK: navegador abierto (${used}, puerto CDP ${this.port})${url ? ', navegando a ' + url : ''}.`;
  }

  kill() {
    try { if (this.ws) this.send('Browser.close').catch(() => {}); } catch {}
    this.ws = null;
    this.activeId = null;
  }

  // ---------- helpers ----------

  async evalJs(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
    return r.result?.value;
  }

  // Wait until the active tab finishes loading (polls readyState; never hangs).
  async waitReady(sessionId, timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const st = await this.evalJs('document.readyState', sessionId);
        if (st === 'complete') { await sleep(400); return true; }
      } catch {}
      await sleep(300);
    }
    return false;
  }

  async navigate(url) {
    let u = String(url || '').trim();
    if (!u) return 'Error: falta la url.';
    if (!/^https?:\/\//i.test(u) && !/^(about|file|chrome):/i.test(u)) u = 'https://' + u;
    const { sessionId } = await this.currentSession();
    try { await this.send('Page.navigate', { url: u }, sessionId); } catch (e) {
      return 'Error al navegar: ' + e.message;
    }
    const loaded = await this.waitReady(sessionId);
    let title = '';
    try { title = (await this.evalJs('document.title', sessionId)) || ''; } catch {}
    return `OK: en «${title || u}»${loaded ? '' : ' (la página sigue cargando)'}\nURL: ${u}`;
  }

  async screenshot(sessionId, fullPage) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!fullPage }, sessionId);
    return 'data:image/png;base64,' + r.data;
  }

  // ---------- interaction ----------

  async findAndClick(selector, text, sessionId) {
    const js = `
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
        const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
        const label = e => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title || e.placeholder || '');
        const sel = ${JSON.stringify(selector || null)};
        const txt = ${JSON.stringify(text ? String(text).toLowerCase().trim() : null)};
        let el = null, how = '';
        if (sel) { el = document.querySelector(sel); how = 'selector'; }
        else if (txt) {
          const cand = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=tab],[role=link],[role=menuitem],[onclick],summary,label')].filter(visible);
          el = cand.find(e => label(e) === txt); how = 'texto exacto';
          if (!el) { el = cand.find(e => label(e).startsWith(txt)); how = 'inicio de texto'; }
          if (!el) { el = cand.find(e => label(e).includes(txt)); how = 'texto incluido'; }
        }
        if (!el || !visible(el)) return 'NOT_FOUND';
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          info: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || el.tagName).toString().replace(/\\s+/g,' ').trim().slice(0, 60),
          how
        });
      })()`;
    const res = await this.evalJs(js, sessionId);
    if (res === 'NOT_FOUND') {
      return 'Error: no encontré ningún elemento visible' + (text ? ` con texto «${text}»` : '') + (selector ? ` (selector ${selector})` : '') +
        '. Prueba action=screenshot para ver la página, o action=content para leerla.';
    }
    const { x, y, info, how } = JSON.parse(res);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await sleep(60);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
      await sleep(40);
    }
    await sleep(900); // dejar reaccionar a la página (menus, modales, navegación)
    return `OK: clic en «${info}» (${how}, ${x},${y})`;
  }

  async type(selector, text, clear, submit, sessionId) {
    const found = await this.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const tag = (el.tagName || '').toLowerCase();
      if (${clear} && (tag === 'input' || tag === 'textarea' || el.isContentEditable)) {
        if (typeof el.select === 'function' && tag !== 'textarea' && !el.isContentEditable) el.select();
        else { const d = document; const range = d.createRange(); range.selectNodeContents(el); const s = d.getSelection(); s.removeAllRanges(); s.addRange(range); }
        if (!el.isContentEditable && 'setRangeText' in el) { el.setRangeText(''); }
        else { const d = document; const s = d.getSelection(); if (s && s.rangeCount) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); s.getRangeAt(0).deleteContents(); } }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 'OK';
    })()`, sessionId);
    if (found === 'NOT_FOUND') return `Error: no encontré el campo ${selector}. Usa action=screenshot para ver la página.`;
    await sleep(120);
    if (text) await this.send('Input.insertText', { text: String(text) }, sessionId);
    await sleep(250);
    if (submit) {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' }, sessionId);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }, sessionId);
      await sleep(900);
      await this.waitReady(sessionId, 6000);
    }
    return `OK: texto escrito en ${selector}${submit ? ' y Enter pulsado' : ''}`;
  }

  // ---------- dispatcher ----------

  async handle(args) {
    const a = args.action;
    try {
      if (a === 'launch') return await this.launch(args.browser, args.url);
      if (a === 'close') {
        try { await this.send('Browser.close'); } catch {}
        this.kill();
        return 'OK: navegador cerrado.';
      }
      if (!this.ws) {
        // autocuración: si hay una instancia viva en nuestro puerto, reconnecta; si no, lanza
        if (this.port && (await this.alive())) { await this.connect(); }
        else return await this.launch(args.browser, args.url);
      }

      switch (a) {
        case 'navigate': return await this.navigate(args.url);

        case 'new_tab': {
          const { targetId } = await this.send('Target.createTarget', { url: args.url || 'about:blank' });
          this.activeId = targetId;
          if (args.url) await this.waitReady(await this.attach(targetId));
          return `OK: nueva pestaña abierta${args.url ? ' en ' + args.url : ''} y seleccionada.`;
        }

        case 'select_tab': {
          const list = await this.pages();
          if (!list.length) return 'Error: no hay pestañas abiertas.';
          let page = null;
          const q = args.tab;
          if (typeof q === 'number' && list[q - 1]) page = list[q - 1];
          else if (typeof q === 'string' && q.trim()) {
            const n = norm(q.toLowerCase());
            page = list.find(p => p.title && norm(p.title.toLowerCase()).includes(n))
                || list.find(p => p.url && p.url.toLowerCase().includes(n));
          }
          if (!page) return 'Error: no encontré esa pestaña («' + q + '»). Abiertas:\n' + list.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join('\n');
          this.activeId = page.id;
          return `OK: pestaña activa → «${page.title}» (${page.url}).`;
        }

        case 'close_tab': {
          const list = await this.pages();
          let id = this.activeId;
          if (typeof args.tab === 'number' && list[args.tab - 1]) id = list[args.tab - 1].id;
          else if (typeof args.tab === 'string' && args.tab.trim()) {
            const p = list.find(p => (p.title || '').toLowerCase().includes(args.tab.toLowerCase()) || (p.url || '').toLowerCase().includes(args.tab.toLowerCase()));
            if (p) id = p.id;
          }
          if (!id) return 'Error: no hay pestaña que cerrar.';
          await this.send('Target.closeTarget', { targetId: id });
          if (this.activeId === id) {
            const rest = await this.pages();
            this.activeId = rest.length ? rest[0].id : null;
          }
          return `OK: pestaña cerrada. Activas: ${(await this.pages()).length}.`;
        }

        case 'click': return await this.findAndClick(args.selector, args.text, await this.sessionIdOf());

        case 'type': return await this.type(args.selector, args.text, args.clear !== false, args.submit === true, await this.sessionIdOf());

        case 'press': {
          const map = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, PageDown: 34, PageUp: 33, Home: 36, End: 35, Space: 32 };
          const winCode = map[args.key];
          if (!winCode) return `Error: tecla no soportada: ${args.key}`;
          const def = { windowsVirtualKeyCode: winCode, code: args.key, key: args.key };
          if (args.key === 'Enter') def.text = '\r';
          const { sessionId } = await this.currentSession();
          await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def }, sessionId);
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
          await sleep(250);
          return `OK: tecla ${args.key}`;
        }

        case 'scroll': {
          const dir = args.direction === 'up' ? -1 : 1;
          const { sessionId } = await this.currentSession();
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: dir * (args.amount || 600)
          }, sessionId);
          await sleep(250);
          return 'OK: scroll ' + (dir > 0 ? 'abajo' : 'arriba');
        }

        case 'wait': {
          const ms = Math.min(Math.max(0, Number(args.ms) || 1000), 10000);
          await sleep(ms);
          return `OK: esperados ${ms} ms.`;
        }

        case 'content': {
          const { sessionId, target } = await this.currentSession();
          const expr = args.query
            ? `(() => { const el = document.querySelector(${JSON.stringify(args.query)}); return el ? el.innerText : 'NOT_FOUND'; })()`
            : `document.body.innerText`;
          const txt = await this.evalJs(expr, sessionId);
          if (txt === 'NOT_FOUND') return 'Error: selector no encontrado.';
          const clipped = String(txt).slice(0, 12000);
          return `Pestaña activa: ${target.title}\nURL: ${target.url}\n\n${clipped}${String(txt).length > 12000 ? '\n...[truncado]' : ''}`;
        }

        case 'eval': {
          const { sessionId } = await this.currentSession();
          const v = await this.evalJs(args.expression, sessionId);
          return 'Resultado: ' + (typeof v === 'string' ? v : JSON.stringify(v));
        }

        case 'screenshot': {
          const { sessionId, target } = await this.currentSession();
          const dataUrl = await this.screenshot(sessionId, args.fullPage === true);
          return { text: `Captura de «${target.title}» (${target.url}). Analízala junto a este resultado.`, images: [dataUrl] };
        }

        case 'tabs': {
          const list = await this.pages();
          if (!list.length) return 'Sin pestañas.';
          return list.map((t, i) => `${i + 1}. ${t.title} — ${t.url}${t.id === this.activeId ? '   ← activa' : ''}`).join('\n');
        }

        default:
          return `Acción desconocida: ${a}`;
      }
    } catch (e) {
      return 'Error: ' + e.message;
    }
  }

  async sessionIdOf() {
    const { sessionId } = await this.currentSession();
    return sessionId;
  }
}

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

module.exports = { Browser };
