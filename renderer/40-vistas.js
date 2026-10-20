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
let convTitle = 'Nueva conversación';
/* Último `conv:list` leído (el Historial lo refresca): de aquí sale el nombre de una
   conversación que se abre por su id, para poder ponerlo en su pestaña. */
let listaConvs = [];
function tituloDeConv(id) {
  const c = listaConvs.find((x) => x.id === id);
  return c ? c.title : '';
}
function setChatTitle(t, guardar) {
  convTitle = t || 'Nueva conversación';
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
      if (p && p.catch) p.catch(() => showToast('No se pudo guardar el nombre de la conversación'));
    } catch {
      showToast('No se pudo guardar el nombre de la conversación');
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
    box.innerHTML = `<div class="subnote">No se pudieron cargar las conversaciones: ${esc((err && err.message) || err)}</div>`;
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
      ? `<div class="subnote">Ninguna conversación coincide con «${esc(q)}».</div>`
      : vListEmpty(
          'history',
          'Nada en el historial aún',
          'Cuando hables con Sagitari, cada conversación se guarda aquí: podrás retomarla donde la dejaste o borrarla cuando quieras.',
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
    it.setAttribute('aria-label', 'Abrir la conversación «' + c.title + '»');
    it.title = c.title;
    const d = new Date(c.updatedAt);
    const when = d.toLocaleDateString('es') + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    it.innerHTML = `<div class="hic">${ic('chat')}</div>
      <div class="hmain"><b>${esc(c.title)}</b><small>${c.busy ? '<span class="hbusy">trabajando</span> ' : ''}${c.count} mensajes · ${when}</small></div>
      <button class="btn ghost sq hfork" data-fork="${esc(c.id)}" title="Duplicar" aria-label="Duplicar la conversación «${esc(c.title)}»">${ic('copy')}</button>
      <button class="btn ghost sq danger hdel" title="Eliminar">${ic('trash')}</button>`;
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
        showToast('No se pudo duplicar la conversación');
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
      if (!(await askConfirm(it, '¿Eliminar la conversación «' + c.title + '»?', 'Se borrará el hilo completo y sus mensajes.'))) return;
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
    showToast('No se pudo abrir la conversación');
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
  setChatTitle((mensajes.find((m) => m.role === 'user') || {}).content || titulo || rt.titulo || 'Nueva conversación');
  pintarHiloActivo(); // título, estado, contexto y deshacer: los de ESTA conversación
  goto('chat');
  feed('Conversación restaurada', 'blu');
}

/** Vuelve el chat a cero y, si hay historial, lo pinta con su modo por turno. */
function resetChatView(messages) {
  /* Última barrera: repintar el hilo A LA VISTA mientras su turno trabaja tiraría lo que
     hay pintado del turno (la burbuja pendiente, su stream). Cambiar de conversación ya
     no pasa por aquí —cada pestaña tiene su nodo y su estado—, así que esto sólo salta en
     los repintados internos (rebobinar, /compact). */
  if (busy) {
    showToast('Espera a que termine el turno de esta conversación para repintarla');
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
  setChatTitle('Nueva conversación');
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
    const who = m.classList.contains('me') ? CFG.settings.userName || 'Tú' : 'Sagitari';
    const badge = m.querySelector('.msg-mode');
    const t = m.querySelector('.bubble');
    if (!t) return;
    // el razonamiento no forma parte de la conversación: se copia la respuesta
    const copia = t.cloneNode(true);
    copia.querySelectorAll('.thinkblock').forEach((x) => x.remove());
    parts.push(`## ${who}${badge ? ' · ' + badge.textContent.trim() : ''}\n${copia.innerText.trim()}`);
  });
  copyText(parts.join('\n\n'), 'Conversación copiada');
};

