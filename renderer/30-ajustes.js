/* SAGITARI renderer — 30-ajustes.js (antes app.js 2754-4113): ajustes, proveedores, seguridad, MCP, hábitos, datos, updater y acerca de
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
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
  // La lista de voces sale del motor real: si no hay ninguna, se dice, no se deja vacío.
  // Las NATURALES ya vienen primero del motor (tts.ps1 las ordena arriba) y se marcan:
  // son las voces modernas de Windows 11, que suenan a persona, frente a las de escritorio
  // (Helena y compañía), que son las robóticas que se oían antes.
  // Piper (voz local) va PRIMERO si está instalada: es la mejor que hay.
  refrescarVocesTts();

function refrescarVocesTts() {
  window.sagitari.ttsList().then((r) => {
    const sel = $('#ttsVoice');
    if (!sel) return;
    sel.innerHTML = '';
    const voces = (r && r.voices) || [];
    if (!voces.length) { const o = document.createElement('option'); o.textContent = 'Sin voces instaladas'; o.value = ''; sel.appendChild(o); return; }
    for (const v of voces) {
      const o = document.createElement('option');
      o.value = v.nombre;
      o.textContent = v.nombre + ' (' + v.idioma + (v.natural ? ' · natural' : '') + ')';
      if (CFG.settings.ttsVoice === v.nombre) o.selected = true;
      sel.appendChild(o);
    }
    /* La voz LOCAL (Piper) manda cuando está instalada: es la única neuronal del equipo y
       no depende del almacén de Windows (que en muchas máquinas sólo tiene voces de
       escritorio, las robóticas). Sólo se respeta otra voz guardada si el usuario la
       eligió a mano (`ttsVoiceFijo`): la que elige la propia app —la primera natural, la
       que se autoasigna al instalar— no puede condenar a la voz buena a no sonar nunca. */
    const local = voces.find((v) => /^piper/i.test(v.nombre));
    if (local && !CFG.settings.ttsVoiceFijo && CFG.settings.ttsVoice !== local.nombre) {
      const antesSonabaWindows = !!CFG.settings.ttsVoice;
      sel.value = local.nombre;
      CFG.settings.ttsVoice = local.nombre;
      window.sagitari.setSettings({ ttsVoice: local.nombre });
      if (antesSonabaWindows) showToast('Voz local activa: «' + local.nombre + '» suena mejor que la voz de Windows.');
    }
    /* Sin voz GUARDADA, se elige sola la primera NATURAL del idioma de voz: es la que
       suena bien. Antes el desplegable se quedaba con la primera de la lista — una voz de
       escritorio robótica — y el usuario tenía que saber que existían las naturales y
       buscarlas a mano. */
    if (!CFG.settings.ttsVoice) {
      const lang = (CFG.settings.voiceLang || 'es-ES').split('-')[0];
      const buena = voces.find(v => v.natural && (v.idioma || '').toLowerCase().startsWith(lang))
        || voces.find(v => (v.idioma || '').toLowerCase().startsWith(lang))
        || voces.find(v => v.natural);
      if (buena) {
        sel.value = buena.nombre;
        window.sagitari.setSettings({ ttsVoice: buena.nombre });
      }
    } else {
      /* La voz guardada puede haberse quedado en una de escritorio (era el default antes
         de preferir naturales): si hay una natural del idioma, se migra sola UNA vez por
         sesión. Una elección manual a otra voz de escritorio no se distingue, pero oír una
         natural siempre es mejor que oír una robótica por un default viejo. */
      const lang = (CFG.settings.voiceLang || 'es-ES').split('-')[0];
      const actual = voces.find(v => v.nombre === CFG.settings.ttsVoice);
      const natural = voces.find(v => v.natural && (v.idioma || '').toLowerCase().startsWith(lang));
      if (actual && !actual.natural && natural && !window.__migracionVozNatural) {
        window.__migracionVozNatural = true;
        sel.value = natural.nombre;
        CFG.settings.ttsVoice = natural.nombre;
        window.sagitari.setSettings({ ttsVoice: natural.nombre });
        showToast('Voz mejorada a «' + natural.nombre + '» (natural): suena mucho más humana que la anterior.');
      }
    }
    /* Sin NINGUNA voz natural para el idioma, la calidad que queda es la robótica de
       siempre: decir cómo se instalan las buenas (gratis, vienen con Windows 11) es la
       única mejora que de verdad cambia lo que oye el usuario. Una sola vez por sesión. */
      const lang2 = (CFG.settings.voiceLang || 'es-ES').split('-')[0];
      const hayNatural = voces.some(v => v.natural && (v.idioma || '').toLowerCase().startsWith(lang2));
      if (!hayNatural && !window.__avisoVocesNaturales) {
        window.__avisoVocesNaturales = true;
        showToast('Para una voz más natural: Configuración de Windows > Accesibilidad > Narrador > «Voces naturales» (descarga gratuita), y vuelve a abrir SAGITARI.');
      }
  }).catch(() => {});
}
  /* El estado visual del interruptor de avisos se pinta aquí y no solo al cablearlo: los
     ajustes llegan de disco después de que el script se ejecute, así que pintarlo al
     cablear mostraba «apagado» aunque estuviera encendido. */
  if ($('#swAvisos')) $('#swAvisos').classList.toggle('on', !!CFG.settings.ttsNotices);
  /* Motor de escucha clásico: el estado visual se pinta aquí y no solo al cablear, por la
     misma razón que el de avisos — los ajustes pueden llegar de disco después del script. */
  if ($('#swSttClasico')) $('#swSttClasico').classList.toggle('on', !!CFG.settings.sttClasico);
  $('#setUserName').value = CFG.settings.userName || '';
  // apariencia: color de interfaz, color del glow e intensidad
  $('#uiColor').value = PALETTES[CFG.settings.uiColor] ? CFG.settings.uiColor : 'aurora';
  $('#glowColor').value = (!CFG.settings.glowColor || CFG.settings.glowColor === 'match') ? 'match'
    : (PALETTES[CFG.settings.glowColor] ? CFG.settings.glowColor : 'match');
  $('#glowStrength').value = String(Math.min(1.4, Math.max(0.4, Number(CFG.settings.glowStrength) || 1)));
  $('#glassTint').value = String(Math.min(1.3, Math.max(0.4, Number(CFG.settings.glassTint) || 1)));
  pintarFill($('#glowStrength')); pintarFill($('#glassTint'));
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
/* Elegir voz a mano marca la elección como FIJA: a partir de ahí manda la del usuario y la
   app deja de preferir la voz local por su cuenta (ver `usarVozLocal` en el motor). */
