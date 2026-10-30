/* SAGITARI renderer — 40-vistas.js (antes app.js 4115-5258): conversaciones, modos, memoria, tareas, menús, tema y arranque init()
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
/* Funciones que se usan desde otros scripts del renderer (index.html carga varios
   <script> que comparten scope). El comentario `exported` le dice a ESLint que
   estas definiciones se usan fuera de este archivo: sin él las marcaría como
   no usadas. */
/* exported glowStrengthLabel, glassTintLabel, renderTools,
   showEmpty, lastTurnLabel, setChatStatus, ensureThinkBlock, scheduleThinkRender, completeToolCard,
   delegationCard, restaurarTraza, equipoChip, equipoCierra, mostrarDeshacer, toolChip, todosCard, pintarDiff, renderAgents,
   equipoEvento, renderEquipo, cargarLimiteEquipo, equipoDe, equipoFicha, equipoPermiso, nombreEquipo,
   estadoEquipo, badgeEquipoPermisos, pintarBadgeEquipo, resumenEquipo, equipoCierraPorTurno */
/* global fillSettings, wizardMostrar, polishSwitches, pintarRailEquipo, refrescarEquipoChat */
/* Los atajos de permiso viven en 30-ajustes.js (junto a la tabla de Seguridad que
   gobiernan): esta vista los llama desde su cabecera. */
/* global permitirTodoPermisos, restablecerPermisos, mostrarAvisoConDeshacer */
/* La etiqueta humana de cada nivel recomendado vive en 30-ajustes.js y se reusa aquí
   para no escribir dos veces la misma traducción «confirm → preguntar antes». */
/* global RISK_LABEL */
/* Las de arriba están definidas en 30-ajustes.js (scope compartido) salvo `pintarRailEquipo`,
   que vive en 20-app.js (el rail es suyo) y `refrescarEquipoChat`, que vive en 10-chat.js
   (la tarjeta del turno es suya): las llama el repintado del equipo de aquí. */
/* currentConvId está declarado en 10-chat.js; aquí sólo se ASIGNA al cambiar de
   hilo (por eso writable), para que el rebobinado y /compact sepan dónde están */
/* global currentConvId:writable */
/* Las pestañas de conversaciones abiertas viven en 10-chat.js: aquí sólo se piden sus
   puertas (activar una pestaña, repintar la cabecera del hilo, marcar su turno, saber
   cuál está abierta y repintar el strip). */
/* global abrirRuntime, pintarHiloActivo, hiloActual, rtActual, reflejarTurno, pintarPestanas */
// ============ conversation history ============
let convTitle = I18N.t('hist.nueva');
/* Último `conv:list` leído (el Historial lo refresca): de aquí sale el nombre de una
   conversación que se abre por su id, para poder ponerlo en su pestaña. */
let listaConvs = [];
function tituloDeConv(id) {
  const c = listaConvs.find((x) => x.id === id);
  return c ? c.title : '';
}
function setChatTitle(t, guardar) {
  convTitle = t || I18N.t('hist.nueva');
  rtActual().titulo = convTitle; // la pestaña enseña el mismo nombre que la cabecera
  pintarPestanas();
  const h = $('#chatTitle');
  h.textContent = convTitle;
  const root = $('#chatRootTitle'); // el h1 (oculto) de la vista mantiene la raíz del documento
  if (root) root.textContent = convTitle;
  h.title = convTitle; // se trunca con ellipsis: la pista completa va en el title
  /* sincroniza el título con la conversación real en el historial. `guardar === false`
     es para repintar la cabecera al cambiar de pestaña: el nombre ya está guardado y
     volver a mandarlo sólo añadiría una ida y vuelta por clic. */
  if (t && guardar !== false) {
    // fire-and-forget: si el IPC rechaza, el fallo se avisa aquí en vez de
    // acabar como promesa sin manejar (burbuja roja en el chat)
    try {
      const p = window.sagitari.convRename && window.sagitari.convRename(t);
      if (p && p.catch) p.catch(() => showToast(I18N.t('vistas.conv.guardar.fallo')));
    } catch {
      showToast(I18N.t('vistas.conv.guardar.fallo'));
    }
  }
}

