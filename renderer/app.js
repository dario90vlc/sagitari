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
  // donde aporta (chat y agentes), no en las otras siete, donde está vacío
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
function dayStamp() {
  const d = document.createElement('div');
  d.className = 'day';
  d.textContent = 'Hoy · ' + nowClock();
  msgs.appendChild(d);
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
    copyText(bub.innerText, 'Mensaje copiado');
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
    };
  }
  return pendingAssistant;
}

/** Grupo contenedor de las herramientas del turno (cabecera resumen + cuerpo). */
function ensureToolGroup() {
  const b = ensureAssistantBubble();
  if (!pendingTurn.group) {
    const g = document.createElement('div');
    g.className = 'tgroup open';
    const head = document.createElement('div');
    head.className = 'tgroup-head';
    // plegable operable por teclado: role button + aria-expanded sincronizado
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'true');
    head.innerHTML = `<span class="tg-ic">${ic('tools')}</span><b class="tg-title">Herramientas</b>`
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
    b.appendChild(g);
    pendingTurn.group = { el: g, body, title: head.querySelector('.tg-title'), meta: head.querySelector('.tg-meta') };
  }
  return pendingTurn.group;
}

function refreshToolGroup() {
  if (!pendingTurn || !pendingTurn.group) return;
  const g = pendingTurn.group;
  g.title.textContent = K.toolCount(pendingTurn.tools);
  g.meta.textContent = pendingTurn.totalMs ? K.fmtDuration(pendingTurn.totalMs) : 'en curso…';
}

/** Abre la tarjeta de una herramienta que empieza a ejecutarse. */
function toolCard(ev) {
  ensureAssistantBubble();
  const meta = K.tool(ev.name);
  const group = ensureToolGroup();
  const card = document.createElement('div');
  card.className = 'tcard run';
  card.dataset.tool = ev.name;
  card._t0 = Date.now();
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
  group.body.appendChild(card);
  pendingTurn.cards.push(card);
  pendingTurn.tools++;
  refreshToolGroup();
  scroll();
  return card;
}

/** Cierra la tarjeta con su resultado, su duración y si falló. */
function completeToolCard(ev) {
  if (!pendingTurn) return;
  let card = null;
  for (let i = pendingTurn.cards.length - 1; i >= 0; i--) {
    const c = pendingTurn.cards[i];
    if (c.dataset.tool === ev.name && c.classList.contains('run')) { card = c; break; }
  }
  const ok = ev.ok !== undefined ? !!ev.ok : !K.looksFailed(ev.result);
  const ms = Number(ev.durationMs) || 0;
  if (!card) { toolCard({ name: ev.name, args: {} }); card = pendingTurn.cards[pendingTurn.cards.length - 1]; }
  card.classList.remove('run');
  card.classList.add(ok ? 'done' : 'err');
  const took = ms || (Date.now() - (card._t0 || Date.now()));
  card.querySelector('.tcard-ic').innerHTML = ic(ok ? 'check' : 'alert');
  card.querySelector('.tcard-time').textContent = K.fmtDuration(took);
  const body = card.querySelector('.tcard-body');
  const old = body.querySelector('[data-result]');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.dataset.result = '1';
  wrap.innerHTML = `<div class="tb-label">RESULTADO<button class="tcard-copy" title="Copiar resultado">${ic('copy')}</button></div>`
    + `<pre>${esc(K.clip(String(ev.result || ''), 1200)) || '(sin salida)'}</pre>`;
  wrap.querySelector('.tcard-copy').onclick = (e) => { e.stopPropagation(); copyText(ev.result, 'Resultado copiado'); };
  body.appendChild(wrap);
  pendingTurn.totalMs += took;
  refreshToolGroup();
  // en modo PLAN, cada herramienta completada marca un paso del plan
  advancePlan();
  scroll();
}

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

/** Cierra las tarjetas que quedaron «en curso…» cuando el turno muere a medias. */
function closePendingCards(failed) {
  if (!pendingTurn) return;
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
  const stream = holder.querySelector('.stream');
  // texto ya streameado: al Detener (o si la ejecución falla) NO se tira, se conserva
  const acc = holder._stream || '';
  if (stream) stream.remove();
  const keptText = finalText ? '' : (o.interrupted ? acc : '');
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
  const said = finalText || keptText;
  if (said) msgActions(holder.closest('.msg-body') || holder, said, { speak: true });
  lastAssistantEl = holder;
  refreshMsgActions();
  pendingAssistant = null; pendingTurn = null;
  scroll(true);
}