// ============ mode switcher: segmented en chat + pill en inicio + Alt+M ============
const MODE_ORDER = K.MODE_ORDER;
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
    showToast('No se pudo guardar el modo: ' + ((r && r.error) || 'no se pudo escribir la configuración'));
    return;
  }
  mode = r;
  updateModeUI();
  const M = K.mode(mode);
  showToast('Modo ' + M.label + ' — ' + M.tagline);
}
function renderModeSeg() {
  // el MISMO segmento vive en el chat y en la home: idéntico aspecto y comportamiento
  for (const seg of [$('#modeSeg'), $('#modeSegHome')]) {
    if (!seg) continue;
    seg.innerHTML = MODE_ORDER.map((k) => {
      const M = K.MODES[k];
      return `<button data-m="${k}" class="${k === mode ? 'on ' + k : ''}" title="${esc(M.name)} — ${esc(M.tagline)}" aria-pressed="${k === mode}">${ic(M.icon)}<span>${M.label}</span></button>`;
    }).join('');
    seg.querySelectorAll('button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  }
}

/** Tarjetas de modo del estado vacío: explican y permiten cambiar con un clic. */
function renderEmptyModes() {
  const box = $('#ceModes');
  if (!box) return;
  box.innerHTML = MODE_ORDER.map((k) => {
    const M = K.MODES[k];
    return `<button class="ce-mode${k === mode ? ' on' : ''}" style="--mr:${M.rgb}" data-m="${k}" aria-pressed="${k === mode}">
      <span class="cm-top">${ic(M.icon)}<b>${M.name.toUpperCase()}</b></span>
      <span class="cm-tag">${esc(M.label)} · ${esc(M.tagline)}</span>
      <ul class="cm-bullets">${M.bullets
        .slice(0, 1)
        .map((b) => `<li>${esc(b)}</li>`)
        .join('')}</ul>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
}
function updateModeUI() {
  $('#modeLabel').innerHTML = `<span class="hint-key">Alt+M</span> cambiar de modo`;
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
    showToast('Sensibilidad de memoria: ' + v);
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
    box.innerHTML = `<div class="subnote">No se pudieron cargar las skills: ${esc((err && err.message) || err)}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = vListEmpty(
      'zap',
      'Sin skills todavía',
      'Las skills son instrucciones especializadas que Sagitari carga solo cuando la tarea lo necesita. Importa un pack desde GitHub o crea la tuya abajo.',
    );
    return;
  }
  for (const s of list) {
    const it = document.createElement('div');
    it.className = 'memitem skillitem' + (s.enabled ? '' : ' off');
    /* Una sola línea de meta (autor, herramientas, deps, repo, coste): la ficha se
       escanea de arriba abajo y los controles quedan alineados a la derecha. */
    const partes = [];
    if (s.author) partes.push('por ' + s.author);
    if (s.allowTools) partes.push('herramientas: ' + s.allowTools);
    if (s.dependencies && s.dependencies.length) partes.push('deps: ' + s.dependencies.join(', '));
    if (s.source) partes.push('de ' + s.source.repo);
    partes.push('~' + Math.ceil(s.bodyChars / 4) + ' tok');
    it.innerHTML = `
      <span class="tc-mark">${ic('zap')}</span>
      <span class="mt"><b>${esc(s.name)}</b>${s.version ? ` <span class="md">v${esc(s.version)}</span>` : ''}${s.category ? ` <span class="md">· ${esc(s.category)}</span>` : ''}
        <small class="md sdesc">${esc(s.description)}</small>
        <small class="md smeta">${esc(partes.join(' · '))}</small></span>
      <span class="mrow-ctl">
        ${s.source ? `<button class="btn ghost sq" data-update title="Actualizar desde su repo">${ic('history')}</button>` : ''}
        <button class="btn ghost sq" data-view title="Ver skill">${ic('search')}</button>
        <label class="sw ${s.enabled ? 'on' : ''}" data-sw title="Activar/desactivar" aria-label="Activar o desactivar ${esc(s.name)}"></label>
        <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>
      </span>`;
    it.querySelector('[data-sw]').onclick = async (e) => {
      await window.sagitari.skillsToggle(s.id, !s.enabled);
      renderSkills();
    };
    it.querySelector('[data-del]').onclick = async () => {
      if (!(await askConfirm(it, '¿Eliminar la skill «' + s.name + '»?', 'Se borra su carpeta y no se puede deshacer.'))) return;
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
          showToast(r.changed ? 'Skill actualizada' : 'Ya estaba actualizada');
        } catch (err) {
          showToast('Error: ' + (err.message || err));
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
    msg.textContent = 'Escribe owner/repo (ej. anthropics/skills).';
    return;
  }
  msg.textContent = 'Importando desde ' + repo + '…';
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
    msg.textContent = 'Error: ' + (err.message || err);
  } finally {
    btn.disabled = false;
  }
};
$('#skillsFolderBtn').onclick = async () => {
  try {
    await window.sagitari.skillsOpenFolder();
  } catch (e) {
    showToast('No se pudo abrir la carpeta de skills: ' + ((e && e.message) || e));
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
    msg.textContent = 'Nombre y descripción son obligatorios.';
    return;
  }
  btn.disabled = true;
  try {
    await window.sagitari.skillsCreate({ name, description: desc, body });
    $('#skillNewName').value = $('#skillNewDesc').value = $('#skillNewBody').value = '';
    msg.textContent = 'Skill "' + name + '" creada.';
    renderSkills();
  } catch (err) {
    msg.textContent = 'Error: ' + (err.message || err);
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
  if (/disco|disk|custom|usuario|user|extern|fichero|cargad/i.test(s)) return { label: 'Cargado de disco', cls: 'custom' };
  if (/integ|built|sistema|nativ|default|predefinid/i.test(s)) return { label: 'Integrado', cls: '' };
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
  const nombre = String((a && a.nombre) || id || 'Agente');
  const desc = String((a && a.descripcion) || '');
  const ori = origenAgente(a && a.origen);
  const tools = toolsAgente(a && a.tools);
  const meta = [];
  if (a && a.modelo) meta.push('modelo ' + String(a.modelo));
  if (a && a.maxSteps) meta.push(String(a.maxSteps) + ' pasos');
  if (tools.length) meta.push(tools.length + (tools.length === 1 ? ' herramienta' : ' herramientas'));
  /* Los nombres de las herramientas son referencia, no la tarjeta: van en el
     tooltip y aquí queda el recuento para que la ficha se lea de un vistazo. */
  const metaTxt = meta.join(' · ');
  const toolsTxt = tools.length ? 'Herramientas: ' + tools.join(', ') : '';
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
    box.innerHTML = `<div class="subnote">No se pudieron cargar los agentes: ${esc((r && r.error) || 'error desconocido')}</div>`;
    if (cuenta) cuenta.textContent = '';
    box.setAttribute('aria-busy', 'false');
    return;
  }
  if (!agentes.length) {
    box.innerHTML = vListEmpty('agents', 'Sin agentes', 'El registro de agentes está vacío: no hay ninguno que listar.');
  } else {
    box.innerHTML = agentes.map(agentCard).join('');
  }
  if (cuenta) cuenta.textContent = agentes.length + (agentes.length === 1 ? ' agente' : ' agentes');
  box.setAttribute('aria-busy', 'false');
}

$('#agentsReload').onclick = async () => {
  const btn = $('#agentsReload');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await window.sagitari.agentsCustomRecargar();
  } catch (e) {
    showToast('No se pudieron recargar los agentes: ' + ((e && e.message) || e));
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

const EQUIPO_ESTADOS = {
  trabajando: { label: 'trabajando', cls: 'eq-trabajando' },
  // «esperando» es del motor: un permiso pendiente O una pregunta al usuario (el motivo
  // llega aparte, en `atencion`). Por eso la etiqueta no dice «permiso»: quien lo dice es
  // la insignia de permisos pendientes, que sí cuenta los que piden autorización.
  esperando: { label: 'esperando', cls: 'eq-esperando' },
  terminado: { label: 'terminado', cls: 'eq-terminado' },
  fallo: { label: 'falló', cls: 'eq-fallo' },
  interrumpido: { label: 'interrumpido', cls: 'eq-interrumpido' },
  pending: { label: 'pendiente', cls: '' },
  in_progress: { label: 'en curso', cls: 'eq-trabajando' },
  completed: { label: 'hecho', cls: 'eq-terminado' },
  failed: { label: 'falló', cls: 'eq-fallo' },
};

/** Cómo se llama y se pinta un estado. Un valor que no conocemos se dice sin inventarlo. */
function estadoEquipo(v) {
  const k = String(v || '').toLowerCase();
  return EQUIPO_ESTADOS[k] || { label: k || 'sin estado', cls: '' };
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
  if (k === 'lider' || k === 'líder') return 'Líder';
  if (k === 'todos') return 'Todos';
  const m = e && e.miembros.get(k);
  return (m && (m.name || m.id)) || k || '—';
}

/** Insignia de permisos pendientes: el mismo lenguaje que el resto (.abadge + .dot).
    La usan el rail y la vista, así que la cuenta se ve igual en los dos sitios. */
function badgeEquipoPermisos(m) {
  const n = Number(m && m.permisos) || 0;
  if (!n) return '';
  const txt = n === 1 ? '1 permiso pendiente' : n + ' permisos pendientes';
  return `<span class="abadge eqperm" title="${esc(txt)} de ${esc((m && m.name) || 'este compañero')}"><span class="dot a-y"></span>${esc(n === 1 ? '1 permiso' : n + ' permisos')}</span>`;
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
  const tope = equipoLimiteMiembros ? ` Caben como máximo ${equipoLimiteMiembros} compañeros a la vez, además del líder.` : '';
  return (
    'En modo EQUIPO el agente pasa a líder: reparte tu encargo entre compañeros vivos, ellos se escriben por un buzón y apuntan lo que hacen en un tablero compartido.' +
    tope +
    ' Aquí se ve el encargo de cada uno, el buzón y el tablero de ESTA conversación.'
  );
}

/** Una tarjeta de miembro: la misma piel que las de la vista Agentes (.acard). */
function equipoCard(m) {
  const look = K.subagent(m.spec) || { icon: 'agents', cls: 'a-p2' };
  const est = estadoEquipo(m.estado);
  return `<div class="acard ${est.cls}" id="equipoMiembro-${esc(m.id)}">
    <div class="aic ${look.cls}">${ic(look.icon)}</div>
    <div class="amain">
      <div class="ahead"><b>${esc(m.name || m.id)}</b><span class="abadge ${est.cls}">${esc(est.label)}</span>${badgeEquipoPermisos(m)}</div>
      <small>${esc(m.tarea || 'Sin encargo todavía')}</small>
      ${m.spec ? `<span class="amd">especialista: ${esc(m.spec)}${m.expect ? ' · criterio: ' + esc(K.clip(m.expect, 120)) : ''}</span>` : ''}
      ${m.atencion ? `<span class="amd">te necesita: ${esc(K.clip(m.atencion, 200))}</span>` : ''}
      ${m.resumen ? `<span class="amd">${esc(K.clip(m.resumen, 240))}</span>` : ''}
    </div>
    <span class="adot"></span>
  </div>`;
}

function equipoFilaBuzon(e, msg) {
  const hora = new Date(msg.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
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
    return (
      (fallidos.length === 1 ? 'Un compañero no terminó' : fallidos.length + ' compañeros no terminaron') +
      ' su parte: el detalle está en el buzón y en el tablero.'
    );
  }
  return e.ok === false ? 'No llegó un resumen del cierre.' : 'El equipo terminó sin resumen.';
}

/** El cierre del encargo: resumen agregado y gasto del equipo. Con `ok:false` el bloque
    se pinta en rojo: es el estado de error del equipo (p. ej. el corte por presupuesto). */
function equipoCierre(e) {
  const mal = e.ok === false;
  const g = e.gasto || {};
  const gasto = [];
  if (Number.isFinite(Number(g.tokens)) && Number(g.tokens) > 0) gasto.push(K.thousands(g.tokens) + ' tokens');
  if (Number.isFinite(Number(g.costUsd)) && Number(g.costUsd) > 0) gasto.push('$' + Number(g.costUsd).toFixed(4));
  return `<div class="eqresumen${mal ? ' err' : ''}">
    <b>${mal ? 'El equipo se detuvo' : 'Encargo cerrado'}</b>
    ${esc(resumenEquipo(e))}
    ${gasto.length ? `\nGasto del equipo: ${esc(gasto.join(' · '))}` : ''}
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
    if (buzon) buzon.innerHTML = '<div class="subnote">Ningún mensaje todavía.</div>';
    if (tablero) tablero.innerHTML = '<div class="subnote">Nada apuntado todavía.</div>';
    if (cierre) cierre.innerHTML = '';
    if (esperandoLider) {
      // estado de CARGA: el turno va en modo EQUIPO y aún no ha llegado ningún team_*
      box.innerHTML = '<div class="subnote">El líder está repartiendo el encargo entre los compañeros…</div>';
      return;
    }
    const otro = equipoEnOtroHilo();
    box.innerHTML = vListEmpty(
      'agents',
      'Sin equipo en esta conversación',
      otro
        ? 'El equipo de esta conversación todavía no ha empezado. Hay uno en marcha en otra conversación: puedes ir a ella para seguirlo.'
        : 'Escribe una orden en modo EQUIPO (el cuarto modo del compositor, Alt+M para llegar) y el agente pasará a líder: repartirá el trabajo entre compañeros, se verá lo que se escriben y lo que apuntan en el tablero. Aquí no hay nada aún porque esta conversación no ha levantado ningún equipo.',
      otro ? '<button class="btn ghost" data-eqir>Ir a esa conversación</button>' : '',
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
    const partes = [miembros.length === 1 ? '1 compañero' : miembros.length + ' compañeros'];
    if (e.estado === 'vivo') {
      partes.push(enMarcha ? enMarcha + ' en marcha' : 'ninguno trabajando');
      if (esperan) partes.push(esperan + ' esperando permiso');
    } else partes.push(e.ok === false ? 'se detuvo' : 'terminado');
    if (permisos) partes.push(permisos === 1 ? '1 permiso pendiente' : permisos + ' permisos pendientes');
    estadoEl.textContent = partes.join(' · ');
  }
  box.innerHTML = miembros.length
    ? miembros.map(equipoCard).join('')
    : '<div class="subnote">El equipo no ha levantado ningún compañero.</div>';
  if (buzon)
    buzon.innerHTML = e.mensajes.length
      ? e.mensajes.map((m) => equipoFilaBuzon(e, m)).join('')
      : '<div class="subnote">Ningún mensaje todavía: el buzón se llena cuando el líder o los compañeros se escriben.</div>';
  if (tablero)
    tablero.innerHTML = e.tablero.length
      ? e.tablero.map((i, n) => equipoFilaTablero(e, i, n)).join('')
      : '<div class="subnote">Nada apuntado todavía: el tablero es donde el equipo deja el progreso.</div>';
  if (cierre) cierre.innerHTML = e.estado === 'fin' ? equipoCierre(e) : '';
  // el buzón vive de lo último: el feed se lee por el final, como el del rail
  if (buzon) buzon.scrollTop = buzon.scrollHeight;
}

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
  ['system_info', 'monitor', 'CPU, RAM, red y tiempo encendido'],
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
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    rec = (m && m.riskDefaults) || {};
  } catch {}
  // se vacía ANTES de construir la cabecera: si se limpia después, la borra
  g.innerHTML = '';
  // v4.2: cabecera de contexto: qué es esta vista y cómo llegar a los permisos
  const head = document.createElement('div');
  head.style.cssText = 'grid-column:1/-1;margin-bottom:6px';
  head.innerHTML =
    '<div class="subnote" style="margin:0">Lo que Sagitari puede hacer por ti, agrupado por su nivel de permiso. Cambia el nivel de cada una en <b>Ajustes → Seguridad</b>.</div>';
  g.appendChild(head);
  const grupoDe = (n) => (rec[n] === 'restricted' || rec[n] === 'safe' ? rec[n] : 'confirmar');
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
  try {
    mcp = await window.sagitari.mcpList();
  } catch {}
  const conHerramientas = mcp.enabled === false ? [] : (mcp.servers || []).filter((s) => s.enabled && (s.discovered || []).length);
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
  pending: { label: 'En cola', cls: 'blu' },
  scheduled: { label: 'Programada', cls: 'blu' },
  running: { label: 'En curso', cls: 'cy' },
  paused: { label: 'Pausada', cls: 'pur' },
  interrupted: { label: 'Interrumpida — recuperable', cls: 'pur' },
  failed: { label: 'Falló', cls: 'mag' },
  completed: { label: 'Completada', cls: 'ok' },
  cancelled: { label: 'Cancelada', cls: 'mag' },
};
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
    box.innerHTML = `<div class="subnote">No se pudieron cargar las tareas: ${esc((err && err.message) || err)}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = vListEmpty(
      'list',
      'Ninguna tarea todavía',
      'Lanza una arriba con un objetivo y un modo, o deja que el chat cree puntos de control solo cuando un trabajo se alarga. Podrás pausarlas y retomarlas donde quedaron.',
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
      ? `<small class="md">${t.live.toolCalls || 0} herramientas · ${(t.live.tokensIn || 0) + (t.live.tokensOut || 0)} tok${t.live.costUsd ? ' · $' + t.live.costUsd.toFixed(4) : ''}${t.live.toolsFired && t.live.toolsFired.length ? ' · última: ' + esc(t.live.toolsFired[t.live.toolsFired.length - 1].name) : ''}</small><br>`
      : '';
    const sched =
      t.status === 'scheduled' && t.scheduledAt ? `<small class="md">→ ${new Date(t.scheduledAt).toLocaleString('es')}</small><br>` : '';
    // sin role=button: la fila lleva botones propios (pausar, reanudar, borrar…)
    it.setAttribute('aria-label', 'Tarea: ' + (t.goal || 'sin objetivo') + ' — ' + st.label);
    it.title = t.goal || '(sin objetivo)';
    it.innerHTML = `<div class="hic">${ic('history')}</div>
      <div class="hmain"><b>${esc(t.goal || '(sin objetivo)')}</b>
        <small><span class="dot ${st.cls}"></span> ${st.label} · paso ${esc(t.step || '—')} · ${t.steps || 0} pasos · ${when}</small><br>
        ${sched}${live}${err}
        ${t.result ? `<small class="md">${esc(K.clip(t.result, 140))}</small>` : ''}
      </div>
      ${t.status === 'running' ? `<button class="btn ghost sq" data-pause title="Pausar">${ic('pause')}</button>` : ''}
      ${t.status === 'paused' || t.status === 'interrupted' || t.status === 'failed' || t.status === 'pending' ? `<button class="btn primary sq" data-resume title="Reanudar">${ic('zap')}</button>` : ''}
      ${t.status === 'scheduled' ? `<button class="btn primary sq" data-runnow title="Ejecutar ahora">${ic('zap')}</button>` : ''}
      ${!['completed', 'failed', 'cancelled'].includes(t.status) ? `<button class="btn ghost sq danger" data-cancel title="Cancelar">${ic('close')}</button>` : ''}
      ${t.status === 'running' ? '' : `<button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`}`;
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
            showToast(r.error || 'No se pudo reanudar');
            rb.disabled = false;
          }
        } catch (e) {
          showToast('No se pudo reanudar: ' + ((e && e.message) || e));
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
          showToast('No se pudo pausar: ' + ((e && e.message) || e));
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
          showToast('No se pudo ejecutar: ' + ((e && e.message) || e));
          sb.disabled = false;
        }
        renderTasks();
      };
    const cb = it.querySelector('[data-cancel]');
    if (cb)
      cb.onclick = async (ev) => {
        ev.stopPropagation();
        if (!(await askConfirm(it, '¿Cancelar esta tarea?', K.clip(t.goal, 160)))) return;
        cb.disabled = true;
        await window.sagitari.taskCancel(t.runId);
        renderTasks();
      };
    const db = it.querySelector('[data-del]');
    if (db)
      db.onclick = async (ev) => {
        ev.stopPropagation();
        if (!(await askConfirm(it, '¿Eliminar esta tarea del historial?', K.clip(t.goal, 160)))) return;
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
    msg.textContent = 'Escribe el objetivo de la tarea.';
    return;
  }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: null });
    if (r && r.ok) {
      msg.textContent = 'Tarea en cola (' + r.runId + ').';
      $('#taskGoal').value = '';
      feed('Tarea lanzada en segundo plano', 'blu');
      renderTasks();
    } else msg.textContent = (r && r.error) || 'No se pudo crear la tarea.';
  } catch (e) {
    msg.textContent = 'Error: ' + ((e && e.message) || e);
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
    msg.textContent = 'Escribe el objetivo de la tarea.';
    return;
  }
  if (!when) {
    msg.textContent = 'Elige fecha y hora.';
    return;
  }
  btn.disabled = true;
  try {
    const r = await window.sagitari.taskEnqueue({ goal, mode: $('#taskMode').value, scheduledAt: new Date(when).toISOString() });
    if (r && r.ok) {
      msg.textContent = 'Tarea programada para ' + new Date(when).toLocaleString('es');
      $('#taskGoal').value = '';
      $('#taskWhen').value = '';
      renderTasks();
    } else msg.textContent = (r && r.error) || 'No se pudo programar.';
  } catch (e) {
    msg.textContent = 'Error: ' + ((e && e.message) || e);
  } finally {
    btn.disabled = false;
  }
  setTimeout(() => {
    msg.textContent = '';
  }, 4000);
};
$('#chatPause').onclick = async () => {
  const r = await window.sagitari.pauseChat(hiloActual());
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
      feed('Espacio de trabajo: ' + (r.workspace || r.path), 'ok');
    } else {
      $('#projMsg').textContent = (r && r.error) || 'No se pudo abrir la ruta.';
    }
  } catch (e) {
    $('#projMsg').textContent = (e && e.message) || 'No se pudo abrir la ruta.';
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
      $('#projMsg').textContent = 'Espacio de trabajo activo: ' + s.path;
      feed('Espacio de trabajo: ' + s.path, 'ok');
    } else $('#projMsg').textContent = (s && s.error) || 'No se pudo fijar la carpeta.';
    setTimeout(() => {
      $('#projMsg').textContent = '';
    }, 4000);
  }
};

