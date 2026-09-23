/* SAGITARI renderer — 20-voz.js (antes app.js 1340-2752): feed de actividad, agentes, skills, voz, confirmaciones, envío y adjuntos
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
// ============ activity feed + live agents ============
const FEED_MAX = 6;
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
/* Importación en dos pasos: el primer clic trae la vista previa (qué skills,
   de qué repo) y el segundo confirma. Una skill son instrucciones que el
   agente obedecerá, no un texto inerte: instalar sin mirar es darle órdenes
   a un desconocido. `say` pinta el aviso donde lo vea el usuario. */
const skillImportArmed = {};   // repo -> true si ya se enseñó la previa
async function skillsImportConfirmed(repo, say) {
  const r = await window.sagitari.skillsImport(repo, skillImportArmed[repo] ? { confirm: true } : undefined);
  if (r && r.needsConfirm) {
    skillImportArmed[repo] = true;
    say('Revisa antes de instalar — ' + (r.error || 'pulsa otra vez para confirmar.'));
    return null;   // previa mostrada: el segundo clic instala
  }
  delete skillImportArmed[repo];
  return r;
}
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
        const inst = await skillsImportConfirmed(b.dataset.install, (t) => { $('#marketMsg').textContent = t; });
        if (!inst) { renderMarket(); return; }   // previa a la vista: el segundo clic confirma
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
        try {
          const inst = await skillsImportConfirmed(b.dataset.install, (t) => { $('#marketMsg').textContent = t; });
          if (!inst) { b.disabled = false; return; }   // previa a la vista: reactivar para el segundo clic
          $('#marketMsg').textContent = 'Instalado: ' + b.dataset.install; renderSkills();
        }
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
  // Actualizar es traer instrucciones nuevas de repos ajenos que el agente
  // obedecerá: no es un «update» inocuo y no se hace en silencio.
  const yes = await askConfirm($('#skillsUpdateAllBtn'), '¿Actualizar todas las skills desde sus repos?', 'Traerá instrucciones nuevas de terceros que el agente obedecerá.');
  if (!yes) return;
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
    if (!h._openText) return;   // se congeló antes del frame: no se repinta nada
    /* El segmento abierto se repinta EN SU SITIO (no se borra y re-anexa al
       final como antes): así cada tramo de narración queda donde nació, entre
       las tarjetas de herramientas que lo rodean, en orden cronológico. */
    let s = h._openEl && h._openEl.isConnected ? h._openEl : null;
    if (!s) {
      s = document.createElement('div');
      s.className = 'stream';
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
  s.className = 'stream-done';
  s.innerHTML = fmt(h._openText);
  h._frozenText = (h._frozenText || '') + (h._frozenText ? '\n\n' : '') + h._openText;
  h._openText = '';
  h._openEl = null;
}

/* ---- pasos del turno, en la franja del panel de voz --------------------------------
   El panel TAPA el chat, así que la tarjeta de herramienta —y su «completado»— se queda
   detrás: la franja de pasos es lo único que dice por dónde va el agente mientras
   trabaja. Se alimenta de los mismos eventos que ya usa el chat y con LA MISMA etiqueta
   humana (`K.tool`), para que diga lo mismo en los dos sitios. */
const PASOS_VOZ_MAX = 5;   // la franja es un estado, no un historial: sin tope, una tarea
                           // de cien herramientas la haría crecer sin fin (y sin verse)
let pasosVoz = [];