// ============ activity feed + live agents ============
const FEED_MAX = 6;
function feed(text, color) {
  const f = $('#activityFeed');
  const it = document.createElement('div');
  it.className = 'fitem';
  it.innerHTML = `<span class="dot ${color || 'pur'}"></span><span class="ft-txt">${esc(text)}</span><span class="ft">${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
  f.prepend(it);
  while (f.children.length > FEED_MAX) f.lastChild.remove();
}

const AGENT_MAP = {
  run_command: { el: 'agentCard-ops', name: 'Operador', icon: 'terminal', cls: 'a-p2', desc: 'Ejecutando comandos' },
  read_file: { el: 'agentCard-file', name: 'Archivador', icon: 'folder', cls: 'a-y', desc: 'Leyendo archivos' },
  write_file: { el: 'agentCard-file', name: 'Archivador', icon: 'folder', cls: 'a-y', desc: 'Escribiendo archivos' },
  list_dir: { el: 'agentCard-file', name: 'Archivador', icon: 'folder', cls: 'a-y', desc: 'Explorando carpetas' },
  search_files: { el: 'agentCard-researcher', name: 'Investigador', icon: 'search', cls: 'a-b', desc: 'Buscando información' },
  open_app: { el: 'agentCard-ops', name: 'Operador', icon: 'terminal', cls: 'a-p2', desc: 'Abriendo aplicaciones' },
  open_url: { el: 'agentCard-navigator', name: 'Navegador', icon: 'compass', cls: 'a-c', desc: 'Abriendo enlaces' },
  browser_control: { el: 'agentCard-navigator', name: 'Navegador', icon: 'compass', cls: 'a-c', desc: 'Controlando el navegador' },
  screenshot: { el: 'agentCard-analyst', name: 'Analista', icon: 'camera', cls: 'a-b2', desc: 'Analizando la pantalla' },
  clipboard: { el: 'agentCard-ops', name: 'Operador', icon: 'clipboard', cls: 'a-p2', desc: 'Gestionando portapapeles' },
  notify: { el: 'agentCard-ops', name: 'Operador', icon: 'bell', cls: 'a-p2', desc: 'Enviando notificación' },
  media_control: { el: 'agentCard-ops', name: 'Operador', icon: 'music', cls: 'a-p2', desc: 'Control multimedia' },
  window_manage: { el: 'agentCard-ops', name: 'Operador', icon: 'window', cls: 'a-p2', desc: 'Gestionando ventanas' },
  system_info: { el: 'agentCard-analyst', name: 'Analista', icon: 'monitor', cls: 'a-b2', desc: 'Leyendo el sistema' }
};

function agentStart(toolName) {
  const a = AGENT_MAP[toolName] || { el: 'agentCard-ops', name: 'Operador', icon: 'terminal', cls: 'a-p2', desc: 'Trabajando' };
  const card = document.getElementById(a.el);
  if (card) card.classList.add('on');
  const rail = $('#railAgents');
  if (rail && !rail.querySelector(`[data-agent="${a.name}"]`)) {
    const d = document.createElement('div');
    d.className = 'ragent';
    d.dataset.agent = a.name;
    d.innerHTML = `<div class="aic ${a.cls || 'a-p2'}">${ic(a.icon)}</div><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div><span class="adot"></span>`;
    rail.prepend(d);
    while (rail.children.length > 4) rail.lastChild.remove();
  }
  updateAgentCount();
}

// map a status text like "Terminal — npm install" back to a tool name
function agentStartForStatus(statusText) {
  const t = String(statusText || '');
  const found = Object.keys(AGENT_MAP).find(n => t.toLowerCase().startsWith(n) || t.includes(AGENT_MAP[n].name));
  if (found) return agentStart(found);
  const prefix = t.split(/ [—·-]/)[0].toLowerCase();
  const hint = { terminal: 'run_command', leyendo: 'read_file', escribiendo: 'write_file', explorando: 'list_dir', buscando: 'search_files', navegador: 'browser_control', capturando: 'screenshot', portapapeles: 'clipboard', multimedia: 'media_control', ventanas: 'window_manage' }[prefix];
  agentStart(hint || 'run_command');
}
function agentStop() {
  document.querySelectorAll('.acard.on').forEach(c => c.classList.remove('on'));
  updateAgentCount();
}
/** id de tarjeta → agente: permite limpiar el rail cuando una tarjeta se apaga. */
const CARD_AGENT = Object.values(AGENT_MAP).reduce((acc, a) => { if (!acc[a.el]) acc[a.el] = a; return acc; }, {});

function updateAgentCount() {
  const cards = [...document.querySelectorAll('.acard.on')];
  const n = cards.length;
  $('#agentCount').textContent = n;
  $('#bigRing').parentElement.parentElement.classList.toggle('idle', n === 0);
  // Sin nada en marcha, el «0» a 24px y el anillo vacío son decoración ocupando el
  // sitio de la información: se dice en una línea y desaparece el resto.
  const caja = $('#agentCount') && $('#agentCount').closest('.rc-count');
  if (caja) caja.hidden = n === 0;
  if ($('#bigRing')) $('#bigRing').hidden = n === 0;
  const titulo = document.querySelector('.rc-title');
  if (titulo) titulo.textContent = n === 0 ? 'Sin agentes en marcha' : 'Agentes activos';
  // el rail lista SOLO agentes vivos: antes acumulaba entradas de herramientas ya
  // terminadas mientras el contador marcaba 0 (lista y número se contradecían)
  const rail = $('#railAgents');
  if (!rail) return;
  const live = new Set(cards.map(c => CARD_AGENT[c.id] && CARD_AGENT[c.id].name).filter(Boolean));
  rail.querySelectorAll('.ragent').forEach(d => { if (!live.has(d.dataset.agent)) d.remove(); });
}
updateAgentCount();

/** Paneles de la vista Agentes: se pintan al entrar y se refrescan durante el turno. */
function refreshAgentsPanels() {
  const v = $('#view-agents');
  if (!v || !v.classList.contains('on') || document.hidden) return;
  renderToolTray(); renderHealth(); renderHabits();
}

/** «Actividad de herramientas» = lo realmente usado en la sesión, no el catálogo. */
async function renderToolTray() {
  const tray = $('#toolTrayList');
  if (!tray) return;
  let fired = [];
  try { fired = ((await window.sagitari.getAgentsLive()) || {}).toolsFired || []; }
  catch (e) { tray.innerHTML = `<div class="subnote">No se pudo leer la actividad: ${esc((e && e.message) || e)}</div>`; return; }
  if (!fired.length) { tray.innerHTML = '<div class="subnote">Todavía no se ha usado ninguna herramienta en esta sesión.</div>'; return; }
  tray.innerHTML = fired.map(t => {
    const label = t.name + ' ×' + t.count;
    return `<span class="toolchip" title="${esc(label)}"><span class="tc-mark">${ic(K.tool(t.name).icon)}</span><span class="tc-txt" title="${esc(label)}">${esc(label)}</span></span>`;
  }).join('');
}

// ============ v1.6: Model Health panel ============
async function renderHealth() {
  const box = $('#healthList');
  if (!box) return;
  let rows = [], err = null;
  try { rows = (await window.sagitari.healthGet()) || []; } catch (e) { err = e; }
  if (err) { box.innerHTML = `<div class="subnote">No se pudo leer la salud del modelo: ${esc((err && err.message) || err)}</div>`; return; }
  if (!rows.length) { box.innerHTML = '<div class="subnote">Sin datos todavía. Cada llamada al modelo registrará latencia, errores y tokens aquí.</div>'; return; }
  box.innerHTML = rows.map(r => {
    const health = r.errorRate >= 0.3 ? 'mag' : r.errorRate > 0 ? 'a-y' : 'ok';
    const plain = `${r.model} · ${r.calls} llamadas · ${r.avgLatencyMs || '—'} ms · ${(r.tokensIn + r.tokensOut).toLocaleString('es')} tok`
      + `${r.errors ? ' · ' + r.errors + ' errores' : ''}${r.fallbacks ? ' · ' + r.fallbacks + (r.fallbacks === 1 ? ' relevo' : ' relevos') : ''}`;
    return `<div class="toolchip" title="${esc(r.lastError || '')}">
      <span class="dot ${health}"></span>
      <span class="tc-txt" title="${esc(plain)}"><b>${esc(r.model)}</b> · ${r.calls} llamadas · ${r.avgLatencyMs || '—'} ms · ${(r.tokensIn + r.tokensOut).toLocaleString('es')} tok${r.errors ? ' · ' + r.errors + ' errores' : ''}${r.fallbacks ? ' · ' + r.fallbacks + (r.fallbacks === 1 ? ' relevo' : ' relevos') : ''}</span>
    </div>`;
  }).join('');
}

// ============ v2.0: hábitos observados ============
async function renderHabits() {
  const box = $('#habitsList');
  if (!box) return;
  let s = {};
  try { s = await window.sagitari.habitsGet(); } catch {}
  const parts = [];
  const fmtList = (arr, icon) => (arr || []).length
    ? `<div class="toolchip" title="${esc(arr.map(x => x.name + ' ×' + x.count).join(' · '))}"><span class="tc-mark">${ic(icon)}</span><span class="tc-txt" title="${esc(arr.map(x => x.name + ' ×' + x.count).join(' · '))}">${arr.map(x => `${esc(x.name)} ×${x.count}`).join(' · ')}</span></div>`
    : '';
  parts.push(fmtList(s.apps, 'zap'));
  parts.push(fmtList(s.commands, 'terminal'));
  parts.push(fmtList(s.sites, 'globe'));
  const c = s.confirms || {};
  if (c.approved || c.denied) parts.push(`<div class="toolchip"><span class="tc-mark">${ic('check')}</span><span class="tc-txt" title="Confirmaciones aceptadas y denegadas">confirmaciones: ${c.approved || 0} aceptadas · ${c.denied || 0} denegadas</span></div>`);
  box.innerHTML = parts.filter(Boolean).join('') || '<div class="subnote">Aún no hay hábitos observados. Se aprenden solo de lo que SAGITARI hace por ti.</div>';
}

/** Resumen legible de una importación: instaladas y omitidas (con el motivo). */
function importSummary(inst) {
  const list = Array.isArray(inst) ? inst : [];
  const ok = list.filter(s => !s.skipped).map(s => s.name);
  const omitidas = list.filter(s => s.skipped);
  let txt = ok.length ? 'Instaladas: ' + ok.join(', ') : 'No se instaló ninguna skill';
  if (omitidas.length) {
    txt += ' · Omitidas: ' + omitidas.map(s => s.name + (s.reason ? ' (' + s.reason + ')' : '')).join(', ');
  }
  return txt;
}

// v1.7: marketplace de skills
async function renderMarket() {
  const box = $('#marketList');
  if (!box) return;
  let items = [];
  try { items = await window.sagitari.marketCatalog(); } catch {}
  box.innerHTML = items.map(f => `
    <div class="memitem">
      <span class="tc-mark">${ic('zap')}</span>
      <span class="mt"><b>${esc(f.repo)}</b> <span class="md">· ${esc(f.category)}</span><br><small class="md">${esc(f.description)}</small></span>
      ${f.installed ? '<span class="md" style="color:var(--ok)">✓ instalado</span>' : `<button class="btn primary sq" data-install="${esc(f.repo)}" title="Instalar">${ic('download')}</button>`}
    </div>`).join('') || '<div class="subnote">Catálogo no disponible sin conexión.</div>';
  box.querySelectorAll('[data-install]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      $('#marketMsg').textContent = 'Instalando ' + b.dataset.install + '…';
      try {
        const inst = await window.sagitari.skillsImport(b.dataset.install);
        $('#marketMsg').textContent = importSummary(inst);
        renderSkills();
      } catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
      renderMarket();
    };
  });
}
$('#marketSearchBtn').onclick = async () => {
  const btn = $('#marketSearchBtn');
  if (btn.disabled) return;
  const q = $('#marketQuery').value.trim();
  if (!q) return;
  const box = $('#marketList');
  $('#marketMsg').textContent = 'Buscando en GitHub…';
  btn.disabled = true;
  try {
    const res = await window.sagitari.marketSearch(q);
    box.innerHTML = res.map(r => `
      <div class="memitem">
        <span class="tc-mark">${ic('search')}</span>
        <span class="mt"><b>${esc(r.repo)}</b> <span class="md">★ ${r.stars}</span><br><small class="md">${esc(r.description)}</small></span>
        <button class="btn primary sq" data-install="${esc(r.repo)}" title="Instalar">${ic('download')}</button>
      </div>`).join('') || '<div class="subnote">Sin resultados.</div>';
    box.querySelectorAll('[data-install]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try { await window.sagitari.skillsImport(b.dataset.install); $('#marketMsg').textContent = 'Instalado: ' + b.dataset.install; renderSkills(); }
        catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
      };
    });
    $('#marketMsg').textContent = '';
  } catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
  finally { btn.disabled = false; }
};
$('#skillsUpdateAllBtn').onclick = async () => {
  const btn = $('#skillsUpdateAllBtn');
  if (btn.disabled) return;
  $('#marketMsg').textContent = 'Actualizando skills…';
  btn.disabled = true;
  try {
    const res = await window.sagitari.skillsUpdateAll();
    const changed = res.filter(r => r.changed).length;
    $('#marketMsg').textContent = `${res.length} skills con origen · ${changed} actualizadas`;
    renderSkills();
  } catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
  finally { btn.disabled = false; }
};

// ============ agent events ============
/* --- stream por frame ---
   Cada delta llega con un puñado de tokens; antes se rehacía el bloque entero
   (marked + recorridos del DOM) por CADA uno. Ahora los deltas sólo acumulan
   texto y el DOM se rehace como máximo una vez por frame, con lo que el texto
   sigue viéndose en vivo sin coste cuadrático. */
let streamRaf = 0;
let streamTarget = null;
function cancelStreamRender() {
  if (streamRaf) { cancelAnimationFrame(streamRaf); streamRaf = 0; }
  streamTarget = null;
}
function scheduleStreamRender(holder) {
  streamTarget = holder;
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0;
    const h = streamTarget;
    streamTarget = null;
    if (!h || !h.isConnected) return;
    const old = h.querySelector('.stream');
    if (old) old.remove();
    const s = document.createElement('div');
    s.className = 'stream';
    s.innerHTML = fmt(h._stream);
    h.appendChild(s);
    scroll();
  });
}

window.sagitari.onAgentEvent((ev) => {
  // v1.3: los eventos de una tarea en segundo plano NO deben tocar el chat
  // interactivo (ni sus burbujas ni el estado busy/detener): solo el feed,
  // el panel de Tareas, las confirmaciones y los avisos.
  if (ev.bg) {
    switch (ev.type) {
      case 'status': feed(ev.text, 'pur'); break;
      case 'tool': feed(ev.name || 'herramienta', 'pur'); break;
      case 'tool_result': feed((ev.name || '') + ' — ' + String(ev.result || 'ok').slice(0, 90), (String(ev.result || '').startsWith('Error') ? 'err' : 'ok')); break;
      case 'task_done':
        feed('Tarea en segundo plano completada', 'ok');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        refreshAgentsPanels();
        break;
      case 'task_interrupted':
        feed('Tarea en segundo plano interrumpida — recuperable', 'err');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        break;
      case 'task_update':
        feed(ev.note || ('Tarea: ' + ev.status), 'blu');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        break;
      case 'guardrail':
        feed('Límite de seguridad (segundo plano): ' + String(ev.reason || '').slice(0, 90), 'err');
        showToast(String(ev.reason || 'Límite de seguridad en una tarea'));
        break;
      case 'error':
        feed('Error en una tarea en segundo plano', 'err');
        showToast(ev.message || 'Error en una tarea en segundo plano');
        break;
      case 'confirm_request': showConfirm(ev); break;
      case 'toast': showToast(ev.title + ': ' + ev.message); break;
      default: break;   // delta/assistant_done/busy/stopped/image se ignoran
    }
    return;
  }
  switch (ev.type) {
    case 'delta': {
      const b = ensureAssistantBubble();
      b._stream = (b._stream || '') + ev.text;
      // modo PLAN: en cuanto el plan queda cerrado en el texto se pinta como
      // checklist y desaparece del stream (así se ve avanzar mientras trabaja)
      if (pendingTurn && pendingTurn.mode === 'plan' && !pendingTurn.plan) {
        const p = K.parsePlan(b._stream);
        const cerrado = p.body.trim().length > 0 || /\n[ \t]*\n[ \t]*$/.test(b._stream);
        if (p.steps.length >= 2 && cerrado) {
          pendingTurn.plan = renderPlanCard(b, p.steps);
          pendingTurn.plan.next();
          b._stream = p.body;
        }
      }
      scheduleStreamRender(b);
      break;
    }
    // cada llamada a herramienta abre su propia tarjeta con argumentos y estado
    case 'tool':
      toolCard(ev);
      setChatStatus(K.tool(ev.name).verb + (ev.subagent && K.subagent(ev.subagent) ? ' — ' + K.subagent(ev.subagent).label : '') + '…');
      feed(K.tool(ev.name).label + (ev.subagent ? ' · ' + K.subagent(ev.subagent).label : ''), 'pur');
      agentStart(ev.name);
      break;
    case 'status':
      setChatStatus(ev.text);
      feed(ev.text, 'pur');
      agentStartForStatus(ev.text);
      break;
    case 'tool_result':
      completeToolCard(ev);
      agentStop();
      feed(K.tool(ev.name).label + (ev.ok === false ? ' — falló' : ' — completado'), ev.ok === false ? 'err' : 'ok');
      setChatStatus('Herramienta completada, continuando…');
      refreshAgentsPanels();
      break;
    case 'image': {
      const b = ensureAssistantBubble();
      const img = document.createElement('img');
      img.src = ev.dataUrl; img.className = 'shot';
      pinImage(img);
      b.appendChild(img);
      scroll();
      break;
    }
    case 'assistant_done':
      finishAssistant(ev.text);
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      speak(ev.text);
      setChatStatus('Listo · ' + lastTurnLabel(), 'done');
      feed('Respuesta lista', 'cy');
      if (devMode) paintMeta();
      break;
    case 'guardrail':
      toolChip('Límite de seguridad — ' + ev.reason.slice(0, 100), 'err');
      feed('Límite de seguridad', 'err');
      showToast(ev.reason);
      break;
    case 'paused':
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      agentStop();
      feed('Tarea pausada — punto de control guardado', 'blu');
      showToast('Tarea pausada. Reanúdala desde el panel Tareas.');
      break;
    case 'task_done':
      feed('Tarea completada y verificada', 'ok');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
      refreshAgentsPanels();
      break;
    case 'task_interrupted':
      feed('Tarea interrumpida — recuperable en Tareas', 'err');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
      refreshAgentsPanels();
      break;
    case 'task_update':
      feed(ev.note || ('Tarea: ' + ev.status), 'blu');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
      break;
    case 'confirm_request':
      showConfirm(ev);
      break;
    case 'busy':
      busy = ev.busy;
      setSendMode();
      syncChatBadge();
      if (busy) {
        currentRunMode = K.mode(ev.mode || mode).key;
        applyModeTheme(currentRunMode);
        setChatStatus(K.mode(currentRunMode).tagline);
        feed('Sagitari está trabajando · ' + K.mode(currentRunMode).label, 'blu');
        if (devMode) paintMeta();   // métricas del turno que arranca, no las del anterior
      } else {
        // terminó la ejecución: el color vuelve al modo que tengas elegido
        applyModeTheme(mode);
        agentStop();                // sin ejecución no queda ningún agente vivo
        // Un corte por guardarraíl sale del bucle SIN respuesta final, así que el
        // turno quedaba abierto: la respuesta siguiente se escribía DENTRO de la
        // burbuja anterior (encima de la pregunta recién enviada) y el turno se
        // quedaba sin pie de acciones. Aquí ya no hay ejecución: se cierra.
        if (pendingAssistant) finishAssistant('', { interrupted: true, failed: true });
        if (devMode) paintMeta();
        refreshAgentsPanels();
        if (!currentConfirm || !currentConfirm.runId) hideConfirm();
      }
      break;
    case 'stopped':
      finishAssistant('', { interrupted: true });
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      agentStop();
      setChatStatus('Detenido por el usuario');
      feed('Detenido por el usuario', 'err');
      if (devMode) paintMeta();
      break;
    case 'toast':
      showToast(ev.title + ': ' + ev.message);
      break;
    case 'error': {
      // «SAGITARI está ocupado» lo emite una ejecución que sigue VIVA: es un envío
      // duplicado, así que no se cierra el turno ni se devuelve el botón a «Enviar».
      const ocupado = /ocupad/i.test(String(ev.message || ''));
      if (ocupado) {
        showToast(ev.message);
        feed('Envío ignorado: el agente sigue trabajando', 'err');
        break;
      }
      const hadTurn = !!pendingAssistant;
      finishAssistant('', { interrupted: true, failed: true });
      {
        // el error se pinta DENTRO del turno cortado si lo había: sin duplicar
        // burbujas ni dejar una respuesta huérfana sin su causa
        const target = (hadTurn && lastAssistantEl) ? lastAssistantEl : bubble('ai');
        const em = document.createElement('span');
        em.className = 'errmsg';
        // el fallo crudo del proveedor no dice nada al usuario: se traduce a una
        // causa legible y a un siguiente paso concreto
        const ex = K.explainError(ev.message);
        em.innerHTML = `${ic('alert')} <b>${esc(ex.texto)}</b>`;
        const pista = document.createElement('span');
        pista.className = 'errmsg-hint';
        pista.textContent = ex.pista;
        const reintentar = document.createElement('button');
        reintentar.className = 'btn';
        reintentar.textContent = 'Reintentar';
        reintentar.onclick = () => { window.sagitari.retryChat(); };
        em.appendChild(pista);
        em.appendChild(reintentar);
        target.appendChild(em);
      }
      // el estado del turno se queda pegado al último aviso («probando siguiente
      // (primary)…») aunque el botón ya haya vuelto a «Enviar»: se limpia, y la
      // píldora del sidebar se recalcula con el fallo recién registrado
      setChatStatus('');
      updateStatusLabels();
      refreshMsgActions();
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      agentStop();
      feed('Error en la tarea', 'err');
      if (devMode) paintMeta();
      break;
    }
  }
});

function glowOffSoon() { setTimeout(() => window.sagitari.glow('off'), 2600); }

// ============ v1.1: confirmación de acciones + métricas de ejecución ============
/* Cola FIFO de confirmaciones: con varias tareas en background (Ajustes permite
   hasta 4) el agente pide permiso más de una vez. Antes había una sola
   confirmación «en vuelo» y la segunda pisaba el contenido de la barra: la
   primera ya no se podía responder y su tarea esperaba al timeout. Ahora se
   muestra la primera de la cola y, al resolverla, la siguiente. */
const confirmQueue = [];
let currentConfirm = null;

function showConfirm(ev) {
  confirmQueue.push(ev);
  if (confirmQueue.length > 1) feed('Confirmación en cola (' + confirmQueue.length + ' pendientes): ' + ev.tool, 'blu');
  paintConfirm();
}

/** Pinta la confirmación que toca (la primera de la cola) o esconde la barra. */
function paintConfirm() {
  const bar = $('#confirmBar');
  const ev = confirmQueue[0];
  currentConfirm = ev || null;
  if (!ev) { if (bar) bar.hidden = true; return; }
  const who = ev.runId ? ' (tarea en segundo plano)' : '';
  // con varias esperando se dice cuál se está viendo: «1 de 3»
  const prog = confirmQueue.length > 1 ? ' · 1 de ' + confirmQueue.length : '';
  $('#confirmTitle').textContent = 'El agente quiere: ' + (ev.description || ev.tool) + who + prog;
  $('#confirmDetail').textContent = ev.summary ? String(ev.summary).slice(0, 240) : 'Herramienta: ' + ev.tool;
  bar.hidden = false;
  // al mostrarse es un diálogo modal de aviso: el lector de pantalla lo anuncia
  bar.setAttribute('role', 'alertdialog');
  bar.setAttribute('aria-live', 'assertive');
  // El foco NO entra en «Permitir»: un Enter al vuelo ejecutaba la acción en tu
  // PC. Se enfoca la barra (para que Escape funcione y el lector la anuncie) y
  // confirmar exige un clic o tabular hasta el botón: elegir una acción es un
  // acto deliberado, y el error por defecto es no ejecutar.
  if (bar.tabIndex < 0) bar.tabIndex = -1;
  bar.focus();
  feed('Esperando tu confirmación: ' + ev.tool, 'blu');
}

function hideConfirm() {
  // la que estaba a la vista ya no puede responderse (el turno acabó): se
  // descarta y, si quedaban más esperando, se muestra la siguiente
  if (currentConfirm && confirmQueue[0] === currentConfirm) confirmQueue.shift();
  currentConfirm = null;
  const bar = $('#confirmBar');
  if (bar) bar.hidden = true;
  if (confirmQueue.length) paintConfirm();
}
async function resolveConfirm(allow) {
  // se responde SIEMPRE a la primera de la cola, que es la que está a la vista
  const c = confirmQueue.shift() || currentConfirm;
  currentConfirm = null;
  const bar = $('#confirmBar');
  if (confirmQueue.length) paintConfirm();
  else if (bar) bar.hidden = true;
  if (c) await window.sagitari.secResolve(c.id, allow, c.runId);
}
$('#confirmOk').onclick = () => resolveConfirm(true);
$('#confirmNo').onclick = () => resolveConfirm(false);
// Escape deniega siempre; Enter sólo confirma con el foco dentro de la barra
// (si no, escribir en el chat dispararía la confirmación sin querer).
document.addEventListener('keydown', (e) => {
  const bar = $('#confirmBar');
  if (!bar || bar.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false); return; }
  if (e.key === 'Enter' && document.activeElement !== bar && bar.contains(document.activeElement)) { e.preventDefault(); resolveConfirm(true); }
});

/**
 * Confirmación inline para acciones destructivas: reutiliza el aspecto de
 * #confirmBar y se inserta junto al elemento afectado (o al inicio de la vista
 * activa si no se le pasa ancla). Devuelve true/false; Escape cancela.
 */
function askConfirm(anchor, message, detail) {
  return new Promise((resolve) => {
    const view = document.querySelector('.view.on');
    const bar = document.createElement('div');
    bar.className = 'confirmbar';
    bar.setAttribute('role', 'alertdialog');
    bar.setAttribute('aria-label', message);
    bar.innerHTML = `<span class="cb-dot"></span>
      <div class="cb-txt"><b></b><small></small></div>
      <div class="btnrow" style="margin:0">
        <button class="btn primary" data-ok>Confirmar</button>
        <button class="btn ghost" data-no>Cancelar</button>
      </div>`;
    bar.querySelector('b').textContent = message;
    bar.querySelector('small').textContent = detail || 'Esta acción no se puede deshacer.';
    let done = false;
    /* Las vistas se repintan con `innerHTML = ''` (renderTasks, renderHistory,
       renderMemory, renderSkills…), lo que arrancaba la barra del DOM sin pasar
       por finish(): la promesa quedaba pendiente para siempre (el botón que la
       espera, disabled) y el listener de teclado, vivo. El observador la cierra
       como cancelada en cuanto deja de estar conectada. */
    const mo = new MutationObserver(() => { if (!bar.isConnected) finish(false); });
    const finish = (v) => {
      if (done) return;                 // una barra se resuelve UNA vez
      done = true;
      mo.disconnect();
      document.removeEventListener('keydown', onKey, true);
      bar.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      // Enter sólo confirma con el foco en un BOTÓN de la barra (no en la barra,
      // que ahora es la que recibe el foco al abrirse): si el usuario se ha ido a
      // escribir, o acaba de aparecer la tarjeta, Enter no borra nada
      else if (e.key === 'Enter' && document.activeElement !== bar && bar.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    bar.querySelector('[data-ok]').onclick = () => finish(true);
    bar.querySelector('[data-no]').onclick = () => finish(false);
    document.addEventListener('keydown', onKey, true);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else if (view) view.insertBefore(bar, view.firstChild);
    else document.body.appendChild(bar);
    mo.observe(document.body, { childList: true, subtree: true });
    // el foco va a la barra, no al botón que ejecuta: nada se confirma sin querer
    if (bar.tabIndex < 0) bar.tabIndex = -1;
    bar.focus();
  });
}

let devMode = false;
async function paintMeta() {
  const line = $('#devMeta');
  if (!line) return;
  if (!devMode) { line.hidden = true; return; }
  try {
    const m = await window.sagitari.metaGet();
    const r = m.run || {};
    const gr = m.guardrails || {};
    line.hidden = false;
    line.textContent = (m.model || '—') + ' · turno: ' + (r.tokensIn || 0) + ' in / ' + (r.tokensOut || 0) + ' out tok · '
      + (r.llmCalls || 0) + ' llamadas · ' + (r.toolCalls || 0) + ' herramientas · ' + (r.lastLatencyMs || 0) + ' ms'
      + ' · límites: ' + (gr.maxSteps || '∞') + ' pasos / ' + (gr.maxDurationMs ? Math.round(gr.maxDurationMs / 60000) + ' min' : '∞')
      + ' / silencio ' + ((CFG.settings.llmTimeoutMs ?? 120000) ? Math.round((CFG.settings.llmTimeoutMs ?? 120000) / 1000) + ' s' : '∞');
  } catch { line.hidden = true; }
}
setInterval(paintMeta, 2000);
// v1.3: la vista Tareas se refresca sola SÓLO mientras está visible (estado en vivo);
// con la ventana oculta o en otra pestaña no hay nada que repintar
setInterval(() => {
  const v = $('#view-tasks');
  if (!v || !v.classList.contains('on') || document.hidden) return;
  // Con una confirmación inline abierta no se repinta: el repintado vacía la lista,
  // desconecta la barra del DOM y el observador la resolvía como cancelada — el
  // usuario veía desaparecer el diálogo sin que su clic hiciera nada.
  if (v.querySelector('.confirmbar')) return;
  renderTasks();
}, 5000);

function setSendMode() {
  const b = $('#chatSend');
  b.innerHTML = ic(busy ? 'stop' : 'send');
  b.classList.toggle('stop', busy);
  b.title = busy ? 'Detener' : 'Enviar';
  // el hilo se anuncia como ocupado mientras el agente trabaja: los lectores de
  // pantalla esperan a que termine en vez de leer cada delta
  const m = $('#messages');
  if (m) m.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ============ sending ============
async function sendFrom(elId) {
  const el = $(elId);
  // Mientras el agente trabaja, el botón es «Detener»: debe funcionar aunque el
  // campo esté vacío (lo habitual, porque el texto se limpió al enviarlo).
  // Por eso este caso va ANTES de la comprobación de texto vacío.
  if (busy) { window.sagitari.stopChat(); feed('Deteniendo…', 'err'); return; }
  const text = el.value.trim();
  const atts = pendingAttachments.slice();
  if (!text && !atts.length) return;
  el.value = ''; el.style.height = '';
  clearAttachments();
  // si el dictado estaba activo, detenerlo y limpiar su estado visual
  if (listening) {
    listening = false;
    voiceBuffer = ''; lastPartial = '';
    $$('.cbtn').forEach(b => b.classList.remove('on'));
    el.classList.remove('rec');
    window.sagitari.glow('off');
    await window.sagitari.voiceStop();
  }
  goto('chat');
  // el turno del usuario queda sellado con el modo con el que se envió: en el
  // historial se ve de un vistazo qué respondió cada modo
  currentRunMode = K.mode(mode).key;
  const b = bubble('user', { mode: currentRunMode });
  b.textContent = text;
  // los adjuntos se ven en la burbuja (miniaturas y nombres), no solo en el texto
  const visAtts = atts.filter(a => a.kind === 'image' ? a.dataUrl : true);
  if (visAtts.length) paintAttachments(b, visAtts);
  setChatTitle(text || (atts[0] && atts[0].name) || 'Nueva conversación');
  pinned = true;
  scroll(true);
  window.sagitari.glow('think');
  // optimista: el evento `busy` del agente tarda en llegar y hasta entonces un
  // segundo Enter lanzaba otro turno que moría con «SAGITARI está ocupado» y
  // devolvía el botón a «Enviar» con el agente aún trabajando.
  busy = true;
  setSendMode();
  syncChatBadge();
  try {
    const r = await window.sagitari.sendChat(text, null, atts);
    if (r && r.ok === false) throw new Error(r.error || 'no se pudo enviar');
  } catch (e) {
    busy = false;
    setSendMode();
    syncChatBadge();
    showToast('No se pudo enviar: ' + ((e && e.message) || e));
  }
}

// ============ adjuntos: archivos, documentos e imágenes ============
const MAX_ATTACHMENTS = 8;
let pendingAttachments = [];   // { name, kind: 'image'|'text'|'binary', size, dataUrl?, text?, note? }

function renderAttachStrip() {
  const strip = $('#attachStrip');
  if (!pendingAttachments.length) { strip.hidden = true; strip.innerHTML = ''; return; }
  strip.hidden = false;
  strip.innerHTML = '';
  for (const a of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'atchip' + (a.kind === 'image' ? ' img' : a.kind === 'binary' ? ' bin' : '');
    if (a.kind === 'image' && a.dataUrl) {
      const im = document.createElement('img'); im.src = a.dataUrl; im.alt = '';
      chip.appendChild(im);
    } else {
      const icn = document.createElement('span'); icn.className = 'ic'; icn.innerHTML = ic(a.kind === 'binary' ? 'file' : 'doc');
      chip.appendChild(icn);
    }
    const meta = document.createElement('span'); meta.className = 'nm';
    meta.textContent = a.name + (a.kind === 'binary' && a.note ? ' · ' + a.note : '');
    meta.title = a.name + ' · ' + (a.size ? Math.round(a.size / 1024) + ' KB' : '');
    chip.appendChild(meta);
    const x = document.createElement('button'); x.className = 'rm'; x.title = 'Quitar'; x.innerHTML = ic('x');
    x.onclick = () => { pendingAttachments = pendingAttachments.filter(p => p !== a); renderAttachStrip(); };
    chip.appendChild(x);
    strip.appendChild(chip);
  }
}
function clearAttachments() { pendingAttachments = []; renderAttachStrip(); }

/* Miniaturas de los adjuntos dentro de la burbuja del usuario (en vivo y al
   recargar el historial). Solo visual: el contenido real ya viajó al modelo. */
function paintAttachments(bubbleEl, atts) {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  for (const a of (atts || [])) {
    if (a.kind === 'image' && a.dataUrl) {
      const im = document.createElement('img');
      im.src = a.dataUrl; im.alt = a.name; im.className = 'msg-att-img';
      pinImage(im);   // la miniatura carga tarde: reajusta el final si seguías el hilo
      im.onclick = () => window.sagitari.openExternal && /^https?:/.test(a.dataUrl) && window.sagitari.openExternal(a.dataUrl);
      box.appendChild(im);
    } else {
      const chip = document.createElement('span');
      chip.className = 'msg-att-file' + (a.kind === 'binary' ? ' bin' : '');
      chip.innerHTML = ic(a.kind === 'binary' ? 'file' : 'doc') + `<b></b><small>${a.size ? Math.round(a.size / 1024) + ' KB' : ''}</small>`;
      chip.querySelector('b').textContent = a.name;
      box.appendChild(chip);
    }
  }
  bubbleEl.appendChild(box);
}

async function addAttachmentPath(p) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) { showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`); return; }
  const r = await window.sagitari.attachmentsRead(p);
  if (!r || !r.ok) { showToast('No se pudo leer: ' + ((r && r.error) || 'error desconocido')); return; }
  if (pendingAttachments.some(a => a.name === r.att.name && a.size === r.att.size)) return;   // ya está
  pendingAttachments.push(r.att);
  renderAttachStrip();
  goto('chat');
}