if ($('#ttsVoice')) $('#ttsVoice').onchange = async (e) => {
  CFG.settings.ttsVoiceFijo = true;
  await window.sagitari.setSettings({ ttsVoice: e.target.value, ttsVoiceFijo: true });
};
/* Relleno real del slider: --fill marca hasta dónde llega el valor y el CSS
   corta el canal ahí (sin esto el degradado fijo mintía sobre la posición). */
function pintarFill(el) {
  if (!el) return;
  const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
}
if ($('#ttsRate')) {
  $('#ttsRate').oninput = async (e) => { pintarFill(e.target); await window.sagitari.setSettings({ ttsRate: Number(e.target.value) }); };
  pintarFill($('#ttsRate'));
}
if ($('#swAvisos')) {
  $('#swAvisos').classList.toggle('on', !!CFG.settings.ttsNotices);
  $('#swAvisos').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ ttsNotices: on }); };
}
/* Dictado local (whisper): estado, instalación con progreso y etiqueta de Ajustes. */
let __whisperProgreso = false;
/* Motor de escucha DE GUARDIA (para la franja de pasos del panel): se refresca en los
   momentos que pueden cambiarlo — arranque, apertura del modo, aviso de rescate — y se
   lee de forma SÍNCRONA al pintar los pasos (los manejadores de eventos no son async). */
