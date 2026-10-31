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
const terceros = require('./terceros'); // marco único del contenido de terceros (datos, no órdenes)
const i18n = require('./i18n');

function getJSON(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

/* ============================================================================
   Recuperación sin puerto de un navegador huérfano

   Desde la v5.0.1 Chrome se lanza con `--remote-debugging-pipe` (sin puerto TCP), y en
   ese modo NO escribe `DevToolsActivePort` en el perfil (medido: el fichero no aparece).
   Si SAGITARI muere de golpe (Administrador de tareas, cuelgue), queda un chrome.exe
   vivo con nuestro `--user-data-dir`; el siguiente `launch()` lanza otro chrome.exe con
   el mismo perfil, la instancia viva se lo traga y el proceso nuevo sale al instante →
   «el navegador no respondió al canal de depuración», y el navegador queda inservible
   hasta que el usuario cierre esa ventana a mano.

   La vía que NO depende del puerto es localizar el proceso por su `--user-data-dir`.
   El perfil es único por sesión (su id lleva el hash del nombre), así que compararlo no
   puede señalar a un Chrome del usuario: solo a uno lanzado por SAGITARI.
   ============================================================================ */

/** Valor de `--user-data-dir=` en una línea de comandos, sin comillas. '' si no está. */
function userDataDirDe(cmd) {
  const m = /--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(String(cmd || ''));
  if (!m) return '';
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3] || '';
}

/** ¿Esta línea de comandos es la de NUESTRO navegador? Se compara el valor de
    `--user-data-dir` normalizado (en Windows las rutas no distinguen mayúsculas). */
function esNuestroPerfil(cmd, profileDir) {
  const suyo = userDataDirDe(cmd);
  if (!suyo || !profileDir) return false;
  try {
    return path.resolve(suyo).toLowerCase() === path.resolve(String(profileDir)).toLowerCase();
  } catch {
    return false;
  }
}

/** PIDs de la salida JSON del escáner cuyo `--user-data-dir` es el nuestro. Acepta el
    objeto suelto que devuelve ConvertTo-Json cuando solo hay un proceso. */
function pidsPropios(salida, profileDir) {
  let data;
  try {
    const txt = String(salida || '').trim();
    if (!txt) return [];
    data = JSON.parse(txt);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [data];
  const pids = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const pid = Number(p.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (esNuestroPerfil(p.CommandLine, profileDir)) pids.push(pid);
  }
  return pids;
}

/* Escáner de procesos de Windows: Chrome/Edge con `--user-data-dir`, en JSON con PID y
   línea de comandos (el filtro por «es nuestro» se hace en Node, con `esNuestroPerfil`).
   Se pasa con `-EncodedCommand` (base64/UTF-16LE) porque el escapado de comillas de
   `child_process` en Windows es frágil con rutas que llevan espacios. */
const PS_ESCANER =
  "$ErrorActionPreference='SilentlyContinue';" +
  'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' or Name=\'msedge.exe\'" | ' +
  "Where-Object { $_.CommandLine -like '*--user-data-dir=*' } | " +
  'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';

/** Argumentos de `powershell.exe` para el escáner (puro: se prueba sin ejecutarlo). */
function psEscanerArgs() {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_ESCANER, 'utf16le').toString('base64')];
}

/* Acciones válidas de browser_control. Se valida ANTES de la autocuración: un
   nombre mal escrito (o alucinado por el modelo) llegaba al `if (!this.ws)` y
   acababa lanzando un Chrome nuevo para luego responder «acción desconocida». */