/* Ruta real de un File soltado: Electron ≥32 eliminó `File.path`, así que la
   pide al preload (webUtils.getPathForFile). Sin esto el arrastre siempre
   acababa en «No se pudo leer». */
function filePathOf(f) {
  if (!f) return '';
  try {
    if (f.path) return f.path;   // versiones antiguas / objetos ya resueltos
    return (window.sagitari.filePath && window.sagitari.filePath(f)) || '';
  } catch { return ''; }
}

async function addAttachmentFiles(files) {
  const list = [...(files || [])];
  const room = MAX_ATTACHMENTS - pendingAttachments.length;
  if (room <= 0) { showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`); return; }
  // recorta al hueco REAL: antes cortaba a 8 y los que sobraban se perdían sin aviso
  if (list.length > room) showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`);
  for (const f of list.slice(0, room)) {
    if (f && f.path) await addAttachmentPath(f.path);
    else if (f && f.type && f.type.startsWith('image/') && f.dataUrl) {
      // imagen pegada/drag&drop desde fuera del sistema de ficheros
      if (pendingAttachments.length < MAX_ATTACHMENTS && !pendingAttachments.some(a => a.dataUrl === f.dataUrl)) {
        pendingAttachments.push({ name: f.name || 'imagen pegada', kind: 'image', size: Math.round((f.dataUrl.length * 3) / 4), dataUrl: f.dataUrl });
        renderAttachStrip(); goto('chat');
      }
    }
  }
}

$('#chatAttach').onclick = async () => {
  try {
    const paths = await window.sagitari.attachmentsPick();
    for (const p of (paths || [])) await addAttachmentPath(p);
  } catch (e) { showToast('No se pudieron adjuntar archivos: ' + ((e && e.message) || e)); }
};

// drag & drop sobre toda la vista del chat
const chatView = $('#view-chat');
['dragover', 'dragenter'].forEach(t => chatView.addEventListener(t, (e) => { e.preventDefault(); chatView.classList.add('dragging'); }));
['dragleave', 'drop', 'dragend'].forEach(t => chatView.addEventListener(t, () => chatView.classList.remove('dragging')));
chatView.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer || {}).files || []];
  if (files.length) addAttachmentFiles(files.map(f => ({ path: filePathOf(f), name: f.name, type: f.type })));
  else {
    const txt = (e.dataTransfer || {}).getData('text/uri-list') || (e.dataTransfer || {}).getData('text/plain');
    if (txt && /^data:image\//.test(txt.trim())) addAttachmentFiles([{ dataUrl: txt.trim(), name: 'imagen pegada' }]);
  }
});

// pegar imágenes directamente en el compositor
$('#chatInput').addEventListener('paste', (e) => {
  const items = [...((e.clipboardData || {}).items || [])];
  const imgs = items.filter(it => it.type && it.type.startsWith('image/'));
  if (!imgs.length) return;
  // con el cupo lleno se avisa ANTES de bloquear el pegado: un slice(0,0) se lo
  // tragaba en silencio y el usuario creía que no había funcionado
  if (pendingAttachments.length >= MAX_ATTACHMENTS) { showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`); return; }
  e.preventDefault();
  for (const it of imgs.slice(0, MAX_ATTACHMENTS - pendingAttachments.length)) {
    const blob = it.getAsFile && it.getAsFile();
    if (!blob) continue;
    const fr = new FileReader();
    fr.onload = () => addAttachmentFiles([{ dataUrl: String(fr.result), name: 'imagen pegada' }]);
    fr.readAsDataURL(blob);
  }
});
$('#chatSend').onclick = () => sendFrom('#chatInput');
// Enter lo gestiona el listener de más abajo: si el menú de skills está abierto
// la tecla pertenece al menú y NO se envía nada al modelo (antes había dos
// listeners y éste enviaba el texto crudo aunque el menú estuviera visible).

// ============ paleta de skills con "/" ============
const skillMenu = $('#skillMenu');
let skillList = [];
let skillIdx = -1;
async function refreshSkillList() {
  try { skillList = (await window.sagitari.skillsList()).filter(s => s.enabled); } catch { skillList = []; }
}
function renderSkillMenu(query) {
  const q = (query || '').toLowerCase();
  const items = skillList.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
  if (!items.length) { skillMenu.hidden = true; return; }
  skillMenu.innerHTML = `<div class="sm-head">SKILLS — escribe para filtrar</div>` + items.map((s, i) =>
    `<div class="sm-item${i === skillIdx ? ' on' : ''}" data-i="${i}">
      <span class="tc-mark">${ic('zap')}</span><span class="sm-name">${esc(s.name)}</span><span class="sm-desc">${esc(s.description || '')}</span>
    </div>`).join('');
  skillMenu.hidden = false;
  skillMenu._items = items;
  const on = skillMenu.querySelector('.sm-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function openSkillMenu() {
  const v = $('#chatInput').value;
  // si el menú se cerró con este mismo valor, fue al elegir una skill: el foco
  // no debe reabrirlo (si no, Enter volvería a elegir en vez de enviar)
  if (v === skillMenu._for) return;
  const m = v.match(/^\/([\w-]*)\s*$/);
  if (m) { refreshSkillList().then(() => { skillIdx = skillList.length ? 0 : -1; renderSkillMenu(m[1]); }); }
  else closeSkillMenu();
}
function closeSkillMenu() { skillMenu.hidden = true; skillIdx = -1; skillMenu._for = $('#chatInput').value; }
function chooseSkill(name) {
  const rest = $('#chatInput').value.replace(/^\/[\w-]*\s*/, '');
  $('#chatInput').value = '/' + name + (rest ? ' ' + rest : ' ');
  closeSkillMenu();
  $('#chatInput').focus();
}
$('#chatInput').addEventListener('input', openSkillMenu);
$('#chatInput').addEventListener('focus', () => { if ($('#chatInput').value.startsWith('/')) openSkillMenu(); });
$('#chatInput').addEventListener('keydown', (e) => {
  if (!skillMenu.hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); skillIdx = (skillIdx + 1) % skillMenu._items.length; renderSkillMenu($('#chatInput').value.replace(/^\/[\w-]*/, '')); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); skillIdx = (skillIdx - 1 + skillMenu._items.length) % skillMenu._items.length; renderSkillMenu($('#chatInput').value.replace(/^\/[\w-]*/, '')); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const it = skillMenu._items[skillIdx]; if (it) chooseSkill(it.name); return; }
    if (e.key === 'Escape') { closeSkillMenu(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFrom('#chatInput'); }
});
skillMenu.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.sm-item');
  if (!el) return;
  e.preventDefault();
  const it = skillMenu._items[+el.dataset.i];
  if (it) chooseSkill(it.name);
});
document.addEventListener('click', (e) => { if (!skillMenu.contains(e.target) && e.target.id !== 'chatInput') closeSkillMenu(); });
// sugerencias del estado vacío del chat: rellenan el compositor, no envían
$$('.ce-hint').forEach(c => c.addEventListener('click', () => {
  if (c.dataset.goto) return goto(c.dataset.goto);
  const input = $('#chatInput');
  input.value = c.dataset.fill || '';
  autoGrow(input);
  input.focus();
}));

// ============ voice ============
// Auto-ajuste de altura de los composers (también al escribir a mano)
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
$('#chatInput').addEventListener('input', () => autoGrow($('#chatInput')));

// Dictado continuo y acumulativo: los finales se CONCATENAN en el input, no lo
// sobrescriben. El micrófono sigue activo hasta que lo apagas o envías — nunca
// se envía solo a mitad de frase.
let voiceBuffer = '';      // texto ya confirmado (de finales anteriores)
let lastPartial = '';      // hipótesis en curso (para reemplazar en el input)
function paintVoice(partial) {
  const el = $('#chatInput');
  const text = (voiceBuffer + (partial || '')).trimStart();
  if (el.value !== text) { el.value = text; }
  el.classList.toggle('rec', true);
  autoGrow(el);
}
function wireMic(btnId) {
  const btn = $(btnId);
  btn.addEventListener('click', async () => {
    if (listening) {
      listening = false; btn.classList.remove('on');
      window.sagitari.glow('off');
      await window.sagitari.voiceStop();
    } else {
      listening = true; btn.classList.add('on');
      voiceBuffer = ''; lastPartial = '';
      window.sagitari.glow('listen', 'voice');
      await window.sagitari.voiceStart();
    }
  });
}
wireMic('#chatMic');

window.sagitari.onVoiceReady((k, lang) => showToast('Dictado activo (' + lang + '). Habla ahora; pulsa el micro o envía para terminar.'));
// motor clásico = precisión inferior: avisar que con el reconocimiento online mejora mucho
window.sagitari.onVoiceMode((k, mode) => {
  if (mode === 'sapi') showToast('Motor de voz clásico activo. Activa "Reconocimiento de voz en línea" en Windows (Privacidad > Voz) para máxima precisión.');
});
window.sagitari.onVoiceHint((k, m) => showToast('Dictado: ' + m));
window.sagitari.onVoice((k, text) => { lastPartial = text ? text + ' ' : ''; paintVoice(lastPartial); });
window.sagitari.onVoiceFinal((k, text) => {
  if (text && text.trim()) voiceBuffer += text.trim() + ' ';
  lastPartial = '';
  paintVoice('');
});
window.sagitari.onVoiceError((k, m) => {
  showToast('Dictado: ' + m);
  listening = false;
  $$('.cbtn').forEach(b => b.classList.remove('on'));
  const rec = document.querySelector('.rec'); if (rec) rec.classList.remove('rec');
});

// ============ window buttons ============
$('#btnMin').onclick = () => window.sagitari.minimize();
$('#btnMax').onclick = () => window.sagitari.maximize();
// estado visual del botón (maximizar/restaurar) + clase .maximized en el shell
window.sagitari.onWinState((isMax) => {
  $('#btnMax').innerHTML = ic(isMax ? 'restore' : 'maximize');
  $('#btnMax').title = isMax ? 'Restaurar' : 'Maximizar';
  document.getElementById('shell').classList.toggle('maximized', !!isMax);
});
// doble clic en el titlebar = maximizar/restaurar
document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('.wb')) return;
  window.sagitari.maximize();
});
// sin foco en la ventana, el CSS apaga las animaciones del glow (menos CPU)
window.addEventListener('blur', () => document.body.classList.add('nofocus'));
window.addEventListener('focus', () => document.body.classList.remove('nofocus'));
$('#btnClose').onclick = () => window.sagitari.quit();

// ============ settings ============
async function fillSettings() {
  CFG = await window.sagitari.getConfig();
  const sel = $('#presetSel');
  if (!sel.options.length) {
    for (const p of CFG.presets) {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
    }
    sel.onchange = () => {
      const p = CFG.presets.find(x => x.id === sel.value);
      $('#pName').value = p.name.replace(' (local)', '').replace('Personalizado (OpenAI-compatible)', 'Mi API');
      $('#pUrl').value = p.baseUrl;
      $('#pKey').value = '';
      $('#modelSel').innerHTML = '<option value="">— detecta modelos primero —</option>';
      if ($('#apiFormat')) $('#apiFormat').value = p.format || 'auto';   // protocolo sugerido por el preset
      hintStoredKey();   // si esa misma URL ya tiene clave guardada, se dice en el campo
    };
    sel.dispatchEvent(new Event('change'));
  }
  renderProviderList();
  if ($('#apiFormat')) $('#apiFormat').value = (CFG.active && CFG.active.format) || 'auto';
  showSetTab(setTabName);       // restaura la pestaña de Ajustes que estaba abierta
  filterSettings('');           // limpia cualquier búsqueda previa
  initDataPanel();              // hábitos + carpeta de datos
  $('#swGlow').classList.toggle('on', !!CFG.settings.glowEnabled);
  $('#swTts').classList.toggle('on', !!CFG.settings.ttsEnabled);
  $('#voiceLang').value = CFG.settings.voiceLang || 'es-ES';
  $('#setUserName').value = CFG.settings.userName || '';
  // apariencia: color de interfaz, color del glow e intensidad
  $('#uiColor').value = PALETTES[CFG.settings.uiColor] ? CFG.settings.uiColor : 'violet';
  $('#glowColor').value = (!CFG.settings.glowColor || CFG.settings.glowColor === 'match') ? 'match'
    : (PALETTES[CFG.settings.glowColor] ? CFG.settings.glowColor : 'match');
  $('#glowStrength').value = String(Math.min(1.4, Math.max(0.4, Number(CFG.settings.glowStrength) || 1)));
  refreshGlowLabels();
  refreshColorDots();
  window.sagitari.workspaceGet().then(w => { $('#wsPath').value = w; });
  mode = CFG.settings.mode || 'act';
  updateModeUI();
  updateStatusLabels();
}

$('#btnDetect').onclick = async () => {
  const url = $('#pUrl').value.trim();
  if (!url) return smsg('Escribe una Base URL.');
  smsg('Detectando modelos…');
  const r = await window.sagitari.listModels(url, $('#pKey').value.trim());
  if (!r.ok) return smsg('Error: ' + r.error);
  const sel = $('#modelSel');
  sel.innerHTML = '';
  for (const m of r.models) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
  smsg(r.models.length + ' modelos detectados.');
};
// 'auto' = que el agente deduzca el protocolo; si no, se fuerza el elegido
const apiFormatValue = () => ($('#apiFormat') ? $('#apiFormat').value : 'auto') || 'auto';   // 'auto' = detectar

$('#btnSaveProv').onclick = async () => {
  const btn = $('#btnSaveProv');
  if (btn.disabled) return;
  if (!$('#pUrl').value.trim()) return smsg('Falta la Base URL.');
  btn.disabled = true;
  try {
    const r = await window.sagitari.saveProvider({ id: 'prov_' + Date.now().toString(36), name: $('#pName').value.trim() || 'Proveedor', baseUrl: $('#pUrl').value.trim(), apiKey: $('#pKey').value.trim(), format: apiFormatValue(), models: [...$('#modelSel').options].map(o => o.value).filter(Boolean) });
    // main valida la URL y puede rechazar: la UI no puede decir «guardado» sin comprobarlo
    if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo guardar'));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg('Proveedor guardado.');
  } catch (e) { smsg('Error: ' + ((e && e.message) || e)); }
  finally { btn.disabled = false; }
};
$('#btnActivate').onclick = async () => {
  const btn = $('#btnActivate');
  if (btn.disabled) return;
  const baseUrl = $('#pUrl').value.trim(), model = $('#modelSel').value;
  if (!baseUrl || !model) return smsg('Detecta modelos y elige uno.');
  const vision = looksVision(model);
  btn.disabled = true;
  try {
    const r = await window.sagitari.activateProvider({ name: $('#pName').value.trim() || 'Proveedor', baseUrl, apiKey: $('#pKey').value.trim(), model, vision, format: apiFormatValue() });
    // activar también valida: si falla, NO se pinta «activo»/«Conectado»
    if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo activar'));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg('Activado: ' + model);
    updateStatusLabels();
  } catch (e) { smsg('Error: ' + ((e && e.message) || e)); }
  finally { btn.disabled = false; }
};

function renderProviderList() {
  const box = $('#provList');
  box.innerHTML = '';
  hintStoredKey();   // la lista cambió (guardar/borrar/activar): el aviso del campo se recalcula
  if (!CFG.providers.length) { box.innerHTML = '<div class="subnote">Aún no hay proveedores guardados.</div>'; return; }
  for (const p of CFG.providers) {
    const item = document.createElement('div');
    item.className = 'provitem';
    const inUse = CFG.active && (CFG.active.providerId === p.id || CFG.active.baseUrl === p.baseUrl);
    item.innerHTML = `<span class="nm">${esc(p.name)} <span class="md">· ${(p.models || []).length} modelos</span></span>${inUse ? '<span class="badge">EN USO</span>' : ''}
      <button class="btn ghost sq" data-act="use" title="Usar">${ic('play')}</button><button class="btn ghost sq danger" data-act="del" title="Eliminar">${ic('trash')}</button>`;
    item.querySelector('[data-act=use]').onclick = async () => {
      const model = (p.models || [])[0];
      if (!model) return smsg('Este proveedor no tiene modelos: detecta primero.');
      // providerId: es lo que permite desactivarlo al borrarlo (main lo resuelve)
      const r = await window.sagitari.activateProvider({ providerId: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model, vision: looksVision(model), format: p.format });
      if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo activar'));
      CFG = await window.sagitari.getConfig();
      renderProviderList(); updateStatusLabels();
      smsg('Usando ' + p.name);
    };
    item.querySelector('[data-act=del]').onclick = async () => {
      if (!(await askConfirm(item, '¿Eliminar el proveedor «' + p.name + '»?'))) return;
      await window.sagitari.deleteProvider(p.id);
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels();   // si era el activo, main lo desactiva: que se vea
      showToast('Proveedor eliminado');
    };
    box.appendChild(item);
  }
}
function smsg(t) { $('#saveMsg').textContent = t; }
/** Aviso del panel MCP (no reutiliza el del formulario de proveedores). */
function mcpMsg(t) { const el = $('#mcpMsg'); if (el) el.textContent = t || ''; }

/* El campo de la clave se vacía al elegir un preset (no se reescribe una credencial
   en pantalla), y activar o detectar en ese momento parecía «sin clave»: el aviso
   va en el propio campo. */
function hintStoredKey() {
  const el = $('#pKey');
  if (!el) return;
  const url = $('#pUrl').value.trim();
  const guardado = (CFG.providers || []).find(p => p.baseUrl === url && p.apiKey);
  el.placeholder = guardado
    ? 'guardada en «' + guardado.name + '» — déjalo vacío para seguir usándola'
    : 'sk-… (vacío para Ollama o LM Studio)';
}
if ($('#pUrl')) $('#pUrl').addEventListener('input', hintStoredKey);

$('#swGlow').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ glowEnabled: on }); };
// espacio de trabajo
$('#wsPick').onclick = async () => {
  const r = await window.sagitari.workspacePick();
  if (r && r.ok) { $('#wsPath').value = r.path; showToast('Espacio de trabajo: ' + r.path); }
};
$('#swTts').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ ttsEnabled: on }); };
$('#voiceLang').onchange = async (e) => {
  try { await window.sagitari.setSettings({ voiceLang: e.target.value }); }
  catch (err) { showToast('No se pudo guardar el idioma de voz'); }
};

// ---- apariencia: aplicar al vuelo y persistir ----
function refreshGlowLabels() {
  const v = Number($('#glowStrength').value) || 1;
  $('#glowStrengthLabel').textContent = glowStrengthLabel(v);
  $('#lblSuave').classList.toggle('on', v < 0.8);
  $('#lblEq').classList.toggle('on', v >= 0.8 && v <= 1.15);
  $('#lblInt').classList.toggle('on', v > 1.15);
}
function refreshColorDots() {
  const ui = (PALETTES[$('#uiColor').value] || PALETTES.violet).acc2;
  const gsel = $('#glowColor').value;
  const gl = gsel === 'match' ? ui : (PALETTES[gsel] || PALETTES.violet).acc2;
  document.getElementById('dotUiColor').style.background = `rgb(${ui.join(',')})`;
  document.getElementById('dotUiColor').style.boxShadow = `0 0 12px rgba(${ui.join(',')},0.55), inset 0 0 0 1px rgba(255,255,255,0.18)`;
  document.getElementById('dotGlowColor').style.background = `rgb(${gl.join(',')})`;
  document.getElementById('dotGlowColor').style.boxShadow = `0 0 12px rgba(${gl.join(',')},0.55), inset 0 0 0 1px rgba(255,255,255,0.18)`;
}
$('#uiColor').onchange = async (e) => {
  CFG.settings.uiColor = e.target.value;
  applyTheme(); refreshColorDots();
  await window.sagitari.setSettings({ uiColor: e.target.value });
};
$('#glowColor').onchange = async (e) => {
  CFG.settings.glowColor = e.target.value;
  applyTheme(); refreshColorDots();
  await window.sagitari.setSettings({ glowColor: e.target.value });
};
let glowSaveTimer = null;
$('#glowStrength').oninput = (e) => {
  CFG.settings.glowStrength = Number(e.target.value);
  applyTheme(); refreshGlowLabels();          // previsualización instantánea
  clearTimeout(glowSaveTimer);
  glowSaveTimer = setTimeout(() => window.sagitari.setSettings({ glowStrength: Number(e.target.value) }), 250);
};
$('#setUserName').onchange = async (e) => {
  CFG.settings.userName = e.target.value;
  try { await window.sagitari.setSettings({ userName: e.target.value }); }
  catch (err) { showToast('No se pudo guardar tu nombre'); }
};

// ---- seguridad: permisos por herramienta + guardarraíles (v1.1) ----
const PERM_TOOLS = [
  { n: 'run_command', d: 'Ejecutar comandos en la terminal' },
  { n: 'write_file', d: 'Crear o sobrescribir archivos' },
  { n: 'edit_file', d: 'Editar archivos existentes' },
  { n: 'browser_control', d: 'Controlar el navegador' },
  { n: 'open_app', d: 'Abrir aplicaciones' },
  { n: 'window_manage', d: 'Gestionar ventanas' },
  { n: 'clipboard', d: 'Portapapeles' },
];
/* El nivel 'safe' se llamaba «Seguro», que se lee como «más protección» cuando en
   realidad significa «se ejecuta SIN preguntar». El nombre dice ahora su efecto. */
const RISK_LABEL = { safe: 'permitir siempre', confirm: 'confirmar', restricted: 'bloqueado' };

/* Seguridad se pinta al arrancar (initSecurity) Y al entrar en su pestaña, así que dos
   pasadas pueden solaparse (al arrancar con «Seguridad» recordada como última pestaña, por
   ejemplo): las dos empiezan vaciando `#permList` y las filas se duplicarían o quedarían a
   medias. La segunda no se descarta: se ENCOLA, porque descartarla dejaba la lista con los
   datos viejos justo cuando el usuario acababa de entrar. */
let securityPainting = false;
let securityAgain = false;
async function renderSecurity() {
  if (securityPainting) { securityAgain = true; return; }
  securityPainting = true;
  try {
    do { securityAgain = false; await _renderSecurity(); } while (securityAgain);
  } finally { securityPainting = false; }
}
async function _renderSecurity() {
  let cfg = { permissions: {}, riskDefaults: {} };
  try {
    const m = await window.sagitari.metaGet();
    cfg.permissions = m.permissions || (CFG.security && CFG.security.permissions) || {};
    cfg.riskDefaults = m.riskDefaults || {};
  } catch {}
  const permBox = $('#permList');
  if (!permBox) return;
  permBox.innerHTML = '';
  for (const t of PERM_TOOLS) {
    const lvl = (cfg.permissions && cfg.permissions[t.n]) || 'default';
    const rec = RISK_LABEL[cfg.riskDefaults[t.n]] || 'confirmar';
    const row = document.createElement('div');
    row.className = 'permrow';
    row.innerHTML = `<span class="mt"><b>${esc(K.tool(t.n).label)}</b> <small class="md">${esc(t.n)}</small><br><small class="md">${esc(t.d)}</small><br><small class="pd">recomendado: ${rec}</small></span>
      <select data-tool="${t.n}" aria-label="Permiso para ${esc(K.tool(t.n).label)} (${esc(t.n)})">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto (${rec})</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>Permitir siempre</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>Preguntar antes</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>Bloqueado</option>
      </select>`;
    row.querySelector('select').onchange = async (e) => {
      await window.sagitari.secSetToolPerm(t.n, e.target.value);
      showToast(`${t.n}: ${e.target.selectedOptions[0].textContent.toLowerCase()}`);
    };
    permBox.appendChild(row);
  }
  // ---- v3.1: servidores MCP. El comodín `mcp__<id>__*` gobierna TODAS sus
  // herramientas de una vez (el override exacto de una herramienta sigue ganando).
  let mcp = { servers: [] };
  try { mcp = await window.sagitari.mcpList(); } catch {}
  for (const s of (mcp.servers || [])) {
    const wildcard = 'mcp__' + s.id + '__*';
    const lvl = (cfg.permissions && cfg.permissions[wildcard]) || 'default';
    const n = (s.discovered || []).length;
    const row = document.createElement('div');
    row.className = 'permrow';
    row.innerHTML = `<span class="mt"><b>${esc(s.name)}</b> <small class="md">MCP</small><br><small class="md">${n} herramienta${n === 1 ? '' : 's'} del servidor</small><br><small class="pd">todas sus herramientas piden permiso salvo que las permitas aquí</small></span>
      <select data-tool="${esc(wildcard)}" aria-label="Permiso para el servidor MCP ${esc(s.name)}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto (preguntar antes)</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>Permitir siempre</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>Preguntar antes</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>Bloqueado</option>
      </select>`;
    row.querySelector('select').onchange = async (e) => {
      await window.sagitari.secSetToolPerm(wildcard, e.target.value);
      showToast('MCP ' + s.name + ': ' + e.target.selectedOptions[0].textContent.toLowerCase());
    };
    permBox.appendChild(row);
  }
  // los desplegables de permisos nacen aquí: se mejoran al pintarse
  mejoraSelects(permBox);
}
async function initSecurity() {
  try {
    const m = await window.sagitari.metaGet();
    const g = m.guardrails || {};
    $('#grSteps').value = g.maxSteps ?? 60;
    $('#grToolCalls').value = g.maxToolCalls ?? 80;
    $('#grMinutes').value = g.maxDurationMs ? Math.round(g.maxDurationMs / 60000) : 0;
    $('#grTokens').value = g.maxTokens ?? 0;
    $('#grLoop').value = g.loopThreshold ?? 3;
    if ($('#grCost')) $('#grCost').value = g.maxCostUsd ?? 0;
    if ($('#grStall')) $('#grStall').value = g.stallThreshold ?? 6;
    if ($('#grLlmTimeout')) $('#grLlmTimeout').value = Math.round((CFG.settings.llmTimeoutMs ?? 120000) / 1000);
    if ($('#setMaxTasks')) $('#setMaxTasks').value = CFG.settings.maxConcurrentTasks ?? 1;
    if ($('#swAutoResume')) $('#swAutoResume').classList.toggle('on', CFG.settings.autoResumeTasks !== false);
    if (CFG.settings.devMode) { devMode = true; $('#devModeSw').classList.add('on'); paintMeta(); }
  } catch {}
  renderSecurity();
}
/** Lee un campo numérico de límites respetando el `min`/`max` declarado y lo
    escribe de vuelta. loopThreshold<=1 hacía que el agente declarase bucle en la
    PRIMERA herramienta y la tarea muriera al arrancar. */
function clampGuardrail(el, fallback) {
  const raw = String(el.value).trim();
  let v = raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(v)) v = fallback;
  const min = el.min === '' ? 0 : Number(el.min);
  const max = el.max === '' ? Infinity : Number(el.max);
  v = Math.min(max, Math.max(min, v));
  el.value = v;
  return v;
}
$('#grSteps').onchange = (e) => window.sagitari.secSetGuardrail({ maxSteps: clampGuardrail(e.target, 0) });
$('#grToolCalls').onchange = (e) => window.sagitari.secSetGuardrail({ maxToolCalls: clampGuardrail(e.target, 0) });
$('#grMinutes').onchange = (e) => window.sagitari.secSetGuardrail({ maxDurationMs: clampGuardrail(e.target, 0) * 60000 });
$('#grTokens').onchange = (e) => window.sagitari.secSetGuardrail({ maxTokens: clampGuardrail(e.target, 0) });
$('#grLoop').onchange = (e) => window.sagitari.secSetGuardrail({ loopThreshold: clampGuardrail(e.target, 3) });
if ($('#grCost')) $('#grCost').onchange = (e) => window.sagitari.secSetGuardrail({ maxCostUsd: clampGuardrail(e.target, 0) });
if ($('#grStall')) $('#grStall').onchange = (e) => window.sagitari.secSetGuardrail({ stallThreshold: clampGuardrail(e.target, 0) });
if ($('#grLlmTimeout')) $('#grLlmTimeout').onchange = async (e) => {
  const v = clampGuardrail(e.target, 120);
  await window.sagitari.setSettings({ llmTimeoutMs: v * 1000 });
  showToast(v ? 'Sin respuesta del modelo: ' + v + ' s' : 'Sin límite de espera del modelo');
};
if ($('#setMaxTasks')) $('#setMaxTasks').onchange = async (e) => {
  const v = Math.max(1, Math.min(4, Number(e.target.value) || 1));
  e.target.value = v;
  await window.sagitari.setSettings({ maxConcurrentTasks: v });
  showToast('Tareas simultáneas: ' + v);
};
if ($('#swAutoResume')) $('#swAutoResume').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  await window.sagitari.setSettings({ autoResumeTasks: on });
};
$('#devModeSw').onclick = async (e) => {
  devMode = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', devMode);
  await window.sagitari.setSettings({ devMode });
  paintMeta();
};
// initSecurity() se llama desde init(), DESPUÉS de fillSettings(): en top-level
// leía CFG.settings vacío y perdía devMode/maxConcurrentTasks/autoResume en cada arranque.

/* ============ v3.1: servidores MCP ============ */
/* let (no const): renderMcp() lo reemplaza en cada refresco — con const, la
   asignación lanzaba «Assignment to constant variable» y el panel nunca pintaba. */
let MCP_STATE = { enabled: true, servers: [] };
const mcpPair = (text) => String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; })
  .filter(Boolean);
