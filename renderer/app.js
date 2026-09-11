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
let pendingChipBox = null;
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
function goto(view) {
  $$('.navitem').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
  if (view === 'chat') $('#chatInput').focus();
  if (view === 'memory') renderMemory();
  if (view === 'tasks') renderTasks();
  if (view === 'agents') { renderHealth(); renderHabits(); }
  if (view === 'skills') { renderMarket(); renderSkills(); }
  if (view === 'projects') window.sagitari.workspaceGet().then(w => { $('#projPath').value = w; });
  if (view === 'history') renderHistory();
  if (view === 'settings') { showSetTab(setTabName); initDataPanel(); }
  polishSwitches();   // los interruptores creados dinámicamente también deben ser accesibles
  syncChatBadge();
  setSideActive();
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
  } catch { /* el sidebar nunca debe romper la app */ }
}
setInterval(refreshSidebar, 3000);

$('#sideStatusBtn').onclick = () => goto('settings');
$('#sideModeBtn').onclick = () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]);
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.shiftKey) return;
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); $('#sideToggle').click(); return; }
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    goto(VIEW_HOTKEY[e.key === '0' ? 9 : parseInt(e.key, 10) - 1]);
  }
});

// ============ clock + greeting (en el estado vacío del chat) ============
function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  const chip = document.getElementById('chatStatusTime');
  if (chip) chip.textContent = `${hh}:${mm}`;
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
/* render markdown real (marked + GFM): tablas, listas, títulos, reglas, código.
   El output de marked se SANEABA antes vía esc(); marked genera HTML de confianza
   del texto del modelo, así que neutralizamos secuencias peligrosas y forzamos
   que los links abran en el navegador del sistema, nunca dentro de la app. */
