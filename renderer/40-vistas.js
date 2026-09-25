/* SAGITARI renderer — 40-vistas.js (antes app.js 4115-5258): conversaciones, modos, memoria, tareas, TTS, menús, tema y arranque init()
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
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
  stampDia = null;   // una conversación nueva vuelve a estampar su día
  setChatStatus('');
  const list = messages || [];
  if (!list.length) { showEmpty(); pinned = true; scroll(true); return; }
  hideEmpty();
  for (const m of list) {
    // separador de día REAL al restaurar: sale al empezar y cada vez que el hilo salta de
    // día, con la fecha de los mensajes (antes se estampaba «Hoy · <hora actual>» arriba
    // aunque la conversación fuera de la semana pasada)
    dayStamp(m.ts);
    const b = bubble(m.role, { mode: m.mode, ts: m.ts });
    // el contenido guardado lleva el texto de los adjuntos incrustado: lo
    // escondemos de la burbuja y enseñamos solo las miniaturas/nombres
    let html = (typeof m.content === 'string') ? m.content : '';
    if (m.attachments && m.attachments.length) {
      html = html.replace(/He adjuntado archivos para que los uses en tu respuesta:\n\n[\s\S]*$/, '').trim();
    }
    const tieneTraza = m.role === 'assistant' && m.trace
      && (((m.trace.tools || []).length) || (m.trace.think && m.trace.think.text) || ((m.trace.todos || []).length));
    if (tieneTraza) restaurarTraza(b, m.trace, html);   // razonamiento + herramientas + respuesta
    else b.innerHTML = fmt(html || '');
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
    if (!t) return;
    // el razonamiento no forma parte de la conversación: se copia la respuesta
    const copia = t.cloneNode(true);
    copia.querySelectorAll('.thinkblock').forEach(x => x.remove());
    parts.push(`## ${who}${badge ? ' · ' + badge.textContent.trim() : ''}\n${copia.innerText.trim()}`);
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
      <input type="range" min="0" max="100" value="${imp}" data-imp class="glowslider compact" title="Importancia" aria-label="Importancia" />
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    const rangoImp = it.querySelector('[data-imp]');
    pintarFill(rangoImp);
    rangoImp.oninput = (e) => pintarFill(e.target);          // el relleno sigue el arrastre
    rangoImp.onchange = async (e) => {
      pintarFill(e.target);
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
    const inst = await skillsImportConfirmed(repo, (t) => { msg.textContent = t; });
    if (!inst) return;   // previa a la vista: el segundo clic instala (el botón se reactiva en finally)
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
function speak(text, { forzar = false, encolar = false } = {}) {
  if ((!forzar && !CFG.settings.ttsEnabled) || !text) return;
  const clean = text.replace(/```[\s\S]*?```/g, ' (código) ').replace(/[*_`#>«»]/g, '').replace(/\s+/g, ' ').trim();
  if (clean) {
    window.sagitari.glow('speak');            // el marco late mientras habla
    /* El `forzar` viaja al proceso principal: es él quien conoce el ajuste del TTS y el
       silencio de los arranques de prueba, y quien decide si esta lectura sale.
       `encolar` es lo que permite leer la respuesta por frases SIN cortar la que está
       sonando: con la cola, la lectura avanza sola mientras el modelo sigue escribiendo. */
    window.sagitari.speak(clean, { forzar, encolar });
  }
}

/* ---- La respuesta se lee MIENTRAS se escribe --------------------------------------
   Antes la voz salía entera al terminar el turno (`assistant_done`): en un turno con
   herramientas eso eran decenas de segundos de silencio y luego un monólogo — nada que ver
   con los modos de voz de los asistentes, donde el asistente empieza a hablar en cuanto
   tiene la primera frase. Aquí cada trozo del stream se manda frase a frase.

   El estado de la lectura es POR TURNO: `lecturaLeida` son los caracteres del stream ya
   mandados a la voz, `lecturaSuena` distingue la primera frase (que sí corta la lectura
   anterior, de otro turno) de las siguientes (que se encolan), y `lecturaMuda` apaga el
   resto del turno cuando el usuario interrumpe. */
let lecturaLeida = 0;
let lecturaSuena = false;
let lecturaMuda = false;
function reiniciarLecturaVoz() { lecturaLeida = 0; lecturaSuena = false; lecturaMuda = false; }
function silenciarLecturaVoz() { lecturaMuda = true; }

/* El troceado (fin de frase sin partir decimales, saltos de línea, código fuera) vive en
   renderer/frases.js: es la pieza delicada de esta lectura y así se puede probar desde
   Node, sin navegador. */
const FRASES = window.SagiFrases || { corteDeFrase: () => 0, limpiarParaVoz: (t) => String(t || ''), diceAlgo: () => false };

/* Manda a la voz lo que ya esté completo. `fin` = la respuesta terminó: entonces también
   va la cola sin punto (una frase suelta al final se lee, no se pierde). */
