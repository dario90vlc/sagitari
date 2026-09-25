/* SAGITARI renderer — 10-chat.js (antes app.js 1-1339): utilidades, burbujas del chat, tarjetas de herramienta, traza y equipo
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const ic = (n, c) => window.SAGI_ICONS.icon(n, c);
/* ChatKit: modos, catálogo de herramientas, formato de duración y parser de
   planes. Todo eso vive en funciones puras (renderer/chatkit.js) para poder
testearlas de verdad desde Node. */
const K = window.ChatKit;

let CFG = { providers: [], active: null, settings: {}, presets: [] };
let busy = false;
let pendingAssistant = null;
let listening = false;
let mode = 'act';
let currentRunMode = 'act';   // modo con el que se lanzó el turno en curso
let lastAssistantEl = null;   // último bloque de respuesta (para regenerar/copiar)
let pendingTurn = null;       // estado del turno: grupo de herramientas, plan…
let lastTurnSummary = '';     // resumen del último turno («3 herramientas · 1,4 s»)

// ============ icon injection ============
$$('[data-i]').forEach(el => { el.innerHTML = ic(el.dataset.i); });

// ============ red de seguridad del renderer ============
/* Un error de script aquí dejaba la interfaz muda: la ventana sigue abierta
   pero sin iconos y sin botones, y no hay forma de saber por qué. Estos dos
   avisos lo hacen visible en el propio chat, en el feed y por toast; el
   contador (window.__errores) lo usa la comprobación automática de interfaz. */
window.__errores = [];
function reportarError(origen, detalle) {
  const msg = String((detalle && (detalle.message || (detalle.reason && detalle.reason.message))) || detalle || 'desconocido');
  window.__errores.push(origen + ': ' + msg);
  try { feed('Fallo en la interfaz — ' + msg.slice(0, 80), 'err'); } catch {}
  try { showToast('La interfaz encontró un problema: ' + msg.slice(0, 120)); } catch {}
  try {
    const b = ensureAssistantBubble();
    b.innerHTML = `<span class="errmsg">${ic('alert')} Fallo en la interfaz: ${esc(msg)}</span>`;
    finishAssistant('');
  } catch {}
}
window.addEventListener('error', (e) => {
  // los recursos que no cargan (una imagen, una fuente) no son fallos de la app
  if (e.target && e.target !== window && !e.error) return;
  reportarError('error', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => reportarError('promesa', e.reason));

// ============ routing ============
$$('.navitem').forEach(b => b.addEventListener('click', () => goto(b.dataset.view)));
function goto(view, opts) {
  // una vista inexistente (Alt+0, un data-view roto…) dejaba TODAS las
  // secciones ocultas: la app se quedaba en blanco. Sin destino, no se toca nada.
  const target = document.getElementById('view-' + view);
  if (!target) return;
  $$('.navitem').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
  // la vista activa queda marcada en la carcasa: el rail lateral solo se pinta
  // donde aporta (chat y agentes); en el resto de vistas está vacío
  const shell = $('#app');
  if (shell) shell.dataset.view = view;
  if (view === 'chat') $('#chatInput').focus();
  else if (opts && opts.focus) {
    // cambio de vista por atajo: el foco caía a <body>; se lleva al título de la vista
    const h = target.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }
  if (view === 'memory') renderMemory();
  if (view === 'tasks') renderTasks();
  if (view === 'tools') renderTools();
  if (view === 'mcp') renderMcp();
  if (view === 'agents') { renderToolTray(); renderHealth(); renderHabits(); }
  if (view === 'skills') { renderMarket(); renderSkills(); }
  if (view === 'projects') window.sagitari.workspaceGet().then(w => { $('#projPath').value = w; });
  if (view === 'history') renderHistory();
  if (view === 'settings') { showSetTab(setTabName); initDataPanel(); initAboutPanel(); }
  polishSwitches();   // los interruptores creados dinámicamente también deben ser accesibles
  syncChatBadge();
  setSideActive();
}

/** ¿El evento nace dentro de un campo editable? Los atajos globales deben cederle la tecla. */
function esCampoDeTexto(t) {
  const el = t instanceof Element ? t : null;
  return !!(el && el.closest('input, textarea, select, [contenteditable]'));
}

// ============ sidebar: compactar, contadores, atajos ============
// sin vista Inicio: Alt+1 es Chat… Alt+9 Ajustes
const VIEW_HOTKEY = ['chat', 'tasks', 'projects', 'agents', 'memory', 'skills', 'tools', 'history', 'settings'];

function applyCompact(on) {
  $('#app').classList.toggle('compact', on);
  const b = $('#sideToggle');
  b.title = (on ? 'Expandir' : 'Compactar') + ' la barra lateral (Alt+B)';
  b.setAttribute('aria-label', on ? 'Expandir barra lateral' : 'Compactar barra lateral');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  try { localStorage.setItem('sagi.sideCompact', on ? '1' : '0'); } catch {}
}
$('#sideToggle').onclick = () => applyCompact(!$('#app').classList.contains('compact'));
try { if (localStorage.getItem('sagi.sideCompact') === '1') applyCompact(true); } catch {}

/** Badge del sidebar: `dot` → puntito pulsante (actividad); si no, contador numérico. */
function setBadge(sel, value, opts) {
  const el = $(sel);
  if (!el) return;
  const o = opts || {};
  if (o.dot) {
    el.classList.add('live');
    el.textContent = '';
    el.hidden = !value;
    return;
  }
  el.classList.remove('live');
  el.textContent = String(value || 0);
  el.hidden = !(value > 0);
  el.classList.toggle('hot', !!o.hot);
}
function syncChatBadge() {
  // punto verde solo si el agente trabaja y NO estás mirando el chat
  const onChat = $('#view-chat').classList.contains('on');
  setBadge('#nbChat', busy && !onChat, { dot: true });
}
function setSideActive() {
  const sm = $('#sideModeBtn');
  if (!sm) return;
  const m = MODE_META[mode] || MODE_META.act;
  sm.classList.remove('act', 'plan', 'think');
  sm.classList.add(mode);
  const d = sm.querySelector('.dot');
  if (d) d.className = 'dot ' + m.dot;
  $('#sideModeLabel').textContent = m.label;
  sm.title = `Modo ${m.label} — ${m.desc} (Alt+M)`;
}

let sideBadgeErr = false;   // evita repetir el aviso en cada sondeo
async function refreshSidebar() {
  if (document.hidden) return;   // sin ventana visible no hay nada que pintar
  syncChatBadge();
  try {
    const tasks = await window.sagitari.tasksList();
    const live = ['running', 'pending', 'scheduled', 'paused', 'interrupted'];
    const n = tasks.filter(t => live.includes(t.status)).length;
    setBadge('#nbTasks', n, { hot: tasks.some(t => t.status === 'running') });
    const mem = await window.sagitari.memoryList();
    setBadge('#nbMemory', mem.length);
    const sk = await window.sagitari.skillsList();
    setBadge('#nbSkills', sk.length);
    sideBadgeErr = false;
  } catch (e) {
    // un canal IPC caído NO es «cero tareas»: avisa una vez con el error real
    if (!sideBadgeErr) {
      sideBadgeErr = true;
      const msg = String((e && e.message) || e || 'error desconocido');
      feed('No se pudo leer el estado lateral — ' + msg.slice(0, 80), 'err');
      showToast('No se pudo leer el estado: ' + msg.slice(0, 120));
    }
  }
}
setInterval(refreshSidebar, 3000);

// el pie abre el selector de modelo (#sideStatusBtn se cablea con el menú, más abajo)
$('#sideModeBtn').onclick = () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]);
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.shiftKey) return;
  // escribiendo en un campo, Alt+N pertenece a la edición: no cambia de vista
  if (esCampoDeTexto(e.target)) return;
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); $('#sideToggle').click(); return; }
  // Alt+0 no tiene vista asignada: VIEW_HOTKEY sólo llega hasta Alt+9
  if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    goto(VIEW_HOTKEY[parseInt(e.key, 10) - 1], { focus: true });
  }
});