function pasoVoz(ev, ok, labelCustom) {
  const label = labelCustom || (K.tool(ev.name).label + (ev.subagent && K.subagent(ev.subagent) ? ' · ' + K.subagent(ev.subagent).label : ''));
  /* El `tool` abre el paso (queda «en curso») y el `tool_result` lo CIERRA marcándolo, en
     vez de añadir una fila nueva: el mismo trabajo saldría dos veces y, con cinco huecos,
     se comería él solo la franja. Si no hay paso abierto que cerrar —porque se recortó o
     porque el resultado llega suelto— se añade igual, para no perder el dato. */
  const ultimo = pasosVoz[pasosVoz.length - 1];
  if (ok === undefined) pasosVoz.push({ label });
  else if (ultimo && ultimo.label === label && ultimo.ok === undefined) ultimo.ok = ok;
  else pasosVoz.push({ label, ok });
  if (pasosVoz.length > PASOS_VOZ_MAX) pasosVoz = pasosVoz.slice(-PASOS_VOZ_MAX);
  if (window.VoiceMode && window.VoiceMode.abierto()) window.VoiceMode.pasos(pasosConMotor(pasosVoz));
}

/* Turno nuevo, franja nueva: lo que hizo el anterior no dice nada de este. */
function limpiarPasosVoz() {
  pasosVoz = [];
  if (window.VoiceMode && window.VoiceMode.abierto()) window.VoiceMode.pasos([]);
}