function hablarEnFlujo(texto, fin) {
  if (lecturaMuda) return;
  const bruto = String(texto || '');
  if (!bruto) return;
  /* El stream puede ACORTARSE: en modo Plan el texto del plan se pinta como tarjeta y sale
     del stream. Ahí no se relee nada (se saltan los caracteres que ya no existen) — el
     error contrario, repetir en voz alta lo mismo, se oiría como un tartamudeo. */
  if (bruto.length < lecturaLeida) lecturaLeida = bruto.length;
  const abierto = !!(window.VoiceMode && window.VoiceMode.abierto());
  for (;;) {
    if (lecturaMuda) return;
    const corte = FRASES.corteDeFrase(bruto.slice(lecturaLeida), fin);
    if (corte <= 0) return;
    const trozo = bruto.slice(lecturaLeida, lecturaLeida + corte);
    lecturaLeida += corte;
    const limpio = FRASES.limpiarParaVoz(trozo);
    if (!FRASES.diceAlgo(limpio)) continue;   // una línea de signos no gasta una síntesis
    speak(limpio, { forzar: abierto, encolar: lecturaSuena });
    lecturaSuena = true;
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
// el menú está anclado a un punto: si el contenedor se desplaza, el ancla se queda atrás.
// PERO el scroll que nace DENTRO del menú (rueda sobre la lista, sliders vecinos) no
// lo desancla: solo se cierra cuando se mueve algo fuera de él.
window.addEventListener('scroll', (e) => {
  if (cselAbierto && cselAbierto.menu.contains(e.target)) return;
  cselCerrar();
}, true);
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
   CSS (80+ tintes) se reconstruye solo, sin recargar nada.
   REEQUILIBRIO: acentos calmados (~20-25% menos de saturación que la era
   chillona) para que tiñan sin invadir. 'aurora' es un tema apagado: interfaz
   sobria azul-grisácea + glow multicolor en el borde
   (su aura no sale de acc2: ver applyTheme). */
const PALETTES = {
  violet:  { label: 'Violeta',   acc: [158, 146, 228], acc2: [128, 110, 214],  acc3: [84, 124, 214] },
  magenta: { label: 'Magenta',   acc: [224, 148, 206], acc2: [184, 92, 196],   acc3: [150, 108, 214] },
  cyan:    { label: 'Cian',      acc: [96, 186, 200],  acc2: [40, 146, 170],   acc3: [52, 158, 168] },
  emerald: { label: 'Esmeralda', acc: [108, 194, 156], acc2: [44, 156, 116],  acc3: [62, 184, 108] },
  amber:   { label: 'Ámbar',     acc: [232, 192, 100], acc2: [196, 128, 40],   acc3: [208, 128, 60] },
  ice:     { label: 'Hielo',     acc: [150, 190, 232], acc2: [84, 134, 214],  acc3: [66, 112, 214] },
  aurora:  { label: 'Aurora',    acc: [148, 168, 208], acc2: [106, 128, 184], acc3: [88, 148, 196] },
};
/* Aura del tema aurora: tres colores DISTINTOS a la vez — azul que manda,
   rosa que se distingue y naranja que acompaña (como Siri). */
const AURORA_GLOW = { a: [141, 159, 255], b: [255, 103, 120], c: [255, 186, 113] };
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
  if (clave === '156,138,253') {
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
  const pal = PALETTES[s.uiColor] || PALETTES.aurora;
  const gpal = (s.glowColor && s.glowColor !== 'match' && PALETTES[s.glowColor]) ? PALETTES[s.glowColor] : pal;
  const r = document.documentElement.style;
  r.setProperty('--acc-rgb', pal.acc.join(','));
  r.setProperty('--acc2-rgb', pal.acc2.join(','));
  r.setProperty('--acc3-rgb', pal.acc3.join(','));
  r.setProperty('--glow-rgb', gpal.acc2.join(','));
  // Aura tricolor: tres tonos DISTINTOS a ±42º del elegido (no vecinos), para
  // que se vean los3 colores a la vez, mezclándose entre sí
  // sin dejar de ser tu color.
  // Excepción: el tema aurora trae su propio espectro (azul→rosa→naranja).
  const auroraGlow = (s.glowColor === 'aurora') || (s.glowColor === 'match' && s.uiColor === 'aurora');
  const [gh, gs, gl] = _hsl(gpal.acc2);
  const ga = auroraGlow ? AURORA_GLOW.a : _rgb(gh + 42, Math.min(1, gs * 1.05), Math.min(.74, gl * 1.0));
  const gb = auroraGlow ? AURORA_GLOW.b : _rgb(gh, gs, gl);
  const gc = auroraGlow ? AURORA_GLOW.c : _rgb(gh - 42, Math.min(1, gs * 1.05), Math.min(.74, gl * 1.0));
  r.setProperty('--glow-a-rgb', ga.join(', '));
  r.setProperty('--glow-b-rgb', gb.join(', '));
  r.setProperty('--glow-c-rgb', gc.join(', '));
  // Por defecto el glow viene SUAVE (0.7): que acaricie el marco, no que lo invada.
  r.setProperty('--glow-str', String(Math.min(1.4, Math.max(0.4, Number(s.glowStrength) || 0.7))));
  r.setProperty('--glass', String(Math.min(1.3, Math.max(0.4, Number(s.glassTint) || 1))));
  // los fondos también son del tema: si no, el color cambia solo en los acentos
  for (const [token, valor] of Object.entries(rampaDeSuperficies(pal.acc))) r.setProperty(token, valor);
  // el espectro fluye por el borde solo con aurora
  document.getElementById('shell').classList.toggle('glow-aurora', auroraGlow);
  // refresca las muestras de color de Ajustes si están pintadas
  document.querySelectorAll('.colordot').forEach(d => { d.style.background = ''; });
}
function glowStrengthLabel(v) { return v < 0.8 ? 'Suave' : v <= 1.15 ? 'Equilibrado' : 'Intenso'; }
function glassTintLabel(v) { return v < 0.7 ? 'Ultra claro' : v <= 1.1 ? 'Equilibrado' : 'Tintado'; }
// cambios hechos desde Ajustes se aplican al vuelo (y desde main, p.ej. relanzar glow)
window.sagitari.onThemeChanged && window.sagitari.onThemeChanged(() => applyTheme());

// ============ init ============
(async function init() {
  await fillSettings();
  try { refrescarWhisperUi(); } catch {}
  try { refrescarPiperUi(); } catch {}
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