// ============ clock + greeting (en el estado vacío del chat) ============

/* Escapa el texto para insertarlo como HTML o como valor de atributo. Las
   COMILLAS también se escapan: sin esto, un argumento de herramienta con una
   comilla rompía el atributo (title="…") y permitía inyectar manejadores. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --- saneado previo a la inserción ---
   El markdown lo produce el MODELO, así que nada de su HTML puede tocar el DOM
   real sin filtrarse antes. Se parsea en un documento INERTE (DOMParser: las
   imágenes no disparan ninguna petición y <style>/<base>/<link> no se aplican),
   se descarta todo lo que no esté en la whitelist y cualquier src/href que no
   sea data: o http(s):. */
const OK_TAGS = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'A', 'STRONG', 'EM', 'DEL', 'HR', 'SPAN', 'DIV']);
// etiquetas que se ELIMINAN con su contenido: nunca se muestran ni se conservan
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'BASE', 'LINK', 'META', 'TITLE', 'HEAD',
  'IFRAME', 'FRAME', 'FRAMESET', 'NOSCRIPT', 'TEMPLATE', 'OBJECT', 'EMBED', 'APPLET',
  'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'FORM', 'INPUT',
  'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'LABEL', 'MARQUEE']);
// atributos sin valor ejecutable que marked sí genera (presentación/tablas)
const OK_ATTRS = new Set(['class', 'title', 'alt', 'colspan', 'rowspan', 'align', 'start']);

function safeUrl(v) {
  const u = String(v || '').trim();
  return /^(data:|https?:)/i.test(u) ? u : '';
}

function cleanNode(node) {
  if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== 1) return document.createDocumentFragment();   // comentarios, etc.
  const tag = node.tagName.toUpperCase();
  if (DROP_TAGS.has(tag)) return document.createDocumentFragment();
  if (!OK_TAGS.has(tag)) {
    // etiqueta fuera de la whitelist: se elimina el elemento y se conserva su texto
    const frag = document.createDocumentFragment();
    for (const child of [...node.childNodes]) frag.appendChild(cleanNode(child));
    return frag;
  }
  const el = document.createElement(tag.toLowerCase());
  for (const attr of [...node.attributes]) {
    const n = attr.name.toLowerCase();
    if (n === 'href' || n === 'src') {
      const u = safeUrl(attr.value);
      if (u) el.setAttribute(n, u);
    } else if (OK_ATTRS.has(n)) {
      el.setAttribute(n, attr.value);
    }
    // on*, style, id, srcset… se descartan siempre
  }
  if (tag === 'A' && el.getAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
  for (const child of [...node.childNodes]) el.appendChild(cleanNode(child));
  return el;
}

function sanitizeHTML(html) {
  const inert = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const out = document.createElement('div');
  for (const node of [...inert.body.childNodes]) out.appendChild(cleanNode(node));
  return out.innerHTML;
}

/* render markdown real (marked + GFM): tablas, listas, títulos, reglas, código.
   Los enlaces abren en el navegador del sistema por delegación (ver el listener
   global de clic), nunca dentro de la app. */
function fmt(text) {
  if (window.marked) {
    const html = window.marked.parse(String(text || ''), { gfm: true, breaks: true });
    const div = document.createElement('div');
    div.innerHTML = sanitizeHTML(html);
    enhanceCode(div);
    // wrapper .md: neutraliza el pre-wrap del bubble para que el HTML de bloques
    // no genere líneas fantasma entre elementos
    return '<div class="md">' + div.innerHTML + '</div>';
  }
  // fallback mínimo si marked no cargó
  return esc(text);
}

/**
 * Da a cada bloque de código una cabecera propia: lenguaje + botón de copiar.
 * El copiado va por delegación (el HTML se serializa y pierde los listeners),
 * así que aquí sólo se marca el botón.
 */
function enhanceCode(root) {
  root.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement.classList.contains('codeblock')) return;
    const cls = String(code.className || '').match(/language-([\w+#-]+)/);
    const lang = cls ? cls[1] : '';
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    const head = document.createElement('div');
    head.className = 'codeblock-head';
    head.innerHTML = `<span>${esc(lang || 'código')}</span>`
      + `<button class="cb-copy" data-copy title="Copiar código">${ic('copy')}</button>`;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.append(head, pre);
  });
}

// copiar desde elementos generados como HTML (bloques de código del chat)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  const box = btn.closest('.codeblock');
  const pre = box && box.querySelector('pre');
  if (pre) copyText(pre.textContent, 'Código copiado');
});

// los enlaces del markdown se abren SIEMPRE en el navegador del sistema: la
// delegación evita re-enganchar un listener por cada token del stream
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !a.closest('.md')) return;
  e.preventDefault();
  window.sagitari.openExternal(a.href);
});

// ============ chat rendering ============
const msgs = $('#messages');
const chatEmpty = $('#chatEmpty');
const jumpDownBtn = $('#jumpDown');

/* --- desplazamiento inteligente: seguir el stream SÓLO si estás abajo del
todo. Si te has ido a leer hacia arriba, la vista no te arrastra. --- */
let pinned = true;
msgs.addEventListener('scroll', () => {
  pinned = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 70;
  jumpDownBtn.hidden = pinned;
});
jumpDownBtn.onclick = () => { pinned = true; jumpDownBtn.hidden = true; scroll(true); };
function scroll(force) {
  if (force || pinned) msgs.scrollTop = msgs.scrollHeight;
}
/* Las imágenes y capturas terminan de cargar DESPUÉS de pintar: la altura del
   hilo crece y el scroll se quedaba a medio camino. Reajustamos el final sólo
   si el usuario venía siguiendo el stream (pinned). */
function pinImage(img) {
  if (!img) return;
  const fix = () => { if (pinned) scroll(); };
  img.addEventListener('load', fix);
  img.addEventListener('error', fix);
}
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (pinned) scroll(); }).observe(msgs);
}
function nowClock(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
/** «Hoy» / «Ayer» / «12 de marzo», según cuánto hace de esa fecha. */
function etiquetaDia(ts) {
  const dias = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts || Date.now()).setHours(0, 0, 0, 0)) / 86400000);
  if (dias <= 0) return 'Hoy';
  if (dias === 1) return 'Ayer';
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}
/* Separador de día: se estampa cuando CAMBIA el día, no antes de cada turno.
   Antes cada respuesta del agente metía un «Hoy · 14:32» entre la pregunta y la
   respuesta —doce veces en una tarde—, y eso se lee como un corte del hilo, no
   como un separador temporal. Al cambiar de conversación se olvida (`stampDia`),
   así que el primero de cada hilo vuelve a salir. */
let stampDia = null;
function dayStamp(ts) {
  const dia = new Date(ts || Date.now()).toDateString();
  if (stampDia === dia) return null;
  stampDia = dia;
  const d = document.createElement('div');
  d.className = 'day';
  // solo el día: la hora ya va en cada mensaje, y «Hoy · 14:32» sobre el primero
  // repetía el mismo dato dos veces
  d.textContent = etiquetaDia(ts);
  msgs.appendChild(d);
  return d;
}
/** El estado vacío desaparece en cuanto hay una sola burbuja. */
function hideEmpty() { if (chatEmpty) chatEmpty.hidden = true; }
function showEmpty() { if (chatEmpty) chatEmpty.hidden = false; }

/** Chip con el modo que produjo un turno: ACT / PLAN / THINK. */
function modeBadge(m) {
  const M = K.mode(m);
  return `<span class="msg-mode" style="--mr:${M.rgb}" title="${esc(M.name)} — ${esc(M.tagline)}">${ic(M.icon)}${esc(M.label)}</span>`;
}

/** Aplica el color del modo a toda la vista del chat (--mode-c). */
function applyModeTheme(m) {
  const M = K.mode(m);
  $('#view-chat').dataset.mode = M.key;
  return M;
}

