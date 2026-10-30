/* SAGITARI renderer — 10-chat.js (antes app.js 1-1339): utilidades, burbujas del chat, tarjetas de herramienta, traza y equipo
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
/* global renderTools, initAboutPanel, pintarDiff, resetChatView, setChatTitle, resetCtxMeter,
   pintarCtxMeter, setSendMode, openConversation, renderEquipo, cargarLimiteEquipo, equipoDe,
   equipoFicha, estadoEquipo, badgeEquipoPermisos, nombreEquipo, resumenEquipo */
/* renderTools está en 40-vistas.js e initAboutPanel en 30-ajustes.js (scope compartido);
   pintarDiff, resetChatView, setChatTitle y openConversation están en 40-vistas.js;
   resetCtxMeter, pintarCtxMeter y setSendMode en 20-app.js; y el estado, las fichas y el
   vocabulario del EQUIPO (equipoDe, equipoFicha, estadoEquipo, badgeEquipoPermisos,
   nombreEquipo, renderEquipo, cargarLimiteEquipo) en 40-vistas.js (v4.4). */
/* exported showEmpty, lastTurnLabel, setChatStatus, ensureThinkBlock, scheduleThinkRender,
   completeToolCard, delegationCard, restaurarTraza, equipoChip, equipoCierra, equipoChat,
   refrescarEquipoChat, mostrarDeshacer, toolChip, todosCard, pinImage, currentConvId, hiloActual,
   cerrarDiffPanel, abrirRuntime, pintarHiloActivo, fijarTurno, eventoDeOtraPestana,
   rtActual, reflejarTurno, pintarPestanas, sysline */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const ic = (n, c) => window.SAGI_ICONS.icon(n, c);
/* ChatKit: modos, catálogo de herramientas, formato de duración y parser de
   planes. Todo eso vive en funciones puras (renderer/chatkit.js) para poder
testearlas de verdad desde Node. */
const K = window.ChatKit;

/* CFG y mode se reasignan desde otros scripts del renderer (30-ajustes.js,
   40-vistas.js, 20-app.js): tienen que ser let. Un commit de lint los dejó como
   const y desde entonces fillSettings() y enviarTexto() rompían con «Assignment
   to constant variable». ESLint no ve las reasignaciones entre ficheros, así que
   se le apaga la regla en estas líneas. */
// eslint-disable-next-line prefer-const
let CFG = { providers: [], active: null, settings: {}, presets: [] };
// eslint-disable-next-line prefer-const
let mode = 'act';

/* ============ conversaciones abiertas: un runtime por pestaña ============
   Antes había UN juego de estado para toda la app (busy, pendingAssistant, pendingTurn,
   lastAssistantEl, lastTurnSummary, currentRunMode) y un solo nodo de mensajes. Por eso
   cambiar de conversación con el agente trabajando estaba PROHIBIDO —la respuesta y su
   guardado acababan en el hilo equivocado—. Ahora cada conversación ABIERTA tiene su
   runtime: su nodo de mensajes dentro de #msgsArea y su propio estado de turno.

   Las variables de siempre pasan a ser una VISTA del runtime activo (ver los accessors
   de más abajo), así que los cuatro scripts siguen leyendo y escribiendo `busy` o
   `pendingTurn` igual que antes, y cada uno opera sobre la conversación que está a la
   vista. Es la superficie mínima para que una pestaña pueda trabajar mientras se usa
   otra, sin reescribir el chat entero. */
const MAX_PESTANAS = 8; // tope de pestañas: al pasarse se cierra la más vieja que no trabaje
const runtimes = new Map(); // id de conversación (null = la de arranque, aún sin id) → runtime
let rtActivo = null;

/** Identificador del nodo de mensajes de una conversación que NO está a la vista. El de
    la activa es `messages` (ver `activarRuntime`). */
function idDeNodo(rt) {
  return 'msgs-' + (rt.id || 'inicial');
}

/** Crea el nodo de mensajes y el estado de turno de una conversación. `el` permite
    adoptar el nodo que ya venía en index.html (la conversación de arranque). */
function crearRuntime(id, el) {
  const cont = el || document.createElement('div');
  cont.className = 'msgs';
  cont.setAttribute('role', 'log');
  cont.setAttribute('aria-live', 'polite');
  cont.setAttribute('aria-relevant', 'additions text');
  cont.setAttribute('aria-label', 'Conversación');
  cont.setAttribute('aria-busy', 'false');
  if (!el) {
    cont.hidden = true;
    ($('#msgsArea') || document.body).appendChild(cont);
  }
  const rt = {
    id: id || null, // id de la conversación en el proceso principal
    el: cont, // su nodo de mensajes
    tab: null, // su pestaña en el strip (la crea `pintarPestanas`)
    titulo: '', // nombre visible: lo fijan setChatTitle y quien abre el hilo
    usado: Date.now(), // última vez que se puso a la vista (desempate de la poda)
    busy: false, // ¿su turno sigue en vuelo?
    pendingAssistant: null, // burbuja del turno en curso
    pendingTurn: null, // estado del turno: grupo de herramientas, plan…
    lastAssistantEl: null, // último bloque de respuesta (para regenerar/copiar)
    lastTurnSummary: '', // resumen del último turno («3 herramientas · 1,4 s»)
    currentRunMode: 'act', // modo con el que se lanzó su turno en curso
    estado: null, // último {texto, tipo} de la barra de estado
    ctx: null, // último evento `context` (el medidor es de cada conversación)
    cambios: [], // archivos que tocó su turno (barra de deshacer)
    pinned: true, // ¿la vista seguía el final del hilo?
    stampDia: null, // último separador de día estampado en ESTE hilo
    ro: null, // ResizeObserver de su nodo: se desconecta al cerrar la pestaña
  };
  /* El desplazamiento es del NODO, no de la app: «seguir el stream sólo si estabas
     abajo» se decide con el `pinned` de la conversación a la que pertenece el nodo. El
     botón de bajar se busca aquí dentro porque los runtimes se crean al vuelo, incluso
     antes de que este archivo termine de cargarse. */
  cont.addEventListener('scroll', () => {
    rt.pinned = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 70;
    const jd = $('#jumpDown');
    if (rt === rtActivo && jd) jd.hidden = rt.pinned;
  });
  if (window.ResizeObserver) {
    /* Se guarda en el runtime para poder desconectarlo al cerrar la pestaña: un
       ResizeObserver mantiene su target —el nodo con todo el hilo dentro— vivo hasta
       que se desconecta. */
    rt.ro = new ResizeObserver(() => {
      if (rt.pinned) cont.scrollTop = cont.scrollHeight;
    });
    rt.ro.observe(cont);
  }
  return rt;
}

/** El runtime de la conversación que está a la vista. Se crea al vuelo la primera vez:
    la app arranca con el nodo `#messages` de index.html y todavía sin id. */
function rtActual() {
  if (!rtActivo) {
    const rt = crearRuntime(null, $('#messages'));
    runtimes.set(null, rt);
    activarRuntime(rt);
  }
  return rtActivo;
}

/** Pone `rt` a la vista: su nodo pasa a ser `#messages` y el de la anterior se queda
    oculto en #msgsArea. `#messages` sigue significando «el hilo en pantalla» porque el
    identificador VIAJA con la pestaña que se abre: nunca hay dos nodos con él. */
function activarRuntime(rt) {
  const previo = rtActivo;
  if (previo && previo !== rt) {
    previo.el.hidden = true;
    if (previo.el.id === 'messages') previo.el.id = idDeNodo(previo);
  }
  rtActivo = rt;
  rt.usado = Date.now();
  rt.el.hidden = false;
  rt.el.id = 'messages';
  pintarPestanas();
  return rt;
}

/** Refleja el estado de turno de una conversación donde se ve: la pestaña y el
    `aria-busy` de SU nodo (los lectores de pantalla esperan a que termine el turno de
    esa conversación, no el de la que estés mirando). */
function reflejarTurno(rt) {
  if (!rt || !rt.el) return;
  rt.el.setAttribute('aria-busy', rt.busy ? 'true' : 'false');
  if (rt.tab) {
    rt.tab.classList.toggle('busy', rt.busy);
    if (rt.tab.isConnected) pintarPestana(rt);
  }
}

/* El estado del turno y de la vista del hilo es el de la conversación ACTIVA. Se define
   como propiedad del objeto global —los demás scripts son clásicos y comparten ese
   objeto— para no tocar NINGUNO de sus usos: `busy = true` sigue siendo una asignación,
   pero va al runtime de la conversación abierta, no a una variable de toda la app. */
for (const campo of ['pendingAssistant', 'pendingTurn', 'lastAssistantEl', 'lastTurnSummary', 'currentRunMode', 'pinned', 'stampDia']) {
  Object.defineProperty(window, campo, {
    configurable: true,
    get: () => rtActual()[campo],
    set: (v) => {
      rtActual()[campo] = v;
    },
  });
}
Object.defineProperty(window, 'busy', {
  configurable: true,
  get: () => rtActual().busy,
  set: (v) => {
    const rt = rtActual();
    rt.busy = !!v;
    reflejarTurno(rt); // su pestaña y su nodo dicen «trabajando» al instante
  },
});
/* Y el nodo de mensajes, con el mismo truco: `msgs` sigue siendo el hilo que se pinta,
   pero ahora es el de la conversación abierta (no siempre el mismo nodo). */
Object.defineProperty(window, 'msgs', {
  configurable: true,
  get: () => rtActual().el,
});

/* ---- pestañas de conversaciones abiertas -------------------------------------------
   Mismo patrón que las pestañas de Ajustes (role=tablist en el contenedor, role=tab en
   cada pestaña, aria-selected, roving tabindex —sólo la abierta entra en el orden de
   tabulación— y flechas/Inicio/Fin para moverse). Aquí cada pestaña lleva DENTRO su
   botón de cerrar, así que la pestaña es un div con role=tab (un button dentro de otro
   button no es HTML válido) y el cierre queda fuera del orden de tabulación: se cierra
   con el ratón o con Supr desde la pestaña enfocada. */