window.sagitari.onAgentEvent((ev) => {
  // v1.3: los eventos de una tarea en segundo plano NO deben tocar el chat
  // interactivo (ni sus burbujas ni el estado busy/detener): solo el feed,
  // el panel de Tareas, las confirmaciones y los avisos.
  if (ev.bg) {
    /* OJO: las tareas en segundo plano NO pintan pasos de voz. El panel tapa el chat y
       sus guiones (investigar, codificar, navegar) usan las mismas herramientas que un
       turno de voz: sin este filtro, una tarea que sigue corriendo pinta «Navegador» o
       «Captura de pantalla» en el panel mientras el usuario habla de otra cosa. */
    switch (ev.type) {
      case 'status': feed(ev.text, 'pur'); break;
      case 'tool': feed(ev.name || 'herramienta', 'pur'); break;
      case 'tool_result': feed((ev.name || '') + ' — ' + String(ev.result || 'ok').slice(0, 90), (String(ev.result || '').startsWith('Error') ? 'err' : 'ok')); break;
      case 'delegate_start':
        feed(etiquetaEquipo(ev), 'pur');
        break;
      case 'delegate_done': {
        const who = (K.subagent(ev.subagent) || {}).label || 'Subagente';
        const st = String(ev.status || 'OK').toUpperCase();
        feed(who + ' — ' + (st === 'FAILED' ? 'falló' : (st === 'PARTIAL' ? 'a medias' : 'terminó')) + (ev.result ? ': ' + String(ev.result).slice(0, 80) : ''), st === 'FAILED' ? 'err' : 'ok');
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
      /* El texto de un SUBAGENTE es trabajo interno (acaba en su RESULT/DETAILS/EVIDENCE),
         no la respuesta al usuario: si entra aquí se mezcla en la burbuja del asistente y,
         peor, la lectura por frases lo pronuncia en voz alta. Su cierre se cuenta en la
         tarjeta de la delegación (delegate_done). */
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
          b._openText = p.body;   // el segmento abierto enseña lo mismo que el stream
        }
      }
      scheduleStreamRender(b);
      /* Y en voz alta según se escribe (ver hablarEnFlujo): la respuesta empieza a sonar en
         cuanto hay una frase, sin esperar a que el turno entero termine. Se pasa la
         narración completa (tramos congelados + abierto): los offsets de lectura son
         absolutos y así no se repite nada al congelar. */
      hablarEnFlujo((b._frozenText || '') + (b._openText || ''), false);
      break;
    }
    /* Razonamiento del modelo (solo llega si el usuario lo activó en Ajustes). Se pinta
       en su bloque y NUNCA en la burbuja ni en la voz: no es la respuesta. */
    case 'thinking_delta': {
      if (ev.subagent) break;   // el de un subagente es trabajo interno (va en su tarjeta)
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
      if (!String(d._texto || '').trim()) {   // el modelo no razonó nada: no hay bloque
        d.remove();
        pendingTurn.think = null;
        break;
      }
      const ms = (d._desde && d._hasta) ? (d._hasta - d._desde) : Number(ev.durationMs) || 0;
      d._terminado = true;   // para el reloj
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
      if (d) { d.remove(); pendingTurn.think = null; }
      break;
    }
    // cada llamada a herramienta abre su propia tarjeta con argumentos y estado
    case 'tool':
      freezeStream();   // la narración hasta aquí queda encima de esta tarjeta
      toolCard(ev);
      setChatStatus(K.tool(ev.name).verb + (ev.subagent && K.subagent(ev.subagent) ? ' — ' + K.subagent(ev.subagent).label : '') + '…');
      feed(K.tool(ev.name).label + (ev.subagent ? ' · ' + K.subagent(ev.subagent).label : ''), 'pur');
      pasoVoz(ev);
      agentStart(ev.name);
      break;
    case 'status':
      setChatStatus(ev.text);
      feed(ev.text, 'pur');
      agentStartForStatus(ev.text);
      break;
    // arranque de una delegación: se pinta en el tablero del equipo al instante
    case 'delegate_start':
      freezeStream();   // igual que con herramientas: intercalado cronológico
      equipoChip(ev);
      pasoVoz({ name: 'delegate', subagent: ev.subagent }, undefined, etiquetaEquipo(ev));
      setChatStatus(etiquetaEquipo(ev) + ' — trabajando…');
      feed(etiquetaEquipo(ev), 'pur');
      break;
    // cierre de una delegación: la tarjeta del subagente con su estado y su evidencia
    case 'delegate_done':
      delegationCard(ev);
      equipoCierra(ev);
      pasoVoz({ name: 'delegate', subagent: ev.subagent }, String(ev.status || 'OK').toUpperCase() !== 'FAILED', etiquetaEquipo(ev));
      agentStop();
      feed(((K.subagent(ev.subagent) || {}).label || 'Subagente') + ' — ' + (String(ev.status || 'OK').toUpperCase() === 'FAILED' ? 'falló' : 'terminó'), String(ev.status || '').toUpperCase() === 'FAILED' ? 'err' : 'ok');
      break;
    case 'tool_result':
      completeToolCard(ev);
      agentStop();
      feed(K.tool(ev.name).label + (ev.ok === false ? ' — falló' : ' — completado'), ev.ok === false ? 'err' : 'ok');
      pasoVoz(ev, ev.ok !== false);
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
    /* v2.5: el turno ha tocado archivos y se pueden deshacer. Se ofrece AHÍ, justo
       encima del compositor, que es donde el usuario está mirando cuando decide volver
       atrás; desaparece al enviar el mensaje siguiente (el turno nuevo empieza con su
       propia pre-imagen) y al deshacer. */
    case 'can_undo': {
      mostrarDeshacer(ev.files);
      break;
    }
    case 'assistant_done': {
      /* El texto del STREAM es el que se ha estado leyendo por frases (y puede traer más
         que el markdown final): se guarda ANTES de cerrar la burbuja, porque
         `finishAssistant` suelta la referencia. Se pasa la narración completa
         (tramos congelados + abierto), no solo el tramo abierto. */
      const leidoHastaAqui = ((pendingAssistant && pendingAssistant._frozenText) ? pendingAssistant._frozenText + '\n\n' : '') + ((pendingAssistant && pendingAssistant._stream) || ev.text);
      finishAssistant(ev.text);
      busy = false;
      setSendMode();
      syncChatBadge();
      glowOffSoon();
      /* En el modo voz la respuesta se dice SIEMPRE, aunque el TTS esté apagado en
         Ajustes: es un modo de oído, y negarse a hablar ahí sería absurdo. La regla de
         los arranques automatizados sigue mandando por encima (la aplica el proceso
         principal).
         Aquí sólo queda la COLA (lo que no hubiera cerrado frase mientras se escribía). */
      hablarEnFlujo(leidoHastaAqui, true);
      /* Y además se LEE: el panel tapa el chat, así que la respuesta tiene que aparecer ahí
         también. Sin esto, con el modo voz abierto la respuesta solo se podía oír. */
      if (window.VoiceMode && window.VoiceMode.abierto()) window.VoiceMode.respuesta(ev.text);
      setChatStatus('Listo · ' + lastTurnLabel(), 'done');
      feed('Respuesta lista', 'cy');
      if (devMode) paintMeta();
      vaciarColaVoz();
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
        vaciarColaVoz();
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
      /* Parar es también CALLAR: si el usuario detuvo el turno (con el botón del panel o
         diciendo «para»), no tiene sentido que la voz siga leyendo lo que ya se generó.
         Y el panel vuelve a «escuchando»: si se quedara en «pensando», el orbe y su botón
         de parar seguirían diciendo que el agente trabaja cuando ya no hay nadie. */
      silenciarLecturaVoz();
      if (window.VoiceMode && window.VoiceMode.abierto()) {
        window.sagitari.ttsStop();
        window.VoiceMode.handle({ type: 'state', state: 'escuchando' });
      }
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

/* El panel del modo voz TAPA el chat (es opaco y se superpone al área de mensajes), así
   que la barra de confirmación de abajo queda oculta detrás: con el modo abierto el permiso
   del agente no se podía contestar —ni con el ratón ni por voz— y el turno se quedaba
   esperando hasta el timeout. Por eso la MISMA confirmación se pinta también en el panel
   mientras el modo esté abierto: los dos botones del panel y su «sí»/«no» por voz acaban
   los dos en `resolveConfirm`, que es el único sitio que responde al proceso principal.
   No hay dos caminos de respuesta: hay uno con dos puertas. */
function pedirConfirmacionEnVoz(ev) {
  if (!ev || !window.VoiceMode || !window.VoiceMode.abierto()) return;
  const texto = 'El agente quiere: ' + (ev.description || ev.tool)
    + (confirmQueue.length > 1 ? ' · 1 de ' + confirmQueue.length : '')
    + (ev.summary ? ' — ' + String(ev.summary).slice(0, 240) : '');
  window.VoiceMode.pedirConfirmacion({
    texto,
    si: () => resolveConfirm(true),
    no: () => resolveConfirm(false),
  });
}

/* Esconde la caja del panel SIN contestarla. Se llama cuando el permiso ya se ha resuelto
   por la otra puerta (la barra del chat, o el fin del turno): si la caja se quedara a la
   vista, sus botones seguirían armados y contestarían con una decisión que el usuario no
   tomó la confirmación que ahora toca (la siguiente de la cola). */
function olvidarConfirmacionEnVoz() {
  if (window.VoiceMode && window.VoiceMode.olvidarConfirmacion) window.VoiceMode.olvidarConfirmacion();
}

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
  pedirConfirmacionEnVoz(ev);
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
  // también la del panel de voz: si no, seguiría a la vista una confirmación que
  // ya no existe detrás (y al abrir el chat tapado ya no se puede contestar)
  olvidarConfirmacionEnVoz();
  if (confirmQueue.length) paintConfirm();
}
async function resolveConfirm(allow) {
  // se responde SIEMPRE a la primera de la cola, que es la que está a la vista
  const c = confirmQueue.shift() || currentConfirm;
  currentConfirm = null;
  const bar = $('#confirmBar');
  // la caja del panel se apaga ANTES de repintar: contestar por la barra del chat (o por
  // voz) tiene que quitar de enmedio la puerta que ya se usó, y si queda otra confirmación
  // en la cola, `paintConfirm` vuelve a armarla con ESA (no con la ya contestada)
  olvidarConfirmacionEnVoz();
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
/* Enviar un texto al agente por el camino de siempre. Existe aparte de sendFrom porque
   el modo voz manda texto que no viene del compositor, y tiene que recorrer EXACTAMENTE
   el mismo camino: la misma burbuja, el mismo sello de modo, el mismo estado ocupado y
   el mismo chat:send. Si hubiera dos caminos, el modo voz dejaría de heredar permisos,
   guardarraíles e historial. */
async function enviarTexto(text, atts = []) {
  goto('chat');
  // v2.5: el turno nuevo empieza su propia pre-imagen, así que el ofrecimiento de
  // deshacer el anterior ya no aplica
  ocultarDeshacer();
  // el turno del usuario queda sellado con el modo con el que se envió: en el
  // historial se ve de un vistazo qué respondió cada modo
  currentRunMode = K.mode(mode).key;
  dayStamp();   // si el hilo cruza la medianoche, el separador sale con la pregunta
  const b = bubble('user', { mode: currentRunMode });
  b.textContent = text;
  // los adjuntos se ven en la burbuja (miniaturas y nombres), no solo en el texto
  const visAtts = atts.filter(a => a.kind === 'image' ? a.dataUrl : true);
  if (visAtts.length) paintAttachments(b, visAtts);
  setChatTitle(text || (atts[0] && atts[0].name) || 'Nueva conversación');
  pinned = true;
  scroll(true);
  window.sagitari.glow('think');
  // turno nuevo: la franja de pasos del panel arranca vacía (es lo del turno que empieza)
  // y la lectura en voz alta arranca de cero (la del turno anterior ya no cuenta)
  limpiarPasosVoz();
  reiniciarLecturaVoz();
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
    voiceBuffer = ''; lastPartial = ''; vozBase = '';
    $$('.cbtn').forEach(b => b.classList.remove('on'));
    el.classList.remove('rec');
    window.sagitari.glow('off');
    await window.sagitari.voiceStop();
  }
  await enviarTexto(text, atts);
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
/* Lo que ya había escrito el usuario al empezar a dictar: el dictado se compone SOBRE
   ello. El comentario de arriba prometía no sobrescribir el input, pero la primera
   hipótesis parcial lo vaciaba y se comía el prompt a medio escribir. */
let vozBase = '';
function paintVoice(partial) {
  const el = $('#chatInput');
  const text = (vozBase + voiceBuffer + (partial || '')).trimStart();
  if (el.value !== text) { el.value = text; }
  el.classList.toggle('rec', true);
  autoGrow(el);
}
function wireMic(btnId) {
  const btn = $(btnId);
  btn.addEventListener('click', async (e) => {
    // El micro es la puerta del modo voz. Con Alt se conserva el dictado de siempre,
    // que sigue siendo lo cómodo para escribir un prompt largo y revisarlo.
    if (!e.altKey) {
      if (window.VoiceMode.abierto()) { await window.VoiceMode.cerrar(); await cerrarTapPcm(); }
      else {
        /* La lectura del chat comparte el AudioContext de la sesión, y al abrir el modo
           voz se reutiliza: sin soltar antes lo que estuviera sonando, una frase a medias
           del chat seguía colgada de un buffer source sin dueño y la primera frase del
           modo voz podía salir corrompida. Es el mismo corte que hace reproducir(). */
        if (window.VoiceMode.audio && window.VoiceMode.audio.parar) await window.VoiceMode.audio.parar();
        await window.VoiceMode.abrir();
        /* Si el agente ya está esperando permiso, la barra del chat acaba de quedar tapada
           por el panel: sin volver a armarla ahí, esta confirmación se quedaría sin poder
           contestarse hasta que el turno muriera por timeout. */
        if (currentConfirm) pedirConfirmacionEnVoz(currentConfirm);
      }
      return;
    }
    if (listening) {
      listening = false; btn.classList.remove('on');
      vozBase = '';
      window.sagitari.glow('off');
      await window.sagitari.voiceStop();
    } else {
      listening = true; btn.classList.add('on');
      voiceBuffer = ''; lastPartial = '';
      const ya = $('#chatInput').value.replace(/\s+$/, '');
      vozBase = ya ? ya + ' ' : '';
      window.sagitari.glow('listen', 'voice');
      await window.sagitari.voiceStart();
    }
  });
}
wireMic('#chatMic');

/* Modo voz: el panel es el único que sabe del modo (y su único punto de entrada es
   `handle`), así que aquí solo se le dan las tres cosas que no puede saber por sí mismo
   —por dónde se envía, por dónde se reproduce una frase y si hay que hablar los avisos—
   y se le pasa todo lo que llega del proceso principal. */
/* El turno dictado no puede salir mientras el agente trabaja: `agent.chat` lo
   rechazaría. Antes se tiraba con un aviso y la frase se perdía (el usuario veía su
   frase en el panel y el agente nunca la hacía: "transcribe pero no actúa"). Ahora se
   guarda UNA frase en cola y sale sola cuando el agente queda libre. */
let vozEnEspera = null;
function vaciarColaVoz() {
  if (vozEnEspera && !busy) { const t = vozEnEspera; vozEnEspera = null; enviarTexto(t); }
}
window.VoiceMode.setEnviar((text) => {
  if (busy) { vozEnEspera = text; window.VoiceMode.handle({ type: 'notice', text: 'Te he oído; lo envío en cuanto termine lo anterior.' }); return; }
  return enviarTexto(text);
});
window.sagitari.onVoiceEvent((ev) => {
  /* El proceso principal puede ordenar reabrir el tap (voice:rescue con whisper de
     guardia): su captura es la única fuente de audio del dictado local. */
  if (ev && ev.type === 'reabrir-tap') { reabrirTapVoz(); return; }
  window.VoiceMode.handle(ev);
  if (ev && (ev.type === 'notice' || ev.type === 'state')) actualizarEstadoMotorEscucha();
});
window.sagitari.onTtsPhrase((p) => window.VoiceMode.audio.reproducir(p));

/* ---- Tap de micrófono para el dictado local (whisper) ----
   El audio crudo (Int16 mono 16 kHz) viaja al proceso principal SOLO mientras el motor
   local está de guardia: es SU única fuente (los de Windows capturan por su cuenta).
   Va por AudioWorklet para no meter el ruido del hilo principal en la señal. Se abre y
   se cierra con la sesión del modo voz: sin panel, no hay nadie transcribiendo. */
let __tapPcm = null;
let __tapFallos = 0;
/* Float32 del micro → Int16 mono 16 kHz para whisper, con REMUESTREO.
   Antes se forzaba el AudioContext a 16 kHz y Chromium en Windows entrega SILENCIO
   con algunos micrófonos cuando se le pide una tasa que no es la del dispositivo:
   el orbe latía (ese contexto es otro) y el dictado local no recibía NI UNA muestra.
   Ahora se captura a la tasa NATIVA —la que se sabe buena— y el remuestreo lineal
   con memoria de fracción viaja aquí, sin deriva acumulada. */
function enviarPcmAlMotor(f, srOrigen, estadoPcm) {
  const srDestino = 16000;
  const comb = new Float32Array(estadoPcm.resto.length + f.length);
  comb.set(estadoPcm.resto, 0); comb.set(f, estadoPcm.resto.length);
  const fuera = [];
  while (estadoPcm.pos + 1 < comb.length) {
    const i0 = Math.floor(estadoPcm.pos), frac = estadoPcm.pos - i0;
    const v0 = comb[i0], v1 = comb[i0 + 1];
    fuera.push(Math.max(-32768, Math.min(32767, Math.round((v0 + (v1 - v0) * frac) * 32767))));
    estadoPcm.pos += RATIO_PCM(srOrigen, srDestino);
  }
  const corta = Math.floor(estadoPcm.pos);
  estadoPcm.resto = comb.slice(corta); estadoPcm.pos -= corta;
  if (!fuera.length) return;
  const b = new Int16Array(fuera.length);
  for (let i = 0; i < fuera.length; i++) b[i] = fuera[i];
  window.sagitari.voicePcm(b.buffer);
}
/* Cada muestra de SALIDA avanza pos tantas muestras de ENTRADA como dicta el cociente
   de tasas (48k→16k: 3 de entrada por cada salida). La razón invertida estiraba el
   audio 9× y Whisper transcribía la voz estirada como «[Música]» — cazado con la
   telemetría pcmMs (648 s de audio en 76 s de sesión). */
const RATIO_PCM = (srOrigen, srDestino) => srOrigen / srDestino;
async function abrirTapPcm() {
  if (__tapPcm) return;
  let stream = null, ctx = null;
  try {
    if (!window.VoiceMode || !window.VoiceMode.abierto()) return;
    if (!(await window.sagitari.voicePcmActivo())) return;
    actualizarEstadoMotorEscucha();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    /* SIN sampleRate forzado (ver enviarPcmAlMotor) y con resume: un contexto
       suspendido no procesa el grafo ni entrega un solo chunk. */
    ctx = new AudioCtx();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    const fuente = ctx.createMediaStreamSource(stream);
    /* Gain a CERO entre el tap y el destino: el nodo cuelga del grafo (Chromium lo
       procesa siempre) pero devuelve ni un mito del micro a los altavoces. Antes el
       nodo quedaba colgando solo — un grafo sin destino puede no procesarse nunca. */
    const mudo = ctx.createGain(); mudo.gain.value = 0;
    const estadoPcm = { resto: new Float32Array(0), pos: 0 };
    const enviar = (f) => enviarPcmAlMotor(f, ctx.sampleRate, estadoPcm);
    let nodo;
    try {
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([
        'class TapPCM extends AudioWorkletProcessor {' +
        '  process(inputs) {' +
        '    const ch = inputs[0] && inputs[0][0];' +
        '    if (ch) this.port.postMessage(ch.slice(0));' +
        '    return true;' +
        '  }' +
        '}' +
        'registerProcessor("tap-pcm", TapPCM);'
      ], { type: 'text/javascript' })));
      nodo = new AudioWorkletNode(ctx, 'tap-pcm');
      /* Un procesador que revienta en el hilo de audio no lanza aquí: lo cuenta y
         lo dice — sin esto, un tap muerto era un panel «Escuchando» para siempre. */
      nodo.onprocessorerror = () => { __tapFallos++; showToast('Dictado local: el capturador de audio falló; cierra y reabre el modo voz.'); };
      nodo.port.onmessage = (e) => enviar(e.data);
      fuente.connect(nodo);
    } catch (eWorklet) {
      /* Respaldo (CSP restrictiva o Chromium viejo): ScriptProcessor hace el mismo
         trabajo en el hilo principal — algo más de ruido, pero audio de verdad. */
      nodo = ctx.createScriptProcessor(1024, 1, 1);
      nodo.onaudioprocess = (ev) => { const ch = ev.inputBuffer.getChannelData(0); enviar(ch); };
      fuente.connect(nodo);
    }
    nodo.connect(mudo); mudo.connect(ctx.destination);
    __tapPcm = { stream, ctx, nodo, mudo };
    __tapFallos = 0;
  } catch (e) {
    /* ANTES este catch referenciaba variables fuera de su ámbito y moría en silencio:
       el tap moría y el panel se quedaba «Escuchando» sin una sola pista. Ahora se
       suelta SOLO lo que se llegó a adquirir y el fallo SE MUESTRA. */
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch {}
    __tapFallos++;
    showToast('Dictado local: no he podido enganchar el micrófono (' + (e && e.message ? e.message : e) + ').');
    console.error('[tap-pcm] fallo al abrir:', e);
  }
}

/* Cierra el tap: sin panel abierto no hay nadie transcribiendo, y el micro no debe
   quedar capturando para nadie. */
async function cerrarTapPcm() {
  const tap = __tapPcm; __tapPcm = null;
  if (!tap) return;
  try { tap.nodo.port.onmessage = null; } catch {}
  try { tap.nodo.onaudioprocess = null; } catch {}
  try { tap.nodo.disconnect(); } catch {}
  try { tap.mudo.disconnect(); } catch {}
  try { tap.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (tap.ctx.state !== 'closed') await tap.ctx.close(); } catch {}
}

/* El panel avisa al abrir y al cerrar (botón, Esc, «adiós»): aquí se engancha y se
   suelta el tap de micrófono del dictado local, sea cual sea la puerta. Un único dueño
   del ciclo de vida — el panel — evita dos micros abiertos por llamadas dobles. */
window.__alAbrirModoVoz = () => { abrirTapPcm(); };
window.__alCerrarModoVoz = () => { cerrarTapPcm(); };
/* Reapertura del tap (rescate del vigía u orden del proceso principal): cerrar y
   volver a enganchar la captura sin tocar la sesión del panel. */
async function reabrirTapVoz() { await cerrarTapPcm(); await abrirTapPcm(); }
window.__reabrirTap = reabrirTapVoz;
window.__tapEstado = () => !!__tapPcm;

/* Los avisos solo se hablan si el usuario lo ha pedido en Ajustes. La decisión se toma
   aquí, que es donde se conocen los ajustes; el panel solo pide que se diga.
   Y el aviso de que NO se ha podido leer no se habla nunca: lo emite el propio fallo de la
   síntesis, así que hablarlo lo realimentaría —cada vuelta pide otra síntesis, que vuelve a
   fallar y vuelve a avisar, y la app se queda girando—. Es el único aviso que se salta, y
   solo ese: los demás (p. ej. «no te he entendido») sí se dicen. */
const AVISO_SIN_VOZ = 'No he podido leer la respuesta en voz alta.';
window.VoiceMode.setHablar((t) => { if (CFG.settings.ttsNotices && t !== AVISO_SIN_VOZ) speak(t, { forzar: true }); });

/* Lo que el panel necesita saber de la app para poder parar de verdad: si el agente está
   trabajando (para reconocer «para»/«detente» como una orden sobre el turno EN CURSO) y
   por dónde pararlo (el mismo `stopChat` del botón Detener del compositor, que el panel
   tapa). Antes, con el modo voz abierto, la única forma de detener al agente era esperar. */
window.VoiceMode.setOcupado(() => busy);
window.VoiceMode.setParar(() => { feed('Deteniendo…', 'err'); window.sagitari.stopChat(); });
/* Interrupción (barge-in): lo que queda de la respuesta deja de leerse. Sin esto, callar la
   frase en curso no callaba la lectura — la siguiente frase del stream volvía a sonar. */
window.VoiceMode.setInterrumpido(() => silenciarLecturaVoz());

/* El canal manda UN dato por evento (el puente lo aplana), no un par «clave, valor»:
   estos manejadores declaraban dos parámetros y leían el segundo, así que el aviso de
   «dictado activo» decía «undefined», el del motor clásico no salía nunca (comparaba
   `undefined` con 'sapi'), las hipótesis parciales borraban el compositor —llegaban
   vacías— y lo dictado NUNCA se acumulaba: el dictado no escribía nada. */
window.sagitari.onVoiceReady((lang) => showToast('Dictado activo (' + lang + '). Habla ahora; pulsa el micro o envía para terminar.'));
// motor clásico = precisión inferior: avisar que con el reconocimiento online mejora mucho
window.sagitari.onVoiceMode((mode) => {
  if (mode === 'sapi') showToast('Motor de voz clásico activo. Activa "Reconocimiento de voz en línea" en Windows (Privacidad > Voz) para máxima precisión.');
});
window.sagitari.onVoiceHint((m) => showToast('Dictado: ' + m));
window.sagitari.onVoice((text) => { lastPartial = text ? text + ' ' : ''; paintVoice(lastPartial); });
window.sagitari.onVoiceFinal((text) => {
  if (text && text.trim()) voiceBuffer += text.trim() + ' ';
  lastPartial = '';
  paintVoice('');
});
window.sagitari.onVoiceError((m) => {
  showToast('Dictado: ' + m);
  listening = false;
  vozBase = '';
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