/** Resumen legible del último turno, para la barra de estado y el feed. */
function lastTurnLabel() { return lastTurnSummary; }

/** Barra de estado en vivo junto al título: qué está haciendo y en qué modo. */
function setChatStatus(text, kind) {
  const box = $('#chatStatus');
  if (!box) return;
  if (!text) {
    box.hidden = true;
    applyModeTheme(mode);
    return;
  }
  const M = kind === 'done' ? K.mode(currentRunMode || mode) : applyModeTheme(currentRunMode || mode);
  box.hidden = false;
  box.classList.toggle('done', kind === 'done');
  $('#chatStatusMode').textContent = M.label;
  $('#chatStatusText').textContent = text;
}

/** Copia al portapapeles avisando por toast (los tres puntos de la UI). */
async function copyText(text, okMsg) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s.trim()) { showToast('No hay nada que copiar'); return false; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(s);
    else {
      const ta = document.createElement('textarea');
      ta.value = s; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    showToast(okMsg || 'Copiado al portapapeles');
    return true;
  } catch { showToast('No se pudo copiar'); return false; }
}

/**
 * Crea un turno: avatar, cabeza (quién · modo · hora), burbuja y pie de acciones.
 * Devuelve la burbuja interna para escribir contenido, como antes.
 */
function bubble(role, opts) {
  const o = opts || {};
  hideEmpty();
  const m = document.createElement('div');
  m.className = 'msg ' + (role === 'user' ? 'me' : 'ai');
  const av = document.createElement('div');
  av.className = 'avatar';
  if (role === 'user') {
    av.textContent = (CFG.settings.userName || 'Tú').slice(0, 1).toUpperCase();
  } else {
    const img = document.createElement('img');
    img.className = 'avimg';
    img.src = 'assets/sagitari-mark.png';
    img.draggable = false;
    av.appendChild(img);
  }
  const col = document.createElement('div');
  col.className = 'msg-col';
  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<span class="msg-who">${esc(role === 'user' ? (CFG.settings.userName || 'Tú') : 'Sagitari')}</span>`
    + (o.mode && role === 'user' ? modeBadge(o.mode) : '')
    + `<span class="msg-ts">${nowClock(o.ts)}</span>`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  const b = document.createElement('div');
  b.className = 'bubble';
  body.appendChild(b);
  col.append(head, body);
  m.append(av, col);
  msgs.appendChild(m);
  scroll();
  return b;
}

/** Acciones al pie de un turno: copiar, regenerar (sólo el último) y voz. */
function msgActions(holder, text, opts) {
  const o = opts || {};
  const row = document.createElement('div');
  row.className = 'msg-actions';
  const mk = (icon, title, fn) => {
    const btn = document.createElement('button');
    btn.className = 'mact';
    btn.title = title;
    btn.innerHTML = ic(icon);
    btn.onclick = fn;
    return btn;
  };
  // copiar SIEMPRE el texto visible ya renderizado (igual que «Copiar toda la
  // conversación»): copiar el markdown crudo daba **negritas** y vallas
  row.appendChild(mk('copy', 'Copiar este mensaje', () => {
    const bub = holder.querySelector('.bubble') || holder;
    // el razonamiento es interno: al copiar el mensaje se copia la respuesta, no
    // lo que el modelo pensó por el camino (el bloque tiene su propio botón)
    const copia = bub.cloneNode(true);
    copia.querySelectorAll('.thinkblock').forEach(x => x.remove());
    copyText(copia.innerText, 'Mensaje copiado');
  }));
  if (o.retry) row.appendChild(mk('refresh', 'Regenerar esta respuesta', regenerate));
  if (o.speak) row.appendChild(mk('volume', 'Leer en voz alta', () => speak(text)));
  holder.appendChild(row);
  return row;
}

/** Sólo el último turno del agente ofrece «Regenerar»: los anteriores ya están superados. */
function refreshMsgActions() {
  const all = msgs.querySelectorAll('.msg.ai');
  all.forEach((m, i) => {
    m.querySelectorAll('[data-retry]').forEach(b => b.remove());
    const row = m.querySelector('.msg-actions');
    if (row && i === all.length - 1) {
      const btn = document.createElement('button');
      btn.className = 'mact';
      btn.dataset.retry = '1';
      btn.title = 'Regenerar esta respuesta';
      btn.innerHTML = ic('refresh');
      btn.onclick = regenerate;
      row.insertBefore(btn, row.children[1] || null);
    }
  });
}

async function regenerate() {
  if (busy) { showToast('Espera a que termine la ejecución actual'); return; }
  const last = lastAssistantEl;
  const msgEl = last ? last.closest('.msg') : null;
  const parent = msgEl ? msgEl.parentNode : null;
  const nextSibling = msgEl ? msgEl.nextSibling : null;
  if (msgEl) msgEl.remove();
  lastAssistantEl = null;
  showToast('Regenerando respuesta…');
  let r;
  try { r = await window.sagitari.retryChat(); }
  catch (e) { r = { ok: false, error: (e && e.message) || e }; }
  if (!r || r.ok === false) {
    // el reintento no salió: la respuesta sigue en el historial, así que se
    // devuelve a la vista en su sitio en lugar de dejarla desaparecer
    if (parent && msgEl) parent.insertBefore(msgEl, nextSibling);
    lastAssistantEl = msgEl ? msgEl.querySelector('.bubble') : null;
    refreshMsgActions();
    showToast('No se pudo regenerar: ' + ((r && r.error) || 'error desconocido'));
  }
}

/* ---------------------------------------------------------------------------
   Tarjetas de herramientas: cada llamada real (con sus argumentos, su
   duración y su resultado) en lugar de una línea truncada.
   --------------------------------------------------------------------------- */
function ensureAssistantBubble() {
  if (!pendingAssistant) {
    dayStamp();
    currentRunMode = currentRunMode || mode;
    pendingAssistant = bubble('ai');
    pendingTurn = {
      mode: currentRunMode, group: null, body: null, cards: [],
      tools: 0, totalMs: 0, plan: null, planIdx: 0,
      team: null,   // v2.2: tablero del equipo (delegaciones en vivo)
      think: null,  // v2.3: bloque de razonamiento (Ajustes ▸ Agente)
      fails: 0,     // herramientas que fallaron (la cabecera del grupo lo enseña)
    };
  }
  return pendingAssistant;
}

/* Grupo contenedor de las herramientas del turno (cabecera resumen + cuerpo).
   Se construye APARTE de `ensureToolGroup` porque una conversación guardada también lo
   necesita: al reabrir la app hay que repintar el mismo grupo sin que exista un turno
   vivo (ver `restaurarTraza`). Con el marcado duplicado, un arreglo en uno de los dos
   caminos dejaría al otro atrás. */
function buildToolGroup() {
  const g = document.createElement('div');
  g.className = 'tgroup open';
  const head = document.createElement('div');
  head.className = 'tgroup-head';
  // plegable operable por teclado: role button + aria-expanded sincronizado
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', 'true');
  head.innerHTML = `<span class="tg-ic">${ic('tools')}</span><b class="tg-title">Herramientas</b>`
    + `<span class="tg-fails" hidden></span>`
    + `<span class="tg-meta"></span><span class="tg-chev">${ic('chevron')}</span>`;
  const body = document.createElement('div');
  body.className = 'tgroup-body';
  const toggle = () => {
    const open = g.classList.toggle('open');
    g.classList.toggle('closed', !open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    g._tocado = true;   // el usuario decide: el cierre automático ya no lo pisa
  };
  head.onclick = toggle;
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  g.append(head, body);
  return { el: g, body, head, title: head.querySelector('.tg-title'), meta: head.querySelector('.tg-meta'), fails: head.querySelector('.tg-fails') };
}

function ensureToolGroup() {
  const b = ensureAssistantBubble();
  if (!pendingTurn.group) {
    const grp = buildToolGroup();
    b.appendChild(grp.el);
    pendingTurn.group = grp;
  }
  return pendingTurn.group;
}

function refreshToolGroup() {
  if (!pendingTurn || !pendingTurn.group) return;
  const g = pendingTurn.group;
  g.title.textContent = K.toolCount(pendingTurn.tools);
  /* Meta: mientras quedan tarjetas abiertas se dice cuántas hay EN CURSO (antes solo
     cabía «en curso…», y con doce herramientas no decía cuánto faltaba); al cerrarse
     todas, el tiempo total acumulado. */
  const enCurso = pendingTurn.cards.filter(c => c.classList.contains('run')).length;
  g.meta.textContent = enCurso ? enCurso + ' en curso' : (pendingTurn.totalMs ? K.fmtDuration(pendingTurn.totalMs) : '');
  /* Y si algo falló, la cabecera lo dice: con el grupo plegado, un fallo dentro era
     invisible hasta abrirlo a mano. */
  const fallos = pendingTurn.fails || 0;
  if (g.fails) {
    g.fails.hidden = !fallos;
    g.fails.textContent = fallos === 1 ? '1 fallo' : fallos + ' fallos';
  }
  g.el.classList.toggle('has-fails', !!fallos);
}

/** Pliega el grupo de herramientas al llegar la respuesta, si el usuario no lo abrió. */
function cerrarHerramientas() {
  const g = pendingTurn && pendingTurn.group;
  if (!g || g.el._tocado) return;
  g.el.classList.remove('open');
  g.el.classList.add('closed');
  g.head.setAttribute('aria-expanded', 'false');
}

/* ---- v2.3: razonamiento del modelo (opcional, Ajustes ▸ Agente) ----
   Los modelos que razonan (Claude con razonamiento ampliado, la serie o/ GPT-5,
   DeepSeek R1…) cuentan su proceso antes de responder. Con el ajuste activado el
   agente lo reenvía en `thinking_delta` y aquí se pinta en un bloque plegable que
   va ANTES de todo lo demás: se lee en vivo mientras piensa y se pliega solo
   cuando empieza a contestar. Nunca se pronuncia —la lectura por frases solo mira
   los `delta`— ni se copia con el mensaje: es texto interno, no la respuesta. */
/**
 * Primera línea con sustancia de un texto: es el resumen que se enseña cuando el bloque
 * está plegado. Se quitan vallas de código y marcas de markdown porque un resumen que
 * empieza por «#» o «- » no informa de nada.
 */
function primeraLineaUtil(texto, max = 130) {
  const lineas = String(texto || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/^[\s>*#\-•]+/, '').replace(/\*\*/g, '').trim())
    .filter(l => l.length >= 18);
  const t = lineas[0] || '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Cuántas líneas tiene el razonamiento (dato barato que da idea de su profundidad). */
function nLineas(texto) { return String(texto || '').split(/\r?\n/).filter(l => l.trim()).length; }

/* Reloj del razonamiento: mientras el modelo piensa, la cabecera dice cuánto lleva. Sin
   esto, un modelo que se toma 40 s en razonar parece colgado. El resumen plegado y el
   dato de duración se pintan en `metaRazonamiento`. */
let thinkTimer = 0;
let thinkVivo = null;
/** Segundos para los relojes EN VIVO: «0,4 s», «12,4 s», «45 s». (fmtDuration da «400 ms»
    para lo que dura menos de un segundo, que en un contador que corre cada 250 ms parpadea.) */
function segundosUI(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return (s < 10 ? s.toFixed(1) : String(Math.round(s))).replace('.', ',') + ' s';
}

function metaRazonamiento(d) {
  const el = d && d.querySelector && d.querySelector('.th-meta');
  if (!el) return;
  const cerrado = d.classList.contains('closed');
  if (!d._terminado) {
    el.classList.remove('gist');
    el.textContent = 'pensando… ' + segundosUI(Date.now() - (d._inicio || Date.now()));
    return;
  }
  if (cerrado) {
    // plegado: manda el resumen. Es lo que permite seguir el hilo sin abrir cada bloque.
    const g = primeraLineaUtil(d._texto);
    el.classList.toggle('gist', !!g);
    el.textContent = g || ('pensó ' + K.fmtDuration(d._ms || 0));
    return;
  }
  el.classList.remove('gist');
  el.textContent = 'pensó ' + K.fmtDuration(d._ms || 0) + ' · ' + nLineas(d._texto) + ' líneas';
}
function relojRazonamiento(d) {
  thinkVivo = d;
  if (thinkTimer) return;
  thinkTimer = setInterval(() => {
    const t = thinkVivo;
    if (!t || !t.isConnected || t._terminado) { clearInterval(thinkTimer); thinkTimer = 0; thinkVivo = null; return; }
    metaRazonamiento(t);
  }, 250);
}

/* El bloque se construye aparte por el mismo motivo que el grupo de herramientas: una
   conversación guardada tiene que poder repintar su razonamiento sin turno vivo. */
function buildThinkBlock() {
  const d = document.createElement('div');
  d.className = 'thinkblock open';
  d.innerHTML = '<div class="think-head" role="button" tabindex="0" aria-expanded="true">'
    + `<span class="th-ic">${ic('brain')}</span><b>Razonamiento</b>`
    + '<span class="th-meta">pensando…</span>'
    + `<button class="th-copy" title="Copiar el razonamiento">${ic('copy')}</button>`
    + `<span class="th-chev">${ic('chevron')}</span></div>`
    + '<div class="think-body"></div>';
  const head = d.querySelector('.think-head');
  d._inicio = Date.now();
  const toggle = () => {
    const open = d.classList.toggle('open');
    d.classList.toggle('closed', !open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    d._tocado = true;   // si el usuario lo abre, ya no se cierra solo
    metaRazonamiento(d);   // plegado enseña el resumen; abierto, la duración y las líneas
  };
  head.onclick = (e) => { if (e.target.closest('.th-copy')) return; toggle(); };
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  d.querySelector('.th-copy').onclick = (e) => { e.stopPropagation(); copyText(d._texto || '', 'Razonamiento copiado'); };
  return d;
}

function ensureThinkBlock() {
  const b = ensureAssistantBubble();
  if (!pendingTurn.think || !pendingTurn.think.isConnected) {
    const d = buildThinkBlock();
    // el razonamiento va el PRIMERO: se piensa antes de usar herramientas y de responder
    b.insertBefore(d, b.firstChild);
    pendingTurn.think = d;
    relojRazonamiento(d);
  }
  return pendingTurn.think;
}

/** Pinta el razonamiento AHORA (sin esperar a un frame). */
function pintarRazonamiento(t) {
  if (!t || !t.isConnected) return;
  t.querySelector('.think-body').innerHTML = fmt(t._texto || '');
}

/** Repinta el razonamiento en el siguiente frame (llega a trozos, como el texto).
    Dos cautelas, ambas aprendidas de fallos reales:
    · el bloque se recuerda EN LA PROPIA FUNCIÓN y no se busca en `pendingTurn`: el último
      frame de un turno puede caer después de que el turno se cierre (pendingTurn = null);
    · esto es solo para el goteo en vivo. El CIERRE del bloque se pinta de forma síncrona
      (ver `thinking_done`), porque con la ventana minimizada u oculta —o en un arranque
      de prueba con `--hidden`— Chromium no dispara `requestAnimationFrame` y el bloque se
      quedaba con su texto guardado pero VACÍO en pantalla. */
let thinkRaf = 0;
let thinkTarget = null;
function scheduleThinkRender(d) {
  thinkTarget = d || (pendingTurn && pendingTurn.think) || thinkTarget;
  if (thinkRaf) return;
  thinkRaf = requestAnimationFrame(() => {
    thinkRaf = 0;
    const t = thinkTarget;
    thinkTarget = null;
    pintarRazonamiento(t);
    scroll();
  });
}

/** Pliega el razonamiento cuando la respuesta empieza (si el usuario no lo abrió). */
function cerrarRazonamiento() {
  const d = pendingTurn && pendingTurn.think;
  if (!d || d._tocado) return;
  d.classList.remove('open');
  d.classList.add('closed');
  d.querySelector('.think-head').setAttribute('aria-expanded', 'false');
  metaRazonamiento(d);
}

/* Construye la tarjeta de una herramienta (sin reloj y sin grupo): la usan el turno EN
   VIVO y el repintado de una conversación guardada. */
function buildToolCard(ev) {
  const meta = K.tool(ev.name);
  const card = document.createElement('div');
  card.className = 'tcard run';
  card.dataset.tool = ev.name;
  const sub = ev.subagent && K.subagent(ev.subagent);
  const args = K.summarizeArgs(ev.name, ev.args);
  card.innerHTML = `
    <div class="tcard-head">
      <span class="tcard-ic">${ic(meta.icon)}</span>
      <span class="tcard-name">${esc(meta.label)}</span>
      ${sub ? `<span class="tcard-sub" title="Subagente">${esc(sub.label)}</span>` : ''}
      <span class="tcard-args" title="${esc(JSON.stringify(ev.args || {}))}">${esc(args)}</span>
      <span class="tcard-time"></span>
      <span class="tcard-chev">${ic('chevron')}</span>
    </div>
    <div class="tcard-body"></div>`;
  const body = card.querySelector('.tcard-body');
  body.innerHTML = `<div class="tb-label">ARGUMENTOS</div><pre class="args">${esc(JSON.stringify(ev.args || {}, null, 2))}</pre>`;
  // tarjeta plegable operable por teclado
  const tchead = card.querySelector('.tcard-head');
  tchead.setAttribute('role', 'button');
  tchead.setAttribute('tabindex', '0');
  tchead.setAttribute('aria-expanded', 'false');
  const toggleCard = () => {
    const open = card.classList.toggle('open');
    tchead.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  tchead.onclick = toggleCard;
  tchead.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); }
  });
  return card;
}

/** Abre la tarjeta de una herramienta que empieza a ejecutarse (turno en vivo). */
function toolCard(ev) {
  ensureAssistantBubble();
  const group = ensureToolGroup();
  const card = buildToolCard(ev);
  card._t0 = Date.now();
  /* Reloj de la tarjeta: mientras corre, cuenta. Un comando que tarda 40 s sin decir
     nada se lee como «se ha colgado»; con el tiempo en marcha, se lee como trabajo. */
  card._tick = setInterval(() => {
    if (!card.isConnected || !card.classList.contains('run')) { clearInterval(card._tick); return; }
    const el = card.querySelector('.tcard-time');
    if (el) el.textContent = segundosUI(Date.now() - (card._t0 || Date.now()));
  }, 400);
  group.body.appendChild(card);
  pendingTurn.cards.push(card);
  pendingTurn.tools++;
  refreshToolGroup();
  scroll();
  return card;
}

/**
 * Pinta en la tarjeta el resultado, la duración y si falló. Devuelve `{ok, took}`.
 * Compartida por el turno EN VIVO y por el repintado de una conversación guardada: la
 * tarjeta de un turno viejo tiene que verse EXACTAMENTE igual que la del turno vivo.
 */
function pintarResultadoTarjeta(card, ev) {
  const ok = (ev.ok !== undefined && ev.ok !== null) ? !!ev.ok : !K.looksFailed(ev.result);
  const ms = Number(ev.durationMs) || 0;
  card.classList.remove('run');
  card.classList.add(ok ? 'done' : 'err');
  clearInterval(card._tick);
  const took = ms || (card._t0 ? Date.now() - card._t0 : 0);
  card.querySelector('.tcard-ic').innerHTML = ic(ok ? 'check' : 'alert');
  card.querySelector('.tcard-time').textContent = K.fmtDuration(took);
  /* Un fallo tiene que poder leerse SIN desplegar la tarjeta: la primera línea del error
     va en la cabecera. Antes había que abrir cada tarjeta roja para saber qué pasó. */
  if (!ok) {
    const head = card.querySelector('.tcard-head');
    if (head && !head.querySelector('.tcard-note')) {
      const note = document.createElement('span');
      note.className = 'tcard-note';
      const linea = String(ev.result || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'falló sin decir por qué';
      note.textContent = linea.replace(/^Error:\s*/i, '').slice(0, 160);
      note.title = String(ev.result || '').slice(0, 2000);
      head.insertBefore(note, head.querySelector('.tcard-time'));
    }
  }
  const body = card.querySelector('.tcard-body');
  const old = body.querySelector('[data-result]');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.dataset.result = '1';
  const salida = String(ev.result || '');
  const cuantas = salida ? salida.split(/\r?\n/).length : 0;
  wrap.innerHTML = `<div class="tb-label">RESULTADO${cuantas > 1 ? ' · ' + cuantas + ' líneas' : ''}<button class="tcard-copy" title="Copiar resultado">${ic('copy')}</button></div>`
    + `<pre>${esc(K.clip(salida, 1200)) || '(sin salida)'}</pre>`;
  wrap.querySelector('.tcard-copy').onclick = (e) => { e.stopPropagation(); copyText(ev.result, 'Resultado copiado'); };
  body.appendChild(wrap);
  return { ok, took };
}

/** Cierra la tarjeta del turno en vivo con su resultado, su duración y si falló. */
function completeToolCard(ev) {
  if (!pendingTurn) return;
  let card = null;
  for (let i = pendingTurn.cards.length - 1; i >= 0; i--) {
    const c = pendingTurn.cards[i];
    if (c.dataset.tool === ev.name && c.classList.contains('run')) { card = c; break; }
  }
  if (!card) { toolCard({ name: ev.name, args: {} }); card = pendingTurn.cards[pendingTurn.cards.length - 1]; }
  const { ok, took } = pintarResultadoTarjeta(card, ev);
  if (!ok) pendingTurn.fails = (pendingTurn.fails || 0) + 1;
  pendingTurn.totalMs += took;
  refreshToolGroup();
  // en modo PLAN, cada herramienta completada marca un paso del plan
  advancePlan();
  scroll();
}

/**
 * Cierre de una delegación: la tarjeta del subagente con su estado y su evidencia.
 * Antes el `delegate` quedaba como una tarjeta de herramienta («Subagente · Investigador
 * → tarea») y su cierre no se veía en ninguna parte: el RESULT/STATUS/EVENCE del
 * subagente se quedaba dentro del prompt del orquestador. Todo lo que se enseña aquí
 * viene ya calculado del evento (agent.js), no se reinterpreta en la interfaz.
 */
function buildDelegationCard(ev) {
  const sub = K.subagent(ev.subagent) || { label: 'Subagente', icon: 'agents', cls: 'a-p2' };
  const estado = String(ev.status || 'OK').toUpperCase();
  const fallo = estado === 'FAILED';
  const parcial = estado === 'PARTIAL';
  const card = document.createElement('div');
  card.className = 'tcard dcard ' + (fallo ? 'err' : (parcial ? 'part' : 'done'));
  if (ev.subagent) card.dataset.delegate = String(ev.subagent);   // nunca `dataset.tool`: no es una herramienta
  const etiqueta = fallo ? 'FALLÓ' : (parcial ? 'PARCIAL' : 'OK');
  card.innerHTML = `
    <div class="tcard-head">
      <span class="tcard-ic">${ic(fallo ? 'alert' : 'check')}</span>
      <span class="tcard-name">${esc(sub.label)}</span>
      <span class="dcard-status ${fallo ? 'fail' : (parcial ? 'part' : 'ok')}" title="Estado del subagente">${esc(etiqueta)}</span>
      <span class="tcard-args" title="${esc(String(ev.result || ''))}">${esc(K.clip(String(ev.result || ''), 110))}</span>
      <span class="tcard-time">${ev.durationMs ? esc(K.fmtDuration(Number(ev.durationMs))) : ''}</span>
      <span class="tcard-chev">${ic('chevron')}</span>
    </div>
    <div class="tcard-body"></div>`;
  const body = card.querySelector('.tcard-body');
  body.innerHTML = `<div class="tb-label">RESULTADO</div><pre>${esc(String(ev.result || '(sin resumen)'))}</pre>`
    + (ev.details ? `<div class="tb-label">DETALLES</div><pre>${esc(String(ev.details))}</pre>` : '')
    + (ev.evidence ? `<div class="tb-label">EVIDENCIA</div><pre>${esc(String(ev.evidence))}</pre>` : '');
  const head = card.querySelector('.tcard-head');
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', 'false');
  const toggle = () => {
    const open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.onclick = toggle;
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return card;
}

function delegationCard(ev) {
  if (!pendingTurn) return;
  ensureAssistantBubble();
  const group = ensureToolGroup();
  const card = buildDelegationCard(ev);
  group.body.appendChild(card);
  pendingTurn.cards.push(card);   // el turno la limpia igual que las demás
  scroll();
  return card;
}

/* ---------- conversación guardada: repintar un turno que ya pasó ----------
   Hasta ahora, al cerrar la app y volver a abrirla el hilo repintaba SOLO las burbujas de
   texto: las herramientas, el razonamiento y sus tiempos desaparecían de la vista y el
   usuario se quedaba con una respuesta sin saber cómo se había llegado a ella (era su
   queja literal: «las herramientas que usó ya no se muestran»). El motor guarda un rastro
   compacto por turno y aquí se reconstruye el MISMO bloque plegable del turno vivo, ya
   terminado y sin relojes: los relojes de un turno cerrado serían mentira. */
function restaurarTraza(bubbleEl, trace, html) {
  const tools = (trace && Array.isArray(trace.tools)) ? trace.tools : [];
  const think = (trace && trace.think && trace.think.text) ? trace.think : null;
  if (think) {
    const d = buildThinkBlock();
    d._texto = String(think.text);
    d._ms = Number(think.ms) || 0;
    d._terminado = true;
    d.querySelector('.think-body').innerHTML = fmt(d._texto);
    d.classList.remove('open');
    d.classList.add('closed');
    d.querySelector('.think-head').setAttribute('aria-expanded', 'false');
    metaRazonamiento(d);
    bubbleEl.appendChild(d);
  }
  /* v2.6: la última lista de tareas del turno, en su sitio (tras el razonamiento y
     antes de las herramientas): al reabrir la conversación se ve en qué quedó el plan. */
  if (trace.todos && trace.todos.length) bubbleEl.appendChild(buildTodoCard(trace.todos));
  if (tools.length) {
    const grp = buildToolGroup();
    let fallos = 0;
    let total = 0;
    for (const t of tools) {
      if (t.delegate) {
        grp.body.appendChild(buildDelegationCard({ subagent: t.delegate, status: t.status, result: t.result, durationMs: t.ms }));
        if (String(t.status || '').toUpperCase() === 'FAILED') fallos++;
        continue;
      }
      const card = buildToolCard({ name: t.name, args: t.args || {}, subagent: t.subagent });
      /* Sin `ok` la herramienta empezó y el turno se cortó antes de su resultado: se dice
         tal cual, en vez de pintarle un check verde que nunca ocurrió. */
      const r = t.ok === undefined
        ? pintarResultadoTarjeta(card, { name: t.name, ok: false, durationMs: t.ms, result: 'Esta herramienta no llegó a devolver su resultado: el turno se cortó antes.' })
        : pintarResultadoTarjeta(card, { name: t.name, ok: t.ok, result: t.result, durationMs: t.ms });
      if (!r.ok) fallos++;
      total += r.took;
      grp.body.appendChild(card);
    }
    grp.title.textContent = K.toolCount(tools.length);
    grp.meta.textContent = total ? K.fmtDuration(total) : '';
    grp.fails.hidden = !fallos;
    grp.fails.textContent = fallos === 1 ? '1 fallo' : fallos + ' fallos';
    grp.el.classList.toggle('has-fails', !!fallos);
    // como al cerrar un turno: los detalles plegados y la respuesta a la vista
    grp.el.classList.remove('open');
    grp.el.classList.add('closed');
    grp.head.setAttribute('aria-expanded', 'false');
    bubbleEl.appendChild(grp.el);
  }
  if (html) {
    const div = document.createElement('div');
    div.innerHTML = fmt(html);
    bubbleEl.appendChild(div);
  }
}

/* ---------- v2.2: tablero del equipo (delegaciones EN VIVO) ----------
   Las tarjetas de herramienta ya enseñan cada paso, pero responder a «quién está
   trabajando ahora mismo» exigía leerlas todas. Este tablero es una tira de chips, uno
   por delegación del turno: se pinta al EMPEZAR (delegate_start, con la subtarea) y se
   resuelve al acabar (delegate_done) con OK, PARCIAL o fallo. Así se ve al instante qué
   está haciendo cada subagente sin esperar al cierre del turno. */
function etiquetaEquipo(ev) {
  const who = (K.subagent(ev.subagent) || {}).label || 'Subagente';
  const tarea = String(ev.task || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return who + (tarea ? ' · ' + tarea : '');
}

function ensureTeamBoard() {
  const b = ensureAssistantBubble();
  if (!pendingTurn.team) {
    const g = document.createElement('div');
    g.className = 'tgroup team open';
    const head = document.createElement('div');
    head.className = 'tgroup-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'true');
    head.innerHTML = `<span class="tg-ic">${ic('agents')}</span><b class="tg-title">Equipo</b>`
      + `<span class="tg-meta"></span><span class="tg-chev">${ic('chevron')}</span>`;
    const body = document.createElement('div');
    body.className = 'tgroup-body';
    const toggle = () => {
      const open = g.classList.toggle('open');
      g.classList.toggle('closed', !open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    head.onclick = toggle;
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    g.append(head, body);
    // el tablero va ARRIBA del grupo de herramientas: es el resumen, no el detalle
    if (pendingTurn.group) b.insertBefore(g, pendingTurn.group.el);
    else b.appendChild(g);
    pendingTurn.team = { el: g, body, meta: head.querySelector('.tg-meta'), chips: [] };
  }
  return pendingTurn.team;
}

function equipoEnMarcha() {
  const t = pendingTurn && pendingTurn.team;
  if (!t) return 0;
  return t.chips.filter(c => !c.cerrado).length;
}

function equipoChip(ev) {
  const board = ensureTeamBoard();
  const chip = document.createElement('div');
  chip.className = 'toolchip run';
  chip.dataset.subagent = String(ev.subagent || '');
  chip.title = etiquetaEquipo(ev) + (ev.expect ? '\n\nCriterio de éxito: ' + String(ev.expect).slice(0, 300) : '');
  chip.innerHTML = `<span class="tc-mark"><span class="pulse-dot"></span></span><span class="tc-txt">${esc(etiquetaEquipo(ev))}</span>`;
  board.body.appendChild(chip);
  board.chips.push({ subagent: String(ev.subagent || ''), el: chip, cerrado: false });
  board.meta.textContent = `${equipoEnMarcha()} en marcha`;
  return chip;
}

function equipoCierra(ev) {
  if (!pendingTurn || !pendingTurn.team) return;
  const estado = String(ev.status || 'OK').toUpperCase();
  // se cierra la fila que abrió ESTA subtarea; si no la encuentra (el turno se recortó),
  // cae a la primera abierta de ese agente y, en último caso, a la primera abierta
  const abiertas = pendingTurn.team.chips.filter(c => !c.cerrado);
  const chip = abiertas.find(c => c.subagent === String(ev.subagent || '') && c.el.title.startsWith(etiquetaEquipo(ev)))
    || abiertas.find(c => c.subagent === String(ev.subagent || ''))
    || abiertas[0];
  if (!chip) return;
  chip.cerrado = true;
  chip.el.classList.remove('run');
  chip.el.classList.add(estado === 'FAILED' ? 'err' : 'done');
  const mark = chip.el.querySelector('.tc-mark');
  if (mark) mark.innerHTML = ic(estado === 'FAILED' ? 'alert' : 'check');
  if (estado === 'PARTIAL') {
    const txt = chip.el.querySelector('.tc-txt');
    if (txt) txt.textContent += ' · a medias';
  }
  const enMarcha = equipoEnMarcha();
  pendingTurn.team.meta.textContent = enMarcha ? `${enMarcha} en marcha` : 'todos han terminado';
}

/* ---- v2.5: deshacer el cambio del turno ---------------------------------- */

/** Ofrece deshacer los archivos que ha tocado el turno ({files} son rutas relativas). */
function mostrarDeshacer(archivos) {
  const bar = $('#undoBar');
  if (!bar) return;
  const lista = Array.isArray(archivos) ? archivos : [];
  const txt = $('#undoText');
  if (txt) {
    const muestra = lista.slice(0, 3).join(', ') + (lista.length > 3 ? '…' : '');
    txt.textContent = lista.length === 1
      ? 'Se ha cambiado 1 archivo (' + muestra + ').'
      : 'Se han cambiado ' + lista.length + ' archivos (' + muestra + ').';
  }
  bar.hidden = false;
}

function ocultarDeshacer() { const bar = $('#undoBar'); if (bar) bar.hidden = true; }

if ($('#undoBtn')) $('#undoBtn').onclick = async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await window.sagitari.undoChanges();
    if (!r || r.ok === false) {
      // si el motor dice que ya no hay nada que deshacer, el botón no debe quedarse ahí
      if (r && /no hay ningún cambio/.test(String(r.error || ''))) ocultarDeshacer();
      showToast('No se pudo deshacer: ' + ((r && r.error) || 'error desconocido'));
      return;
    }
    ocultarDeshacer();
    const partes = [];
    if (r.restaurados) partes.push(r.restaurados + ' restaurado(s)');
    if (r.borrados) partes.push(r.borrados + ' borrado(s)');
    if (r.fallos) partes.push(r.fallos + ' sin poder tocar (no se pudo leer su contenido antes)');
    showToast('Cambios del turno deshechos: ' + (partes.join(', ') || 'no había nada') );
    feed('Cambio del turno deshecho', 'blu');
  } catch (err) {
    showToast('No se pudo deshacer: ' + ((err && err.message) || err));
  } finally { btn.disabled = false; }
};

function toolChip(text, state) {
  const b = ensureAssistantBubble();
  if (!pendingTurn || !pendingTurn.body) {
    const box = document.createElement('div');
    box.className = 'chip-run';
    b.appendChild(box);
    if (pendingTurn) pendingTurn.body = box;
  }
  const c = document.createElement('div');
  c.className = 'toolchip' + (state ? ' ' + state : '');
  const mark = state === 'done' ? ic('check') : state === 'err' ? ic('alert') : '<span class="pulse-dot"></span>';
  c.innerHTML = `<span class="tc-mark">${mark}</span><span class="tc-txt" title="${esc(text)}">${esc(text)}</span>`;
  (pendingTurn ? pendingTurn.body : b).appendChild(c);
  scroll();
}

/* ---- plan del modo PLAN: se pinta como checklist y se marca al avanzar ---- */
function renderPlanCard(container, steps, before, prev) {
  const card = document.createElement('div');
  card.className = 'plancard';
  card.innerHTML = `<div class="plancard-head">${ic('map')}<b>PLAN</b><span class="pl-count"></span></div>`
    + '<ol>' + steps.map(s => `<li data-step="${s.n}"><span class="pl-n">${s.n}</span><span>${esc(s.text)}</span></li>`).join('') + '</ol>';
  if (before) container.insertBefore(card, before);
  else container.appendChild(card);
  const count = card.querySelector('.pl-count');
  const items = [...card.querySelectorAll('li')];
  /* Al repintar la tarjeta (el plan creció tras el último delta) se conservan los
     pasos ya cumplidos: si no, volvían a aparecer pendientes y el contador se
     reiniciaba a 0. */
  const done = Math.max(0, Math.min(prev ? (prev.done || 0) : 0, items.length));
  for (let i = 0; i < done; i++) items[i].classList.add('done');
  count.textContent = done ? `${done}/${items.length} pasos` : `${steps.length} pasos`;
  return {
    el: card,
    total: items.length,
    done,
    next() {
      const cur = items[this.done];
      if (!cur) return;
      cur.classList.add('now');
    },
    /** Marca como cumplido el paso en curso y pasa el foco al siguiente. */
    advance() {
      const cur = items[this.done];
      if (!cur) return;
      cur.classList.remove('now');
      cur.classList.add('done');
      this.done++;
      count.textContent = `${this.done}/${this.total} pasos`;
      if (items[this.done]) items[this.done].classList.add('now');
    },
  };
}
function advancePlan() {
  if (pendingTurn && pendingTurn.plan) pendingTurn.plan.advance();
}

/* ---- v2.6: lista de tareas VIVA (todo_write) ----
   A diferencia del plan del modo PLAN (que se parsea del TEXTO de la respuesta), esta
   lista la posee el modelo: la crea y la actualiza con la herramienta todo_write y aquí
   se pinta el estado REAL que guardó el agente. Cada actualización repinta la tarjeta
   en su sitio, conservando la posición que ya tenía en el turno. */
function todoStatusMeta(status) {
  return status === 'completed' ? { cls: 'done', icn: 'check' }
    : status === 'in_progress' ? { cls: 'now', icn: 'play' }
    : { cls: '', icn: '' };
}
function todoCount(todos) {
  const done = todos.filter(t => t && t.status === 'completed').length;
  return done ? done + '/' + todos.length + ' pasos' : todos.length + ' pasos';
}
function buildTodoCard(todos) {
  const card = document.createElement('div');
  card.className = 'plancard todocard';
  card.innerHTML = `<div class="plancard-head">${ic('list')}<b>TAREAS</b><span class="pl-count">${esc(todoCount(todos))}</span></div>`
    + '<ol>' + todos.map(t => {
      const m = todoStatusMeta(t && t.status);
      // mientras se hace, se enseña en presente (activeForm) si el modelo lo dio
      const txt = (t && t.status === 'in_progress' && t.activeForm) ? t.activeForm : (t && t.content) || '';
      return `<li class="${m.cls}"><span class="pl-n">${m.icn ? ic(m.icn) : ''}</span><span>${esc(txt)}</span></li>`;
    }).join('') + '</ol>';
  return card;
}
function todosCard(ev) {
  const todos = Array.isArray(ev.todos) ? ev.todos : [];
  // lista vacía: el modelo la borró — la tarjeta anterior desaparece (no se queda
  // colgada enseñando un plan que ya no existe)
  if (!todos.length) {
    if (pendingTurn && pendingTurn.todocard && pendingTurn.todocard.isConnected) {
      pendingTurn.todocard.remove();
      pendingTurn.todocard = null;
    }
    return;
  }
  ensureAssistantBubble();
  if (pendingTurn.todocard && pendingTurn.todocard.isConnected) {
    const fresh = buildTodoCard(todos);
    pendingTurn.todocard.replaceWith(fresh);
    pendingTurn.todocard = fresh;
  } else {
    const card = buildTodoCard(todos);
    const stream = pendingAssistant.querySelector('.stream');
    if (stream) pendingAssistant.insertBefore(card, stream);
    else pendingAssistant.appendChild(card);
    pendingTurn.todocard = card;
  }
  scroll();
}

/** Cierra las tarjetas que quedaron «en curso…» cuando el turno muere a medias. */
function closePendingCards(failed) {
  if (!pendingTurn) return;
  // un razonamiento que se quedó a medias se marca: «pensando…» para siempre mentiría
  if (pendingTurn.think) {
    const meta = pendingTurn.think.querySelector('.th-meta');
    if (meta && /pensando/.test(meta.textContent)) meta.textContent = 'interrumpido';
  }
  // los chips del tablero del equipo que quedaron «en marcha» también se cierran
  if (pendingTurn.team) {
    for (const chip of pendingTurn.team.chips) {
      if (chip.cerrado) continue;
      chip.cerrado = true;
      chip.el.classList.remove('run');
      chip.el.classList.add(failed ? 'err' : 'done');
      const mark = chip.el.querySelector('.tc-mark');
      if (mark) mark.innerHTML = ic(failed ? 'alert' : 'close');
    }
    pendingTurn.team.meta.textContent = failed ? 'interrumpido' : 'detenido';
  }
  for (const card of pendingTurn.cards) {
    if (!card.classList.contains('run')) continue;   // ya tenía su resultado
    card.classList.remove('run');
    card.classList.add(failed ? 'err' : 'cancelled');
    const mark = card.querySelector('.tcard-ic');
    if (mark) mark.innerHTML = ic(failed ? 'alert' : 'close');
    const body = card.querySelector('.tcard-body');
    if (body && !body.querySelector('[data-result]')) {
      const wrap = document.createElement('div');
      wrap.dataset.result = '1';
      wrap.innerHTML = `<div class="tb-label">${failed ? 'ERROR' : 'CANCELADO'}</div>`
        + `<pre>${failed ? 'La ejecución falló antes de recibir el resultado.' : 'Detenido por el usuario antes de recibir el resultado.'}</pre>`;
      body.appendChild(wrap);
    }
  }
  // el grupo tampoco puede seguir diciendo «en curso…» para siempre
  if (pendingTurn.group) pendingTurn.group.meta.textContent = failed ? 'interrumpido' : 'detenido';
}

function finishAssistant(finalText, opts) {
  cancelStreamRender();   // un frame pendiente repintaría el stream ya cerrado
  if (!pendingAssistant) return;
  const o = opts || {};
  const holder = pendingAssistant;
  /* Con la respuesta ya entregada, el razonamiento y las herramientas se pliegan (si el
     usuario no los abrió): la transcripción queda pregunta → detalles plegados → respuesta,
     que es lo que se quiere releer. Un turno interrumpido se deja tal cual: ahí los detalles
     SON el interés. */
  if (finalText) {
    // y su texto se asegura en pantalla: si el último frame no llegó a dispararse (ventana
    // oculta), el bloque se quedaba vacío hasta el siguiente repintado
    pintarRazonamiento(pendingTurn && pendingTurn.think);
    cerrarRazonamiento();
    cerrarHerramientas();
  }
  const stream = holder._openEl && holder._openEl.isConnected ? holder._openEl : holder.querySelector('.stream');
  // texto ya streameado: al Detener (o si la ejecución falla) NO se tira, se conserva
  const acc = holder._stream || '';
  // Narración visible del turno: tramos congelados entre herramientas + tramo abierto.
  // Antes aquí solo sobrevivía el párrafo final y la respuesta larga "se volvía corta".
  const shown = ((holder._frozenText || '') + '\n\n' + (holder._openText || '')).trim();
  const fin = String(finalText || '').trim();
  const runMode0 = (pendingTurn && pendingTurn.mode) || mode;
  const planConTarjeta = runMode0 === 'plan' && !!((pendingTurn && pendingTurn.plan));
  // lo que se ofrece para copiar/leer: la historia completa, no solo el cierre
  const narrativa = planConTarjeta ? finalText
    : ((shown && fin && !shown.endsWith(fin)) ? shown + '\n\n' + finalText : (shown || finalText));
  if (planConTarjeta) {
    if (stream) stream.remove();
  } else if (stream) {
    // el tramo abierto se queda donde nació (intercalado con las herramientas);
    // solo se retira si llegó vacío (congelado antes del primer frame)
    if (holder._openText) {
      stream.className = 'stream-done';
      /* …y se asegura en pantalla: con la ventana oculta Chromium no dispara
         requestAnimationFrame y el tramo abierto llegaría vacío (los congelados
         sí están, que se pintan en el evento). Sin esto, en oculto la respuesta
         quedaba sin su último tramo. */
      if (!(stream.textContent || '').trim()) stream.innerHTML = fmt(holder._openText);
    }
    else stream.remove();
  } else if (!planConTarjeta && holder._openText) {
    // Sin elemento porque ningún frame llegó a crearlo (ventana oculta): el
    // tramo abierto se pinta entero de una vez, en su sitio (al final).
    const s = document.createElement('div');
    s.className = 'stream-done';
    s.innerHTML = fmt(holder._openText);
    holder.appendChild(s);
  }
  holder._openEl = null;
  const keptText = finalText ? '' : (o.interrupted ? (planConTarjeta ? acc : shown) : '');
  if (finalText && planConTarjeta) {
  if (finalText) {
    const runMode = (pendingTurn && pendingTurn.mode) || mode;
    const parsed = K.parsePlan(finalText);
    if (runMode === 'plan' && parsed.steps.length) {
      const current = pendingTurn && pendingTurn.plan;
      if (!current) {
        // la respuesta trae el plan entero: se pinta ahora
        pendingTurn.plan = renderPlanCard(holder, parsed.steps);
        pendingTurn.plan.next();
      } else if (parsed.steps.length > current.total) {
        // el plan creció tras el último delta: se repinta completo, en su sitio,
        // conservando los pasos ya cumplidos (prev = tarjeta anterior)
        pendingTurn.plan = renderPlanCard(holder, parsed.steps, current.el, current);
        pendingTurn.plan.next();
        current.el.remove();
      }
    }
    // El texto se recorta solo cuando el plan se pinta como tarjeta (modo PLAN): en
    // ACT/THINK el prompt también pide planes, y ahí desaparecían de la respuesta.
    const text = (runMode === 'plan' && parsed.steps.length) ? (parsed.body || '') : finalText;
    if (text) {
      const div = document.createElement('div');
      div.innerHTML = fmt(text);
      holder.appendChild(div);
    }
  }
  } else if (finalText) {
    // La narración ya está en su sitio (tramos congelados + tramo abierto): solo
    // se añade el cierre si aporta algo nuevo. Antes se borraba todo y se
    // pintaba solo este párrafo, y la respuesta larga "se volvía corta".
    if (fin && !(shown && shown.endsWith(fin))) {
      const div = document.createElement('div');
      div.innerHTML = fmt(finalText);
      holder.appendChild(div);
    }
  } else if (keptText) {
    // turno cortado a medias con texto acumulado: se repinta igual que el stream
    // pero SIN la clase .stream (su caret parpadeante diría «sigue escribiendo»)
    const div = document.createElement('div');
    div.className = 'interrupted';
    div.innerHTML = fmt(keptText);
    holder.appendChild(div);
    const tag = document.createElement('div');
    tag.className = 'subnote';
    tag.textContent = o.failed ? 'Respuesta interrumpida por un error' : 'Respuesta interrumpida';
    holder.appendChild(tag);
  }
  // turno completado: el plan queda cerrado. Si se detuvo a medias (sin
  // respuesta final) los pasos restantes se dejan como estaban — marcarlos
  // como cumplidos sería mentir sobre lo que realmente se hizo.
  if (!finalText) closePendingCards(!!o.failed);
  if (finalText && pendingTurn && pendingTurn.plan) {
    const p = pendingTurn.plan;
    while (p.done < p.total) p.advance();
  }
  if (finalText && pendingTurn && pendingTurn.tools) {
    lastTurnSummary = K.toolCount(pendingTurn.tools) + (pendingTurn.totalMs ? ' · ' + K.fmtDuration(pendingTurn.totalMs) : '');
  } else if (finalText && pendingTurn && pendingTurn.plan) {
    lastTurnSummary = pendingTurn.plan.total + ' pasos completados';
  } else if (!finalText) {
    lastTurnSummary = o.failed ? 'error en la ejecución' : 'detenido por el usuario';
  } else {
    lastTurnSummary = 'respuesta entregada';
  }
  // el pie ofrece copiar/leer también lo que quedó a medias
  const said = narrativa || keptText;
  if (said) msgActions(holder.closest('.msg-body') || holder, said, { speak: true });
  lastAssistantEl = holder;
  refreshMsgActions();
  pendingAssistant = null; pendingTurn = null;
  scroll(true);
}

