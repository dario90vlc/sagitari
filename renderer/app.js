'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const ic = (n, c) => window.SAGI_ICONS.icon(n, c);

let CFG = { providers: [], active: null, settings: {}, presets: [] };
let busy = false;
let pendingAssistant = null;
let pendingChipBox = null;
let listening = false;
let mode = 'act';

// ============ icon injection ============
$$('[data-i]').forEach(el => { el.innerHTML = ic(el.dataset.i); });

// ============ routing ============
$$('.navitem').forEach(b => b.addEventListener('click', () => goto(b.dataset.view)));
function goto(view) {
  $$('.navitem').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
  if (view === 'chat') $('#chatInput').focus();
  if (view === 'memory') renderMemory();
  if (view === 'skills') renderSkills();
  if (view === 'projects') window.sagitari.workspaceGet().then(w => { $('#projPath').value = w; });
  if (view === 'history') renderHistory();
}

// ============ clock + greeting ============
function tickClock() {
  const d = new Date();
  const days = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  $('#dateChip').innerHTML = `${days[d.getDay()]}. ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} · <span class="t">${hh}:${mm}</span>`;
  const h = d.getHours();
  const greet = h < 12 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  const heroEl = document.querySelector('.hero');
  if (heroEl._g !== greet) {
    heroEl.innerHTML = `${greet}, <span class="grad">${esc(CFG.settings.userName || 'usuario')}</span>`;
    heroEl._g = greet;
  }
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
    // wrapper .md: neutraliza el pre-wrap del bubble para que el HTML de bloques
    // no genere líneas fantasma entre elementos
    return '<div class="md">' + div.innerHTML + '</div>';
  }
  // fallback mínimo si marked no cargó
  return esc(text);
}

// ============ chat rendering ============
const msgs = $('#messages');
function dayStamp() {
  const d = document.createElement('div');
  d.className = 'day';
  d.textContent = 'Hoy · ' + new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  msgs.appendChild(d);
}
function bubble(role) {
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
  const b = document.createElement('div');
  b.className = 'bubble';
  m.append(av, b);
  msgs.appendChild(m);
  scroll();
  return b;
}
function scroll() { msgs.scrollTop = msgs.scrollHeight; }

