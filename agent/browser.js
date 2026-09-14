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

const { spawn } = require('child_process');
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

/* Acciones válidas de browser_control. Se valida ANTES de la autocuración: un
   nombre mal escrito (o alucinado por el modelo) llegaba al `if (!this.ws)` y
   acababa lanzando un Chrome nuevo para luego responder «acción desconocida». */
const ACTIONS = new Set(['launch', 'profile', 'close', 'navigate', 'new_tab', 'select_tab', 'close_tab',
  'elements', 'click_index', 'click', 'type', 'press', 'scroll', 'wait', 'content', 'eval', 'screenshot', 'tabs']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* v1.5: perfiles de navegador — cada perfil tiene SU propia carpeta de datos
   (cookies, sesiones, logins) bajo %APPDATA%/SagitariAI/browser-profiles/<id>. */
const { profileId, ensureProfileDir } = require('./browser-profiles');

class Browser {
  constructor() {
    this.ws = null;
    this.port = 0;
    this.activeId = null;      // targetId of the tab every action targets
    this.profile = profileId('default');  // v1.5: id canónico del perfil activo
    this._id = 0;
    this._pending = new Map();
    this._events = new Map();   // method -> esperadores de eventos CDP
    this._sessions = new Map(); // targetId -> sessionId (una sesión por pestaña)
    this.browserPid = null;     // pid del navegador lanzado (para matar el árbol)
    // Inventario de `elements()` y de qué ejecución es: sus coordenadas son
    // relativas al viewport de UNA página, así que un inventario viejo o de otra
    // ejecución no puede servir para clicar.
    this._lastElements = null;
    this._invOwner = null;
    this._queue = Promise.resolve();   // una acción de navegador a la vez (ver handle)
    // carpeta de datos del perfil activo (persistentes: los logins sobreviven)
    this.profileDir = ensureProfileDir('default');
  }

  /** Cambia de perfil: cierra la sesión actual si procede; el próximo launch usa ese perfil. */
  async switchProfile(profile) {
    const id = profileId(profile);
    const label = String(profile || 'default');
    if (id === this.profile && this.ws) return `OK: ya estás en el perfil «${label}».`;
    if (this.ws) {
      try { await this.send('Browser.close'); } catch {}
      try { this.ws.close(); } catch {}
      this._rejectPending('Cambiando de perfil.');
    }
    // El estado del navegador anterior se olvida SIEMPRE, haya socket vivo o no:
    // su puerto y su PID no valen para el perfil nuevo. (Antes solo se limpiaban
    // con el socket abierto, así que un cambio de perfil tras un cierre brusco
    // dejaba un PID viejo que kill() podía disparar contra otro proceso.)
    this.ws = null; this.activeId = null; this.port = 0;
    this._sessions.clear();
    this._lastElements = null;
    this.browserPid = null;
    this.profile = id;
    this.profileDir = ensureProfileDir(profile);   // el dir se deriva del nombre original, no del id ya hasheado
    return `OK: perfil activo → «${label}». Se abrirá (con sus propias cookies y sesiones) en el próximo launch.`;
  }

  // ---------- discovery / connection ----------

  /**
   * Puerto CDP que Chrome dejó escrito en el perfil (`DevToolsActivePort`).
   * Sobrevive a un cierre brusco de SAGITARI, así que es la única forma de
   * recuperar un navegador huérfano que sigue usando nuestro perfil.
   */
  _portFromProfile() {
    try {
      const raw = fs.readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8');
      const n = Number(String(raw).split(/\r?\n/)[0].trim());
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
    } catch { return 0; }
  }

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
    this._sessions.clear();   // una conexión nueva invalida todas las sesiones CDP cacheadas
    const sock = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    this.ws = sock;
    try {
      await new Promise((res, rej) => {
        // Con deadline propio: si el extremo acepta el TCP pero no completa el
        // upgrade, 'open' no llega nunca y la herramienta se quedaba «cargando»
        // para siempre (ws solo aplica timeout si se le pasa handshakeTimeout).
        const timer = setTimeout(() => { cleanup(); rej(new Error('CDP: el navegador no completó la conexión en 15 s.')); }, 15000);
        const cleanup = () => { clearTimeout(timer); sock.off('open', onOpen); sock.off('error', onErr); };
        const onOpen = () => { cleanup(); res(); };
        const onErr = (e) => { cleanup(); rej(e); };
        sock.once('open', onOpen);
        sock.once('error', onErr);
      });
    } catch (e) {
      try { sock.close(); } catch {}
      if (this.ws === sock) this.ws = null;
      throw e;
    }
    // Listener 'error' PERMANENTE: tras el handshake, un error de socket (Chrome
    // cerrado, RST) sin handler lanzaría una excepción no capturada y tumbaría
    // el proceso principal de Electron.
    sock.on('error', () => {});
    sock.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this._emitEvent(msg.method, msg.params, msg.sessionId);
      }
    });
    sock.on('close', () => {
      // Solo el socket vigente limpia el estado: el cierre tardío de un socket
      // viejo no debe anular una reconexión recién establecida.
      if (this.ws !== sock) return;
      this.ws = null;
      this._sessions.clear();
      this._rejectPending('Navegador desconectado.');
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('Navegador no iniciado. Usa browser_control action=launch.'));
      const id = ++this._id;
      // el temporizador se cancela al resolverse: si no, cada comando CDP dejaba
      // un timer vivo 30 s más (cientos en una sesión de automatización larga)
      let timer = null;
      const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this._pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); return reject(e); }
      timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }

  /** Rechaza y vacía todas las peticiones en vuelo (cierre de socket, kill, etc.). */
  _rejectPending(reason) {
    for (const { reject } of this._pending.values()) {
      try { reject(new Error(reason)); } catch {}
    }
    this._pending.clear();
  }

  /** Notifica a los esperadores de un evento CDP (p. ej. Page.loadEventFired). */
  _emitEvent(method, params, sessionId) {
    const set = this._events.get(method);
    if (!set) return;
    for (const w of [...set]) {
      if (w.sessionId && sessionId && w.sessionId !== sessionId) continue;
      this._events.get(method)?.delete(w);
      clearTimeout(w.timer);
      w.resolve({ params, sessionId });
    }
  }

  /** Espera un evento CDP; resuelve null si vence `timeoutMs` (red de seguridad). */
  waitEvent(method, timeoutMs = 5000, sessionId) {
    return new Promise((resolve) => {
      let set = this._events.get(method);
      if (!set) { set = new Set(); this._events.set(method, set); }
      const w = { sessionId, timer: null, resolve: (v) => { this._events.get(method)?.delete(w); resolve(v); } };
      w.timer = setTimeout(() => w.resolve(null), timeoutMs);
      set.add(w);
    });
  }

  async pages() {
    const t = await getJSON(`http://127.0.0.1:${this.port}/json`, 2500);
    return (Array.isArray(t) ? t : []).filter((p) => p.type === 'page' && !p.url.startsWith('devtools://'));
  }

  async attach(targetId) {
    // Reutiliza la sesión ya adjunta a este target (evita attach huérfano por acción).
    const cached = this._sessions.get(targetId);
    if (cached) return cached;
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this._sessions.set(targetId, sessionId);
    return sessionId;
  }

  /** Libera la sesión CDP de un target (al cerrar su pestaña o al dejar de ser la activa). */
  async detach(targetId) {
    const sessionId = this._sessions.get(targetId);
    if (!sessionId) return;
    this._sessions.delete(targetId);
    try { await this.send('Target.detachFromTarget', { sessionId }); } catch {}
  }

  // The tab every action operates on: the selected one, or the first alive.
  async currentSession() {
    const list = await this.pages();
    if (!list.length) throw new Error('No hay pestañas abiertas. Usa action=launch o action=new_tab.');
    let page = list.find((p) => p.id === this.activeId);
    if (!page) {
      const stale = this.activeId;
      page = list[0];
      this.activeId = page.id;
      if (stale) await this.detach(stale);   // la pestaña activa ya no existe: libera su sesión
    }
    const sessionId = await this.attach(page.id);
    return { sessionId, target: page };
  }

  // ---------- lifecycle ----------

  async launch(browserArg, url) {
    const want = (browserArg || 'chrome').toLowerCase();
    fs.mkdirSync(this.profileDir, { recursive: true });   // asegura el perfil activo

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

    // 2b) Un navegador huérfano (Electron murió sin cerrarlo) sigue vivo con
    //     nuestro perfil bloqueado: al reabrir, Chrome delega en esa instancia y
    //     NO abre puerto nuevo, así que el arranque acababa en «no respondió al
    //     puerto de depuración» con el zombie inalcanzable. Chrome deja el puerto
    //     en DevToolsActivePort dentro del perfil: se lee y se reconecta.
    if (!this.port) {
      const discovered = this._portFromProfile();
      if (discovered) {
        this.port = discovered;
        if (await this.alive()) {
          await this.connect();
          const pg = (await this.pages()).find((x) => x.type === 'page');
          if (pg) this.activeId = pg.id;
          if (url) return this.navigate(url);
          return `OK: reconectado al navegador que ya estaba abierto (puerto CDP ${this.port}).`;
        }
        this.port = 0;
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
    const target = url || 'about:blank';
    // spawn + array de argumentos (sin shell): comillas, &, | o ^ de la ruta o la
    // URL no pueden inyectar comandos en cmd.exe.
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
      '--start-maximized', target,
    ];
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});   // nunca dejar una excepción no capturada
    this.browserPid = child.pid;
    this.activeId = null;

    // Sondeo corto de condición (el puerto CDP responde) con timeout de ~9 s.
    const spawnDeadline = Date.now() + 9000;
    let ok = false;
    while (Date.now() < spawnDeadline) {
      await sleep(250);
      if (await this.alive()) { ok = true; break; }
    }
    if (!ok) return 'Error: el navegador no respondió al puerto de depuración.';
    await this.connect();

    const list = await this.pages();
    if (list.length) {
      this.activeId = list[0].id;
      if (url) return this.navigate(url);   // navigate ya espera la carga (waitReady)
    }
    return `OK: navegador abierto (${used}, puerto CDP ${this.port})${url ? ', navegando a ' + url : ''}.`;
  }

  kill() {
    try {
      if (this.ws) { this.send('Browser.close').catch(() => {}); this.ws.close(); }
    } catch {}
    // Mata el árbol del proceso lanzado (Chrome abre hijos; taskkill /T los alcanza).
    if (this.browserPid) {
      try { spawn('taskkill', ['/PID', String(this.browserPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      this.browserPid = null;
    }
    this.ws = null;
    this.activeId = null;
    this._sessions.clear();
    this._rejectPending('Navegador cerrado.');
  }

  // ---------- helpers ----------

  async evalJs(expression, sessionId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
    return r.result?.value;
  }

  // Espera a que la pestaña cargue: evento Page.loadEventFired y, como respaldo,
  // sondeo corto de readyState. `timeoutMs` es la red de seguridad.
  async waitReady(sessionId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    const ev = this.waitEvent('Page.loadEventFired', timeoutMs, sessionId);
    let fired = false;
    ev.then((v) => { if (v) fired = true; });
    while (Date.now() < deadline) {
      try { if (await this.evalJs('document.readyState', sessionId) === 'complete') return true; } catch {}
      if (fired) return true;
      await Promise.race([ev, sleep(150)]);
    }
    return false;
  }

  // Deja que la página reaccione a una acción (menús, modales, navegación) sin
  // sleeps fijos: observa mutaciones del DOM y espera un periodo de calma; si la
  // acción navega, el documento nuevo se considera listo al completar la carga.
  async settle(sessionId, timeoutMs = 1500, quietMs = 250) {
    try {
      await this.evalJs(`(() => {
        if (window.__sagitariObs) return;
        window.__sagitariObs = true;
        window.__sagitariLastMutation = Date.now();
        try {
          new MutationObserver(() => { window.__sagitariLastMutation = Date.now(); })
            .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch {}
      })()`, sessionId);
    } catch {}
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(80);
      try {
        const idle = await this.evalJs(
          `document.readyState === 'complete' && (Date.now() - (window.__sagitariLastMutation || 0)) > ${quietMs}`,
          sessionId);
        if (idle) return true;
      } catch {}
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
    // el inventario de elements() ya no vale: sus coordenadas son de otra página
    this._lastElements = null;
    let title = '';
    try { title = (await this.evalJs('document.title', sessionId)) || ''; } catch {}
    return `OK: en «${title || u}»${loaded ? '' : ' (la página sigue cargando)'}\nURL: ${u}`;
  }

  // Captura en JPEG y acotada (máx. 1280 px de ancho, 2400 de alto): un PNG a
  // resolución completa cuesta muchísimos más tokens que un JPEG reducido.
  async screenshot(sessionId, fullPage) {
    const MAX_SHOT_W = 1280, MAX_SHOT_H = 2400, QUALITY = 60;
    let x = 0, y = 0, w = 0, h = 0;
    try {
      const m = await this.send('Page.getLayoutMetrics', {}, sessionId);
      if (fullPage) {
        const c = m.cssContentSize || m.contentSize || {};
        w = Math.round(c.width || 0); h = Math.round(c.height || 0);
      } else {
        const v = m.cssVisualViewport || m.visualViewport || {};
        x = Math.round(v.pageX || 0); y = Math.round(v.pageY || 0);
        w = Math.round(v.clientWidth || v.width || 0); h = Math.round(v.clientHeight || v.height || 0);
      }
    } catch {}
    if (!w || !h) { w = MAX_SHOT_W; h = fullPage ? MAX_SHOT_H : 800; }
    const scale = Math.min(w > MAX_SHOT_W ? MAX_SHOT_W / w : 1, h > MAX_SHOT_H ? MAX_SHOT_H / h : 1);
    const r = await this.send('Page.captureScreenshot', {
      format: 'jpeg', quality: QUALITY, captureBeyondViewport: !!fullPage,
      clip: { x, y, width: w, height: h, scale },
    }, sessionId);
    return 'data:image/jpeg;base64,' + r.data;
  }

  // ---------- v1.5: percepción visual avanzada (DOM + bounding boxes) ----------

  /** Inventario clicable/legible de la página con índices estables y coordenadas:
      el modelo puede actuar con click_index sin selectores ni capturas a ciegas. */
  async elements(sessionId, ownerId) {
    const js = `
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim();
        const visible = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.top >= 0 && r.left >= 0 && r.bottom <= (window.innerHeight||800) + 200 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
        const sel = 'a,button,input,select,textarea,[role=button],[role=tab],[role=link],[role=menuitem],[role=checkbox],[role=radio],summary,label,[onclick]';
        const out = [];
        for (const e of document.querySelectorAll(sel)) {
          if (!visible(e)) continue;
          const r = e.getBoundingClientRect();
          const label = norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title || e.placeholder || e.alt || '');
          const type = (e.tagName || '').toLowerCase() + (e.getAttribute('role') ? ':' + e.getAttribute('role') : '');
          out.push({
            tag: type,
            text: label.slice(0, 80),
            id: e.id || undefined,
            name: e.name || undefined,
            href: (e.tagName === 'A' && e.href) ? e.href.slice(0, 120) : undefined,
            x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
            w: Math.round(r.width), h: Math.round(r.height),
          });
          if (out.length >= 80) break;
        }
        return JSON.stringify({ url: location.href, title: document.title, count: out.length, elements: out });
      })()`;
    const raw = await this.evalJs(js, sessionId);
    let data;
    try { data = JSON.parse(raw); } catch { return 'Error: no pude analizar la página.'; }
    if (!data.elements || !data.elements.length) return 'Sin elementos interactivos visibles. Prueba action=screenshot o action=content.';
    this._lastElements = data.elements;   // índices válidos hasta la próxima navegación
    this._invOwner = ownerId || null;     // …y solo para la ejecución que los pidió
    const lines = data.elements.map((e, i) => {
      const bits = [`${i}: <${e.tag}>`];
      if (e.text) bits.push(`"${e.text}"`);
      if (e.id) bits.push(`#${e.id}`);
      if (e.href) bits.push(`→ ${e.href}`);
      bits.push(`(${e.x},${e.y} ${e.w}x${e.h})`);
      return bits.join(' ');
    });
    return `Página: ${data.title}\nURL: ${data.url}\nElementos interactivos (${data.count}):
${lines.join('\n')}

Usa action=click_index con estos índices, o selector/text como antes.`;
  }

  /** Etiqueta del elemento que ocupa ese índice en el último inventario.
      La usa el motor de permisos: por índice no se sabe qué se está pulsando, y
      un clic que compra o borra no puede depender de que el modelo lo diga. */
  labelForIndex(idx) {
    const el = (this._lastElements || [])[Number(idx)];
    if (!el) return '';
    return [el.text, el.id, el.name, el.href, el.tag].filter(Boolean).join(' ').slice(0, 160);
  }

  /** Clic por índice del último inventory de elements(). */
  async clickIndex(idx, sessionId, ownerId) {
    // El inventario es de una ejecución concreta: si es de otra, sus coordenadas
    // apuntan a la página de la otra y el clic caería donde no debe.
    if (this._invOwner && ownerId && this._invOwner !== ownerId) {
      return 'Error: el inventario que tienes es de otra ejecución del agente. Ejecuta action=elements otra vez antes de clicar.';
    }
    const el = (this._lastElements || [])[Number(idx)];
    if (!el) return `Error: índice ${idx} inválido. Ejecuta action=elements para ver los índices actuales.`;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: el.x, y: el.y }, sessionId);
    await sleep(50);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: el.x, y: el.y, button: 'left', clickCount: 1 }, sessionId);
      await sleep(40);
    }
    await this.settle(sessionId, 1200);   // deja reaccionar (menús, modales, navegación)
    // la página puede haber cambiado: los índices anteriores ya no son fiables
    // (pulsar «el de antes» con coordenadas viejas es peor que volver a inventariar)
    this._lastElements = null;
    return `OK: clic por índice ${idx} en «${el.text || el.tag}» (${el.x},${el.y})`;
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
    await this.settle(sessionId, 1500); // deja reaccionar a la página (menús, modales, navegación)
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
        // select() también vale para textarea: la rama del Range no toca su
        // selección interna, así que setRangeText('') no borraba nada y el texto
        // nuevo se insertaba en el cursor dejando el viejo detrás
        if (typeof el.select === 'function' && !el.isContentEditable) el.select();
        else { const d = document; const range = d.createRange(); range.selectNodeContents(el); const s = d.getSelection(); s.removeAllRanges(); s.addRange(range); }
        if (!el.isContentEditable && 'setRangeText' in el) { el.setRangeText(''); }
        else if (!el.isContentEditable) { el.value = ''; }
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
      await this.settle(sessionId, 1500);
      await this.waitReady(sessionId, 6000);
      this._lastElements = null;   // enviar puede haber cambiado la página
    }
    return `OK: texto escrito en ${selector}${submit ? ' y Enter pulsado' : ''}`;
  }

  // ---------- dispatcher ----------

  /**
   * Punto de entrada de browser_control. `ownerId` identifica a la ejecución que
   * pide la acción (el agente del chat o una tarea de background).
   *
   * Serializado a propósito: hay UN navegador para toda la app y el estado que
   * decide dónde se hace clic (pestaña activa, inventario) es global. Sin la cola,
   * dos agentes a la vez se pisaban: el elements() de uno invalidaba el del otro y
   * su clic_index se despachaba contra la pestaña del otro.
   */
  async handle(args, ownerId) {
    const run = () => this._handle(args, ownerId);
    const next = this._queue.then(run, run);
    this._queue = next.then(() => {}, () => {});   // un fallo no rompe la cola
    return next;
  }

  async _handle(args, ownerId) {
    const a = args.action;
    if (!ACTIONS.has(a)) return `Acción desconocida: ${a}. Válidas: ${[...ACTIONS].join(', ')}.`;
    let retried = false;
    try {
      if (a === 'launch') return await this.launch(args.browser, args.url);
      if (a === 'profile') return await this.switchProfile(args.profile);
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
          if (this.activeId && this.activeId !== targetId) await this.detach(this.activeId);
          this.activeId = targetId;
          this._lastElements = null; this._invOwner = null;   // otra pestaña: otros índices
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
          if (this.activeId && this.activeId !== page.id) await this.detach(this.activeId);
          this.activeId = page.id;
          this._lastElements = null; this._invOwner = null;   // otra pestaña: otros índices
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
          await this.detach(id);   // libera la sesión CDP antes de cerrar el target
          await this.send('Target.closeTarget', { targetId: id });
          if (this.activeId === id) {
            const rest = await this.pages();
            this.activeId = rest.length ? rest[0].id : null;
            this._lastElements = null; this._invOwner = null;   // otra pestaña: otros índices
          }
          return `OK: pestaña cerrada. Activas: ${(await this.pages()).length}.`;
        }

        case 'elements': {
          const { sessionId } = await this.currentSession();
          const inv = await this.elements(sessionId, ownerId);
          // La captura solo se adjunta si el modelo la pide explícitamente
          // (screenshot:true): así no se paga una imagen en cada inventario.
          if (args.screenshot === true) {
            try {
              const dataUrl = await this.screenshot(sessionId, false);
              return { text: inv + '\n[Captura de la página adjunta para análisis visual]', images: [dataUrl] };
            } catch {}
          }
          return inv;
        }

        case 'click_index': return await this.clickIndex(args.index, await this.sessionIdOf(), ownerId);

        case 'click': return await this.findAndClick(args.selector, args.text, await this.sessionIdOf());

        case 'type': return await this.type(args.selector, args.text, args.clear !== false, args.submit === true, await this.sessionIdOf());

        case 'press': {
          const map = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, PageDown: 34, PageUp: 33, Home: 36, End: 35, Space: 32 };
          const winCode = map[args.key];
          if (!winCode) return `Error: tecla no soportada: ${args.key}`;
          const def = { windowsVirtualKeyCode: winCode, code: args.key, key: args.key };
          if (args.key === 'Enter') def.text = '\r';
          // sin `text` el navegador no ejecuta la acción de carácter: pulsar Space
          // no insertaba el espacio ni activaba el botón con foco
          if (args.key === 'Space') { def.key = ' '; def.text = ' '; }
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
          // las coordenadas del inventario son relativas al viewport: tras
          // desplazar la página apuntan a otro sitio
          this._lastElements = null; this._invOwner = null;
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
      // La sesión CDP cacheada de una pestaña puede dejar de existir (el usuario
      // la cerró a mano, o recargó el target). Antes se devolvía el error crudo
      // «Session with given id not found»; ahora se invalida la caché y se
      // reintenta UNA vez, que es lo que la autocuración promete.
      if (!retried && /session with given id/i.test(String(e && e.message))) {
        retried = true;
        this._sessions.clear();
        return this.handle(args);
      }
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