const mcpLines = (obj) => Object.entries(obj || {}).map(([k, v]) => k + '=' + v).join('\n');

/** Estados del servidor, tal y como los ve el usuario. */
function mcpStatusLabel(s) {
  if (!s.enabled) return { text: 'Desactivado', cls: 'off' };
  const n = (s.discovered || []).length;
  if (s.state === 'ready') return { text: 'Listo (' + n + ' herramienta' + (n === 1 ? '' : 's') + ')', cls: 'ok' };
  if (s.state === 'starting') return { text: 'Conectando…', cls: 'wait' };
  if (s.state === 'dead') return { text: 'Error: ' + (s.error || 'no arrancó'), cls: 'err' };
  return { text: 'Sin probar', cls: 'off' };
}

async function renderMcp() {
  const box = $('#mcpList');
  if (!box) return;
  try { MCP_STATE = await window.sagitari.mcpList(); } catch (e) { showToast('No pude leer los servidores MCP: ' + e.message); return; }
  $('#mcpGlobal').classList.toggle('on', MCP_STATE.enabled !== false);
  if (!(MCP_STATE.servers || []).length) {
    box.innerHTML = '<div class="mcpempty">Ningún servidor MCP. Añade uno o pega el JSON de <code>mcpServers</code> de otro cliente.</div>';
    return;
  }
  box.innerHTML = MCP_STATE.servers.map(s => {
    const st = mcpStatusLabel(s);
    const lista = (s.discovered || []).map(t => `<span class="mcptool" title="${esc(t.description || '')}">${esc(t.tool)}</span>`).join('');
    return `<div class="mcprow" data-id="${esc(s.id)}">
      <div class="mcphead">
        <span class="mcpdot ${st.cls}"></span>
        <b>${esc(s.name)}</b>
        <span class="mcpst">${esc(st.text)}</span>
        <span class="mcpdo">${s.transport === 'http' ? 'URL' : 'local'}</span>
      </div>
      <div class="mcptools">${lista}</div>
      <div class="mcpacts">
        <button class="btn ghost" data-mcp="test">Probar</button>
        <button class="btn ghost" data-mcp="log">Ver log</button>
        <button class="btn ghost" data-mcp="edit">Editar</button>
        <button class="btn ghost" data-mcp="toggle">${s.enabled ? 'Desactivar' : 'Activar'}</button>
        <button class="btn ghost" data-mcp="del">Eliminar</button>
      </div>
    </div>`;
  }).join('');
  mejoraSelects(box);
}

async function mcpFormShow(server) {
  const s = server || { transport: 'stdio', tools: {} };
  // Se oculta con clase (ver styles.css), pero el buscador de Ajustes pudo fijar
  // [hidden] en esta tarjeta mientras había una búsqueda activa: al abrirla hay
  // que soltarlo, o "Editar" con una búsqueda puesta no enseñaría nada.
  const card = $('#mcpFormCard');
  card.hidden = false;
  card.classList.add('on');
  // Y el buscador también dejó `hidden` en las FILAS de la tarjeta que no casaron:
  // sin devolverlas, el formulario se abriría a medias (solo la fila que coincidió).
  card.querySelectorAll('.srow').forEach(r => { r.hidden = false; });
  $('#mcpFormTitle').textContent = server ? 'Editar servidor' : 'Nuevo servidor';
  $('#mcpId').value = s.id || '';
  $('#mcpId').disabled = !!server;
  $('#mcpName').value = s.name || '';
  $('#mcpTransport').value = s.transport || 'stdio';
  $('#mcpCommand').value = s.command || '';
  $('#mcpArgs').value = (s.args || []).join(' ');
  $('#mcpEnv').value = mcpLines(s.env);
  $('#mcpUrl').value = s.url || '';
  $('#mcpHeaders').value = mcpLines(s.headers);
  $('#mcpAllow').value = (s.tools && s.tools.allow || []).join(', ');
  $('#mcpDeny').value = (s.tools && s.tools.deny || []).join(', ');
  // El nivel real vive en security.permissions['mcp__<id>__*'] (misma fuente que la
  // vista Seguridad: config:get no expone `security`). Sin esto el desplegable mentiría:
  // diría «Preguntar siempre» con el comodín en 'safe'.
  let nivel = 'default';
  if (server && server.id) {
    try { const m = await window.sagitari.metaGet(); nivel = (m.permissions || {})['mcp__' + server.id + '__*'] || 'default'; } catch {}
  }
  $('#mcpLevel').value = nivel;
  $('#mcpFormDelete').hidden = !server;
  mejoraSelects(card);
  // fijar el <select> por código no dispara el MutationObserver de mejoraSelect: el
  // control propio (.csel) se quedaría con la etiqueta anterior
  cselPintar($('#mcpTransport'));
  cselPintar($('#mcpLevel'));
  mcpTransportRows();
}

function mcpTransportRows() {
  const esHttp = $('#mcpTransport').value === 'http';
  $('#mcpStdioRows').hidden = esHttp;
  $('#mcpHttpRows').hidden = !esHttp;
}

/** Construye el servidor con lo que hay en el formulario (valida main). */
function mcpFormValue() {
  const pair = (id) => Object.fromEntries(mcpPair($(id).value));
  return {
    id: $('#mcpId').value.trim(),
    name: $('#mcpName').value.trim(),
    transport: $('#mcpTransport').value,
    command: $('#mcpCommand').value.trim(),
    args: $('#mcpArgs').value.trim() ? $('#mcpArgs').value.trim().split(/\s+/) : [],
    env: pair('#mcpEnv'),
    url: $('#mcpUrl').value.trim(),
    headers: pair('#mcpHeaders'),
    tools: {
      allow: $('#mcpAllow').value.split(',').map(x => x.trim()).filter(Boolean),
      deny: $('#mcpDeny').value.split(',').map(x => x.trim()).filter(Boolean),
    },
  };
}