async function renderHistory() {
  const box = $('#histList');
  if (!box) return;
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.convList()) || [];
  } catch (e) {
    err = e;
  }
  box.innerHTML = '';
  // una lista vacía por un IPC caído no es «no hay conversaciones»: se dice el error
  if (err) {
    box.innerHTML = `<div class="subnote">${esc(I18N.t('vistas.hist.fallo', { motivo: (err && err.message) || err }))}</div>`;
    return;
  }
  /* La lista se recuerda (títulos y cuáles trabajan): con su id se puede abrir una
     conversación desde cualquier sitio —una pestaña, una copia recién hecha— y saber su
     nombre sin volver a preguntar. */
  listaConvs = list;
  /* v4.2: buscador del historial — por título Y por lo que se dijo dentro. El texto
     buscable viene ya preparado y acotado desde el proceso principal (`busca`), así que
     filtrar es instantáneo al teclear y no hay una ida y vuelta por pulsación. */
  const q = ($('#histSearch') && $('#histSearch').value.trim().toLowerCase()) || '';
  if (q)
    list = list.filter((c) =>
      String(c.busca || c.title || '')
        .toLowerCase()
        .includes(q),
    );
  if (!list.length) {
    box.innerHTML = q
      ? `<div class="subnote">${esc(I18N.t('vistas.hist.sinCoincidencias', { q }))}</div>`
      : vListEmpty(
          'history',
          I18N.t('vistas.hist.vacio.titulo'),
          I18N.t('vistas.hist.vacio.texto'),
        );
    return;
  }
  for (const c of list) {
    const it = document.createElement('div');
    it.className = 'hitem';
    // fila operable con teclado: era un div con click, invisible para el tabulador
    it.setAttribute('tabindex', '0');
    // sin role=button: la fila CONTIENE un botón (eliminar) y un solo rol
    // anunciaría un botón que en realidad tiene dos acciones
    it.setAttribute('aria-label', I18N.t('vistas.hist.abrir', { titulo: c.title }));
    it.title = c.title;
    const d = new Date(c.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    it.innerHTML = `<div class="hic">${ic('chat')}</div>
      <div class="hmain"><b>${esc(c.title)}</b><small>${c.busy ? '<span class="hbusy">' + esc(I18N.t('vistas.hist.trabajando')) + '</span> ' : ''}${esc(I18N.t(c.count === 1 ? 'vistas.hist.mensajes.uno' : 'vistas.hist.mensajes.varios', { n: c.count }))} · ${when}</small></div>
      <button class="btn ghost sq hfork" data-fork="${esc(c.id)}" title="${esc(I18N.t('vistas.hist.duplicar'))}" aria-label="${esc(I18N.t('vistas.hist.duplicar.aria', { titulo: c.title }))}">${ic('copy')}</button>
      <button class="btn ghost sq danger hdel" title="${esc(I18N.t('vistas.hist.eliminar'))}">${ic('trash')}</button>`;
    it.addEventListener('click', (ev) => {
      if (ev.target.closest('.hdel') || ev.target.closest('[data-fork]')) return;
      openConversation(c.id, c.title);
    });
    it.addEventListener('keydown', (ev) => {
      if (ev.target !== it || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      it.click();
    });
    it.querySelector('[data-fork]').onclick = async (ev) => {
      ev.stopPropagation();
      const r = await window.sagitari.convFork(c.id);
      if (!r || !r.ok) {
        showToast(I18N.t('vistas.hist.duplicar.fallo'));
        return;
      }
      /* main ya ha cambiado de hilo: la copia es la conversación en curso. Se refresca
         el historial PRIMERO (así la copia ya está en la lista con su nombre) y se abre
         en su propia pestaña, con su hilo copiado a la vista. */
      await renderHistory();
      await openConversation(r.id, tituloDeConv(r.id));
    };
    it.querySelector('.hdel').onclick = async (ev) => {
      ev.stopPropagation();
      if (!(await askConfirm(it, I18N.t('vistas.hist.eliminar.confirmar', { titulo: c.title }), I18N.t('vistas.hist.eliminar.detalle')))) return;
      await window.sagitari.convDel(c.id);
      renderHistory();
    };
    box.appendChild(it);
  }
}

/* El hilo en curso (`currentConvId`) lo declara 10-chat.js; aquí sólo se sigue el
   que main acaba de abrir, crear o bifurcar. Va en una función para que el
   fichero lo LEA (no sólo lo escriba) y para no repetir el guard cuatro veces.
   Además deja a la vista la pestaña de ese hilo (`abrirRuntime`): desde que varias
   conversaciones pueden estar abiertas a la vez, cambiar de hilo es cambiar de pestaña,
   y el hilo abierto SIEMPRE tiene una. */
function recordarHilo(id, titulo) {
  const nuevo = id || null;
  if (currentConvId !== nuevo) currentConvId = nuevo;
  const rt = abrirRuntime(nuevo);
  if (titulo && !rt.titulo) rt.titulo = titulo;
  return nuevo;
}

/** Abre (o trae al frente) la conversación `id` en SU pestaña. Cambiar de conversación
    está SIEMPRE permitido: cada una tiene su nodo de mensajes y su turno, así que una
    puede seguir trabajando mientras se usa otra (antes había que esperar a que
    terminara, y por eso esta función se negaba). `titulo` es el nombre conocido
    (Historial o lista) para su pestaña. */
async function openConversation(id, titulo) {
  const r = await window.sagitari.convOpen(id);
  if (!r || !r.ok) {
    showToast(I18N.t('vistas.conv.abrir.fallo'));
    return;
  }
  // el hilo en curso pasa a ser éste (main ya lo hizo en `conv:open`): pestaña + runtime
  const rt = recordarHilo(id);
  if (titulo && !rt.titulo) rt.titulo = titulo;
  /* El estado de turno lo manda el proceso principal (`conv:open` viaja con `busy`): una
     conversación que siguió trabajando sin mirarla vuelve marcada como ocupada. */
  rt.busy = !!r.busy;
  reflejarTurno(rt);
  if (!r.busy) resetChatView(r.messages);
  /* Con su turno en vuelo NO se repinta: su nodo ya tiene lo pintado hasta ahora (la
     respuesta en curso incluida) y rehacerlo desde el historial guardado lo borraría. */
  const mensajes = r.messages || [];
  setChatTitle((mensajes.find((m) => m.role === 'user') || {}).content || titulo || rt.titulo || I18N.t('hist.nueva'));
  pintarHiloActivo(); // título, estado, contexto y deshacer: los de ESTA conversación
  goto('chat');
  feed(I18N.t('vistas.conv.restaurada'), 'blu');
}

/** Vuelve el chat a cero y, si hay historial, lo pinta con su modo por turno. */
function resetChatView(messages) {
  /* Última barrera: repintar el hilo A LA VISTA mientras su turno trabaja tiraría lo que
     hay pintado del turno (la burbuja pendiente, su stream). Cambiar de conversación ya
     no pasa por aquí —cada pestaña tiene su nodo y su estado—, así que esto sólo salta en
     los repintados internos (rebobinar, /compact). */
  if (busy) {
    showToast(I18N.t('vistas.conv.ocupada'));
    return false;
  }
  cancelStreamRender();
  msgs.innerHTML = '';
  pendingAssistant = null;
  pendingTurn = null;
  lastAssistantEl = null;
  lastTurnSummary = '';
  stampDia = null; // una conversación nueva vuelve a estampar su día
  setChatStatus('');
  const list = messages || [];
  if (!list.length) {
    showEmpty();
    pinned = true;
    scroll(true);
    return;
  }
  hideEmpty();
  for (const m of list) {
    // separador de día REAL al restaurar: sale al empezar y cada vez que el hilo salta de
    // día, con la fecha de los mensajes (antes se estampaba «Hoy · <hora actual>» arriba
    // aunque la conversación fuera de la semana pasada)
    dayStamp(m.ts);
    const b = bubble(m.role, { mode: m.mode, ts: m.ts });
    // el contenido guardado lleva el texto de los adjuntos incrustado: lo
    // escondemos de la burbuja y enseñamos solo las miniaturas/nombres
    let html = typeof m.content === 'string' ? m.content : '';
    if (m.attachments && m.attachments.length) {
      html = html.replace(/He adjuntado archivos para que los uses en tu respuesta:\n\n[\s\S]*$/, '').trim();
    }
    const tieneTraza =
      m.role === 'assistant' &&
      m.trace &&
      ((m.trace.tools || []).length || (m.trace.think && m.trace.think.text) || (m.trace.todos || []).length);
    if (tieneTraza)
      restaurarTraza(b, m.trace, html); // razonamiento + herramientas + respuesta
    else b.innerHTML = fmt(html || '');
    if (m.attachments && m.attachments.length) paintAttachments(b, m.attachments);
    if (m.role === 'assistant') {
      msgActions(b.closest('.msg-body') || b, m.content, {});
      lastAssistantEl = b;
    }
  }
  refreshMsgActions();
  pinned = true;
  scroll(true);
}

async function newConversation() {
  /* Se puede empezar una conversación nueva aunque la anterior siga trabajando: la
     anterior conserva su pestaña, su nodo y su turno (su respuesta se queda en su hilo). */
  const r = await window.sagitari.convNew();
  // main devuelve el id del hilo recién creado y ya cambió el suyo: seguirlo
  // (null sólo si el IPC no trajo id, que degrada sin romper)
  recordarHilo(r && r.ok && r.id);
  resetChatView([]);
  setChatTitle(I18N.t('hist.nueva'));
  pintarHiloActivo();
  goto('chat');
  $('#chatInput').focus();
}
$('#btnClear').onclick = newConversation;
$('#histNew').onclick = newConversation;
$('#btnGoHistory').onclick = () => goto('history');
// v4.2: el buscador refiltra el historial (con debounce corto para no repintar por tecla)
if ($('#histSearch')) {
  let histTimer = null;
  $('#histSearch').oninput = () => {
    clearTimeout(histTimer);
    histTimer = setTimeout(renderHistory, 140);
  };
}

// copiar la conversación completa, de un vistazo, al portapapeles
$('#btnCopyConv').onclick = () => {
  const parts = [];
  msgs.querySelectorAll('.msg').forEach((m) => {
    const who = m.classList.contains('me') ? CFG.settings.userName || I18N.t('chat.tu') : 'Sagitari';
    const badge = m.querySelector('.msg-mode');
    const t = m.querySelector('.bubble');
    if (!t) return;
    // el razonamiento no forma parte de la conversación: se copia la respuesta
    const copia = t.cloneNode(true);
    copia.querySelectorAll('.thinkblock').forEach((x) => x.remove());
    parts.push(`## ${who}${badge ? ' · ' + badge.textContent.trim() : ''}\n${copia.innerText.trim()}`);
  });
  copyText(parts.join('\n\n'), I18N.t('vistas.conv.copiada'));
};

// ============ mode switcher: segmented en chat + pill en inicio + Alt+M ============
const MODE_ORDER = K.MODE_ORDER;
/* La tecla de cambio de modo se pinta en su cápsula: es un nombre de tecla, no una frase. */
const TECLA_MODO = 'Alt+M';
async function setMode(m) {
  if (m === mode) return;
  const anterior = mode;
  const r = await window.sagitari.setMode(m);
  /* El canal devuelve la cadena del modo nuevo; si el guardado en disco falló devuelve
     `{ok:false,error}`. Ese router recibe el saveConfig crudo —solo hace console.error—,
     así que NO hay toast del proceso principal: el aviso es de aquí. Y como el modo ya
     se aplicó en memoria allí, se le devuelve el anterior para que el motor no corra con
     uno distinto del que enseñan el segmento y la píldora sin que nadie se entere. */
  if (r && typeof r === 'object') {
    if (mode === anterior) {
      try {
        await window.sagitari.setMode(anterior);
      } catch {}
    }
    /* El motivo CRUDO tiene que llegar al usuario (es lo que le dice si el archivo está
       en solo lectura, sin permisos o en uso); cuando es un bloqueo pasajero de Windows
       se le añade la causa en lenguaje llano delante, no se sustituye. */
    const crudo = String((r && r.error) || '');
    const motivo = crudo
      ? /EPERM|EACCES|EBUSY/.test(crudo)
        ? I18N.t('vistas.modo.motivo.bloqueo', { crudo })
        : crudo
      : I18N.t('vistas.modo.motivo.generico');
    showToast(I18N.t('vistas.modo.guardar.fallo', { motivo }));
    return;
  }
  mode = r;
  updateModeUI();
  const M = K.mode(mode);
  showToast(I18N.t('vistas.modo.cambiado', { modo: M.label, lema: M.tagline }));
}
function renderModeSeg() {
  // el MISMO segmento vive en el chat y en la home: idéntico aspecto y comportamiento
  for (const seg of [$('#modeSeg'), $('#modeSegHome')]) {
    if (!seg) continue;
    seg.innerHTML = MODE_ORDER.map((k) => {
      const M = K.mode(k);
      return `<button data-m="${k}" class="${k === mode ? 'on ' + k : ''}" title="${esc(M.name)} — ${esc(M.tagline)}" aria-pressed="${k === mode}">${ic(M.icon)}<span>${M.label}</span></button>`;
    }).join('');
    seg.querySelectorAll('button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  }
}

/** Tarjetas de modo del estado vacío: explican y permiten cambiar con un clic.
    Sin viñetas: la etiqueta + la frase corta ya distinguen los cuatro modos, y la
    tarjeta de tres líneas (con el compositor justo debajo) pedía siete decisiones
    antes de escribir la primera palabra. */
function renderEmptyModes() {
  const box = $('#ceModes');
  if (!box) return;
  box.innerHTML = MODE_ORDER.map((k) => {
    const M = K.mode(k);
    return `<button class="ce-mode${k === mode ? ' on' : ''}" style="--mr:${M.rgb}" data-m="${k}" aria-pressed="${k === mode}">
      <span class="cm-top">${ic(M.icon)}<b>${esc(M.name)}</b></span>
      <span class="cm-tag">${esc(M.label)} · ${esc(M.tagline)}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
}
function updateModeUI() {
  $('#modeLabel').innerHTML = '<span class="hint-key">' + TECLA_MODO + '</span> ' + esc(I18N.t('vistas.modo.atajo'));
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
/* La vista Memoria vive en renderer/memoria-ui.js (ficha, bandeja, hábitos, buscador,
   papelera y pie). Aquí ya no queda nada suyo: el router de vistas llama a
   `renderMemoria()` por su nombre. La vieja lista plana con deslizador de importancia se
   retiró con ella. */

// ============ v1.2: relevancia de memoria (Ajustes) ============
async function fillMemorySens() {
  const el = $('#memSens');
  if (!el) return;
  try {
    el.value = CFG.settings.memSensitivity ?? 2;
  } catch {}
  el.onchange = async () => {
    const v = Math.max(0, Math.min(3, Number(el.value) || 0));
    el.value = v;
    await window.sagitari.setSettings({ memSensitivity: v });
    showToast(I18N.t('vistas.memoria.sensibilidad', { n: v }));
  };
}
// se llama desde init(), después de fillSettings() (antes CFG.settings iba vacío)

// ============ skills view ============
async function renderSkills() {
  const box = $('#skillsList');
  if (!box) return;
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.skillsList()) || [];
  } catch (e) {
    err = e;
  }
  box.innerHTML = '';
  if (err) {
    box.innerHTML = `<div class="subnote">${esc(I18N.t('vistas.skills.fallo', { motivo: (err && err.message) || err }))}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = vListEmpty(
      'zap',
      I18N.t('vistas.skills.vacio.titulo'),
      I18N.t('vistas.skills.vacio.texto'),
    );
    return;
  }
  for (const s of list) {
    const it = document.createElement('div');
    it.className = 'memitem skillitem' + (s.enabled ? '' : ' off');
    /* Una sola línea de meta (autor, herramientas, deps, repo, coste): la ficha se
       escanea de arriba abajo y los controles quedan alineados a la derecha. */
    const partes = [];
    if (s.author) partes.push(I18N.t('vistas.skills.autor', { autor: s.author }));
    if (s.allowTools) partes.push(I18N.t('vistas.skills.tools', { lista: s.allowTools }));
    if (s.dependencies && s.dependencies.length) partes.push(I18N.t('vistas.skills.deps', { lista: s.dependencies.join(', ') }));
    if (s.source) partes.push(I18N.t('vistas.skills.origen', { repo: s.source.repo }));
    partes.push('~' + Math.ceil(s.bodyChars / 4) + ' tok');
    it.innerHTML = `
      <span class="tc-mark">${ic('zap')}</span>
      <span class="mt"><b>${esc(s.name)}</b>${s.version ? ` <span class="md">v${esc(s.version)}</span>` : ''}${s.category ? ` <span class="md">· ${esc(s.category)}</span>` : ''}
        <small class="md sdesc">${esc(s.description)}</small>
        <small class="md smeta">${esc(partes.join(' · '))}</small></span>
      <span class="mrow-ctl">
        ${s.source ? `<button class="btn ghost sq" data-update title="${esc(I18N.t('vistas.skills.actualizar.title'))}">${ic('history')}</button>` : ''}
        <button class="btn ghost sq" data-view title="${esc(I18N.t('vistas.skills.ver.title'))}">${ic('search')}</button>
        <label class="sw ${s.enabled ? 'on' : ''}" data-sw title="${esc(I18N.t('vistas.skills.activar.title'))}" aria-label="${esc(I18N.t('vistas.skills.activar.aria', { nombre: s.name }))}"></label>
        <button class="btn ghost sq danger" data-del title="${esc(I18N.t('vistas.skills.eliminar.title'))}">${ic('trash')}</button>
      </span>`;
    it.querySelector('[data-sw]').onclick = async (e) => {
      await window.sagitari.skillsToggle(s.id, !s.enabled);
      renderSkills();
    };
    it.querySelector('[data-del]').onclick = async () => {
      if (!(await askConfirm(it, I18N.t('vistas.skills.eliminar.confirmar', { nombre: s.name }), I18N.t('vistas.skills.eliminar.detalle')))) return;
      await window.sagitari.skillsDelete(s.id);
      renderSkills();
    };
    const ub = it.querySelector('[data-update]');
    if (ub)
      ub.onclick = async (e) => {
        e.stopPropagation();
        ub.disabled = true;
        try {
          const r = await window.sagitari.skillsUpdate(s.id);
          showToast(r.changed ? I18N.t('vistas.skills.actualizada') : I18N.t('vistas.skills.alDia'));
        } catch (err) {
          showToast(I18N.t('ajustes.error', { motivo: err.message || err }));
        }
        renderSkills();
      };
    it.querySelector('[data-view]').onclick = async () => {
      const full = await window.sagitari.skillsRead(s.id);
      if (full) showToast(full.name + ': ' + full.description);
    };
    box.appendChild(it);
  }
  /* Los interruptores que acaban de pintarse son nodos NUEVOS: la vista se repinta sola
     al activar una skill, al actualizarla y al importar, y sin esta llamada se quedaban
     sin role=switch, sin tabindex y sin Enter/Espacio (sólo los pulía el goto() de la
     entrada a la vista, que aquí ya ha pasado). Se pule SIEMPRE que se pinta. */
  polishSwitches();
}
$('#skillImportBtn').onclick = async () => {
  const btn = $('#skillImportBtn');
  if (btn.disabled) return;
  const inp = $('#skillImportInput'),
    msg = $('#skillMsg');
  const repo = inp.value.trim();
  if (!repo) {
    msg.textContent = I18N.t('vistas.skills.importar.falta');
    return;
  }
  msg.textContent = I18N.t('vistas.skills.importando', { repo });
  btn.disabled = true;
  try {
    const inst = await skillsImportConfirmed(repo, (t) => {
      msg.textContent = t;
    });
    if (!inst) return; // previa a la vista: el segundo clic instala (el botón se reactiva en finally)
    msg.textContent = importSummary(inst);
    inp.value = '';
    renderSkills();
  } catch (err) {
    msg.textContent = I18N.t('ajustes.error', { motivo: err.message || err });
  } finally {
    btn.disabled = false;
  }
};
$('#skillsFolderBtn').onclick = async () => {
  try {
    await window.sagitari.skillsOpenFolder();
  } catch (e) {
    showToast(I18N.t('vistas.skills.carpeta.fallo', { motivo: (e && e.message) || e }));
  }
};
$('#skillCreateBtn').onclick = async () => {
  const btn = $('#skillCreateBtn');
  if (btn.disabled) return;
  const msg = $('#skillMsg');
  const name = $('#skillNewName').value.trim(),
    desc = $('#skillNewDesc').value.trim(),
    body = $('#skillNewBody').value.trim();
  if (!name || !desc) {
    msg.textContent = I18N.t('vistas.skills.crear.falta');
    return;
  }
  btn.disabled = true;
  try {
    await window.sagitari.skillsCreate({ name, description: desc, body });
    $('#skillNewName').value = $('#skillNewDesc').value = $('#skillNewBody').value = '';
    msg.textContent = I18N.t('vistas.skills.creada', { nombre: name });
    renderSkills();
  } catch (err) {
    msg.textContent = I18N.t('ajustes.error', { motivo: err.message || err });
  } finally {
    btn.disabled = false;
  }
};

// ============ agents view (v4.3) ============
/* La vista enseña el registro REAL de subagentes (agentsCustom), no un
   escaparate: antes eran 6 tarjetas fijas que ni cuadraban en número con los
   agentes que existen. Este mapa es sólo presentación (icono y color); un
   agente que no esté aquí cae en el genérico y nunca se queda sin cara. */
const AGENT_LOOK = {
  research: { icon: 'search', cls: 'a-b' },
  browser: { icon: 'compass', cls: 'a-c' },
  coding: { icon: 'code', cls: 'a-p' },
  file: { icon: 'folder', cls: 'a-y' },
  vision: { icon: 'eye', cls: 'a-b2' },
  verification: { icon: 'check', cls: 'a-p' },
  review: { icon: 'list', cls: 'a-y2' },
};
const AGENT_LOOK_FALLBACK = { icon: 'agents', cls: 'a-p2' };

/** «Integrado» o «cargado de disco» a partir del `origen` que da el registro.
    Un valor que no reconocemos se enseña tal cual y, si no viene, no se pinta
    nada: mejor sin insignia que con una inventada. */
function origenAgente(origen) {
  const s = String(origen || '').trim();
  if (!s) return { label: '', cls: '' };
  if (/disco|disk|custom|usuario|user|extern|fichero|cargad/i.test(s))
    return { label: I18N.t('vistas.agentes.disco'), cls: 'custom' };
  if (/integ|built|sistema|nativ|default|predefinid/i.test(s)) return { label: I18N.t('vistas.agentes.integrado'), cls: '' };
  return { label: s, cls: '' };
}

/** Herramientas de un agente, vengan como array o como texto separado por comas. */
function toolsAgente(tools) {
  if (Array.isArray(tools)) return tools.map((t) => String(t)).filter(Boolean);
  const s = String(tools || '').trim();
  return s ? s.split(/[,\s]+/).filter(Boolean) : [];
}

/** Una tarjeta de agente. Todo el texto lo produce el registro: va escapado. */
function agentCard(a) {
  const id = String((a && a.id) || '');
  const look = AGENT_LOOK[id] || AGENT_LOOK_FALLBACK;
  const nombre = String((a && a.nombre) || id || I18N.t('vistas.agentes.sinNombre'));
  const desc = String((a && a.descripcion) || '');
  const ori = origenAgente(a && a.origen);
  const tools = toolsAgente(a && a.tools);
  const meta = [];
  if (a && a.modelo) meta.push(I18N.t('vistas.agentes.modelo', { modelo: String(a.modelo) }));
  if (a && a.maxSteps)
    meta.push(I18N.t(a.maxSteps === 1 ? 'vistas.agentes.pasos.uno' : 'vistas.agentes.pasos.varios', { n: a.maxSteps }));
  if (tools.length)
    meta.push(I18N.t(tools.length === 1 ? 'vistas.agentes.herramientas.uno' : 'vistas.agentes.herramientas.varios', { n: tools.length }));
  /* Los nombres de las herramientas son referencia, no la tarjeta: van en el
     tooltip y aquí queda el recuento para que la ficha se lea de un vistazo. */
  const metaTxt = meta.join(' · ');
  const toolsTxt = tools.length ? I18N.t('vistas.agentes.tools', { lista: tools.join(', ') }) : '';
  return `<div class="acard" id="agentCard-${esc(id)}" title="${esc(toolsTxt)}">
    <div class="aic ${look.cls}">${ic(look.icon)}</div>
    <div class="amain">
      <div class="ahead"><b>${esc(nombre)}</b>${ori.label ? `<span class="abadge${ori.cls ? ' ' + ori.cls : ''}">${esc(ori.label)}</span>` : ''}</div>
      ${desc ? `<small>${esc(desc)}</small>` : ''}
      ${metaTxt ? `<span class="amd">${esc(metaTxt)}</span>` : ''}
    </div>
    <span class="adot"></span>
  </div>`;
}

/** Pinta la vista Agentes desde el registro real, con carga y error explícitos. */
async function renderAgents() {
  const box = $('#agentsList');
  if (!box) return;
  box.setAttribute('aria-busy', 'true');
  const cuenta = $('#agentsCount');
  let r = null;
  try {
    r = await window.sagitari.agentsCustom();
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  const agentes = r && r.ok && Array.isArray(r.agentes) ? r.agentes : [];
  if (!r || !r.ok) {
    box.innerHTML = `<div class="subnote">${esc(I18N.t('vistas.agentes.fallo', { motivo: (r && r.error) || I18N.t('chat.error.desconocido') }))}</div>`;
    if (cuenta) cuenta.textContent = '';
    box.setAttribute('aria-busy', 'false');
    return;
  }
  if (!agentes.length) {
    box.innerHTML = vListEmpty('agents', I18N.t('vistas.agentes.vacio.titulo'), I18N.t('vistas.agentes.vacio.texto'));
  } else {
    box.innerHTML = agentes.map(agentCard).join('');
  }
  if (cuenta)
    cuenta.textContent = I18N.t(
      agentes.length === 1 ? 'vistas.agentes.cuenta.uno' : 'vistas.agentes.cuenta.varios',
      { n: agentes.length },
    );
  box.setAttribute('aria-busy', 'false');
}

$('#agentsReload').onclick = async () => {
  const btn = $('#agentsReload');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await window.sagitari.agentsCustomRecargar();
  } catch (e) {
    showToast(I18N.t('vistas.agentes.recargar.fallo', { motivo: (e && e.message) || e }));
  } finally {
    btn.disabled = false;
  }
  renderAgents();
};

/* La lista se pinta al ENTRAR en la vista, sea por clic o por Alt+4: se observa
   la clase `.on` de la sección en vez de engancharse a cada atajo (goto no
   refresca esta vista, a diferencia de Tareas o Skills). */
(function vigilarVistaAgentes() {
  const v = document.getElementById('view-agents');
  if (!v) return;
  new MutationObserver(() => {
    if (v.classList.contains('on')) renderAgents();
  }).observe(v, { attributes: true, attributeFilter: ['class'] });
  if (v.classList.contains('on')) renderAgents();
})();

// ============ equipo view (v4.4, modo EQUIPO) ============
/* El equipo trabaja en el proceso principal, así que aquí sólo se ve lo que cuentan sus
   eventos. NO hay canal de lectura: el estado se ACUMULA por conversación —cada team_*
   viaja con su convId— y por eso cambiar de pestaña no mezcla equipos y una conversación
   sin equipo dice la verdad al enseñar el vacío (un equipo no sobrevive al reinicio de la
   app en esta versión: el vacío ES el estado real, no una carga que se quedó colgada).
   Todo lo que se pinta sale de esos eventos; nada inventado.

   Vocabulario de estado: el del motor (trabajando · esperando · terminado · fallo) y,
   en el tablero, el de la lista de tareas (pending · in_progress · completed), que es de
   donde viene la forma de sus ítems. Lo que no esté en la tabla se enseña tal cual. */
const EQUIPO_BUZON_MAX = 200; // el buzón es un feed vivo, no un archivo: se queda lo último

/* Vocabulario de estado: la etiqueta es una CLAVE del diccionario y el estilo, una clase. */
const ESTADO_CLAVE = 'vistas.estado.';
const EQUIPO_ESTADOS = {};
for (const [clave, cls] of [
  ['trabajando', 'eq-trabajando'],
  ['esperando', 'eq-esperando'],
  ['terminado', 'eq-terminado'],
  ['fallo', 'eq-fallo'],
  ['interrumpido', 'eq-interrumpido'],
  ['pending', ''],
  ['in_progress', 'eq-trabajando'],
  ['completed', 'eq-terminado'],
  ['failed', 'eq-fallo'],
]) {
  EQUIPO_ESTADOS[clave] = {
    cls,
    get label() {
      return I18N.t(ESTADO_CLAVE + clave);
    },
  };
}

/** Cómo se llama y se pinta un estado. Un valor que no conocemos se dice sin inventarlo. */
function estadoEquipo(v) {
  const k = String(v || '').toLowerCase();
  return EQUIPO_ESTADOS[k] || { label: k || I18N.t('vistas.estado.sin'), cls: '' };
}

const equipos = new Map(); // convId -> estado acumulado del equipo de ESA conversación
let equipoLimiteMiembros = 0; // tope de compañeros que da el motor (meta:get); 0 = sin dato

/** Clave de conversación de un evento (o de la conversación abierta). */
function claveEquipo(convId) {
  return String(convId || hiloActual() || '');
}

/** Estado del equipo de una conversación (con o sin creación). */
function equipoDe(convId, crear) {
  const clave = claveEquipo(convId);
  let e = equipos.get(clave) || null;
  if (!e && crear) {
    e = {
      convId: clave,
      inicio: Date.now(),
      fin: 0,
      estado: 'vivo', // 'vivo' | 'fin'
      ok: null,
      miembros: new Map(),
      orden: [],
      mensajes: [],
      tablero: [],
      resumen: '',
      gasto: null,
    };
    equipos.set(clave, e);
  }
  return e;
}

/** Un compañero, venga del team_start (aún sin encargo) o del team_member (ya con él). */
function equipoMiembro(e, ev) {
  const id = String((ev && ev.id) || '');
  if (!id) return null;
  let m = e.miembros.get(id);
  if (!m) {
    m = { id, spec: '', name: '', estado: 'trabajando', tarea: '', expect: '', atencion: '', resumen: '', evidencia: '', permisos: 0 };
    e.miembros.set(id, m);
    e.orden.push(id);
  }
  if (ev.spec) m.spec = String(ev.spec);
  /* El nombre lo pone el registro (main). Si un evento llegara sin él, el id sigue
     valiendo: mejor «m2» que una fila sin nombre. */
  if (ev.name) m.name = String(ev.name);
  if (!m.name) m.name = m.spec || id;
  return m;
}

/** Nombre de un extremo del buzón: id de compañero, «lider» o «todos». */
function nombreEquipo(e, id) {
  const k = String(id || '');
  if (k === 'lider' || k === 'líder') return I18N.t('vistas.equipo.lider');
  if (k === 'todos') return I18N.t('vistas.equipo.todos');
  const m = e && e.miembros.get(k);
  return (m && (m.name || m.id)) || k || '—';
}

/** Insignia de permisos pendientes: el mismo lenguaje que el resto (.abadge + .dot).
    La usan el rail y la vista, así que la cuenta se ve igual en los dos sitios. */
function badgeEquipoPermisos(m) {
  const n = Number(m && m.permisos) || 0;
  if (!n) return '';
  const txt = I18N.t(n === 1 ? 'vistas.equipo.permisos.uno' : 'vistas.equipo.permisos.varios', { n });
  return `<span class="abadge eqperm" title="${esc(I18N.t('vistas.equipo.permisos.de', { texto: txt, nombre: (m && m.name) || I18N.t('vistas.equipo.companero') }))}"><span class="dot a-y"></span>${esc(I18N.t(n === 1 ? 'vistas.equipo.permisos.corto.uno' : 'vistas.equipo.permisos.corto.varios', { n }))}</span>`;
}

/** Entra un evento del equipo. Los team_* llegan ANTES de la tarjeta del chat: aquí se
    acumula (para cualquier conversación) y después se pinta lo que toque. */
function equipoEvento(ev) {
  const tipo = String((ev && ev.type) || '');
  const e = equipoDe(ev.convId, true);
  switch (tipo) {
    case 'team_start':
      /* Un encargo nuevo en la MISMA conversación empieza de cero: los eventos que llegan
         describen al equipo que arranca ahora, no al que ya cerró (miembros, buzón y
         tablero del anterior no pintan nada aquí y hacerlos convivir mentiría). */
      e.inicio = Number(ev.ts) || Date.now();
      e.fin = 0;
      e.estado = 'vivo';
      e.ok = null;
      e.resumen = '';
      e.gasto = null;
      e.miembros = new Map();
      e.orden = [];
      e.mensajes = [];
      e.tablero = [];
      e.card = null; // la tarjeta del equipo anterior: la nueva se apunta al pintarla
      for (const mi of Array.isArray(ev.miembros) ? ev.miembros : []) equipoMiembro(e, mi);
      break;
    case 'team_member': {
      const m = equipoMiembro(e, ev);
      if (m) {
        if (ev.estado) m.estado = String(ev.estado);
        if (ev.tarea) m.tarea = String(ev.tarea);
        if (ev.expect) m.expect = String(ev.expect);
        /* `atencion` es POR QUÉ está esperando (un permiso, una pregunta): el estado sólo
           dice «esperando», y sin el motivo el usuario tendría que adivinar qué se le pide. */
        m.atencion = ev.atencion ? String(ev.atencion) : '';
      }
      break;
    }
    case 'team_message':
      e.mensajes.push({
        de: String(ev.de || ''),
        para: String(ev.para || ''),
        texto: String(ev.texto || ''),
        ts: Number(ev.ts) || Date.now(),
      });
      if (e.mensajes.length > EQUIPO_BUZON_MAX) e.mensajes.splice(0, e.mensajes.length - EQUIPO_BUZON_MAX);
      break;
    case 'team_board':
      // el tablero se reemplaza entero: es el estado que apunta el líder, no un diario
      e.tablero = (Array.isArray(ev.items) ? ev.items : []).map((i) => ({
        quien: (i && i.quien) || '',
        que: (i && i.que) || '',
        estado: (i && i.estado) || '',
        nota: (i && i.nota) || '',
      }));
      break;
    case 'team_done': {
      const m = equipoMiembro(e, ev);
      if (m) {
        m.estado = ev.ok === false ? 'fallo' : 'terminado';
        if (ev.resumen) m.resumen = String(ev.resumen);
        if (ev.evidencia) m.evidencia = String(ev.evidencia);
      }
      break;
    }
    case 'team_end': {
      e.estado = 'fin';
      e.fin = Number(ev.ts) || Date.now();
      e.ok = ev.ok !== false;
      e.resumen = ev.resumen ? String(ev.resumen) : '';
      e.gasto = ev.gasto && typeof ev.gasto === 'object' ? ev.gasto : null;
      /* El motor manda el estado REAL de cada compañero al cerrar: a quien sigue esperando al
         usuario se le deja esperando (su permiso pendiente se puede contestar y su vuelta
         continúa), y sólo se les quita lo que ya no está pendiente a los demás. Decir
         «interrumpido» de quien está esperando una respuesta del usuario sería mentir, y
         además borraría la insignia del permiso que el usuario todavía tiene que contestar. */
      for (const mi of Array.isArray(ev.miembros) ? ev.miembros : []) equipoMiembro(e, mi);
      for (const m of e.miembros.values()) {
        if (m.estado !== 'trabajando' && m.estado !== 'esperando') m.permisos = 0;
      }
      break;
    }
    default:
      return; // un team_* que no conocemos no toca el estado
  }
  pintarEquipoDe(e.convId);
}

/** Repinta las superficies del equipo tras un cambio de estado: la vista y el rail son de
    la conversación ABIERTA (el mismo criterio que el chat), y el contador del menú es de
    toda la app —un equipo en marcha en otra conversación también se ve ahí—. */
function pintarEquipoDe(convId) {
  if (claveEquipo(convId) === claveEquipo(null)) {
    renderEquipo();
    pintarRailEquipo(); // definida en 20-app.js: el rail es suyo
    refrescarEquipoChat(); // y la tarjeta del turno (10-chat.js): la insignia vive en su fila
  }
  pintarBadgeEquipo();
}

/** Contador del menú: compañeros vivos en CUALQUIER conversación. */
function pintarBadgeEquipo() {
  let n = 0;
  for (const e of equipos.values()) {
    if (e.estado !== 'vivo') continue;
    for (const m of e.miembros.values()) if (m.estado === 'trabajando' || m.estado === 'esperando') n++;
  }
  setBadge('#nbEquipo', n);
}

/** Ficha de un compañero, para atribuir un permiso o una herramienta a SU miembro.
    Devuelve null si ese id no es de este equipo: entonces no se inventa un nombre. */
function equipoFicha(convId, id) {
  const e = equipoDe(convId, false);
  const m = e && e.miembros.get(String(id || ''));
  return m ? { id: m.id, name: m.name || m.id, spec: m.spec } : null;
}

/** Suma o resta un permiso pendiente al compañero que lo pide. La barra de confirmación y
    la insignia salen de AQUÍ: un compañero puede estar esperando un permiso mientras otro
    trabaja, y la cuenta tiene que ser la misma en los dos sitios. Devuelve false cuando ese
    id no es de un equipo conocido (el líder, o un permiso sin equipo detrás). */
function equipoPermiso(convId, member, delta) {
  const e = equipoDe(convId, false);
  const m = e && e.miembros.get(String(member || ''));
  if (!m) return false;
  m.permisos = Math.max(0, (Number(m.permisos) || 0) + (delta > 0 ? 1 : -1));
  pintarEquipoDe(e.convId);
  return true;
}

/** ¿Hay un equipo vivo en OTRA conversación? Es lo único que se puede saber sin mentir
    cuando la que está abierta no tiene equipo: cada convId tiene su estado. */
function equipoEnOtroHilo() {
  const abierto = claveEquipo(null);
  for (const e of equipos.values()) if (e.convId !== abierto && e.estado === 'vivo') return e;
  return null;
}

/** El TURNO de esa conversación se ha cerrado (o ha muerto: un corte por guardarraíl, un
    fallo, el botón Detener): un equipo que siga «vivo» ya no lo está. El motor sólo manda
    `team_end` cuando el turno llega al final, así que sin esto el rail y el contador del
    menú seguirían contando compañeros que se apagaron con el turno. */
function equipoCierraPorTurno(convId) {
  const e = equipoDe(convId, false);
  if (!e || e.estado !== 'vivo') return;
  e.estado = 'fin';
  e.fin = Date.now();
  e.ok = false; // no llegó al final: el cierre se cuenta como interrumpido
  for (const m of e.miembros.values()) {
    if (m.estado === 'trabajando' || m.estado === 'esperando') m.estado = 'interrumpido';
    m.permisos = 0;
  }
  pintarEquipoDe(e.convId);
}

/** El tope de compañeros lo fija el motor (meta:get): la vista no lo inventa. */
async function cargarLimiteEquipo() {
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    const n = Number(m && m.equipo && m.equipo.limiteMiembros);
    if (Number.isFinite(n) && n > 0) equipoLimiteMiembros = n;
  } catch {
    // sin dato se dice sin número; no hay nada que avisar aquí
  }
  return equipoLimiteMiembros;
}

function notaEquipo() {
  const base = I18N.t('vistas.equipo.nota');
  return equipoLimiteMiembros ? base + ' ' + I18N.t('vistas.equipo.tope', { n: equipoLimiteMiembros }) : base;
}

/** Una tarjeta de miembro: la misma piel que las de la vista Agentes (.acard). */
function equipoCard(m) {
  const look = K.subagent(m.spec) || { icon: 'agents', cls: 'a-p2' };
  const est = estadoEquipo(m.estado);
  return `<div class="acard ${est.cls}" id="equipoMiembro-${esc(m.id)}">
    <div class="aic ${look.cls}">${ic(look.icon)}</div>
    <div class="amain">
      <div class="ahead"><b>${esc(m.name || m.id)}</b><span class="abadge ${est.cls}">${esc(est.label)}</span>${badgeEquipoPermisos(m)}</div>
      <small>${esc(m.tarea || I18N.t('vistas.equipo.sinEncargo'))}</small>
      ${m.spec ? `<span class="amd">${esc(I18N.t('vistas.equipo.especialista', { spec: m.spec }))}${m.expect ? ' · ' + esc(I18N.t('vistas.equipo.criterio', { texto: K.clip(m.expect, 120) })) : ''}</span>` : ''}
      ${m.atencion ? `<span class="amd">${esc(I18N.t('vistas.equipo.teNecesita', { texto: K.clip(m.atencion, 200) }))}</span>` : ''}
      ${m.resumen ? `<span class="amd">${esc(K.clip(m.resumen, 240))}</span>` : ''}
    </div>
    <span class="adot"></span>
  </div>`;
}

function equipoFilaBuzon(e, msg) {
  const hora = new Date(msg.ts).toLocaleTimeString(I18N.idioma, { hour: '2-digit', minute: '2-digit' });
  return `<div class="eqfila">
    <span class="eqde">${esc(nombreEquipo(e, msg.de))}</span><span class="eqfl">→</span
    ><span class="eqpara">${esc(nombreEquipo(e, msg.para))}</span
    ><span class="eqtexto">${esc(msg.texto)}</span><span class="eqts">${hora}</span>
  </div>`;
}

function equipoFilaTablero(e, i, n) {
  const est = i.estado ? estadoEquipo(i.estado) : null;
  return `<div class="eqitem">
    <span class="eqquien">${esc(nombreEquipo(e, i.quien))}</span>
    <span class="eqque">${esc(i.que)}${est ? ` <span class="abadge ${est.cls}">${esc(est.label)}</span>` : ''}${
      i.nota ? `<span class="eqnota">${esc(i.nota)}</span>` : ''
    }</span>
  </div>`;
}

/** El resumen del cierre, con su recaída HONESTA: el motor puede cerrar un encargo sin
    resumen (el corte por presupuesto viaja por el buzón, no aquí). Entonces no se dice
    «terminó»: se cuenta cuántos compañeros no llegaron a cerrar su parte. Lo usan la vista
    y la tarjeta del chat, que tienen que contar lo mismo. */
function resumenEquipo(e) {
  if (!e) return '';
  if (e.resumen) return e.resumen;
  const fallidos = [...e.miembros.values()].filter((m) => m.estado === 'fallo' || m.estado === 'interrumpido');
  if (fallidos.length) {
    // el título del bloque ya dice que se detuvo: aquí sólo se explica quién no llegó
    return I18N.t(
      fallidos.length === 1 ? 'vistas.equipo.resumen.parte.uno' : 'vistas.equipo.resumen.parte.varios',
      { n: fallidos.length },
    );
  }
  return e.ok === false ? I18N.t('vistas.equipo.resumen.sinCierre') : I18N.t('vistas.equipo.resumen.sinResumen');
}

/** El cierre del encargo: resumen agregado y gasto del equipo. Con `ok:false` el bloque
    se pinta en rojo: es el estado de error del equipo (p. ej. el corte por presupuesto). */
function equipoCierre(e) {
  const mal = e.ok === false;
  const g = e.gasto || {};
  const gasto = [];
  if (Number.isFinite(Number(g.tokens)) && Number(g.tokens) > 0) gasto.push(I18N.t('vistas.equipo.tokens', { n: K.thousands(g.tokens) }));
  if (Number.isFinite(Number(g.costUsd)) && Number(g.costUsd) > 0) gasto.push('$' + Number(g.costUsd).toFixed(4));
  return `<div class="eqresumen${mal ? ' err' : ''}">
    <b>${esc(I18N.t(mal ? 'vistas.equipo.detenido' : 'vistas.equipo.cerrado'))}</b>
    ${esc(resumenEquipo(e))}
    ${gasto.length ? `\n${esc(I18N.t('vistas.equipo.gasto', { gasto: gasto.join(' · ') }))}` : ''}
  </div>`;
}

/** Pinta la vista Equipo. Sin equipo en esta conversación hay tres casos HONESTOS: el
    líder aún repartiendo (carga), un equipo vivo en otra conversación (se ofrece ir), o
    sencillamente ninguno (vacío). */
function renderEquipo() {
  const box = $('#equipoMiembros');
  if (!box) return;
  const e = equipoDe(null, false);
  const estadoEl = $('#equipoEstado');
  const nota = $('#equipoNota');
  const buzon = $('#equipoBuzon');
  const tablero = $('#equipoTablero');
  const cierre = $('#equipoCierre');
  if (nota) nota.textContent = notaEquipo();

  if (!e) {
    const esperandoLider = busy && currentRunMode === 'equipo';
    box.setAttribute('aria-busy', esperandoLider ? 'true' : 'false');
    if (estadoEl) estadoEl.textContent = '';
    if (buzon) buzon.innerHTML = '<div class="subnote">' + esc(I18N.t('vistas.equipo.sinMensajes')) + '</div>';
    if (tablero) tablero.innerHTML = '<div class="subnote">' + esc(I18N.t('vistas.equipo.sinApuntes')) + '</div>';
    if (cierre) cierre.innerHTML = '';
    if (esperandoLider) {
      // estado de CARGA: el turno va en modo EQUIPO y aún no ha llegado ningún team_*
      box.innerHTML = '<div class="subnote">' + esc(I18N.t('vistas.equipo.repartiendo')) + '</div>';
      return;
    }
    const otro = equipoEnOtroHilo();
    box.innerHTML = vListEmpty(
      'agents',
      I18N.t('vistas.equipo.vacio.titulo'),
      otro ? I18N.t('vistas.equipo.vacio.otro') : I18N.t('vistas.equipo.vacio.sin'),
      otro ? '<button class="btn ghost" data-eqir>' + esc(I18N.t('vistas.equipo.ir')) + '</button>' : '',
    );
    if (otro) {
      const b = box.querySelector('[data-eqir]');
      if (b) b.onclick = () => openConversation(otro.convId, tituloDeConv(otro.convId));
    }
    return;
  }

  box.setAttribute('aria-busy', 'false');
  const miembros = e.orden.map((id) => e.miembros.get(id)).filter(Boolean);
  const enMarcha = miembros.filter((m) => m.estado === 'trabajando').length;
  const esperan = miembros.filter((m) => m.estado === 'esperando').length;
  const permisos = miembros.reduce((s, m) => s + (Number(m.permisos) || 0), 0);
  if (estadoEl) {
    const partes = [I18N.t(miembros.length === 1 ? 'vistas.equipo.cuenta.uno' : 'vistas.equipo.cuenta.varios', { n: miembros.length })];
    if (e.estado === 'vivo') {
      partes.push(enMarcha ? I18N.t('vistas.equipo.enMarcha', { n: enMarcha }) : I18N.t('vistas.equipo.nadie'));
      if (esperan) partes.push(I18N.t('vistas.equipo.esperando', { n: esperan }));
    } else partes.push(I18N.t(e.ok === false ? 'vistas.equipo.detenido.corto' : 'vistas.equipo.terminado'));
    if (permisos) partes.push(I18N.t(permisos === 1 ? 'vistas.equipo.permisos.uno' : 'vistas.equipo.permisos.varios', { n: permisos }));
    estadoEl.textContent = partes.join(' · ');
  }
  box.innerHTML = miembros.length
    ? miembros.map(equipoCard).join('')
    : '<div class="subnote">' + esc(I18N.t('vistas.equipo.sinCompaneros')) + '</div>';
  if (buzon)
    buzon.innerHTML = e.mensajes.length
      ? e.mensajes.map((m) => equipoFilaBuzon(e, m)).join('')
      : '<div class="subnote">' + esc(I18N.t('vistas.equipo.sinMensajes.largo')) + '</div>';
  if (tablero)
    tablero.innerHTML = e.tablero.length
      ? e.tablero.map((i, n) => equipoFilaTablero(e, i, n)).join('')
      : '<div class="subnote">' + esc(I18N.t('vistas.equipo.sinApuntes.largo')) + '</div>';
  if (cierre) cierre.innerHTML = e.estado === 'fin' ? equipoCierre(e) : '';
  // el buzón vive de lo último: el feed se lee por el final, como el del rail
  if (buzon) buzon.scrollTop = buzon.scrollHeight;
}

// ============ tools view ============
const TOOL_INFO = [
  ['run_command', 'terminal', 'vistas.tools.run_command'],
  ['read_file', 'file', 'vistas.tools.read_file'],
  ['write_file', 'doc', 'vistas.tools.write_file'],
  ['list_dir', 'folder', 'vistas.tools.list_dir'],
  ['search_files', 'search', 'vistas.tools.search_files'],
  ['open_app', 'zap', 'vistas.tools.open_app'],
  ['open_url', 'globe', 'vistas.tools.open_url'],
  ['browser_control', 'compass', 'vistas.tools.browser_control'],
  ['screenshot', 'camera', 'vistas.tools.screenshot'],
  ['clipboard', 'clipboard', 'vistas.tools.clipboard'],
  ['notify', 'bell', 'vistas.tools.notify'],
  ['media_control', 'music', 'vistas.tools.media_control'],
  ['window_manage', 'window', 'vistas.tools.window_manage'],
  ['system_info', 'monitor', 'vistas.tools.system_info'],
];
/* El catálogo se agrupa por lo que de verdad decide el usuario: qué herramientas
   piden permiso. Antes eran 14 tarjetas idénticas donde ese dato no aparecía. El título
   de cada grupo es una clave del diccionario. */
const TOOL_GROUPS = [
  { key: 'confirmar', titulo: 'vistas.tools.grupo.confirmar' },
  { key: 'safe', titulo: 'vistas.tools.grupo.safe' },
  { key: 'restricted', titulo: 'vistas.tools.grupo.restricted' },
];
async function renderTools() {
  const g = $('#toolsGrid');
  if (!g) return;
  /* Los dos atajos de la cabecera. Se atan al entrar en la vista: los botones son
     estáticos, pero así el repintado de la rejilla nunca deja un handler viejo. */
  const allowAll = $('#toolsAllowAll');
  if (allowAll)
    allowAll.onclick = async () => {
      if (!(await permitirTodoPermisos(allowAll))) return; // pide confirmación
      await renderTools();
      mostrarAvisoConDeshacer(I18N.t('vistas.tools.todas'));
    };
  const resetAll = $('#toolsResetPerms');
  if (resetAll)
    resetAll.onclick = async () => {
      if (!(await restablecerPermisos())) return;
      await renderTools();
      mostrarAvisoConDeshacer(I18N.t('vistas.tools.reset'));
    };
  let rec = {};
  let perm = {};
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    rec = (m && m.riskDefaults) || {};
    // la POLÍTICA guardada (override del usuario), no sólo la recomendación
    perm = (m && m.permissions) || {};
  } catch {}
  // se vacía ANTES de construir la cabecera: si se limpia después, la borra
  g.innerHTML = '';
  /* Nivel EFECTIVO: lo que el usuario ha fijado o, si no ha fijado nada, lo que
     recomienda la herramienta. La tarjeta cae en el grupo que de verdad gobierna
     hoy, no en el que «debería» — antes el grupo era la recomendación y el nivel
     real vivía en otra vista, así que la tarjeta podía mentir. */
  const nivelDe = (n) => (perm[n] && perm[n] !== 'default' ? perm[n] : rec[n] || 'confirm');
  const grupoDe = (n) => {
    const v = nivelDe(n);
    return v === 'restricted' ? 'restricted' : v === 'safe' ? 'safe' : 'confirmar';
  };
  const head = document.createElement('div');
  head.style.cssText = 'grid-column:1/-1;margin-bottom:6px';
  head.innerHTML =
    '<div class="subnote" style="margin:0">' + I18N.t('vistas.tools.nota') + '</div>';
  g.appendChild(head);
  const NIVELES = [
    ['default', I18N.t('ajustes.perm.defecto')],
    ['safe', I18N.t('ajustes.perm.siempre')],
    ['confirm', I18N.t('ajustes.perm.preguntar')],
    ['restricted', I18N.t('ajustes.perm.bloqueado')],
  ];
  for (const gr of TOOL_GROUPS) {
    const items = TOOL_INFO.filter(([n]) => grupoDe(n) === gr.key);
    if (!items.length) continue;
    const h = document.createElement('div');
    h.className = 'toolsgroup';
    h.textContent = I18N.t(gr.titulo) + ' · ' + items.length;
    g.appendChild(h);
    for (const [n, i, d] of items) {
      /* El desplegable enseña lo GUARDADO («Por defecto» si no hay override), igual
         que la tabla de Seguridad. Antes enseñaba el nivel efectivo y tras «Volver a
         lo recomendado» las tarjetas seguían diciendo «Preguntar antes»: parecía
         que el reset no había hecho nada. El grupo sí va por el efectivo, y la línea
         «recomendado: …» explica por qué la tarjeta cae donde cae. */
      const lvl = perm[n] && perm[n] !== 'default' ? perm[n] : 'default';
      const nombre = K.tool(n).label;
      const recTxt = RISK_LABEL[rec[n] || 'confirm'] || I18N.t('nivel.confirm');
      const c = document.createElement('div');
      c.className = 'toolcard';
      c.innerHTML = `<div class="tctop"><div class="tic">${ic(i)}</div><div class="tc-body"><b>${esc(nombre)}</b> <small class="md">${esc(n)}</small><br><small>${esc(I18N.t(d))}</small><br><small class="md">${esc(I18N.t('ajustes.perm.recomendado', { nivel: recTxt }))}</small></div></div>
        <select class="toolperm" data-tool="${esc(n)}" aria-label="${esc(I18N.t('ajustes.perm.aria', { nombre }))}">
          ${NIVELES.map(([v, t]) => `<option value="${v}"${lvl === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>`;
      // cambiar el nivel aquí es el permiso real: la misma llamada que Ajustes ▸ Seguridad
      c.querySelector('select').onchange = async (e) => {
        await window.sagitari.secSetToolPerm(n, e.target.value);
        showToast(
          I18N.t('ajustes.perm.guardado', { nombre, nivel: e.target.selectedOptions[0].textContent.toLowerCase() }),
        );
        renderTools(); // cambia de grupo: se repinta para que la tarjeta caiga donde toca
      };
      g.appendChild(c);
    }
  }
  // ---- v3.1: herramientas MCP reales del usuario (no están en el catálogo nativo) ----
  // Con el interruptor global apagado el modelo NO recibe ninguna herramienta MCP (main no
  // ofrece el catálogo dinámico): pintarlas aquí diría que el agente puede usarlas.
  let mcp = { servers: [] };
  try {
    mcp = await window.sagitari.mcpList();
  } catch {}
  const conHerramientas = mcp.enabled === false ? [] : (mcp.servers || []).filter((s) => s.enabled && (s.discovered || []).length);
  if (conHerramientas.length) {
    const total = conHerramientas.reduce((n, s) => n + s.discovered.length, 0);
    const h = document.createElement('div');
    h.className = 'toolsgroup';
    h.textContent = I18N.t('vistas.mcp.grupo', { n: total });
    g.appendChild(h);
    for (const s of conHerramientas) {
      /* El permiso de MCP se guarda por SERVIDOR (comodín), no por herramienta: las
         tarjetas de un mismo servidor comparten selector a propósito, y así el nivel
         se puede cambiar también desde aquí en vez de sólo en Ajustes. */
      const wildcard = s.permKey || 'mcp__' + s.id + '__*';
      const lvlMcp = perm[wildcard] && perm[wildcard] !== 'default' ? perm[wildcard] : 'default';
      for (const t of s.discovered) {
        const c = document.createElement('div');
        c.className = 'toolcard';
        c.innerHTML = `<div class="tctop"><div class="tic">${ic('bolt')}</div><div class="tc-body"><b>${esc(t.tool)}</b> <small class="md">${esc(s.name)}</small><br><small>${esc(t.description || '')}</small></div></div>
          <select class="toolperm" data-tool="${esc(wildcard)}" aria-label="${esc(I18N.t('ajustes.perm.mcp.aria', { nombre: s.name }))}">
            ${NIVELES.map(([v, tx]) => `<option value="${v}"${lvlMcp === v ? ' selected' : ''}>${tx}</option>`).join('')}
          </select>`;
        c.querySelector('select').onchange = async (e) => {
          await window.sagitari.secSetToolPerm(wildcard, e.target.value);
          showToast(
            I18N.t('vistas.mcp.guardado', { nombre: s.name, nivel: e.target.selectedOptions[0].textContent.toLowerCase() }),
          );
          renderTools();
        };
        g.appendChild(c);
      }
    }
  }
  // los desplegables de permiso nacen aquí: se mejoran al pintarse (mismo control
  // propio que el resto de la app, con teclado y sin el popup nativo del sistema)
  mejoraSelects(g);
}

// ============ v1.2: tasks view (puntos de control, pausa, reanudación) ============
/* El estado de una tarea: la etiqueta es una CLAVE del diccionario. */
const TAREA_ESTADO_CLAVE = 'vistas.tarea.estado.';
const TASK_STATUS = {};
for (const [clave, cls] of [
  ['pending', 'blu'],
  ['scheduled', 'blu'],
  ['running', 'cy'],
  ['paused', 'pur'],
  ['interrupted', 'pur'],
  ['failed', 'mag'],
  ['completed', 'ok'],
  ['cancelled', 'mag'],
]) {
  TASK_STATUS[clave] = {
    cls,
    get label() {
      return I18N.t(TAREA_ESTADO_CLAVE + clave);
    },
  };
}
/** v4.2: estado vacío ilustrado, reutilizable por todas las vistas de lista.
    Icono + título + explicación con la acción del usuario dentro del texto. */
function vListEmpty(icon, titulo, texto, accion) {
  return `<div class="listempty">
    <div class="le-mark">${ic(icon)}</div>
    <b>${esc(titulo)}</b>
    <p>${esc(texto)}</p>
    ${accion ? `<div class="le-act">${accion}</div>` : ''}
  </div>`;
}
async function renderTasks() {
  const box = $('#tasksList');
  if (!box) return;
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.tasksList()) || [];
  } catch (e) {
    err = e;
  }
  box.innerHTML = '';
  if (err) {
    box.innerHTML = `<div class="subnote">${esc(I18N.t('vistas.tarea.fallo', { motivo: (err && err.message) || err }))}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = vListEmpty(
      'list',
      I18N.t('vistas.tarea.vacio.titulo'),
      I18N.t('vistas.tarea.vacio.texto'),
    );
    return;
  }
  for (const t of list) {
    const st = TASK_STATUS[t.status] || TASK_STATUS.completed;
    const it = document.createElement('div');
    it.className = 'hitem';
    const d = new Date(t.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const err = t.lastError
      ? `<small class="md" style="color:var(--danger)">✗ ${esc(t.lastError.step || '')}${t.lastError.tool ? ' · ' + esc(t.lastError.tool) : ''}: ${esc(K.clip(t.lastError.message, 120))}</small><br>`
      : '';
    const live = t.live
      ? `<small class="md">${esc(I18N.t('vistas.tarea.herramientas', { n: t.live.toolCalls || 0 }))} · ${(t.live.tokensIn || 0) + (t.live.tokensOut || 0)} tok${t.live.costUsd ? ' · $' + t.live.costUsd.toFixed(4) : ''}${t.live.toolsFired && t.live.toolsFired.length ? ' · ' + esc(I18N.t('vistas.tarea.ultima', { herramienta: t.live.toolsFired[t.live.toolsFired.length - 1].name })) : ''}</small><br>`
      : '';
    const sched =
      t.status === 'scheduled' && t.scheduledAt ? `<small class="md">→ ${new Date(t.scheduledAt).toLocaleString('es')}</small><br>` : '';
    // sin role=button: la fila lleva botones propios (pausar, reanudar, borrar…)
    const objetivo = t.goal || I18N.t('vistas.tarea.sinObjetivo');
    it.setAttribute('aria-label', I18N.t('vistas.tarea.aria', { objetivo, estado: st.label }));
    it.title = objetivo;
    it.innerHTML = `<div class="hic">${ic('history')}</div>
      <div class="hmain"><b>${esc(objetivo)}</b>
        <small><span class="dot ${st.cls}"></span> ${esc(st.label)} · ${esc(I18N.t('vistas.tarea.paso', { n: t.step || '—' }))} · ${esc(I18N.t(t.steps === 1 ? 'chat.pasos.uno' : 'chat.pasos.varios', { n: t.steps || 0 }))} · ${when}</small><br>
        ${sched}${live}${err}
        ${t.result ? `<small class="md">${esc(K.clip(t.result, 140))}</small>` : ''}
      </div>
      ${t.status === 'running' ? `<button class="btn ghost sq" data-pause title="${esc(I18N.t('vistas.tarea.pausar'))}">${ic('pause')}</button>` : ''}
      ${t.status === 'paused' || t.status === 'interrupted' || t.status === 'failed' || t.status === 'pending' ? `<button class="btn primary sq" data-resume title="${esc(I18N.t('vistas.tarea.reanudar'))}">${ic('zap')}</button>` : ''}
      ${t.status === 'scheduled' ? `<button class="btn primary sq" data-runnow title="${esc(I18N.t('vistas.tarea.ejecutar'))}">${ic('zap')}</button>` : ''}
      ${!['completed', 'failed', 'cancelled'].includes(t.status) ? `<button class="btn ghost sq danger" data-cancel title="${esc(I18N.t('vistas.tarea.cancelar'))}">${ic('close')}</button>` : ''}
      ${t.status === 'running' ? '' : `<button class="btn ghost sq danger" data-del title="${esc(I18N.t('vistas.tarea.eliminar'))}">${ic('trash')}</button>`}`;
    // fila operable con teclado SOLO si tiene una acción principal: completed y
    // cancelled únicamente traen el borrado, y una fila enfocable que no responde
    // a Enter es una trampa para quien navega con el teclado.
    const accionPrincipal = it.querySelector('button:not([data-del])');
    if (accionPrincipal) {
      it.setAttribute('tabindex', '0');
      it.addEventListener('keydown', (ev) => {
        if (ev.target !== it || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        // Enter/Space actúa como el clic en la fila: dispara su botón principal
        accionPrincipal.click();
      });
    }
    const rb = it.querySelector('[data-resume]');
    if (rb)
      rb.onclick = async (ev) => {
        ev.stopPropagation();
        if (rb.disabled) return;
        rb.disabled = true;
        try {
          const r = await window.sagitari.taskResume(t.runId);
          if (r && r.ok === false) {
            showToast(r.error || I18N.t('vistas.tarea.reanudar.fallo'));
            rb.disabled = false;
          }
        } catch (e) {
          showToast(I18N.t('vistas.tarea.reanudar.fallo') + ': ' + ((e && e.message) || e));
          rb.disabled = false;
        }
        renderTasks();
      };
    const pb = it.querySelector('[data-pause]');
    if (pb)
      pb.onclick = async (ev) => {
        ev.stopPropagation();
        if (pb.disabled) return;
        pb.disabled = true;
        try {
          await window.sagitari.taskPause(t.runId);
        } catch (e) {
          showToast(I18N.t('vistas.tarea.pausar.fallo', { motivo: (e && e.message) || e }));
          pb.disabled = false;
        }
        renderTasks();
      };
    const sb = it.querySelector('[data-runnow]');
    if (sb)
      sb.onclick = async (ev) => {
        ev.stopPropagation();
        if (sb.disabled) return;
        sb.disabled = true;
        try {
          await window.sagitari.taskResume(t.runId);
        } catch (e) {
          showToast(I18N.t('vistas.tarea.ejecutar.fallo', { motivo: (e && e.message) || e }));
          sb.disabled = false;
        }
        renderTasks();
      };
    const cb = it.querySelector('[data-cancel]');
    if (cb)
      cb.onclick = async (ev) => {
        ev.stopPropagation();
        if (!(await askConfirm(it, I18N.t('vistas.tarea.cancelar.confirmar'), K.clip(t.goal, 160)))) return;
        cb.disabled = true;
        await window.sagitari.taskCancel(t.runId);
        renderTasks();
      };
    const db = it.querySelector('[data-del]');
    if (db)
      db.onclick = async (ev) => {
        ev.stopPropagation();
        if (!(await askConfirm(it, I18N.t('vistas.tarea.borrar.confirmar'), K.clip(t.goal, 160)))) return;
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
  if (!goal) {
    msg.textContent = I18N.t('vistas.tarea.objetivo.falta');
    return;
  }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: null });
    if (r && r.ok) {
      msg.textContent = I18N.t('vistas.tarea.enCola', { id: r.runId });
      $('#taskGoal').value = '';
      feed(I18N.t('vistas.tarea.lanzada'), 'blu');
      renderTasks();
    } else msg.textContent = (r && r.error) || I18N.t('vistas.tarea.crear.fallo');
  } catch (e) {
    msg.textContent = I18N.t('ajustes.error', { motivo: (e && e.message) || e });
  } finally {
    btn.disabled = false;
  }
  setTimeout(() => {
    msg.textContent = '';
  }, 4000);
};
$('#taskSchedule').onclick = async () => {
  const btn = $('#taskSchedule');
  if (btn.disabled) return;
  const goal = $('#taskGoal').value.trim();
  const when = $('#taskWhen').value;
  const msg = $('#taskMsg');
  if (!goal) {
    msg.textContent = I18N.t('vistas.tarea.objetivo.falta');
    return;
  }
  if (!when) {
    msg.textContent = I18N.t('vistas.tarea.cuando.falta');
    return;
  }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: new Date(when).toISOString() });
    if (r && r.ok) {
      msg.textContent = I18N.t('vistas.tarea.programada', { cuando: new Date(when).toLocaleString(I18N.idioma) });
      $('#taskGoal').value = '';
      $('#taskWhen').value = '';
      renderTasks();
    } else msg.textContent = (r && r.error) || I18N.t('vistas.tarea.programar.fallo');
  } catch (e) {
    msg.textContent = I18N.t('ajustes.error', { motivo: (e && e.message) || e });
  } finally {
    btn.disabled = false;
  }
  setTimeout(() => {
    msg.textContent = '';
  }, 4000);
};
$('#chatPause').onclick = async () => {
  const r = await window.sagitari.pauseChat(hiloActual());
  if (r && r.ok === false) showToast(r.error || I18N.t('vistas.tarea.pausarTarea.fallo'));
};

// ============ projects ============
$('#projOpen').onclick = async () => {
  const btn = $('#projOpen');
  btn.disabled = true;
  $('#projMsg').textContent = I18N.t('vistas.espacio.abriendo');
  try {
    const r = await window.sagitari.openPath($('#projPath').value);
    if (r && r.ok) {
      $('#projMsg').textContent = I18N.t('vistas.espacio.activo', { ruta: r.workspace || r.path });
      feed(I18N.t('vistas.espacio.feed', { ruta: r.workspace || r.path }), 'ok');
    } else {
      $('#projMsg').textContent = (r && r.error) || I18N.t('vistas.espacio.abrir.fallo');
    }
  } catch (e) {
    $('#projMsg').textContent = (e && e.message) || I18N.t('vistas.espacio.abrir.fallo');
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      $('#projMsg').textContent = '';
    }, 4000);
  }
};
$('#projPick').onclick = async () => {
  const r = await window.sagitari.pickFolder();
  if (r && r.path) {
    const s = await window.sagitari.workspaceSet(r.path);
    if (s && s.ok) {
      $('#projPath').value = s.path;
      $('#projMsg').textContent = I18N.t('vistas.espacio.activo', { ruta: s.path });
      feed(I18N.t('vistas.espacio.feed', { ruta: s.path }), 'ok');
    } else $('#projMsg').textContent = (s && s.error) || I18N.t('vistas.espacio.fijar.fallo');
    setTimeout(() => {
      $('#projMsg').textContent = '';
    }, 4000);
  }
};