// ============ misc ============

function showToast(text) {
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
  pila.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
/** Texto del pie: qué modelo está en uso y de qué proveedor. Sin estados: la
    píldora enseña la selección y abre la lista para cambiarla. */
function updateStatusLabels() {
  const a = CFG.active;
  $('#stModel').textContent = a ? a.model : 'sin modelo';
  $('#stProv').textContent = a ? a.name || 'proveedor' : 'configura tu API';
  $('#sideStatusBtn').title = a
    ? `Modelo: ${a.model} — pulsa para cambiar entre los modelos de tu API`
    : 'Configura un proveedor y un modelo';
  $('#chatModelLabel').textContent = a ? a.name + ' · ' + a.model : '';
  // tarjeta de estado de Ajustes
  const name = $('#activeModelName');
  if (!name) return;
  const meta = $('#activeModelMeta'),
    badge = $('#activeModelBadge');
  if (!a) {
    name.textContent = 'Sin modelo activo';
    meta.textContent = 'Elige un proveedor y activa un modelo para empezar.';
    badge.textContent = 'sin activar';
    badge.classList.add('off');
    return;
  }
  name.textContent = a.model;
  const bits = [a.name || 'Proveedor'];
  try {
    bits.push(new URL(a.baseUrl).host);
  } catch {}
  if (a.format && a.format !== 'auto') bits.push('formato: ' + a.format);
  if (a.vision) bits.push('visión');
  meta.textContent = bits.join(' · ');
  badge.textContent = 'activo';
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
      .join('') || '<div class="mm-hint">Sin opciones.</div>';
  // Coordenadas propias: el menú es position:fixed, así que escapa del overflow del
  // contenedor (antes .main lo recortaba). Se mide con la lista ya pintada, se ancla
  // al botón, se voltea hacia arriba si abajo no cabe y se mantiene dentro de la vista.
  const r = caja.getBoundingClientRect();
  menu.style.width = Math.round(r.width) + 'px';
  // el menú nace [hidden] (display:none) y sin caja scrollHeight mide siempre 0:
  // se le da caja un instante para medirlo de verdad. Todo ocurre en el mismo tick,
  // así que no llega a pintarse en una posición provisional.
  menu.hidden = false;
  const alto = Math.min(300, menu.scrollHeight || 300);
  const cabeAbajo = window.innerHeight - r.bottom - 8 >= Math.min(alto, 200);
  const arriba = !cabeAbajo && r.top > alto;
  const top = arriba ? r.top - alto - 6 : r.bottom + 6;
  menu.style.left = Math.round(Math.max(8, Math.min(r.left - 2, window.innerWidth - r.width - 6))) + 'px';
  menu.style.top = Math.round(Math.max(8, Math.min(top, window.innerHeight - 12))) + 'px';
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
    modelMenu.innerHTML = `<div class="sm-head">SIN MODELO</div>
      <div class="mm-hint">Activa un proveedor y un modelo en Ajustes › Modelo.</div>
      <div class="sm-item" data-act="settings"><span class="sm-name">Abrir Ajustes</span></div>`;
  } else {
    const head = c.provider ? `MODELOS · ${esc(c.provider.name)}` : 'MODELOS';
    const items = c.models
      .map((m) => {
        const on = m === c.current;
        return `<div class="sm-item${on ? ' on' : ''}" role="option" aria-selected="${on}" data-model="${esc(m)}" title="${esc(m)}">
        <span class="sm-name">${esc(m)}</span>${on ? '<span class="mm-mark" aria-hidden="true">✓</span>' : ''}</div>`;
      })
      .join('');
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
      row.querySelector('.sm-name').textContent = 'Detectando…';
      // Sin decir el protocolo, una base Anthropic/Responses de terceros cuya ruta no
      // lo delata se sondeaba con Bearer y la detección fallaba (401/404) justo donde la
      // pestaña Modelo sí acierta. Se manda el `format`/`providerId` del proveedor activo
      // (como 30-ajustes.js) para que main elija las cabeceras y la ruta correctas.
      const r = await window.sagitari.listModels(cfg.baseUrl, cfg.apiKey, {
        format: cfg.format,
        providerId: cfg.id,
      });
      if (!r.ok) {
        showToast('No se pudieron detectar: ' + r.error);
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
        showToast('Error guardando la lista: ' + saved.error);
        closeModelMenu();
        return;
      }
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
      providerId: c.provider ? c.provider.id : CFG.active && CFG.active.providerId,
      name: c.provider ? c.provider.name : CFG.active && CFG.active.name,
      baseUrl: CFG.active && CFG.active.baseUrl,
      model,
      vision: looksVision(model),
      format: (CFG.active && CFG.active.format) || 'auto',
    });
    if (r && r.ok === false) {
      showToast('No se pudo cambiar: ' + r.error);
      return;
    }
    CFG = await window.sagitari.getConfig();
    closeModelMenu();
    renderProviderList();
    updateStatusLabels();
    showToast('Modelo: ' + model);
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
function applyTheme() {
  const s = CFG.settings || {};
  const pal = PALETTES[s.uiColor] || PALETTES.aurora;
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
  r.setProperty('--glow-str', String(Math.min(1.4, Math.max(0.4, Number(s.glowStrength) || 0.7))));
  r.setProperty('--glass', String(Math.min(1.3, Math.max(0.4, Number(s.glassTint) || 1))));
  // los fondos también son del tema: si no, el color cambia solo en los acentos
  for (const [token, valor] of Object.entries(rampaDeSuperficies(pal.acc))) r.setProperty(token, valor);
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
  return v < 0.8 ? 'Suave' : v <= 1.15 ? 'Equilibrado' : 'Intenso';
}
function glassTintLabel(v) {
  return v < 0.7 ? 'Ultra claro' : v <= 1.1 ? 'Equilibrado' : 'Tintado';
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
    box.innerHTML = '<div class="subnote">No hay cambios que revisar en este turno.</div>';
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
          ${noRev ? '<span class="df-norev">No se puede revertir solo este archivo</span>' : ''}
          <button class="btn ghost sq" data-revert="${esc(ruta)}" title="Revertir este archivo" aria-label="Revertir los cambios de ${esc(rel)}"${noRev ? ' disabled' : ''}>${ic('history')}</button>
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
  feed('Sagitari iniciado', 'ok');
  feed('Esperando peticiones', 'blu');
  if (!CFG.active) {
    // bienvenida SIN abrir turno: con ensureAssistantBubble quedaban vivos
    // pendingAssistant/pendingTurn y el primer mensaje real se escribía dentro
    // de esta misma burbuja, heredando el modo del arranque
    const b = bubble('ai');
    b.innerHTML = fmt(
      '**Sagitari online.** Antes de escribirme, ve a **Ajustes** y activa un proveedor y modelo (OpenCode Go, OpenRouter, Ollama…).',
    );
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
