/* SAGITARI renderer — 20-app.js (antes app.js 1340-2752): feed de actividad, agentes, skills, confirmaciones, envío y adjuntos
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
/* exported renderMarket, pintarCtxMeter, resetCtxMeter, pintarRailEquipo */
/* global hiloActual, eventoDeOtraPestana, equipoDe, estadoEquipo, badgeEquipoPermisos, equipoEvento */
/* global equipoChat, equipoPermiso, equipoFicha, sysline, newConversation */
// ============ activity feed + live agents ============
const FEED_MAX = 6;
/* v5.0.1: eventos que NO pertenecen a una conversación concreta y por eso se atienden
   mire donde mire el usuario: la confirmación (su turno la espera, y el id viaja con la
   conversación que la pidió), el aviso de la app, y el cierre/estado de una tarea en
   segundo plano (panel de Tareas). Todo lo demás viaja con `convId` y solo se pinta en su
   pestaña. Al añadir un tipo de evento nuevo: si es del turno, NO va aquí. */
const EVENTOS_DE_LA_APP = new Set(['confirm_request', 'toast', 'task_done', 'task_interrupted', 'task_update']);
/* TABLERO: reloj de estación del rail (hora local tabular, late 1 vez por segundo
   y solo si el rail existe; el intervalo vive mientras la ventana viva). */