$('#mcpTransport').onchange = mcpTransportRows;
$('#mcpNew').onclick = () => mcpFormShow(null);
$('#mcpCancel').onclick = () => { $('#mcpFormCard').classList.remove('on'); };
$('#mcpGlobal').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  await window.sagitari.mcpSetGlobal(on);
  renderMcp();
};
$('#mcpSave').onclick = async () => {
  const s = mcpFormValue();
  const nivel = $('#mcpLevel').value;
  const r = await window.sagitari.mcpSave(s);
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  // El nivel elegido se aplica SIEMPRE al comodín del servidor (el MISMO que edita
  // Seguridad), también con 'default': así el desplegable no es decorativo y se puede
  // volver atrás (sec:setToolPerm borra el comodín cuando recibe 'default'). Se usa el
  // id que devuelve main (ya saneado), no el del formulario, que puede traer mayúsculas.
  if (r.id && nivel) await window.sagitari.secSetToolPerm('mcp__' + r.id + '__*', nivel);
  $('#mcpFormCard').classList.remove('on');
  mcpMsg('Guardado. Probando la conexión…');
  const t = await window.sagitari.mcpTest(r.id || s.id);
  mcpMsg(t.ok ? 'Conectado: ' + (t.server ? t.server.discovered.length : 0) + ' herramientas.' : 'No conecta: ' + t.error);
  renderMcp();
};
$('#mcpFormDelete').onclick = async () => {
  const id = $('#mcpId').value.trim();
  const yes = await askConfirm($('#mcpFormCard'), '¿Eliminar el servidor MCP «' + id + '»?', 'Se borran su configuración y sus permisos.');
  if (!yes) return;
  const r = await window.sagitari.mcpDelete(id);
  $('#mcpFormCard').classList.remove('on');
  mcpMsg(r.ok ? 'Servidor eliminado.' : 'Error: ' + r.error);
  renderMcp();
};
$('#mcpList').onclick = async (e) => {
  const btn = e.target.closest('[data-mcp]');
  if (!btn) return;
  const id = btn.closest('.mcprow').dataset.id;
  const accion = btn.dataset.mcp;
  if (accion === 'edit') return mcpFormShow(MCP_STATE.servers.find(s => s.id === id));
  if (accion === 'toggle') {
    const s = MCP_STATE.servers.find(x => x.id === id);
    await window.sagitari.mcpToggle(id, !s.enabled);
    return renderMcp();
  }
  if (accion === 'del') {
    const yes = await askConfirm(btn, '¿Eliminar «' + id + '»?', 'Se borran su configuración y sus permisos.');
    if (!yes) return;
    await window.sagitari.mcpDelete(id);
    // si el formulario estaba editando justo ese servidor, se cierra: dejarlo abierto
    // permitiría recrearlo en silencio con un «Guardar» posterior
    if ($('#mcpFormCard').classList.contains('on') && $('#mcpId').value.trim() === id) {
      $('#mcpFormCard').classList.remove('on');
      $('#mcpFormCard').hidden = true;
    }
    return renderMcp();
  }
  if (accion === 'log') {
    const r = await window.sagitari.mcpLog(id);
    return showToast(r.log ? r.log.split('\n').slice(-3).join(' · ') : (r.error || 'El servidor no ha escrito nada.'));
  }
  if (accion === 'test') {
    btn.textContent = 'Probando…';
    const r = await window.sagitari.mcpTest(id);
    btn.textContent = 'Probar';
    mcpMsg(r.ok ? 'Conectado: ' + (r.server ? r.server.discovered.length : 0) + ' herramientas.' : 'No conecta: ' + r.error);
    return renderMcp();
  }
};
$('#mcpExportBtn').onclick = async () => {
  const r = await window.sagitari.mcpExport();
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  copyText(r.json, 'JSON copiado (contiene tus secretos: no lo compartas).');
};
// `window.prompt` NO existe en Electron (lanza «prompt() is not supported»): el
// cuadro de pegado es propio, como el resto de la interfaz.
$('#mcpPaste').onclick = () => {
  const b = $('#mcpPasteBox');
  b.hidden = !b.hidden;
  if (!b.hidden) { $('#mcpPasteText').value = ''; $('#mcpPasteText').focus(); }
};
$('#mcpPasteCancel').onclick = () => { $('#mcpPasteBox').hidden = true; };
$('#mcpPasteGo').onclick = async () => {
  const json = $('#mcpPasteText').value.trim();
  if (!json) return mcpMsg('Pega el bloque mcpServers en el cuadro.');
  const r = await window.sagitari.mcpImport(json);
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  const resumen = r.servers.map(s => s.id + (s.conflict ? ' (reemplaza el actual)' : '')).join(', ');
  const yes = await askConfirm($('#mcpPasteBox'), '¿Añadir estos servidores?', resumen);
  if (!yes) return;
  for (const s of r.servers) await window.sagitari.mcpSave(s);
  $('#mcpPasteBox').hidden = true;
  mcpMsg('Añadidos: ' + resumen);
  renderMcp();
};

/* ============ Ajustes: pestañas, búsqueda y utilidades ============ */

const SET_TABS = ['model', 'prefs', 'security', 'agent', 'mcp', 'data', 'about'];
let setTabName = 'model';
try { const t = localStorage.getItem('sagi.setTab'); if (SET_TABS.includes(t)) setTabName = t; } catch {}