function ensureAssistantBubble() {
  if (!pendingAssistant) {
    dayStamp();
    pendingAssistant = bubble('ai');
    pendingChipBox = null;
  }
  return pendingAssistant;
}
function toolChip(text, state) {
  const b = ensureAssistantBubble();
  if (!pendingChipBox) {
    pendingChipBox = document.createElement('div');
    pendingChipBox.className = 'chip-run';
    b.appendChild(pendingChipBox);
  }
  const c = document.createElement('div');
  c.className = 'toolchip' + (state ? ' ' + state : '');
  const mark = state === 'done' ? ic('check') : state === 'err' ? ic('alert') : '<span class="pulse-dot"></span>';
  c.innerHTML = `<span class="tc-mark">${mark}</span><span class="tc-txt">${esc(text)}</span>`;
  pendingChipBox.appendChild(c);
  scroll();
}
function finishAssistant(finalText) {
  if (!pendingAssistant) return;
  const stream = pendingAssistant.querySelector('.stream');
  if (finalText) {
    if (stream) stream.remove();
    const div = document.createElement('div');
    div.innerHTML = fmt(finalText);
    pendingAssistant.appendChild(div);
  }
  pendingAssistant = null; pendingChipBox = null;
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

// ============ agent events ============
window.sagitari.onAgentEvent((ev) => {
  switch (ev.type) {
    case 'delta': {
      const b = ensureAssistantBubble();
      b._stream = (b._stream || '') + ev.text;
      const old = b.querySelector('.stream');
      if (old) old.remove();
      const s = document.createElement('div');
      s.className = 'stream';
      s.innerHTML = fmt(b._stream);
      b.appendChild(s);
      scroll();
      break;
    }
    case 'status':
      toolChip(ev.text, 'run');
      feed(ev.text, 'pur');
      agentStartForStatus(ev.text);
      break;
    case 'tool_result':
      toolChip(ev.name + ' — ' + (ev.result || 'ok').slice(0, 110), (ev.result || '').startsWith('Error') ? 'err' : 'done');
      agentStop();
      feed(ev.name.charAt(0).toUpperCase() + ev.name.slice(1) + ' completado', 'ok');
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
      feed('Respuesta lista', 'cy');
      break;
    case 'busy':
      busy = ev.busy;
      setSendMode();
      if (busy) feed('Sagitari está trabajando', 'blu');
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

function setSendMode() {
  for (const id of ['#heroSend', '#chatSend']) {
    const b = $(id);
    b.innerHTML = ic(busy ? 'stop' : 'send');
    b.classList.toggle('stop', busy);
    b.title = busy ? 'Detener' : 'Enviar';
  }
}

// ============ sending ============
async function sendFrom(elId) {
  const el = $(elId);
  const text = el.value.trim();
  if (!text) return;
  if (busy) { window.sagitari.stopChat(); return; }
  el.value = '';
  // Inicio = SIEMPRE una conversación nueva, sin enlazar con la actual
  if (elId === '#heroInput') await newConversation();
  else { goto('chat'); dayStamp(); }
  const b = bubble('user');
  b.textContent = text;
  setChatTitle(text);
  window.sagitari.glow('think');
  await window.sagitari.sendChat(text, null);
}
$('#heroSend').onclick = () => sendFrom('#heroInput');
$('#chatSend').onclick = () => sendFrom('#chatInput');
$('#heroInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFrom('#heroInput'); } });

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
document.querySelectorAll('.fcard[data-fill]').forEach(c => c.addEventListener('click', () => {
  $('#heroInput').value = c.dataset.fill;
  $('#heroInput').focus();
}));
document.querySelector('.fcard[data-goto]').addEventListener('click', () => goto('agents'));

// ============ voice ============
function wireMic(btnId) {
  const btn = $(btnId);
  btn.addEventListener('click', async () => {
    if (listening) {
      listening = false; btn.classList.remove('on');
      window.sagitari.glow('off');
      await window.sagitari.voiceStop();
    } else {
      listening = true; btn.classList.add('on');
      window.sagitari.glow('listen', 'voice');
      await window.sagitari.voiceStart();
    }
  });
}
wireMic('#heroMic');
wireMic('#chatMic');

window.sagitari.onVoiceReady((k, lang) => showToast('Dictado activo (' + lang + '). Habla ahora.'));
window.sagitari.onVoice((k, text) => {
  const el = $('#view-chat').classList.contains('on') ? $('#chatInput') : $('#heroInput');
  el.value = text; el.classList.add('rec');
});
window.sagitari.onVoiceFinal((k, text) => {
  const el = $('#view-chat').classList.contains('on') ? $('#chatInput') : $('#heroInput');
  el.value = text; el.classList.remove('rec');
  setTimeout(async () => {
    if (el.value.trim()) sendFrom(el.id === '#chatInput' ? '#chatInput' : '#heroInput');
    listening = false;
    $$('.cbtn').forEach(b => b.classList.remove('on'));
    window.sagitari.glow('off');
    await window.sagitari.voiceStop();
  }, 300);
});
window.sagitari.onVoiceError((k, m) => {
  showToast('Dictado: ' + m);
  listening = false;
  $$('.cbtn').forEach(b => b.classList.remove('on'));
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
    };
    sel.dispatchEvent(new Event('change'));
  }
  renderProviderList();
  $('#swGlow').classList.toggle('on', !!CFG.settings.glowEnabled);
  $('#swTts').classList.toggle('on', !!CFG.settings.ttsEnabled);
  $('#voiceLang').value = CFG.settings.voiceLang || 'es-ES';
  $('#setUserName').value = CFG.settings.userName || '';
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
$('#btnSaveProv').onclick = async () => {
  if (!$('#pUrl').value.trim()) return smsg('Falta la Base URL.');
  await window.sagitari.saveProvider({ id: 'prov_' + Date.now().toString(36), name: $('#pName').value.trim() || 'Proveedor', baseUrl: $('#pUrl').value.trim(), apiKey: $('#pKey').value.trim(), models: [...$('#modelSel').options].map(o => o.value).filter(Boolean) });
  CFG = await window.sagitari.getConfig();
  renderProviderList();
  smsg('Proveedor guardado.');
};
$('#btnActivate').onclick = async () => {
  const baseUrl = $('#pUrl').value.trim(), model = $('#modelSel').value;
  if (!baseUrl || !model) return smsg('Detecta modelos y elige uno.');
  const vision = /(gpt-4|gpt-5|4o|vision|llava|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i.test(model);
  await window.sagitari.activateProvider({ name: $('#pName').value.trim() || 'Proveedor', baseUrl, apiKey: $('#pKey').value.trim(), model, vision });
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
      await window.sagitari.activateProvider({ name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model, vision: /(gpt-4|4o|vision|llava|claude|gemini)/i.test(model) });
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
$('#setUserName').onchange = (e) => { window.sagitari.setSettings({ userName: e.target.value }); CFG.settings.userName = e.target.value; tickClock(); };

// ============ conversation history ============
let convTitle = 'Nueva conversación';
function setChatTitle(t) { convTitle = t || 'Nueva conversación'; $('#chatTitle').textContent = convTitle; }

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
  msgs.innerHTML = '';
  dayStamp();
  pendingAssistant = null; pendingChipBox = null;
  for (const m of r.messages) {
    const b = bubble(m.role);
    b.innerHTML = fmt(m.content);
  }
  setChatTitle((r.messages.find(m => m.role === 'user') || {}).content || 'Nueva conversación');
  goto('chat');
  feed('Conversación restaurada', 'blu');
}

async function newConversation() {
  await window.sagitari.convNew();
  msgs.innerHTML = '';
  dayStamp();
  pendingAssistant = null; pendingChipBox = null;
  setChatTitle('Nueva conversación');
  goto('chat');
  $('#chatInput').focus();
}
$('#btnClear').onclick = newConversation;
$('#histNew').onclick = newConversation;
$('#btnGoHistory').onclick = () => goto('history');

// ============ mode switcher ============
const MODE_META = { act: { dot: 'ok', label: 'ACT', desc: 'Ejecución directa' }, plan: { dot: 'pur', label: 'PLAN', desc: 'Planifica y ejecuta' }, think: { dot: 'blu', label: 'THINK', desc: 'Razonamiento profundo' } };
function updateModeUI() {
  const m = MODE_META[mode] || MODE_META.act;
  const pill = $('#modePill');
  pill.innerHTML = `<span class="dot ${m.dot}"></span> ${m.label}`;
  $('#modeLabel').innerHTML = `Modo <b>${m.label}</b> — ${m.desc}`;
}
$('#modePill').onclick = async () => {
  mode = await window.sagitari.setMode(mode === 'act' ? 'plan' : mode === 'plan' ? 'think' : 'act');
  updateModeUI();
  showToast('Modo ' + (MODE_META[mode] || MODE_META.act).label);
};

// ============ memory view ============
async function renderMemory() {
  const list = await window.sagitari.memoryList();
  const box = $('#memList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="subnote">Sin recuerdos aún. Añade uno arriba o pídele a Sagitari que recuerde algo.</div>'; return; }
  for (const m of list) {
    const it = document.createElement('div');
    it.className = 'memitem';
    it.innerHTML = `<span class="mt">${esc(m.text)}</span><span class="md">${new Date(m.date).toLocaleDateString('es')}</span><button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
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
      <span class="mt"><b>${esc(s.name)}</b>${s.version ? ` <span class="md">v${esc(s.version)}</span>` : ''}<br><small class="md">${esc(s.description)}</small></span>
      <span class="md">~${Math.ceil(s.bodyChars / 4)} tok</span>
      <button class="btn ghost sq" data-view title="Ver skill">${ic('search')}</button>
      <label class="sw ${s.enabled ? 'on' : ''}" data-sw title="Activar/desactivar"></label>
      <button class="btn ghost sq danger" data-del title="Eliminar">${ic('trash')}</button>`;
    it.querySelector('[data-sw]').onclick = async (e) => { await window.sagitari.skillsToggle(s.id, !s.enabled); renderSkills(); };
    it.querySelector('[data-del]').onclick = async () => { await window.sagitari.skillsDelete(s.id); renderSkills(); };
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
  if (clean) window.sagitari.speak(clean);
}
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
}

// ============ frame glow: estados del agente en el marco de la app ============
const shellEl = document.getElementById('shell');
let frameGlowTimer = null;
window.sagitari.onGlow(({ mode }) => {
  ['think', 'work', 'listen', 'speak', 'pulse'].forEach(m => shellEl.classList.remove('glow-' + m));
  clearTimeout(frameGlowTimer);
  if (mode === 'off') {
    // vuelve al resplandor interior calmado por defecto
    ['--gc', '--g1', '--g2', '--g3', '--g4', '--gborder'].forEach(v => shellEl.style.removeProperty(v));
    return;
  }
  // paleta violeta ↔ turquesa: cada estado sesga la mezcla hacia un extremo
  const V = '139,92,246', V2 = '167,139,250', T = '34,211,238', T2 = '45,212,191', C = '196,181,253', W = '255,255,255';
  const map = {
    think:  { core: `rgba(${W},0.55)`, g1: `rgba(${V},0.60)`, g2: `rgba(${V2},0.45)`, g3: `rgba(${T},0.24)`, g4: `rgba(${V},0.16)`, border: `rgba(${C},0.55)`, anim: 'think' },
    work:   { core: `rgba(${W},0.50)`, g1: `rgba(${T},0.55)`, g2: `rgba(${T2},0.42)`, g3: `rgba(${V},0.24)`, g4: `rgba(${T},0.16)`, border: `rgba(${T},0.50)`, anim: 'work' },
    listen: { core: `rgba(${W},0.50)`, g1: `rgba(${V},0.66)`, g2: `rgba(${V2},0.50)`, g3: `rgba(${V},0.28)`, g4: `rgba(${T},0.14)`, border: `rgba(${C},0.60)`, anim: 'listen' },
    speak:  { core: `rgba(${W},0.55)`, g1: `rgba(${T},0.60)`, g2: `rgba(${T2},0.45)`, g3: `rgba(${V},0.26)`, g4: `rgba(${T},0.16)`, border: `rgba(${T},0.55)`, anim: 'speak' },
    pulse:  { core: `rgba(${W},0.60)`, g1: `rgba(${T2},0.70)`, g2: `rgba(${T},0.50)`, g3: `rgba(${V},0.30)`, g4: `rgba(${T},0.20)`, border: `rgba(${T},0.70)`, anim: 'work' }
  };
  const c = map[mode] || map.think;
  shellEl.style.setProperty('--gc', c.core);
  shellEl.style.setProperty('--g1', c.g1);
  shellEl.style.setProperty('--g2', c.g2);
  shellEl.style.setProperty('--g3', c.g3);
  shellEl.style.setProperty('--g4', c.g4);
  shellEl.style.setProperty('--gborder', c.border);
  shellEl.classList.add('glow-' + c.anim);
  if (mode === 'pulse') frameGlowTimer = setTimeout(() => shellEl.classList.remove('glow-work'), 2600);
});

// ============ init ============
(async function init() {
  await fillSettings();
  setSendMode();
  dayStamp();
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
      if (r.ok && r.messages.length) {
        for (const m of r.messages) { const b = bubble(m.role); b.innerHTML = fmt(m.content); }
        setChatTitle((r.messages.find(m => m.role === 'user') || {}).content || 'Nueva conversación');
      }
    }
  } catch {}
})();