/** Crea la pestaña de un runtime (la cuelga del strip). */
function crearPestana(rt) {
  const strip = $('#convTabs');
  const t = document.createElement('div');
  t.className = 'ctab';
  t.setAttribute('role', 'tab');
  t.dataset.conv = rt.id || '';
  const dot = document.createElement('span');
  dot.className = 'ctab-dot';
  dot.setAttribute('aria-hidden', 'true');
  const nombre = document.createElement('span');
  nombre.className = 'ctab-name';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'ctab-x';
  x.tabIndex = -1; // la tira es UNA parada de tabulación, no ocho
  x.innerHTML = ic('close');
  t.append(dot, nombre, x);
  t.addEventListener('click', (ev) => {
    if (ev.target.closest('.ctab-x')) return; // cerrar no es abrir
    if (rt === rtActivo || !rt.id) return;
    /* Cambiar de hilo lleva el foco al compositor (lo hace `goto('chat')`), y la tira es
       un tablist: si el cambio vino de aquí, el foco se devuelve a la pestaña, o la
       siguiente flecha no tendría dónde apoyarse. */
    Promise.resolve(openConversation(rt.id, rt.titulo)).then(() => {
      if (rt.tab && rt.tab.isConnected) rt.tab.focus();
    }).catch((e) => console.warn('no se pudo abrir la conversación:', e && e.message));
  });
  t.addEventListener('keydown', (ev) => {
    // un div con role=tab no se activa solo: Enter y espacio son suyos
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    t.click();
  });
  x.addEventListener('click', (ev) => {
    ev.stopPropagation();
    cerrarPestana(rt);
  });
  if (strip) strip.appendChild(t);
  rt.tab = t;
  return t;
}

/** Pone al día una pestaña: nombre, ocupada y seleccionada. El nombre lo controla el
    usuario, así que va por textContent (nunca por HTML). */
function pintarPestana(rt) {
  const t = rt.tab;
  if (!t) return;
  const nombre = rt.titulo || 'Nueva conversación';
  const on = rt === rtActivo;
  t.classList.toggle('busy', rt.busy);
  t.classList.toggle('on', on);
  t.setAttribute('aria-selected', on ? 'true' : 'false');
  /* Roving tabindex: sólo la pestaña abierta entra en el orden de tabulación; para
     moverse entre pestañas están las flechas (ver el keydown del strip). */
  t.setAttribute('tabindex', on ? '0' : '-1');
  // señala el nodo que controla (el de la activa es el `#messages` de la vista)
  t.setAttribute('aria-controls', on ? 'messages' : idDeNodo(rt));
  t.setAttribute('aria-label', 'Conversación «' + nombre + '»' + (rt.busy ? ' — trabajando ahora' : ''));
  t.title = nombre;
  // el id se fija también aquí: la pestaña de arranque se ADOPTA (pasa de no tener id a
  // tenerlo) y su pestaña ya estaba creada
  t.dataset.conv = rt.id || '';
  const etiqueta = t.querySelector('.ctab-name');
  if (etiqueta) etiqueta.textContent = nombre;
  const x = t.querySelector('.ctab-x');
  if (x) x.setAttribute('aria-label', 'Cerrar la pestaña de «' + nombre + '» (la conversación sigue en Historial)');
}

/** Pinta el strip. Se pone al día EN SU SITIO (no se rehace el innerHTML) para no perder
    el foco al cambiar de pestaña con las flechas. */
function pintarPestanas() {
  const strip = $('#convTabs');
  if (!strip) return;
  for (const rt of runtimes.values()) {
    if (!rt.tab) crearPestana(rt);
    pintarPestana(rt);
  }
  /* Con una sola conversación abierta la tira repetía el título de la cabecera: se
     enseña en cuanto hay algo entre lo que cambiar y se retira cuando no. */
  strip.hidden = runtimes.size <= 1;
}

/** Pone a la vista la conversación `id`, creando su pestaña si es la primera vez. NO
    repinta su historial: eso es cosa de quien conoce el camino (openConversation, con
    `conv:open`). Devuelve su runtime. */
function abrirRuntime(id) {
  const clave = id || null;
  let rt = runtimes.get(clave);
  if (!rt) {
    const arranque = runtimes.get(null);
    if (clave && runtimes.size === 1 && arranque) {
      /* La pestaña de arranque (todavía sin id) se ADOPTA cuando llega el primer hilo:
         es la misma vista vacía con la que se abrió la app; no hay dos. */
      runtimes.delete(null);
      arranque.id = clave;
      rt = arranque;
    } else {
      rt = crearRuntime(clave);
    }
    runtimes.set(clave, rt);
  }
  activarRuntime(rt);
  podarPestanas();
  pintarPestanas();
  return rt;
}

/** Cierra la pestaña de un runtime. La conversación NO se borra —borrar es cosa del
    Historial—: sólo se sueltan su nodo y su estado. Si era la que estaba a la vista,
    pasa a la más reciente de las que quedan. */
function cerrarPestana(rt) {
  if (!rt || runtimes.get(rt.id) !== rt) return;
  if (runtimes.size <= 1) {
    showToast('Es la única conversación abierta: cambia a otra o abre una nueva');
    return;
  }
  const otras = [...runtimes.values()].filter((r) => r !== rt);
  /* Si la que se cierra es la que está a la vista, la siguiente se pone YA —sin esperar
     a que llegue su historial—: el hilo abierto no puede quedarse ni un momento sin nodo
     montado, o lo que se escribiera en ese hueco acabaría en un nodo suelto. */
  if (rt === rtActivo) {
    const siguiente = otras.sort((a, b) => b.usado - a.usado)[0];
    currentConvId = siguiente.id; // el hilo abierto es ya el siguiente
    activarRuntime(siguiente);
    pintarHiloActivo();
    if (siguiente.id) openConversation(siguiente.id, siguiente.titulo); // y su historial
  }
  if (rt.tab) rt.tab.remove();
  /* El observador se desconecta ANTES de soltar el nodo: mientras siga vivo mantiene
     su target —el árbol de mensajes entero— retenido, aunque ya no esté en el documento. */
  if (rt.ro) {
    rt.ro.disconnect();
    rt.ro = null;
  }
  rt.el.remove();
  runtimes.delete(rt.id);
  pintarPestanas();
}

/** Tope de pestañas ABIERTAS: por encima de MAX_PESTANAS se cierra la menos usada de las
    que NO estén trabajando —una que trabaja no se cierra nunca: su turno sigue vivo en
    el proceso principal—. Cerrar una pestaña no borra nada: la conversación sigue en el
    Historial y se vuelve a abrir desde ahí. */
function podarPestanas() {
  while (runtimes.size > MAX_PESTANAS) {
    const cand = [...runtimes.values()].filter((r) => r !== rtActivo && !r.busy).sort((a, b) => a.usado - b.usado)[0];
    if (!cand) return; // todas las demás están trabajando: se quedan abiertas
    cerrarPestana(cand);
  }
}

/* Flechas del tablist: mueven el foco Y activan (el mismo modelo que el clic), igual que
   en las pestañas de Ajustes. Supr cierra la pestaña enfocada: es la única forma de
   cerrar por teclado (el botón × está fuera del orden de tabulación a propósito). */
