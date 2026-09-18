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
  'elements', 'click_index', 'click', 'type', 'press', 'scroll', 'wait', 'content', 'eval', 'screenshot', 'tabs',
  // v2.5 «navegador 2»: actuar como una persona y no a ciegas
  'hover', 'select', 'check', 'hotkey', 'upload', 'wait_for', 'logs', 'back', 'forward', 'reload', 'dialog']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================
   v2.5 — NAVEGADOR 2

   La v1.5 sabía lo justo: un inventario de elementos por coordenadas y cuatro
   acciones. Sobre webs de verdad se quedaba corta en cinco sitios, todos vistos
   en uso real:

   1. NOMBRES. El inventario usaba `innerText` a secas: un botón de icono salía
      con cadena vacía y el modelo clicaba por índice a ciegas. Ahora se calcula
      el nombre ACCESIBLE (aria-label, aria-labelledby, <label for>, alt, title,
      placeholder, data-testid, value de submit) y se marca el rol real.
   2. SHADOW DOM e IFRAMES del mismo origen: la mitad de las interfaces de hoy
      (componentes web, editores embebidos, formularios dentro de un iframe)
      eran INVISIBLES para el inventario.
   3. LO QUE ESTÁ FUERA DE PANTALLA se tiraba: el modelo tenía que adivinar el
      scroll. Ahora va marcado `[fuera de pantalla]` y el clic lo trae a la vista
      antes de pulsar.
   4. ESTABILIDAD. Un clic con coordenadas viejas (menú que se cierra, barra que
      aparece, animación a medias) caía donde no debía. Ahora, antes de pulsar, se
      comprueba que el elemento sigue ahí (por su HUELLA, no por la posición), que
      ha dejado de moverse y que nadie lo tapa; si lo tapa algo, se dice QUÉ lo tapa.
   5. ESPERAS. `wait` dormía a ciegas: o sobraba tiempo o faltaba. `wait_for`
      espera a que aparezca un texto, un selector, una URL o desaparezca algo.

   Y lo que faltaba por completo: diálogos (alert/confirm/prompt bloquean la
   página), descargas (hay que decir dónde cae el archivo), consola y errores de
   red (depurar una web que hace el agente mismo), atajos de teclado, subir
   archivos, elegir en un <select>, marcar casillas, hover y volver/avanzar.
   ============================================================================ */

/* Nombre accesible + rol + huella + acción segura, inyectado EN la página.
   Se inyecta una vez por documento (tras navegar, `window` es nuevo y se vuelve a
   inyectar solo). Todo lo que necesitan el inventario y las acciones vive aquí. */