let __estadoMotorEscucha = '';
async function actualizarEstadoMotorEscucha() {
  try {
    const r = await window.sagitari.voiceInstallStatus();
    if (!r || !r.ok) return;
    if (r.disponible) __estadoMotorEscucha = 'dictado local (Whisper)';
    else if (r.motor === 'sapi') __estadoMotorEscucha = 'Windows (clásico)';
    else if (r.motor === 'winrt') __estadoMotorEscucha = 'Windows (moderno)';
    else if (r.motor) __estadoMotorEscucha = 'Windows';
    else __estadoMotorEscucha = '';
  } catch {}
}
function pasosConMotor(lista) {
  return __estadoMotorEscucha ? [{ label: 'Escucha: ' + __estadoMotorEscucha }, ...lista] : lista;
}
async function refrescarWhisperUi() {
  const lbl = $('#lblWhisperEstado');
  const btn = $('#btnInstalarWhisper');
  if (!lbl || !btn) return;
  try {
    const r = await window.sagitari.voiceInstallStatus();
    actualizarEstadoMotorEscucha();
    const instalado = !!(r && r.ok && r.disponible);
    btn.textContent = instalado ? 'Reinstalar' : 'Instalar motor';
    if (r && r.ok && r.transcribiendo) lbl.textContent = 'transcribiendo…';
    else if (r && r.ok && instalado) lbl.textContent = 'instalado (' + r.modeloNombre + ') — activo';
  } catch {}
}
if ($('#btnInstalarWhisper')) {
  $('#btnInstalarWhisper').onclick = async () => {
    if (__whisperProgreso) return;
    __whisperProgreso = true;
    const lbl = $('#lblWhisperEstado'), btn = $('#btnInstalarWhisper');
    btn.disabled = true;
    window.sagitari.onVoiceInstall((p) => {
      if (!p) return;
      if (p.tipo === 'binario') lbl.textContent = 'descargando motor… ' + Math.round((p.recibido / (p.total || 1)) * 100) + '%';
      else if (p.tipo === 'modelo') lbl.textContent = 'descargando modelo… ' + Math.round((p.recibido / (p.total || 1)) * 100) + '%';
      else if (p.tipo === 'extrayendo') lbl.textContent = 'extrayendo motor…';
      else if (p.tipo === 'listo') { lbl.textContent = 'instalado — activo'; btn.disabled = false; btn.textContent = 'Reinstalar'; __whisperProgreso = false; showToast('Dictado local instalado: SAGITARI ahora entiende mucho mejor lo que dices.'); }
      else if (p.tipo === 'error') { lbl.textContent = 'error: ' + (p.error || 'descarga fallida'); btn.disabled = false; __whisperProgreso = false; }
    });
    try { await window.sagitari.voiceInstall(); } catch (e) { lbl.textContent = 'error: ' + (e.message || 'instalación'); __whisperProgreso = false; }
    btn.disabled = false;
    __whisperProgreso = false;
  };
};
/* Voz local (Piper): mismo patrón que el dictado local — progreso en vivo por evento,
   botón que se desactiva mientras descarga, etiqueta que dice qué suena ahora. */
let __piperProgreso = false;
async function refrescarPiperUi() {
  const lbl = $('#lblPiperEstado');
  const btn = $('#btnInstalarPiper');
  if (!lbl || !btn) return;
  try {
    const r = await window.sagitari.voiceInstallStatus();
    const instalado = !!(r && r.ok && r.piperDisponible);
    btn.textContent = instalado ? 'Reinstalar' : 'Instalar voz';
    if (instalado) lbl.textContent = 'instalada (voz local Piper) — activa';
  } catch {}
}
if ($('#btnInstalarPiper')) {
  $('#btnInstalarPiper').onclick = async () => {
    if (__piperProgreso) return;
    __piperProgreso = true;
    const lbl = $('#lblPiperEstado'), btn = $('#btnInstalarPiper');
    btn.disabled = true;
    window.sagitari.onTtsInstall((p) => {
      if (!p) return;
      if (p.tipo === 'binario') lbl.textContent = 'descargando voz… ' + Math.round((p.recibido / (p.total || 1)) * 100) + '%';
      else if (p.tipo === 'voz') lbl.textContent = 'descargando modelo de voz… ' + Math.round((p.recibido / (p.total || 1)) * 100) + '%';
      else if (p.tipo === 'config') lbl.textContent = 'configurando voz…';
      else if (p.tipo === 'extrayendo') lbl.textContent = 'extrayendo motor…';
      else if (p.tipo === 'listo') { lbl.textContent = 'instalada (voz local Piper) — activa'; btn.disabled = false; btn.textContent = 'Reinstalar'; __piperProgreso = false; showToast('Voz local instalada: SAGITARI ahora suena mucho más natural.'); refrescarVocesTts(); }
      else if (p.tipo === 'error') { lbl.textContent = 'error: ' + (p.error || 'descarga fallida'); btn.disabled = false; __piperProgreso = false; }
    });
    try { await window.sagitari.ttsInstall(); } catch (e) { lbl.textContent = 'error: ' + (e.message || 'instalación'); __piperProgreso = false; }
    btn.disabled = false;
    __piperProgreso = false;
  };
}
/* Motor de escucha clásico: sólo cambia CÓMO se escucha (el reconocedor de Windows que
   se usa). No toca la síntesis — esa es la de «Leer en voz alta» y su desplegable de voz. */