if ($('#convTabs'))
  $('#convTabs').addEventListener('keydown', (e) => {
    const tabs = [...$('#convTabs').querySelectorAll('.ctab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const rt = [...runtimes.values()].find((r) => r.tab === tabs[i]);
      if (rt) {
        e.preventDefault();
        cerrarPestana(rt);
      }
      return;
    }
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    tabs[j].focus();
    tabs[j].click();
  });

/** Atiende un evento que es de OTRA conversación abierta. No pinta nada en el chat que
    está a la vista —ese chat es de otro hilo—, pero deja al día SU pestaña (ocupada, con
    cambios que deshacer) para que diga la verdad; su historial se repinta desde el
    proceso principal al volver a ella. Devuelve true: el evento ya está atendido. */
function eventoDeOtraPestana(ev) {
  const rt = runtimes.get(ev.convId);
  if (!rt) return true; // su pestaña no está abierta: ni que pintar ni que marcar
  switch (ev.type) {
    case 'busy':
      rt.busy = !!ev.busy;
      if (ev.busy && ev.mode) rt.currentRunMode = K.mode(ev.mode).key;
      reflejarTurno(rt);
      break;
    case 'assistant_done':
    case 'stopped':
    case 'paused':
    case 'error':
      // el turno de esa conversación ya no sigue: deja de estar ocupada
      rt.busy = false;
      reflejarTurno(rt);
      break;
    case 'can_undo':
      // sus cambios son suyos: la barra de deshacer se ofrecerá al volver a su pestaña
      rt.cambios = Array.isArray(ev.files) ? ev.files : [];
      break;
    case 'guardrail':
      /* El turno de esa conversación se detuvo por un tope de seguridad. Su tarjeta y su
         chip son suyos (no se pintan aquí), pero el aviso es de la app y conviene verlo:
         sin esto, un tope en la pestaña de al lado pasaba en silencio. */
      rt.busy = false;
      reflejarTurno(rt);
      showToast('Límite de seguridad: ' + String(ev.reason || '').slice(0, 100));
      feed('Límite de seguridad', 'err');
      break;
    case 'context':
      rt.ctx = ev;
      break;
    default:
      break;
  }
  return true;
}

/** Devuelve el compositor y la insignia del sidebar al estado de turno que dice el
    proceso principal: al volver a una pestaña que siguió trabajando, su botón tiene que
    volver a ser «Detener». */
function fijarTurno(hay) {
  busy = !!hay;
  setSendMode();
  syncChatBadge();
}

/** Pinta lo que NO vive en el nodo de mensajes —título, barra de estado, medidor de
    contexto y barra de deshacer— con lo de la conversación que está a la vista: son
    cuatro sitios únicos para toda la app, y al cambiar de pestaña tienen que contar lo
    de la que entra. */
function pintarHiloActivo() {
  const rt = rtActual();
  setChatTitle(rt.titulo || 'Nueva conversación', false); // su nombre ya está guardado
  if (rt.estado) setChatStatus(rt.estado.texto, rt.estado.tipo);
  else setChatStatus('');
  if (rt.ctx) pintarCtxMeter(rt.ctx);
  else resetCtxMeter();
  // el estado vacío es una capa compartida: se enseña el de ESTA conversación
  if (rt.el.querySelector('.msg')) hideEmpty();
  else showEmpty();
  cerrarDiffPanel(); // el panel enseña los archivos de un turno: los de la otra pestaña no valen
  sincronizarDeshacer();
  fijarTurno(rt.busy); // el botón del compositor: «Enviar» o «Detener», según SU turno
}

/** La barra de deshacer es de la conversación que hizo los cambios: al cambiar de
    pestaña se pregunta por los SUYOS (los de la otra no se ofrecen aquí). */
async function sincronizarDeshacer() {
  const rt = rtActual();
  let archivos = rt.cambios || [];
  if (rt.id && window.sagitari.undoState) {
    try {
      const r = await window.sagitari.undoState(rt.id);
      if (r && r.ok) archivos = r.puede ? r.archivos || [] : [];
    } catch {}
  }
  if (rt !== rtActivo) return; // mientras se preguntaba, el usuario cambió otra vez
  if (archivos.length) mostrarDeshacer(archivos);
  else ocultarDeshacer();
}

/* Hilo abierto. Se declara AQUÍ y sólo aquí: los scripts comparten el ámbito global, así
   que una segunda declaración (let/const/var) en otro fichero es un SyntaxError que deja
   la app entera sin arrancar. Lo fijan los tres caminos que cambian de conversación
   (conv:new, conv:open y conv:fork, en 40-vistas.js) y lo leen el rebobinado y /compact. */
let currentConvId = null;

/** El hilo abierto tal y como lo dejó el último cambio de conversación. `null` cuando
    todavía no se sabe: el proceso principal cae entonces a SU conversación actual. */
function hiloActual() {
  return typeof currentConvId === 'string' && currentConvId ? currentConvId : null;
}

// ============ icon injection ============
$$('[data-i]').forEach((el) => {
  el.innerHTML = ic(el.dataset.i);
});

// ============ red de seguridad del renderer ============
/* Un error de script aquí dejaba la interfaz muda: la ventana sigue abierta
   pero sin iconos y sin botones, y no hay forma de saber por qué. Estos dos
   avisos lo hacen visible en el propio chat, en el feed y por toast; el
   contador (window.__errores) lo usa la comprobación automática de interfaz. */
window.__errores = [];
function reportarError(origen, detalle) {
  const msg = String((detalle && (detalle.message || (detalle.reason && detalle.reason.message))) || detalle || 'desconocido');
  window.__errores.push(origen + ': ' + msg);
  try {
    feed('Fallo en la interfaz — ' + K.clip(msg, 80), 'err');
  } catch {}
  try {
    showToast('La interfaz encontró un problema: ' + K.clip(msg, 120));
  } catch {}
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
$$('.navitem').forEach((b) => b.addEventListener('click', () => goto(b.dataset.view)));
function goto(view, opts) {
  // una vista inexistente (Alt+0, un data-view roto…) dejaba TODAS las
  // secciones ocultas: la app se quedaba en blanco. Sin destino, no se toca nada.
  const target = document.getElementById('view-' + view);
  if (!target) return;
  $$('.navitem').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + view));
  // la vista activa queda marcada en la carcasa: el rail lateral solo se pinta
  // donde aporta (chat y agentes); en el resto de vistas está vacío
  const shell = $('#app');
  if (shell) shell.dataset.view = view;
  if (view === 'chat') $('#chatInput').focus();
  else if (opts && opts.focus) {
    // cambio de vista por atajo: el foco caía a <body>; se lleva al título de la vista
    const h = target.querySelector('h2');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus();
    }
  }
  if (view === 'memory') renderMemoria();
  if (view === 'tasks') renderTasks();
  if (view === 'tools') renderTools();
  if (view === 'mcp') renderMcp();
  if (view === 'agents') {
    renderToolTray();
    renderHealth();
    renderHabits();
  }
  if (view === 'skills') {
    renderMarket();
    renderSkills();
  }
  if (view === 'projects')
    window.sagitari.workspaceGet().then((w) => {
      $('#projPath').value = w;
    }).catch((e) => console.warn('no se pudo leer la carpeta de trabajo:', e && e.message));
  if (view === 'equipo') {
    renderEquipo(); // lo que ya se sabe, al instante
    // el tope de compañeros vive en el motor (meta:get): cuando llegue, se completa la nota
    cargarLimiteEquipo().then(renderEquipo).catch((e) => console.warn('no se pudo cargar el tope del equipo:', e && e.message));
  }
  if (view === 'history') renderHistory();
  if (view === 'settings') {
    showSetTab(setTabName);
    initDataPanel();
    initAboutPanel();
  }
  polishSwitches(); // los interruptores creados dinámicamente también deben ser accesibles
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
  try {
    localStorage.setItem('sagi.sideCompact', on ? '1' : '0');
  } catch {}
}
$('#sideToggle').onclick = () => applyCompact(!$('#app').classList.contains('compact'));
try {
  if (localStorage.getItem('sagi.sideCompact') === '1') applyCompact(true);
} catch {}

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
/* Meta de cada modo para la píldora del sidebar (define 40-vistas.js con una sola
   fuente de verdad, ChatKit). Vive aquí porque quien la pinta es setSideActive. */
const MODE_META = Object.fromEntries(
  K.MODE_ORDER.map((k) => {
    const m = K.MODES[k];
    return [k, { dot: m.dot, label: m.label, desc: m.tagline, icon: m.icon, name: m.name, rgb: m.rgb }];
  }),
);
function setSideActive() {
  const sm = $('#sideModeBtn');
  if (!sm) return;
  const m = MODE_META[mode] || MODE_META.act;
  sm.classList.remove('act', 'plan', 'think', 'equipo');
  sm.classList.add(mode);
  const d = sm.querySelector('.dot');
  if (d) d.className = 'dot ' + m.dot;
  $('#sideModeLabel').textContent = m.label;
  sm.title = `Modo ${m.label} — ${m.desc} (Alt+M)`;
}