const HELPERS_JS = `(() => {
  if (window.__sagReady) return 'ready';
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[role=textbox],[role=searchbox],[role=spinbutton],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const vis = (e) => { try { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; } catch (err) { return false; } };
  const roleOf = (e) => {
    const r = e.getAttribute && e.getAttribute('role');
    if (r) return norm(r).toLowerCase();
    const t = (e.tagName || '').toLowerCase();
    const ty = ((e.getAttribute && e.getAttribute('type')) || '').toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : ty === 'file' ? 'file'
      : (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') ? 'button' : 'textbox';
    if (e.isContentEditable) return 'textbox';
    return t || 'generic';
  };
  /* Nombre accesible: lo que un lector de pantalla anunciaría. El orden importa:
     aria-label, aria-labelledby, <label for>, texto propio, y por último pistas. */
  const nameOf = (e) => {
    const aria = norm(e.getAttribute && e.getAttribute('aria-label'));
    if (aria) return aria;
    const ref = e.getAttribute && e.getAttribute('aria-labelledby');
    if (ref) {
      const t = norm(ref.split(/\\s+/).map((id) => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' '));
      if (t) return t;
    }
    if (e.id) {
      try { const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]'); if (l && norm(l.textContent)) return norm(l.textContent); } catch (err) {}
    }
    const role = roleOf(e);
    const own = norm(e.innerText || '');
    if (own && role !== 'textbox') return own;
    if (role === 'button') { const v = norm(e.getAttribute && e.getAttribute('value')); if (v) return v; }
    const hint = norm(e.getAttribute && (e.getAttribute('data-testid') || e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('placeholder')));
    if (hint) return hint;
    if (own) return own;
    const kid = e.querySelector ? e.querySelector('img[alt],svg title,[aria-label],[title]') : null;
    if (kid) return norm((kid.getAttribute && (kid.getAttribute('alt') || kid.getAttribute('aria-label') || kid.getAttribute('title'))) || kid.textContent);
    return norm(e.name || '');
  };
  const fpOf = (e) => (roleOf(e) + '|' + (e.id || '') + '|' + nameOf(e)).slice(0, 140);
  const cssPath = (e) => {
    const parts = [];
    let n = e;
    for (let i = 0; n && n.nodeType === 1 && i < 6; i++) {
      let s = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\\w-]*$/.test(n.id)) { parts.unshift(s + '#' + n.id); break; }
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
      n = p;
    }
    return parts.join(' > ');
  };
  /* Recorre shadow roots e iframes del mismo origen: sin esto, media interfaz
     moderna no existe para el inventario. El desplazamiento acumula los marcos. */
  const collect = (root, offset, frames) => {
    const out = [];
    let nodes = [];
    try { nodes = [...root.querySelectorAll(SEL)]; } catch (err) { nodes = []; }
    for (const e of nodes) {
      if (!vis(e)) continue;
      let r; try { r = e.getBoundingClientRect(); } catch (err) { continue; }
      out.push({
        el: e,
        x: Math.round(offset.x + r.left + r.width / 2),
        y: Math.round(offset.y + r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        role: roleOf(e), name: nameOf(e).slice(0, 90), fp: fpOf(e),
        id: e.id || '', type: ((e.getAttribute && e.getAttribute('type')) || '').toLowerCase(),
        disabled: e.disabled === true || e.getAttribute('aria-disabled') === 'true',
        checked: typeof e.checked === 'boolean' ? e.checked : undefined,
        value: (e.tagName === 'SELECT' || e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') ? String(e.value || '').slice(0, 60) : '',
        required: e.required === true,
        testid: (e.getAttribute && e.getAttribute('data-testid')) || '',
        css: cssPath(e), frame: frames || '',
        off: (offset.y + r.top) + r.height < 0 || (offset.y + r.top) > (window.innerHeight || 0),
        top: offset.y + r.top,
      });
    }
    // componentes web
    try {
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length && i < 4000; i++) {
        const sr = all[i].shadowRoot;
        if (sr) out.push(...collect(sr, offset, frames));
      }
    } catch (err) {}
    // iframes del mismo origen (los de otro origen no se pueden leer desde aquí)
    try {
      for (const f of root.querySelectorAll('iframe')) {
        let d = null;
        try { d = f.contentDocument; } catch (err) { d = null; }
        if (!d || !d.querySelectorAll) { if (frames !== null) frames.ext++; continue; }
        const fr = f.getBoundingClientRect();
        const label = norm(f.getAttribute('title') || f.getAttribute('name') || f.getAttribute('src') || 'iframe').slice(0, 40);
        out.push(...collect(d, { x: offset.x + fr.left, y: offset.y + fr.top }, frames));
      }
    } catch (err) {}
    return out;
  };
  /* Deja el elemento a la vista y devuelve coordenadas FRESCAS, diciendo si algo
     lo tapa y si se ha movido entre medidas. */
  window.__sagPoint = async (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (err) {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = el.getBoundingClientRect();
    await new Promise((r) => setTimeout(r, 60));
    const b = el.getBoundingClientRect();
    /* Las coordenadas de Input.* son del viewport de ARRIBA, así que un elemento
       dentro de un iframe arrastra la posición de cada marco que lo contiene. */
    let fx = 0, fy = 0;
    try {
      let w = el.ownerDocument && el.ownerDocument.defaultView;
      while (w && w.frameElement) {
        const fr = w.frameElement.getBoundingClientRect();
        fx += fr.left; fy += fr.top;
        w = w.parent;
      }
    } catch (err) {}
    const x = Math.round(fx + b.left + b.width / 2), y = Math.round(fy + b.top + b.height / 2);
    let top = null;
    try { top = (el.ownerDocument || document).elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); } catch (err) {}
    const hit = !top || top === el || el.contains(top) || (top.contains && top.contains(el));
    return {
      x, y, w: Math.round(b.width), h: Math.round(b.height),
      estable: Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2,
      hits: hit, role: roleOf(el), name: nameOf(el).slice(0, 90), fp: fpOf(el),
      blockedBy: hit ? '' : norm((top && (top.tagName + ' ' + (top.getAttribute('aria-label') || top.getAttribute('data-testid') || ''))) || ''),
    };
  };
  /* Busca por HUELLA en toda la página (shadow + iframes): es lo que permite
     sobrevivir a que el DOM se haya movido entre el inventario y el clic. */
  window.__sagFind = (fp, name, role) => {
    const all = collect(document, { x: 0, y: 0 }, { ext: 0 });
    let hit = all.find((c) => c.fp === fp);
    if (!hit && name) hit = all.find((c) => c.role === role && c.name === name);
    if (!hit && name) hit = all.find((c) => c.name === name);
    if (!hit && name) hit = all.find((c) => c.name.toLowerCase().includes(String(name).toLowerCase()));
    return hit ? hit.el : null;
  };
  window.__sagAll = (max) => {
    const frames = { ext: 0 };
    const all = collect(document, { x: 0, y: 0 }, frames);
    // el mismo control anidado (botón dentro de un enlace con el mismo nombre) no
    // debe salir dos veces: manda el más específico
    const limpio = all.filter((c) => !all.some((o) => o !== c && c.el.contains(o.el) && o.name && o.name === c.name));
    const total = limpio.length;
    return { total, frames: frames.ext, lista: limpio.slice(0, max) };
  };
  /* Un solo elemento resuelto vive en window.__sagSel: las acciones siguientes
     (escribir, marcar, subir) lo usan sin volver a buscarlo. */
  window.__sagByCss = (css) => { try { return document.querySelector(css); } catch (err) { return null; } };
  window.__sagReady = true;
  return 'ok';
})()`;

/**
 * Inventario de la página en JSON (lo ejecuta `elements`). Se inyectan antes los
 * ayudantes; este script solo los usa y da formato a lo que el modelo verá.
 */
function inventoryJs() {
  return `(() => {
    if (!window.__sagReady) return JSON.stringify({ error: 'sin ayudantes' });
    const inv = window.__sagAll(500);
    const els = inv.lista.map((c) => ({
      role: c.role, name: c.name, id: c.id, type: c.type, css: c.css, frame: c.frame,
      disabled: c.disabled ? true : undefined, checked: c.checked, value: c.value || undefined,
      required: c.required ? true : undefined, testid: c.testid || undefined, fp: c.fp,
      off: c.off ? true : undefined, x: c.x, y: c.y, w: c.w, h: c.h,
    }));
    return JSON.stringify({ url: location.href, title: document.title, total: inv.total, frames: inv.frames, elements: els });
  })()`;
}