if ($('#swSttClasico')) {
  $('#swSttClasico').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    await window.sagitari.setSettings({ sttClasico: on });
  };
}
// ---- apariencia: aplicar al vuelo y persistir ----
function refreshGlowLabels() {
  const v = Number($('#glowStrength').value) || 1;
  $('#glowStrengthLabel').textContent = glowStrengthLabel(v);
  $('#lblSuave').classList.toggle('on', v < 0.8);
  $('#lblEq').classList.toggle('on', v >= 0.8 && v <= 1.15);
  $('#lblInt').classList.toggle('on', v > 1.15);
  const g = Number($('#glassTint').value) || 1;
  $('#glassTintLabel').textContent = glassTintLabel(g);
  $('#lblGlassClaro').classList.toggle('on', g < 0.7);
  $('#lblGlassEq').classList.toggle('on', g >= 0.7 && g <= 1.1);
  $('#lblGlassTint').classList.toggle('on', g > 1.1);
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
  pintarFill(e.target);
  CFG.settings.glowStrength = Number(e.target.value);
  applyTheme(); refreshGlowLabels();          // previsualización instantánea
  clearTimeout(glowSaveTimer);
  glowSaveTimer = setTimeout(() => window.sagitari.setSettings({ glowStrength: Number(e.target.value) }), 250);
};
let glassSaveTimer = null;
$('#glassTint').oninput = (e) => {
  pintarFill(e.target);
  CFG.settings.glassTint = Number(e.target.value);
  applyTheme(); refreshGlowLabels();          // previsualización instantánea
  clearTimeout(glassSaveTimer);
  glassSaveTimer = setTimeout(() => window.sagitari.setSettings({ glassTint: Number(e.target.value) }), 250);
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
  { n: 'browser_eval', d: 'Ejecutar JavaScript dentro de la página (acción eval)', label: 'Ejecutar JavaScript' },
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
    row.innerHTML = `<span class="mt"><b>${esc(t.label || K.tool(t.n).label)}</b> <small class="md">${esc(t.n)}</small><br><small class="md">${esc(t.d)}</small><br><small class="pd">recomendado: ${rec}</small></span>
      <select data-tool="${t.n}" aria-label="Permiso para ${esc(t.label || K.tool(t.n).label)} (${esc(t.n)})">
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
  // ---- v3.1: servidores MCP. El comodín del servidor gobierna TODAS sus
  // herramientas de una vez (el override exacto de una herramienta sigue ganando).
  // La clave la construye main (`permKey`), con la MISMA normalización que el nombre
  // expuesto: el id crudo no sirve si trae guiones o pasa de 16 caracteres.
  let mcp = { servers: [] };
  try { mcp = await window.sagitari.mcpList(); } catch {}
  for (const s of (mcp.servers || [])) {
    const wildcard = s.permKey || 'mcp__' + s.id + '__*';
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
    if ($('#grDelegations')) $('#grDelegations').value = g.maxDelegations ?? 8;
    // v2.5: paralelismo del turno (por defecto 3; el navegador y el disco van con cola)
    if ($('#parTools')) $('#parTools').value = CFG.settings.parallelTools ?? 3;
    if ($('#grLlmTimeout')) $('#grLlmTimeout').value = Math.round((CFG.settings.llmTimeoutMs ?? 120000) / 1000);
    if ($('#setMaxTasks')) $('#setMaxTasks').value = CFG.settings.maxConcurrentTasks ?? 1;
    if ($('#swAutoResume')) $('#swAutoResume').classList.toggle('on', CFG.settings.autoResumeTasks !== false);
    // La verificación de cierre viene ACTIVADA por defecto (el agente no da una tarea
    // por terminada sin comprobarla); la marca sólo se lee como desactivada si es false.
    if ($('#swVerificar')) $('#swVerificar').classList.toggle('on', CFG.settings.verifyGate !== false);
    // Modelo por agente: viene DESACTIVADO (el modelo elegido manda en todo hasta que el
    // usuario pida el ahorro: una vez se cambió un modelo en silencio y se leyó como un fallo)
    if ($('#swAgenteModelo')) $('#swAgenteModelo').classList.toggle('on', CFG.settings.agentRouting === true);
    // Razonamiento visible: apagado por defecto (en algunos proveedores cuesta tokens
    // aparte, y no todo el mundo quiere leer el proceso interno del modelo)
    if ($('#swThinking')) $('#swThinking').classList.toggle('on', CFG.settings.showThinking === true);
    // Revisión del cambio: ACTIVA por defecto (es la pieza que evita que el código
    // salga sin que nadie lo haya leído); solo se lee como apagada si es false
    if ($('#swRevisar')) $('#swRevisar').classList.toggle('on', CFG.settings.reviewGate !== false);
    // v2.5: verificación real, activada por defecto (comprobadores del proyecto al
    // escribir y pruebas al cerrar); solo se leen como apagadas si son false
    if ($('#swCache')) $('#swCache').classList.toggle('on', CFG.settings.promptCache !== false);
    if ($('#swDiagnosticos')) $('#swDiagnosticos').classList.toggle('on', CFG.settings.diagnosticosEscritura !== false);
    if ($('#swCierre')) $('#swCierre').classList.toggle('on', CFG.settings.verificacionCierre !== false);
    if ($('#swArboles')) $('#swArboles').classList.toggle('on', CFG.settings.arbolesAislados !== false);
    if ($('#verAttempts')) $('#verAttempts').value = CFG.settings.intentosArreglo ?? 2;
    // v2.5: tus hooks. Se guardan como texto tal cual (una línea = un comando).
    if ($('#hookEditar')) $('#hookEditar').value = CFG.settings.hookEditar || '';
    if ($('#hookCerrar')) $('#hookCerrar').value = CFG.settings.hookCerrar || '';
    if (CFG.settings.devMode) { devMode = true; $('#devModeSw').classList.add('on'); paintMeta(); }
  } catch {}
  renderSecurity();
  paintInstrucciones();   // v2.5: qué reglas del proyecto se están leyendo ahora mismo
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
if ($('#grDelegations')) $('#grDelegations').onchange = (e) => window.sagitari.secSetGuardrail({ maxDelegations: clampGuardrail(e.target, 8) });
if ($('#parTools')) $('#parTools').onchange = async (e) => {
  const v = clampGuardrail(e.target, 3);   // 1 = en orden, como antes
  CFG.settings.parallelTools = v;
  await window.sagitari.setSettings({ parallelTools: v });
  showToast(v === 1 ? 'Las herramientas irán una detrás de otra' : 'Hasta ' + v + ' herramientas a la vez (con cola por recurso)');
};
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
if ($('#swAgenteModelo')) $('#swAgenteModelo').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.agentRouting = on;
  await window.sagitari.setSettings({ agentRouting: on });
};
if ($('#swVerificar')) $('#swVerificar').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.verifyGate = on;
  await window.sagitari.setSettings({ verifyGate: on });
};
if ($('#swRevisar')) $('#swRevisar').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.reviewGate = on;
  await window.sagitari.setSettings({ reviewGate: on });
  showToast(on ? 'Cada cambio se revisará antes de cerrar' : 'Revisión del cambio desactivada');
};
if ($('#swCache')) $('#swCache').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.promptCache = on;
  await window.sagitari.setSettings({ promptCache: on });
  showToast(on ? 'Se reutilizará el prompt cacheado del proveedor' : 'Caché de prompt desactivado (cada paso se paga entero)');
};
if ($('#swDiagnosticos')) $('#swDiagnosticos').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.diagnosticosEscritura = on;
  await window.sagitari.setSettings({ diagnosticosEscritura: on });
  showToast(on ? 'Al escribir se comprobará el proyecto (los fallos vuelven al instante)' : 'Comprobación al escribir desactivada');
};
if ($('#swCierre')) $('#swCierre').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.verificacionCierre = on;
  await window.sagitari.setSettings({ verificacionCierre: on });
  showToast(on ? 'Antes de cerrar se ejecutarán las pruebas del proyecto' : 'Pruebas de cierre desactivadas');
};
if ($('#swArboles')) $('#swArboles').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.arbolesAislados = on;
  await window.sagitari.setSettings({ arbolesAislados: on });
  showToast(on ? 'Los subagentes que escriben trabajarán en un árbol de git aislado' : 'Los subagentes escribirán directamente sobre el proyecto');
};
if ($('#verAttempts')) $('#verAttempts').onchange = async (e) => {
  const v = Math.max(0, Math.min(5, Number(e.target.value) || 0));
  e.target.value = v;
  CFG.settings.intentosArreglo = v;
  await window.sagitari.setSettings({ intentosArreglo: v });
  showToast(v ? 'Si una prueba falla, se lo devolveré hasta ' + v + ' vez(ces)' : 'Si una prueba falla, no se reintentará');
};
/* --------------------------------------------------------------------------- *
 *  v2.5: reglas del proyecto (SAGITARI.md / AGENTS.md) y tus hooks.
 *  Las reglas no se editan aquí: se editan en el archivo, que es del proyecto y va
 *  a su git. Aquí se ve CUÁLES se están leyendo (para que nadie se pregunte por qué
 *  el agente hace algo raro, o por qué no obedece un archivo que no existe).
 * --------------------------------------------------------------------------- */
/** Pinta la lista de ficheros de reglas que se están leyendo ahora mismo. */
async function paintInstrucciones() {
  const cont = $('#instrList');
  if (!cont) return;
  let info = { fuentes: [], candidatos: [], workspace: '' };
  try { info = await window.sagitari.instruccionesInfo(); } catch {}
  const fuentes = info.fuentes || [];
  if (!fuentes.length) {
    cont.innerHTML = '<span class="instrnone">No hay ninguna: SAGITARI usa solo sus propias reglas. Creando una, tus convenciones mandan sobre ellas.</span>';
  } else {
    cont.innerHTML = fuentes.map(f => '<span class="instrfile" title="' + esc(String(f.ruta || '')) + '">'
      + '<i data-i="check"></i>' + esc(String(f.etiqueta || ''))
      + (f.donde === 'usuario' ? ' <em>(tus reglas globales)</em>' : ' <em>(' + (f.chars || 0) + ' caracteres leídos' + (f.recortado ? ', recortado' : '') + ')</em>') + '</span>').join('');
  }
  cont.querySelectorAll('[data-i]').forEach(el => { el.innerHTML = ic(el.dataset.i); });
}
if ($('#instrReload')) $('#instrReload').onclick = async () => {
  await paintInstrucciones();
  showToast('Reglas del proyecto releídas');
};
if ($('#instrCreate')) $('#instrCreate').onclick = async () => {
  try {
    const r = await window.sagitari.instruccionesCrear();
    if (r && r.yaExistia) { showToast('Ya existe: ' + r.ruta); return; }
    if (r && r.ok) { await paintInstrucciones(); showToast('Creado ' + r.ruta + ' — ábrelo y escribe tus reglas'); }
    else showToast('No se pudo crear: ' + ((r && r.error) || 'error desconocido'));
  } catch (e) { showToast('No se pudo crear el archivo'); }
};
const guardarHook = (id, campo, aviso) => {
  const el = $(id);
  if (!el) return;
  el.onchange = async () => {
    const v = String(el.value || '').trim();
    if (/\n/.test(String(el.value || ''))) showToast('Un hook es UN comando: me quedo con la primera línea');
    el.value = v;
    CFG.settings[campo] = v;
    await window.sagitari.setSettings({ [campo]: v });
    showToast(v ? aviso : 'Hook desactivado');
  };
};
guardarHook('#hookEditar', 'hookEditar', 'Se ejecutará tras cada escritura');
guardarHook('#hookCerrar', 'hookCerrar', 'Se ejecutará antes de cerrar el turno');
if ($('#swThinking')) $('#swThinking').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.showThinking = on;
  await window.sagitari.setSettings({ showThinking: on });
  showToast(on ? 'Se mostrará el razonamiento del modelo' : 'Razonamiento del modelo oculto');
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
  const card = $('#mcpFormCard');
  card.classList.add('on');
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
  // El nivel real vive en security.permissions[<comodín del servidor>] (misma fuente que la
  // vista Seguridad: config:get no expone `security`). Sin esto el desplegable mentiría:
  // diría «Preguntar siempre» con el comodín en 'safe'. El comodín viene en `permKey`
  // (misma normalización que el nombre expuesto); el id crudo solo como respaldo.
  let nivel = 'default';
  if (server && server.id) {
    const clave = server.permKey || 'mcp__' + server.id + '__*';
    try { const m = await window.sagitari.metaGet(); nivel = (m.permissions || {})[clave] || 'default'; } catch {}
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
  // Un servidor stdio ejecuta un comando de TU equipo con tus permisos: es la
  // capacidad más potente que se puede conceder desde esta pantalla (equivale a
  // dejar que algo lance programas por ti). Consentimiento informado ANTES de guardar.
  if (s.transport !== 'http' && !$('#mcpId').disabled) {
    const yes = await askConfirm($('#mcpFormCard'),
      '¿Confiar en este servidor MCP?',
      'Ejecutará «' + (s.command || '(sin comando)') + '» en tu equipo con tus permisos. Solo continúa si sabes qué programa es y de dónde viene.');
    if (!yes) return;
  }
  const r = await window.sagitari.mcpSave(s);
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  // El nivel elegido se aplica SIEMPRE al comodín del servidor (el MISMO que edita
  // Seguridad), también con 'default': así el desplegable no es decorativo y se puede
  // volver atrás (sec:setToolPerm borra el comodín cuando recibe 'default'). La clave la
  // devuelve main ya normalizada (`permKey`): construirla con el id crudo dejaría el
  // nivel sin aplicar en cuanto el id traiga guiones o pase de 16 caracteres.
  const wildcard = r.permKey || (r.id ? 'mcp__' + r.id + '__*' : '');
  if (wildcard && nivel) await window.sagitari.secSetToolPerm(wildcard, nivel);
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

const SET_TABS = ['model', 'prefs', 'security', 'agent', 'data', 'about'];
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
let updState = { kind: null, current: null, latest: null, available: false, ready: null, pending: null, status: 'idle', error: null, progress: null };
let updInitDone = false;   // la comprobación al abrir Ajustes se hace UNA vez, no en cada render
let updNotified = false;   // el toast de «nueva versión» no se repite en toda la sesión
let updUnsignedArmed = false; // primer clic en Instalar con binario sin firmar: el segundo confirma
let updSignerArmed = false;   // primer clic con firmante cambiado: el segundo confirma el cambio

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
    `state = { kind, current, latest, available, ready, pending, status, error, progress }`
    con `status` ∈ 'idle' | 'checking' | 'downloading' | 'ready'.
    `pending` es una instalación que se intentó y no cuajó (la app se cerró para
    instalarse y al volver seguía la versión vieja): se ofrece reintentarla. */
function renderUpdate(state) {
  const v = state || {};
  const s = {
    kind: v.kind || null, current: v.current || null, latest: v.latest || null,
    available: !!v.available, ready: v.ready || null, status: v.status || 'idle',
    error: v.error || null, progress: v.progress || null,
    pending: v.pending && v.pending.version ? v.pending : null
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
  // El botón sirve para dos cosas: instalar lo que se acaba de descargar, o
  // reintentar la instalación que se quedó a medias (los dos acaban cerrando la app).
  const reintento = !ready && !!s.pending && s.kind !== 'portable';
  if (inst) {
    const puede = (!!ready && s.kind !== 'dev') || reintento;
    inst.hidden = !puede;
    if (puede) {
      const portable = !reintento && s.kind === 'portable';
      const lbl = $('#updInstallLabel');
      if (lbl) lbl.textContent = reintento ? 'Reintentar la instalación' : (portable ? 'Abrir carpeta' : 'Instalar y cerrar');
      inst.setAttribute('aria-label', portable
        ? 'Abrir la carpeta con el archivo descargado'
        : (reintento
          ? 'Volver a intentar la instalación de la versión ' + (s.pending.version || '') + '; Sagitari se cerrará para instalarse'
          : 'Instalar la actualización; Sagitari se cerrará para instalarse'));
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
  if (s.pending && !ready) {
    notes.push(s.pending.exists
      ? 'La instalación de la versión ' + s.pending.version + ' no llegó a completarse (el asistente no pudo instalarla). El archivo sigue descargado: puedes reintentarlo o abrirlo a mano desde ' + s.pending.path + '.'
      : 'La instalación de la versión ' + s.pending.version + ' no llegó a completarse y el archivo descargado ya no está: descarga la actualización otra vez.');
  }
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
    updState.pending = r.pending || null;   // el motor la descarta sola si ya no aplica
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
    updState.ready = { name: r.name, version: r.version, verified: r.verified, signed: r.signed, signer: r.signer };
    updState.kind = r.kind || updState.kind;
    updState.status = 'ready';
    updState.progress = null;
    updUnsignedArmed = false;   // otra descarga, otra decisión: el consentimiento no se hereda
    updSignerArmed = false;
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
  // con algo recién descargado se instala eso; si no, se reintenta lo pendiente
  const reintento = !updState.ready && !!updState.pending;
  try {
    // Preparar la instalación ya no es instantáneo: antes de cerrar la app se espera
    // a que el asistente esté vivo FUERA de ella (si no, moriría con la app y el
    // usuario se quedaría con la ventana cerrada y nada instalado). Sin este aviso,
    // el botón parecía colgado durante esos segundos.
    updMsg('Preparando la instalación… no cierres la app todavía.');
    const extra = updUnsignedArmed ? { confirmUnsigned: true } : (updSignerArmed ? { confirmSignerChange: true } : undefined);
    let r = reintento ? await window.sagitari.updateRetry(extra)
      : await window.sagitari.updateInstall(extra);
    // Puerta de binario sin firmar: el motor exige consentimiento activo en dos
    // pasos (sin modales nativos: el segundo clic ES la confirmación). El aviso
    // queda escrito en la tarjeta, no solo en un toast que se pierde. Vale para
    // instalar y para reintentar: lo pendiente también puede ir sin firmar.
    if (r && r.ok === false && r.needsUnsignedConfirm) {
      updMsg(reintento
        ? 'Sin firma digital: solo SHA-512. Pulsa «Reintentar la instalación» OTRA VEZ para confirmar que la instalas igualmente.'
        : 'Sin firma digital: solo SHA-512. Pulsa «Instalar y cerrar» OTRA VEZ para confirmar que la instalas igualmente.');
      renderUpdate(updState);
      updUnsignedArmed = true;
      return;
    }
    // Puerta de cambio de firmante (TOFU): el binario trae otro firmante que las
    // releases anteriores (o perdió la firma). Mismo patrón de doble clic, con su
    // propio aviso para que el usuario sepa QUÉ cambió.
    if (r && r.ok === false && r.needsSignerConfirm) {
      updMsg('El firmante de esta actualización NO coincide con el de versiones anteriores. Pulsa «Instalar y cerrar» OTRA VEZ solo si confías en el cambio.');
      renderUpdate(updState);
      updSignerArmed = true;
      return;
    }
    updUnsignedArmed = false;
    updSignerArmed = false;
    if (r && 'pending' in r) {
      // el motor decidió qué queda pendiente (p. ej. descartó un instalador que ya
      // no está): la tarjeta se queda con eso en vez de seguir ofreciendo un fantasma
      updState.pending = r.pending || null;
      renderUpdate(updState);
    }
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
  // La instalación de la sesión anterior no cuajó: decirlo y ofrecer reintentarla
  // (es lo único que se puede hacer: para instalar hay que cerrar la app).
  if (ev.type === 'install-failed') {
    updState.pending = { version: ev.version || null, path: ev.path || null, exists: ev.exists !== false };
    setBadge('#nbUpdate', 1, { hot: true });
    showToast('La actualización a ' + (ev.version || 'la versión nueva') + ' no se llegó a instalar · Ajustes → Acerca de');
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