// ============ misc ============

function showToast(text, accion) {
  // los avisos se apilan: uno nuevo NO debe borrar el anterior antes de que se lea.
  // Se conservan 3 como máximo y el más viejo cae primero (ya tiene su temporizador).
  // El contenedor los coloca en columna: sin él los tres se pintaban en el MISMO punto
  // y el nuevo tapaba al viejo, que se iba sin que nadie lo hubiera leído.
  let pila = $('#toastStack');
  if (!pila) {
    pila = document.createElement('div');
    pila.id = 'toastStack';
    document.body.appendChild(pila);
  }
  const previos = pila.querySelectorAll('.toast');
  if (previos.length >= 3) previos[0].remove();
  const t = document.createElement('div');
  t.className = 'toast';
  // aviso no bloqueante: el lector de pantalla lo anuncia sin robar el foco
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<span class="dot pur"></span>${esc(text)}`;
  /* Acción opcional dentro del aviso: la usa «Deshacer» de los cambios masivos de
     permisos, donde la única vuelta era rehacerlo a mano. Un aviso con acción vive
     más (9 s en vez de 3,2) porque hay que poder leerlo y decidir. */
  const conAccion = !!(accion && accion.etiqueta && typeof accion.fn === 'function');
  if (conAccion) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = accion.etiqueta;
    b.onclick = () => {
      t.remove();
      accion.fn();
    };
    t.appendChild(b);
    t.classList.add('con-accion');
  }
  pila.appendChild(t);
  setTimeout(() => t.remove(), conAccion ? 9000 : 3200);
}
/** Texto del pie: qué modelo está en uso y de qué proveedor. Sin estados: la
    píldora enseña la selección y abre la lista para cambiarla. */
function updateStatusLabels() {
  const a = CFG.active;
  $('#stModel').textContent = a ? a.model : I18N.t('vistas.modelo.sin');
  $('#stProv').textContent = a ? a.name || I18N.t('vistas.modelo.proveedor') : I18N.t('vistas.modelo.configurar');
  $('#sideStatusBtn').title = a ? a.model + ' — ' + I18N.t('barra.modelo.title') : I18N.t('vistas.modelo.configurar.titulo');
  $('#chatModelLabel').textContent = a ? a.name + ' · ' + a.model : '';
  // tarjeta de estado de Ajustes
  const name = $('#activeModelName');
  if (!name) return;
  const meta = $('#activeModelMeta'),
    badge = $('#activeModelBadge');
  if (!a) {
    name.textContent = I18N.t('vistas.modelo.sinActivo');
    meta.textContent = I18N.t('vistas.modelo.empezar');
    badge.textContent = I18N.t('vistas.modelo.sinActivar');
    badge.classList.add('off');
    return;
  }
  name.textContent = a.model;
  const bits = [a.name || I18N.t('vistas.modelo.proveedor')];
  try {
    bits.push(new URL(a.baseUrl).host);
  } catch {}
  if (a.format && a.format !== 'auto') bits.push(I18N.t('vistas.modelo.formato', { formato: a.format }));
  if (a.vision) bits.push(I18N.t('vistas.modelo.vision'));
  meta.textContent = bits.join(' · ');
  badge.textContent = I18N.t('vistas.modelo.activo');
  badge.classList.remove('off');
  // si la lista está abierta (p. ej. acabas de activar algo en Ajustes), se repinta
  const mm = document.getElementById('modelMenu');
  if (mm && !mm.hidden) {
    mm.hidden = true;
    openModelMenu();
  }
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
  const nombre = (lab && lab.textContent.trim()) || sel.getAttribute('aria-label') || I18N.t('vistas.csel.nombre');
  btn.setAttribute('aria-label', nombre + ': ' + (et || I18N.t('vistas.csel.sinSeleccion')));
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
  menu.innerHTML =
    [...sel.options]
      .map((o) => {
        const on = o.value === actual && !o.disabled;
        const datos = o.disabled ? '' : ` data-v="${esc(o.value)}"`;
        return (
          `<div class="sm-item${on ? ' on' : ''}" role="option" aria-selected="${on}"${datos}>` +
          `<span class="sm-name">${esc(o.textContent.trim())}</span>${on ? '<span class="mm-mark" aria-hidden="true">✓</span>' : ''}</div>`
        );
      })
      .join('') || '<div class="mm-hint">' + esc(I18N.t('vistas.csel.sinOpciones')) + '</div>';
  // Coordenadas propias: el menú es position:fixed, así que escapa del overflow del
  // contenedor (antes .main lo recortaba). Se mide con la lista ya pintada, se ancla
  // al botón, se voltea hacia arriba si abajo no cabe y se mantiene dentro de la vista.
  const colocar = () => {
    const r = caja.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || 0;
    const vh = document.documentElement.clientHeight || 0;
    menu.style.width = Math.round(r.width || 160) + 'px';
    const alto = Math.min(300, menu.scrollHeight || 300);
    const cabeAbajo = vh - r.bottom - 8 >= Math.min(alto, 200);
    const arriba = !cabeAbajo && r.top > alto;
    const top = arriba ? r.top - alto - 6 : r.bottom + 6;
    /* Vista sin tamaño (ventana oculta en los arranques de la comprobación de
       interfaz): sin viewport no hay contra qué recortar y el recorte dejaba el
       menú en (8,8), encima del logo. Se ancla al botón y se recoloca al primer
       frame con vista de verdad. */
    const sinVista = !(vw >= 200) || !(vh >= 200);
    /* Contra NaN/Infinito (vista sin medir en un arranque oculto): un cálculo no finito
       deja la declaración inválida y el menú se queda en el (0,0) del CSS, encima del
       logo. Si no hay números fiables, se ancla al botón sin recortar. */
    const izq = sinVista ? r.left - 2 : Math.max(8, Math.min(r.left - 2, vw - r.width - 6));
    const arr = sinVista ? top : Math.max(8, Math.min(top, vh - 12));
    if (Number.isFinite(izq)) menu.style.left = Math.round(izq) + 'px';
    if (Number.isFinite(arr)) menu.style.top = Math.round(arr) + 'px';
    const cs = getComputedStyle(menu);
    menu.dataset.anchor = JSON.stringify({
      vw,
      vh,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      l: menu.style.left,
      t: menu.style.top,
      pos: cs.position,
      cl: cs.left,
      ct: cs.top,
      anim: cs.animationName,
      op: cs.opacity,
      tf: cs.transform,
      n: document.querySelectorAll('.csel[data-csel-de="' + (sel.id || '') + '"]').length,
      inDoc: document.body.contains(menu),
    });
    const ya = menu.querySelector('.sm-item.on');
    if (ya) ya.scrollIntoView({ block: 'nearest' });
  };
  // el menú nace [hidden] (display:none) y sin caja scrollHeight mide siempre 0:
  // se le da caja un instante para medirlo de verdad. Todo ocurre en el mismo tick,
  // así que no llega a pintarse en una posición provisional.
  menu.hidden = false;
  colocar();
  requestAnimationFrame(() => {
    if (cselAbierto && cselAbierto.menu === menu && !menu.hidden) colocar();
  });
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
  if (sel.id) caja.dataset.cselDe = sel.id; // gancho estable para las comprobaciones
  if (sel.style.width) {
    caja.style.width = sel.style.width;
    sel.style.width = '';
  }
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
  sel.classList.add('csel-native'); // oculto: el control visible es el botón

  const resaltar = (n) => {
    const filas = [...menu.querySelectorAll('.sm-item[data-v]')];
    if (!filas.length) return;
    filas.forEach((f) => f.classList.remove('hl'));
    const i = ((n % filas.length) + filas.length) % filas.length;
    filas[i].classList.add('hl');
    filas[i].scrollIntoView({ block: 'nearest' });
  };
  const indiceResaltado = () => [...menu.querySelectorAll('.sm-item')].findIndex((f) => f.classList.contains('hl'));

  btn.onclick = (e) => {
    e.stopPropagation();
    if (cselAbierto && cselAbierto.sel === sel) cselCerrar();
    else cselAbrir(sel);
  };
  btn.onkeydown = (e) => {
    const abierto = !!(cselAbierto && cselAbierto.sel === sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!abierto) {
        cselAbrir(sel);
        resaltar(e.key === 'ArrowDown' ? 0 : -1);
      } else resaltar(indiceResaltado() + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!abierto) return cselAbrir(sel);
      const f = menu.querySelector('.sm-item.hl') || menu.querySelector('.sm-item.on');
      if (f && f.dataset.v !== undefined) cselElegir(sel, f.dataset.v);
      return;
    }
    if (abierto && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      resaltar(e.key === 'Home' ? 0 : -1);
      return;
    }
    if (abierto && e.key === 'Escape') {
      e.preventDefault();
      cselCerrar();
      return;
    }
    if (e.key === 'Tab') {
      cselCerrar();
      return;
    }
    // salto por letra, como hace el select nativo
    if (abierto && e.key.length === 1 && /\S/.test(e.key)) {
      const filas = [...menu.querySelectorAll('.sm-item[data-v]')];
      const desde = indiceResaltado();
      const k = e.key.toLowerCase();
      for (let i = 1; i <= filas.length; i++) {
        const j = (desde + i + filas.length) % filas.length;
        if (filas[j].textContent.trim().toLowerCase().startsWith(k)) {
          e.preventDefault();
          resaltar(j);
          break;
        }
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cselCerrar();
});
window.addEventListener('resize', cselCerrar);
// el menú está anclado a un punto: si el contenedor se desplaza, el ancla se queda atrás.
// PERO el scroll que nace DENTRO del menú (rueda sobre la lista, sliders vecinos) no
// lo desancla: solo se cierra cuando se mueve algo fuera de él.
window.addEventListener(
  'scroll',
  (e) => {
    if (cselAbierto && cselAbierto.menu.contains(e.target)) return;
    cselCerrar();
  },
  true,
);
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
    modelMenu.innerHTML = `<div class="sm-head">${esc(I18N.t('vistas.modelo.menu.sinModelo'))}</div>
      <div class="mm-hint">${esc(I18N.t('vistas.modelo.menu.activar'))}</div>
      <div class="sm-item" data-act="settings"><span class="sm-name">${esc(I18N.t('vistas.modelo.menu.abrirAjustes'))}</span></div>`;
  } else {
    const head = c.provider
      ? esc(I18N.t('vistas.modelo.menu.tituloProv', { nombre: c.provider.name }))
      : esc(I18N.t('vistas.modelo.menu.titulo'));
    const items = c.models
      .map((m) => {
        const on = m === c.current;
        return `<div class="sm-item${on ? ' on' : ''}" role="option" aria-selected="${on}" data-model="${esc(m)}" title="${esc(m)}">
        <span class="sm-name">${esc(m)}</span>${on ? '<span class="mm-mark" aria-hidden="true">✓</span>' : ''}</div>`;
      })
      .join('');
    const nota = c.known
      ? `<div class="mm-hint">${esc(
          c.provider
            ? I18N.t('vistas.modelo.menu.listaProv', { n: c.models.length, nombre: c.provider.name })
            : I18N.t('vistas.modelo.menu.lista', { n: c.models.length }),
        )}</div>`
      : `<div class="mm-hint">${esc(I18N.t('vistas.modelo.menu.sinLista'))}</div>`;
    modelMenu.innerHTML = `<div class="sm-head">${head}</div>${items}${nota}
      <div class="mm-foot">
        <div class="sm-item" data-act="detect"><span class="sm-name">${esc(I18N.t('vistas.modelo.menu.detectar'))}</span></div>
        <div class="sm-item" data-act="settings"><span class="sm-name">${esc(I18N.t('vistas.modelo.menu.proveedores'))}</span></div>
      </div>`;
  }
  modelMenu.hidden = false;
  $('#sideStatusBtn').setAttribute('aria-expanded', 'true');
  // el modelo activo queda marcado para navegar con el teclado desde ahí
  const on = modelMenu.querySelector('.sm-item.on');
  if (on) {
    on.classList.add('hl');
    on.scrollIntoView({ block: 'nearest' });
  }
}

$('#sideStatusBtn').onclick = openModelMenu;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModelMenu();
});
/* Teclado dentro del menú de modelos: mismo patrón que los desplegables propios
   (csel). Sin esto el botón anunciaba aria-haspopup="listbox" pero no se podía
   elegir nada sin ratón. El foco sigue en el botón (las filas son divs), así que
   la escucha va en el documento y solo actúa con el menú abierto y el foco ahí. */
document.addEventListener('keydown', (e) => {
  if (!modelMenu || modelMenu.hidden) return;
  if (!$('#sideStatusBtn').contains(document.activeElement)) return;
  const rows = [...modelMenu.querySelectorAll('.sm-item')];
  if (!rows.length) return;
  const at = rows.findIndex((r) => r.classList.contains('hl'));
  const paint = (i) => {
    rows.forEach((r) => r.classList.remove('hl'));
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

if (modelMenu)
  modelMenu.onclick = async (e) => {
    const row = e.target.closest('.sm-item');
    if (!row) return;
    if (row.dataset.act === 'settings') {
      closeModelMenu();
      goto('settings');
      showSetTab('model');
      return;
    }
    if (row.dataset.act === 'detect') {
      const prov = K.modelChoices(CFG.active, CFG.providers).provider;
      const cfg = (CFG.providers || []).find((p) => prov && p.id === prov.id) || CFG.active;
      if (!cfg || !cfg.baseUrl) return closeModelMenu();
      row.classList.add('on');
      row.querySelector('.sm-name').textContent = I18N.t('vistas.modelo.detectando');
      // Sin decir el protocolo, una base Anthropic/Responses de terceros cuya ruta no
      // lo delata se sondeaba con Bearer y la detección fallaba (401/404) justo donde la
      // pestaña Modelo sí acierta. Se manda el `format`/`providerId` del proveedor activo
      // (como 30-ajustes.js) para que main elija las cabeceras y la ruta correctas.
      const r = await window.sagitari.listModels(cfg.baseUrl, cfg.apiKey, {
        format: cfg.format,
        providerId: cfg.id,
      });
      if (!r.ok) {
        showToast(I18N.t('vistas.modelo.detectar.fallo', { motivo: r.error }));
        closeModelMenu();
        return;
      }
      // la lista detectada se guarda en el proveedor: es la que ofrece el menú
      const saved = await window.sagitari.saveProvider({
        id: cfg.id || 'prov_' + Date.now().toString(36),
        name: cfg.name || 'Proveedor',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        format: cfg.format,
        models: r.models,
      });
      if (saved && saved.ok === false) {
        showToast(I18N.t('vistas.modelo.guardar.fallo', { motivo: saved.error }));
        closeModelMenu();
        return;
      }
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      closeModelMenu();
      openModelMenu();
      showToast(I18N.t('vistas.modelo.detectados', { n: r.models.length }));
      return;
    }
    const model = row.dataset.model;
    if (!model || model === (CFG.active && CFG.active.model)) return closeModelMenu();
    const c = K.modelChoices(CFG.active, CFG.providers);
    // providerId + baseUrl: main resuelve la clave guardada (no viaja por aquí)
    const r = await window.sagitari.activateProvider({
      providerId: c.provider ? c.provider.id : CFG.active && CFG.active.providerId,
      name: c.provider ? c.provider.name : CFG.active && CFG.active.name,
      baseUrl: CFG.active && CFG.active.baseUrl,
      model,
      vision: looksVision(model),
      format: (CFG.active && CFG.active.format) || 'auto',
    });
    if (r && r.ok === false) {
      showToast(I18N.t('vistas.modelo.cambiar.fallo', { motivo: r.error }));
      return;
    }
    CFG = await window.sagitari.getConfig();
    closeModelMenu();
    renderProviderList();
    updateStatusLabels();
    showToast(I18N.t('vistas.modelo.cambiado', { modelo: model }));
  };

// ============ borde vivo: estados del agente en el filo de las superficies ============
const shellEl = document.getElementById('shell');
let frameGlowTimer = null;
/* El COLOR lo pone el usuario (Ajustes → Apariencia) vía --glow-rgb, y cada estado se
   distingue por DÓNDE está encendida la luz, no por su tono: pensar enciende el panel
   lateral y trabajar el compositor y la tarjeta que corre. Desde aquí sólo se pone la clase;
   el mapa estado→superficie vive en styles.css (BORDE VIVO), en un solo sitio. */
window.sagitari.onGlow(({ mode }) => {
  const ESTADOS = ['think', 'work', 'pulse'];
  const pedido = mode === 'off' ? '' : ESTADOS.includes(mode) ? mode : 'think';
  const actual = ESTADOS.find((m) => shellEl.classList.contains('glow-' + m)) || '';
  /* Mismo estado = NO se toca nada. Quitar y volver a poner la misma clase deja la lista
     igual, pero REINICIA el recorrido y hunde un momento el nivel del filo: con los
     eventos de estado que llegan durante un turno (uno por herramienta), la luz se
     re-encendía y el reflejo volvía a empezar en cada paso — el parpadeo que se veía «al
     aparecer». `pulse` sí se rehace a propósito: es un acuse de un solo pase. */
  if (pedido === actual && pedido !== 'pulse') return;
  ESTADOS.forEach((m) => shellEl.classList.remove('glow-' + m));
  clearTimeout(frameGlowTimer);
  if (!pedido) return; // sin clases = calma: sólo queda el filo de reposo
  /* Forzar el recálculo: si ya estaba pulsando, quitar y poner la misma clase en el mismo
     turno deja la lista igual y el navegador no reinicia el recorrido — el segundo
     Ctrl+Shift+G no se vería. */
  if (pedido === 'pulse') void shellEl.offsetWidth;
  shellEl.classList.add('glow-' + pedido);
  if (pedido === 'pulse') frameGlowTimer = setTimeout(() => shellEl.classList.remove('glow-pulse'), 1400);
});

/* ============ tema: acento de la UI + color e intensidad del glow ============
   PALETTES define los triplets RGB; applyTheme los vuelca en el :root y todo el
   CSS (80+ tintes) se reconstruye solo, sin recargar nada.
   REEQUILIBRIO: acentos calmados (~20-25% menos de saturación que la era
   chillona) para que tiñan sin invadir. 'aurora' es un tema apagado: interfaz
   sobria azul-grisácea + glow multicolor en el borde
   (su aura no sale de acc2: ver applyTheme). */
const PALETTES = {
  violet: { label: 'Violeta', acc: [158, 146, 228], acc2: [128, 110, 214], acc3: [84, 124, 214] },
  magenta: { label: 'Magenta', acc: [224, 148, 206], acc2: [184, 92, 196], acc3: [150, 108, 214] },
  cyan: { label: 'Cian', acc: [96, 186, 200], acc2: [40, 146, 170], acc3: [52, 158, 168] },
  emerald: { label: 'Esmeralda', acc: [108, 194, 156], acc2: [44, 156, 116], acc3: [62, 184, 108] },
  amber: { label: 'Ámbar', acc: [232, 192, 100], acc2: [196, 128, 40], acc3: [208, 128, 60] },
  ice: { label: 'Hielo', acc: [150, 190, 232], acc2: [84, 134, 214], acc3: [66, 112, 214] },
  aurora: { label: 'Aurora', acc: [148, 168, 208], acc2: [106, 128, 184], acc3: [88, 148, 196] },
};
/* Aura del tema aurora: tres colores DISTINTOS a la vez — azul que manda,
   rosa que se distingue y naranja que acompaña (como Siri). */
const AURORA_GLOW = { a: [141, 159, 255], b: [255, 103, 120], c: [255, 186, 113] };
/* Escalones de superficie de la rampa violeta: son los fondos que la app tenía
   escritos a mano. Cada paleta deriva los suyos con la MISMA luminancia relativa
   (no la L de HSL, que no es brillo percibido) y el TONO del acento: cambiar el
   color de la interfaz cambia también los fondos sin mover el contraste un punto. */
const RAMPA_REF = {
  '--bg0-rgb': [6, 4, 15],
  '--bg1-rgb': [16, 10, 38],
  '--bg2-rgb': [22, 14, 48],
  '--deep-rgb': [12, 8, 30],
  '--field-rgb': [8, 5, 24],
  '--panel-rgb': [18, 12, 42],
  '--panel2-rgb': [26, 18, 56],
  '--face-rgb': [30, 20, 64],
  '--face2-rgb': [38, 26, 76],
};
const _hsl = (c) => {
  const r = c[0] / 255,
    g = c[1] / 255,
    b = c[2] / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
};
const _rgb = (h, s, l) => {
  const f = (n) => {
    const k = (n + h / 30) % 12,
      a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};
const _lum = (c) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
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
    const [, s] = _hsl(baseRGB),
      objetivo = _lum(baseRGB);
    // bisección: la luminancia crece con L, así que se busca la L que la iguala
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 22; i++) {
      const medio = (lo + hi) / 2;
      if (_lum(_rgb(h, s, medio)) < objetivo) lo = medio;
      else hi = medio;
    }
    out[token] = _rgb(h, s, (lo + hi) / 2).join(', ');
  }
  // SOLO la paleta de referencia se fija con sus literales, para que el tema por
  // defecto quede idéntico. Aplicarlo siempre devolvía la rampa violeta a todas las
  // paletas: el color de la interfaz cambiaba en los acentos y no en los fondos.
  if (clave === PALETTES.violet.acc.join(',')) {
    out['--bg0-rgb'] = '6, 4, 15';
    out['--bg1-rgb'] = '16, 10, 38';
    out['--bg2-rgb'] = '22, 14, 48';
    out['--deep-rgb'] = '12, 8, 30';
    out['--field-rgb'] = '8, 5, 24';
    out['--panel-rgb'] = '18, 12, 42';
    out['--panel2-rgb'] = '26, 18, 56';
    out['--face-rgb'] = '30, 20, 64';
    out['--face2-rgb'] = '38, 26, 76';
  }
  return (_rampas[clave] = out);
}
/* ============ ASPECTOS ============
   Holo es la identidad de la casa (vidrio, filo, aura). Los otros dos aspectos comparten
   la MISMA base —vistas, componentes, medidas— y cambian la materia: Consola y Lienzo son
   planos, sin desenfoque y sin glow (ver renderer/skins.css). El aspecto viaja como
   atributo en <html>, así que el CSS decide y aquí solo se elige. */
const SKINS = ['holo', 'console', 'canvas'];
function skinActual(s) {
  const k = s && s.uiSkin;
  return SKINS.includes(k) ? k : 'holo';
}
function applyTheme() {
  const s = CFG.settings || {};
  const pal = PALETTES[s.uiColor] || PALETTES.aurora;
  /* El aspecto ANTES de todo lo demás: skins.css lee los tokens de aquí (paleta, vidrio)
     y los suyos propios llegan después. `holo` quita el atributo: la identidad de la casa
     es la hoja de siempre, sin ninguna capa encima. */
  const skin = skinActual(s);
  if (skin === 'holo') document.documentElement.removeAttribute('data-skin');
  else document.documentElement.setAttribute('data-skin', skin);
  const gpal = s.glowColor && s.glowColor !== 'match' && PALETTES[s.glowColor] ? PALETTES[s.glowColor] : pal;
  const r = document.documentElement.style;
  r.setProperty('--acc-rgb', pal.acc.join(','));
  r.setProperty('--acc2-rgb', pal.acc2.join(','));
  r.setProperty('--acc3-rgb', pal.acc3.join(','));
  r.setProperty('--glow-rgb', gpal.acc2.join(','));
  // Aura tricolor: tres tonos DISTINTOS a ±42º del elegido (no vecinos), para
  // que se vean los3 colores a la vez, mezclándose entre sí
  // sin dejar de ser tu color.
  // Excepción: el tema aurora trae su propio espectro (azul→rosa→naranja).
  const auroraGlow = s.glowColor === 'aurora' || (s.glowColor === 'match' && s.uiColor === 'aurora');
  const [gh, gs, gl] = _hsl(gpal.acc2);
  const ga = auroraGlow ? AURORA_GLOW.a : _rgb(gh + 42, Math.min(1, gs * 1.05), Math.min(0.74, gl * 1.0));
  const gb = auroraGlow ? AURORA_GLOW.b : _rgb(gh, gs, gl);
  const gc = auroraGlow ? AURORA_GLOW.c : _rgb(gh - 42, Math.min(1, gs * 1.05), Math.min(0.74, gl * 1.0));
  r.setProperty('--glow-a-rgb', ga.join(', '));
  r.setProperty('--glow-b-rgb', gb.join(', '));
  r.setProperty('--glow-c-rgb', gc.join(', '));
  // Sin valor guardado, el glow viene SUAVE (0.7): que acaricie el marco, no que lo
  // invada. El deslizador enseña ESTE mismo respaldo (fillSettings), no otro.
  /* Los aspectos planos no tienen filo ni atmósfera: la intensidad del glow se guarda (se
     recupera al volver a Holo) pero aquí vale 0, porque el brillo del marco contradice la
     materia plana. Lo mismo con el vidrio: sin desenfoque, el tinte no pinta nada. */
  const plano = skin !== 'holo';
  r.setProperty('--glow-str', plano ? '0' : String(Math.min(2, Math.max(0.4, Number(s.glowStrength) || 0.7))));
  r.setProperty('--glass', plano ? '1' : String(Math.min(1.3, Math.max(0.4, Number(s.glassTint) || 1))));
  /* Los fondos también son del tema: si no, el color cambia solo en los acentos.
     ENAJENACIÓN: en un aspecto plano los fondos NO los deriva la paleta —Consola es negro
     neutro y Lienzo es gris plano— así que la rampa se SUELTA (removeProperty) y la fija
     skins.css. Dejarla puesta sería teñir de violeta una interfaz que se llama Consola. */
  for (const [token, valor] of Object.entries(rampaDeSuperficies(pal.acc))) {
    if (plano) r.removeProperty(token);
    else r.setProperty(token, valor);
  }
  /* Las filas de luz y vidrio no tienen sentido en un aspecto plano (no hay filo que
     iluminar ni cristal que teñir): se retiran de la vista en vez de ofrecer controles
     que no hacen nada. Vuelven al elegir Holo. */
  document.querySelectorAll('[data-solo-holo]').forEach((el) => {
    el.hidden = plano;
  });
  /* Apagar el glow tiene que apagarlo AQUÍ: main deja de mandar estados, pero el filo
     de reposo y la atmósfera del marco los pinta el CSS con --glow-str. Con 0, todos
     los filos (y el recorrido) quedan a cero; la hairline neutra de la ventana se
     conserva: es el borde de la ventana, no una señal. */
  document.getElementById('shell')?.classList.toggle('glow-off', !s.glowEnabled);
  /* Los tres tonos ya no giran por el marco: se conservan porque los leen el filo vivo
     (--live-rgb sale de --glow-rgb) y la veta del pulso, que los lleva enteros. */
  // refresca las muestras de color de Ajustes si están pintadas
  document.querySelectorAll('.colordot').forEach((d) => {
    d.style.background = '';
  });
}
function glowStrengthLabel(v) {
  return v < 0.8
    ? I18N.t('vistas.apariencia.suave')
    : v <= 1.15
      ? I18N.t('vistas.apariencia.equilibrado')
      : I18N.t('vistas.apariencia.intenso');
}
function glassTintLabel(v) {
  return v < 0.7
    ? I18N.t('vistas.apariencia.ultraClaro')
    : v <= 1.1
      ? I18N.t('vistas.apariencia.equilibrado')
      : I18N.t('vistas.apariencia.tintado');
}
// cambios hechos desde Ajustes se aplican al vuelo (y desde main, p.ej. relanzar glow)
window.sagitari.onThemeChanged && window.sagitari.onThemeChanged(() => applyTheme());

// ============ revisión del cambio (F2) ============
/* Pinta un payload de cambiosDiff() dentro del contenedor dado. Es SÓLO pintura:
   no engancha listeners (el revisor delega el clic en [data-revert]). Las rutas
   y las líneas del diff las produce el modelo sobre tus archivos, así que TODO
   lo que se interpola va escapado con esc(). */
/** Números de partida de un hunk: "@@ -12,3 +12,5 @@" → {viejo, nuevo}. */
function diffContadores(cabecera) {
  const m = /-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(String(cabecera || ''));
  return m ? { viejo: Number(m[1]), nuevo: Number(m[2]) } : { viejo: 1, nuevo: 1 };
}

/** Un hunk: su cabecera y sus líneas, cada una con su número y su color. */
function diffHunk(h) {
  const cabecera = String((h && h.cabecera) || '');
  const lineas = h && Array.isArray(h.lineas) ? h.lineas : [];
  const n = diffContadores(cabecera);
  const filas = lineas.map((l) => {
    const tipo = l && l.tipo === 'del' ? 'del' : l && l.tipo === 'add' ? 'add' : 'ctx';
    let num;
    if (tipo === 'add') num = n.nuevo++;
    else if (tipo === 'del') num = n.viejo++;
    else {
      num = n.nuevo;
      n.viejo++;
      n.nuevo++;
    }
    const signo = tipo === 'add' ? '+' : tipo === 'del' ? '−' : ' ';
    const texto = esc(l && l.texto !== null && l.texto !== undefined ? String(l.texto) : '');
    return `<div class="df-line ${tipo}"><span class="df-num" aria-hidden="true">${num}</span><span class="df-sign" aria-hidden="true">${signo}</span><span class="df-text">${texto || '&nbsp;'}</span></div>`;
  });
  return `<div class="df-hunk">${cabecera ? `<div class="df-hunkhead">${esc(cabecera)}</div>` : ''}${filas.join('')}</div>`;
}

/** Pinta `archivos` (de cambiosDiff) dentro de `contenedor` (id o elemento). */
function pintarDiff(archivos, contenedor) {
  const box = typeof contenedor === 'string' ? document.getElementById(contenedor) : contenedor;
  if (!box) return;
  const lista = Array.isArray(archivos) ? archivos : [];
  if (!lista.length) {
    box.innerHTML = '<div class="subnote">' + esc(I18N.t('vistas.diff.sinCambios')) + '</div>';
    return;
  }
  box.innerHTML = lista
    .map((a) => {
      const f = a && typeof a === 'object' ? a : {};
      const ruta = String(f.path || '');
      const rel = String(f.rel || f.path || '');
      const hunks = Array.isArray(f.hunks) ? f.hunks : [];
      const noRev = !!f.noReversible;
      const adds = Number(f.adds) || 0;
      const dels = Number(f.dels) || 0;
      return `<div class="dffile">
        <div class="df-head">
          <span class="df-path" title="${esc(rel)}">${esc(rel)}</span>
          <span class="df-counts"><span class="df-add">+${adds}</span><span class="df-del">−${dels}</span></span>
          ${noRev ? '<span class="df-norev">' + esc(I18N.t('vistas.diff.noRevertible')) + '</span>' : ''}
          <button class="btn ghost sq" data-revert="${esc(ruta)}" title="${esc(I18N.t('vistas.diff.revertir'))}" aria-label="${esc(I18N.t('vistas.diff.revertir.aria', { ruta: rel }))}"${noRev ? ' disabled' : ''}>${ic('history')}</button>
        </div>
        <div class="df-hunks">${hunks.map(diffHunk).join('')}</div>
      </div>`;
    })
    .join('');
}

// ============ init ============
(async function init() {
  await fillSettings();
  wizardMostrar(); // v4.2: guía de primer uso si no hay modelo activo
  fillMemorySens();
  await initSecurity();
  // los desplegables nativos (selects) pasan a ser controles con el estilo de la app
  mejoraSelects();
  applyTheme(); // acento + glow antes del primer frame
  setSendMode();
  // el chat arranca vacío: nada de sellos de hora sueltos, sólo la bienvenida
  resetChatView([]);
  $('#chatTitle').title = convTitle; // el título se trunca: pista completa siempre
  refreshSidebar();
  // la pestaña con la que se abre la app debe quedar marcada en el sidebar
  const on = $('.view.on');
  if (on)
    $$('.navitem').forEach((b) => {
      const active = b.dataset.view === on.id.replace('view-', '');
      b.classList.toggle('on', active);
      if (active) b.setAttribute('aria-current', 'page');
    });
  // El monitor abre VACÍO: «Sagitari iniciado» y «Esperando peticiones» no eran
  // trabajo del agente, eran dos formas de decir lo que ya dice «En reposo» en la
  // cabecera del rail. El primer evento real (una herramienta, un aviso) estrena
  // la línea de tiempo; mientras no haya ninguno, el panel dice para qué está.
  if (!CFG.active) {
    // bienvenida SIN abrir turno: con ensureAssistantBubble quedaban vivos
    // pendingAssistant/pendingTurn y el primer mensaje real se escribía dentro
    // de esta misma burbuja, heredando el modo del arranque
    const b = bubble('ai');
    b.innerHTML = fmt(I18N.t('vistas.bienvenida'));
  }
  // recupera la conversación activa si la app se cerró a medias
  try {
    const list = await window.sagitari.convList();
    listaConvs = list; // de aquí sale el nombre de su pestaña
    if (list.length) {
      const r = await window.sagitari.convOpen(list[0].id);
      if (r.ok) recordarHilo(list[0].id, list[0].title); // el hilo restaurado es el que manda
      if (r.ok && r.messages.length) resetChatView(r.messages);
      if (r.ok) pintarHiloActivo(); // el título y el turno de ESA conversación, en su cabecera
    }
  } catch {}
})();