let sideBadgeErr = false; // evita repetir el aviso en cada sondeo
async function refreshSidebar() {
  if (document.hidden) return; // sin ventana visible no hay nada que pintar
  syncChatBadge();
  try {
    // las tres lecturas son independientes: lanzarlas en paralelo hace que el
    // sondeo cueste una latencia en vez de tres encadenadas cada 3s
    const [tasks, mem, sk] = await Promise.all([window.sagitari.tasksList(), window.sagitari.memoryList(), window.sagitari.skillsList()]);
    const live = ['running', 'pending', 'scheduled', 'paused', 'interrupted'];
    const n = tasks.filter((t) => live.includes(t.status)).length;
    setBadge('#nbTasks', n, { hot: tasks.some((t) => t.status === 'running') });
    setBadge('#nbMemory', mem.length);
    setBadge('#nbSkills', sk.length);
    sideBadgeErr = false;
  } catch (e) {
    // un canal IPC caído NO es «cero tareas»: avisa una vez con el error real
    if (!sideBadgeErr) {
      sideBadgeErr = true;
      const msg = String((e && e.message) || e || 'error desconocido');
      feed('No se pudo leer el estado lateral — ' + K.clip(msg, 80), 'err');
      showToast('No se pudo leer el estado: ' + K.clip(msg, 120));
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
  if (e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    $('#sideToggle').click();
    return;
  }
  // Alt+0 sigue sin vista asignada: VIEW_HOTKEY llega hasta Alt+9 y la vista Equipo de v4.4
  // se abre como MCP, desde su sección del menú (sin atajo propio)
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
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* --- saneado previo a la inserción ---
   El markdown lo produce el MODELO, así que nada de su HTML puede tocar el DOM
   real sin filtrarse antes. Se parsea en un documento INERTE (DOMParser: las
   imágenes no disparan ninguna petición y <style>/<base>/<link> no se aplican),
   se descarta todo lo que no esté en la whitelist y cualquier src/href que no
   sea data: o http(s):. */
const OK_TAGS = new Set([
  'P',
  'BR',
  'UL',
  'OL',
  'LI',
  'CODE',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'A',
  'STRONG',
  'EM',
  'DEL',
  'HR',
  'SPAN',
  'DIV',
]);
// etiquetas que se ELIMINAN con su contenido: nunca se muestran ni se conservan
const DROP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'BASE',
  'LINK',
  'META',
  'TITLE',
  'HEAD',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'NOSCRIPT',
  'TEMPLATE',
  'OBJECT',
  'EMBED',
  'APPLET',
  'SVG',
  'MATH',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'FORM',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'LABEL',
  'MARQUEE',
]);
// atributos sin valor ejecutable que marked sí genera (presentación/tablas)
const OK_ATTRS = new Set(['class', 'title', 'alt', 'colspan', 'rowspan', 'align', 'start']);

function safeUrl(v) {
  const u = String(v || '').trim();
  return /^(data:|https?:)/i.test(u) ? u : '';
}

function cleanNode(node) {
  if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== 1) return document.createDocumentFragment(); // comentarios, etc.
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
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement.classList.contains('codeblock')) return;
    const cls = String(code.className || '').match(/language-([\w+#-]+)/);
    const lang = cls ? cls[1] : '';
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    const head = document.createElement('div');
    head.className = 'codeblock-head';
    head.innerHTML =
      `<span>${esc(lang || 'código')}</span>` + `<button class="cb-copy" data-copy title="Copiar código">${ic('copy')}</button>`;
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
/* `msgs` (el nodo del hilo a la vista) y `pinned` (si la vista seguía el final) son de
   la conversación ABIERTA: los define el runtime de 10-chat.js (arriba). El nodo de
   arranque es el `#messages` de index.html y lo adopta el primer runtime. */
const chatEmpty = $('#chatEmpty');
const jumpDownBtn = $('#jumpDown');

/* --- desplazamiento inteligente: seguir el stream SÓLO si estás abajo del
todo. Si te has ido a leer hacia arriba, la vista no te arrastra. El listener vive en
cada nodo (lo engancha `crearRuntime`): aquí sólo queda el botón de bajar. --- */
jumpDownBtn.onclick = () => {
  pinned = true;
  jumpDownBtn.hidden = true;
  scroll(true);
};
function scroll(force) {
  if (force || pinned) msgs.scrollTop = msgs.scrollHeight;
}
/* Las imágenes y capturas terminan de cargar DESPUÉS de pintar: la altura del
   hilo crece y el scroll se quedaba a medio camino. Reajustamos el final sólo
   si el usuario venía siguiendo el stream (pinned). */
function pinImage(img) {
  if (!img) return;
  const fix = () => {
    if (pinned) scroll();
  };
  img.addEventListener('load', fix);
  img.addEventListener('error', fix);
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
   como un separador temporal. `stampDia` es del hilo abierto (lo define su runtime),
   así que cada conversación estampa el suyo y al cambiar de pestaña no se arrastra
   el día de la anterior. */
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
function hideEmpty() {
  if (chatEmpty) chatEmpty.hidden = true;
}
/* `showEmpty` lo llaman DOS sitios: `resetChatView` (40-vistas.js) cuando la conversación
   que se acaba de pintar está vacía —o sea, al empezar una nueva— y `pintarHiloActivo`
   al cambiar de pestaña a una que lo esté. Es el punto exacto para tirar lo que era del
   hilo anterior: el medidor de contexto (todavía no se ha enviado nada que medir) y la
   revisión de cambios (no hay turno que revisar). */
function showEmpty() {
  if (chatEmpty) chatEmpty.hidden = false;
  resetCtxMeter();
  cerrarDiffPanel();
}

/** Aplica el color del modo a toda la vista del chat (--mode-c). */
function applyModeTheme(m) {
  const M = K.mode(m);
  $('#view-chat').dataset.mode = M.key;
  return M;
}

/** Resumen legible del último turno, para la barra de estado y el feed. */
function lastTurnLabel() {
  return lastTurnSummary;
}

/** Barra de estado en vivo junto al título: qué está haciendo y en qué modo.
    Es una sola para toda la app, así que el texto se guarda en el runtime de la
    conversación abierta: al volver a su pestaña se rehace con lo que decía la suya. */
function setChatStatus(text, kind) {
  const box = $('#chatStatus');
  rtActual().estado = text ? { texto: text, tipo: kind || null } : null;
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
  if (!s.trim()) {
    showToast('No hay nada que copiar');
    return false;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(s);
    else {
      const ta = document.createElement('textarea');
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(okMsg || 'Copiado al portapapeles');
    return true;
  } catch {
    showToast('No se pudo copiar');
    return false;
  }
}

/**
 * Línea del sistema dentro del hilo (clase `.sysline`, ver styles.css): la salida de una
 * orden de barra —/cost, /compact— o el motivo por el que no se pudo hacer. NO es un
 * turno: no lleva avatar ni burbuja ni viaja al modelo. La usa el compositor (20-app.js)
 * al despachar `K.parseCommand`.
 */
function sysline(texto) {
  const el = document.createElement('div');
  el.className = 'sysline';
  el.textContent = String(texto == null ? '' : texto);
  rtActual().el.appendChild(el);
  scroll(true);
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
  const ts = nowClock(o.ts);
  /* Dos entregas del agente en el mismo minuto (plan y resultado) son el mismo turno
     a la vista: la segunda no repite cara, nombre ni hora (ver .msg.cont). */
  const prev = msgs.lastElementChild;
  const prevTs =
    prev && prev.classList.contains('msg') && prev.classList.contains('ai') && prev.querySelector('.msg-ts');
  if (role !== 'user' && prevTs && prevTs.textContent === ts) m.classList.add('cont');
  const av = document.createElement('div');
  av.className = 'avatar';
  if (role === 'user') {
    // la inicial es el primer PUNTO DE CÓDIGO: cortar por unidades UTF-16 partía el
    // emoji de un nombre y dejaba media mitad en el avatar
    av.textContent = (Array.from(CFG.settings.userName || 'Tú')[0] || 'T').toUpperCase();
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
  head.innerHTML =
    `<span class="msg-who">${esc(role === 'user' ? CFG.settings.userName || 'Tú' : 'Sagitari')}</span>` +
    `<span class="msg-ts">${ts}</span>`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  const b = document.createElement('div');
  b.className = 'bubble';
  body.appendChild(b);
  col.append(head, body);
  m.append(av, col);
  msgs.appendChild(m);
  /* Sobre el mensaje del usuario también se puede volver atrás (rebobinar tira ese turno y
     todo lo posterior: es lo que se quiere al reescribir una petición). Sólo eso: copiar su
     propio mensaje no aporta nada que no esté ya en pantalla. */
  if (role === 'user') msgActions(body, '', { onlyRewind: true });
  scroll();
  return b;
}

/** Acciones al pie de un turno: copiar, regenerar (sólo el último) y volver atrás. */
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
  if (!o.onlyRewind)
    row.appendChild(
      mk('copy', 'Copiar este mensaje', () => {
        const bub = holder.querySelector('.bubble') || holder;
        // el razonamiento es interno: al copiar el mensaje se copia la respuesta, no
        // lo que el modelo pensó por el camino (el bloque tiene su propio botón)
        const copia = bub.cloneNode(true);
        copia.querySelectorAll('.thinkblock').forEach((x) => x.remove());
        copyText(copia.innerText, 'Mensaje copiado');
      }),
    );
  if (o.retry) row.appendChild(mk('refresh', 'Regenerar esta respuesta', regenerate));
  /* F7: volver el hilo hasta aquí — se conserva lo anterior y se tira este mensaje con
     todo lo que venga después. Sólo se ofrece en mensajes que existen de verdad en el
     hilo guardado (el índice sale del DOM: ver `indiceMensaje`). */
  const idx = indiceMensaje(holder);
  if (idx >= 0) {
    const rb = mk('history', 'Volver el hilo hasta aquí', () => rebobinarHilo(idx, rb));
    rb.dataset.rewind = String(idx);
    rb.setAttribute('aria-label', 'Volver el hilo hasta aquí');
    row.appendChild(rb);
  }
  // una fila sin nada que ofrecer no se pinta: el mensaje se queda sin pie
  if (!row.children.length) return null;
  holder.appendChild(row);
  return row;
}

/** Sólo el último turno del agente ofrece «Regenerar»: los anteriores ya están superados. */
function refreshMsgActions() {
  const all = msgs.querySelectorAll('.msg.ai');
  all.forEach((m, i) => {
    m.querySelectorAll('[data-retry]').forEach((b) => b.remove());
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

/**
 * Índice de un mensaje dentro del hilo guardado, sacado del propio DOM.
 * #messages va EN ORDEN: `resetChatView` pinta los mensajes del hilo de uno en uno y las
 * burbujas de un turno en vivo se añaden al final, así que la posición entre los `.msg`
 * es la posición en la conversación. Devuelve -1 si el elemento no es un mensaje del hilo
 * (una burbuja que no se ha guardado, por ejemplo el saludo de arranque sin modelo).
 */
function indiceMensaje(holder) {
  const m = holder.closest ? holder.closest('.msg') : null;
  if (!m || !msgs.contains(m)) return -1;
  return [...msgs.querySelectorAll(':scope > .msg')].indexOf(m);
}

/**
 * F7: rebobina el hilo hasta el mensaje `idx` — se conserva lo anterior y se tira ese
 * mensaje con todo lo posterior. Trunca de verdad (no hay vuelta atrás), así que pasa por
 * la confirmación de la casa; y al terminar se repinta la conversación por el MISMO camino
 * que abrirla, para que los sellos de día, las tarjetas y los pies de acciones se rehagan.
 */
async function rebobinarHilo(idx, btn) {
  // la barra de confirmación se inserta justo debajo del mensaje que se va a tirar
  const ancla = btn.closest ? btn.closest('.msg') : null;
  btn.disabled = true;
  try {
    const ok = await askConfirm(
      ancla,
      '¿Volver el hilo hasta aquí?',
      'Se descartarán este mensaje y todos los siguientes. Lo anterior se conserva y sigues en la misma conversación.',
    );
    if (!ok) return;
    const r = await window.sagitari.convRebobinar(hiloActual(), idx);
    if (!r || r.ok === false) {
      showToast('No se pudo rebobinar: ' + ((r && r.error) || 'error desconocido'));
      return;
    }
    const mensajes = r.messages || [];
    cerrarDiffPanel();
    resetCtxMeter();
    // el hilo YA está truncado en main: si el chat no puede repintarse ahora (ejecución en
    // vuelo), se dice y no se pinta un título que no corresponde al hilo guardado
    if (resetChatView(mensajes) === false) return;
    setChatTitle((mensajes.find((m) => m.role === 'user') || {}).content || 'Nueva conversación');
    feed('Hilo rebobinado a un punto anterior', 'blu');
    showToast('Hilo rebobinado');
  } finally {
    btn.disabled = false;
  }
}

async function regenerate() {
  if (busy) {
    showToast('Espera a que termine la ejecución actual');
    return;
  }
  const last = lastAssistantEl;
  const msgEl = last ? last.closest('.msg') : null;
  const parent = msgEl ? msgEl.parentNode : null;
  const nextSibling = msgEl ? msgEl.nextSibling : null;
  if (msgEl) msgEl.remove();
  lastAssistantEl = null;
  showToast('Regenerando respuesta…');
  let r;
  try {
    r = await window.sagitari.retryChat(hiloActual());
  } catch (e) {
    r = { ok: false, error: (e && e.message) || e };
  }
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
    /* El turno es una COLUMNA de bloques, no un campo de texto: cada tramo de narración,
       cada tanda de herramientas y el razonamiento son piezas con su propia piel, en el
       orden en que ocurrieron. Antes todo caía dentro de una sola burbuja y una respuesta
       de veinte pasos se leía como un muro de prosa (queja literal del usuario: «aglutina
       toda la información»). */
    pendingAssistant.classList.add('blocks');
    pendingTurn = {
      mode: currentRunMode,
      group: null,
      body: null,
      cards: [],
      tools: 0,
      totalMs: 0,
      plan: null,
      planIdx: 0,
      team: null, // v2.2: tablero del equipo (delegaciones en vivo)
      think: null, // v2.3: bloque de razonamiento (Ajustes ▸ Agente)
      fails: 0, // herramientas que fallaron (la cabecera del grupo lo enseña)
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
  head.innerHTML =
    `<span class="tg-ic">${ic('tools')}</span><b class="tg-title">Herramientas</b>` +
    `<span class="tg-fails" hidden></span>` +
    `<span class="tg-meta"></span><span class="tg-chev">${ic('chevron')}</span>`;
  const body = document.createElement('div');
  body.className = 'tgroup-body';
  const toggle = () => {
    const open = g.classList.toggle('open');
    g.classList.toggle('closed', !open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    g._tocado = true; // el usuario decide: el cierre automático ya no lo pisa
  };
  head.onclick = toggle;
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  g.append(head, body);
  return {
    el: g,
    body,
    head,
    title: head.querySelector('.tg-title'),
    meta: head.querySelector('.tg-meta'),
    fails: head.querySelector('.tg-fails'),
  };
}

function ensureToolGroup() {
  const b = ensureAssistantBubble();
  /* Una tanda de herramientas por BLOQUE: si después del grupo se escribió narración, la
     herramienta siguiente abre un grupo nuevo debajo de ese texto —así cada tanda queda
     donde ocurrió y no todo agrupado al final del turno—. Sin esto, el grupo era único y
     el hilo no se podía leer en orden. */
  if (!pendingTurn.group || !pendingTurn.group.el.isConnected || b.lastElementChild !== pendingTurn.group.el) {
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
  const enCurso = pendingTurn.cards.filter((c) => c.classList.contains('run')).length;
  g.meta.textContent = enCurso ? enCurso + ' en curso' : pendingTurn.totalMs ? K.fmtDuration(pendingTurn.totalMs) : '';
  /* Y si algo falló, la cabecera lo dice: con el grupo plegado, un fallo dentro era
     invisible hasta abrirlo a mano. */
  const fallos = pendingTurn.fails || 0;
  if (g.fails) {
    g.fails.hidden = !fallos;
    g.fails.textContent = fallos === 1 ? '1 fallo' : fallos + ' fallos';
  }
  g.el.classList.toggle('has-fails', !!fallos);
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
    .map((l) =>
      l
        .replace(/^[\s>*#\-•]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .filter((l) => l.length >= 18);
  const t = lineas[0] || '';
  return K.clip(t, max);
}

/** Cuántas líneas tiene el razonamiento (dato barato que da idea de su profundidad). */
function nLineas(texto) {
  return String(texto || '')
    .split(/\r?\n/)
    .filter((l) => l.trim()).length;
}

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
  // la luz que late es señal de «sigue pensando», no de «está abierto»: un bloque ya
  // terminado no puede quedarse parpadeando para siempre
  d.classList.toggle('th-vivo', !d._terminado); // no `live`: esa clase es de la barra lateral (display:flex)
  const pasos = d._pasos || nLineas(d._texto);
  if (!d._terminado) {
    el.classList.remove('gist');
    el.textContent = 'pensando… ' + segundosUI(Date.now() - (d._inicio || Date.now())) + (pasos ? ' · ' + pasos + (pasos === 1 ? ' paso' : ' pasos') : '');
    return;
  }
  if (cerrado) {
    // plegado: manda el resumen. Es lo que permite seguir el hilo sin abrir cada bloque.
    const g = primeraLineaUtil(d._texto);
    el.classList.toggle('gist', !!g);
    el.textContent = g || 'pensó ' + K.fmtDuration(d._ms || 0);
    return;
  }
  el.classList.remove('gist');
  el.textContent = pasos + (pasos === 1 ? ' paso' : ' pasos') + ' · ' + K.fmtDuration(d._ms || 0);
}
function relojRazonamiento(d) {
  thinkVivo = d;
  if (thinkTimer) return;
  thinkTimer = setInterval(() => {
    const t = thinkVivo;
    if (!t || !t.isConnected || t._terminado) {
      clearInterval(thinkTimer);
      thinkTimer = 0;
      thinkVivo = null;
      return;
    }
    metaRazonamiento(t);
  }, 250);
}

/* El bloque se construye aparte por el mismo motivo que el grupo de herramientas: una
   conversación guardada tiene que poder repintar su razonamiento sin turno vivo. */
function buildThinkBlock() {
  const d = document.createElement('div');
  d.className = 'thinkblock open';
  d.innerHTML =
    '<div class="think-head" role="button" tabindex="0" aria-expanded="true">' +
    `<span class="th-ic">${ic('brain')}</span><b>Razonamiento</b>` +
    '<span class="th-meta">pensando…</span>' +
    `<button class="th-copy" title="Copiar el razonamiento">${ic('copy')}</button>` +
    `<span class="th-chev">${ic('chevron')}</span></div>` +
    '<div class="think-body"></div>';
  const head = d.querySelector('.think-head');
  d._inicio = Date.now();
  const toggle = () => {
    const open = d.classList.toggle('open');
    d.classList.toggle('closed', !open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    d._tocado = true; // si el usuario lo abre, ya no se cierra solo
    metaRazonamiento(d); // plegado enseña el resumen; abierto, la duración y las líneas
  };
  head.onclick = (e) => {
    if (e.target.closest('.th-copy')) return;
    toggle();
  };
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  d.querySelector('.th-copy').onclick = (e) => {
    e.stopPropagation();
    copyText(d._texto || '', 'Razonamiento copiado');
  };
  return d;
}

function ensureThinkBlock() {
  const b = ensureAssistantBubble();
  /* Un bloque por RÁFAGA de razonamiento, en su sitio: un modelo con razonamiento piensa
     antes de cada paso, y meter todo en un bloque al principio del turno pondría el
     razonamiento del paso 6 encima de las herramientas del paso 1. El primero abre el
     turno (se piensa antes de actuar); los siguientes van donde ocurrieron. */
  const actual = pendingTurn.think;
  if (!actual || !actual.isConnected || actual._terminado) {
    const d = buildThinkBlock();
    b.appendChild(d);
    pendingTurn.think = d;
    relojRazonamiento(d);
  }
  return pendingTurn.think;
}

/* Pinta el cuerpo del razonamiento como PASOS, no como un muro de prosa: cada bloque
   (párrafo, lista, código) lleva su marca y el que está en curso —el último mientras el
   modelo piensa— se lee más fuerte; los anteriores quedan de rastro. Es la misma
   información, pero se sigue la línea de pensamiento de un vistazo. */
function pintarCuerpoRazonamiento(t) {
  const body = t.querySelector('.think-body');
  if (!body) return;
  body.innerHTML = fmt(t._texto || '');
  const flujo = body.querySelector('.md') || body;
  const bloques = [...flujo.children];
  bloques.forEach((b) => b.classList.remove('th-live'));
  t._pasos = bloques.length;
  if (!t._terminado && bloques.length) {
    bloques[bloques.length - 1].classList.add('th-live');
    // seguir el paso nuevo mientras piensa, salvo que el usuario haya subido a leer
    const cerca = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    if (cerca) body.scrollTop = body.scrollHeight;
  }
}

/** Pinta el razonamiento AHORA (sin esperar a un frame). */
function pintarRazonamiento(t) {
  if (!t || !t.isConnected) return;
  pintarCuerpoRazonamiento(t);
  metaRazonamiento(t);
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
  /* v4.4: la herramienta de un COMPAÑERO del equipo se atribuye a SU miembro —la píldora
     lleva el nombre del compañero, no el del especialista del registro—; el `subagent` de
     siempre se sigue usando para las delegaciones. El nombre sale del equipo acumulado y,
     si aún no se conoce a ese miembro, de `memberName` (lo pone el motor) o del propio id. */
  const ficha = ev.member ? equipoFicha(hiloActual(), ev.member) : null;
  const miembro = ev.member ? { id: ev.member, name: (ficha && ficha.name) || ev.memberName || ev.member } : null;
  const sub = !miembro && ev.subagent && K.subagent(ev.subagent);
  const args = K.summarizeArgs(ev.name, ev.args);
  card.innerHTML = `
    <div class="tcard-head">
      <span class="tcard-ic">${ic(meta.icon)}</span>
      <span class="tcard-name">${esc(meta.label)}</span>
      ${miembro ? `<span class="tcard-sub" title="Compañero del equipo (${esc(ev.member)})">${esc(miembro.name)}</span>` : ''}
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
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCard();
    }
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
    if (!card.isConnected || !card.classList.contains('run')) {
      clearInterval(card._tick);
      return;
    }
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
  const ok = ev.ok !== undefined && ev.ok !== null ? !!ev.ok : !K.looksFailed(ev.result);
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
      const linea =
        String(ev.result || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) || 'falló sin decir por qué';
      note.textContent = K.clip(linea.replace(/^Error:\s*/i, ''), 160);
      note.title = K.clip(String(ev.result || ''), 2000);
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
  wrap.innerHTML =
    `<div class="tb-label">RESULTADO${cuantas > 1 ? ' · ' + cuantas + ' líneas' : ''}<button class="tcard-copy" title="Copiar resultado">${ic('copy')}</button></div>` +
    `<pre>${esc(K.clip(salida, 1200)) || '(sin salida)'}</pre>`;
  wrap.querySelector('.tcard-copy').onclick = (e) => {
    e.stopPropagation();
    copyText(ev.result, 'Resultado copiado');
  };
  body.appendChild(wrap);
  return { ok, took };
}

/** Cierra la tarjeta del turno en vivo con su resultado, su duración y si falló. */
function completeToolCard(ev) {
  if (!pendingTurn) return;
  let card = null;
  for (let i = pendingTurn.cards.length - 1; i >= 0; i--) {
    const c = pendingTurn.cards[i];
    if (c.dataset.tool === ev.name && c.classList.contains('run')) {
      card = c;
      break;
    }
  }
  if (!card) {
    toolCard({ name: ev.name, args: {} });
    card = pendingTurn.cards[pendingTurn.cards.length - 1];
  }
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
  card.className = 'tcard dcard ' + (fallo ? 'err' : parcial ? 'part' : 'done');
  if (ev.subagent) card.dataset.delegate = String(ev.subagent); // nunca `dataset.tool`: no es una herramienta
  const etiqueta = fallo ? 'FALLÓ' : parcial ? 'PARCIAL' : 'OK';
  card.innerHTML = `
    <div class="tcard-head">
      <span class="tcard-ic">${ic(fallo ? 'alert' : 'check')}</span>
      <span class="tcard-name">${esc(sub.label)}</span>
      <span class="dcard-status ${fallo ? 'fail' : parcial ? 'part' : 'ok'}" title="Estado del subagente">${esc(etiqueta)}</span>
      <span class="tcard-args" title="${esc(String(ev.result || ''))}">${esc(K.clip(String(ev.result || ''), 110))}</span>
      <span class="tcard-time">${ev.durationMs ? esc(K.fmtDuration(Number(ev.durationMs))) : ''}</span>
      <span class="tcard-chev">${ic('chevron')}</span>
    </div>
    <div class="tcard-body"></div>`;
  const body = card.querySelector('.tcard-body');
  body.innerHTML =
    `<div class="tb-label">RESULTADO</div><pre>${esc(String(ev.result || '(sin resumen)'))}</pre>` +
    (ev.details ? `<div class="tb-label">DETALLES</div><pre>${esc(String(ev.details))}</pre>` : '') +
    (ev.evidence ? `<div class="tb-label">EVIDENCIA</div><pre>${esc(String(ev.evidence))}</pre>` : '');
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
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return card;
}

function delegationCard(ev) {
  if (!pendingTurn) return;
  ensureAssistantBubble();
  const group = ensureToolGroup();
  const card = buildDelegationCard(ev);
  group.body.appendChild(card);
  pendingTurn.cards.push(card); // el turno la limpia igual que las demás
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
/* Un tramo de texto del turno: su propio bloque, con la piel de la burbuja. */
function segTexto(texto) {
  const d = document.createElement('div');
  d.className = 'seg';
  d.innerHTML = fmt(texto);
  return d;
}

/** Bloque de razonamiento ya terminado (el de un turno guardado): misma pieza que en vivo. */
function bloqueRazonamiento(think) {
  const d = buildThinkBlock();
  d._texto = String(think.text || '');
  d._ms = Number(think.ms) || 0;
  d._terminado = true;
  pintarCuerpoRazonamiento(d);
  d.classList.remove('open');
  d.classList.add('closed');
  d.querySelector('.think-head').setAttribute('aria-expanded', 'false');
  metaRazonamiento(d);
  return d;
}

/** Tarjeta de una herramienta del rastro guardado: EXACTAMENTE la del turno en vivo. */
function cardDeTraza(t) {
  const card = buildToolCard({ name: t.name, args: t.args || {}, subagent: t.subagent, member: t.member });
  /* Sin `ok` la herramienta empezó y el turno se cortó antes de su resultado: se dice tal
     cual, en vez de pintarle un check verde que nunca ocurrió. */
  const r =
    t.ok === undefined
      ? pintarResultadoTarjeta(card, {
          name: t.name,
          ok: false,
          durationMs: t.ms,
          result: 'Esta herramienta no llegó a devolver su resultado: el turno se cortó antes.',
        })
      : pintarResultadoTarjeta(card, { name: t.name, ok: t.ok, result: t.result, durationMs: t.ms });
  return { card, ok: r.ok, took: r.took };
}

/** Pinta un grupo de herramientas completo (cabecera con el resumen + sus tarjetas). */
function cerrarGrupoTraza(grp, cuantas, fallos, total) {
  grp.title.textContent = K.toolCount(cuantas);
  grp.meta.textContent = total ? K.fmtDuration(total) : '';
  grp.fails.hidden = !fallos;
  grp.fails.textContent = fallos === 1 ? '1 fallo' : fallos + ' fallos';
  grp.el.classList.toggle('has-fails', !!fallos);
  /* Las filas se QUEDAN a la vista: el turno es una traza y esconder lo que hizo es
     justo lo que el usuario pedía dejar de hacer. La cabecera sigue plegándolas. */
  grp.el.classList.add('open');
  grp.el.classList.remove('closed');
  grp.head.setAttribute('aria-expanded', 'true');
}

/* El turno guardado se repinta EN ORDEN: los mismos bloques que se vieron en vivo, con las
   herramientas donde ocurrieron. `parts` lo escribe main/traza.js mientras el turno corre. */
function restaurarPartes(bubbleEl, parts) {
  let grupo = null;
  let enGrupo = 0;
  let fallos = 0;
  let total = 0;
  let huboTexto = false;
  const cierra = () => {
    if (!grupo) return;
    cerrarGrupoTraza(grupo, enGrupo, fallos, total);
    grupo = null;
    enGrupo = 0;
    fallos = 0;
    total = 0;
  };
  for (const p of parts) {
    if (!p || !p.k) continue;
    if (p.k === 'tool' || p.k === 'delegate') {
      if (!grupo) {
        grupo = buildToolGroup();
        bubbleEl.appendChild(grupo.el);
      }
      enGrupo++;
      if (p.k === 'delegate') {
        grupo.body.appendChild(buildDelegationCard({ subagent: p.subagent, status: p.status, result: p.result, durationMs: p.ms }));
        if (String(p.status || '').toUpperCase() === 'FAILED') fallos++;
        total += Number(p.ms) || 0;
      } else {
        const { card, ok, took } = cardDeTraza(p);
        if (!ok) fallos++;
        total += took;
        grupo.body.appendChild(card);
      }
      continue;
    }
    cierra();
    if (p.k === 'text') {
      if (!String(p.text || '').trim()) continue;
      huboTexto = true;
      bubbleEl.appendChild(segTexto(p.text));
    } else if (p.k === 'think') {
      if (!String(p.text || '').trim()) continue;
      bubbleEl.appendChild(bloqueRazonamiento(p));
    } else if (p.k === 'todos') {
      if (p.todos && p.todos.length) bubbleEl.appendChild(buildTodoCard(p.todos));
    }
  }
  cierra();
  return huboTexto;
}

function restaurarTraza(bubbleEl, trace, html) {
  bubbleEl.classList.add('blocks');
  const parts = trace && Array.isArray(trace.parts) && trace.parts.length ? trace.parts : null;
  /* Un turno cuyo texto no cupo en `parts` se repinta por la rama completa: las partes
     enseñarían la respuesta a medias y «Copiar» copiaría el corte. */
  if (parts && !(trace && trace.cortado)) {
    /* Si el motor no llegó a cerrar ni un tramo de texto (turno cortado, o guardado por una
       versión anterior), manda el texto del mensaje: antes que una traza sin respuesta. */
    if (!restaurarPartes(bubbleEl, parts) && html) bubbleEl.appendChild(segTexto(html));
    return;
  }
  /* Mensajes guardados ANTES de las partes: se repinta el rastro compacto de siempre, con
     la misma piel nueva (razonamiento, lista de tareas y una tanda de herramientas). */
  const tools = trace && Array.isArray(trace.tools) ? trace.tools : [];
  const think = trace && trace.think && trace.think.text ? trace.think : null;
  if (think) bubbleEl.appendChild(bloqueRazonamiento(think));
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
        total += Number(t.ms) || 0;
        continue;
      }
      const { card, ok, took } = cardDeTraza(t);
      if (!ok) fallos++;
      total += took;
      grp.body.appendChild(card);
    }
    cerrarGrupoTraza(grp, grp.body.children.length, fallos, total);
    bubbleEl.appendChild(grp.el);
  }
  if (html) bubbleEl.appendChild(segTexto(html));
}

/* ---------- v2.2: tablero del equipo (delegaciones EN VIVO) ----------
   Las tarjetas de herramienta ya enseñan cada paso, pero responder a «quién está
   trabajando ahora mismo» exigía leerlas todas. Este tablero es una tira de chips, uno
   por delegación del turno: se pinta al EMPEZAR (delegate_start, con la subtarea) y se
   resuelve al acabar (delegate_done) con OK, PARCIAL o fallo. Así se ve al instante qué
   está haciendo cada subagente sin esperar al cierre del turno. */
function etiquetaEquipo(ev) {
  const who = (K.subagent(ev.subagent) || {}).label || 'Subagente';
  const tarea = K.clip(
    String(ev.task || '')
      .replace(/\s+/g, ' ')
      .trim(),
    40,
  );
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
    head.innerHTML =
      `<span class="tg-ic">${ic('agents')}</span><b class="tg-title">Equipo</b>` +
      `<span class="tg-meta"></span><span class="tg-chev">${ic('chevron')}</span>`;
    const body = document.createElement('div');
    body.className = 'tgroup-body';
    const toggle = () => {
      const open = g.classList.toggle('open');
      g.classList.toggle('closed', !open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    head.onclick = toggle;
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
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
  return t.chips.filter((c) => !c.cerrado).length;
}

function equipoChip(ev) {
  const board = ensureTeamBoard();
  const chip = document.createElement('div');
  chip.className = 'toolchip run';
  chip.dataset.subagent = String(ev.subagent || '');
  chip.title = etiquetaEquipo(ev) + (ev.expect ? '\n\nCriterio de éxito: ' + K.clip(ev.expect, 300) : '');
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
  const abiertas = pendingTurn.team.chips.filter((c) => !c.cerrado);
  const chip =
    abiertas.find((c) => c.subagent === String(ev.subagent || '') && c.el.title.startsWith(etiquetaEquipo(ev))) ||
    abiertas.find((c) => c.subagent === String(ev.subagent || '')) ||
    abiertas[0];
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

/* ---------- v4.4: tarjeta del EQUIPO (modo EQUIPO) ----------
   Un encargo de equipo en UNA tarjeta: el reparto del líder (quién hace qué, con el estado
   de cada compañero) mientras corre y el resultado agregado cuando termina. Por fuera es la
   tarjeta de la delegación (`.tcard.dcard`: cabecera plegable, píldora de estado, tiempo),
   porque el usuario ya sabe leerla; por dentro lleva una fila por compañero. El tablero
   compartido y el buzón completos viven en su vista (renderer/40-vistas.js): aquí se cuenta
   el reparto, no se duplica el tablero. */
function buildEquipoCard() {
  const card = document.createElement('div');
  /* Abierta desde el principio y sin cerrarse sola al acabar: mientras corre es donde se lee
     el REPARTO (quién hace qué) y al cerrar, el resultado agregado y el gasto. Es la misma
     decisión que la tarjeta de tareas (que tampoco se pliega): es el resumen del encargo,
     no una lista de detalles. */
  card.className = 'tcard dcard run open';
  card.dataset.equipo = '1';
  card.innerHTML = `
    <div class="tcard-head">
      <span class="tcard-ic">${ic('agents')}</span>
      <span class="tcard-name">Equipo</span>
      <span class="dcard-status part" title="Estado del equipo">en marcha</span>
      <span class="tcard-args"></span>
      <span class="tcard-time"></span>
      <span class="tcard-chev">${ic('chevron')}</span>
    </div>
    <div class="tcard-body">
      <div class="tb-label">REPARTO DEL LÍDER</div>
      <div class="eqmiembros"></div>
    </div>`;
  const head = card.querySelector('.tcard-head');
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', 'true');
  const toggle = () => {
    const open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.onclick = toggle;
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  card._t0 = Date.now();
  return card;
}

/** Una fila del reparto: quién, con qué encargo y en qué estado (su permiso pendiente
    incluido, que es lo que explica que uno esté parado y otro trabajando). */
function equipoFilaMiembro(m) {
  const est = estadoEquipo(m.estado);
  return `<div class="eqmiembro" data-miembro="${esc(m.id)}">
    <span class="eqid">${esc(m.id)}</span>
    <span class="eqquien">${esc(m.name || m.id)}</span>
    <span class="eqque">${esc(m.tarea || 'sin encargo todavía')}${
      m.estado === 'esperando' && m.atencion ? ' — te necesita: ' + esc(K.clip(m.atencion, 90)) : ''
    }${m.estado === 'terminado' && m.resumen ? ' — ' + esc(K.clip(m.resumen, 160)) : ''}</span>
    ${badgeEquipoPermisos(m)}
    <span class="abadge ${est.cls}">${esc(est.label)}</span>
  </div>`;
}

/** Repinta el reparto (y, si el encargo cerró, su resultado) desde el estado ACUMULADO del
    equipo: los eventos cuentan el mismo hecho que la vista, así que se pinta de la misma
    fuente y la tarjeta no puede discrepar de ella. */
function pintarEquipoCard(card, e) {
  if (!card || !card.isConnected || !e) return;
  const miembros = e.orden.map((id) => e.miembros.get(id)).filter(Boolean);
  const enMarcha = miembros.filter((m) => m.estado === 'trabajando').length;
  const esperan = miembros.filter((m) => m.estado === 'esperando').length;
  const reparto = card.querySelector('.eqmiembros');
  if (reparto)
    reparto.innerHTML = miembros.length ? miembros.map(equipoFilaMiembro).join('') : '<div class="subnote">Sin reparto todavía.</div>';
  const args = card.querySelector('.tcard-args');
  /* El equipo puede estar cerrado y un compañero seguir vivo (esperando tu permiso, o
     trabajando después de concederlo): mientras quede alguien, la tarjeta no puede decir
     «terminado» ni enseñar el resultado agregado —el trabajo no ha acabado—. */
  const fin = e.estado === 'fin' && enMarcha + esperan === 0;
  if (args)
    args.textContent = fin
      ? K.clip(resumenEquipo(e), 110)
      : `${miembros.length} ${miembros.length === 1 ? 'compañero' : 'compañeros'} · ${enMarcha} en marcha${esperan ? ' · ' + esperan + ' esperando' : ''}`;
  const pill = card.querySelector('.dcard-status');
  if (pill) {
    pill.textContent = fin ? (e.ok === false ? 'se detuvo' : 'terminado') : 'en marcha';
    pill.className = 'dcard-status ' + (fin ? (e.ok === false ? 'fail' : 'ok') : 'part');
  }
  if (!fin) return;
  // cierre: fuera «en marcha», con su tiempo real y el resultado agregado + el gasto
  card.classList.remove('run');
  card.classList.add(e.ok === false ? 'err' : 'done');
  const t = card.querySelector('.tcard-time');
  if (t && !t.textContent) t.textContent = K.fmtDuration((e.fin || Date.now()) - e.inicio);
  const body = card.querySelector('.tcard-body');
  if (body && !body.querySelector('[data-result]')) {
    const wrap = document.createElement('div');
    wrap.dataset.result = '1';
    const g = e.gasto || {};
    const gasto = [];
    if (Number.isFinite(Number(g.tokens)) && Number(g.tokens) > 0) gasto.push(K.thousands(g.tokens) + ' tokens');
    if (Number.isFinite(Number(g.costUsd)) && Number(g.costUsd) > 0) gasto.push('$' + Number(g.costUsd).toFixed(4));
    wrap.innerHTML =
      `<div class="tb-label">${e.ok === false ? 'EL EQUIPO SE DETUVO' : 'RESULTADO AGREGADO'}</div>` +
      `<pre>${esc(resumenEquipo(e))}</pre>` +
      (gasto.length ? `<div class="tb-label">GASTO DEL EQUIPO</div><pre>${esc(gasto.join(' · '))}</pre>` : '');
    body.appendChild(wrap);
  }
}

/** Enganche del turno para los eventos del equipo: la tarjeta se crea con el team_start y
    se repinta con cada evento. Sólo lo llama el manejador de eventos del renderer
    (20-app.js), y sólo para la conversación que está a la vista. */
function equipoChat(ev) {
  const e = equipoDe(ev.convId, false);
  const tipo = String((ev && ev.type) || '');
  /* El chat cuenta por dónde va el equipo con una línea de estado (que se reemplaza) y sólo
     los HITOS en el feed: el buzón entero vive en su vista, y volcarlo aquí taparía el
     resto de la actividad del turno. */
  const n = e ? e.orden.length : 0;
  switch (tipo) {
    case 'team_start':
      setChatStatus(`Equipo · ${n === 1 ? '1 compañero' : n + ' compañeros'} repartiendo el trabajo…`);
      feed(`Equipo: ${n === 1 ? '1 compañero' : n + ' compañeros'}`, 'a-y');
      break;
    case 'team_member': {
      const m = e && e.miembros.get(String(ev.id || ''));
      if (m) setChatStatus(`Equipo · ${m.name}: ${K.clip(m.tarea || 'sin encargo todavía', 70)}`);
      break;
    }
    case 'team_message':
      setChatStatus(`Equipo · ${nombreEquipo(e, ev.de)} escribe a ${nombreEquipo(e, ev.para)}`);
      break;
    case 'team_done': {
      const f = e && e.miembros.get(String(ev.id || ''));
      feed(
        `${(f && f.name) || ev.id} — ${ev.ok === false ? 'no pudo con el encargo' : 'terminó su parte'}`,
        ev.ok === false ? 'err' : 'ok',
      );
      break;
    }
    case 'team_end': {
      const mal = e ? e.ok === false : false;
      setChatStatus('Equipo · ' + (mal ? 'se detuvo' : 'encargo cerrado'));
      feed(mal ? 'El equipo se detuvo' : 'Equipo: encargo cerrado', mal ? 'err' : 'ok');
      break;
    }
    default:
      break;
  }
  if (tipo === 'team_start') {
    /* La burbuja del turno se crea AQUÍ si este evento llegó antes que cualquier otra cosa
       del turno (el líder puede levantar compañeros antes de su primera herramienta):
       exigir un `pendingTurn` previo dejaría el encargo sin tarjeta. */
    ensureAssistantBubble();
    if (!pendingTurn) return; // turno ya cerrado: no hay dónde colgar la tarjeta
    const card = buildEquipoCard();
    const grupo = pendingTurn.group ? pendingTurn.group.el : null;
    if (grupo) pendingAssistant.insertBefore(card, grupo);
    else pendingAssistant.appendChild(card);
    pendingTurn.cards.push(card); // el turno la cierra igual que las demás
    pendingTurn.equipo = card;
    e.card = card; // …y el EQUIPO la recuerda: sigue viva cuando el turno ya cerró
    pintarEquipoCard(card, e);
    scroll();
    return;
  }
  /* La tarjeta se repinta AUNQUE el turno ya haya cerrado: un compañero puede estar esperando
     un permiso con el líder fuera (su vuelta sigue viva), y al contestarlo tiene que verse que
     sigue y que termina. Mirando sólo el turno abierto, la tarjeta se quedaba congelada en
     «esperando» y con la insignia puesta para siempre. */
  const card = tarjetaEquipoAbierta();
  if (!card) return;
  pintarEquipoCard(card, e);
  if (tipo === 'team_end') scroll();
}

/** La tarjeta del equipo de ESTA conversación: la del turno abierto o, si el turno ya cerró,
    la última que se pintó para ese equipo. La usan los dos caminos que cambian el estado —los
    eventos del equipo y el alta/baja de un permiso pendiente—: la insignia de un compañero
    vive en su fila, y el compañero sigue vivo después del turno si espera al usuario. */
function tarjetaEquipoAbierta() {
  if (pendingTurn && pendingTurn.equipo && pendingTurn.equipo.isConnected) return pendingTurn.equipo;
  const e = equipoDe(hiloActual(), false);
  return e && e.card && e.card.isConnected ? e.card : null;
}

/** Repinta la tarjeta del equipo de esta conversación, si la hay. La usan los dos caminos que
    cambian el estado: los eventos del equipo y el alta/baja de un permiso pendiente (la
    insignia de un compañero vive en su fila de la tarjeta). */
function refrescarEquipoChat() {
  const card = tarjetaEquipoAbierta();
  if (!card) return;
  pintarEquipoCard(card, equipoDe(hiloActual(), false));
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
    txt.textContent =
      lista.length === 1
        ? 'Se ha cambiado 1 archivo (' + muestra + ').'
        : 'Se han cambiado ' + lista.length + ' archivos (' + muestra + ').';
  }
  bar.hidden = false;
  // los cambios son de la conversación que los hizo: quedan apuntados en SU runtime para
  // que la barra vuelva con ellos si se sale de la pestaña y se vuelve
  rtActual().cambios = lista;
  /* Hay cambios que revisar: el disparador de la revisión aparece y desaparece CON la
     barra. La señal es la misma (el `can_undo` del turno), así que no puede quedar un
     botón «revisar» sin nada que revisar ni al revés. */
  const bt = $('#btnDiff');
  if (bt) bt.hidden = false;
}

function ocultarDeshacer() {
  const bar = $('#undoBar');
  if (bar) bar.hidden = true;
  const bt = $('#btnDiff');
  if (bt) bt.hidden = true;
  rtActual().cambios = [];
  // sin cambios del turno no hay nada que revisar, y un panel abierto seguiría enseñando
  // los archivos de un turno que ya no está en juego
  cerrarDiffPanel();
}

if ($('#undoBtn'))
  $('#undoBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await window.sagitari.undoChanges(hiloActual());
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
      showToast('Cambios del turno deshechos: ' + (partes.join(', ') || 'no había nada'));
      feed('Cambio del turno deshecho', 'blu');
    } catch (err) {
      showToast('No se pudo deshacer: ' + ((err && err.message) || err));
    } finally {
      btn.disabled = false;
    }
  };

/* ---- F2: revisión de los cambios del turno, archivo a archivo -------------
   `#undoBtn` deshace el turno ENTERO de una vez; `#btnDiff` abre la revisión para ver
   qué cambió en cada archivo y revertir sólo uno. El panel no guarda estado propio: se
   llena pidiendo los cambios al proceso principal (que es quien los tiene) y se cierra
   en cuanto dejan de existir. */
const diffPanel = $('#diffPanel');
const diffList = $('#diffList');

function cerrarDiffPanel() {
  if (diffPanel) diffPanel.hidden = true;
}

/** Abre el panel con los cambios que haya ahora mismo (el pintado es de 40-vistas.js). */
async function abrirDiffPanel() {
  if (!diffPanel || !diffList) return;
  const r = await window.sagitari.cambiosDiff(hiloActual());
  if (!r || r.ok === false) {
    showToast('No se pudieron leer los cambios: ' + ((r && r.error) || 'error desconocido'));
    return;
  }
  pintarDiff(r.archivos || [], diffList);
  diffPanel.hidden = false;
}

/** Vuelve a pedir los cambios y pone al día el panel y la barra de deshacer con lo que
    QUEDA (después de revertir un archivo, el turno ya no toca lo mismo). */
async function refrescarDiffPanel() {
  const r = await window.sagitari.cambiosDiff(hiloActual());
  const archivos = r && r.ok !== false ? r.archivos || [] : [];
  if (!archivos.length) {
    // ya no queda nada del turno: se va también la barra de deshacer (y con ella el panel)
    ocultarDeshacer();
    return;
  }
  if (diffList) pintarDiff(archivos, diffList);
  mostrarDeshacer(archivos.map((a) => a.rel || a.path));
}

if ($('#btnDiff')) {
  $('#btnDiff').hidden = true; // sin cambios del turno no hay nada que revisar
  // alterna, como el menú de modelos: un segundo clic sobre el disparador cierra
  $('#btnDiff').onclick = () => (diffPanel && !diffPanel.hidden ? cerrarDiffPanel() : abrirDiffPanel());
}
if ($('#diffClose')) $('#diffClose').onclick = cerrarDiffPanel;
/* Un solo escucha delegado para todos los botones de revertir: el pintado rehace las filas
   enteras en cada refresco, así que engancharlos uno a uno se quedaría viejo al primer
   refresco. */
if (diffList)
  diffList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-revert]');
    if (!btn || btn.disabled) return;
    const archivo = btn.dataset.revert;
    btn.disabled = true;
    try {
      const r = await window.sagitari.cambiosRevertir(hiloActual(), archivo);
      if (!r || r.ok === false) {
        btn.disabled = false;
        showToast('No se pudo revertir «' + archivo + '»: ' + ((r && r.error) || 'error desconocido'));
        return;
      }
      showToast('«' + archivo + '» vuelto a como estaba antes del turno');
      feed('Archivo revertido: ' + archivo, 'blu');
      await refrescarDiffPanel();
    } catch (err) {
      btn.disabled = false;
      showToast('No se pudo revertir «' + archivo + '»: ' + ((err && err.message) || err));
    }
  });
// Escape cierra el panel: es el mismo gesto con el que se cierran los menús de la casa
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && diffPanel && !diffPanel.hidden) cerrarDiffPanel();
});

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
  card.innerHTML =
    `<div class="plancard-head">${ic('map')}<b>PLAN</b><span class="pl-count"></span></div>` +
    '<ol>' +
    steps.map((s) => `<li data-step="${s.n}"><span class="pl-n">${s.n}</span><span>${esc(s.text)}</span></li>`).join('') +
    '</ol>';
  if (before) container.insertBefore(card, before);
  else container.appendChild(card);
  const count = card.querySelector('.pl-count');
  const items = [...card.querySelectorAll('li')];
  /* Al repintar la tarjeta (el plan creció tras el último delta) se conservan los
     pasos ya cumplidos: si no, volvían a aparecer pendientes y el contador se
     reiniciaba a 0. */
  const done = Math.max(0, Math.min(prev ? prev.done || 0 : 0, items.length));
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
  return status === 'completed'
    ? { cls: 'done', icn: 'check' }
    : status === 'in_progress'
      ? { cls: 'now', icn: 'play' }
      : { cls: '', icn: '' };
}
function todoCount(todos) {
  const done = todos.filter((t) => t && t.status === 'completed').length;
  return done ? done + '/' + todos.length + ' pasos' : todos.length + ' pasos';
}
function buildTodoCard(todos) {
  const card = document.createElement('div');
  card.className = 'plancard todocard';
  card.innerHTML =
    `<div class="plancard-head">${ic('list')}<b>TAREAS</b><span class="pl-count">${esc(todoCount(todos))}</span></div>` +
    '<ol>' +
    todos
      .map((t) => {
        const m = todoStatusMeta(t && t.status);
        // mientras se hace, se enseña en presente (activeForm) si el modelo lo dio
        const txt = t && t.status === 'in_progress' && t.activeForm ? t.activeForm : (t && t.content) || '';
        return `<li class="${m.cls}"><span class="pl-n">${m.icn ? ic(m.icn) : ''}</span><span>${esc(txt)}</span></li>`;
      })
      .join('') +
    '</ol>';
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
    if (!card.classList.contains('run')) continue; // ya tenía su resultado
    card.classList.remove('run');
    card.classList.add(failed ? 'err' : 'cancelled');
    const mark = card.querySelector('.tcard-ic');
    if (mark) mark.innerHTML = ic(failed ? 'alert' : 'close');
    const body = card.querySelector('.tcard-body');
    if (body && !body.querySelector('[data-result]')) {
      const wrap = document.createElement('div');
      wrap.dataset.result = '1';
      wrap.innerHTML =
        `<div class="tb-label">${failed ? 'ERROR' : 'CANCELADO'}</div>` +
        `<pre>${failed ? 'La ejecución falló antes de recibir el resultado.' : 'Detenido por el usuario antes de recibir el resultado.'}</pre>`;
      body.appendChild(wrap);
    }
  }
  // el grupo tampoco puede seguir diciendo «en curso…» para siempre
  if (pendingTurn.group) pendingTurn.group.meta.textContent = failed ? 'interrumpido' : 'detenido';
}

function finishAssistant(finalText, opts) {
  cancelStreamRender(); // un frame pendiente repintaría el stream ya cerrado
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
    /* Las herramientas NO se pliegan al terminar: el turno es una traza y lo que hizo el
       agente es parte de la respuesta. Antes se cerraban solas y el hilo se leía como un
       párrafo sin origen. La cabecera del grupo sigue plegándolas si el usuario quiere. */
  }
  const stream = holder._openEl && holder._openEl.isConnected ? holder._openEl : holder.querySelector('.stream');
  // texto ya streameado: al Detener (o si la ejecución falla) NO se tira, se conserva
  const acc = holder._stream || '';
  const fin = String(finalText || '').trim();
  const runMode0 = (pendingTurn && pendingTurn.mode) || mode;
  const planConTarjeta = runMode0 === 'plan' && !!(pendingTurn && pendingTurn.plan);
  if (planConTarjeta) {
    if (stream) stream.remove();
  } else if (stream) {
    // el tramo abierto se queda donde nació (intercalado con las herramientas);
    // solo se retira si llegó vacío (congelado antes del primer frame)
    if (holder._openText) {
      stream.className = 'stream-done seg';
      /* …y se asegura el texto COMPLETO en pantalla. El tramo abierto se acumula en CADA
         evento (`_openText`), pero se PINTA por frames: si el último frame no llega —la
         ventana no tiene el foco y Chromium no repinta— el elemento se queda con lo del
         frame ANTERIOR y la respuesta se veía cortada a media frase, mientras el mensaje
         guardado (que lo acumula el proceso principal, sin frames de por medio) estaba
         entero. Antes esto sólo rellenaba el elemento si estaba VACÍO: cubría «no se pintó
         nada», pero no «se pintó a medias». Y si el stream se quedó corto respecto al
         texto del turno, manda el del turno. */
      const abierto = (holder._openText || '').trim();
      if (fin && abierto && fin.startsWith(abierto) && fin.length > abierto.length) holder._openText = fin;
      stream.innerHTML = fmt(holder._openText);
    } else stream.remove();
  } else if (!planConTarjeta && holder._openText) {
    // Sin elemento porque ningún frame llegó a crearlo (ventana oculta): el
    // tramo abierto se pinta entero de una vez, en su sitio (al final).
    // Si el acumulado se quedó corto respecto al texto del turno, manda el del turno
    // (misma corrección que la rama del stream: si no, se pintaba el trozo y luego la
    // respuesta entera otra vez).
    const abierto = (holder._openText || '').trim();
    if (fin && abierto && fin.startsWith(abierto) && fin.length > abierto.length) holder._openText = fin;
    const s = document.createElement('div');
    s.className = 'stream-done seg';
    s.innerHTML = fmt(holder._openText);
    holder.appendChild(s);
  }
  holder._openEl = null;
  /* La narración visible se mide AQUÍ, DESPUÉS de reponer el stream, no antes: la rama
     de arriba acaba de corregir `_openText` con el texto completo del turno (`fin`) cuando
     los deltas se perdieron —el usuario miraba otra pestaña y `eventoDeOtraPestana` los
     descarta, así que el tramo abierto se quedó corto—. Medido antes, `shown` no terminaba
     en `fin` y la rama final creía que faltaba texto y volvía a añadir la respuesta
     ENTERA: el mismo texto aparecía dos veces en el hilo. */
  const shown = ((holder._frozenText || '') + '\n\n' + (holder._openText || '')).trim();
  // lo que se ofrece para copiar/leer: la historia completa, no solo el cierre
  const narrativa = planConTarjeta ? finalText : shown && fin && !shown.endsWith(fin) ? shown + '\n\n' + finalText : shown || finalText;
  const keptText = finalText ? '' : o.interrupted ? (planConTarjeta ? acc : shown) : '';
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
      const text = runMode === 'plan' && parsed.steps.length ? parsed.body || '' : finalText;
      if (text) {
        holder.appendChild(segTexto(text));
      }
    }
  } else if (finalText) {
    // La narración ya está en su sitio (tramos congelados + tramo abierto): solo
    // se añade el cierre si aporta algo nuevo. Antes se borraba todo y se
    // pintaba solo este párrafo, y la respuesta larga "se volvía corta".
    if (fin && !(shown && shown.endsWith(fin))) {
      holder.appendChild(segTexto(finalText));
    }
  } else if (keptText) {
    // turno cortado a medias con texto acumulado: se repinta igual que el stream
    // pero SIN la clase .stream (su caret parpadeante diría «sigue escribiendo»)
    const div = document.createElement('div');
    div.className = 'interrupted seg';
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
  // el pie ofrece copiar también lo que quedó a medias
  const said = narrativa || keptText;
  if (said) msgActions(holder.closest('.msg-body') || holder, said, {});
  lastAssistantEl = holder;
  refreshMsgActions();
  pendingAssistant = null;
  pendingTurn = null;
  scroll(true);
}