/** Muestra una pestaña de Ajustes (y la recuerda para la próxima vez). */
function showSetTab(panel) {
  const name = SET_TABS.includes(panel) ? panel : 'model';
  setTabName = name;
  try { localStorage.setItem('sagi.setTab', name); } catch {}
  const tabs = $('#setTabs');
  if (tabs) {
    tabs.setAttribute('role', 'tablist');
    tabs.querySelectorAll('.settab').forEach(b => {
      const on = b.dataset.set === name;
      b.classList.toggle('on', on);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  const wrap = $('#setWrap');
  if (wrap) wrap.querySelectorAll('.setpanel').forEach(p => p.classList.toggle('on', p.dataset.panel === name));
  if (name === 'mcp') renderMcp();
  // Seguridad también se pinta al entrar: sus filas MCP reflejan los servidores de la
  // sesión (conectados, con su número de herramientas) y al pintarse una sola vez al
  // arrancar mostraban datos viejos.
  if (name === 'security') renderSecurity();
  // la pestaña «Acerca de» ya enseña el aviso: el punto del sidebar sobra
  // (solo si Ajustes está a la vista: fillSettings llama aquí al arrancar)
  if (name === 'about' && $('#view-settings').classList.contains('on')) setBadge('#nbUpdate', 0);
}
if ($('#setTabs')) $('#setTabs').querySelectorAll('.settab').forEach(b => {
  b.onclick = () => {
    const q = $('#setSearch');
    if (q && q.value) { q.value = ''; filterSettings(''); }
    showSetTab(b.dataset.set);
  };
});

/** Filtra los ajustes por texto. Con búsqueda activa se muestran todas las tarjetas
    cuyas filas (`.srow` y `.themerow`) coincidan. */
const SET_ROWS = '.srow, .themerow';
function filterSettings(query) {
  const wrap = $('#setWrap');
  if (!wrap) return;
  const q = String(query || '').trim().toLowerCase();
  wrap.classList.toggle('searching', !!q);
  // Con búsqueda activa se muestran TODOS los paneles (CSS .setwrap.searching
  // .setpanel), así que cuentan las filas de cualquiera de ellos; sin búsqueda
  // solo hay abierto el panel con .on. Contar las filas de un panel cerrado
  // (display:none) daba por buena una búsqueda cuyo único resultado no se veía
  // y, además, ocultaba el aviso «Ningún ajuste coincide».
  const buscando = wrap.classList.contains('searching');
  let shown = 0;
  wrap.querySelectorAll(SET_ROWS).forEach(row => {
    const hay = ((row.dataset.keys || '') + ' ' + row.textContent).toLowerCase();
    const hit = !q || hay.includes(q);
    row.hidden = !hit;
    const panel = row.closest('.setpanel');
    if (hit && (buscando || !panel || panel.classList.contains('on'))) shown++;
  });
  wrap.querySelectorAll('.setcard').forEach(card => {
    card.hidden = !!q && ![...card.querySelectorAll(SET_ROWS)].some(r => !r.hidden);
  });
  const empty = $('#setNoResults');
  if (empty) empty.hidden = !(q && shown === 0);
}
if ($('#setSearch')) $('#setSearch').addEventListener('input', (e) => filterSettings(e.target.value));

// mostrar/ocultar la API key
if ($('#apiKeyReveal')) $('#apiKeyReveal').onclick = () => {
  const k = $('#pKey');
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('#apiKeyReveal').classList.toggle('on', show);
  $('#apiKeyReveal').title = show ? 'Ocultar la clave' : 'Mostrar la clave';
};

// restablecer límites a los valores recomendados QUE DEFINE EL AGENTE (main los
// expone en meta:get): antes había una segunda lista hardcodeada aquí que podía
// desincronizarse de la del agente y «restablecer» a algo que ya no era lo suyo
if ($('#secResetGuardrails')) $('#secResetGuardrails').onclick = async () => {
  try {
    const m = await window.sagitari.metaGet();
    const d = m && m.guardrailDefaults;
    if (!d) throw new Error('el agente no informó de sus valores recomendados');
    const r = await window.sagitari.secSetGuardrail(d);
    if (r && r.ok === false) throw new Error(r.error || 'no se pudo guardar');
    await initSecurity();
    showToast('Límites restablecidos a los valores recomendados');
  } catch (e) {
    showToast('No se pudieron restablecer: ' + ((e && e.message) || 'error'));
  }
};
if ($('#secResetPerms')) $('#secResetPerms').onclick = async () => {
  for (const t of PERM_TOOLS) await window.sagitari.secSetToolPerm(t.n, 'default');
  await renderSecurity();
  showToast('Permisos restablecidos a los recomendados');
};

// datos: hábitos aprendidos + carpeta de datos
async function renderHabitsPreview() {
  const box = $('#habitsPreview');
  if (!box) return;
  let s = null;
  try { s = await window.sagitari.habitsGet(); } catch {}
  if (!s) { box.innerHTML = ''; return; }
  const pills = [];
  const add = (label, arr) => {
    if (arr && arr.length) pills.push(`<span class="hpill">${esc(label)}: ${arr.map(x => esc(x.name) + ' ×' + x.count).join(', ')}</span>`);
  };
  add('apps', s.apps); add('comandos', s.commands); add('carpetas', s.folders);
  add('webs', s.sites); add('herramientas', s.tools);
  const modes = Object.entries(s.modes || {}).sort((a, b) => b[1] - a[1]);
  if (modes.length && modes[0][1] >= 2) pills.push(`<span class="hpill">modo: ${esc(modes[0][0])}</span>`);
  box.innerHTML = pills.length
    ? pills.join('')
    : '<span class="hdim">Todavía no hay hábitos: se aprenden con el uso normal de la app.</span>';
}
async function initDataPanel() {
  try {
    const m = await window.sagitari.metaGet();
    const p = $('#dataDirPath');
    if (p && m.dataDir) p.textContent = m.dataDir;
  } catch {}
  renderHabitsPreview();
}
if ($('#habitsResetBtn')) $('#habitsResetBtn').onclick = async () => {
  const btn = $('#habitsResetBtn');
  if (btn.disabled) return;
  const anchor = btn.closest('.srow') || btn;
  if (!(await askConfirm(anchor, '¿Reiniciar los hábitos aprendidos?', 'Se borra lo que Sagitari ha deducido de tu uso: apps, comandos, webs y tu modo preferido.'))) return;
  btn.disabled = true;
  try {
    await window.sagitari.habitsReset();
    await renderHabitsPreview();
    if ($('#view-agents').classList.contains('on')) renderHabits();
    showToast('Hábitos aprendidos reiniciados');
  } finally { btn.disabled = false; }
};
if ($('#openDataDirBtn')) $('#openDataDirBtn').onclick = async () => {
  const r = await window.sagitari.openDataDir();
  if (r && r.ok === false) showToast(r.error || 'No se pudo abrir la carpeta');
};

/* ============ Acerca de: actualizaciones (aviso discreto) ============
   El motor vive en main/updater.js (comprobar, descargar, verificar el sha512 y
   lanzar el instalador): aquí solo se pinta el estado y se pide la acción.
   Nada se descarga ni se instala sin un clic del usuario. */
let updState = { kind: null, current: null, latest: null, available: false, ready: null, status: 'idle', error: null, progress: null };
let updInitDone = false;   // la comprobación al abrir Ajustes se hace UNA vez, no en cada render
let updNotified = false;   // el toast de «nueva versión» no se repite en toda la sesión

/** «2.3.0» → «v2.3.0»; sin versión conocida, un guion. */
function updVer(v) { return v ? 'v' + String(v).replace(/^v/i, '') : '—'; }

/** Tamaño legible («12,4 MB») para la nota de progreso. */
function updSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

/** Mensaje de la tarjeta (vacío lo limpia). */
function updMsg(text) { const el = $('#updMsg'); if (el) el.textContent = text || ''; }

/** Pinta la tarjeta «Actualizaciones». GLOBAL para poder comprobarla desde fuera.
    `state = { kind, current, latest, available, ready, status, error, progress }`
    con `status` ∈ 'idle' | 'checking' | 'downloading' | 'ready'. */
function renderUpdate(state) {
  const v = state || {};
  const s = {
    kind: v.kind || null, current: v.current || null, latest: v.latest || null,
    available: !!v.available, ready: v.ready || null, status: v.status || 'idle',
    error: v.error || null, progress: v.progress || null
  };
  // un archivo con verificación fallida no existe (main lo descarta): `verified`
  // sólo puede valer true cuando hay algo listo para instalar
  const ready = s.ready && s.ready.verified === true ? s.ready : null;

  const ver = updVer(s.current);
  const cur = $('#updCurrent'); if (cur) cur.textContent = ver;
  const app = $('#aboutVersion'); if (app) app.textContent = ver;

  const st = $('#updState');
  if (st) {
    if (s.status === 'checking') st.textContent = 'Buscando actualizaciones…';
    else if (s.status === 'downloading') st.textContent = 'Descargando la versión ' + (s.latest || '') + '…';
    else if (s.error) st.textContent = 'No se pudo comprobar: ' + s.error;
    else if (s.available) st.textContent = 'Nueva versión ' + (s.latest || '') + ' disponible';
    else if (s.current || s.latest) st.textContent = 'Estás al día';
    else st.textContent = 'Aún no se ha comprobado.';
  }

  const busy = s.status === 'checking' || s.status === 'downloading';
  const check = $('#updCheckBtn');
  if (check) {
    check.disabled = busy;
    const lbl = $('#updCheckLabel');
    if (lbl) lbl.textContent = s.status === 'checking' ? 'Buscando…' : 'Buscar actualizaciones';
  }
  const dl = $('#updDownloadBtn');
  if (dl) {
    // en modo 'dev' también se puede descargar (el instalador); lo imposible es instalar
    dl.hidden = !(s.available && !ready && s.status !== 'downloading');
    dl.disabled = busy;
  }
  const inst = $('#updInstallBtn');
  if (inst) {
    const puede = !!ready && s.kind !== 'dev';
    inst.hidden = !puede;
    if (puede) {
      const portable = s.kind === 'portable';
      const lbl = $('#updInstallLabel');
      if (lbl) lbl.textContent = portable ? 'Abrir carpeta' : 'Instalar y cerrar';
      inst.setAttribute('aria-label', portable
        ? 'Abrir la carpeta con el archivo descargado'
        : 'Instalar la actualización; Sagitari se cerrará para instalarse');
    }
    inst.disabled = busy;
  }

  // progreso: pct + bytes, con aria-valuenow para los lectores de pantalla
  const downloading = s.status === 'downloading';
  const pct = Math.max(0, Math.min(100, Math.round(Number(s.progress && s.progress.pct) || 0)));
  const prow = $('#updProgressRow'); if (prow) prow.classList.toggle('on', downloading);
  const bar = $('#updBar'); if (bar) bar.setAttribute('aria-valuenow', String(pct));
  const fill = $('#updBarFill'); if (fill) fill.style.transform = 'scaleX(' + (pct / 100) + ')';
  const bnote = $('#updBarNote');
  if (bnote && downloading) {
    const total = s.progress && s.progress.total;
    bnote.textContent = 'Descargando… ' + pct + ' %'
      + (total ? ' (' + updSize(s.progress.received) + ' de ' + updSize(total) + ')' : '');
  }

  // notas: modo de ejecución, firma y qué pasará exactamente al instalar
  const notes = [];
  if (s.kind === 'dev') notes.push('Estás ejecutando desde el código fuente; para actualizarte, compila o usa el instalador.');
  if (ready) {
    if (ready.signed === false) notes.push('Esta actualización no está firmada digitalmente: se instala solo con la verificación SHA-512 publicada en la release.');
    else if (ready.signed === true && ready.signer) notes.push('Firmada digitalmente por ' + ready.signer + '.');
    if (s.kind === 'nsis') notes.push('La app se cerrará para instalarse. Vuelve a abrirla cuando termine.');
    if (s.kind === 'portable') notes.push('Cierra la app y ejecuta el archivo nuevo desde la carpeta que se abrirá.');
  }
  const note = $('#updNote');
  if (note) { note.textContent = notes.join(' '); note.hidden = !notes.length; }
}

/** Comprueba si hay versión nueva y refresca la tarjeta. Quita el punto del sidebar. */
async function refreshUpdate() {
  updState.status = 'checking';
  updState.error = null;
  updState.progress = null;
  setBadge('#nbUpdate', 0);
  updMsg('');
  renderUpdate(updState);
  try {
    const r = await window.sagitari.updateCheck();
    if (!r) throw new Error('respuesta vacía del actualizador');
    updState.current = r.current || updState.current;
    updState.latest = r.latest || null;
    updState.available = !!r.available;
    updState.kind = r.kind || updState.kind;
    updState.ready = r.ready || updState.ready;
    updState.error = r.ok === false ? (r.error || 'error desconocido') : null;
  } catch (e) {
    updState.error = String((e && e.message) || e || 'error desconocido');
  }
  updState.status = updState.ready ? 'ready' : 'idle';
  renderUpdate(updState);
}

/** Al entrar en Ajustes: pinta lo que ya sepamos y comprueba una sola vez. */
function initAboutPanel() {
  renderUpdate(updState);
  if (updInitDone) return;
  updInitDone = true;
  refreshUpdate();
}

if ($('#updCheckBtn')) $('#updCheckBtn').onclick = () => refreshUpdate();

if ($('#updDownloadBtn')) $('#updDownloadBtn').onclick = async () => {
  const btn = $('#updDownloadBtn');
  if (btn.disabled) return;
  updState.status = 'downloading';
  updState.progress = { pct: 0, received: 0, total: 0 };
  updMsg('');
  renderUpdate(updState);
  try {
    const r = await window.sagitari.updateDownload();
    if (!r || r.ok === false) {
      updState.status = updState.ready ? 'ready' : 'idle';
      updState.progress = null;
      renderUpdate(updState);
      updMsg('No se pudo descargar: ' + ((r && r.error) || 'error desconocido'));
      return;
    }
    updState.ready = { name: r.name, version: r.version, verified: r.verified };
    updState.kind = r.kind || updState.kind;
    updState.status = 'ready';
    updState.progress = null;
    renderUpdate(updState);
  } catch (e) {
    updState.status = updState.ready ? 'ready' : 'idle';
    updState.progress = null;
    renderUpdate(updState);
    updMsg('No se pudo descargar: ' + ((e && e.message) || 'error desconocido'));
  }
};

if ($('#updInstallBtn')) $('#updInstallBtn').onclick = async () => {
  const btn = $('#updInstallBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await window.sagitari.updateInstall();
    if (!r || r.ok === false) { updMsg('No se pudo instalar: ' + ((r && r.error) || 'error desconocido')); return; }
    updMsg(r.manual
      ? 'Archivo listo: ejecútalo desde la carpeta que se acaba de abrir.'
      : 'Instalando… la app se cerrará para instalarse.');
  } catch (e) {
    updMsg('No se pudo instalar: ' + ((e && e.message) || 'error desconocido'));
  } finally {
    btn.disabled = false;   // si la instalación arranca, la app se cierra antes de llegar aquí
  }
};

if ($('#updPageBtn')) $('#updPageBtn').onclick = async () => {
  const r = await window.sagitari.updatePage();
  if (r && r.ok === false) updMsg('No se pudo abrir la página: ' + (r.error || 'error desconocido'));
};
if ($('#aboutRelBtn')) $('#aboutRelBtn').onclick = () => window.sagitari.updatePage();
if ($('#aboutRepoBtn')) $('#aboutRepoBtn').onclick = () => window.sagitari.openExternal('https://github.com/dario90vlc/sagitari');

/* Eventos del motor. El aviso es discreto: un punto en Ajustes y UN solo toast
   (nada de modales ni de descargas automáticas). */
if (window.sagitari.onUpdate) window.sagitari.onUpdate((ev) => {
  if (!ev || !ev.type) return;
  if (ev.type === 'available') {
    if (ev.current) updState.current = ev.current;   // la tarjeta ya sabe qué tienes instalado
    updState.latest = ev.version || updState.latest;
    updState.available = true;
    if (updState.status !== 'downloading') updState.status = updState.ready ? 'ready' : 'idle';
    setBadge('#nbUpdate', 1, { hot: true });
    if (!updNotified) {
      updNotified = true;
      showToast('Nueva versión ' + (ev.version || '') + ' disponible · Ajustes → Acerca de');
    }
    renderUpdate(updState);
    return;
  }
  if (ev.type === 'up-to-date') {
    updState.available = false;
    updState.latest = ev.version || updState.latest;
    updState.status = updState.ready ? 'ready' : 'idle';
    renderUpdate(updState);
    return;
  }
  if (ev.type === 'progress') {
    updState.status = 'downloading';
    updState.progress = { pct: ev.pct, received: ev.received, total: ev.total };
    renderUpdate(updState);
    return;
  }
  if (ev.type === 'downloaded') {
    updState.ready = { name: ev.name, version: ev.version, verified: ev.verified, signed: ev.signed, signer: ev.signer };
    updState.status = 'ready';
    updState.progress = null;
    renderUpdate(updState);
    return;
  }
  if (ev.type === 'error') {
    const descargando = updState.status === 'downloading';
    updState.progress = null;
    updState.status = updState.ready ? 'ready' : 'idle';
    if (descargando) updMsg('No se pudo descargar: ' + (ev.message || 'error desconocido'));
    else updState.error = ev.message || 'error desconocido';
    renderUpdate(updState);
  }
});

/** Interruptores: teclado + estado ARIA, sin tocar sus handlers ya definidos. */
function polishSwitches() {
  $$('.sw').forEach(sw => {
    if (sw.dataset.polished) return;
    sw.dataset.polished = '1';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('tabindex', '0');
    sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
    sw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sw.click(); }
    });
    new MutationObserver(() => sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false'))
      .observe(sw, { attributes: true, attributeFilter: ['class'] });
  });
}
polishSwitches();

// ============ conversation history ============
let convTitle = 'Nueva conversación';
function setChatTitle(t) {
  convTitle = t || 'Nueva conversación';
  const h = $('#chatTitle');
  h.textContent = convTitle;
  const root = $('#chatRootTitle');   // el h1 (oculto) de la vista mantiene la raíz del documento
  if (root) root.textContent = convTitle;
  h.title = convTitle;   // se trunca con ellipsis: la pista completa va en el title
  // sincroniza el título con la conversación real en el historial
  if (t) {
    // fire-and-forget: si el IPC rechaza, el fallo se avisa aquí en vez de
    // acabar como promesa sin manejar (burbuja roja en el chat)
    try {
      const p = window.sagitari.convRename && window.sagitari.convRename(t);
      if (p && p.catch) p.catch(() => showToast('No se pudo guardar el nombre de la conversación'));
    } catch { showToast('No se pudo guardar el nombre de la conversación'); }
  }
}

async function renderHistory() {
  const box = $('#histList');
  if (!box) return;
  let list = [], err = null;
  try { list = (await window.sagitari.convList()) || []; } catch (e) { err = e; }
  box.innerHTML = '';
  // una lista vacía por un IPC caído no es «no hay conversaciones»: se dice el error
  if (err) { box.innerHTML = `<div class="subnote">No se pudieron cargar las conversaciones: ${esc((err && err.message) || err)}</div>`; return; }
  if (!list.length) { box.innerHTML = '<div class="subnote">Aún no hay conversaciones. Todo lo que hables con Sagitari aparecerá aquí.</div>'; return; }
  for (const c of list) {
    const it = document.createElement('div');
    it.className = 'hitem';
    // fila operable con teclado: era un div con click, invisible para el tabulador
    it.setAttribute('tabindex', '0');
    // sin role=button: la fila CONTIENE un botón (eliminar) y un solo rol
    // anunciaría un botón que en realidad tiene dos acciones
    it.setAttribute('aria-label', 'Abrir la conversación «' + c.title + '»');
    it.title = c.title;
    const d = new Date(c.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    it.innerHTML = `<div class="hic">${ic('chat')}</div>
      <div class="hmain"><b>${esc(c.title)}</b><small>${c.count} mensajes · ${when}</small></div>
      <button class="btn ghost sq danger hdel" title="Eliminar">${ic('trash')}</button>`;
    it.addEventListener('click', (ev) => {
      if (ev.target.closest('.hdel')) return;
      openConversation(c.id);
    });
    it.addEventListener('keydown', (ev) => {
      if (ev.target !== it || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      it.click();
    });
    it.querySelector('.hdel').onclick = async (ev) => {
      ev.stopPropagation();
      if (!(await askConfirm(it, '¿Eliminar la conversación «' + c.title + '»?', 'Se borrará el hilo completo y sus mensajes.'))) return;
      await window.sagitari.convDel(c.id);
      renderHistory();
    };
    box.appendChild(it);
  }
}

async function openConversation(id) {
  // cambiar de hilo con una ejecución en curso desviaría la respuesta (y su
  // guardado) a la conversación equivocada
  if (busy) { showToast('Detén o espera la ejecución en curso para cambiar de conversación'); return; }
  const r = await window.sagitari.convOpen(id);
  if (!r.ok) { showToast('No se pudo abrir la conversación'); return; }
  resetChatView(r.messages);
  setChatTitle((r.messages.find(m => m.role === 'user') || {}).content || 'Nueva conversación');
  goto('chat');
  feed('Conversación restaurada', 'blu');
}

/** Vuelve el chat a cero y, si hay historial, lo pinta con su modo por turno. */
function resetChatView(messages) {
  // última barrera: ningún camino puede vaciar el hilo mientras el agente trabaja
  if (busy) { showToast('Detén o espera la ejecución en curso para cambiar de conversación'); return false; }
  cancelStreamRender();
  msgs.innerHTML = '';
  pendingAssistant = null; pendingTurn = null;
  lastAssistantEl = null; lastTurnSummary = '';
  setChatStatus('');
  const list = messages || [];
  if (!list.length) { showEmpty(); pinned = true; scroll(true); return; }
  hideEmpty();
  dayStamp();
  for (const m of list) {
    const b = bubble(m.role, { mode: m.mode, ts: m.ts });
    // el contenido guardado lleva el texto de los adjuntos incrustado: lo
    // escondemos de la burbuja y enseñamos solo las miniaturas/nombres
    let html = (typeof m.content === 'string') ? m.content : '';
    if (m.attachments && m.attachments.length) {
      html = html.replace(/He adjuntado archivos para que los uses en tu respuesta:\n\n[\s\S]*$/, '').trim();
    }
    b.innerHTML = fmt(html || '');
    if (m.attachments && m.attachments.length) paintAttachments(b, m.attachments);
    if (m.role === 'assistant') {
      msgActions(b.closest('.msg-body') || b, m.content, { speak: true });
      lastAssistantEl = b;
    }
  }
  refreshMsgActions();
  pinned = true;
  scroll(true);
}

async function newConversation() {
  // no se crea un hilo nuevo con una ejecución en curso: la respuesta acabaría
  // en el hilo nuevo y el original quedaría sin ella
  if (busy) { showToast('Detén o espera la ejecución en curso para empezar una conversación nueva'); return; }
  await window.sagitari.convNew();
  resetChatView([]);
  setChatTitle('Nueva conversación');
  goto('chat');
  $('#chatInput').focus();
}
$('#btnClear').onclick = newConversation;
$('#histNew').onclick = newConversation;
$('#btnGoHistory').onclick = () => goto('history');

// copiar la conversación completa, de un vistazo, al portapapeles
$('#btnCopyConv').onclick = () => {
  const parts = [];
  msgs.querySelectorAll('.msg').forEach(m => {
    const who = m.classList.contains('me') ? (CFG.settings.userName || 'Tú') : 'Sagitari';
    const badge = m.querySelector('.msg-mode');
    const t = m.querySelector('.bubble');
    if (t) parts.push(`## ${who}${badge ? ' · ' + badge.textContent.trim() : ''}\n${t.innerText.trim()}`);
  });
  copyText(parts.join('\n\n'), 'Conversación copiada');
};

// ============ mode switcher: segmented en chat + pill en inicio + Alt+M ============
// Los tres modos comparten definición con el backend vía ChatKit (una sola
// fuente de verdad): etiqueta, color, icono, lema y en qué se diferencian.
const MODE_META = Object.fromEntries(K.MODE_ORDER.map(k => {
  const m = K.MODES[k];
  return [k, { dot: m.dot, label: m.label, desc: m.tagline, icon: m.icon, name: m.name, rgb: m.rgb }];
}));
const MODE_ORDER = K.MODE_ORDER;
async function setMode(m) {
  if (m === mode) return;
  mode = await window.sagitari.setMode(m);
  updateModeUI();
  const M = K.mode(mode);
  showToast('Modo ' + M.label + ' — ' + M.tagline);
}
function renderModeSeg() {
  // el MISMO segmento vive en el chat y en la home: idéntico aspecto y comportamiento
  for (const seg of [$('#modeSeg'), $('#modeSegHome')]) {
    if (!seg) continue;
    seg.innerHTML = MODE_ORDER.map(k => {
      const M = K.MODES[k];
      return `<button data-m="${k}" class="${k === mode ? 'on ' + k : ''}" title="${esc(M.name)} — ${esc(M.tagline)}" aria-pressed="${k === mode}">${ic(M.icon)}<span>${M.label}</span></button>`;
    }).join('');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => setMode(b.dataset.m));
  }
}

/** Tarjetas de modo del estado vacío: explican y permiten cambiar con un clic. */
function renderEmptyModes() {
  const box = $('#ceModes');
  if (!box) return;
  box.innerHTML = MODE_ORDER.map(k => {
    const M = K.MODES[k];
    return `<button class="ce-mode${k === mode ? ' on' : ''}" style="--mr:${M.rgb}" data-m="${k}" aria-pressed="${k === mode}">
      <span class="cm-top">${ic(M.icon)}<b>${M.name.toUpperCase()}</b></span>
      <span class="cm-tag">${esc(M.label)} · ${esc(M.tagline)}</span>
      <ul class="cm-bullets">${M.bullets.slice(0, 1).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => setMode(b.dataset.m));
}
function updateModeUI() {
  const m = MODE_META[mode] || MODE_META.act;
  const M = K.mode(mode);
  $('#modeLabel').innerHTML = `Modo <b>${m.label}</b> — ${esc(M.tagline)} <span class="hint-key">Alt+M</span>`;
  applyModeTheme(busy ? currentRunMode : mode);
  renderModeSeg();
  renderEmptyModes();
  setSideActive();
}
window.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    // escribiendo en un campo, Alt+M es del campo (no cambia el modo)
    if (esCampoDeTexto(e.target)) return;
    e.preventDefault();
    setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]);
  }
});

// ============ memory view ============
async function renderMemory() {
  const box = $('#memList');
  if (!box) return;
  let list = [], err = null;
  try { list = (await window.sagitari.memoryList()) || []; } catch (e) { err = e; }
  box.innerHTML = '';
  // sin datos y «IPC caído» no pueden verse igual
  if (err) { box.innerHTML = `<div class="subnote">No se pudo leer la memoria: ${esc((err && err.message) || err)}</div>`; return; }
  if (!list.length) { box.innerHTML = '<div class="subnote">Sin recuerdos aún. Añade uno arriba o pídele a Sagitari que recuerde algo.</div>'; return; }
  for (const m of list) {
    const it = document.createElement('div');
    it.className = 'memitem';
    const imp = Math.round((m.importance ?? 0.5) * 100);
    it.innerHTML = `<span class="mt">${esc(m.text)}<br><small class="md">importancia ${imp}% · confianza ${Math.round((m.confidence ?? 0.8) * 100)}% · usos ${m.uses || 0} · ${new Date(m.date).toLocaleDateString('es')}</small></span>
      <input type="range" min="0" max="100" value="${imp}" data-imp title="Importancia" style="width:90px" />
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    it.querySelector('[data-imp]').onchange = async (e) => {
      await window.sagitari.memoryUpdate(m.id, { importance: Number(e.target.value) / 100 });
      showToast('Importancia actualizada');
    };
    it.querySelector('[data-del]').onclick = async () => {
      if (!(await askConfirm(it, '¿Olvidar este recuerdo?', String(m.text || '').slice(0, 200)))) return;
      await window.sagitari.memoryRemove(m.id);
      renderMemory();
    };
    box.appendChild(it);
  }
}
$('#memAdd').onclick = async () => {
  const btn = $('#memAdd');
  if (btn.disabled) return;               // evita el doble envío mientras dura el IPC
  const t = $('#memInput').value.trim();
  if (!t) return;
  btn.disabled = true;
  try {
    await window.sagitari.memoryAdd(t);
    $('#memInput').value = '';
    await renderMemory();
  } catch (e) { showToast('No se pudo añadir: ' + ((e && e.message) || e)); }
  finally { btn.disabled = false; }
};

// ============ v1.2: relevancia de memoria (Ajustes) ============
async function fillMemorySens() {
  const el = $('#memSens');
  if (!el) return;
  try { el.value = CFG.settings.memSensitivity ?? 2; } catch {}
  el.onchange = async () => {
    const v = Math.max(0, Math.min(3, Number(el.value) || 0));
    el.value = v;
    await window.sagitari.setSettings({ memSensitivity: v });
    showToast('Sensibilidad de memoria: ' + v);
  };
}
// se llama desde init(), después de fillSettings() (antes CFG.settings iba vacío)

// ============ skills view ============
async function renderSkills() {
  const box = $('#skillsList');
  if (!box) return;
  let list = [], err = null;
  try { list = (await window.sagitari.skillsList()) || []; } catch (e) { err = e; }
  box.innerHTML = '';
  if (err) { box.innerHTML = `<div class="subnote">No se pudieron cargar las skills: ${esc((err && err.message) || err)}</div>`; return; }
  if (!list.length) { box.innerHTML = '<div class="subnote">No hay skills instaladas todavía.</div>'; return; }
  for (const s of list) {
    const it = document.createElement('div');
    it.className = 'memitem skillitem' + (s.enabled ? '' : ' off');
    it.innerHTML = `
      <span class="tc-mark">${ic('zap')}</span>
      <span class="mt"><b>${esc(s.name)}</b>${s.version ? ` <span class="md">v${esc(s.version)}</span>` : ''}${s.category ? ` <span class="md">· ${esc(s.category)}</span>` : ''}<br><small class="md">${esc(s.description)}</small>${s.author ? `<br><small class="md">por ${esc(s.author)}${s.allowTools ? ' · herramientas: ' + esc(s.allowTools) : ''}${s.dependencies && s.dependencies.length ? ' · deps: ' + esc(s.dependencies.join(', ')) : ''}</small>` : (s.allowTools ? `<br><small class="md">herramientas: ${esc(s.allowTools)}</small>` : '')}${s.source ? `<br><small class="md">de ${esc(s.source.repo)}</small>` : ''}</span>
      <span class="md">~${Math.ceil(s.bodyChars / 4)} tok</span>
      ${s.source ? `<button class="btn ghost sq" data-update title="Actualizar desde su repo">${ic('history')}</button>` : ''}
      <button class="btn ghost sq" data-view title="Ver skill">${ic('search')}</button>
      <label class="sw ${s.enabled ? 'on' : ''}" data-sw title="Activar/desactivar" aria-label="Activar o desactivar ${esc(s.name)}"></label>
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    it.querySelector('[data-sw]').onclick = async (e) => { await window.sagitari.skillsToggle(s.id, !s.enabled); renderSkills(); };
    it.querySelector('[data-del]').onclick = async () => {
      if (!(await askConfirm(it, '¿Eliminar la skill «' + s.name + '»?', 'Se borra su carpeta y no se puede deshacer.'))) return;
      await window.sagitari.skillsDelete(s.id);
      renderSkills();
    };
    const ub = it.querySelector('[data-update]');
    if (ub) ub.onclick = async (e) => {
      e.stopPropagation();
      ub.disabled = true;
      try { const r = await window.sagitari.skillsUpdate(s.id); showToast(r.changed ? 'Skill actualizada' : 'Ya estaba actualizada'); }
      catch (err) { showToast('Error: ' + (err.message || err)); }
      renderSkills();
    };
    it.querySelector('[data-view]').onclick = async () => {
      const full = await window.sagitari.skillsRead(s.id);
      if (full) showToast(full.name + ': ' + full.description);
    };
    box.appendChild(it);
  }
}
$('#skillImportBtn').onclick = async () => {
  const btn = $('#skillImportBtn');
  if (btn.disabled) return;
  const inp = $('#skillImportInput'), msg = $('#skillMsg');
  const repo = inp.value.trim();
  if (!repo) { msg.textContent = 'Escribe owner/repo (ej. anthropics/skills).'; return; }
  msg.textContent = 'Importando desde ' + repo + '…';
  btn.disabled = true;
  try {
    const inst = await window.sagitari.skillsImport(repo);
    msg.textContent = importSummary(inst);
    inp.value = '';
    renderSkills();
  } catch (err) { msg.textContent = 'Error: ' + (err.message || err); }
  finally { btn.disabled = false; }
};
$('#skillsFolderBtn').onclick = async () => {
  try { await window.sagitari.skillsOpenFolder(); }
  catch (e) { showToast('No se pudo abrir la carpeta de skills: ' + ((e && e.message) || e)); }
};
$('#skillCreateBtn').onclick = async () => {
  const btn = $('#skillCreateBtn');
  if (btn.disabled) return;
  const msg = $('#skillMsg');
  const name = $('#skillNewName').value.trim(), desc = $('#skillNewDesc').value.trim(), body = $('#skillNewBody').value.trim();
  if (!name || !desc) { msg.textContent = 'Nombre y descripción son obligatorios.'; return; }
  btn.disabled = true;
  try {
    await window.sagitari.skillsCreate({ name, description: desc, body });
    $('#skillNewName').value = $('#skillNewDesc').value = $('#skillNewBody').value = '';
    msg.textContent = 'Skill "' + name + '" creada.';
    renderSkills();
  } catch (err) { msg.textContent = 'Error: ' + (err.message || err); }
  finally { btn.disabled = false; }
};

// ============ tools view ============
const TOOL_INFO = [
  ['run_command', 'terminal', 'Terminal de Windows: comandos, scripts, git…'],
  ['read_file', 'file', 'Leer archivos de texto'],
  ['write_file', 'doc', 'Crear o sobrescribir archivos'],
  ['list_dir', 'folder', 'Explorar carpetas'],
  ['search_files', 'search', 'Buscar texto dentro de archivos'],
  ['open_app', 'zap', 'Abrir aplicaciones'],
  ['open_url', 'globe', 'Abrir URLs en el navegador'],
  ['browser_control', 'compass', 'Controlar Chrome y Edge: clic, escribir, leer, capturar'],
  ['screenshot', 'camera', 'Capturar y analizar la pantalla'],
  ['clipboard', 'clipboard', 'Leer y escribir el portapapeles'],
  ['notify', 'bell', 'Notificaciones nativas de Windows'],
  ['media_control', 'music', 'Reproducir, pausar, volumen'],
  ['window_manage', 'window', 'Minimizar todo, mostrar escritorio'],
  ['system_info', 'monitor', 'CPU, RAM, red y tiempo encendido']
];
/* El catálogo se agrupa por lo que de verdad decide el usuario: qué herramientas
   piden permiso. Antes eran 14 tarjetas idénticas donde ese dato no aparecía. */
const TOOL_GROUPS = [
  { key: 'confirmar', titulo: 'Piden tu permiso antes de actuar' },
  { key: 'safe', titulo: 'Se ejecutan sin preguntar' },
  { key: 'restricted', titulo: 'Bloqueadas' },
];
async function renderTools() {
  const g = $('#toolsGrid');
  if (!g) return;
  let rec = {};
  try { const m = await window.sagitari.metaGet(); rec = (m && m.riskDefaults) || {}; } catch {}
  const grupoDe = (n) => (rec[n] === 'restricted' || rec[n] === 'safe') ? rec[n] : 'confirmar';
  g.innerHTML = '';
  for (const gr of TOOL_GROUPS) {
    const items = TOOL_INFO.filter(([n]) => grupoDe(n) === gr.key);
    if (!items.length) continue;
    const h = document.createElement('div');
    h.className = 'toolsgroup';
    h.textContent = gr.titulo + ' · ' + items.length;
    g.appendChild(h);
    for (const [n, i, d] of items) {
      const c = document.createElement('div');
      c.className = 'toolcard';
      c.innerHTML = `<div class="tic">${ic(i)}</div><div><b>${esc(K.tool(n).label)}</b> <small class="md">${esc(n)}</small><br><small>${d}</small></div>`;
      g.appendChild(c);
    }
  }
  // ---- v3.1: herramientas MCP reales del usuario (no están en el catálogo nativo) ----
  // Con el interruptor global apagado el modelo NO recibe ninguna herramienta MCP (main no
  // ofrece el catálogo dinámico): pintarlas aquí diría que el agente puede usarlas.
  let mcp = { servers: [] };
  try { mcp = await window.sagitari.mcpList(); } catch {}
  const conHerramientas = mcp.enabled === false ? [] : (mcp.servers || []).filter(s => s.enabled && (s.discovered || []).length);
  if (conHerramientas.length) {
    const total = conHerramientas.reduce((n, s) => n + s.discovered.length, 0);
    const h = document.createElement('div');
    h.className = 'toolsgroup';
    h.textContent = 'Servidores MCP · ' + total;
    g.appendChild(h);
    for (const s of conHerramientas) {
      for (const t of s.discovered) {
        const c = document.createElement('div');
        c.className = 'toolcard';
        c.innerHTML = `<div class="tic">${ic('bolt')}</div><div><b>${esc(t.tool)}</b> <small class="md">${esc(s.name)}</small><br><small>${esc(t.description || '')}</small></div>`;
        g.appendChild(c);
      }
    }
  }
}

// ============ v1.2: tasks view (puntos de control, pausa, reanudación) ============
const TASK_STATUS = {
  pending:     { label: 'En cola', cls: 'blu' },
  scheduled:   { label: 'Programada', cls: 'blu' },
  running:     { label: 'En curso', cls: 'cy' },
  paused:      { label: 'Pausada', cls: 'pur' },
  interrupted: { label: 'Interrumpida — recuperable', cls: 'pur' },
  failed:      { label: 'Falló', cls: 'mag' },
  completed:   { label: 'Completada', cls: 'ok' },
  cancelled:   { label: 'Cancelada', cls: 'mag' },
};
async function renderTasks() {
  const box = $('#tasksList');
  if (!box) return;
  let list = [], err = null;
  try { list = (await window.sagitari.tasksList()) || []; } catch (e) { err = e; }
  box.innerHTML = '';
  if (err) { box.innerHTML = `<div class="subnote">No se pudieron cargar las tareas: ${esc((err && err.message) || err)}</div>`; return; }
  if (!list.length) { box.innerHTML = '<div class="subnote">Aún no hay tareas. Lanza una arriba o espera a que el chat cree puntos de control automáticamente.</div>'; return; }
  for (const t of list) {
    const st = TASK_STATUS[t.status] || TASK_STATUS.completed;
    const it = document.createElement('div');
    it.className = 'hitem';
    const d = new Date(t.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const err = t.lastError ? `<small class="md" style="color:var(--danger)">✗ ${esc(t.lastError.step || '')}${t.lastError.tool ? ' · ' + esc(t.lastError.tool) : ''}: ${esc(String(t.lastError.message).slice(0, 120))}</small><br>` : '';
    const live = t.live ? `<small class="md">${t.live.toolCalls || 0} herramientas · ${(t.live.tokensIn || 0) + (t.live.tokensOut || 0)} tok${t.live.costUsd ? ' · $' + t.live.costUsd.toFixed(4) : ''}${t.live.toolsFired && t.live.toolsFired.length ? ' · última: ' + esc(t.live.toolsFired[t.live.toolsFired.length - 1].name) : ''}</small><br>` : '';
    const sched = t.status === 'scheduled' && t.scheduledAt ? `<small class="md">→ ${new Date(t.scheduledAt).toLocaleString('es')}</small><br>` : '';
    // fila operable con teclado; el borrado no se ofrece mientras la tarea corre
    it.setAttribute('tabindex', '0');
    // sin role=button: la fila lleva botones propios (pausar, reanudar, borrar…)
    it.setAttribute('aria-label', 'Tarea: ' + (t.goal || 'sin objetivo') + ' — ' + st.label);
    it.title = t.goal || '(sin objetivo)';
    it.innerHTML = `<div class="hic">${ic('history')}</div>
      <div class="hmain"><b>${esc(t.goal || '(sin objetivo)')}</b>
        <small><span class="dot ${st.cls}"></span> ${st.label} · paso ${esc(t.step || '—')} · ${t.steps || 0} pasos · ${when}</small><br>
        ${sched}${live}${err}
        ${t.result ? `<small class="md">${esc(String(t.result).slice(0, 140))}</small>` : ''}
      </div>
      ${(t.status === 'running') ? `<button class="btn ghost sq" data-pause title="Pausar">${ic('pause')}</button>` : ''}
      ${(t.status === 'paused' || t.status === 'interrupted' || t.status === 'failed' || t.status === 'pending') ? `<button class="btn primary sq" data-resume title="Reanudar">${ic('zap')}</button>` : ''}
      ${(t.status === 'scheduled') ? `<button class="btn primary sq" data-runnow title="Ejecutar ahora">${ic('zap')}</button>` : ''}
      ${!['completed', 'failed', 'cancelled'].includes(t.status) ? `<button class="btn ghost sq danger" data-cancel title="Cancelar">${ic('close')}</button>` : ''}
      ${t.status === 'running' ? '' : `<button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`}`;
    it.addEventListener('keydown', (ev) => {
      if (ev.target !== it || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      // Enter/Space actúa como el clic en la fila: dispara su botón principal
      const main = it.querySelector('button:not([data-del])');
      if (main) main.click();
    });
    const rb = it.querySelector('[data-resume]');
    if (rb) rb.onclick = async (ev) => {
      ev.stopPropagation();
      if (rb.disabled) return;
      rb.disabled = true;
      try {
        const r = await window.sagitari.taskResume(t.runId);
        if (r && r.ok === false) { showToast(r.error || 'No se pudo reanudar'); rb.disabled = false; }
      } catch (e) { showToast('No se pudo reanudar: ' + ((e && e.message) || e)); rb.disabled = false; }
      renderTasks();
    };
    const pb = it.querySelector('[data-pause]');
    if (pb) pb.onclick = async (ev) => {
      ev.stopPropagation();
      if (pb.disabled) return;
      pb.disabled = true;
      try { await window.sagitari.taskPause(t.runId); }
      catch (e) { showToast('No se pudo pausar: ' + ((e && e.message) || e)); pb.disabled = false; }
      renderTasks();
    };
    const sb = it.querySelector('[data-runnow]');
    if (sb) sb.onclick = async (ev) => {
      ev.stopPropagation();
      if (sb.disabled) return;
      sb.disabled = true;
      try { await window.sagitari.taskResume(t.runId); }
      catch (e) { showToast('No se pudo ejecutar: ' + ((e && e.message) || e)); sb.disabled = false; }
      renderTasks();
    };
    const cb = it.querySelector('[data-cancel]');
    if (cb) cb.onclick = async (ev) => {
      ev.stopPropagation();
      if (!(await askConfirm(it, '¿Cancelar esta tarea?', String(t.goal || '').slice(0, 160)))) return;
      cb.disabled = true;
      await window.sagitari.taskCancel(t.runId);
      renderTasks();
    };
    const db = it.querySelector('[data-del]');
    if (db) db.onclick = async (ev) => {
      ev.stopPropagation();
      if (!(await askConfirm(it, '¿Eliminar esta tarea del historial?', String(t.goal || '').slice(0, 160)))) return;
      await window.sagitari.taskRemove(t.runId);
      renderTasks();
    };
    box.appendChild(it);
  }
}
$('#tasksRefresh').onclick = () => renderTasks();

// v1.3: crear y programar tareas en background
$('#taskCreate').onclick = async () => {
  const btn = $('#taskCreate');
  if (btn.disabled) return;
  const goal = $('#taskGoal').value.trim();
  const msg = $('#taskMsg');
  if (!goal) { msg.textContent = 'Escribe el objetivo de la tarea.'; return; }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: null });
    if (r && r.ok) {
      msg.textContent = 'Tarea en cola (' + r.runId + ').';
      $('#taskGoal').value = '';
      feed('Tarea lanzada en segundo plano', 'blu');
      renderTasks();
    } else msg.textContent = (r && r.error) || 'No se pudo crear la tarea.';
  } catch (e) { msg.textContent = 'Error: ' + ((e && e.message) || e); }
  finally { btn.disabled = false; }
  setTimeout(() => { msg.textContent = ''; }, 4000);
};
$('#taskSchedule').onclick = async () => {
  const btn = $('#taskSchedule');
  if (btn.disabled) return;
  const goal = $('#taskGoal').value.trim();
  const when = $('#taskWhen').value;
  const msg = $('#taskMsg');
  if (!goal) { msg.textContent = 'Escribe el objetivo de la tarea.'; return; }
  if (!when) { msg.textContent = 'Elige fecha y hora.'; return; }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: new Date(when).toISOString() });
    if (r && r.ok) {
      msg.textContent = 'Tarea programada para ' + new Date(when).toLocaleString('es');
      $('#taskGoal').value = ''; $('#taskWhen').value = '';
      renderTasks();
    } else msg.textContent = (r && r.error) || 'No se pudo programar.';
  } catch (e) { msg.textContent = 'Error: ' + ((e && e.message) || e); }
  finally { btn.disabled = false; }
  setTimeout(() => { msg.textContent = ''; }, 4000);
};
$('#chatPause').onclick = async () => {
  const r = await window.sagitari.pauseChat();
  if (r && r.ok === false) showToast(r.error || 'No se pudo pausar la tarea');
};

// ============ projects ============
$('#projOpen').onclick = async () => {
  const btn = $('#projOpen');
  btn.disabled = true;
  $('#projMsg').textContent = 'Abriendo…';
  try {
    const r = await window.sagitari.openPath($('#projPath').value);
    if (r && r.ok) {
      $('#projMsg').textContent = 'Espacio de trabajo activo: ' + (r.workspace || r.path);
      $('#wsPath').value = r.workspace || r.path;
      feed('Espacio de trabajo: ' + (r.workspace || r.path), 'ok');
    } else {
      $('#projMsg').textContent = (r && r.error) || 'No se pudo abrir la ruta.';
    }
  } catch (e) {
    $('#projMsg').textContent = (e && e.message) || 'No se pudo abrir la ruta.';
  } finally {
    btn.disabled = false;
    setTimeout(() => { $('#projMsg').textContent = ''; }, 4000);
  }
};
$('#projPick').onclick = async () => {
  const r = await window.sagitari.pickFolder();
  if (r && r.path) {
    const s = await window.sagitari.workspaceSet(r.path);
    if (s && s.ok) {
      $('#projPath').value = s.path;
      $('#wsPath').value = s.path;
      $('#projMsg').textContent = 'Espacio de trabajo activo: ' + s.path;
      feed('Espacio de trabajo: ' + s.path, 'ok');
    } else $('#projMsg').textContent = (s && s.error) || 'No se pudo fijar la carpeta.';
    setTimeout(() => { $('#projMsg').textContent = ''; }, 4000);
  }
};

// ============ misc ============
function speak(text) {
  if (!CFG.settings.ttsEnabled || !text) return;
  const clean = text.replace(/```[\s\S]*?```/g, ' (código) ').replace(/[*_`#>«»]/g, '').replace(/\s+/g, ' ').trim();
  if (clean) {
    window.sagitari.glow('speak');            // el marco late mientras habla
    window.sagitari.speak(clean);
  }
}
// cuando la voz termina (el proceso TTS sale), el glow vuelve a su calma
window.sagitari.onTtsDone && window.sagitari.onTtsDone(() => glowOffSoon());
function showToast(text) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  // aviso no bloqueante: el lector de pantalla lo anuncia sin robar el foco
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<span class="dot pur"></span>${esc(text)}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
/** Texto del pie: qué modelo está en uso y de qué proveedor. Sin estados: la
    píldora enseña la selección y abre la lista para cambiarla. */
function updateStatusLabels() {
  const a = CFG.active;
  $('#stModel').textContent = a ? a.model : 'sin modelo';
  $('#stProv').textContent = a ? (a.name || 'proveedor') : 'configura tu API';
  $('#sideStatusBtn').title = a
    ? `Modelo: ${a.model} — pulsa para cambiar entre los modelos de tu API`
    : 'Configura un proveedor y un modelo';
  $('#chatModelLabel').textContent = a ? a.name + ' · ' + a.model : '';
  // tarjeta de estado de Ajustes
  const name = $('#activeModelName');
  if (!name) return;
  const meta = $('#activeModelMeta'), badge = $('#activeModelBadge');
  if (!a) {
    name.textContent = 'Sin modelo activo';
    meta.textContent = 'Elige un proveedor y activa un modelo para empezar.';
    badge.textContent = 'sin activar';
    badge.classList.add('off');
    return;
  }
  name.textContent = a.model;
  const bits = [a.name || 'Proveedor'];
  try { bits.push(new URL(a.baseUrl).host); } catch {}
  if (a.format && a.format !== 'auto') bits.push('formato: ' + a.format);
  if (a.vision) bits.push('visión');
  meta.textContent = bits.join(' · ');
  badge.textContent = 'activo';
  badge.classList.remove('off');
  // si la lista está abierta (p. ej. acabas de activar algo en Ajustes), se repinta
  const mm = document.getElementById('modelMenu');
  if (mm && !mm.hidden) { mm.hidden = true; openModelMenu(); }
}

/* ---- desplegables con el estilo de la app ----
   El popup de un <select> lo dibuja el sistema operativo (claro, con su tipografía)
   y no se puede tematizar desde CSS: por eso los desplegables de la app se veían
   fuera de estilo. Cada select lleva encima un control propio, con el mismo lenguaje
   que los menús de skills y modelos, y el select nativo queda debajo como fuente de
   verdad: `.value`/`.options` y el evento `change` siguen siendo suyos, así que el
   resto del código no cambia de contrato. */
let cselAbierto = null;

function cselEtiqueta(sel) {
  const o = sel.selectedOptions && sel.selectedOptions[0];
  return o ? o.textContent.trim() : '';
}

/** Refresca la etiqueta y el estado del botón de un select ya mejorado. */
function cselPintar(sel) {
  const caja = sel.closest('.csel');
  if (!caja) return;
  const btn = caja.querySelector('.csel-btn');
  const et = cselEtiqueta(sel);
  btn.querySelector('.csel-label').textContent = et || '—';
  btn.disabled = !!sel.disabled;
  const lab = sel.id && document.querySelector('label[for="' + sel.id + '"]');
  const nombre = (lab && lab.textContent.trim()) || sel.getAttribute('aria-label') || 'Desplegable';
  btn.setAttribute('aria-label', nombre + ': ' + (et || 'sin selección'));
}

function cselCerrar() {
  if (!cselAbierto) return;
  const { sel, menu } = cselAbierto;
  menu.hidden = true;
  const btn = sel.closest('.csel').querySelector('.csel-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  cselAbierto = null;
}

/** Abre la lista: filas con el mismo aspecto que el resto de menús de la app. */
function cselAbrir(sel) {
  cselCerrar();
  const caja = sel.closest('.csel');
  if (!caja) return;
  const menu = caja.querySelector('.csel-menu');
  const actual = sel.value;
  menu.innerHTML = [...sel.options].map(o => {
    const on = o.value === actual && !o.disabled;
    const datos = o.disabled ? '' : ` data-v="${esc(o.value)}"`;
    return `<div class="sm-item${on ? ' on' : ''}" role="option" aria-selected="${on}"${datos}>`
      + `<span class="sm-name">${esc(o.textContent.trim())}</span>${on ? '<span class="mm-mark" aria-hidden="true">✓</span>' : ''}</div>`;
  }).join('') || '<div class="mm-hint">Sin opciones.</div>';
  // Coordenadas propias: el menú es position:fixed, así que escapa del overflow del
  // contenedor (antes .main lo recortaba). Se mide con la lista ya pintada, se ancla
  // al botón, se voltea hacia arriba si abajo no cabe y se mantiene dentro de la vista.
  const r = caja.getBoundingClientRect();
  const alto = Math.min(300, menu.scrollHeight || 300);
  menu.style.width = Math.round(r.width) + 'px';
  const cabeAbajo = window.innerHeight - r.bottom - 8 >= Math.min(alto, 200);
  const arriba = !cabeAbajo && r.top > alto;
  const top = arriba ? r.top - alto - 6 : r.bottom + 6;
  menu.style.left = Math.round(Math.max(8, Math.min(r.left - 2, window.innerWidth - r.width - 6))) + 'px';
  menu.style.top = Math.round(Math.max(8, Math.min(top, window.innerHeight - 12))) + 'px';
  menu.hidden = false;
  const ya = menu.querySelector('.sm-item.on');
  if (ya) ya.scrollIntoView({ block: 'nearest' });
  caja.querySelector('.csel-btn').setAttribute('aria-expanded', 'true');
  cselAbierto = { sel, menu };
}

/** Elige una opción: escribe en el select nativo y dispara `change`. */
function cselElegir(sel, valor) {
  if (sel.value !== valor) {
    sel.value = valor;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  cselPintar(sel);
  cselCerrar();
}

/** Convierte un <select> en desplegable propio (idempotente). */
function mejoraSelect(sel) {
  if (sel.dataset.csel) return;
  sel.dataset.csel = '1';
  const caja = document.createElement('div');
  caja.className = 'csel';
  if (sel.id) caja.dataset.cselDe = sel.id;   // gancho estable para las comprobaciones
  if (sel.style.width) { caja.style.width = sel.style.width; sel.style.width = ''; }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="csel-label"></span><span class="ss-caret" aria-hidden="true">▾</span>';
  const menu = document.createElement('div');
  menu.className = 'csel-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  sel.parentNode.insertBefore(caja, sel);
  caja.append(btn, menu, sel);
  sel.classList.add('csel-native');   // oculto: el control visible es el botón

  const resaltar = (n) => {
    const filas = [...menu.querySelectorAll('.sm-item[data-v]')];
    if (!filas.length) return;
    filas.forEach(f => f.classList.remove('hl'));
    const i = ((n % filas.length) + filas.length) % filas.length;
    filas[i].classList.add('hl');
    filas[i].scrollIntoView({ block: 'nearest' });
  };
  const indiceResaltado = () => [...menu.querySelectorAll('.sm-item')].findIndex(f => f.classList.contains('hl'));

  btn.onclick = (e) => {
    e.stopPropagation();
    if (cselAbierto && cselAbierto.sel === sel) cselCerrar();
    else cselAbrir(sel);
  };
  btn.onkeydown = (e) => {
    const abierto = !!(cselAbierto && cselAbierto.sel === sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!abierto) { cselAbrir(sel); resaltar(e.key === 'ArrowDown' ? 0 : -1); }
      else resaltar(indiceResaltado() + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!abierto) return cselAbrir(sel);
      const f = menu.querySelector('.sm-item.hl') || menu.querySelector('.sm-item.on');
      if (f && f.dataset.v !== undefined) cselElegir(sel, f.dataset.v);
      return;
    }
    if (abierto && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); resaltar(e.key === 'Home' ? 0 : -1); return; }
    if (abierto && e.key === 'Escape') { e.preventDefault(); cselCerrar(); return; }
    if (e.key === 'Tab') { cselCerrar(); return; }
    // salto por letra, como hace el select nativo
    if (abierto && e.key.length === 1 && /\S/.test(e.key)) {
      const filas = [...menu.querySelectorAll('.sm-item[data-v]')];
      const desde = indiceResaltado();
      const k = e.key.toLowerCase();
      for (let i = 1; i <= filas.length; i++) {
        const j = (desde + i + filas.length) % filas.length;
        if (filas[j].textContent.trim().toLowerCase().startsWith(k)) { e.preventDefault(); resaltar(j); break; }
      }
    }
  };
  menu.onclick = (e) => {
    const fila = e.target.closest('.sm-item');
    if (fila && fila.dataset.v !== undefined) cselElegir(sel, fila.dataset.v);
  };
  // las opciones pueden llegar después (detectar modelos, presets): el botón se
  // repinta solo y, si está abierto, la lista también
  new MutationObserver(() => {
    cselPintar(sel);
    if (cselAbierto && cselAbierto.sel === sel) cselAbrir(sel);
  }).observe(sel, { childList: true });
  cselPintar(sel);
}

/** Mejora todos los selects de un contenedor (o de la app entera). */
function mejoraSelects(root) {
  (root || document).querySelectorAll('select:not([data-csel])').forEach(mejoraSelect);
}

document.addEventListener('mousedown', (e) => {
  if (!cselAbierto) return;
  const caja = cselAbierto.sel.closest('.csel');
  if (caja && (caja.contains(e.target) || cselAbierto.menu.contains(e.target))) return;
  cselCerrar();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cselCerrar(); });
window.addEventListener('resize', cselCerrar);
// el menú está anclado a un punto: si el contenedor se desplaza, el ancla se queda atrás
window.addEventListener('scroll', cselCerrar, true);
window.addEventListener('blur', cselCerrar);

/* ---- selector de modelo del pie: cambia entre los modelos de tu API ---- */
const modelMenu = $('#modelMenu');

/** Modelos de la vista multimodal conocidos por nombre (los que sí ven imágenes). */
function looksVision(model) {
  return /(gpt-4|gpt-5|4o|vision|llava|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i.test(String(model || ''));
}

function closeModelMenu() {
  if (!modelMenu || modelMenu.hidden) return;
  modelMenu.hidden = true;
  $('#sideStatusBtn').setAttribute('aria-expanded', 'false');
}

/** Pinta la lista de modelos acordes a la API del usuario y la abre. */
function openModelMenu() {
  if (!modelMenu) return;
  if (!modelMenu.hidden) return closeModelMenu();
  const c = K.modelChoices(CFG.active, CFG.providers);
  if (!c.current && !c.provider) {
    modelMenu.innerHTML = `<div class="sm-head">SIN MODELO</div>
      <div class="mm-hint">Activa un proveedor y un modelo en Ajustes › Modelo.</div>
      <div class="sm-item" data-act="settings"><span class="sm-name">Abrir Ajustes</span></div>`;
  } else {
    const head = c.provider ? `MODELOS · ${esc(c.provider.name)}` : 'MODELOS';
    const items = c.models.map(m => {
      const on = m === c.current;
      return `<div class="sm-item${on ? ' on' : ''}" role="option" aria-selected="${on}" data-model="${esc(m)}" title="${esc(m)}">
        <span class="sm-name">${esc(m)}</span>${on ? '<span class="mm-mark" aria-hidden="true">✓</span>' : ''}</div>`;
    }).join('');
    const nota = c.known
      ? `<div class="mm-hint">${c.models.length} modelos de tu API${c.provider ? ' (' + esc(c.provider.name) + ')' : ''}.</div>`
      : `<div class="mm-hint">Tu proveedor no tiene lista guardada: detecta los modelos para poder cambiar.</div>`;
    modelMenu.innerHTML = `<div class="sm-head">${head}</div>${items}${nota}
      <div class="mm-foot">
        <div class="sm-item" data-act="detect"><span class="sm-name">Detectar modelos de nuevo</span></div>
        <div class="sm-item" data-act="settings"><span class="sm-name">Ajustes de proveedores…</span></div>
      </div>`;
  }
  modelMenu.hidden = false;
  $('#sideStatusBtn').setAttribute('aria-expanded', 'true');
  // el modelo activo queda marcado para navegar con el teclado desde ahí
  const on = modelMenu.querySelector('.sm-item.on');
  if (on) { on.classList.add('hl'); on.scrollIntoView({ block: 'nearest' }); }
}

$('#sideStatusBtn').onclick = openModelMenu;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });
/* Teclado dentro del menú de modelos: mismo patrón que los desplegables propios
   (csel). Sin esto el botón anunciaba aria-haspopup="listbox" pero no se podía
   elegir nada sin ratón. El foco sigue en el botón (las filas son divs), así que
   la escucha va en el documento y solo actúa con el menú abierto y el foco ahí. */
document.addEventListener('keydown', (e) => {
  if (!modelMenu || modelMenu.hidden) return;
  if (!$('#sideStatusBtn').contains(document.activeElement)) return;
  const rows = [...modelMenu.querySelectorAll('.sm-item')];
  if (!rows.length) return;
  const at = rows.findIndex(r => r.classList.contains('hl'));
  const paint = (i) => {
    rows.forEach(r => r.classList.remove('hl'));
    rows[i].classList.add('hl');
    rows[i].scrollIntoView({ block: 'nearest' });
  };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    paint(at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length);
  } else if (e.key === 'Home') {
    e.preventDefault();
    paint(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    paint(rows.length - 1);
  } else if (e.key === 'Enter' && at >= 0) {
    e.preventDefault();
    rows[at].click();
  }
});
// clic fuera: cierra (el menú flota sobre la barra, no bloquea la app)
document.addEventListener('mousedown', (e) => {
  if (!modelMenu || modelMenu.hidden) return;
  if (!modelMenu.contains(e.target) && !$('#sideStatusBtn').contains(e.target)) closeModelMenu();
});

if (modelMenu) modelMenu.onclick = async (e) => {
  const row = e.target.closest('.sm-item');
  if (!row) return;
  if (row.dataset.act === 'settings') { closeModelMenu(); goto('settings'); showSetTab('model'); return; }
  if (row.dataset.act === 'detect') {
    const prov = K.modelChoices(CFG.active, CFG.providers).provider;
    const cfg = (CFG.providers || []).find(p => prov && p.id === prov.id) || CFG.active;
    if (!cfg || !cfg.baseUrl) return closeModelMenu();
    row.classList.add('on');
    row.querySelector('.sm-name').textContent = 'Detectando…';
    const r = await window.sagitari.listModels(cfg.baseUrl, cfg.apiKey);
    if (!r.ok) { showToast('No se pudieron detectar: ' + r.error); closeModelMenu(); return; }
    // la lista detectada se guarda en el proveedor: es la que ofrece el menú
    const saved = await window.sagitari.saveProvider({ id: cfg.id || 'prov_' + Date.now().toString(36), name: cfg.name || 'Proveedor', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, format: cfg.format, models: r.models });
    if (saved && saved.ok === false) { showToast('Error guardando la lista: ' + saved.error); closeModelMenu(); return; }
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    closeModelMenu();
    openModelMenu();
    showToast(r.models.length + ' modelos detectados');
    return;
  }
  const model = row.dataset.model;
  if (!model || model === (CFG.active && CFG.active.model)) return closeModelMenu();
  const c = K.modelChoices(CFG.active, CFG.providers);
  // providerId + baseUrl: main resuelve la clave guardada (no viaja por aquí)
  const r = await window.sagitari.activateProvider({
    providerId: c.provider ? c.provider.id : (CFG.active && CFG.active.providerId),
    name: c.provider ? c.provider.name : (CFG.active && CFG.active.name),
    baseUrl: (CFG.active && CFG.active.baseUrl),
    model,
    vision: looksVision(model),
    format: (CFG.active && CFG.active.format) || 'auto',
  });
  if (r && r.ok === false) { showToast('No se pudo cambiar: ' + r.error); return; }
  CFG = await window.sagitari.getConfig();
  closeModelMenu();
  renderProviderList();
  updateStatusLabels();
  showToast('Modelo: ' + model);
};

// ============ frame glow: estados del agente en el marco de la app ============
const shellEl = document.getElementById('shell');
let frameGlowTimer = null;
/* El COLOR lo pone el usuario (Ajustes → Apariencia) vía --glow-rgb; cada estado
   se distingue por su RITMO, no por su tono: pensar respira lento, trabajar
   late rápido, escuchar respira suave y hablar pulsa al ritmo de la voz. */
window.sagitari.onGlow(({ mode }) => {
  ['think', 'work', 'listen', 'speak', 'pulse'].forEach(m => shellEl.classList.remove('glow-' + m));
  clearTimeout(frameGlowTimer);
  if (mode === 'off') return;   // sin clases = resplandor calmado por defecto
  // `pulse` ya no reutiliza el estado de trabajo: es un pase de luz (una vuelta), que es
  // lo que significa «acuso recibo» y no «estoy trabajando».
  const anim = { think: 'think', work: 'work', listen: 'listen', speak: 'speak', pulse: 'pulse' }[mode] || 'think';
  shellEl.classList.add('glow-' + anim);
  if (mode === 'pulse') frameGlowTimer = setTimeout(() => shellEl.classList.remove('glow-pulse'), 1400);
});

/* ============ tema: acento de la UI + color e intensidad del glow ============
   PALETTES define los triplets RGB; applyTheme los vuelca en el :root y todo el
   CSS (80+ tintes) se reconstruye solo, sin recargar nada. */
const PALETTES = {
  violet:  { label: 'Violeta',   acc: [148, 118, 255], acc2: [139, 92, 246],  acc3: [59, 130, 246] },
  magenta: { label: 'Magenta',   acc: [240, 130, 220], acc2: [217, 70, 239],  acc3: [139, 92, 246] },
  cyan:    { label: 'Cian',      acc: [103, 232, 249], acc2: [34, 211, 238],  acc3: [45, 212, 191] },
  emerald: { label: 'Esmeralda', acc: [110, 231, 183], acc2: [52, 211, 153],  acc3: [45, 212, 191] },
  amber:   { label: 'Ámbar',     acc: [252, 211, 77],  acc2: [245, 158, 11],  acc3: [251, 146, 60] },
  ice:     { label: 'Hielo',     acc: [147, 197, 253], acc2: [59, 130, 246],  acc3: [125, 180, 255] }
};
/* Escalones de superficie de la rampa violeta: son los fondos que la app tenía
   escritos a mano. Cada paleta deriva los suyos con la MISMA luminancia relativa
   (no la L de HSL, que no es brillo percibido) y el TONO del acento: cambiar el
   color de la interfaz cambia también los fondos sin mover el contraste un punto. */
const RAMPA_REF = {
  '--bg0-rgb': [6, 4, 15], '--bg1-rgb': [16, 10, 38], '--bg2-rgb': [22, 14, 48],
  '--deep-rgb': [12, 8, 30], '--field-rgb': [8, 5, 24], '--panel-rgb': [18, 12, 42],
  '--panel2-rgb': [26, 18, 56], '--face-rgb': [30, 20, 64], '--face2-rgb': [38, 26, 76],
};
const _hsl = (c) => {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
};
const _rgb = (h, s, l) => {
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
};
const _lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const _rampas = {};
/** Superficies de una paleta: mismo brillo que la referencia, tono del acento. */
function rampaDeSuperficies(acento) {
  const clave = acento.join(',');
  if (_rampas[clave]) return _rampas[clave];
  const [h] = _hsl(acento);
  const out = {};
  for (const [token, baseRGB] of Object.entries(RAMPA_REF)) {
    const [, s] = _hsl(baseRGB), objetivo = _lum(baseRGB);
    // bisección: la luminancia crece con L, así que se busca la L que la iguala
    let lo = 0, hi = 1;
    for (let i = 0; i < 22; i++) { const medio = (lo + hi) / 2; if (_lum(_rgb(h, s, medio)) < objetivo) lo = medio; else hi = medio; }
    out[token] = _rgb(h, s, (lo + hi) / 2).join(', ');
  }
  // SOLO la paleta de referencia se fija con sus literales, para que el tema por
  // defecto quede idéntico. Aplicarlo siempre devolvía la rampa violeta a todas las
  // paletas: el color de la interfaz cambiaba en los acentos y no en los fondos.
  if (clave === '148,118,255') {
    out['--bg0-rgb'] = '6, 4, 15'; out['--bg1-rgb'] = '16, 10, 38'; out['--bg2-rgb'] = '22, 14, 48';
    out['--deep-rgb'] = '12, 8, 30'; out['--field-rgb'] = '8, 5, 24'; out['--panel-rgb'] = '18, 12, 42';
    out['--panel2-rgb'] = '26, 18, 56'; out['--face-rgb'] = '30, 20, 64'; out['--face2-rgb'] = '38, 26, 76';
  }
  return (_rampas[clave] = out);
}
/** Un tono vecino del elegido, en grados de diferencia. */
function gh(pal, giro) {
  const [h, s, l] = _hsl(pal.acc2);
  return _rgb(h + giro, Math.min(1, s * 1.02), Math.min(.78, l * 1.0)).join(', ');
}
function applyTheme() {
  const s = CFG.settings || {};
  const pal = PALETTES[s.uiColor] || PALETTES.violet;
  const gpal = (s.glowColor && s.glowColor !== 'match' && PALETTES[s.glowColor]) ? PALETTES[s.glowColor] : pal;
  const r = document.documentElement.style;
  r.setProperty('--acc-rgb', pal.acc.join(','));
  r.setProperty('--acc2-rgb', pal.acc2.join(','));
  r.setProperty('--acc3-rgb', pal.acc3.join(','));
  r.setProperty('--glow-rgb', gpal.acc2.join(','));
  // Aura iridiscente: tres tonos VECINOS del elegido (no un arcoíris), para que la luz
  // tenga variación de color como el brillo de Apple Intelligence sin dejar de ser tu color.
  const [gh, gs, gl] = _hsl(gpal.acc2);
  r.setProperty('--glow-a-rgb', _rgb(gh + 13, Math.min(1, gs * 1.01), Math.min(.72, gl * .98)).join(', '));
  r.setProperty('--glow-b-rgb', _rgb(gh, gs, gl).join(', '));
  r.setProperty('--glow-c-rgb', _rgb(gh - 12, Math.min(1, gs * 1.04), Math.min(.78, gl * 1.01)).join(', '));
  r.setProperty('--glow-str', String(Math.min(1.4, Math.max(0.4, Number(s.glowStrength) || 1))));
  // los fondos también son del tema: si no, el color cambia solo en los acentos
  for (const [token, valor] of Object.entries(rampaDeSuperficies(pal.acc))) r.setProperty(token, valor);
  // refresca las muestras de color de Ajustes si están pintadas
  document.querySelectorAll('.colordot').forEach(d => { d.style.background = ''; });
}
function glowStrengthLabel(v) { return v < 0.8 ? 'Suave' : v <= 1.15 ? 'Equilibrado' : 'Intenso'; }
// cambios hechos desde Ajustes se aplican al vuelo (y desde main, p.ej. relanzar glow)
window.sagitari.onThemeChanged && window.sagitari.onThemeChanged(() => applyTheme());

// ============ init ============
(async function init() {
  await fillSettings();
  // paneles que leen CFG/metaGet: van DESPUÉS de cargar la configuración real
  fillMemorySens();
  await initSecurity();
  // los desplegables nativos (selects) pasan a ser controles con el estilo de la app
  mejoraSelects();
  applyTheme();            // acento + glow antes del primer frame
  setSendMode();
  // el chat arranca vacío: nada de sellos de hora sueltos, sólo la bienvenida
  resetChatView([]);
  $('#chatTitle').title = convTitle;   // el título se trunca: pista completa siempre
  refreshSidebar();
  // la pestaña con la que se abre la app debe quedar marcada en el sidebar
  const on = $('.view.on');
  if (on) $$('.navitem').forEach(b => {
    const active = b.dataset.view === on.id.replace('view-', '');
    b.classList.toggle('on', active);
    if (active) b.setAttribute('aria-current', 'page');
  });
  feed('Sagitari iniciado', 'ok');
  feed('Esperando peticiones', 'blu');
  if (!CFG.active) {
    // bienvenida SIN abrir turno: con ensureAssistantBubble quedaban vivos
    // pendingAssistant/pendingTurn y el primer mensaje real se escribía dentro
    // de esta misma burbuja, heredando el modo del arranque
    const b = bubble('ai');
    b.innerHTML = fmt('**Sagitari online.** Antes de hablar conmigo, ve a **Ajustes** y activa un proveedor y modelo (OpenCode Go, OpenRouter, Ollama…).');
  }
  // recupera la conversación activa si la app se cerró a medias
  try {
    const list = await window.sagitari.convList();
    if (list.length) {
      const r = await window.sagitari.convOpen(list[0].id);
      if (r.ok && r.messages.length) resetChatView(r.messages);
    }
  } catch {}
})();