/** Atajos de teclado: «Ctrl+Shift+T» → modificadores (bitmask CDP) + teclas. */
const HOTKEY_MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 };
const HOTKEY_KEYS = {
  enter: { vk: 13, code: 'Enter', key: 'Enter', text: '\r' },
  tab: { vk: 9, code: 'Tab', key: 'Tab' },
  escape: { vk: 27, code: 'Escape', key: 'Escape' },
  esc: { vk: 27, code: 'Escape', key: 'Escape' },
  space: { vk: 32, code: 'Space', key: ' ', text: ' ' },
  backspace: { vk: 8, code: 'Backspace', key: 'Backspace' },
  delete: { vk: 46, code: 'Delete', key: 'Delete' },
  home: { vk: 36, code: 'Home', key: 'Home' },
  end: { vk: 35, code: 'End', key: 'End' },
  pagedown: { vk: 34, code: 'PageDown', key: 'PageDown' },
  pageup: { vk: 33, code: 'PageUp', key: 'PageUp' },
  arrowup: { vk: 38, code: 'ArrowUp', key: 'ArrowUp' },
  arrowdown: { vk: 40, code: 'ArrowDown', key: 'ArrowDown' },
  arrowleft: { vk: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  arrowright: { vk: 39, code: 'ArrowRight', key: 'ArrowRight' },
  f5: { vk: 116, code: 'F5', key: 'F5' },
};

/**
 * Interpreta un atajo («Ctrl+Shift+T», «Alt+ArrowLeft», «a»). Devuelve
 * { modifiers, vk, code, key, text } o null si no se entiende. Separado para poder
 * probarlo sin navegador.
 */
function parseHotkey(spec) {
  const partes = String(spec || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!partes.length) return null;
  let modifiers = 0;
  let tecla = null;
  for (const p of partes) {
    const low = p.toLowerCase();
    if (low in HOTKEY_MODS) { modifiers |= HOTKEY_MODS[low]; continue; }
    if (tecla) return null;                       // dos teclas no es un atajo
    tecla = low;
  }
  if (!tecla) return null;
  const named = HOTKEY_KEYS[tecla];
  if (named) return { modifiers, ...named };
  if (tecla.length === 1) {
    const shift = (modifiers & 8) !== 0;
    const ch = tecla === 'space' ? ' ' : (shift ? tecla.toUpperCase() : tecla);
    return { modifiers, vk: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0), code: ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase(), key: ch, text: modifiers ? undefined : ch };
  }
  return null;
}

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
    this._invRev = 0;                  // v2.5: revisión del inventario (se dice en la respuesta)
    this._logs = [];                   // v2.5: consola + errores de red de la pestaña
    this._dialog = null;               // v2.5: diálogo de la página esperando respuesta
    this._downloads = [];              // v2.5: descargas vistas (para avisar dónde cayeron)
    this.downloadDir = path.join(os.tmpdir(), 'sagitari-downloads');
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
        // v2.5: consola, errores de red, diálogos y descargas se van acumulando; el
        // modelo los lee con action=logs y los avisos se pegan al resultado que toca
        try { this._track(msg.method, msg.params); } catch {}
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

  /** `opts.timeoutMs` recorta la espera de un comando concreto (ver _clickAt: un clic
      puede abrir un diálogo y entonces el renderer deja de acusar recibo). */
  send(method, params = {}, sessionId, opts = {}) {
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
      const limite = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
      timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, limite);
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
    // Los eventos del dominio Page solo llegan si el dominio está habilitado, y
    // waitReady() espera Page.loadEventFired: sin esto esa espera era código muerto
    // y el único criterio real era el sondeo de readyState (que puede leer el
    // documento ANTERIOR todavía en 'complete' justo tras navegar).
    try { await this.send('Page.enable', {}, sessionId); } catch {}
    // v2.5: consola y red de la pestaña (para action=logs) y carpeta de descargas
    try { await this._enableDomains(sessionId); } catch {}
    return sessionId;
  }

  /**
   * v2.5: qué se acumula de la pestaña para poder depurarla sin adivinar. Sin
   * `Network.enable` no hay errores de red, y sin `Log.enable` no hay warnings del
   * navegador: se activan al adjuntar la sesión (una vez por pestaña).
   */
  _track(method, params = {}) {
    const push = (tipo, texto, url) => {
      const t = new Date().toISOString().slice(11, 19);
      this._logs.push({ tipo, texto: String(texto).slice(0, 400), url: url ? String(url).slice(0, 160) : undefined, t });
      if (this._logs.length > 250) this._logs.splice(0, this._logs.length - 250);
    };
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = (params.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type)));
        push(params.type === 'error' ? 'error' : params.type === 'warning' ? 'aviso' : 'consola', args.join(' '));
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        push('excepción', (d.exception && (d.exception.description || d.exception.value)) || d.text || 'error de la página', d.url);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        push(e.level === 'error' ? 'error' : e.level || 'log', e.text, e.url);
        break;
      }
      case 'Network.responseReceived': {
        const r = params.response || {};
        if (Number(r.status) >= 400) push('http', r.status + ' ' + (r.statusText || '') + ' ' + String(r.url || '').slice(0, 120), r.url);
        break;
      }
      case 'Network.loadingFailed':
        push('red', params.errorText || 'petición fallida');
        break;
      case 'Page.javascriptDialogOpening':
        this._dialog = { type: params.type || 'alert', message: params.message || '', url: params.url || '' };
        break;
      case 'Page.javascriptDialogClosed':
        this._dialog = null;
        break;
      case 'Browser.downloadWillBegin':
      case 'Page.downloadWillBegin':
        this._downloads.push({ archivo: params.suggestedFilename || 'archivo', estado: 'descargando', ruta: '' });
        if (this._downloads.length > 20) this._downloads.shift();
        break;
      case 'Browser.downloadProgress':
      case 'Page.downloadProgress': {
        const d = this._downloads[this._downloads.length - 1];
        if (d) { d.estado = params.state === 'completed' ? 'completada' : params.state || d.estado; if (params.filePath) d.ruta = params.filePath; }
        if (params.state === 'completed') push('descarga', `${d ? d.archivo : 'archivo'} guardada en ${this.downloadDir}`);
        break;
      }
      default: break;
    }
  }

  /** Dominios que dan contexto (consola, red) y dónde caen las descargas. */
  async _enableDomains(sessionId) {
    for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
      try { await this.send(m, {}, sessionId); } catch {}
    }
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      // con eventos: sin ellos no hay aviso de dónde quedó el archivo descargado
      await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true }, sessionId);
    } catch {}
  }

  /** Fija la carpeta de descargas (la llama el ejecutor con el espacio de trabajo). */
  setDownloadDir(dir) {
    if (!dir) return;
    this.downloadDir = dir;
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
    /* v2.5: con un diálogo abierto (alert/confirm/prompt) el contexto de la página está
       PAUSADO: `Runtime.evaluate` no responde hasta que alguien lo contesta y el comando
       moría a los 30 s con un «CDP timeout» que no explicaba nada. Ahora se falla al
       instante diciendo qué pasa y cómo salir. */
    if (this._dialog) throw new Error(`la página tiene un diálogo abierto («${this._dialog.type}»: ${(this._dialog.message || '').slice(0, 80)}) y está pausada. Contéstalo con action=dialog accept:true|false.`);
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
    return r.result?.value;
  }

  // Espera a que la pestaña cargue: evento Page.loadEventFired y, como respaldo,
  // sondeo corto de readyState. `timeoutMs` es la red de seguridad.
  async waitReady(sessionId, timeoutMs = 10000) {
    // con un diálogo abierto la página está pausada: esperar a que cargue no tiene sentido
    if (this._dialog) { await sleep(300); return false; }
    const deadline = Date.now() + timeoutMs;
    const ev = this.waitEvent('Page.loadEventFired', timeoutMs, sessionId);
    let fired = false;
    ev.then((v) => { if (v) fired = true; });
    // Margen para que la navegación se comprometa: recién enviado Page.navigate el
    // documento ANTERIOR sigue en 'complete' y se respondía «OK» sin haber cargado
    // la página nueva (y el siguiente elements/content leían la vieja).
    await sleep(150);
    while (Date.now() < deadline) {
      if (fired) return true;   // el evento manda: es la carga de la página nueva
      try { if (await this.evalJs('document.readyState', sessionId) === 'complete') return true; } catch {}
      await Promise.race([ev, sleep(150)]);
    }
    return false;
  }

  // Deja que la página reaccione a una acción (menús, modales, navegación) sin
  // sleeps fijos: observa mutaciones del DOM y espera un periodo de calma; si la
  // acción navega, el documento nuevo se considera listo al completar la carga.
  async settle(sessionId, timeoutMs = 1500, quietMs = 250) {
    // un diálogo abierto pausa la página: no hay mutaciones que observar, solo esperar
    if (this._dialog) { await sleep(Math.min(400, timeoutMs)); return false; }
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

  /** Inyecta (una vez por documento) los ayudantes de página. Tras navegar, `window`
      es nuevo y vuelve a inyectarlos solo. */
  async _injectHelpers(sessionId) {
    try { return await this.evalJs(HELPERS_JS, sessionId); }
    catch { return null; }
  }

  /**
   * Resuelve QUÉ elemento se va a pulsar y dónde está AHORA.
   * `want` acepta las tres formas que usa el modelo: { index } del último inventario
   * (se reencuentra por su HUELLA, no por las coordenadas viejas), { selector } CSS o
   * { text } visible. Deja el elemento en `window.__sagSel` para la acción siguiente.
   * Devuelve { error } o la ficha con coordenadas frescas, aviso de oclusión y demás.
   */
  async _resolve(want, sessionId, ownerId, opts = {}) {
    if (want.index !== undefined && want.index !== null) {
      if (this._invOwner && ownerId && this._invOwner !== ownerId) {
        return { error: 'el inventario que tienes es de otra ejecución del agente. Ejecuta action=elements otra vez antes de clicar.' };
      }
      const el = (this._lastElements || [])[Number(want.index)];
      if (!el) return { error: `índice ${want.index} inválido. Ejecuta action=elements para ver los índices actuales.` };
      const js = await this.evalJs(`(async () => {
        const el = window.__sagFind(${JSON.stringify(el.fp)}, ${JSON.stringify(el.name || '')}, ${JSON.stringify(el.role || '')})
          || (${JSON.stringify(el.css || '')} ? window.__sagByCss(${JSON.stringify(el.css || '')}) : null);
        if (!el) return JSON.stringify({ error: 'ese elemento ya no está en la página (quizá cambió al pulsar otra cosa)' });
        window.__sagSel = el;
        return JSON.stringify(await window.__sagPoint(el));
      })()`, sessionId);
      return this._parsePoint(js);
    }
    const sel = want.selector ? String(want.selector) : null;
    const txt = want.text ? String(want.text) : null;
    if (!sel && !txt) return { error: 'necesito index, selector o text para saber sobre qué actuar' };
    const nth = Number(want.nth) > 0 ? Number(want.nth) : 1;
    const js = await this.evalJs(`(async () => {
      const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      const lower = (s) => norm(s).toLowerCase();
      const sel = ${JSON.stringify(sel)};
      const txt = ${JSON.stringify(txt ? txt.toLowerCase() : null)};
      let cands = [];
      if (sel) {
        try { cands = [...document.querySelectorAll(sel)]; } catch (e) { return JSON.stringify({ error: 'selector CSS no válido: ' + e.message }); }
      } else {
        const inv = window.__sagAll(500).lista;
        const vivos = inv.filter((c) => !c.disabled);
        // exacto → sin la etiqueta de marcado → inicio → incluido. Igual que antes,
        // pero sobre el nombre ACCESIBLE y no sobre el innerText.
        const pick = vivos.filter((c) => lower(c.name) === txt)
          .concat(vivos.filter((c) => lower(c.name).startsWith(txt)))
          .concat(vivos.filter((c) => lower(c.name).includes(txt)));
        cands = [...new Set(pick.map((c) => c.el))];
      }
      const el = cands[${nth - 1}];
      if (!el) {
        const que = (txt ? ' con el texto «' + ${JSON.stringify(txt)} + '»' : '') + (sel ? ' con el selector ' + ${JSON.stringify(sel)} : '');
        return JSON.stringify({ error: 'no encontré nada que pulsar' + que + ' (coincidencias: ' + cands.length + ')' });
      }
      window.__sagSel = el;
      const p = await window.__sagPoint(el);
      p.candidatos = cands.length;
      p.candidato = ${nth};
      return JSON.stringify(p);
    })()`, sessionId);
    return this._parsePoint(js);
  }

  _parsePoint(raw) {
    try {
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!p) return { error: 'no pude localizar el elemento' };
      return p;
    } catch { return { error: 'no pude localizar el elemento' } };
  }

  /** Pulsa en las coordenadas frescas y deja que la página reaccione. */
  async _clickAt(p, sessionId, { force } = {}) {
    if (force) {
      // a la fuerza: clic por DOM, ignorando lo que tape (útil con over-lays pegajosos)
      const ok = await this.evalJs('(() => { const el = window.__sagSel; if (!el) return false; el.click(); return true; })()', sessionId);
      await this.settle(sessionId, 1200);
      this._lastElements = null;
      return ok ? null : 'el elemento ya no está en la página';
    }
    if (!p.hits) {
      return `algo tapa ese elemento («${p.blockedBy || 'desconocido'}»). Ciérralo o acepta el aviso, vuelve a hacer elements y reintenta (o usa force:true para pulsar a la fuerza).`;
    }
    /* El acuse de recibo de un evento de ratón se lo queda el renderer. Si el clic abre
       un `confirm()`, la página se pausa y Chrome NUNCA acusa: esperar los 30 s por
       defecto hacía que un clic perfectamente válido acabara en «CDP timeout» y el
       agente no sabía que había un diálogo esperando. Se espera poco y, si hay diálogo,
       el aviso viaja en el resultado. */
    const corto = { timeoutMs: 2500 };
    const enviar = async (params) => {
      try { await this.send('Input.dispatchMouseEvent', params, sessionId, corto); return true; }
      catch (e) {
        if (/timeout/i.test(String(e.message)) && this._dialog) return true;   // entregado: la página está pausada
        throw e;
      }
    };
    await enviar({ type: 'mouseMoved', x: p.x, y: p.y });
    await sleep(40);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await enviar({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(30);
    }
    // un clic puede abrir un confirm(): se le da un momento para que el evento llegue
    // antes de componer el resultado (si no, el aviso del diálogo se pierde)
    await this._esperarDialogo(1200);
    return null;
  }

  /** ¿Ha aparecido un diálogo? Se espera un poco: el evento viaja aparte del clic. */
  async _esperarDialogo(ms = 1200) {
    const fin = Date.now() + ms;
    while (!this._dialog && Date.now() < fin) await sleep(100);
    return !!this._dialog;
  }

  /** Inventario clicable/legible de la página con índices estables y coordenadas:
      el modelo puede actuar con click_index sin selectores ni capturas a ciegas. */
  async elements(sessionId, ownerId) {
    await this._injectHelpers(sessionId);
    const raw = await this.evalJs(inventoryJs(), sessionId);
    let data;
    try { data = JSON.parse(raw); } catch { return 'Error: no pude analizar la página.'; }
    if (!data.elements || !data.elements.length) {
      return 'Sin elementos interactivos visibles.'
        + (data.frames ? ` La página tiene ${data.frames} iframe(s) de OTRO origen (no se pueden leer desde aquí).` : '')
        + ' Prueba action=screenshot (con selector para una zona) o action=content.';
    }
    this._lastElements = data.elements;   // índices válidos hasta la próxima acción que cambie la página
    this._invOwner = ownerId || null;     // …y solo para la ejecución que los pidió
    this._invRev++;
    const lines = data.elements.map((e, i) => {
      const bits = [`${i}: [${e.role}]`];
      if (e.name) bits.push(`"${e.name}"`);
      if (e.id) bits.push(`#${e.id}`);
      if (e.testid) bits.push(`[testid=${e.testid}]`);
      if (e.frame) bits.push(`(en marco: ${e.frame})`);
      if (e.type && e.type !== 'text') bits.push(e.type);
      if (e.disabled) bits.push('DESHABILITADO');
      if (e.required) bits.push('obligatorio');
      if (e.checked !== undefined && (e.role === 'checkbox' || e.role === 'radio')) bits.push(e.checked ? 'marcado' : 'sin marcar');
      if (e.value && e.role === 'select') bits.push(`valor actual: ${e.value}`);
      if (e.off) bits.push('[fuera de pantalla]');
      return bits.join(' ');
    });
    const recorte = data.total > data.elements.length ? ` (mostrando ${data.elements.length} de ${data.total}: usa content, search de la página o un selector más concreto)` : '';
    return `Página: ${data.title}\nURL: ${data.url}\nElementos interactivos: ${data.total}${recorte}${data.frames ? `  ·  ${data.frames} iframe(s) de otro origen` : ''}\n${lines.join('\n')}\n\nUsa action=click_index con estos índices (si la página cambió, el clic vuelve a buscar el MISMO elemento por su huella, así que también vale tras un scroll), o action=click con text/selector.`;
  }

  /** Etiqueta del elemento que ocupa ese índice en el último inventario.
      La usa el motor de permisos: por índice no se sabe qué se está pulsando, y
      un clic que compra o borra no puede depender de que el modelo lo diga. */
  labelForIndex(idx) {
    const el = (this._lastElements || [])[Number(idx)];
    if (!el) return '';
    return [el.name, el.id, el.testid, el.role, el.frame].filter(Boolean).join(' ').slice(0, 160);
  }

  /**
   * Clic por índice del último inventario. El elemento se vuelve a LOCALIZAR por su
   * huella antes de pulsar: si la página se ha movido (scroll, menú, animación) se
   * pulsa el mismo control en su sitio nuevo, y si ya no existe se dice en vez de
   * clicar en las coordenadas viejas (que es como se compran cosas sin querer).
   */
  async clickIndex(idx, sessionId, ownerId, opts = {}) {
    const p = await this._resolve({ index: idx }, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    const mal = await this._clickAt(p, sessionId, opts);
    if (mal) return `Error: ${mal}`;
    await this.settle(sessionId, 1200);   // deja reaccionar (menús, modales, navegación)
    // la página puede haber cambiado: los índices anteriores ya no son fiables
    this._lastElements = null;
    return `OK: clic en ${p.role} «${p.name}» (${p.x},${p.y})${p.estable === false ? ' — el elemento se estaba moviendo, comprueba el resultado' : ''}${opts.force ? ' [forzado]' : ''}`;
  }

  // ---------- interaction ----------

  /**
   * Clic por texto visible o selector CSS, con la misma comprobación de estabilidad,
   * oclusión y huella que el clic por índice. `nth` elige entre varias coincidencias
   * (el mensaje dice cuántas había) y `force` pulsa aunque algo lo tape.
   */
  async findAndClick(selector, text, sessionId, ownerId, opts = {}) {
    const p = await this._resolve({ selector, text, nth: opts.nth }, sessionId, ownerId);
    if (p.error) {
      return `Error: ${p.error}. Prueba action=elements (inventario con nombres accesibles), action=content para leer la página o action=screenshot para verla.`;
    }
    const mal = await this._clickAt(p, sessionId, opts);
    if (mal) return `Error: ${mal}`;
    await this.settle(sessionId, 1500); // deja reaccionar a la página (menús, modales, navegación)
    const varias = p.candidatos > 1 ? ` (había ${p.candidatos} coincidencias; he pulsado la ${p.candidato}: usa nth para otra)` : '';
    return `OK: clic en ${p.role} «${p.name}» en (${p.x},${p.y})${varias}${opts.force ? ' [forzado]' : ''}`;
  }

  /** Una tecla de texto con sus eventos reales: los sitios que validan al teclear
      (autocompletado, máscaras, contadores) no ven `insertText` y se quedan a medias. */
  async _typeChar(ch, sessionId) {
    const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
    const code = /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase() : (/[0-9]/.test(ch) ? 'Digit' + ch : '');
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
    const mods = upper ? 8 : 0;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, code, key: ch, text: ch, unmodifiedText: ch, modifiers: mods }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key: ch, modifiers: mods }, sessionId);
  }

  /**
   * Escribe en un campo. Localiza por index/selector/text, limpia si hace falta y
   * DEVUELVE lo que quedó escrito: si el sitio recorta (maxlength, máscaras de
   * teléfono, mayúsculas) el modelo lo sabe aquí y no tres pasos después.
   * opts: { clear, submit, human } — human = teclea tecla a tecla (textos cortos).
   */
  async type(want, text, opts, sessionId, ownerId) {
    const { clear = true, submit = false, human = true } = opts || {};
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    const preparado = await this.evalJs(`(() => {
      const el = window.__sagSel;
      if (!el) return 'NO';
      const tag = (el.tagName || '').toLowerCase();
      const editable = el.isContentEditable || tag === 'input' || tag === 'textarea';
      if (!editable) return 'NO_EDITABLE';
      el.focus();
      if (${clear ? 'true' : 'false'}) {
        // select() también vale para textarea: la rama del Range no toca su
        // selección interna, así que setRangeText('') no borraba nada y el texto
        // nuevo se insertaba en el cursor dejando el viejo detrás
        if (typeof el.select === 'function' && !el.isContentEditable) el.select();
        else { const d = el.ownerDocument; const range = d.createRange(); range.selectNodeContents(el); const s = d.getSelection(); s.removeAllRanges(); s.addRange(range); }
        if (!el.isContentEditable && 'setRangeText' in el) { el.setRangeText(''); }
        else if (!el.isContentEditable) { el.value = ''; }
        else { const d = el.ownerDocument; const s = d.getSelection(); if (s && s.rangeCount) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); s.getRangeAt(0).deleteContents(); } }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 'OK';
    })()`, sessionId);
    if (preparado === 'NO') return `Error: ese elemento ya no está en la página. Vuelve a hacer action=elements.`;
    if (preparado === 'NO_EDITABLE') return `Error: «${p.name}» (${p.role}) no es un campo de texto; para un <select> usa action=select y para una casilla action=check.`;
    await sleep(80);
    const str = String(text ?? '');
    if (str) {
      // tecla a tecla en textos cortos (compatible con validaciones en vivo); pegado
      // en textos largos, donde teclear sería lentísimo
      if (human !== false && str.length <= 400) { for (const ch of str) await this._typeChar(ch, sessionId); }
      else await this.send('Input.insertText', { text: str }, sessionId);
    }
    await sleep(180);
    const quedo = await this.evalJs(`(() => {
      const el = window.__sagSel; if (!el) return '';
      return String(el.value === undefined ? (el.isContentEditable ? el.innerText : '') : el.value);
    })()`, sessionId);
    const recorte = String(quedo || '').length < str.length;
    if (submit) {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' }, sessionId);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }, sessionId);
      await this.settle(sessionId, 1500);
      await this.waitReady(sessionId, 6000);
      this._lastElements = null;   // enviar puede haber cambiado la página
    }
    return `OK: escrito en ${p.role} «${p.name}»${submit ? ' y Enter pulsado' : ''}. Valor del campo ahora: «${String(quedo || '').slice(0, 120)}»`
      + (recorte ? '\nAviso: el campo se quedó con menos texto del enviado (maxlength, máscara o validación en vivo).' : '');
  }

  /** Elegir una opción de un <select> por valor, texto o posición. */
  async selectOption(want, value, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    const raw = await this.evalJs(`(() => {
      const el = window.__sagSel; if (!el) return 'NO';
      if ((el.tagName || '').toLowerCase() !== 'select') return 'NO_SELECT';
      const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      const want = ${JSON.stringify(String(value ?? ''))};
      const opts = [...el.options];
      const byValue = opts.find((o) => o.value === want);
      const byText = opts.find((o) => norm(o.textContent) === want)
        || opts.find((o) => norm(o.textContent).toLowerCase().includes(want.toLowerCase()));
      const byIndex = /^\\d+$/.test(want) ? opts[Number(want)] : null;
      const opt = byValue || byText || byIndex;
      if (!opt) return JSON.stringify({ error: 'no hay opción «' + want + '»', opciones: opts.map((o) => norm(o.textContent)).slice(0, 25) });
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, elegido: norm(opt.textContent), valor: el.value, multiple: !!el.multiple });
    })()`, sessionId);
    if (raw === 'NO') return 'Error: ese elemento ya no está en la página.';
    if (raw === 'NO_SELECT') return `Error: «${p.name}» no es un <select> nativo. Si es una lista desplegable de la web, haz clic en ella (action=click) y luego en la opción (action=elements + click_index).`;
    let r; try { r = JSON.parse(raw); } catch { return 'Error: no pude elegir la opción.'; }
    if (r.error) return `Error: ${r.error}. Opciones: ${(r.opciones || []).join(' | ')}`;
    await this.settle(sessionId, 600);
    this._lastElements = null;
    return `OK: elegido «${r.elegido}» (valor ${r.valor}).`;
  }

  /** Marcar/desmarcar una casilla o un radio (pulsando de verdad: los frameworks
      escuchan el clic, no el cambio de .checked). */
  async check(want, on, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    const raw = await this.evalJs(`(() => {
      const el = window.__sagSel; if (!el) return 'NO';
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      if (typeof el.checked !== 'boolean' && role !== 'checkbox' && role !== 'radio' && role !== 'switch') return 'NO_CHECK';
      const antes = el.checked === true;
      const quiero = ${on ? 'true' : 'false'};
      if (antes !== quiero) el.click();
      return JSON.stringify({ antes, ahora: el.checked === true });
    })()`, sessionId);
    if (raw === 'NO') return 'Error: ese elemento ya no está en la página.';
    if (raw === 'NO_CHECK') return `Error: «${p.name}» (${p.role}) no es una casilla. Para pulsarlo usa action=click_index.`;
    let r; try { r = JSON.parse(raw); } catch { return 'Error: no pude cambiar la casilla.'; }
    await this.settle(sessionId, 500);
    this._lastElements = null;
    const estado = r.ahora ? 'marcado' : 'sin marcar';
    return r.antes === r.ahora ? `OK: «${p.name}» ya estaba ${estado}.` : `OK: «${p.name}» ahora está ${estado}.`;
  }

  /** Pasar el ratón por encima: menús que se despliegan, tooltips, previsualizaciones. */
  async hover(want, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sessionId);
    await this.settle(sessionId, 800);
    return `OK: ratón sobre ${p.role} «${p.name}». Si se ha desplegado un menú, haz action=elements para verlo.`;
  }

  /** Atajo de teclado: Ctrl+Shift+T, Alt+ArrowLeft, Escape… (con modificadores reales). */
  async hotkey(spec, sessionId) {
    const k = parseHotkey(spec);
    if (!k) return `Error: no entiendo el atajo «${spec}». Ejemplos: Ctrl+A, Ctrl+Shift+T, Alt+ArrowLeft, Escape, F5, Ctrl+Enter.`;
    const def = { windowsVirtualKeyCode: k.vk, code: k.code, key: k.key, modifiers: k.modifiers };
    if (k.text !== undefined) def.text = k.text;
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
    await this.settle(sessionId, 900);
    this._lastElements = null;
    return `OK: ${spec} pulsado.`;
  }

  /** Subir archivos a un <input type=file> (aunque esté oculto tras un botón). */
  async upload(want, files, sessionId, ownerId) {
    const lista = (Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => String(f));
    if (!lista.length) return 'Error: dime qué archivo(s) subir en `files`.';
    const faltan = lista.filter((f) => { try { return !fs.existsSync(f); } catch { return true; } });
    if (faltan.length) return `Error: no existe(n): ${faltan.join(', ')}. Usa rutas absolutas.`;
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return `Error: ${p.error}`;
    if (!p.css) return 'Error: no pude resolver la ruta del campo de archivo.';
    try {
      const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
      const rootId = doc && doc.root ? doc.root.nodeId : null;
      const found = await this.send('DOM.querySelector', { nodeId: rootId, selector: p.css }, sessionId);
      if (!found || !found.nodeId) return 'Error: no alcanzé el campo de archivo por el DOM (¿está dentro de un marco de otro origen?).';
      await this.send('DOM.setFileInputFiles', { files: lista, nodeId: found.nodeId }, sessionId);
    } catch (e) {
      return 'Error al subir: ' + e.message;
    }
    await this.settle(sessionId, 1000);
    this._lastElements = null;
    return `OK: ${lista.length} archivo(s) puestos en «${p.name}»: ${lista.map((f) => path.basename(f)).join(', ')}.`;
  }

  /**
   * Espera a que la página cumpla algo, en vez de dormir a ciegas: que aparezca un
   * texto o un selector, que cambie la URL o el título, o que DESAPAREZCA algo.
   */
  async waitFor(args, sessionId) {
    const timeout = Math.min(Math.max(Number(args.timeoutMs || args.timeout) || 8000, 300), 60000);
    const texto = args.text ? String(args.text) : null;
    const selector = args.selector ? String(args.selector) : null;
    const url = args.url ? String(args.url) : null;
    const titulo = args.title ? String(args.title) : null;
    const negar = args.gone === true;
    if (!texto && !selector && !url && !titulo) return 'Error: dime a qué esperar: text, selector, url o title.';
    const dentro = (cond) => (negar ? `!(${cond})` : `(${cond})`);
    const conds = [];
    if (texto) conds.push(dentro(`(document.body ? document.body.innerText : '').toLowerCase().indexOf(${JSON.stringify(texto.toLowerCase())}) >= 0`));
    if (selector) conds.push(dentro(`!!document.querySelector(${JSON.stringify(selector)})`));
    if (url) conds.push(dentro(`location.href.indexOf(${JSON.stringify(url)}) >= 0`));
    if (titulo) conds.push(dentro(`(document.title || '').toLowerCase().indexOf(${JSON.stringify(titulo.toLowerCase())}) >= 0`));
    const expr = `(${conds.join(' && ')})`;
    const t0 = Date.now();
    let visto = false;
    while (Date.now() - t0 < timeout) {
      try { if (await this.evalJs(expr, sessionId) === true) { visto = true; break; } } catch {}
      await sleep(180);
    }
    if (visto) {
      const estado = await this._pageState(sessionId);
      return `OK: cumplido en ${Date.now() - t0} ms (${negar ? 'ya no está' : 'ya está'}). Ahora: ${estado}`;
    }
    const estado = await this._pageState(sessionId);
    return `Error: en ${timeout} ms no se cumplió «${negar ? 'desaparecer ' : ''}${texto || selector || url || titulo}». Sigue así: ${estado}. Comprueba con action=logs si la página falló, o con action=screenshot.`;
  }

  /** Resumen del estado de la página (para los mensajes de espera y de error). */
  async _pageState(sessionId) {
    try {
      const raw = await this.evalJs('JSON.stringify({ url: location.href, title: document.title, texto: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 200) })', sessionId);
      const s = JSON.parse(raw);
      return `«${s.title}» — ${s.url} — ${s.texto}`;
    } catch { return '(no pude leer el estado de la página)'; }
  }

  /** Consola, excepciones, errores de red y descargas recientes (depurar la propia web). */
  logs(args = {}) {
    const n = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
    const desde = args.since ? String(args.since) : null;
    const items = this._logs.filter((l) => !desde || l.t >= desde).slice(-n);
    if (args.clear) this._logs = [];
    if (!items.length) return 'Sin mensajes de consola ni errores de red desde que se abrió la pestaña.' + (this._downloads.length ? `\nDescargas: ${this._downloads.map((d) => d.archivo + ' (' + d.estado + ')').join(', ')}` : '');
    const lineas = items.map((l) => `[${l.tipo}] ${l.texto}${l.url ? '  ← ' + l.url : ''}`);
    const descargas = this._downloads.length ? `\nDescargas: ${this._downloads.map((d) => `${d.archivo} (${d.estado})${d.ruta ? ' en ' + d.ruta : ''}`).join('; ')}` : '';
    return `Últimos ${items.length} mensajes:\n${lineas.join('\n')}${descargas}`;
  }

  /** Volver, avanzar o recargar usando el historial REAL de la pestaña. */
  async history(dir, sessionId) {
    const h = await this.send('Page.getNavigationHistory', {}, sessionId);
    const i = h.currentIndex;
    const idx = dir === 'back' ? i - 1 : dir === 'forward' ? i + 1 : i;
    if (dir === 'reload') {
      await this.send('Page.reload', {}, sessionId);
    } else {
      if (idx < 0 || idx >= (h.entries || []).length) return `Error: no hay nada más a donde ${dir === 'back' ? 'volver' : 'avanzar'}.`;
      await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id }, sessionId);
    }
    const loaded = await this.waitReady(sessionId, 10000);
    this._lastElements = null;
    const target = (h.entries || [])[idx] || {};
    return `OK: ${dir === 'reload' ? 'recargada' : (dir === 'back' ? 'atrás' : 'adelante')}${loaded ? '' : ' (sigue cargando)'}${dir === 'reload' ? '' : ' → ' + (target.title || '') + ' ' + (target.url || '')}`;
  }

  /** Contesta a un diálogo de la página (alert/confirm/prompt/beforeunload). */
  async dialog(args) {
    if (!this._dialog) return 'No hay ningún diálogo abierto ahora mismo.';
    const d = this._dialog;
    const accept = args.accept !== false;
    try {
      await this.send('Page.handleJavaScriptDialog', { accept, promptText: args.text ? String(args.text) : undefined }, await this.sessionIdOf());
    } catch (e) {
      return 'Error al contestar al diálogo: ' + e.message;
    }
    this._dialog = null;
    return `OK: diálogo «${d.type}» ${accept ? 'aceptado' : 'cancelado'}${d.message ? ' («' + d.message.slice(0, 120) + '»)' : ''}.`;
  }

  /** Aviso para pegar al resultado de cualquier acción si hay un diálogo bloqueando. */
  _dialogNote() {
    if (!this._dialog) return '';
    const d = this._dialog;
    return `\nATENCIÓN: la página tiene un diálogo abierto («${d.type}»: ${(d.message || '').slice(0, 120)}) que la bloquea. Contéstalo con action=dialog accept:true|accept:false (y text para un prompt).`;
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
    // v2.5: si hay un diálogo abierto, la página está bloqueada para el resto de
    // acciones: se avisa en el resultado de CUALQUIER acción (menos la que lo cierra)
    const res = await next;
    if (!this._dialog || args.action === 'dialog') return res;
    const nota = this._dialogNote();
    if (typeof res === 'string') return res + nota;
    if (res && typeof res === 'object' && typeof res.text === 'string') return { ...res, text: res.text + nota };
    return res;
  }

  async _handle(args, ownerId) {
    const a = args.action;
    if (!ACTIONS.has(a)) return `Acción desconocida: ${a}. Válidas: ${[...ACTIONS].join(', ')}.`;
    /* v2.5: con un diálogo abierto casi nada funciona (la página está pausada) y antes
       cada acción se quedaba 30 s hasta el timeout. Mejor decirlo en claro y de una. */
    if (this._dialog && !['dialog', 'logs', 'tabs', 'close', 'launch', 'new_tab', 'select_tab', 'screenshot'].includes(a)) {
      return `Error: la página tiene un diálogo abierto («${this._dialog.type}»: ${(this._dialog.message || '').slice(0, 120)}) que la tiene pausada. Contéstalo con action=dialog accept:true|false (text para un prompt) y sigue.`;
    }
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

        case 'click_index': return await this.clickIndex(args.index, await this.sessionIdOf(), ownerId, { force: args.force === true });

        case 'click': return await this.findAndClick(args.selector, args.text, await this.sessionIdOf(), ownerId, { nth: args.nth, force: args.force === true });

        case 'type': return await this.type(
          { index: args.index, selector: args.selector, text: args.text, nth: args.nth },
          args.text, { clear: args.clear !== false, submit: args.submit === true, human: args.human !== false },
          await this.sessionIdOf(), ownerId);

        /* ---- v2.5: acciones nuevas ---- */
        case 'hover': return await this.hover({ index: args.index, selector: args.selector, text: args.text }, await this.sessionIdOf(), ownerId);

        case 'select': return await this.selectOption({ index: args.index, selector: args.selector, text: args.text }, args.value !== undefined ? args.value : args.option, await this.sessionIdOf(), ownerId);

        case 'check': return await this.check({ index: args.index, selector: args.selector, text: args.text }, args.on !== false && args.checked !== false, await this.sessionIdOf(), ownerId);

        case 'hotkey': return await this.hotkey(args.key || args.keys, await this.sessionIdOf());

        case 'upload': return await this.upload({ index: args.index, selector: args.selector, text: args.text }, args.files || args.file, await this.sessionIdOf(), ownerId);

        case 'wait_for': return await this.waitFor(args, await this.sessionIdOf());

        case 'logs': return this.logs(args);

        case 'back': case 'forward': case 'reload': return await this.history(a, await this.sessionIdOf());

        case 'dialog': return await this.dialog(args);

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
          const campo = args.selector || args.query;
          const html = args.html === true;
          const expr = campo
            ? `(() => { const el = document.querySelector(${JSON.stringify(String(campo))}); if (!el) return 'NOT_FOUND'; return ${html ? 'el.outerHTML' : 'el.innerText'}; })()`
            : (html ? `document.documentElement.outerHTML` : `document.body.innerText`);
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
          /* v2.5: también una ZONA (selector o índice): para mirar un formulario o un
             detalle concreto, la captura de toda la página se convierte en una miniatura
             ilegible (y caríssima en tokens). */
          if (args.selector || args.index !== undefined) {
            const p = await this._resolve({ index: args.index, selector: args.selector, text: args.text }, sessionId, ownerId);
            if (p.error) return `Error: ${p.error}`;
            const m = await this.send('Page.getLayoutMetrics', {}, sessionId);
            const v = m.cssVisualViewport || m.visualViewport || {};
            const maxW = 1280, maxH = 1200;
            const escala = Math.min(1, maxW / Math.max(1, p.w), maxH / Math.max(1, p.h));
            const r = await this.send('Page.captureScreenshot', {
              format: 'jpeg', quality: 70,
              clip: { x: (v.pageX || 0) + p.x - p.w / 2, y: (v.pageY || 0) + p.y - p.h / 2, width: Math.max(1, p.w), height: Math.max(1, p.h), scale: escala },
            }, sessionId);
            return { text: `Captura de «${p.name}» (${p.role}) en «${target.title}».`, images: ['data:image/jpeg;base64,' + r.data] };
          }
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

module.exports = {
  Browser,
  // piezas puras: se prueban sin navegador (el resto necesita Chrome de verdad, y eso
  // lo comprueba scripts/navegador-check.js contra una página real)
  __test: { HELPERS_JS, inventoryJs, parseHotkey, ACTIONS, HOTKEY_MODS, HOTKEY_KEYS },
};