function fmt(text) {
  if (window.marked) {
    const html = window.marked.parse(String(text || ''), { gfm: true, breaks: true });
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('a[href]').forEach(a => {
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.addEventListener('click', (e) => { e.preventDefault(); window.sagitari.openExternal(a.href); });
    });
    // sin HTML crudo escrito por el modelo: solo el que produce el propio markdown
    div.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (!/^(href|class|src)$/.test(attr.name) || /javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'SCRIPT' || el.tagName === 'IFRAME' || (el.tagName === 'IMG' && !/^data:image\//.test(el.getAttribute('src') || ''))) el.remove();
    });
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
  row.appendChild(mk('copy', 'Copiar este mensaje', () => copyText(text, 'Mensaje copiado')));
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
  if (last) { try { last.closest('.msg').remove(); } catch {} }
  lastAssistantEl = null;
  showToast('Regenerando respuesta…');
  await window.sagitari.retryChat();
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
    pendingChipBox = null;
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
    head.innerHTML = `<span class="tg-ic">${ic('tools')}</span><b class="tg-title">Herramientas</b>`
      + `<span class="tg-meta"></span><span class="tg-chev">${ic('chevron')}</span>`;
    const body = document.createElement('div');
    body.className = 'tgroup-body';
    head.onclick = () => {
      const open = g.classList.toggle('open');
      g.classList.toggle('closed', !open);
    };
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
  card.querySelector('.tcard-head').onclick = () => card.classList.toggle('open');
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
  c.innerHTML = `<span class="tc-mark">${mark}</span><span class="tc-txt">${esc(text)}</span>`;
  (pendingTurn ? pendingTurn.body : b).appendChild(c);
  scroll();
}

/* ---- plan del modo PLAN: se pinta como checklist y se marca al avanzar ---- */
function renderPlanCard(container, steps, before) {
  const card = document.createElement('div');
  card.className = 'plancard';
  card.innerHTML = `<div class="plancard-head">${ic('map')}<b>PLAN</b><span class="pl-count"></span></div>`
    + '<ol>' + steps.map(s => `<li data-step="${s.n}"><span class="pl-n">${s.n}</span><span>${esc(s.text)}</span></li>`).join('') + '</ol>';
  if (before) container.insertBefore(card, before);
  else container.appendChild(card);
  const count = card.querySelector('.pl-count');
  const items = [...card.querySelectorAll('li')];
  count.textContent = `${steps.length} pasos`;
  return {
    el: card,
    total: items.length,
    done: 0,
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

function finishAssistant(finalText) {
  if (!pendingAssistant) return;
  const holder = pendingAssistant;
  const stream = holder.querySelector('.stream');
  if (stream) stream.remove();
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
        // el plan creció tras el último delta: se repinta completo, en su sitio
        pendingTurn.plan = renderPlanCard(holder, parsed.steps, current.el);
        pendingTurn.plan.next();
        current.el.remove();
      }
    }
    const text = parsed.steps.length ? (parsed.body || '') : finalText;
    if (text) {
      const div = document.createElement('div');
      div.innerHTML = fmt(text);
      holder.appendChild(div);
    }
  }
  // turno completado: el plan queda cerrado. Si se detuvo a medias (sin
  // respuesta final) los pasos restantes se dejan como estaban — marcarlos
  // como cumplidos sería mentir sobre lo que realmente se hizo.
  if (finalText && pendingTurn && pendingTurn.plan) {
    const p = pendingTurn.plan;
    while (p.done < p.total) p.advance();
  }
  if (pendingTurn && pendingTurn.tools) {
    lastTurnSummary = K.toolCount(pendingTurn.tools) + (pendingTurn.totalMs ? ' · ' + K.fmtDuration(pendingTurn.totalMs) : '');
  } else if (pendingTurn && pendingTurn.plan) {
    lastTurnSummary = pendingTurn.plan.total + ' pasos completados';
  } else {
    lastTurnSummary = 'respuesta entregada';
  }
  if (finalText) msgActions(holder.closest('.msg-body') || holder, finalText, { speak: true });
  lastAssistantEl = holder;
  refreshMsgActions();
  pendingAssistant = null; pendingChipBox = null; pendingTurn = null;
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
function updateAgentCount() {
  const n = document.querySelectorAll('.acard.on').length;
  $('#agentCount').textContent = n;
  $('#bigRing').parentElement.parentElement.classList.toggle('idle', n === 0);
}
updateAgentCount();

function renderToolTray() {
  const tray = $('#toolTrayList');
  if (!tray || tray.children.length) return;
  for (const t of Object.keys(AGENT_MAP)) {
    const c = document.createElement('span');
    c.className = 'toolchip';
    c.innerHTML = `<span class="tc-mark">${ic(AGENT_MAP[t].icon)}</span><span class="tc-txt">${t}</span>`;
    tray.appendChild(c);
  }
}

// ============ v1.6: Model Health panel ============
async function renderHealth() {
  const box = $('#healthList');
  if (!box) return;
  let rows = [];
  try { rows = await window.sagitari.healthGet(); } catch {}
  if (!rows.length) { box.innerHTML = '<div class="subnote">Sin datos todavía. Cada llamada al modelo registrará latencia, errores y tokens aquí.</div>'; return; }
  box.innerHTML = rows.map(r => {
    const health = r.errorRate >= 0.3 ? 'mag' : r.errorRate > 0 ? 'a-y' : 'ok';
    return `<div class="toolchip" title="${esc(r.lastError || '')}">
      <span class="dot ${health}"></span>
      <span class="tc-txt"><b>${esc(r.model)}</b> · ${r.calls} llamadas · ${r.avgLatencyMs || '—'} ms · ${(r.tokensIn + r.tokensOut).toLocaleString('es')} tok${r.errors ? ' · ' + r.errors + ' errores' : ''}${r.fallbacks ? ' · ' + r.fallbacks + ' fallbacks' : ''}</span>
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
    ? `<div class="toolchip"><span class="tc-mark">${ic(icon)}</span><span class="tc-txt">${arr.map(x => `${esc(x.name)} ×${x.count}`).join(' · ')}</span></div>`
    : '';
  parts.push(fmtList(s.apps, 'zap'));
  parts.push(fmtList(s.commands, 'terminal'));
  parts.push(fmtList(s.sites, 'globe'));
  const c = s.confirms || {};
  if (c.approved || c.denied) parts.push(`<div class="toolchip"><span class="tc-mark">${ic('check')}</span><span class="tc-txt">confirmaciones: ${c.approved || 0} aceptadas · ${c.denied || 0} denegadas</span></div>`);
  box.innerHTML = parts.filter(Boolean).join('') || '<div class="subnote">Aún no hay hábitos observados. Se aprenden solo de lo que SAGITARI hace por ti.</div>';
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
        $('#marketMsg').textContent = 'Instaladas: ' + inst.map(s => s.name).join(', ');
        renderSkills();
      } catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
      renderMarket();
    };
  });
}
$('#marketSearchBtn').onclick = async () => {
  const q = $('#marketQuery').value.trim();
  if (!q) return;
  const box = $('#marketList');
  $('#marketMsg').textContent = 'Buscando en GitHub…';
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
};
$('#skillsUpdateAllBtn').onclick = async () => {
  $('#marketMsg').textContent = 'Actualizando skills…';
  try {
    const res = await window.sagitari.skillsUpdateAll();
    const changed = res.filter(r => r.changed).length;
    $('#marketMsg').textContent = `${res.length} skills con origen · ${changed} actualizadas`;
    renderSkills();
  } catch (e) { $('#marketMsg').textContent = 'Error: ' + (e.message || e); }
};

// ============ agent events ============
window.sagitari.onAgentEvent((ev) => {
  // v1.3: los eventos de una tarea en background NO deben tocar el chat
  // interactivo (ni sus burbujas ni el estado busy/detener): solo el feed,
  // el panel de Tareas, las confirmaciones y los avisos.
  if (ev.bg) {
    switch (ev.type) {
      case 'status': feed(ev.text, 'pur'); break;
      case 'tool': feed(ev.name || 'herramienta', 'pur'); break;
      case 'tool_result': feed((ev.name || '') + ' — ' + String(ev.result || 'ok').slice(0, 90), (String(ev.result || '').startsWith('Error') ? 'err' : 'ok')); break;
      case 'task_done':
        feed('Tarea en background completada', 'ok');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        break;
      case 'task_interrupted':
        feed('Tarea en background interrumpida — recuperable', 'err');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        break;
      case 'task_update':
        feed(ev.note || ('Tarea: ' + ev.status), 'blu');
        if ($('#view-tasks').classList.contains('on')) renderTasks();
        break;
      case 'guardrail':
        feed('Límite de seguridad (background): ' + String(ev.reason || '').slice(0, 90), 'err');
        showToast(String(ev.reason || 'Límite de seguridad en una tarea'));
        break;
      case 'error':
        feed('Error en tarea de background', 'err');
        showToast(ev.message || 'Error en una tarea de background');
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
      const old = b.querySelector('.stream');
      if (old) old.remove();
      const s = document.createElement('div');
      s.className = 'stream';
      s.innerHTML = fmt(b._stream);
      b.appendChild(s);
      scroll();
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
      break;
    case 'image': {
      const b = ensureAssistantBubble();
      const img = document.createElement('img');
      img.src = ev.dataUrl; img.className = 'shot';
      b.appendChild(img);
      scroll();
      break;
    }
    case 'assistant_done':
      finishAssistant(ev.text);
      busy = false;
      setSendMode();
      glowOffSoon();
      speak(ev.text);
      setChatStatus('Listo · ' + lastTurnLabel(), 'done');
      feed('Respuesta lista', 'cy');
      break;
    case 'guardrail':
      toolChip('Límite de seguridad — ' + ev.reason.slice(0, 100), 'err');
      feed('Límite de seguridad', 'err');
      showToast(ev.reason);
      break;
    case 'paused':
      busy = false;
      setSendMode();
      glowOffSoon();
      feed('Tarea pausada — checkpoint guardado', 'blu');
      showToast('Tarea pausada. Reanúdala desde el panel Tareas.');
      break;
    case 'task_done':
      feed('Tarea completada y verificada', 'ok');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
      break;
    case 'task_interrupted':
      feed('Tarea interrumpida — recuperable en Tareas', 'err');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
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
      if (busy) {
        currentRunMode = K.mode(ev.mode || mode).key;
        applyModeTheme(currentRunMode);
        setChatStatus(K.mode(currentRunMode).tagline);
        feed('Sagitari está trabajando · ' + K.mode(currentRunMode).label, 'blu');
      } else {
        // terminó la ejecución: el color vuelve al modo que tengas elegido
        applyModeTheme(mode);
        if (!currentConfirm || !currentConfirm.runId) hideConfirm();
      }
      break;
    case 'stopped':
      finishAssistant('');
      busy = false;
      setSendMode();
      glowOffSoon();
      setChatStatus('Detenido por el usuario');
      feed('Detenido por el usuario', 'err');
      break;
    case 'toast':
      showToast(ev.title + ': ' + ev.message);
      break;
    case 'error':
      finishAssistant('');
      {
        const eb = bubble('ai');
        eb.innerHTML = `<span class="errmsg">${ic('alert')} ${esc(ev.message)}</span>`;
      }
      busy = false;
      setSendMode();
      glowOffSoon();
      feed('Error en la tarea', 'err');
      break;
  }
});

function glowOffSoon() { setTimeout(() => window.sagitari.glow('off'), 2600); }

// ============ v1.1: confirmación de acciones + métricas de ejecución ============
let currentConfirm = null;
function showConfirm(ev) {
  currentConfirm = ev;
  const bar = $('#confirmBar');
  const who = ev.runId ? ' (tarea en background)' : '';
  $('#confirmTitle').textContent = 'El agente quiere: ' + (ev.description || ev.tool) + who;
  $('#confirmDetail').textContent = ev.summary ? String(ev.summary).slice(0, 240) : 'Herramienta: ' + ev.tool;
  bar.hidden = false;
  feed('Esperando tu confirmación: ' + ev.tool, 'blu');
}
function hideConfirm() { currentConfirm = null; $('#confirmBar').hidden = true; }
$('#confirmOk').onclick = async () => { const c = currentConfirm; hideConfirm(); if (c) await window.sagitari.secResolve(c.id, true, c.runId); };
$('#confirmNo').onclick = async () => { const c = currentConfirm; hideConfirm(); if (c) await window.sagitari.secResolve(c.id, false, c.runId); };

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
    line.textContent = (m.model || '—') + ' · ' + (r.tokensIn || 0) + ' in / ' + (r.tokensOut || 0) + ' out tok · '
      + (r.llmCalls || 0) + ' llamadas · ' + (r.toolCalls || 0) + ' herramientas · ' + (r.lastLatencyMs || 0) + ' ms'
      + ' · límites: ' + (gr.maxSteps || '∞') + ' pasos / ' + (gr.maxDurationMs ? Math.round(gr.maxDurationMs / 60000) + ' min' : '∞');
  } catch { line.hidden = true; }
}
setInterval(paintMeta, 2000);
// v1.3: la vista Tareas se refresca sola mientras está visible (estado en vivo)
setInterval(() => { const v = $('#view-tasks'); if (v && v.classList.contains('on')) renderTasks(); }, 5000);

function setSendMode() {
  const b = $('#chatSend');
  b.innerHTML = ic(busy ? 'stop' : 'send');
  b.classList.toggle('stop', busy);
  b.title = busy ? 'Detener' : 'Enviar';
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
  await window.sagitari.sendChat(text, null, atts);
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

async function addAttachmentFiles(files) {
  for (const f of (files || []).slice(0, MAX_ATTACHMENTS)) {
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
  const paths = await window.sagitari.attachmentsPick();
  for (const p of (paths || [])) await addAttachmentPath(p);
};

// drag & drop sobre toda la vista del chat
const chatView = $('#view-chat');
['dragover', 'dragenter'].forEach(t => chatView.addEventListener(t, (e) => { e.preventDefault(); chatView.classList.add('dragging'); }));
['dragleave', 'drop', 'dragend'].forEach(t => chatView.addEventListener(t, (e) => { if (t !== 'drop' || e.target === chatView || true) chatView.classList.remove('dragging'); }));
chatView.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer || {}).files || []];
  if (files.length) addAttachmentFiles(files.map(f => ({ path: f.path, name: f.name, type: f.type })));
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
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFrom('#chatInput'); } });

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
  const m = v.match(/^\/([\w-]*)\s*$/);
  if (m) { refreshSkillList().then(() => { skillIdx = skillList.length ? 0 : -1; renderSkillMenu(m[1]); }); }
  else closeSkillMenu();
}
function closeSkillMenu() { skillMenu.hidden = true; skillIdx = -1; }
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
$('#btnClose').onclick = () => window.sagitari.quit();
$('#btnClear').onclick = async () => { await window.sagitari.clearChat(); msgs.innerHTML = ''; dayStamp(); showToast('Conversación reiniciada'); };

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
  tickClock();
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
  if (!$('#pUrl').value.trim()) return smsg('Falta la Base URL.');
  await window.sagitari.saveProvider({ id: 'prov_' + Date.now().toString(36), name: $('#pName').value.trim() || 'Proveedor', baseUrl: $('#pUrl').value.trim(), apiKey: $('#pKey').value.trim(), format: apiFormatValue(), models: [...$('#modelSel').options].map(o => o.value).filter(Boolean) });
  CFG = await window.sagitari.getConfig();
  renderProviderList();
  smsg('Proveedor guardado.');
};
$('#btnActivate').onclick = async () => {
  const baseUrl = $('#pUrl').value.trim(), model = $('#modelSel').value;
  if (!baseUrl || !model) return smsg('Detecta modelos y elige uno.');
  const vision = /(gpt-4|gpt-5|4o|vision|llava|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i.test(model);
  await window.sagitari.activateProvider({ name: $('#pName').value.trim() || 'Proveedor', baseUrl, apiKey: $('#pKey').value.trim(), model, vision, format: apiFormatValue() });
  CFG = await window.sagitari.getConfig();
  renderProviderList();
  smsg('Activado: ' + model);
  updateStatusLabels();
};

function renderProviderList() {
  const box = $('#provList');
  box.innerHTML = '';
  if (!CFG.providers.length) { box.innerHTML = '<div class="subnote">Aún no hay proveedores guardados.</div>'; return; }
  for (const p of CFG.providers) {
    const item = document.createElement('div');
    item.className = 'provitem';
    const inUse = CFG.active && CFG.active.baseUrl === p.baseUrl;
    item.innerHTML = `<span class="nm">${esc(p.name)} <span class="md">· ${(p.models || []).length} modelos</span></span>${inUse ? '<span class="badge">EN USO</span>' : ''}
      <button class="btn ghost sq" data-act="use" title="Usar">${ic('play')}</button><button class="btn ghost sq danger" data-act="del" title="Eliminar">${ic('trash')}</button>`;
    item.querySelector('[data-act=use]').onclick = async () => {
      const model = (p.models || [])[0];
      if (!model) return smsg('Este proveedor no tiene modelos: detecta primero.');
      await window.sagitari.activateProvider({ name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model, vision: /(gpt-4|4o|vision|llava|claude|gemini)/i.test(model), format: p.format });
      CFG = await window.sagitari.getConfig();
      renderProviderList(); updateStatusLabels();
      smsg('Usando ' + p.name);
    };
    item.querySelector('[data-act=del]').onclick = async () => {
      await window.sagitari.deleteProvider(p.id);
      CFG = await window.sagitari.getConfig();
      renderProviderList();
    };
    box.appendChild(item);
  }
}
function smsg(t) { $('#saveMsg').textContent = t; }

$('#swGlow').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ glowEnabled: on }); };
// espacio de trabajo
$('#wsPick').onclick = async () => {
  const r = await window.sagitari.workspacePick();
  if (r && r.ok) { $('#wsPath').value = r.path; showToast('Espacio de trabajo: ' + r.path); }
};
$('#swTts').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ ttsEnabled: on }); };
$('#voiceLang').onchange = (e) => window.sagitari.setSettings({ voiceLang: e.target.value });

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
$('#setUserName').onchange = (e) => { window.sagitari.setSettings({ userName: e.target.value }); CFG.settings.userName = e.target.value; tickClock(); };

// ---- seguridad: permisos por herramienta + guardarraíles (v1.1) ----
const PERM_TOOLS = [
  { n: 'run_command', d: 'Ejecutar comandos en la terminal' },
  { n: 'write_file', d: 'Crear o sobrescribir archivos' },
  { n: 'browser_control', d: 'Controlar el navegador' },
  { n: 'open_app', d: 'Abrir aplicaciones' },
  { n: 'window_manage', d: 'Gestionar ventanas' },
  { n: 'clipboard', d: 'Portapapeles' },
];
const RISK_LABEL = { safe: 'seguro', confirm: 'confirmar', restricted: 'bloqueado' };

async function renderSecurity() {
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
    row.innerHTML = `<span class="mt"><b>${esc(t.n)}</b><br><small class="md">${esc(t.d)}</small><br><small class="pd">recomendado: ${rec}</small></span>
      <select data-tool="${t.n}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto (${rec})</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>Seguro</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>Confirmar</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>Bloqueado</option>
      </select>`;
    row.querySelector('select').onchange = async (e) => {
      await window.sagitari.secSetToolPerm(t.n, e.target.value);
      showToast(`${t.n}: ${e.target.selectedOptions[0].textContent.toLowerCase()}`);
    };
    permBox.appendChild(row);
  }
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
    if ($('#setMaxTasks')) $('#setMaxTasks').value = CFG.settings.maxConcurrentTasks ?? 1;
    if ($('#swAutoResume')) $('#swAutoResume').classList.toggle('on', CFG.settings.autoResumeTasks !== false);
    if (CFG.settings.devMode) { devMode = true; $('#devModeSw').classList.add('on'); paintMeta(); }
  } catch {}
  renderSecurity();
}
$('#grSteps').onchange = (e) => window.sagitari.secSetGuardrail({ maxSteps: Number(e.target.value) || 0 });
$('#grToolCalls').onchange = (e) => window.sagitari.secSetGuardrail({ maxToolCalls: Number(e.target.value) || 0 });
$('#grMinutes').onchange = (e) => window.sagitari.secSetGuardrail({ maxDurationMs: (Number(e.target.value) || 0) * 60000 });
$('#grTokens').onchange = (e) => window.sagitari.secSetGuardrail({ maxTokens: Number(e.target.value) || 0 });
$('#grLoop').onchange = (e) => window.sagitari.secSetGuardrail({ loopThreshold: Number(e.target.value) || 3 });
if ($('#grCost')) $('#grCost').onchange = (e) => window.sagitari.secSetGuardrail({ maxCostUsd: Math.max(0, Number(e.target.value) || 0) });
if ($('#grStall')) $('#grStall').onchange = (e) => window.sagitari.secSetGuardrail({ stallThreshold: Math.max(0, Number(e.target.value) || 0) });
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
initSecurity();

/* ============ Ajustes: pestañas, búsqueda y utilidades ============ */

const SET_TABS = ['model', 'prefs', 'security', 'agent', 'data'];
let setTabName = 'model';
try { const t = localStorage.getItem('sagi.setTab'); if (SET_TABS.includes(t)) setTabName = t; } catch {}

/** Muestra una pestaña de Ajustes (y la recuerda para la próxima vez). */
function showSetTab(panel) {
  const name = SET_TABS.includes(panel) ? panel : 'model';
  setTabName = name;
  try { localStorage.setItem('sagi.setTab', name); } catch {}
  const tabs = $('#setTabs');
  if (tabs) tabs.querySelectorAll('.settab').forEach(b => b.classList.toggle('on', b.dataset.set === name));
  const wrap = $('#setWrap');
  if (wrap) wrap.querySelectorAll('.setpanel').forEach(p => p.classList.toggle('on', p.dataset.panel === name));
}
if ($('#setTabs')) $('#setTabs').querySelectorAll('.settab').forEach(b => {
  b.onclick = () => {
    const q = $('#setSearch');
    if (q && q.value) { q.value = ''; filterSettings(''); }
    showSetTab(b.dataset.set);
  };
});

/** Filtra los ajustes por texto. Con búsqueda activa se muestran todas las tarjetas
    cuyas filas (.srow) coincidan. */
function filterSettings(query) {
  const wrap = $('#setWrap');
  if (!wrap) return;
  const q = String(query || '').trim().toLowerCase();
  wrap.classList.toggle('searching', !!q);
  let shown = 0;
  wrap.querySelectorAll('.srow').forEach(row => {
    const hay = ((row.dataset.keys || '') + ' ' + row.textContent).toLowerCase();
    const hit = !q || hay.includes(q);
    row.hidden = !hit;
    if (hit) shown++;
  });
  wrap.querySelectorAll('.setcard').forEach(card => {
    card.hidden = !!q && ![...card.querySelectorAll('.srow')].some(r => !r.hidden);
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

// restablecer límites y permisos a los valores recomendados
const GUARDRAIL_DEFAULTS = { maxSteps: 60, maxToolCalls: 80, maxDurationMs: 15 * 60 * 1000, maxTokens: 0, maxCostUsd: 0, loopThreshold: 3, stallThreshold: 6 };
if ($('#secResetGuardrails')) $('#secResetGuardrails').onclick = async () => {
  await window.sagitari.secSetGuardrail(GUARDRAIL_DEFAULTS);
  await initSecurity();
  showToast('Límites restablecidos a los valores recomendados');
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
  await window.sagitari.habitsReset();
  await renderHabitsPreview();
  showToast('Hábitos aprendidos reiniciados');
};
if ($('#openDataDirBtn')) $('#openDataDirBtn').onclick = async () => {
  const r = await window.sagitari.openDataDir();
  if (r && r.ok === false) showToast(r.error || 'No se pudo abrir la carpeta');
};

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
  $('#chatTitle').textContent = convTitle;
  // sincroniza el título con la conversación real en el historial
  if (t) window.sagitari.convRename && window.sagitari.convRename(t);
}

async function renderHistory() {
  const list = await window.sagitari.convList();
  const box = $('#histList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="subnote">Aún no hay conversaciones. Todo lo que hables con Sagitari aparecerá aquí.</div>'; return; }
  for (const c of list) {
    const it = document.createElement('div');
    it.className = 'hitem';
    const d = new Date(c.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    it.innerHTML = `<div class="hic">${ic('chat')}</div>
      <div class="hmain"><b>${esc(c.title)}</b><small>${c.count} mensajes · ${when}</small></div>
      <button class="btn ghost sq danger hdel" title="Eliminar">${ic('trash')}</button>`;
    it.addEventListener('click', (ev) => {
      if (ev.target.closest('.hdel')) return;
      openConversation(c.id);
    });
    it.querySelector('.hdel').onclick = async (ev) => {
      ev.stopPropagation();
      await window.sagitari.convDel(c.id);
      renderHistory();
    };
    box.appendChild(it);
  }
}

async function openConversation(id) {
  const r = await window.sagitari.convOpen(id);
  if (!r.ok) { showToast('No se pudo abrir la conversación'); return; }
  resetChatView(r.messages);
  setChatTitle((r.messages.find(m => m.role === 'user') || {}).content || 'Nueva conversación');
  goto('chat');
  feed('Conversación restaurada', 'blu');
}

/** Vuelve el chat a cero y, si hay historial, lo pinta con su modo por turno. */
function resetChatView(messages) {
  msgs.innerHTML = '';
  pendingAssistant = null; pendingChipBox = null; pendingTurn = null;
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
      <span class="cm-tag">${esc(M.tagline)}</span>
      <ul class="cm-bullets">${M.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
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
    e.preventDefault();
    setMode(MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]);
  }
});

// ============ memory view ============
async function renderMemory() {
  const list = await window.sagitari.memoryList();
  const box = $('#memList');
  box.innerHTML = '';
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
    it.querySelector('[data-del]').onclick = async () => { await window.sagitari.memoryRemove(m.id); renderMemory(); };
    box.appendChild(it);
  }
}
$('#memAdd').onclick = async () => {
  const t = $('#memInput').value.trim();
  if (!t) return;
  await window.sagitari.memoryAdd(t);
  $('#memInput').value = '';
  renderMemory();
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
fillMemorySens();

// ============ skills view ============
async function renderSkills() {
  const list = await window.sagitari.skillsList();
  const box = $('#skillsList');
  box.innerHTML = '';
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
      <label class="sw ${s.enabled ? 'on' : ''}" data-sw title="Activar/desactivar"></label>
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    it.querySelector('[data-sw]').onclick = async (e) => { await window.sagitari.skillsToggle(s.id, !s.enabled); renderSkills(); };
    it.querySelector('[data-del]').onclick = async () => { await window.sagitari.skillsDelete(s.id); renderSkills(); };
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
  const inp = $('#skillImportInput'), msg = $('#skillMsg');
  const repo = inp.value.trim();
  if (!repo) { msg.textContent = 'Escribe owner/repo (ej. anthropics/skills).'; return; }
  msg.textContent = 'Importando desde ' + repo + '…';
  try {
    const inst = await window.sagitari.skillsImport(repo);
    msg.textContent = 'Importadas: ' + inst.map(s => s.name).join(', ');
    inp.value = '';
    renderSkills();
  } catch (err) { msg.textContent = 'Error: ' + (err.message || err); }
};
$('#skillsFolderBtn').onclick = () => window.sagitari.skillsOpenFolder();
$('#skillCreateBtn').onclick = async () => {
  const msg = $('#skillMsg');
  const name = $('#skillNewName').value.trim(), desc = $('#skillNewDesc').value.trim(), body = $('#skillNewBody').value.trim();
  if (!name || !desc) { msg.textContent = 'Nombre y descripción son obligatorios.'; return; }
  await window.sagitari.skillsCreate({ name, description: desc, body });
  $('#skillNewName').value = $('#skillNewDesc').value = $('#skillNewBody').value = '';
  msg.textContent = 'Skill "' + name + '" creada.';
  renderSkills();
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
(function renderTools() {
  const g = $('#toolsGrid');
  for (const [n, i, d] of TOOL_INFO) {
    const c = document.createElement('div');
    c.className = 'toolcard';
    c.innerHTML = `<div class="tic">${ic(i)}</div><div><b>${n}</b><small>${d}</small></div>`;
    g.appendChild(c);
  }
})();

// ============ v1.2: tasks view (checkpoints, pausa, reanudación) ============
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
  let list = [];
  try { list = await window.sagitari.tasksList(); } catch {}
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="subnote">Aún no hay tareas. Lanza una arriba o espera a que el chat cree checkpoints automáticamente.</div>'; return; }
  for (const t of list) {
    const st = TASK_STATUS[t.status] || TASK_STATUS.completed;
    const it = document.createElement('div');
    it.className = 'hitem';
    const d = new Date(t.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const err = t.lastError ? `<small class="md" style="color:var(--danger)">✗ ${esc(t.lastError.step || '')}${t.lastError.tool ? ' · ' + esc(t.lastError.tool) : ''}: ${esc(String(t.lastError.message).slice(0, 120))}</small><br>` : '';
    const live = t.live ? `<small class="md">${t.live.toolCalls || 0} herramientas · ${(t.live.tokensIn || 0) + (t.live.tokensOut || 0)} tok${t.live.costUsd ? ' · $' + t.live.costUsd.toFixed(4) : ''}${t.live.toolsFired && t.live.toolsFired.length ? ' · última: ' + esc(t.live.toolsFired[t.live.toolsFired.length - 1].name) : ''}</small><br>` : '';
    const sched = t.status === 'scheduled' && t.scheduledAt ? `<small class="md">→ ${new Date(t.scheduledAt).toLocaleString('es')}</small><br>` : '';
    it.innerHTML = `<div class="hic">${ic('history')}</div>
      <div class="hmain"><b>${esc(t.goal || '(sin objetivo)')}</b>
        <small><span class="dot ${st.cls}"></span> ${st.label} · paso ${esc(t.step || '—')} · ${t.steps || 0} pasos · ${when}</small><br>
        ${sched}${live}${err}
        ${t.result ? `<small class="md">${esc(String(t.result).slice(0, 140))}</small>` : ''}
      </div>
      ${(t.status === 'running') ? `<button class="btn ghost sq" data-pause title="Pausar">${ic('minimize')}</button>` : ''}
      ${(t.status === 'paused' || t.status === 'interrupted' || t.status === 'failed' || t.status === 'pending') ? `<button class="btn primary sq" data-resume title="Reanudar">${ic('zap')}</button>` : ''}
      ${(t.status === 'scheduled') ? `<button class="btn primary sq" data-runnow title="Ejecutar ahora">${ic('zap')}</button>` : ''}
      ${!['completed', 'failed', 'cancelled'].includes(t.status) ? `<button class="btn ghost sq danger" data-cancel title="Cancelar">${ic('close')}</button>` : ''}
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    const rb = it.querySelector('[data-resume]');
    if (rb) rb.onclick = async (ev) => {
      ev.stopPropagation();
      rb.disabled = true;
      const r = await window.sagitari.taskResume(t.runId);
      if (r && r.ok === false) { showToast(r.error || 'No se pudo reanudar'); rb.disabled = false; }
      renderTasks();
    };
    const pb = it.querySelector('[data-pause]');
    if (pb) pb.onclick = async (ev) => { ev.stopPropagation(); await window.sagitari.taskPause(t.runId); renderTasks(); };
    const sb = it.querySelector('[data-runnow]');
    if (sb) sb.onclick = async (ev) => { ev.stopPropagation(); await window.sagitari.taskResume(t.runId); renderTasks(); };
    const cb = it.querySelector('[data-cancel]');
    if (cb) cb.onclick = async (ev) => { ev.stopPropagation(); await window.sagitari.taskCancel(t.runId); renderTasks(); };
    it.querySelector('[data-del]').onclick = async (ev) => {
      ev.stopPropagation();
      await window.sagitari.taskRemove(t.runId);
      renderTasks();
    };
    box.appendChild(it);
  }
}
$('#tasksRefresh').onclick = () => renderTasks();

// v1.3: crear y programar tareas en background
$('#taskCreate').onclick = async () => {
  const goal = $('#taskGoal').value.trim();
  const msg = $('#taskMsg');
  if (!goal) { msg.textContent = 'Escribe el objetivo de la tarea.'; return; }
  const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: null });
  if (r && r.ok) {
    msg.textContent = 'Tarea en cola (' + r.runId + ').';
    $('#taskGoal').value = '';
    feed('Tarea lanzada en background', 'blu');
    renderTasks();
  } else msg.textContent = (r && r.error) || 'No se pudo crear la tarea.';
  setTimeout(() => { msg.textContent = ''; }, 4000);
};
$('#taskSchedule').onclick = async () => {
  const goal = $('#taskGoal').value.trim();
  const when = $('#taskWhen').value;
  const msg = $('#taskMsg');
  if (!goal) { msg.textContent = 'Escribe el objetivo de la tarea.'; return; }
  if (!when) { msg.textContent = 'Elige fecha y hora.'; return; }
  const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: new Date(when).toISOString() });
  if (r && r.ok) {
    msg.textContent = 'Tarea programada para ' + new Date(when).toLocaleString('es');
    $('#taskGoal').value = ''; $('#taskWhen').value = '';
    renderTasks();
  } else msg.textContent = (r && r.error) || 'No se pudo programar.';
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
  const r = await window.sagitari.openPath($('#projPath').value);
  btn.disabled = false;
  if (r && r.ok) {
    $('#projMsg').textContent = 'Espacio de trabajo activo: ' + (r.workspace || r.path);
    $('#wsPath').value = r.workspace || r.path;
    feed('Espacio de trabajo: ' + (r.workspace || r.path), 'ok');
  } else {
    $('#projMsg').textContent = (r && r.error) || 'No se pudo abrir la ruta.';
  }
  setTimeout(() => { $('#projMsg').textContent = ''; }, 4000);
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
  t.innerHTML = `<span class="dot pur"></span>${esc(text)}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function updateStatusLabels() {
  const a = CFG.active;
  $('#stModel').textContent = a ? a.model : 'sin modelo';
  $('#stConn').textContent = a ? 'Conectado' : 'Desconectado';
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
}

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
  const anim = { think: 'think', work: 'work', listen: 'listen', speak: 'speak', pulse: 'work' }[mode] || 'think';
  shellEl.classList.add('glow-' + anim);
  if (mode === 'pulse') frameGlowTimer = setTimeout(() => shellEl.classList.remove('glow-work'), 2600);
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
function applyTheme() {
  const s = CFG.settings || {};
  const pal = PALETTES[s.uiColor] || PALETTES.violet;
  const gpal = (s.glowColor && s.glowColor !== 'match' && PALETTES[s.glowColor]) ? PALETTES[s.glowColor] : pal;
  const r = document.documentElement.style;
  r.setProperty('--acc-rgb', pal.acc.join(','));
  r.setProperty('--acc2-rgb', pal.acc2.join(','));
  r.setProperty('--acc3-rgb', pal.acc3.join(','));
  r.setProperty('--glow-rgb', gpal.acc2.join(','));
  r.setProperty('--glow-str', String(Math.min(1.4, Math.max(0.4, Number(s.glowStrength) || 1))));
  // refresca las muestras de color de Ajustes si están pintadas
  document.querySelectorAll('.colordot').forEach(d => { d.style.background = ''; });
}
function glowStrengthLabel(v) { return v < 0.8 ? 'Suave' : v <= 1.15 ? 'Equilibrado' : 'Intenso'; }
// cambios hechos desde Ajustes se aplican al vuelo (y desde main, p.ej. relanzar glow)
window.sagitari.onThemeChanged && window.sagitari.onThemeChanged(() => applyTheme());

// ============ init ============
(async function init() {
  await fillSettings();
  applyTheme();            // acento + glow antes del primer frame
  setSendMode();
  // el chat arranca vacío: nada de sellos de hora sueltos, sólo la bienvenida
  resetChatView([]);
  refreshSidebar();
  // la pestaña con la que se abre la app debe quedar marcada en el sidebar
  const on = $('.view.on');
  if (on) $$('.navitem').forEach(b => b.classList.toggle('on', b.dataset.view === on.id.replace('view-', '')));
  feed('Sagitari iniciado', 'ok');
  feed('Esperando peticiones', 'blu');
  if (!CFG.active) {
    const b = ensureAssistantBubble();
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