function tickBoardClock() {
  const el = document.getElementById('boardClock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
tickBoardClock();
setInterval(tickBoardClock, 1000);
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
  view_image: { el: 'agentCard-analyst', name: 'Analista', icon: 'eye', cls: 'a-b2', desc: 'Analizando una imagen' },
  clipboard: { el: 'agentCard-ops', name: 'Operador', icon: 'clipboard', cls: 'a-p2', desc: 'Gestionando portapapeles' },
  notify: { el: 'agentCard-ops', name: 'Operador', icon: 'bell', cls: 'a-p2', desc: 'Enviando notificación' },
  media_control: { el: 'agentCard-ops', name: 'Operador', icon: 'music', cls: 'a-p2', desc: 'Control multimedia' },
  window_manage: { el: 'agentCard-ops', name: 'Operador', icon: 'window', cls: 'a-p2', desc: 'Gestionando ventanas' },
  system_info: { el: 'agentCard-analyst', name: 'Analista', icon: 'monitor', cls: 'a-b2', desc: 'Leyendo el sistema' },
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
  const found = Object.keys(AGENT_MAP).find((n) => t.toLowerCase().startsWith(n) || t.includes(AGENT_MAP[n].name));
  if (found) return agentStart(found);
  const prefix = t.split(/ [—·-]/)[0].toLowerCase();
  const hint = {
    terminal: 'run_command',
    leyendo: 'read_file',
    escribiendo: 'write_file',
    explorando: 'list_dir',
    buscando: 'search_files',
    navegador: 'browser_control',
    capturando: 'screenshot',
    portapapeles: 'clipboard',
    multimedia: 'media_control',
    ventanas: 'window_manage',
  }[prefix];
  agentStart(hint || 'run_command');
}
function agentStop() {
  document.querySelectorAll('.acard.on').forEach((c) => c.classList.remove('on'));
  updateAgentCount();
}
/** id de tarjeta → agente: permite limpiar el rail cuando una tarjeta se apaga. */
const CARD_AGENT = Object.values(AGENT_MAP).reduce((acc, a) => {
  if (!acc[a.el]) acc[a.el] = a;
  return acc;
}, {});

function updateAgentCount() {
  const cards = [...document.querySelectorAll('.acard.on')];
  const n = cards.length;
  const cuenta = $('#agentCount');
  if (cuenta) cuenta.textContent = n;
  // Sin nada en marcha, el «0» a 24px y los mini-puntos son decoración ocupando el
  // sitio de la información: el contador desaparece y lo dice la etiqueta de estado.
  const caja = cuenta && cuenta.closest('.rc-count');
  if (caja) caja.hidden = n === 0;
  /* El estado REAL, no una etiqueta fija. Antes la tarjeta decía «Sin agentes en
     marcha» mientras el agente principal respondía en el hilo: dos verdades
     contradictorias en la misma pantalla. `busy` es el turno de la conversación a
     la vista (lo mantiene 20-app.js al vuelo de cada evento). */
  const estado = $('#railState');
  if (estado) {
    estado.textContent = n ? (n === 1 ? '1 agente activo' : n + ' agentes activos') : busy ? 'Sagitari trabajando' : 'En reposo';
  }
  const live = $('#railLive');
  if (live) live.classList.toggle('busy', !n && !!busy);
  // el rail lista SOLO agentes vivos: antes acumulaba entradas de herramientas ya
  // terminadas mientras el contador marcaba 0 (lista y número se contradecían)
  const rail = $('#railAgents');
  if (!rail) return;
  const liveSet = new Set(cards.map((c) => CARD_AGENT[c.id] && CARD_AGENT[c.id].name).filter(Boolean));
  rail.querySelectorAll('.ragent').forEach((d) => {
    if (!liveSet.has(d.dataset.agent)) d.remove();
  });
}
updateAgentCount();

/** Los compañeros del EQUIPO en el rail: la vista Equipo y la tarjeta del chat comparten
    este estado (40-vistas.js), así que el rail lo pinta quien tiene el DOM del rail. */
function pintarRailEquipo() {
  const rail = $('#railAgents');
  if (!rail) return;
  rail.querySelectorAll('.ragent.miembro').forEach((n) => n.remove());
  const e = equipoDe(hiloActual(), false);
  if (e && e.estado === 'vivo') {
    const filas = [];
    for (const id of e.orden) {
      const m = e.miembros.get(id);
      if (!m) continue;
      const look = K.subagent(m.spec) || { icon: 'agents', cls: 'a-p2' };
      const est = estadoEquipo(m.estado);
      const d = document.createElement('div');
      d.className = 'ragent miembro ' + est.cls;
      d.dataset.miembro = m.id;
      d.innerHTML = `<div class="aic ${look.cls}">${ic(look.icon)}</div>
      <div><b>${esc(m.name || m.id)}</b><small>${esc(K.clip(m.tarea || est.label, 48))}</small></div>
      ${badgeEquipoPermisos(m)}<span class="adot"></span>`;
      d.title = `${m.name || m.id}${m.spec ? ' (' + m.spec + ')' : ''} · ${est.label}${m.tarea ? '\n' + m.tarea : ''}`;
      filas.push(d);
    }
    rail.prepend(...filas);
  }
  updateAgentCount();
}

/** Paneles de la vista Agentes: se pintan al entrar y se refrescan durante el turno. */
function refreshAgentsPanels() {
  const v = $('#view-agents');
  if (!v || !v.classList.contains('on') || document.hidden) return;
  renderToolTray();
  renderHealth();
  renderHabits();
}

/* Un panel de diagnóstico sin datos se marca `vacio`: pierde la caja y queda como
   nota con su rótulo (ver .tooltray.vacio). En cuanto hay algo dentro vuelve a ser
   panel, así que la caja significa «aquí hay datos que mirar». */
function marcarTrayVacio(el, vacio) {
  const tray = el && el.closest ? el.closest('.tooltray') : null;
  if (tray) tray.classList.toggle('vacio', !!vacio);
}

/** «Actividad de herramientas» = lo realmente usado en la sesión, no el catálogo. */
async function renderToolTray() {
  const tray = $('#toolTrayList');
  if (!tray) return;
  marcarTrayVacio(tray, false);
  let fired = [];
  try {
    fired = ((await window.sagitari.getAgentsLive()) || {}).toolsFired || [];
  } catch (e) {
    tray.innerHTML = `<div class="subnote">No se pudo leer la actividad: ${esc((e && e.message) || e)}</div>`;
    return;
  }
  if (!fired.length) {
    tray.innerHTML = '<div class="subnote">Todavía no se ha usado ninguna herramienta en esta sesión.</div>';
    marcarTrayVacio(tray, true);
    return;
  }
  tray.innerHTML = fired
    .map((t) => {
      const label = t.name + ' ×' + t.count;
      return `<span class="toolchip" title="${esc(label)}"><span class="tc-mark">${ic(K.tool(t.name).icon)}</span><span class="tc-txt" title="${esc(label)}">${esc(label)}</span></span>`;
    })
    .join('');
}

// ============ v1.6: Model Health panel ============
async function renderHealth() {
  const box = $('#healthList');
  if (!box) return;
  marcarTrayVacio(box, false);
  let rows = [],
    err = null;
  try {
    rows = (await window.sagitari.healthGet()) || [];
  } catch (e) {
    err = e;
  }
  if (err) {
    box.innerHTML = `<div class="subnote">No se pudo leer la salud del modelo: ${esc((err && err.message) || err)}</div>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = '<div class="subnote">Sin datos todavía. Cada llamada al modelo registrará latencia, errores y tokens aquí.</div>';
    marcarTrayVacio(box, true);
    return;
  }
  /* Una fila de datos por modelo: las cifras no se recortan y las columnas
     quedan alineadas entre filas (celdas vacías incluidas). */
  box.innerHTML = rows
    .map((r) => {
      const health = r.errorRate >= 0.3 ? 'mag' : r.errorRate > 0 ? 'a-y' : 'ok';
      const tok = (r.tokensIn + r.tokensOut).toLocaleString('es');
      const errs = r.errors ? r.errors + (r.errors === 1 ? ' error' : ' errores') : '';
      const rel = r.fallbacks ? r.fallbacks + (r.fallbacks === 1 ? ' relevo' : ' relevos') : '';
      return `<div class="hrow" title="${esc(r.lastError || '')}">
      <span class="dot ${health}"></span>
      <b class="hmod">${esc(r.model)}</b>
      <span class="hstat">${r.calls} llamadas</span>
      <span class="hstat">${r.avgLatencyMs || '—'} ms</span>
      <span class="hstat">${tok} tok</span>
      <span class="hstat${errs ? ' bad' : ''}">${errs}</span>
      <span class="hstat">${rel}</span>
    </div>`;
    })
    .join('');
}

// ============ v2.0: hábitos observados ============
async function renderHabits() {
  const box = $('#habitsList');
  if (!box) return;
  marcarTrayVacio(box, false);
  let s = {};
  try {
    s = await window.sagitari.habitsGet();
  } catch {}
  const parts = [];
  const fmtList = (arr, icon) =>
    (arr || []).length
      ? `<div class="toolchip" title="${esc(arr.map((x) => x.name + ' ×' + x.count).join(' · '))}"><span class="tc-mark">${ic(icon)}</span><span class="tc-txt" title="${esc(arr.map((x) => x.name + ' ×' + x.count).join(' · '))}">${arr.map((x) => `${esc(x.name)} ×${x.count}`).join(' · ')}</span></div>`
      : '';
  parts.push(fmtList(s.apps, 'zap'));
  parts.push(fmtList(s.commands, 'terminal'));
  parts.push(fmtList(s.sites, 'globe'));
  const c = s.confirms || {};
  if (c.approved || c.denied)
    parts.push(
      `<div class="toolchip"><span class="tc-mark">${ic('check')}</span><span class="tc-txt" title="Confirmaciones aceptadas y denegadas">confirmaciones: ${c.approved || 0} aceptadas · ${c.denied || 0} denegadas</span></div>`,
    );
  const hayHabitos = parts.filter(Boolean).length > 0;
  box.innerHTML =
    parts.filter(Boolean).join('') ||
    '<div class="subnote">Aún no hay hábitos observados. Se aprenden solo de lo que SAGITARI hace por ti.</div>';
  marcarTrayVacio(box, !hayHabitos);
}

/** Resumen legible de una importación: instaladas y omitidas (con el motivo). */
function importSummary(inst) {
  const list = Array.isArray(inst) ? inst : [];
  const ok = list.filter((s) => !s.skipped).map((s) => s.name);
  const omitidas = list.filter((s) => s.skipped);
  let txt = ok.length ? 'Instaladas: ' + ok.join(', ') : 'No se instaló ninguna skill';
  if (omitidas.length) {
    txt += ' · Omitidas: ' + omitidas.map((s) => s.name + (s.reason ? ' (' + s.reason + ')' : '')).join(', ');
  }
  return txt;
}

// v1.7: marketplace de skills
/* Importación en dos pasos: el primer clic trae la vista previa (qué skills,
   de qué repo) y el segundo confirma. Una skill son instrucciones que el
   agente obedecerá, no un texto inerte: instalar sin mirar es darle órdenes
   a un desconocido. `say` pinta el aviso donde lo vea el usuario. */
const skillImportArmed = {}; // repo -> true si ya se enseñó la previa
async function skillsImportConfirmed(repo, say) {
  const r = await window.sagitari.skillsImport(repo, skillImportArmed[repo] ? { confirm: true } : undefined);
  if (r && r.needsConfirm) {
    skillImportArmed[repo] = true;
    say('Revisa antes de instalar — ' + (r.error || 'pulsa otra vez para confirmar.'));
    return null; // previa mostrada: el segundo clic instala
  }
  delete skillImportArmed[repo];
  return r;
}
async function renderMarket() {
  const box = $('#marketList');
  if (!box) return;
  let items = [];
  try {
    items = await window.sagitari.marketCatalog();
  } catch {}
  box.innerHTML =
    items
      .map(
        (f) => `
    <div class="memitem">
      <span class="tc-mark">${ic('zap')}</span>
      <span class="mt"><b>${esc(f.repo)}</b> <span class="md">· ${esc(f.category)}</span><br><small class="md">${esc(f.description)}</small></span>
      ${f.installed ? '<span class="md" style="color:var(--ok)">✓ instalado</span>' : `<button class="btn primary sq" data-install="${esc(f.repo)}" title="Instalar">${ic('download')}</button>`}
    </div>`,
      )
      .join('') || '<div class="subnote">Catálogo no disponible sin conexión.</div>';
  box.querySelectorAll('[data-install]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      $('#marketMsg').textContent = 'Instalando ' + b.dataset.install + '…';
      try {
        const inst = await skillsImportConfirmed(b.dataset.install, (t) => {
          $('#marketMsg').textContent = t;
        });
        if (!inst) {
          renderMarket();
          return;
        } // previa a la vista: el segundo clic confirma
        $('#marketMsg').textContent = importSummary(inst);
        renderSkills();
      } catch (e) {
        $('#marketMsg').textContent = 'Error: ' + (e.message || e);
      }
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
    box.innerHTML =
      res
        .map(
          (r) => `
      <div class="memitem">
        <span class="tc-mark">${ic('search')}</span>
        <span class="mt"><b>${esc(r.repo)}</b> <span class="md">★ ${esc(r.stars)}</span><br><small class="md">${esc(r.description)}</small></span>
        <button class="btn primary sq" data-install="${esc(r.repo)}" title="Instalar">${ic('download')}</button>
      </div>`,
        )
        .join('') || '<div class="subnote">Sin resultados.</div>';
    box.querySelectorAll('[data-install]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const inst = await skillsImportConfirmed(b.dataset.install, (t) => {
            $('#marketMsg').textContent = t;
          });
          if (!inst) {
            b.disabled = false;
            return;
          } // previa a la vista: reactivar para el segundo clic
          $('#marketMsg').textContent = 'Instalado: ' + b.dataset.install;
          renderSkills();
        } catch (e) {
          $('#marketMsg').textContent = 'Error: ' + (e.message || e);
        }
      };
    });
    $('#marketMsg').textContent = '';
  } catch (e) {
    $('#marketMsg').textContent = 'Error: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
};
$('#skillsUpdateAllBtn').onclick = async () => {
  const btn = $('#skillsUpdateAllBtn');
  if (btn.disabled) return;
  // Actualizar es traer instrucciones nuevas de repos ajenos que el agente
  // obedecerá: no es un «update» inocuo y no se hace en silencio.
  const yes = await askConfirm(
    $('#skillsUpdateAllBtn'),
    '¿Actualizar todas las skills desde sus repos?',
    'Traerá instrucciones nuevas de terceros que el agente obedecerá.',
  );
  if (!yes) return;
  $('#marketMsg').textContent = 'Actualizando skills…';
  btn.disabled = true;
  try {
    const res = await window.sagitari.skillsUpdateAll();
    const changed = res.filter((r) => r.changed).length;
    $('#marketMsg').textContent = `${res.length} skills con origen · ${changed} actualizadas`;
    renderSkills();
  } catch (e) {
    $('#marketMsg').textContent = 'Error: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
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
  if (streamRaf) {
    cancelAnimationFrame(streamRaf);
    streamRaf = 0;
  }
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
    if (!h._openText) return; // se congeló antes del frame: no se repinta nada
    /* El segmento abierto se repinta EN SU SITIO (no se borra y re-anexa al
       final como antes): así cada tramo de narración queda donde nació, entre
       las tarjetas de herramientas que lo rodean, en orden cronológico. */
    let s = h._openEl && h._openEl.isConnected ? h._openEl : null;
    if (!s) {
      s = document.createElement('div');
      // `seg`: el tramo de narración es un BLOQUE con piel propia dentro de la traza del
      // turno, no texto suelto dentro de una burbuja única
      s.className = 'stream seg';
      h.appendChild(s);
      h._openEl = s;
    }
    s.innerHTML = fmt(h._openText);
    scroll();
  });
}

/* Congela el tramo de narración en curso: pasa a bloque estático y el texto
   siguiente nacerá en un bloque nuevo DESPUÉS de la tarjeta que llega ahora.
   Es lo que intercala explicación y trabajo en orden cronológico. En modo PLAN
   con tarjeta activa no se congela: el plan ya vive en su tarjeta y el texto
   se repintaría duplicado. */
function freezeStream() {
  const h = pendingAssistant;
  if (!h || !h._openText) return;
  if (pendingTurn && pendingTurn.mode === 'plan' && pendingTurn.plan) return;
  cancelStreamRender();
  let s = h._openEl && h._openEl.isConnected ? h._openEl : null;
  if (!s) {
    s = document.createElement('div');
    h.appendChild(s);
  }
  s.className = 'stream-done seg';
  s.innerHTML = fmt(h._openText);
  h._frozenText = (h._frozenText || '') + (h._frozenText ? '\n\n' : '') + h._openText;
  h._openText = '';
  h._openEl = null;
}

/* ---- medidor de contexto del chat ----
   Lo alimenta el evento `context` del agente: tokens usados sobre la ventana del modelo y
   el estado que él mismo calcula ('hola' = holgado, 'ajustado', 'apretado'). Vive aquí
   porque lo usan las fichas de conversación (`10-chat.js`) y el reset de la vista. */
function pintarCtxMeter(ev) {
  const el = document.getElementById('ctxMeter');
  if (!el || !ev) return;
  const pct = Number.isFinite(Number(ev.pct)) ? Math.max(0, Math.min(100, Number(ev.pct))) : 0;
  el.hidden = false;
  el.dataset.estado = String(ev.estado || 'hola');
  el.style.setProperty('--ctx-pct', pct + '%');
  const val = el.querySelector('.ctxval');
  if (val) val.textContent = pct + '%';
  /* La cifra exacta, a un `title` de distancia: el chat no es un panel de métricas. */
  const tokens = Number(ev.tokens) || 0;
  const limite = Number(ev.limite) || 0;
  el.title = limite
    ? K.thousands(tokens) + ' de ' + K.thousands(limite) + ' tokens de contexto'
    : K.thousands(tokens) + ' tokens de contexto';
}

/** Sin contexto que enseñar (conversación nueva, o sin evento todavía): se esconde, en vez
    de quedarse con el porcentaje de otra conversación. */
function resetCtxMeter() {
  const el = document.getElementById('ctxMeter');
  if (!el) return;
  el.hidden = true;
  el.dataset.estado = 'hola';
  el.style.setProperty('--ctx-pct', '0%');
  const val = el.querySelector('.ctxval');
  if (val) val.textContent = '0%';
  el.title = '';
}

window.sagitari.onAgentEvent((ev) => {
  // v1.3: los eventos de una tarea en segundo plano NO deben tocar el chat
  // interactivo (ni sus burbujas ni el estado busy/detener): solo el feed,
  // el panel de Tareas, las confirmaciones y los avisos.
  if (ev.bg) {
    switch (ev.type) {
      case 'status':
        feed(ev.text, 'pur');
        break;
      case 'tool':
        feed(ev.name || 'herramienta', 'pur');
        break;
      case 'tool_result':
        feed((ev.name || '') + ' — ' + String(ev.result || 'ok').slice(0, 90), ev.ok === false ? 'err' : 'ok');
        break;
      case 'delegate_start':
        feed(etiquetaEquipo(ev), 'pur');
        break;
      case 'delegate_done': {
        const who = (K.subagent(ev.subagent) || {}).label || 'Subagente';
        const st = String(ev.status || 'OK').toUpperCase();
        feed(
          who +
            ' — ' +
            (st === 'FAILED' ? 'falló' : st === 'PARTIAL' ? 'a medias' : 'terminó') +
            (ev.result ? ': ' + String(ev.result).slice(0, 80) : ''),
          st === 'FAILED' ? 'err' : 'ok',
        );
        break;
      }
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
        feed(ev.note || 'Tarea: ' + ev.status, 'blu');
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
      case 'confirm_request':
        showConfirm(ev);
        break;
      case 'toast':
        showToast(ev.title + ': ' + ev.message);
        break;
      default:
        break; // delta/assistant_done/busy/stopped/image se ignoran
    }
    return;
  }
  /* EQUIPO: los eventos se ACUMULAN por conversación (`equipoEvento`) y la tarjeta del chat
     se pinta con ellos (`equipoChat`). Sin estos dos enganches la vista Equipo sale vacía y
     la tarjeta no nace, aunque el motor sí mande los eventos. */
  if (/^team_/.test(String(ev.type || ''))) {
    /* Este bloque va ANTES de la guarda de `convId` de más abajo, así que hay que
       comprobarla aquí: el ESTADO del equipo se acumula para CUALQUIER conversación
       (lo leen la vista Equipo y el contador del menú, que son de toda la app), pero la
       TARJETA del hilo sólo se pinta en la conversación a la vista. Sin esta comprobación
       un `team_*` de otra pestaña pintaba estado, feed, una burbuja y una tarjeta DENTRO
       del hilo visible y la dejaba enganchada al equipo de la otra conversación (los
       siguientes eventos la seguían repintando ahí). Mismo criterio que la guarda de
       abajo: sin conversación conocida (`hiloActual()` null) no se desvía nada. */
    equipoEvento(ev);
    const visible = hiloActual();
    if (!visible || !ev.convId || ev.convId === visible) equipoChat(ev);
    return;
  }
  /* v5.0.1: cada evento del turno viaja con SU conversación (`convId`). Si no es la que
     está a la vista, no se pinta aquí: antes la respuesta de una pestaña se colaba en la
     burbuja de la otra (delta, busy, assistant_done…), porque este manejador es único y
     escribía siempre en la vista activa. `eventoDeOtraPestana` deja a la dueña al día
     —ocupada, con sus cambios que deshacer— y su historial se repinta al volver a ella.
     Lo que NO es de una conversación sigue su camino: una confirmación tiene que poder
     responderse mire donde mire el usuario (su turno la está esperando) y los avisos y el
     panel de Tareas son de la app. Sin conversación conocida (`hiloActual()` null, en el
     arranque) tampoco se desvía nada: no hay a quién atribuir el evento. */
  const abierto = hiloActual();
  if (abierto && ev.convId && ev.convId !== abierto && !EVENTOS_DE_LA_APP.has(ev.type)) return eventoDeOtraPestana(ev);
  switch (ev.type) {
    /* El contexto crece MIENTRAS el turno trabaja: si sólo se pintara al cambiar de ficha,
       el medidor mentiría durante toda la respuesta. */
    case 'context':
      pintarCtxMeter(ev);
      break;
    case 'delta': {
      if (ev.subagent) break;
      const b = ensureAssistantBubble();
      b._stream = (b._stream || '') + ev.text;
      b._openText = (b._openText || '') + ev.text;
      // ya está contestando: el razonamiento se pliega (el bloque sigue ahí, para releerlo)
      cerrarRazonamiento();
      // modo PLAN: en cuanto el plan queda cerrado en el texto se pinta como
      // checklist y desaparece del stream (así se ve avanzar mientras trabaja)
      if (pendingTurn && pendingTurn.mode === 'plan' && !pendingTurn.plan) {
        const p = K.parsePlan(b._stream);
        const cerrado = p.body.trim().length > 0 || /\n[ \t]*\n[ \t]*$/.test(b._stream);
        if (p.steps.length >= 2 && cerrado) {
          pendingTurn.plan = renderPlanCard(b, p.steps);
          pendingTurn.plan.next();
          b._stream = p.body;
          b._openText = p.body; // el segmento abierto enseña lo mismo que el stream
        }
      }
      scheduleStreamRender(b);
      break;
    }
    /* Razonamiento del modelo (solo llega si el usuario lo activó en Ajustes). Se pinta
       en su bloque y NUNCA en la burbuja ni en la narración: no es la respuesta. */
    case 'thinking_delta': {
      if (ev.subagent) break; // el de un subagente es trabajo interno (va en su tarjeta)
      const d = ensureThinkBlock();
      d._texto = (d._texto || '') + ev.text;
      d._desde = d._desde || Date.now();
      d._hasta = Date.now();
      // el texto de la cabecera lo lleva el reloj (pensando… 12,4 s): aquí no se pisa
      scheduleThinkRender(d);
      setChatStatus('Razonando…');
      break;
    }
    case 'thinking_done': {
      if (ev.subagent) break;
      const d = pendingTurn && pendingTurn.think;
      if (!d) break;
      if (typeof ev.text === 'string' && ev.text) d._texto = ev.text;
      if (!String(d._texto || '').trim()) {
        // el modelo no razonó nada: no hay bloque
        d.remove();
        pendingTurn.think = null;
        break;
      }
      const ms = d._desde && d._hasta ? d._hasta - d._desde : Number(ev.durationMs) || 0;
      d._terminado = true; // para el reloj
      d._ms = ms;
      metaRazonamiento(d);
      // SÍNCRONO a propósito: es el cierre del bloque (ver scheduleThinkRender)
      thinkTarget = null;
      pintarRazonamiento(d);
      scroll();
      break;
    }
    // un reintento en otro modelo: lo que pensó el que falló no se mezcla con lo nuevo
    case 'thinking_reset': {
      const d = pendingTurn && pendingTurn.think;
      if (d) {
        d.remove();
        pendingTurn.think = null;
      }
      break;
    }
    // cada llamada a herramienta abre su propia tarjeta con argumentos y estado
    case 'tool':
      freezeStream(); // la narración hasta aquí queda encima de esta tarjeta
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
    // arranque de una delegación: se pinta en el tablero del equipo al instante
    case 'delegate_start':
      freezeStream(); // igual que con herramientas: intercalado cronológico
      equipoChip(ev);
      setChatStatus(etiquetaEquipo(ev) + ' — trabajando…');
      feed(etiquetaEquipo(ev), 'pur');
      break;
    // v2.6: el modelo actualizó su lista de tareas: se repinta el estado real
    case 'todos':
      todosCard(ev);
      break;
    // cierre de una delegación: la tarjeta del subagente con su estado y su evidencia
    case 'delegate_done':
      delegationCard(ev);
      equipoCierra(ev);
      agentStop();
      feed(
        ((K.subagent(ev.subagent) || {}).label || 'Subagente') +
          ' — ' +
          (String(ev.status || 'OK').toUpperCase() === 'FAILED' ? 'falló' : 'terminó'),
        String(ev.status || '').toUpperCase() === 'FAILED' ? 'err' : 'ok',
      );
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
      img.src = ev.dataUrl;
      img.className = 'shot';
      pinImage(img);
      b.appendChild(img);
      scroll();
      break;
    }
    /* v2.5: el turno ha tocado archivos y se pueden deshacer. Se ofrece AHÍ, justo
       encima del compositor, que es donde el usuario está mirando cuando decide volver
       atrás; desaparece al enviar el mensaje siguiente (el turno nuevo empieza con su
       propia pre-imagen) y al deshacer. */
    case 'can_undo': {
      mostrarDeshacer(ev.files);
      break;
    }
    case 'assistant_done': {
      finishAssistant(ev.text);
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      setChatStatus('Listo · ' + lastTurnLabel(), 'done');
      feed('Respuesta lista', 'cy');
      if (devMode) paintMeta();
      break;
    }
    case 'guardrail':
      toolChip('Límite de seguridad — ' + ev.reason.slice(0, 100), 'err');
      feed('Límite de seguridad', 'err');
      showToast(ev.reason);
      break;
    /* v2.5: el contexto se está llenando. No es un error —el turno sigue y se sueltan
       bloques antiguos del envío— pero conviene saberlo: la respuesta se vuelve más
       corta y, si el turno va muy largo, lo que toca es empezar una conversación nueva. */
    case 'contexto': {
      const pct = Math.round((ev.uso || 0) * 100);
      const aprox = ev.tokens ? ' (~' + Math.round(ev.tokens / 1000) + 'k de ' + Math.round((ev.ventana || 0) / 1000) + 'k tokens)' : '';
      feed('Contexto al ' + pct + '%' + aprox + ': se sueltan los bloques más antiguos del envío (la conversación se conserva)', 'pur');
      break;
    }
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
      feed(ev.note || 'Tarea: ' + ev.status, 'blu');
      if ($('#view-tasks').classList.contains('on')) renderTasks();
      break;
    case 'confirm_request':
      showConfirm(ev);
      break;
    case 'busy':
      busy = ev.busy;
      setSendMode();
      syncChatBadge();
      // el rail cuenta el estado real del turno, no sólo los agentes de herramienta
      updateAgentCount();
      if (busy) {
        currentRunMode = K.mode(ev.mode || mode).key;
        applyModeTheme(currentRunMode);
        setChatStatus(K.mode(currentRunMode).tagline);
        feed('Sagitari está trabajando · ' + K.mode(currentRunMode).label, 'blu');
        if (devMode) paintMeta(); // métricas del turno que arranca, no las del anterior
      } else {
        // terminó la ejecución: el color vuelve al modo que tengas elegido
        applyModeTheme(mode);
        agentStop(); // sin ejecución no queda ningún agente vivo
        // Un corte por guardarraíl sale del bucle SIN respuesta final, así que el
        // turno quedaba abierto: la respuesta siguiente se escribía DENTRO de la
        // burbuja anterior (encima de la pregunta recién enviada) y el turno se
        // quedaba sin pie de acciones. Aquí ya no hay ejecución: se cierra.
        if (pendingAssistant) finishAssistant('', { interrupted: true, failed: true });
        if (devMode) paintMeta();
        refreshAgentsPanels();
        if (!currentConfirm || !(currentConfirm.runId || currentConfirm.member)) hideConfirm();
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
        const target = hadTurn && lastAssistantEl ? lastAssistantEl : bubble('ai');
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
        reintentar.onclick = () => {
          window.sagitari.retryChat();
        };
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

function glowOffSoon() {
  setTimeout(() => window.sagitari.glow('off'), 2600);
}

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
  /* El permiso es de QUIEN lo pide: un compañero del equipo lleva su `member`, así que se
     cuenta en su insignia de pendientes (puede estar esperando mientras otro trabaja); el
     líder no lleva `member` y no tiene insignia que sumar. */
  if (ev.member) equipoPermiso(ev.convId || hiloActual(), ev.member, +1);
  if (confirmQueue.length > 1) feed('Confirmación en cola (' + confirmQueue.length + ' pendientes): ' + ev.tool, 'blu');
  paintConfirm();
}

/** Pinta la confirmación que toca (la primera de la cola) o esconde la barra. */
function paintConfirm() {
  const bar = $('#confirmBar');
  const ev = confirmQueue[0];
  currentConfirm = ev || null;
  if (!ev) {
    if (bar) bar.hidden = true;
    return;
  }
  const who = ev.runId ? ' (tarea en segundo plano)' : '';
  // con varias esperando se dice cuál se está viendo: «1 de 3»
  const prog = confirmQueue.length > 1 ? ' · 1 de ' + confirmQueue.length : '';
  /* El LITERAL manda: el comando, la ruta o la URL exactos. Antes sólo aparecía
     en un `small` de 12 px recortado a 240 caracteres y 3 líneas, mientras lo que
     el ojo leía primero era la descripción genérica («Ejecutar comando en la
     terminal»), que nunca dice QUÉ va a pasar en tu equipo. */
  const literal = ev.summary ? String(ev.summary) : '';
  const cmd = $('#confirmCmd');
  if (cmd) {
    cmd.textContent = literal;
    cmd.title = literal; // el literal completo, aunque la caja tenga tope de alto
  }
  $('#confirmTitle').textContent =
    (quienPidePermiso(ev) ? quienPidePermiso(ev) + ' quiere: ' : 'El agente quiere: ') + (ev.description || ev.tool) + who + prog;
  // el detalle dice con qué herramienta se hace: nunca queda vacío
  $('#confirmDetail').textContent = ev.tool ? 'Herramienta: ' + ev.tool : '';
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
  feed('Esperando tu confirmación: ' + (literal || ev.tool), 'blu');
}

/* Quién pide el permiso, dicho para la barra: el compañero del equipo por su nombre, y el
   líder cuando el turno trae equipo pero el permiso no es de ningún miembro. Sin equipo,
   null: la barra se queda con el texto de siempre. */
function quienPidePermiso(ev) {
  if (!ev) return null;
  const convId = ev.convId || hiloActual();
  if (ev.member) {
    const f = equipoFicha(convId, ev.member);
    return (f && f.name) || ev.memberName || ev.member;
  }
  const e = equipoDe(convId, false);
  return e && e.estado === 'vivo' ? 'el líder del equipo' : null;
}

/* El permiso ya no está pendiente: se descuenta de la insignia de su compañero. Se llama en
   las DOS salidas —contestado o descartado al terminar el turno—: una cuenta que sólo
   bajara por un camino acabaría mintiendo. */
function permisoResuelto(ev) {
  if (ev && ev.member) equipoPermiso(ev.convId || hiloActual(), ev.member, -1);
}

function hideConfirm() {
  // la que estaba a la vista ya no puede responderse (el turno acabó): se
  // descarta y, si quedaban más esperando, se muestra la siguiente
  if (currentConfirm && confirmQueue[0] === currentConfirm) {
    confirmQueue.shift();
    permisoResuelto(currentConfirm);
  }
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
  /* La confirmación es de la conversación que la pidió: puede ser una pestaña que no está a
     la vista (su turno espera una respuesta), así que se responde por SU id. Los argumentos
     van en el orden del puente (`convId, id, approved, runId`): con el orden cambiado no
     casaba ninguna confirmación y «Permitir» no reanudaba la herramienta. */
  if (c) {
    await window.sagitari.secResolve(c.convId || hiloActual(), c.id, allow, c.runId);
    permisoResuelto(c);
  }
}
$('#confirmOk').onclick = () => resolveConfirm(true);
$('#confirmNo').onclick = () => resolveConfirm(false);
// Escape deniega siempre; Enter sólo confirma con el foco dentro de la barra
// (si no, escribir en el chat dispararía la confirmación sin querer).
document.addEventListener('keydown', (e) => {
  const bar = $('#confirmBar');
  if (!bar || bar.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    resolveConfirm(false);
    return;
  }
  if (e.key === 'Enter' && document.activeElement !== bar && bar.contains(document.activeElement)) {
    e.preventDefault();
    resolveConfirm(true);
  }
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
       renderMemoria, renderSkills…), lo que arrancaba la barra del DOM sin pasar
       por finish(): la promesa quedaba pendiente para siempre (el botón que la
       espera, disabled) y el listener de teclado, vivo. El observador la cierra
       como cancelada en cuanto deja de estar conectada. */
    const mo = new MutationObserver(() => {
      if (!bar.isConnected) finish(false);
    });
    const finish = (v) => {
      if (done) return; // una barra se resuelve UNA vez
      done = true;
      mo.disconnect();
      document.removeEventListener('keydown', onKey, true);
      bar.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
      // Enter sólo confirma con el foco en un BOTÓN de la barra (no en la barra,
      // que ahora es la que recibe el foco al abrirse): si el usuario se ha ido a
      // escribir, o acaba de aparecer la tarjeta, Enter no borra nada
      else if (e.key === 'Enter' && document.activeElement !== bar && bar.contains(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
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

/* devMode se reasigna desde 30-ajustes.js (dos veces): tiene que ser let.
   ESLint no ve la reasignación entre ficheros. */
// eslint-disable-next-line prefer-const
let devMode = false;
async function paintMeta() {
  const line = $('#devMeta');
  if (!line) return;
  if (!devMode) {
    line.hidden = true;
    return;
  }
  try {
    const m = await window.sagitari.metaGet();
    const r = m.run || {};
    const gr = m.guardrails || {};
    line.hidden = false;
    line.textContent =
      (m.model || '—') +
      ' · turno: ' +
      (r.tokensIn || 0) +
      ' in / ' +
      (r.tokensOut || 0) +
      ' out tok · ' +
      (r.llmCalls || 0) +
      ' llamadas · ' +
      (r.toolCalls || 0) +
      ' herramientas · ' +
      (r.lastLatencyMs || 0) +
      ' ms' +
      ' · límites: ' +
      (gr.maxSteps || '∞') +
      ' pasos / ' +
      (gr.maxDurationMs ? Math.round(gr.maxDurationMs / 60000) + ' min' : '∞') +
      ' / silencio ' +
      ((CFG.settings.llmTimeoutMs ?? 120000) ? Math.round((CFG.settings.llmTimeoutMs ?? 120000) / 1000) + ' s' : '∞');
  } catch {
    line.hidden = true;
  }
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
  // La pausa solo existe mientras hay un turno que pausar: un control que no
  // puede hacer nada en reposo no se enseña.
  const p = $('#chatPause');
  if (p) p.hidden = !busy;
  // el hilo se anuncia como ocupado mientras el agente trabaja: los lectores de
  // pantalla esperan a que termine en vez de leer cada delta
  const m = $('#messages');
  if (m) m.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ============ sending ============
async function enviarTexto(text, atts = []) {
  goto('chat');
  // v2.5: el turno nuevo empieza su propia pre-imagen, así que el ofrecimiento de
  // deshacer el anterior ya no aplica
  ocultarDeshacer();
  // el turno del usuario queda sellado con el modo con el que se envió: en el
  // historial se ve de un vistazo qué respondió cada modo
  currentRunMode = K.mode(mode).key;
  dayStamp(); // si el hilo cruza la medianoche, el separador sale con la pregunta
  const b = bubble('user', { mode: currentRunMode });
  b.textContent = text;
  // los adjuntos se ven en la burbuja (miniaturas y nombres), no solo en el texto
  const visAtts = atts.filter((a) => (a.kind === 'image' ? a.dataUrl : true));
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
    const r = await window.sagitari.sendChat(hiloActual(), text, null, atts);
    if (r && r.ok === false) throw new Error(r.error || 'no se pudo enviar');
  } catch (e) {
    busy = false;
    setSendMode();
    syncChatBadge();
    showToast('No se pudo enviar: ' + ((e && e.message) || e));
  }
}

async function sendFrom(elId) {
  const el = $(elId);
  // Mientras el agente trabaja, el botón es «Detener»: debe funcionar aunque el
  // campo esté vacío (lo habitual, porque el texto se limpió al enviarlo).
  // Por eso este caso va ANTES de la comprobación de texto vacío.
  if (busy) {
    window.sagitari.stopChat();
    feed('Deteniendo…', 'err');
    return;
  }
  const text = el.value.trim();
  const atts = pendingAttachments.slice();
  if (!text && !atts.length) return;
  /* Órdenes de barra (`/cost`, `/compact`…): NO son mensajes. Se despachan al proceso
     principal —que es quien tiene el gasto y el contexto— y su salida va a una línea de
     sistema del hilo. Antes el renderer no las miraba y viajaban como mensaje normal al
     modelo, gastando un turno y guardándose «/cost» en el historial. */
  const cmd = K.parseCommand(text);
  if (cmd) {
    el.value = '';
    el.style.height = '';
    clearAttachments();
    await despacharOrden(cmd);
    return;
  }
  el.value = '';
  el.style.height = '';
  clearAttachments();
  await enviarTexto(text, atts);
}

/** Despacha una orden de barra al proceso principal y deja su resultado (o el motivo del
    fallo) como línea de sistema en el hilo. El registro de órdenes es el de ChatKit
    (`K.parseCommand`): la paleta «/» y esta ruta despachan la MISMA lista. */
async function despacharOrden(cmd) {
  const nombre = '/' + cmd.name + (cmd.args ? ' ' + cmd.args : '');
  /* `/new` arranca una conversación nueva —lo mismo que el botón «+»— y `/help` lo
     contesta el propio renderer con la lista de ChatKit, la MISMA que pinta la paleta al
     escribir «/»: no hace falta cruzar el IPC para repetirla ni puede contradecirse con
     lo que se ve. */
  if (cmd.name === 'new') {
    await newConversation();
    sysline('Conversación nueva. La anterior queda guardada en el historial.');
    return;
  }
  if (cmd.name === 'help') {
    sysline('Órdenes: ' + K.COMMANDS.map((c) => '/' + c.name + (c.args ? ' ' + c.args : '') + ' — ' + c.descripcion).join(' · '));
    return;
  }
  /* La orden cruza el IPC y algunas tardan (un `/compact` llama al modelo: segundos).
     Su línea es de la conversación que estaba a la vista al pedirla; si mientras se
     esperaba el usuario abrió otra, el resultado se quedaría y no se pinta en el hilo
     que ahora ocupa `#messages`, que es de otra conversación. */
  const conv = hiloActual();
  const enHilo = (texto) => {
    if (hiloActual() !== conv) return;
    sysline(texto);
  };
  try {
    const r = await window.sagitari.chatCommand(conv, cmd.name, cmd.args);
    if (r && r.ok === false) enHilo('No se pudo «' + nombre + '»: ' + (r.error || 'orden no disponible'));
    else enHilo((r && r.text) || 'Hecho.');
  } catch (e) {
    enHilo('No se pudo «' + nombre + '»: ' + ((e && e.message) || e));
  }
}

// ============ adjuntos: archivos, documentos e imágenes ============
const MAX_ATTACHMENTS = 8;
let pendingAttachments = []; // { name, kind: 'image'|'text'|'binary', size, dataUrl?, text?, note? }

function renderAttachStrip() {
  const strip = $('#attachStrip');
  if (!pendingAttachments.length) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  strip.innerHTML = '';
  for (const a of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'atchip' + (a.kind === 'image' ? ' img' : a.kind === 'binary' ? ' bin' : '');
    if (a.kind === 'image' && a.dataUrl) {
      const im = document.createElement('img');
      im.src = a.dataUrl;
      im.alt = '';
      chip.appendChild(im);
    } else {
      const icn = document.createElement('span');
      icn.className = 'ic';
      icn.innerHTML = ic(a.kind === 'binary' ? 'file' : 'doc');
      chip.appendChild(icn);
    }
    const meta = document.createElement('span');
    meta.className = 'nm';
    meta.textContent = a.name + (a.kind === 'binary' && a.note ? ' · ' + a.note : '');
    meta.title = a.name + ' · ' + (a.size ? Math.round(a.size / 1024) + ' KB' : '');
    chip.appendChild(meta);
    const x = document.createElement('button');
    x.className = 'rm';
    x.title = 'Quitar';
    x.innerHTML = ic('x');
    x.onclick = () => {
      pendingAttachments = pendingAttachments.filter((p) => p !== a);
      renderAttachStrip();
    };
    chip.appendChild(x);
    strip.appendChild(chip);
  }
}
function clearAttachments() {
  pendingAttachments = [];
  renderAttachStrip();
}

/* Miniaturas de los adjuntos dentro de la burbuja del usuario (en vivo y al
   recargar el historial). Solo visual: el contenido real ya viajó al modelo. */
function paintAttachments(bubbleEl, atts) {
  const box = document.createElement('div');
  box.className = 'msg-atts';
  for (const a of atts || []) {
    if (a.kind === 'image' && a.dataUrl) {
      const im = document.createElement('img');
      im.src = a.dataUrl;
      im.alt = a.name;
      im.className = 'msg-att-img';
      pinImage(im); // la miniatura carga tarde: reajusta el final si seguías el hilo
      im.onclick = () => window.sagitari.openExternal && /^https?:/.test(a.dataUrl) && window.sagitari.openExternal(a.dataUrl);
      box.appendChild(im);
    } else {
      const chip = document.createElement('span');
      chip.className = 'msg-att-file' + (a.kind === 'binary' ? ' bin' : '');
      chip.innerHTML =
        ic(a.kind === 'binary' ? 'file' : 'doc') + `<b></b><small>${a.size ? Math.round(a.size / 1024) + ' KB' : ''}</small>`;
      chip.querySelector('b').textContent = a.name;
      box.appendChild(chip);
    }
  }
  bubbleEl.appendChild(box);
}

async function addAttachmentPath(p) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`);
    return;
  }
  const r = await window.sagitari.attachmentsRead(p);
  if (!r || !r.ok) {
    showToast('No se pudo leer: ' + ((r && r.error) || 'error desconocido'));
    return;
  }
  if (pendingAttachments.some((a) => a.name === r.att.name && a.size === r.att.size)) return; // ya está
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
    if (f.path) return f.path; // versiones antiguas / objetos ya resueltos
    return (window.sagitari.filePath && window.sagitari.filePath(f)) || '';
  } catch {
    return '';
  }
}

async function addAttachmentFiles(files) {
  const list = [...(files || [])];
  const room = MAX_ATTACHMENTS - pendingAttachments.length;
  if (room <= 0) {
    showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`);
    return;
  }
  // recorta al hueco REAL: antes cortaba a 8 y los que sobraban se perdían sin aviso
  if (list.length > room) showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`);
  for (const f of list.slice(0, room)) {
    if (f && f.path) await addAttachmentPath(f.path);
    else if (f && f.type && f.type.startsWith('image/') && f.dataUrl) {
      // imagen pegada/drag&drop desde fuera del sistema de ficheros
      if (pendingAttachments.length < MAX_ATTACHMENTS && !pendingAttachments.some((a) => a.dataUrl === f.dataUrl)) {
        pendingAttachments.push({
          name: f.name || 'imagen pegada',
          kind: 'image',
          size: Math.round((f.dataUrl.length * 3) / 4),
          dataUrl: f.dataUrl,
        });
        renderAttachStrip();
        goto('chat');
      }
    }
  }
}

$('#chatAttach').onclick = async () => {
  try {
    const paths = await window.sagitari.attachmentsPick();
    for (const p of paths || []) await addAttachmentPath(p);
  } catch (e) {
    showToast('No se pudieron adjuntar archivos: ' + ((e && e.message) || e));
  }
};

// drag & drop sobre toda la vista del chat
const chatView = $('#view-chat');
['dragover', 'dragenter'].forEach((t) =>
  chatView.addEventListener(t, (e) => {
    e.preventDefault();
    chatView.classList.add('dragging');
  }),
);
['dragleave', 'drop', 'dragend'].forEach((t) => chatView.addEventListener(t, () => chatView.classList.remove('dragging')));
chatView.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...((e.dataTransfer || {}).files || [])];
  if (files.length) addAttachmentFiles(files.map((f) => ({ path: filePathOf(f), name: f.name, type: f.type })));
  else {
    const txt = (e.dataTransfer || {}).getData('text/uri-list') || (e.dataTransfer || {}).getData('text/plain');
    if (txt && /^data:image\//.test(txt.trim())) addAttachmentFiles([{ dataUrl: txt.trim(), name: 'imagen pegada' }]);
  }
});

// pegar imágenes directamente en el compositor
$('#chatInput').addEventListener('paste', (e) => {
  const items = [...((e.clipboardData || {}).items || [])];
  const imgs = items.filter((it) => it.type && it.type.startsWith('image/'));
  if (!imgs.length) return;
  // con el cupo lleno se avisa ANTES de bloquear el pegado: un slice(0,0) se lo
  // tragaba en silencio y el usuario creía que no había funcionado
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showToast(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje`);
    return;
  }
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
  try {
    skillList = (await window.sagitari.skillsList()).filter((s) => s.enabled);
  } catch {
    skillList = [];
  }
}
function renderSkillMenu(query) {
  const q = (query || '').toLowerCase();
  /* La paleta «/» ofrece DOS cosas: las órdenes de barra (el registro de ChatKit, la misma
     lista que las despacha) y las skills instaladas. Las órdenes van primero porque son las
     que se escriben a mano; las skills, después, porque son las que se descubren. Antes sólo
     salían las skills y escribir «/compact» no ofrecía nada. */
  const ordenes = (Array.isArray(K.COMMANDS) ? K.COMMANDS : []).filter(
    (c) =>
      c &&
      (!q ||
        String(c.name || '')
          .toLowerCase()
          .includes(q) ||
        String(c.descripcion || '')
          .toLowerCase()
          .includes(q)),
  );
  const items = skillList.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
  if (!ordenes.length && !items.length) {
    skillMenu.hidden = true;
    skillMenu._items = [];
    return;
  }
  const filas = [];
  const seleccionables = [];
  const fila = (nombre, marca, etiqueta, descripcion) => {
    const i = seleccionables.length;
    seleccionables.push({ name: nombre });
    filas.push(
      `<div class="sm-item${i === skillIdx ? ' on' : ''}" data-i="${i}">
      <span class="tc-mark">${ic(marca)}</span><span class="sm-name">${esc(etiqueta)}</span><span class="sm-desc">${esc(descripcion)}</span>
    </div>`,
    );
  };
  if (ordenes.length) {
    filas.push('<div class="sm-head">ÓRDENES — escribe para filtrar</div>');
    for (const c of ordenes) fila(c.name, 'terminal', '/' + c.name, c.descripcion || '');
  }
  if (items.length) {
    filas.push('<div class="sm-head">SKILLS — escribe para filtrar</div>');
    for (const s of items) fila(s.name, 'zap', s.name, s.description || '');
  }
  skillMenu.innerHTML = filas.join('');
  skillMenu.hidden = false;
  skillMenu._items = seleccionables;
  const on = skillMenu.querySelector('.sm-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function openSkillMenu() {
  const v = $('#chatInput').value;
  // si el menú se cerró con este mismo valor, fue al elegir una skill: el foco
  // no debe reabrirlo (si no, Enter volvería a elegir en vez de enviar)
  if (v === skillMenu._for) return;
  const m = v.match(/^\/([\w-]*)\s*$/);
  if (m) {
    refreshSkillList().then(() => {
      skillIdx = skillList.length ? 0 : -1;
      renderSkillMenu(m[1]);
    }).catch((e) => console.warn('no se pudo refrescar la lista de skills:', e && e.message));
  } else closeSkillMenu();
}
function closeSkillMenu() {
  skillMenu.hidden = true;
  skillIdx = -1;
  skillMenu._for = $('#chatInput').value;
}
function chooseSkill(name) {
  const rest = $('#chatInput').value.replace(/^\/[\w-]*\s*/, '');
  $('#chatInput').value = '/' + name + (rest ? ' ' + rest : ' ');
  closeSkillMenu();
  $('#chatInput').focus();
}
$('#chatInput').addEventListener('input', openSkillMenu);
$('#chatInput').addEventListener('focus', () => {
  if ($('#chatInput').value.startsWith('/')) openSkillMenu();
});
$('#chatInput').addEventListener('keydown', (e) => {
  if (!skillMenu.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      skillIdx = (skillIdx + 1) % skillMenu._items.length;
      renderSkillMenu($('#chatInput').value.replace(/^\/[\w-]*/, ''));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      skillIdx = (skillIdx - 1 + skillMenu._items.length) % skillMenu._items.length;
      renderSkillMenu($('#chatInput').value.replace(/^\/[\w-]*/, ''));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const it = skillMenu._items[skillIdx];
      if (it) chooseSkill(it.name);
      return;
    }
    if (e.key === 'Escape') {
      closeSkillMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFrom('#chatInput');
  }
});
skillMenu.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.sm-item');
  if (!el) return;
  e.preventDefault();
  const it = skillMenu._items[+el.dataset.i];
  if (it) chooseSkill(it.name);
});
document.addEventListener('click', (e) => {
  if (!skillMenu.contains(e.target) && e.target.id !== 'chatInput') closeSkillMenu();
});
// sugerencias del estado vacío del chat: rellenan el compositor, no envían
$$('.ce-hint').forEach((c) =>
  c.addEventListener('click', () => {
    if (c.dataset.goto) return goto(c.dataset.goto);
    const input = $('#chatInput');
    input.value = c.dataset.fill || '';
    autoGrow(input);
    input.focus();
  }),
);

// ============ compositor ============
// Auto-ajuste de altura de los composers (también al escribir a mano)
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
$('#chatInput').addEventListener('input', () => autoGrow($('#chatInput')));

// ============ idioma: pasada única sobre el marcado estático ============
/* Aquí y no más arriba: a esta altura todos los scripts han declarado sus handlers y el
   markup de index.html está completo, así que una sola pasada deja la interfaz en el
   idioma que decidió el proceso principal antes de que nadie pinte encima. */
if (window.I18N) I18N.aplicarDOM();

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