const ACTIONS = new Set([
  'launch',
  'profile',
  'close',
  'navigate',
  'new_tab',
  'select_tab',
  'close_tab',
  'elements',
  'click_index',
  'click',
  'type',
  'press',
  'scroll',
  'wait',
  'content',
  'eval',
  'screenshot',
  'tabs',
  // v2.5 «navegador 2»: actuar como una persona y no a ciegas
  'hover',
  'select',
  'check',
  'hotkey',
  'upload',
  'wait_for',
  'logs',
  'back',
  'forward',
  'reload',
  'dialog',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Detener aborta la acción en vuelo (espera de carga, `settle`, `wait_for`…): este
   es el mensaje que recibe el modelo en vez de dejarlo esperando a que acabe. */
/* Función y no constante: el mensaje va al diccionario y el idioma puede cambiar con
   la app ya arrancada. */
const CANCELADO = () => i18n.err('nav.cancelado');

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
  /* Espera a que la página pinte, SIN poder colgarse.
     OJO, esto era un fallo real: esperar a requestAnimationFrame a secas no se resuelve
     nunca si la ventana del navegador está oculta, minimizada o tapada por otra
     aplicación —Chromium deja de dar frames— y como el comando viaja por Runtime.evaluate
     con awaitPromise, moría a los 30 s con un CDP timeout sin explicar nada. Y esa es la
     situación NORMAL: el agente trabaja mientras el usuario está en SAGITARI, con el
     navegador detrás. Dos frames si se ve; y un tope de tiempo que siempre cierra. */
  window.__sagPintar = (ms) => new Promise((r) => {
    let listo = false;
    const fin = () => { if (!listo) { listo = true; r(); } };
    try { requestAnimationFrame(() => requestAnimationFrame(fin)); } catch (err) { setTimeout(fin, 0); }
    setTimeout(fin, Number(ms) > 0 ? Number(ms) : 150);
  });
  /* Deja el elemento a la vista y devuelve coordenadas FRESCAS, diciendo si algo
     lo tapa y si se ha movido entre medidas. */
  window.__sagPoint = async (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (err) {}
    await window.__sagPintar(150);
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
  const partes = String(spec || '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!partes.length) return null;
  let modifiers = 0;
  let tecla = null;
  for (const p of partes) {
    const low = p.toLowerCase();
    if (low in HOTKEY_MODS) {
      modifiers |= HOTKEY_MODS[low];
      continue;
    }
    if (tecla) return null; // dos teclas no es un atajo
    tecla = low;
  }
  if (!tecla) return null;
  const named = HOTKEY_KEYS[tecla];
  if (named) return { modifiers, ...named };
  if (tecla.length === 1) {
    const shift = (modifiers & 8) !== 0;
    const ch = tecla === 'space' ? ' ' : shift ? tecla.toUpperCase() : tecla;
    return {
      modifiers,
      vk: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0),
      code: ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase(),
      key: ch,
      text: modifiers ? undefined : ch,
    };
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
    this.activeId = null; // targetId of the tab every action targets
    this.profile = profileId('default'); // v1.5: id canónico del perfil activo
    this._id = 0;
    this._pending = new Map();
    this._events = new Map(); // method -> esperadores de eventos CDP
    this._sessions = new Map(); // targetId -> sessionId (una sesión por pestaña)
    this.browserPid = null; // pid del navegador lanzado (para matar el árbol)
    // v5.0.1: tubería de depuración (no hay puerto TCP). `toBrowser` es el fd 3
    // (lo que SAGITARI escribe a Chrome), `fromBrowser` el fd 4 (lo que Chrome responde).
    this.child = null;
    this.toBrowser = null;
    this.fromBrowser = null;
    this._readBuffer = '';
    // Inventario de `elements()` y de qué ejecución es: sus coordenadas son
    // relativas al viewport de UNA página, así que un inventario viejo o de otra
    // ejecución no puede servir para clicar.
    this._lastElements = null;
    this._invOwner = null;
    this._invRev = 0; // v2.5: revisión del inventario (se dice en la respuesta)
    this._logs = []; // v2.5: consola + errores de red de la pestaña
    this._dialog = null; // v2.5: diálogo de la página esperando respuesta
    this._dialogReciente = null; // v5.0.1: diálogo que se abrió (y pudo auto-cerrarse) en esta acción
    this._downloads = []; // v2.5: descargas vistas (para avisar dónde cayeron)
    this.downloadDir = path.join(os.tmpdir(), 'sagitari-downloads');
    this._queue = Promise.resolve(); // una acción de navegador a la vez (ver handle)
    this._signal = null; // AbortSignal de la acción en vuelo (Detener la corta)
    // carpeta de datos del perfil activo (persistentes: los logins sobreviven)
    this.profileDir = ensureProfileDir('default');
  }

  /** Cambia de perfil: cierra la sesión actual si procede; el próximo launch usa ese perfil. */
  async switchProfile(profile) {
    const id = profileId(profile);
    const label = String(profile || 'default');
    if (id === this.profile && this.ws) return i18n.t('nav.res.perfil.ya', { perfil: label });
    const teniaSocket = !!this.ws;
    if (teniaSocket) {
      try {
        await this.send('Browser.close');
      } catch {}
      try {
        this.ws.close();
      } catch {}
      this._rejectPending(i18n.t('nav.res.perfil.cambiando'));
    }
    // Matar el árbol ANTES de olvidar el PID: si solo se descarta, el proceso sigue vivo
    // con el perfil viejo y ya nadie lo cerrará. Con el socket vivo es seguro el nuestro
    // (la tubería sigue abierta: es el que lanzamos); sin socket se busca por el
    // --user-data-dir del perfil que se abandona. Nunca «a ciegas»: Windows reutiliza PIDs.
    if (teniaSocket && this.browserPid) {
      try {
        this._matarArbol(this.browserPid);
      } catch {}
    } else {
      await this._cerrarHuerfano();
    }
    // El estado del navegador anterior se olvida SIEMPRE, haya socket vivo o no:
    // su puerto y su PID no valen para el perfil nuevo. (Antes solo se limpiaban
    // con el socket abierto, así que un cambio de perfil tras un cierre brusco
    // dejaba un PID viejo que kill() podía disparar contra otro proceso.)
    this.ws = null;
    this.activeId = null;
    this.port = 0;
    this._sessions.clear();
    this._lastElements = null;
    this.browserPid = null;
    this.profile = id;
    this.profileDir = ensureProfileDir(profile); // el dir se deriva del nombre original, no del id ya hasheado
    return i18n.t('nav.res.perfil.activo', { perfil: label });
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
    } catch {
      return 0;
    }
  }

  async alive() {
    // Con la tubería no hay un puerto que sondear: la conexión viva es la prueba.
    return this.ws ? true : null;
  }

  async connect() {
    // Con la tubería no hay handshake HTTP: los streams ya existen tras el spawn.
    // Solo se enganchan los listeners y se invalidan las sesiones CDP cacheadas.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this._sessions.clear();
    this._readBuffer = '';
    if (!this.toBrowser || !this.fromBrowser) return;
    const to = this.toBrowser;
    const from = this.fromBrowser;
    const conn = {
      to,
      from,
      close: () => {
        try {
          to.end();
        } catch {}
        try {
          from.destroy();
        } catch {}
      },
    };
    this.ws = conn;
    from.on('data', (chunk) => {
      if (this.ws !== conn) return;
      this._readBuffer += chunk.toString('utf8');
      let progressed = true;
      while (progressed && this._readBuffer) {
        progressed = false;
        const idx = this._readBuffer.indexOf('\0');
        let msg = null;
        if (idx >= 0) {
          msg = this._readBuffer.slice(0, idx);
          this._readBuffer = this._readBuffer.slice(idx + 1);
          progressed = true;
        } else {
          // Algunos mensajes llegan sin terminador NUL (o el NUL se queda en un chunk
          // posterior): si el buffer acumulado ya es JSON válido, se procesa igual.
          try {
            JSON.parse(this._readBuffer);
            msg = this._readBuffer;
            this._readBuffer = '';
            progressed = true;
          } catch {
            // incompleto: esperar más datos
          }
        }
        if (msg === null) break;
        if (!msg) continue;
        let parsed;
        try {
          parsed = JSON.parse(msg);
        } catch {
          continue;
        }
        if (parsed.id && this._pending.has(parsed.id)) {
          const { resolve, reject } = this._pending.get(parsed.id);
          this._pending.delete(parsed.id);
          parsed.error ? reject(new Error(parsed.error.message || JSON.stringify(parsed.error))) : resolve(parsed.result);
        } else if (parsed.method) {
          try {
            this._track(parsed.method, parsed.params);
          } catch {}
          this._emitEvent(parsed.method, parsed.params, parsed.sessionId);
        }
      }
    });
    from.on('end', () => {
      if (this.ws !== conn) return;
      this.ws = null;
      this.toBrowser = null;
      this.fromBrowser = null;
      this.child = null;
      this.browserPid = null;
      this._sessions.clear();
      this._rejectPending(i18n.t('nav.desconectado'));
    });
    from.on('error', () => {
      /* se cierra por `end`; no se deja una excepción no capturada */
    });
  }

  /** `opts.timeoutMs` recorta la espera de un comando concreto (ver _clickAt: un clic
      puede abrir un diálogo y entonces el renderer deja de acusar recibo). */
  send(method, params = {}, sessionId, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error(i18n.t('nav.no.iniciado')));
      const id = ++this._id;
      // el temporizador se cancela al resolverse: si no, cada comando CDP dejaba
      // un timer vivo 30 s más (cientos en una sesión de automatización larga)
      let timer = null;
      const wrap = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this._pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      try {
        this.ws.to.write(JSON.stringify(payload) + '\0');
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        return reject(e);
      }
      const limite = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
      timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, limite);
    });
  }

  /** Rechaza y vacía todas las peticiones en vuelo (cierre de socket, kill, etc.). */
  _rejectPending(reason) {
    for (const { reject } of this._pending.values()) {
      try {
        reject(new Error(reason));
      } catch {}
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
      if (!set) {
        set = new Set();
        this._events.set(method, set);
      }
      const w = {
        sessionId,
        timer: null,
        resolve: (v) => {
          this._events.get(method)?.delete(w);
          resolve(v);
        },
      };
      w.timer = setTimeout(() => w.resolve(null), timeoutMs);
      set.add(w);
    });
  }

  async pages() {
    if (!this.ws) return [];
    try {
      const r = await this.send('Target.getTargets');
      const infos = r && Array.isArray(r.targetInfos) ? r.targetInfos : [];
      return infos
        .filter((t) => t.type === 'page' && !(t.url || '').startsWith('devtools://'))
        .map((t) => ({ id: t.targetId, type: t.type, title: t.title || '', url: t.url || '' }));
    } catch {
      return [];
    }
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
    try {
      await this.send('Page.enable', {}, sessionId);
    } catch {}
    // v2.5: consola y red de la pestaña (para action=logs) y carpeta de descargas
    try {
      await this._enableDomains(sessionId);
    } catch {}
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
        const args = (params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type));
        push(
          params.type === 'error' ? 'error' : params.type === 'warning' ? i18n.t('nav.log.aviso') : i18n.t('nav.log.consola'),
          args.join(' '),
        );
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        push(
          i18n.t('nav.log.excepcion'),
          (d.exception && (d.exception.description || d.exception.value)) || d.text || i18n.t('nav.log.error.pagina'),
          d.url,
        );
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
        push(i18n.t('nav.log.red'), params.errorText || i18n.t('nav.log.peticion.fallida'));
        break;
      case 'Page.javascriptDialogOpening':
        this._dialog = { type: params.type || 'alert', message: params.message || '', url: params.url || '' };
        this._dialogReciente = this._dialog;
        break;
      case 'Page.javascriptDialogClosed':
        this._dialog = null;
        // El diálogo pudo auto-cerrarse (Chrome lo acepta solo cuando nadie lo
        // contesta a tiempo). Se conserva la nota un rato para que la acción que
        // lo abrió pueda avisar y `action=dialog` responder con sentido.
        if (this._dialogReciente) {
          const reciente = this._dialogReciente;
          setTimeout(() => {
            if (this._dialogReciente === reciente) this._dialogReciente = null;
          }, 3000);
        }
        break;
      case 'Browser.downloadWillBegin':
      case 'Page.downloadWillBegin':
        this._downloads.push({
          archivo: params.suggestedFilename || i18n.t('nav.log.archivo'),
          estado: i18n.t('nav.log.descargando'),
          ruta: '',
        });
        if (this._downloads.length > 20) this._downloads.shift();
        break;
      case 'Browser.downloadProgress':
      case 'Page.downloadProgress': {
        const d = this._downloads[this._downloads.length - 1];
        if (d) {
          d.estado = params.state === 'completed' ? i18n.t('nav.log.completada') : params.state || d.estado;
          if (params.filePath) d.ruta = params.filePath;
        }
        if (params.state === 'completed')
          push(
            i18n.t('nav.log.descarga'),
            i18n.t('nav.log.guardada', { archivo: d ? d.archivo : i18n.t('nav.log.archivo'), ruta: this.downloadDir }),
          );
        break;
      }
      default:
        break;
    }
  }

  /** Dominios que dan contexto (consola, red) y dónde caen las descargas. */
  async _enableDomains(sessionId) {
    for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
      try {
        await this.send(m, {}, sessionId);
      } catch {}
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
    try {
      await this.send('Target.detachFromTarget', { sessionId });
    } catch {}
  }

  // The tab every action operates on: the selected one, or the first alive.
  async currentSession() {
    const list = await this.pages();
    if (!list.length) throw new Error(i18n.t('nav.res.pestanas.nada'));
    let page = list.find((p) => p.id === this.activeId);
    if (!page) {
      const stale = this.activeId;
      page = list[0];
      this.activeId = page.id;
      if (stale) await this.detach(stale); // la pestaña activa ya no existe: libera su sesión
    }
    const sessionId = await this.attach(page.id);
    return { sessionId, target: page };
  }

  // ---------- lifecycle ----------

  async _exeDe(want) {
    const cands =
      want === 'edge'
        ? [
            process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
          ];
    for (const c of cands) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  // Cierra un navegador huérfano que siga vivo con nuestro perfil. Dos vías:
  // 1) si un Chrome viejo (anterior a la tubería) dejó DevToolsActivePort, se le pide
  //    Browser.close por su WebSocket;
  // 2) la que de verdad importa desde la tubería: localizar el proceso por su
  //    --user-data-dir y matarlo, porque la tubería no publica puerto (ver el bloque
  //    de `userDataDirDe` arriba).
  async _cerrarHuerfano() {
    const port = this._portFromProfile();
    if (port) {
      let url = null;
      try {
        const v = await getJSON(`http://127.0.0.1:${port}/json/version`, 1200);
        if (v && v.webSocketDebuggerUrl) url = v.webSocketDebuggerUrl;
      } catch {}
      if (url) await this._pedirCierre(url);
    }
    const pids = await this._pidsHuerfanos();
    if (pids) {
      for (const pid of pids) this._matarArbol(pid);
      if (pids.length) await sleep(500); // deja morir el árbol antes de relanzar
      this._borrarMarca();
    }
  }

  /** Pide Browser.close por WebSocket (vía antigua, la del puerto). */
  async _pedirCierre(url) {
    try {
      const sock = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((res) => {
        const t = setTimeout(() => {
          try {
            sock.close();
          } catch {}
          res();
        }, 3000);
        sock.once('open', () => {
          try {
            sock.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          } catch {}
          setTimeout(() => {
            try {
              sock.close();
            } catch {}
            res();
          }, 200);
        });
        sock.once('error', () => {
          clearTimeout(t);
          try {
            sock.close();
          } catch {}
          res();
        });
      });
    } catch {}
  }

  /** Fichero con el PID del navegador lanzado. Vive en el perfil (único por sesión) y
      sobrevive a un cierre brusco de SAGITARI: es la señal barata de «pudo quedar un
      huérfano». Sin él no se escanea ningún proceso, así que el lanzamiento normal no
      paga nada. */
  _marcaPath() {
    return path.join(this.profileDir, 'sagitari-browser.pid');
  }

  _borrarMarca() {
    try {
      fs.unlinkSync(this._marcaPath());
    } catch {}
  }

  /** PIDs de procesos con NUESTRO --user-data-dir. Solo Windows (es donde corre la app).
      Devuelve [] si el marcador dice que no hay nada que buscar, null si no se pudo
      determinar (escáner ausente o fallo): en ese caso nunca se borra el marcador ni se
      mata a ciegas. */
  _pidsHuerfanos() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    if (!fs.existsSync(this._marcaPath())) return Promise.resolve([]);
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn('powershell.exe', psEscanerArgs(), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve(null);
      }, 5000);
      child.on('error', () => {
        clearTimeout(t);
        resolve(null);
      });
      if (child.stdout) child.stdout.on('data', (c) => (out += c));
      child.on('close', (code) => {
        clearTimeout(t);
        const txt = String(out).trim();
        if (!txt && code !== 0) return resolve(null); // no se pudo determinar
        resolve(pidsPropios(txt, this.profileDir));
      });
    });
  }

  _lanzarProceso(exe, args) {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return null;
    }
    child.on('error', () => {}); // nunca dejar una excepción no capturada
    this.child = child;
    this.browserPid = child.pid;
    // Deja el PID en el perfil: si SAGITARI muere de golpe, es lo único que permite
    // localizar (y matar) a este navegador en el siguiente lanzamiento. La ruta se ancla
    // aquí y no en el cierre, porque para entonces ya se pudo haber cambiado de perfil.
    const marca = this._marcaPath();
    try {
      fs.writeFileSync(marca, String(child.pid));
    } catch {}
    this.toBrowser = child.stdio[3];
    this.fromBrowser = child.stdio[4];
    this.activeId = null;
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.toBrowser = null;
      this.fromBrowser = null;
      this.browserPid = null;
      try {
        fs.unlinkSync(marca); // el proceso ya no está: no hay huérfano que buscar
      } catch {}
      if (this.ws) {
        this.ws = null;
        this._sessions.clear();
        this._rejectPending(i18n.t('nav.desconectado'));
      }
    });
    return child;
  }

  async _esperarPuerto(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      await sleep(250);
      if (!this.ws) return false; // el proceso murió
      try {
        await Promise.race([
          this.send('Browser.getVersion'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), Math.max(100, deadline - Date.now()))),
        ]);
        return true;
      } catch {}
    }
    return false;
  }

  async launch(browserArg, url) {
    const want = (browserArg || 'chrome').toLowerCase();
    fs.mkdirSync(this.profileDir, { recursive: true }); // asegura el perfil activo

    // 1) Ya conectado: navega o informa.
    if (this.ws) {
      if (url) {
        await this.currentSession();
        return this.navigate(url);
      }
      const n = (await this.pages()).length;
      return i18n.t(n === 1 ? 'nav.res.launch.ya.una' : 'nav.res.launch.ya.varias', { n });
    }

    // 2) Limpia un Chrome huérfano que siga vivo con nuestro perfil (antes se
    //    reconectaba a él; con la tubería ya no se puede, así que se cierra).
    await this._cerrarHuerfano();

    // 3) Busca el ejecutable.
    let exe = await this._exeDe(want);
    let used = want;
    if (!exe) {
      used = want === 'edge' ? 'chrome' : 'edge';
      exe = await this._exeDe(used);
    }
    if (!exe) return i18n.err('nav.sin.navegador');

    // 4) Lanza con la tubería de depuración (sin puerto TCP: nada que escuchar).
    this.port = 0;
    const target = url || 'about:blank';
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      /* Estos tres son los que hacen que el navegador se pueda manejar con su ventana
         DETRÁS de la app, que es como se usa de verdad (el usuario está en SAGITARI y el
         navegador trabaja por debajo). Sin ellos Chromium deja de dar frames y de acusar
         recibo de la entrada a la ventana oculta, y cada acción —un clic, un tipeo, una
         espera de pintado— se quedaba colgada hasta el timeout de 30 s. */
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      /* Y este, que es SOLO de Windows y nos costó un rato: el sistema avisa a Chromium
         cuando una ventana queda tapada por otra, y entonces Chromium la «congela» —deja
         de producir frames y de acusar recibo de la entrada—. Para un navegador que el
         usuario ve, es una optimización; para uno que maneja un agente por debajo, es la
         diferencia entre clicar y quedarse esperando 30 s. */
      '--disable-features=CalculateNativeWinOcclusion',
      '--start-maximized',
      target,
    ];
    const child = this._lanzarProceso(exe, args);
    if (!child) return i18n.err('nav.no.lanzado');
    await this.connect();
    const ok = await this._esperarPuerto(9000);
    if (!ok) {
      this.kill();
      return i18n.err('nav.sin.depuracion');
    }

    const list = await this.pages();
    if (list.length) {
      this.activeId = list[0].id;
      if (url) return this.navigate(url); // navigate ya espera la carga (waitReady)
    }
    return i18n.t('nav.res.launch.ok', { navegador: used, url: url ? i18n.t('nav.res.navegando', { url }) : '' });
  }

  kill() {
    try {
      if (this.ws) this.ws.close();
    } catch {}
    if (this.browserPid) {
      try {
        this._matarArbol(this.browserPid);
      } catch {}
    }
    this._borrarMarca(); // cierre ordenado: no queda huérfano que buscar mañana
    this.ws = null;
    this.toBrowser = null;
    this.fromBrowser = null;
    this.child = null;
    this.browserPid = null;
    this.activeId = null;
    this._sessions.clear();
    this._lastElements = null;
    this._rejectPending(i18n.t('nav.cerrado'));
  }

  _matarArbol(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }

  // ---------- helpers ----------

  async evalJs(expression, sessionId) {
    /* v2.5: con un diálogo abierto (alert/confirm/prompt) el contexto de la página está
       PAUSADO: `Runtime.evaluate` no responde hasta que alguien lo contesta y el comando
       moría a los 30 s con un «CDP timeout» que no explicaba nada. Ahora se falla al
       instante diciendo qué pasa y cómo salir. */
    if (this._dialog)
      throw new Error(
        i18n.t('nav.res.dialogo.pausa', {
          tipo: this._dialog.type,
          mensaje: (this._dialog.message || '').slice(0, 80),
        }),
      );
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || i18n.t('nav.res.js.error'));
    return r.result?.value;
  }

  // Espera a que la pestaña cargue: evento Page.loadEventFired y, como respaldo,
  // sondeo corto de readyState. `timeoutMs` es la red de seguridad.
  async waitReady(sessionId, timeoutMs = 10000) {
    // con un diálogo abierto la página está pausada: esperar a que cargue no tiene sentido
    if (this._dialog) {
      await sleep(300);
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    const ev = this.waitEvent('Page.loadEventFired', timeoutMs, sessionId);
    let fired = false;
    ev.then((v) => {
      if (v) fired = true;
    });
    // Margen para que la navegación se comprometa: recién enviado Page.navigate el
    // documento ANTERIOR sigue en 'complete' y se respondía «OK» sin haber cargado
    // la página nueva (y el siguiente elements/content leían la vieja).
    await sleep(150);
    while (Date.now() < deadline) {
      if (this._abortada()) return false; // Detener: no esperar a que cargue
      if (fired) return true; // el evento manda: es la carga de la página nueva
      try {
        if ((await this.evalJs('document.readyState', sessionId)) === 'complete') return true;
      } catch {}
      await Promise.race([ev, sleep(150)]);
    }
    return false;
  }

  // Deja que la página reaccione a una acción (menús, modales, navegación) sin
  // sleeps fijos: observa mutaciones del DOM y espera un periodo de calma; si la
  // acción navega, el documento nuevo se considera listo al completar la carga.
  async settle(sessionId, timeoutMs = 1500, quietMs = 250) {
    // un diálogo abierto pausa la página: no hay mutaciones que observar, solo esperar
    if (this._dialog) {
      await sleep(Math.min(400, timeoutMs));
      return false;
    }
    try {
      await this.evalJs(
        `(() => {
        if (window.__sagitariObs) return;
        window.__sagitariObs = true;
        window.__sagitariLastMutation = Date.now();
        try {
          new MutationObserver(() => { window.__sagitariLastMutation = Date.now(); })
            .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch {}
      })()`,
        sessionId,
      );
    } catch {}
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._abortada()) return false; // Detener: no esperar al periodo de calma
      await sleep(80);
      try {
        const idle = await this.evalJs(
          `document.readyState === 'complete' && (Date.now() - (window.__sagitariLastMutation || 0)) > ${quietMs}`,
          sessionId,
        );
        if (idle) return true;
      } catch {}
    }
    return false;
  }

  async navigate(url) {
    let u = String(url || '').trim();
    if (!u) return i18n.err('nav.falta.url');
    // Solo http(s): file:// leería el disco desde el navegador (fuera del
    // confinamiento de read_file) y chrome:/about: tocan internals del navegador.
    // Antes se aceptaban explícitamente; ahora se rechazan con el motivo.
    if (/^(file|chrome|about|chrome-extension|edge|view-source):/i.test(u)) {
      return i18n.err('nav.solo.http');
    }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const { sessionId } = await this.currentSession();
    try {
      await this.send('Page.navigate', { url: u }, sessionId);
    } catch (e) {
      return i18n.err('nav.fallo', { motivo: e.message });
    }
    const loaded = await this.waitReady(sessionId);
    // el inventario de elements() ya no vale: sus coordenadas son de otra página
    this._lastElements = null;
    let title = '';
    try {
      title = (await this.evalJs('document.title', sessionId)) || '';
    } catch {}
    return i18n.t('nav.res.navegar', {
      pagina: title || u,
      cargando: loaded ? '' : i18n.t('nav.res.cargando'),
      url: u,
    });
  }

  // Captura en JPEG y acotada (máx. 1280 px de ancho, 2400 de alto): un PNG a
  // resolución completa cuesta muchísimos más tokens que un JPEG reducido.
  async screenshot(sessionId, fullPage) {
    const MAX_SHOT_W = 1280,
      MAX_SHOT_H = 2400,
      QUALITY = 60;
    let x = 0,
      y = 0,
      w = 0,
      h = 0;
    try {
      const m = await this.send('Page.getLayoutMetrics', {}, sessionId);
      if (fullPage) {
        const c = m.cssContentSize || m.contentSize || {};
        w = Math.round(c.width || 0);
        h = Math.round(c.height || 0);
      } else {
        const v = m.cssVisualViewport || m.visualViewport || {};
        x = Math.round(v.pageX || 0);
        y = Math.round(v.pageY || 0);
        w = Math.round(v.clientWidth || v.width || 0);
        h = Math.round(v.clientHeight || v.height || 0);
      }
    } catch {}
    if (!w || !h) {
      w = MAX_SHOT_W;
      h = fullPage ? MAX_SHOT_H : 800;
    }
    const scale = Math.min(w > MAX_SHOT_W ? MAX_SHOT_W / w : 1, h > MAX_SHOT_H ? MAX_SHOT_H / h : 1);
    const r = await this.send(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: QUALITY,
        captureBeyondViewport: !!fullPage,
        clip: { x, y, width: w, height: h, scale },
      },
      sessionId,
    );
    return 'data:image/jpeg;base64,' + r.data;
  }

  // ---------- v1.5: percepción visual avanzada (DOM + bounding boxes) ----------

  /** Inyecta (una vez por documento) los ayudantes de página. Tras navegar, `window`
      es nuevo y vuelve a inyectarlos solo. */
  async _injectHelpers(sessionId) {
    try {
      return await this.evalJs(HELPERS_JS, sessionId);
    } catch {
      return null;
    }
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
        return { error: i18n.t('nav.res.inventario.otra') };
      }
      const el = (this._lastElements || [])[Number(want.index)];
      if (!el) return { error: i18n.t('nav.res.indice', { indice: want.index }) };
      const js = await this.evalJs(
        `(async () => {
        const el = window.__sagFind(${JSON.stringify(el.fp)}, ${JSON.stringify(el.name || '')}, ${JSON.stringify(el.role || '')})
          || (${JSON.stringify(el.css || '')} ? window.__sagByCss(${JSON.stringify(el.css || '')}) : null);
        if (!el) return JSON.stringify({ error: 'ese elemento ya no está en la página (quizá cambió al pulsar otra cosa)' });
        window.__sagSel = el;
        return JSON.stringify(await window.__sagPoint(el));
      })()`,
        sessionId,
      );
      return this._parsePoint(js);
    }
    const sel = want.selector ? String(want.selector) : null;
    const txt = want.text ? String(want.text) : null;
    if (!sel && !txt) return { error: i18n.t('nav.res.falta.objetivo') };
    const nth = Number(want.nth) > 0 ? Number(want.nth) : 1;
    const js = await this.evalJs(
      `(async () => {
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
    })()`,
      sessionId,
    );
    return this._parsePoint(js);
  }

  _parsePoint(raw) {
    try {
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!p) return { error: i18n.t('nav.res.no.localizado') };
      return p;
    } catch {
      return { error: i18n.t('nav.res.no.localizado') };
    }
  }

  /** Pulsa en las coordenadas frescas y deja que la página reaccione. */
  async _clickAt(p, sessionId, { force } = {}) {
    if (force) {
      // a la fuerza: clic por DOM, ignorando lo que tape (útil con over-lays pegajosos)
      const ok = await this.evalJs('(() => { const el = window.__sagSel; if (!el) return false; el.click(); return true; })()', sessionId);
      await this.settle(sessionId, 1200);
      this._lastElements = null;
      return ok ? null : i18n.t('nav.res.elemento.fuera');
    }
    if (!p.hits) {
      return i18n.t('nav.res.tapado', { por: p.blockedBy || i18n.t('nav.res.tapado.desconocido') });
    }
    /* El acuse de recibo de un evento de ratón se lo queda el renderer. Si el clic abre
       un `confirm()`, la página se pausa y Chrome NUNCA acusa: esperar los 30 s por
       defecto hacía que un clic perfectamente válido acabara en «CDP timeout» y el
       agente no sabía que había un diálogo esperando. Se espera poco y, si hay diálogo,
       el aviso viaja en el resultado. */
    const corto = { timeoutMs: 2500 };
    const enviar = async (params) => {
      try {
        await this.send('Input.dispatchMouseEvent', params, sessionId, corto);
        return true;
      } catch (e) {
        if (/timeout/i.test(String(e.message)) && this._dialog) return true; // entregado: la página está pausada
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
    while (!(this._dialog || this._dialogReciente) && Date.now() < fin) await sleep(100);
    return !!(this._dialog || this._dialogReciente);
  }

  /** Inventario clicable/legible de la página con índices estables y coordenadas:
      el modelo puede actuar con click_index sin selectores ni capturas a ciegas. */
  async elements(sessionId, ownerId) {
    await this._injectHelpers(sessionId);
    const raw = await this.evalJs(inventoryJs(), sessionId);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return i18n.err('nav.sin.analisis');
    }
    if (!data.elements || !data.elements.length) {
      return (
        i18n.t('nav.res.sin.elementos') +
        (data.frames ? i18n.t('nav.res.sin.elementos.marcos', { n: data.frames }) : '') +
        i18n.t('nav.res.sin.elementos.prueba')
      );
    }
    this._lastElements = data.elements; // índices válidos hasta la próxima acción que cambie la página
    this._invOwner = ownerId || null; // …y solo para la ejecución que los pidió
    this._invRev++;
    const lines = data.elements.map((e, i) => {
      const bits = [`${i}: [${e.role}]`];
      if (e.name) bits.push(`"${e.name}"`);
      if (e.id) bits.push(`#${e.id}`);
      if (e.testid) bits.push(`[testid=${e.testid}]`);
      if (e.frame) bits.push(i18n.t('nav.res.marco', { marco: e.frame }));
      if (e.type && e.type !== 'text') bits.push(e.type);
      if (e.disabled) bits.push(i18n.t('nav.res.deshabilitado'));
      if (e.required) bits.push(i18n.t('nav.res.obligatorio'));
      if (e.checked !== undefined && (e.role === 'checkbox' || e.role === 'radio'))
        bits.push(e.checked ? i18n.t('nav.res.marcado') : i18n.t('nav.res.sin.marcar'));
      if (e.value && e.role === 'select') bits.push(i18n.t('nav.res.valor.actual', { valor: e.value }));
      if (e.off) bits.push(i18n.t('nav.res.fuera.pantalla'));
      return bits.join(' ');
    });
    const recorte =
      data.total > data.elements.length
        ? i18n.t('nav.res.recorte', { vistos: data.elements.length, total: data.total })
        : '';
    return i18n.t('nav.res.inventario', {
      titulo: data.title,
      url: data.url,
      total: data.total,
      recorte,
      marcos: data.frames ? i18n.t('nav.res.inventario.marcos', { n: data.frames }) : '',
      lineas: lines.join('\n'),
    });
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
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    const mal = await this._clickAt(p, sessionId, opts);
    if (mal) return i18n.err('nav.motivo', { motivo: mal });
    await this.settle(sessionId, 1200); // deja reaccionar (menús, modales, navegación)
    // la página puede haber cambiado: los índices anteriores ya no son fiables
    this._lastElements = null;
    return i18n.t('nav.res.clic', {
      rol: p.role,
      nombre: p.name,
      x: p.x,
      y: p.y,
      movido: p.estable === false ? i18n.t('nav.res.clic.movido') : '',
      forzado: opts.force ? i18n.t('nav.res.forzado') : '',
    });
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
      return i18n.err('nav.motivo.prueba', { motivo: p.error });
    }
    const mal = await this._clickAt(p, sessionId, opts);
    if (mal) return i18n.err('nav.motivo', { motivo: mal });
    await this.settle(sessionId, 1500); // deja reaccionar a la página (menús, modales, navegación)
    const varias = p.candidatos > 1 ? i18n.t('nav.res.varias', { n: p.candidatos, cual: p.candidato }) : '';
    return i18n.t('nav.res.clic.en', {
      rol: p.role,
      nombre: p.name,
      x: p.x,
      y: p.y,
      varias,
      forzado: opts.force ? i18n.t('nav.res.forzado') : '',
    });
  }

  /** Una tecla de texto con sus eventos reales: los sitios que validan al teclear
      (autocompletado, máscaras, contadores) no ven `insertText` y se quedan a medias. */
  async _typeChar(ch, sessionId) {
    const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
    const code = /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : '';
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
    const mods = upper ? 8 : 0;
    await this.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', windowsVirtualKeyCode: vk, code, key: ch, text: ch, unmodifiedText: ch, modifiers: mods },
      sessionId,
    );
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
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    const preparado = await this.evalJs(
      `(() => {
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
    })()`,
      sessionId,
    );
    if (preparado === 'NO') return i18n.err('nav.elemento.fuera.elements');
    if (preparado === 'NO_EDITABLE')
      return i18n.err('nav.no.campo', { nombre: p.name, rol: p.role });
    await sleep(80);
    const str = String(text ?? '');
    if (str) {
      // tecla a tecla en textos cortos (compatible con validaciones en vivo); pegado
      // en textos largos, donde teclear sería lentísimo
      if (human !== false && str.length <= 400) {
        for (const ch of str) await this._typeChar(ch, sessionId);
      } else await this.send('Input.insertText', { text: str }, sessionId);
    }
    await sleep(180);
    const quedo = await this.evalJs(
      `(() => {
      const el = window.__sagSel; if (!el) return '';
      return String(el.value === undefined ? (el.isContentEditable ? el.innerText : '') : el.value);
    })()`,
      sessionId,
    );
    const recorte = String(quedo || '').length < str.length;
    if (submit) {
      await this.send(
        'Input.dispatchKeyEvent',
        { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
        sessionId,
      );
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }, sessionId);
      await this.settle(sessionId, 1500);
      await this.waitReady(sessionId, 6000);
      this._lastElements = null; // enviar puede haber cambiado la página
    }
    return (
      i18n.t('nav.res.escrito', {
        rol: p.role,
        nombre: p.name,
        enter: submit ? i18n.t('nav.res.enter') : '',
        valor: String(quedo || '').slice(0, 120),
      }) + (recorte ? i18n.t('nav.res.escrito.recorte') : '')
    );
  }

  /** Elegir una opción de un <select> por valor, texto o posición. */
  async selectOption(want, value, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    const raw = await this.evalJs(
      `(() => {
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
    })()`,
      sessionId,
    );
    if (raw === 'NO') return i18n.err('nav.elemento.fuera');
    if (raw === 'NO_SELECT') return i18n.err('nav.select.nativo', { nombre: p.name });
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      return i18n.err('nav.select.fallo');
    }
    if (r.error) return i18n.err('nav.select.opciones', { motivo: r.error, opciones: (r.opciones || []).join(' | ') });
    await this.settle(sessionId, 600);
    this._lastElements = null;
    return i18n.t('nav.res.elegido', { opcion: r.elegido, valor: r.valor });
  }

  /** Marcar/desmarcar una casilla o un radio (pulsando de verdad: los frameworks
      escuchan el clic, no el cambio de .checked). */
  async check(want, on, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    const raw = await this.evalJs(
      `(() => {
      const el = window.__sagSel; if (!el) return 'NO';
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      if (typeof el.checked !== 'boolean' && role !== 'checkbox' && role !== 'radio' && role !== 'switch') return 'NO_CHECK';
      const antes = el.checked === true;
      const quiero = ${on ? 'true' : 'false'};
      if (antes !== quiero) el.click();
      return JSON.stringify({ antes, ahora: el.checked === true });
    })()`,
      sessionId,
    );
    if (raw === 'NO') return i18n.err('nav.elemento.fuera');
    if (raw === 'NO_CHECK') return i18n.err('nav.no.checkbox', { nombre: p.name, rol: p.role });
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      return i18n.err('nav.check.fallo');
    }
    await this.settle(sessionId, 500);
    this._lastElements = null;
    const estado = r.ahora ? i18n.t('nav.res.marcado') : i18n.t('nav.res.sin.marcar');
    return i18n.t(r.antes === r.ahora ? 'nav.res.check.ya' : 'nav.res.check.ahora', { nombre: p.name, estado });
  }

  /** Pasar el ratón por encima: menús que se despliegan, tooltips, previsualizaciones. */
  async hover(want, sessionId, ownerId) {
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sessionId);
    await this.settle(sessionId, 800);
    return i18n.t('nav.res.hover', { rol: p.role, nombre: p.name });
  }

  /** Atajo de teclado: Ctrl+Shift+T, Alt+ArrowLeft, Escape… (con modificadores reales). */
  async hotkey(spec, sessionId) {
    const k = parseHotkey(spec);
    if (!k) return i18n.err('nav.atajo', { atajo: spec });
    const def = { windowsVirtualKeyCode: k.vk, code: k.code, key: k.key, modifiers: k.modifiers };
    if (k.text !== undefined) def.text = k.text;
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
    await this.settle(sessionId, 900);
    this._lastElements = null;
    return i18n.t('nav.res.atajo', { atajo: spec });
  }

  /** Subir archivos a un <input type=file> (aunque esté oculto tras un botón). */
  async upload(want, files, sessionId, ownerId) {
    const lista = (Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => String(f));
    if (!lista.length) return i18n.err('nav.files.falta');
    const faltan = lista.filter((f) => {
      try {
        return !fs.existsSync(f);
      } catch {
        return true;
      }
    });
    if (faltan.length) return i18n.err('nav.files.fuera', { lista: faltan.join(', ') });
    const p = await this._resolve(want, sessionId, ownerId);
    if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
    if (!p.css) return i18n.err('nav.archivo.css');
    try {
      const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
      const rootId = doc && doc.root ? doc.root.nodeId : null;
      const found = await this.send('DOM.querySelector', { nodeId: rootId, selector: p.css }, sessionId);
      if (!found || !found.nodeId) return i18n.err('nav.archivo.dom');
      await this.send('DOM.setFileInputFiles', { files: lista, nodeId: found.nodeId }, sessionId);
    } catch (e) {
      return i18n.err('nav.subir.fallo', { motivo: e.message });
    }
    await this.settle(sessionId, 1000);
    this._lastElements = null;
    return i18n.t('nav.res.subido', {
      n: lista.length,
      nombre: p.name,
      lista: lista.map((f) => path.basename(f)).join(', '),
    });
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
    if (!texto && !selector && !url && !titulo) return i18n.err('nav.esperar.falta');
    const dentro = (cond) => (negar ? `!(${cond})` : `(${cond})`);
    const conds = [];
    if (texto)
      conds.push(
        dentro(`(document.body ? document.body.innerText : '').toLowerCase().indexOf(${JSON.stringify(texto.toLowerCase())}) >= 0`),
      );
    if (selector) conds.push(dentro(`!!document.querySelector(${JSON.stringify(selector)})`));
    if (url) conds.push(dentro(`location.href.indexOf(${JSON.stringify(url)}) >= 0`));
    if (titulo) conds.push(dentro(`(document.title || '').toLowerCase().indexOf(${JSON.stringify(titulo.toLowerCase())}) >= 0`));
    const expr = `(${conds.join(' && ')})`;
    const t0 = Date.now();
    let visto = false;
    while (Date.now() - t0 < timeout) {
      if (this._abortada()) return CANCELADO();
      try {
        if ((await this.evalJs(expr, sessionId)) === true) {
          visto = true;
          break;
        }
      } catch {}
      await sleep(180);
    }
    if (visto) {
      const estado = await this._pageState(sessionId);
      return i18n.t('nav.res.cumplido', {
        ms: Date.now() - t0,
        estado: negar ? i18n.t('nav.res.espera.no') : i18n.t('nav.res.espera.ya'),
        pagina: estado,
      });
    }
    const estado = await this._pageState(sessionId);
    return i18n.err('nav.esperar.timeout', {
      ms: timeout,
      que: `${negar ? i18n.t('nav.esperar.desaparecer') : ''}${texto || selector || url || titulo}`,
      estado,
    });
  }

  /** Resumen del estado de la página (para los mensajes de espera y de error). */
  async _pageState(sessionId) {
    try {
      const raw = await this.evalJs(
        'JSON.stringify({ url: location.href, title: document.title, texto: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 200) })',
        sessionId,
      );
      const s = JSON.parse(raw);
      return `«${s.title}» — ${s.url} — ${s.texto}`;
    } catch {
      return i18n.t('nav.res.estado.ilegible');
    }
  }

  /** Consola, excepciones, errores de red y descargas recientes (depurar la propia web). */
  logs(args = {}) {
    const n = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
    const desde = args.since ? String(args.since) : null;
    const items = this._logs.filter((l) => !desde || l.t >= desde).slice(-n);
    if (args.clear) this._logs = [];
    if (!items.length)
      return (
        i18n.t('nav.res.logs.vacio') +
        (this._downloads.length ? i18n.t('nav.res.logs.descargas', { lista: this._descargasTexto() }) : '')
      );
    const lineas = items.map((l) => `[${l.tipo}] ${l.texto}${l.url ? '  ← ' + l.url : ''}`);
    const descargas = this._downloads.length ? i18n.t('nav.res.logs.descargas', { lista: this._descargasTexto() }) : '';
    return i18n.t('nav.res.logs.ultimos', { n: items.length, lineas: lineas.join('\n'), descargas });
  }

  /** Descargas en una línea: archivo (estado) y dónde cayó. */
  _descargasTexto() {
    return this._downloads
      .map((d) =>
        d.ruta
          ? i18n.t('nav.res.logs.descarga.ruta', { archivo: d.archivo, estado: d.estado, ruta: d.ruta })
          : `${d.archivo} (${d.estado})`,
      )
      .join(', ');
  }

  /** Volver, avanzar o recargar usando el historial REAL de la pestaña. */
  async history(dir, sessionId) {
    const h = await this.send('Page.getNavigationHistory', {}, sessionId);
    const i = h.currentIndex;
    const idx = dir === 'back' ? i - 1 : dir === 'forward' ? i + 1 : i;
    if (dir === 'reload') {
      await this.send('Page.reload', {}, sessionId);
    } else {
      if (idx < 0 || idx >= (h.entries || []).length)
        return i18n.err('nav.historia.tope', { direccion: dir === 'back' ? i18n.t('nav.volver') : i18n.t('nav.avanzar') });
      await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id }, sessionId);
    }
    const loaded = await this.waitReady(sessionId, 10000);
    this._lastElements = null;
    const target = (h.entries || [])[idx] || {};
    const accion =
      dir === 'reload'
        ? i18n.t('nav.res.historial.recarga')
        : dir === 'back'
          ? i18n.t('nav.res.historial.atras')
          : i18n.t('nav.res.historial.adelante');
    return i18n.t('nav.res.historial', {
      accion,
      cargando: loaded ? '' : i18n.t('nav.res.historial.cargando'),
      destino: dir === 'reload' ? '' : i18n.t('nav.res.historial.destino', { titulo: target.title || '', url: target.url || '' }),
    });
  }

  /** Contesta a un diálogo de la página (alert/confirm/prompt/beforeunload). */
  async dialog(args) {
    const d = this._dialog || this._dialogReciente;
    if (!d) return i18n.t('nav.res.sin.dialogo');
    const accept = args.accept !== false;
    if (this._dialog) {
      try {
        await this.send(
          'Page.handleJavaScriptDialog',
          { accept, promptText: args.text ? String(args.text) : undefined },
          await this.sessionIdOf(),
        );
      } catch (e) {
        // El diálogo ya se cerró (Chrome lo aceptó solo): no es un error para el modelo.
        if (!/No dialog is showing|no dialog/i.test(String(e.message))) return i18n.err('nav.dialogo.fallo', { motivo: e.message });
      }
    }
    this._dialog = null;
    this._dialogReciente = null;
    return i18n.t('nav.res.dialogo', {
      tipo: d.type,
      respuesta: accept ? i18n.t('nav.res.dialogo.aceptado') : i18n.t('nav.res.dialogo.cancelado'),
      mensaje: d.message ? i18n.t('nav.res.dialogo.mensaje', { mensaje: d.message.slice(0, 120) }) : '',
    });
  }

  /** Aviso para pegar al resultado de cualquier acción si hay un diálogo bloqueando. */
  _dialogNote(d = this._dialog) {
    if (!d) return '';
    return i18n.t('nav.res.aviso.dialogo', { tipo: d.type, mensaje: (d.message || '').slice(0, 120) });
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
  async handle(args, ownerId, opts = {}) {
    const signal = (opts && opts.signal) || null;
    // Detener antes de encolar: no tiene sentido arrancar una acción ya cancelada
    if (signal && signal.aborted) return CANCELADO();
    const run = () => this._handle(args, ownerId, opts);
    const next = this._queue.then(run, run);
    this._queue = next.then(
      () => {},
      () => {},
    ); // un fallo no rompe la cola
    // v2.5: si hay un diálogo abierto, la página está bloqueada para el resto de
    // acciones: se avisa en el resultado de CUALQUIER acción (menos la que lo cierra)
    const res = await next;
    const dialogo = this._dialog || this._dialogReciente;
    if (!dialogo || args.action === 'dialog') return res;
    const nota = this._dialogNote(dialogo);
    if (typeof res === 'string') return res + nota;
    if (res && typeof res === 'object' && typeof res.text === 'string') return { ...res, text: res.text + nota };
    return res;
  }

  async _handle(args, ownerId, opts = {}) {
    /* El signal viaja en la INSTANCIA (no en cada firma): la cola garantiza una sola
       acción a la vez, y así también lo ven los helpers que ya cuelgan de `this`
       (waitReady, settle, waitFor). Se limpia al acabar. */
    this._signal = (opts && opts.signal) || null;
    try {
      return await this._despachar(args, ownerId);
    } finally {
      this._signal = null;
    }
  }

  /** ¿Se ha pedido Detener mientras corre esta acción? */
  _abortada() {
    return !!(this._signal && this._signal.aborted);
  }

  /** Sueño interrumpible: se corta en cuanto llega el abort (hasta 10 s de `wait`). */
  async _dormir(ms) {
    const fin = Date.now() + Math.max(0, Number(ms) || 0);
    for (;;) {
      if (this._abortada()) return;
      const queda = fin - Date.now();
      if (queda <= 0) return;
      await sleep(Math.min(100, queda));
    }
  }

  async _despachar(args, ownerId, { retried = false } = {}) {
    const a = args.action;
    if (this._abortada()) return CANCELADO();
    if (!ACTIONS.has(a)) return i18n.t('nav.accion', { accion: a, validas: [...ACTIONS].join(', ') });
    /* v2.5: con un diálogo abierto casi nada funciona (la página está pausada) y antes
       cada acción se quedaba 30 s hasta el timeout. Mejor decirlo en claro y de una. */
    if (this._dialog && !['dialog', 'logs', 'tabs', 'close', 'launch', 'new_tab', 'select_tab', 'screenshot'].includes(a)) {
      return i18n.err('nav.dialogo.bloquea', {
        tipo: this._dialog.type,
        mensaje: (this._dialog.message || '').slice(0, 120),
      });
    }
    try {
      if (a === 'launch') return await this.launch(args.browser, args.url);
      if (a === 'profile') return await this.switchProfile(args.profile);
      if (a === 'close') {
        try {
          await this.send('Browser.close');
        } catch {}
        this.kill();
        return i18n.t('nav.res.cerrar');
      }
      if (!this.ws) {
        // Con la tubería no se reutiliza una instancia anterior: se lanza una nueva
        // (cualquier Chrome huérfano con nuestro perfil se limpia dentro de launch).
        return await this.launch(args.browser, args.url);
      }

      switch (a) {
        case 'navigate':
          return await this.navigate(args.url);

        case 'new_tab': {
          const { targetId } = await this.send('Target.createTarget', { url: args.url || 'about:blank' });
          if (this.activeId && this.activeId !== targetId) await this.detach(this.activeId);
          this.activeId = targetId;
          this._lastElements = null;
          this._invOwner = null; // otra pestaña: otros índices
          if (args.url) await this.waitReady(await this.attach(targetId));
          return i18n.t('nav.res.nueva.pestana', { url: args.url ? i18n.t('nav.res.nueva.pestana.url', { url: args.url }) : '' });
        }

        case 'select_tab': {
          const list = await this.pages();
          if (!list.length) return i18n.err('nav.pestanas.nada');
          let page = null;
          const q = args.tab;
          if (typeof q === 'number' && list[q - 1]) page = list[q - 1];
          else if (typeof q === 'string' && q.trim()) {
            const n = norm(q.toLowerCase());
            page =
              list.find((p) => p.title && norm(p.title.toLowerCase()).includes(n)) ||
              list.find((p) => p.url && p.url.toLowerCase().includes(n));
          }
          if (!page)
            return i18n.err('nav.pestana.no.encontrada', {
              busqueda: q,
              lista: list.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join('\n'),
            });
          if (this.activeId && this.activeId !== page.id) await this.detach(this.activeId);
          this.activeId = page.id;
          this._lastElements = null;
          this._invOwner = null; // otra pestaña: otros índices
          return i18n.t('nav.res.pestana.activa', { titulo: page.title, url: page.url });
        }

        case 'close_tab': {
          const list = await this.pages();
          let id = this.activeId;
          if (typeof args.tab === 'number' && list[args.tab - 1]) id = list[args.tab - 1].id;
          else if (typeof args.tab === 'string' && args.tab.trim()) {
            const p = list.find(
              (p) =>
                (p.title || '').toLowerCase().includes(args.tab.toLowerCase()) ||
                (p.url || '').toLowerCase().includes(args.tab.toLowerCase()),
            );
            if (p) id = p.id;
          }
          if (!id) return i18n.err('nav.pestana.nada');
          await this.detach(id); // libera la sesión CDP antes de cerrar el target
          await this.send('Target.closeTarget', { targetId: id });
          if (this.activeId === id) {
            const rest = await this.pages();
            this.activeId = rest.length ? rest[0].id : null;
            this._lastElements = null;
            this._invOwner = null; // otra pestaña: otros índices
          }
          return i18n.t('nav.res.pestana.cerrada', { n: (await this.pages()).length });
        }

        case 'elements': {
          const { sessionId } = await this.currentSession();
          const inv = await this.elements(sessionId, ownerId);
          // La captura solo se adjunta si el modelo la pide explícitamente
          // (screenshot:true): así no se paga una imagen en cada inventario.
          if (args.screenshot === true) {
            try {
              const dataUrl = await this.screenshot(sessionId, false);
              return { text: inv + i18n.t('nav.res.captura.adjunta'), images: [dataUrl] };
            } catch {}
          }
          return inv;
        }

        case 'click_index':
          return await this.clickIndex(args.index, await this.sessionIdOf(), ownerId, { force: args.force === true });

        case 'click':
          return await this.findAndClick(args.selector, args.text, await this.sessionIdOf(), ownerId, {
            nth: args.nth,
            force: args.force === true,
          });

        case 'type':
          return await this.type(
            { index: args.index, selector: args.selector, text: args.text, nth: args.nth },
            args.text,
            { clear: args.clear !== false, submit: args.submit === true, human: args.human !== false },
            await this.sessionIdOf(),
            ownerId,
          );

        /* ---- v2.5: acciones nuevas ---- */
        case 'hover':
          return await this.hover({ index: args.index, selector: args.selector, text: args.text }, await this.sessionIdOf(), ownerId);

        case 'select':
          return await this.selectOption(
            { index: args.index, selector: args.selector, text: args.text },
            args.value !== undefined ? args.value : args.option,
            await this.sessionIdOf(),
            ownerId,
          );

        case 'check':
          return await this.check(
            { index: args.index, selector: args.selector, text: args.text },
            args.on !== false && args.checked !== false,
            await this.sessionIdOf(),
            ownerId,
          );

        case 'hotkey':
          return await this.hotkey(args.key || args.keys, await this.sessionIdOf());

        case 'upload':
          return await this.upload(
            { index: args.index, selector: args.selector, text: args.text },
            args.files || args.file,
            await this.sessionIdOf(),
            ownerId,
          );

        case 'wait_for':
          return await this.waitFor(args, await this.sessionIdOf());

        case 'logs':
          return this.logs(args);

        case 'back':
        case 'forward':
        case 'reload':
          return await this.history(a, await this.sessionIdOf());

        case 'dialog':
          return await this.dialog(args);

        case 'press': {
          const map = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            ArrowDown: 40,
            ArrowUp: 38,
            ArrowLeft: 37,
            ArrowRight: 39,
            Backspace: 8,
            Delete: 46,
            PageDown: 34,
            PageUp: 33,
            Home: 36,
            End: 35,
            Space: 32,
          };
          const winCode = map[args.key];
          if (!winCode) return i18n.err('nav.tecla', { tecla: args.key });
          const def = { windowsVirtualKeyCode: winCode, code: args.key, key: args.key };
          if (args.key === 'Enter') def.text = '\r';
          // sin `text` el navegador no ejecuta la acción de carácter: pulsar Space
          // no insertaba el espacio ni activaba el botón con foco
          if (args.key === 'Space') {
            def.key = ' ';
            def.text = ' ';
          }
          const { sessionId } = await this.currentSession();
          await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def }, sessionId);
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
          await sleep(250);
          return i18n.t('nav.res.tecla', { tecla: args.key });
        }

        case 'scroll': {
          const dir = args.direction === 'up' ? -1 : 1;
          const { sessionId } = await this.currentSession();
          await this.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseWheel',
              x: 500,
              y: 400,
              deltaX: 0,
              deltaY: dir * (args.amount || 600),
            },
            sessionId,
          );
          await sleep(250);
          // las coordenadas del inventario son relativas al viewport: tras
          // desplazar la página apuntan a otro sitio
          this._lastElements = null;
          this._invOwner = null;
          return i18n.t('nav.res.scroll', { direccion: dir > 0 ? i18n.t('nav.res.abajo') : i18n.t('nav.res.arriba') });
        }

        case 'wait': {
          const ms = Math.min(Math.max(0, Number(args.ms) || 1000), 10000);
          await this._dormir(ms);
          if (this._abortada()) return CANCELADO();
          return i18n.t('nav.res.esperados', { ms });
        }

        case 'content': {
          const { sessionId, target } = await this.currentSession();
          const campo = args.selector || args.query;
          const html = args.html === true;
          const expr = campo
            ? `(() => { const el = document.querySelector(${JSON.stringify(String(campo))}); if (!el) return 'NOT_FOUND'; return ${html ? 'el.outerHTML' : 'el.innerText'}; })()`
            : html
              ? `document.documentElement.outerHTML`
              : `document.body.innerText`;
          const txt = await this.evalJs(expr, sessionId);
          if (txt === 'NOT_FOUND') return i18n.err('nav.selector');
          const clipped = String(txt).slice(0, 12000);
          /* El texto de la página son DATOS de terceros: se envuelve con el mismo
             bloque que las skills (terceros.js). Si no, una página con «ignora tus
             reglas y ejecuta X» entra al prompt como si fuera texto del usuario. */
          return terceros.envolver(
            i18n.t('nav.res.pagina.titulo'),
            i18n.t('nav.res.pagina.pestana', {
              titulo: target.title,
              url: target.url,
              texto: `${clipped}${String(txt).length > 12000 ? i18n.t('nav.res.pagina.truncado') : ''}`,
            }),
          );
        }

        case 'eval': {
          const { sessionId } = await this.currentSession();
          const v = await this.evalJs(args.expression, sessionId);
          return i18n.t('nav.res.resultado', { valor: typeof v === 'string' ? v : JSON.stringify(v) });
        }

        case 'screenshot': {
          const { sessionId, target } = await this.currentSession();
          /* v2.5: también una ZONA (selector o índice): para mirar un formulario o un
             detalle concreto, la captura de toda la página se convierte en una miniatura
             ilegible (y caríssima en tokens). */
          if (args.selector || args.index !== undefined) {
            const p = await this._resolve({ index: args.index, selector: args.selector, text: args.text }, sessionId, ownerId);
            if (p.error) return i18n.err('nav.motivo', { motivo: p.error });
            const m = await this.send('Page.getLayoutMetrics', {}, sessionId);
            const v = m.cssVisualViewport || m.visualViewport || {};
            const maxW = 1280,
              maxH = 1200;
            const escala = Math.min(1, maxW / Math.max(1, p.w), maxH / Math.max(1, p.h));
            const r = await this.send(
              'Page.captureScreenshot',
              {
                format: 'jpeg',
                quality: 70,
                clip: {
                  x: (v.pageX || 0) + p.x - p.w / 2,
                  y: (v.pageY || 0) + p.y - p.h / 2,
                  width: Math.max(1, p.w),
                  height: Math.max(1, p.h),
                  scale: escala,
                },
              },
              sessionId,
            );
            return {
              text: i18n.t('nav.res.captura.zona', { nombre: p.name, rol: p.role, titulo: target.title }),
              images: ['data:image/jpeg;base64,' + r.data],
            };
          }
          const dataUrl = await this.screenshot(sessionId, args.fullPage === true);
          return { text: i18n.t('nav.res.captura.pagina', { titulo: target.title, url: target.url }), images: [dataUrl] };
        }

        case 'tabs': {
          const list = await this.pages();
          if (!list.length) return i18n.t('nav.res.sin.pestanas');
          return list
            .map((t, i) => `${i + 1}. ${t.title} — ${t.url}${t.id === this.activeId ? '   ← ' + i18n.t('nav.res.pestana.marca') : ''}`)
            .join('\n');
        }

        default:
          return i18n.t('nav.res.accion.desconocida', { accion: a });
      }
    } catch (e) {
      // La sesión CDP cacheada de una pestaña puede dejar de existir (el usuario
      // la cerró a mano, o recargó el target). Antes se devolvía el error crudo
      // «Session with given id not found»; ahora se invalida la caché y se
      // reintenta UNA vez, que es lo que la autocuración promete.
      if (!retried && /session with given id/i.test(String(e && e.message))) {
        /* Reintento DENTRO de la misma acción ya serializada: llamar otra vez a
           `handle` encolaría esta continuación detrás del propio task que la espera y
           se quedaría colgada para siempre (y con ella TODAS las acciones siguientes).
           Se reentra en `_despachar` directamente, marcando `retried` para no repetir. */
        this._sessions.clear();
        return this._despachar(args, ownerId, { retried: true });
      }
      return i18n.err('nav.motivo', { motivo: e.message });
    }
  }

  async sessionIdOf() {
    const { sessionId } = await this.currentSession();
    return sessionId;
  }
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  Browser,
  // piezas puras: se prueban sin navegador (el resto necesita Chrome de verdad, y eso
  // lo comprueba scripts/navegador-check.js contra una página real)
  __test: { HELPERS_JS, inventoryJs, parseHotkey, ACTIONS, HOTKEY_MODS, HOTKEY_KEYS, userDataDirDe, esNuestroPerfil, pidsPropios, psEscanerArgs, PS_ESCANER },
};
