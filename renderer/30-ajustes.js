/* SAGITARI renderer — 30-ajustes.js (antes app.js 2754-4113): ajustes, proveedores, seguridad, MCP, hábitos, datos, updater y acerca de
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
/* global glowStrengthLabel, glassTintLabel, smsg, hiloActual */
/* glowStrengthLabel y glassTintLabel están definidas en 40-vistas.js y hiloActual en
   10-chat.js (scope compartido); smsg está definida en ajustes-util.js */
/* exported fillSettings, wizardMostrar, initAboutPanel */
// ============ settings ============
async function fillSettings() {
  CFG = await window.sagitari.getConfig();
  const sel = $('#presetSel');
  if (!sel.options.length) {
    for (const p of CFG.presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      const p = CFG.presets.find((x) => x.id === sel.value);
      $('#pName').value = p.name.replace(' (local)', '').replace('Personalizado (OpenAI-compatible)', 'Mi API');
      $('#pUrl').value = p.baseUrl;
      $('#pKey').value = '';
      $('#modelSel').innerHTML = '<option value="">— detecta modelos primero —</option>';
      if ($('#apiFormat')) $('#apiFormat').value = p.format || 'auto'; // protocolo sugerido por el preset
      hintStoredKey(); // si esa misma URL ya tiene clave guardada, se dice en el campo
      pintarPresetHint(p); // y qué es y para qué sirve este proveedor, que lo dice su `hint`
    };
    sel.dispatchEvent(new Event('change'));
  } else {
    // Si la lista ya estaba montada, el aviso del proveedor se repinta igual: dejarlo
    // dependiendo de un solo `change` era lo que lo mantenía vacío para siempre.
    pintarPresetHint(CFG.presets.find((x) => x.id === sel.value));
  }
  renderProviderList();
  if ($('#apiFormat')) $('#apiFormat').value = (CFG.active && CFG.active.format) || 'auto';
  showSetTab(setTabName); // restaura la pestaña de Ajustes que estaba abierta
  filterSettings(''); // limpia cualquier búsqueda previa
  initDataPanel(); // hábitos + carpeta de datos
  $('#swGlow').classList.toggle('on', !!CFG.settings.glowEnabled);
  $('#setUserName').value = CFG.settings.userName || '';
  // apariencia: color de interfaz, color del glow e intensidad
  $('#uiColor').value = PALETTES[CFG.settings.uiColor] ? CFG.settings.uiColor : 'aurora';
  $('#glowColor').value =
    !CFG.settings.glowColor || CFG.settings.glowColor === 'match'
      ? 'match'
      : PALETTES[CFG.settings.glowColor]
        ? CFG.settings.glowColor
        : 'match';
  $('#glowStrength').value = String(Math.min(1.4, Math.max(0.4, Number(CFG.settings.glowStrength) || 1)));
  $('#glassTint').value = String(Math.min(1.3, Math.max(0.4, Number(CFG.settings.glassTint) || 1)));
  pintarFill($('#glowStrength'));
  pintarFill($('#glassTint'));
  refreshGlowLabels();
  refreshColorDots();
  window.sagitari.workspaceGet().then((w) => {
    pintarEspacioTrabajo(w);
  });
  mode = CFG.settings.mode || 'act';
  updateModeUI();
  updateStatusLabels();
}

$('#btnDetect').onclick = async () => {
  const url = $('#pUrl').value.trim();
  if (!url) return smsg('Escribe una Base URL.');
  smsg('Detectando modelos…');
  /* El protocolo elegido viaja con la petición: sin él, una base Anthropic de terceros
     (sin «/anthropic» en la ruta) se sondeaba con Bearer en vez de x-api-key y la
     detección fallaba justo cuando el usuario acababa de decir cómo habla ese servidor. */
  const pre = (CFG.presets || []).find((p) => p.id === $('#presetSel').value) || {};
  const r = await window.sagitari.listModels(url, $('#pKey').value.trim(), {
    format: apiFormatValue(),
    providerId: pre.baseUrl && pre.baseUrl === url ? pre.id : undefined,
  });
  if (!r.ok) return smsg('Error: ' + r.error);
  const sel = $('#modelSel');
  sel.innerHTML = '';
  for (const m of r.models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  smsg(r.models.length + ' modelos detectados.');
};
// 'auto' = que el agente deduzca el protocolo; si no, se fuerza el elegido
const apiFormatValue = () => ($('#apiFormat') ? $('#apiFormat').value : 'auto') || 'auto'; // 'auto' = detectar

/** El `hint` que cada proveedor predefinido trae escrito en main/providers.js es la única
    explicación de para qué sirve cada uno (local y gratis, necesita clave, ultrarrápido…)
    y hasta ahora no llegaba a ninguna parte: `#presetHint` era un div muerto y siempre
    vacío, así que elegir un proveedor no decía nada sobre él. */
function pintarPresetHint(p) {
  const el = $('#presetHint');
  if (el) el.textContent = (p && p.hint) || '';
}

/* El protocolo no es decorativo: decide las cabeceras (Bearer o x-api-key) y la ruta del
   endpoint. Antes no tenía manejador, así que cambiarlo después de guardar no se guardaba
   en ninguna parte: el proveedor conservaba el formato viejo y activarlo lo reenviaba, con
   la llamada yendo por el camino equivocado sin que nada lo dijera. */
if ($('#apiFormat'))
  $('#apiFormat').onchange = async () => {
    const format = apiFormatValue();
    const texto = ($('#apiFormat').selectedOptions[0] || {}).textContent || format;
    const url = $('#pUrl').value.trim();
    const guardado = (CFG.providers || []).find((p) => p.baseUrl === url);
    if (guardado) {
      // Se guarda sobre el proveedor que ya tiene esa URL (la clave va enmascarada: main
      // conserva la guardada). Así la fila «Usar» reenvía el protocolo correcto.
      const r = await window.sagitari.saveProvider({ ...guardado, format });
      if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo guardar el protocolo'));
      CFG = await window.sagitari.getConfig();
      renderProviderList();
    }
    const activo = CFG.active && CFG.active.baseUrl === url && CFG.active.model;
    if (activo) {
      // Si es el proveedor activo, el cambio tiene que llegar al motor ya: activar el
      // mismo modelo y la misma URL solo reescribe el protocolo.
      const r = await window.sagitari.activateProvider({
        providerId: CFG.active.providerId,
        name: CFG.active.name,
        baseUrl: url,
        apiKey: $('#pKey').value.trim(),
        model: CFG.active.model,
        vision: CFG.active.vision,
        format,
      });
      if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo aplicar el protocolo'));
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels();
    }
    smsg(guardado || activo ? 'Protocolo aplicado: ' + texto : 'Protocolo elegido: ' + texto + '. Se guardará con el proveedor.');
  };

$('#btnSaveProv').onclick = async () => {
  const btn = $('#btnSaveProv');
  if (btn.disabled) return;
  if (!$('#pUrl').value.trim()) return smsg('Falta la Base URL.');
  btn.disabled = true;
  try {
    const r = await window.sagitari.saveProvider({
      id: 'prov_' + Date.now().toString(36),
      name: $('#pName').value.trim() || 'Proveedor',
      baseUrl: $('#pUrl').value.trim(),
      apiKey: $('#pKey').value.trim(),
      format: apiFormatValue(),
      models: [...$('#modelSel').options].map((o) => o.value).filter(Boolean),
    });
    // main valida la URL y puede rechazar: la UI no puede decir «guardado» sin comprobarlo
    if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo guardar'));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg('Proveedor guardado.');
  } catch (e) {
    smsg('Error: ' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
  }
};
$('#btnActivate').onclick = async () => {
  const btn = $('#btnActivate');
  if (btn.disabled) return;
  const baseUrl = $('#pUrl').value.trim(),
    model = $('#modelSel').value;
  if (!baseUrl || !model) return smsg('Detecta modelos y elige uno.');
  const vision = looksVision(model);
  btn.disabled = true;
  try {
    const r = await window.sagitari.activateProvider({
      name: $('#pName').value.trim() || 'Proveedor',
      baseUrl,
      apiKey: $('#pKey').value.trim(),
      model,
      vision,
      format: apiFormatValue(),
    });
    // activar también valida: si falla, NO se pinta «activo»/«Conectado»
    if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo activar'));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg('Activado: ' + model);
    updateStatusLabels();
  } catch (e) {
    smsg('Error: ' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
  }
};

function renderProviderList() {
  const box = $('#provList');
  box.innerHTML = '';
  hintStoredKey(); // la lista cambió (guardar/borrar/activar): el aviso del campo se recalcula
  if (!CFG.providers.length) {
    box.innerHTML = '<div class="subnote">Aún no hay proveedores guardados.</div>';
    return;
  }
  /* Una clave guardada que este equipo no puede descifrar (config traída de otro
     perfil o equipo) tiene que VERSE: el proveedor parece configurado, el campo
     enseña sus puntos suspensivos y la llamada falla. El proceso principal ya no lo
     trata como fallo interno; aquí se dice qué hacer, y sin bloquear nada. Va después
     del caso vacío porque ese sí vacía la caja entera. */
  const ilegibles = (CFG.providers || []).filter((p) => p && p.keyUnreadable);
  if (ilegibles.length || (CFG.active && CFG.active.keyUnreadable)) {
    const nombres = [...new Set([...ilegibles.map((p) => p.name), ...(CFG.active && CFG.active.keyUnreadable ? [CFG.active.name] : [])])];
    const av = document.createElement('div');
    av.className = 'subnote';
    av.id = 'provKeyUnreadable';
    av.innerHTML =
      `<b>Hay una clave guardada que este equipo no puede descifrar</b> (pasa si el ` +
      `config llegó de otro perfil o de otro equipo): ${esc(nombres.join(', '))}. ` +
      `Vuelve a escribirla abajo y guárdala; hasta entonces ese proveedor no puede llamar al modelo.`;
    box.appendChild(av);
  }
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
      const r = await window.sagitari.activateProvider({
        providerId: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model,
        vision: looksVision(model),
        format: p.format,
      });
      if (r && r.ok === false) return smsg('Error: ' + (r.error || 'no se pudo activar'));
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels();
      smsg('Usando ' + p.name);
    };
    item.querySelector('[data-act=del]').onclick = async () => {
      if (!(await askConfirm(item, '¿Eliminar el proveedor «' + p.name + '»?'))) return;
      await window.sagitari.deleteProvider(p.id);
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels(); // si era el activo, main lo desactiva: que se vea
      showToast('Proveedor eliminado');
    };
    box.appendChild(item);
  }
}
/** Aviso del panel MCP (no reutiliza el del formulario de proveedores). */
function mcpMsg(t) {
  const el = $('#mcpMsg');
  if (el) el.textContent = t || '';
}

/* El campo de la clave se vacía al elegir un preset (no se reescribe una credencial
   en pantalla), y activar o detectar en ese momento parecía «sin clave»: el aviso
   va en el propio campo. */
function hintStoredKey() {
  const el = $('#pKey');
  if (!el) return;
  const url = $('#pUrl').value.trim();
  const guardado = (CFG.providers || []).find((p) => p.baseUrl === url && p.apiKey);
  /* Una clave ilegible NO se puede «seguir usando»: decir «déjala vacía para seguir
     usándola» mandaba al usuario a un proveedor que no puede llamar al modelo. */
  if (guardado && guardado.keyUnreadable) {
    el.placeholder = 'la clave guardada en «' + guardado.name + '» no se pudo descifrar: escríbela otra vez';
    return;
  }
  el.placeholder = guardado
    ? 'guardada en «' + guardado.name + '» — déjalo vacío para seguir usándola'
    : 'sk-… (vacío para Ollama o LM Studio)';
}
if ($('#pUrl')) $('#pUrl').addEventListener('input', hintStoredKey);

$('#swGlow').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  CFG.settings.glowEnabled = on;
  /* el CSS es quien dibuja el glow de reposo y la atmósfera: sin este repintado el
     interruptor sólo callaba los estados de main y el marco seguía encendido */
  applyTheme();
  await window.sagitari.setSettings({ glowEnabled: on });
};
// espacio de trabajo: Ajustes ya NO tiene un segundo campo de ruta (duplicaba el
// editable de la vista Espacio de trabajo); aquí se enseña la carpeta activa y se
// ofrece cambiarla.
function pintarEspacioTrabajo(p) {
  const el = $('#wsPathLabel');
  if (el) el.textContent = p || '—';
  // El campo editable de la vista Espacio de trabajo es la otra cara del MISMO ajuste:
  // si se cambia desde aquí y no se actualiza, las dos pantallas se contradicen.
  const proj = $('#projPath');
  if (proj && p) proj.value = p;
}
$('#wsPick').onclick = async () => {
  const r = await window.sagitari.workspacePick();
  if (r && r.ok) {
    pintarEspacioTrabajo(r.path);
    showToast('Espacio de trabajo: ' + r.path);
  }
};
/* Relleno real del slider: --fill marca hasta dónde llega el valor y el CSS
   corta el canal ahí (sin esto el degradado fijo mintía sobre la posición). */
function pintarFill(el) {
  if (!el) return;
  const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
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
  paintTiles();
}

/* ---- paletas visuales: las muestras escriben en el select oculto, que sigue
   siendo la fuente de verdad del ajuste (y lo que guarda la app). ---- */
function paintTiles() {
  const ui = document.getElementById('uiColor');
  const gl = document.getElementById('glowColor');
  if (ui)
    document.querySelectorAll('#uiColorTiles .pal').forEach((b) => b.classList.toggle('on', b.dataset.pal === ui.value));
  if (gl)
    document.querySelectorAll('#glowColorTiles .pal').forEach((b) => b.classList.toggle('on', b.dataset.pal === gl.value));
}
document.querySelectorAll('.pals .pal').forEach((b) => {
  b.addEventListener('click', () => {
    const row = b.closest('.themerow');
    const sel = row && row.querySelector('select');
    if (!sel) return;
    sel.value = b.dataset.pal;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    paintTiles();
  });
});
const btnChangeModel = document.getElementById('btnChangeModel');
if (btnChangeModel)
  btnChangeModel.addEventListener('click', () => {
    const t = document.getElementById('tab-model');
    if (t) t.click();
  });

$('#uiColor').onchange = async (e) => {
  CFG.settings.uiColor = e.target.value;
  applyTheme();
  refreshColorDots();
  await window.sagitari.setSettings({ uiColor: e.target.value });
};
$('#glowColor').onchange = async (e) => {
  CFG.settings.glowColor = e.target.value;
  applyTheme();
  refreshColorDots();
  await window.sagitari.setSettings({ glowColor: e.target.value });
};
let glowSaveTimer = null;
$('#glowStrength').oninput = (e) => {
  pintarFill(e.target);
  CFG.settings.glowStrength = Number(e.target.value);
  applyTheme();
  refreshGlowLabels(); // previsualización instantánea
  clearTimeout(glowSaveTimer);
  glowSaveTimer = setTimeout(() => window.sagitari.setSettings({ glowStrength: Number(e.target.value) }), 250);
};
let glassSaveTimer = null;
$('#glassTint').oninput = (e) => {
  pintarFill(e.target);
  CFG.settings.glassTint = Number(e.target.value);
  applyTheme();
  refreshGlowLabels(); // previsualización instantánea
  clearTimeout(glassSaveTimer);
  glassSaveTimer = setTimeout(() => window.sagitari.setSettings({ glassTint: Number(e.target.value) }), 250);
};
$('#setUserName').onchange = async (e) => {
  CFG.settings.userName = e.target.value;
  try {
    await window.sagitari.setSettings({ userName: e.target.value });
  } catch (err) {
    showToast('No se pudo guardar tu nombre');
  }
};

// ---- seguridad: permisos por herramienta + guardarraíles (v1.1) ----
/* QUÉ herramientas hay y qué nivel recomienda cada una lo dice el AGENTE
   (agent/tools.js → meta:get.riskDefaults), que es la única fuente: aquí había una
   lista copiada a mano con 8 filas de las 31 claves reales, así que todo lo que se
   añadió después (apply_patch, open_url, web_fetch, los git…) no se podía permitir ni
   bloquear desde Ajustes. Se pinta la tabla ENTERA, agrupada por familia para que se
   lea, y una clave que no esté en ningún grupo no se esconde: cae en «Otras».
   Lo único que se escribe a mano aquí es cómo se llama cada cosa en castellano
   (`PERM_INFO`); si falta, se usa el nombre humanizado que da el catálogo (K.tool). */
const PERM_GROUPS = [
  {
    id: 'archivos',
    titulo: 'Archivos y proyecto',
    keys: [
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'list_dir',
      'search_files',
      'search_code',
      'find_symbol',
      'repo_map',
      'view_image',
    ],
  },
  { id: 'terminal', titulo: 'Terminal', keys: ['run_command'] },
  {
    id: 'escritorio',
    titulo: 'Escritorio y sistema',
    keys: ['open_app', 'open_url', 'clipboard', 'notify', 'media_control', 'window_manage', 'screenshot', 'system_info'],
  },
  { id: 'navegador', titulo: 'Navegador', keys: ['browser_control', 'browser_eval'] },
  { id: 'git', titulo: 'Git', keys: ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit'] },
  { id: 'web', titulo: 'Web', keys: ['web_fetch'] },
  { id: 'agente', titulo: 'El propio agente', keys: ['remember', 'use_skill', 'todo_write', 'delegate'] },
];
const PERM_INFO = {
  read_file: 'Leer archivos de texto del proyecto',
  write_file: 'Crear o sobrescribir archivos',
  edit_file: 'Editar archivos existentes',
  apply_patch: 'Aplicar un parche que toca varios archivos a la vez',
  list_dir: 'Listar el contenido de una carpeta',
  search_files: 'Buscar texto dentro de los archivos',
  search_code: 'Buscar en el código del proyecto',
  find_symbol: 'Buscar dónde se define una función o clase',
  repo_map: 'Leer el índice del proyecto (nombres y rutas)',
  view_image: 'Mirar una imagen que le señalas',
  run_command: 'Ejecutar comandos en la terminal de Windows',
  open_app: 'Abrir aplicaciones instaladas',
  open_url: 'Abrir cualquier dirección en el navegador del sistema',
  clipboard: 'Leer y escribir el portapapeles',
  notify: 'Mostrar notificaciones de Windows',
  media_control: 'Controlar la música y el volumen',
  window_manage: 'Minimizar, enfocar y ordenar ventanas',
  screenshot: 'Capturar la pantalla',
  system_info: 'Consultar CPU, memoria, red y tiempo encendido',
  browser_control: 'Manejar Chrome o Edge: clic, escribir, leer, capturar',
  browser_eval: 'Ejecutar JavaScript dentro de la página (acción «eval»)',
  git_status: 'Ver qué ha cambiado en el repositorio',
  git_diff: 'Ver el detalle de los cambios',
  git_log: 'Leer el historial de commits',
  git_branch: 'Listar, crear y cambiar de rama',
  git_commit: 'Crear un commit',
  web_fetch: 'Descargar y leer una página pública',
  remember: 'Guardar algo en su memoria',
  use_skill: 'Aplicar una skill instalada',
  todo_write: 'Llevar su lista de tareas del turno',
  delegate: 'Repartir trabajo a subagentes',
};
const PERM_OTRAS = 'Otras herramientas';
/* El nivel 'safe' se llamaba «Seguro», que se lee como «más protección» cuando en
   realidad significa «se ejecuta SIN preguntar». El nombre dice ahora su efecto. */
const RISK_LABEL = { safe: 'permitir siempre', confirm: 'confirmar', restricted: 'bloqueado' };
/* Claves reales de la tabla del agente, rellenadas al pintar Seguridad (ver
   _renderSecurity): las usa «Restablecer permisos recomendados».
   `PERM_LABEL`: nombres bonitos que no están en el catálogo del chat (browser_eval no
   es una herramienta suelta, es la acción «eval» de browser_control). */
let PERM_KEYS = [];
const PERM_LABEL = { browser_eval: 'Ejecutar JavaScript' };

/* Seguridad se pinta al arrancar (initSecurity) Y al entrar en su pestaña, así que dos
   pasadas pueden solaparse (al arrancar con «Seguridad» recordada como última pestaña, por
   ejemplo): las dos empiezan vaciando `#permList` y las filas se duplicarían o quedarían a
   medias. La segunda no se descarta: se ENCOLA, porque descartarla dejaba la lista con los
   datos viejos justo cuando el usuario acababa de entrar. */
let securityPainting = false;
let securityAgain = false;
async function renderSecurity() {
  if (securityPainting) {
    securityAgain = true;
    return;
  }
  securityPainting = true;
  try {
    do {
      securityAgain = false;
      await _renderSecurity();
    } while (securityAgain);
  } finally {
    securityPainting = false;
  }
}
async function _renderSecurity() {
  const cfg = { permissions: {}, riskDefaults: {} };
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    cfg.permissions = m.permissions || (CFG.security && CFG.security.permissions) || {};
    cfg.riskDefaults = m.riskDefaults || {};
  } catch {}
  const permBox = $('#permList');
  if (!permBox) return;
  permBox.innerHTML = '';
  /* Las claves salen de la tabla del agente, NO de una lista de aquí. `browser_eval`
     se añade porque es una SUB-permisión de browser_control (la herramienta es la
     misma, la acción «eval» es la que se regula) y por eso no vive en esa tabla. */
  const claves = Object.keys(cfg.riskDefaults);
  if (!claves.includes('browser_eval')) claves.push('browser_eval');
  PERM_KEYS = claves.slice(); // lo usa «Restablecer permisos recomendados»
  const grupos = PERM_GROUPS.map((g) => ({ ...g, keys: g.keys.filter((k) => claves.includes(k)) }));
  const yaPuestas = new Set(grupos.flatMap((g) => g.keys));
  const sueltas = claves.filter((k) => !yaPuestas.has(k)); // una clave nueva NO se esconde
  if (sueltas.length) grupos.push({ id: 'otras', titulo: PERM_OTRAS, keys: sueltas });
  for (const g of grupos) {
    if (!g.keys.length) continue;
    const h = document.createElement('div');
    h.className = 'permgroup';
    h.textContent = g.titulo;
    permBox.appendChild(h);
    for (const n of g.keys) {
      const lvl = (cfg.permissions && cfg.permissions[n]) || 'default';
      const rec = RISK_LABEL[cfg.riskDefaults[n]] || 'confirmar';
      const nombre = PERM_LABEL[n] || K.tool(n).label; // nunca la clave interna
      const desc = PERM_INFO[n] || g.titulo;
      const row = document.createElement('div');
      row.className = 'permrow';
      row.innerHTML = `<span class="mt"><b>${esc(nombre)}</b><br><small class="md">${esc(desc)}</small><br><small class="pd">recomendado: ${rec}</small></span>
      <select data-tool="${esc(n)}" aria-label="Permiso para ${esc(nombre)}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>Permitir siempre</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>Preguntar antes</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>Bloqueado</option>
      </select>`;
      row.querySelector('select').onchange = async (e) => {
        await window.sagitari.secSetToolPerm(n, e.target.value);
        showToast(`${nombre}: ${e.target.selectedOptions[0].textContent.toLowerCase()}`);
      };
      permBox.appendChild(row);
    }
  }
  // ---- v3.1: servidores MCP. El comodín del servidor gobierna TODAS sus
  // herramientas de una vez (el override exacto de una herramienta sigue ganando).
  // La clave la construye main (`permKey`), con la MISMA normalización que el nombre
  // expuesto: el id crudo no sirve si trae guiones o pasa de 16 caracteres.
  let mcp = { servers: [] };
  try {
    mcp = await window.sagitari.mcpList();
  } catch {}
  /* Un servidor MCP es una fila que gobierna TODAS sus herramientas de una vez, así
     que va en su propio grupo y no entre las nativas (donde se leería como una más). */
  if ((mcp.servers || []).length) {
    const hMcp = document.createElement('div');
    hMcp.className = 'permgroup';
    hMcp.textContent = 'Servidores MCP';
    permBox.appendChild(hMcp);
  }
  for (const s of mcp.servers || []) {
    const wildcard = s.permKey || 'mcp__' + s.id + '__*';
    const lvl = (cfg.permissions && cfg.permissions[wildcard]) || 'default';
    const n = (s.discovered || []).length;
    const row = document.createElement('div');
    row.className = 'permrow';
    row.innerHTML = `<span class="mt"><b>${esc(s.name)}</b> <small class="md">MCP</small><br><small class="md">${n} herramienta${n === 1 ? '' : 's'} del servidor</small><br><small class="pd">todas sus herramientas piden permiso salvo que las permitas aquí</small></span>
      <select data-tool="${esc(wildcard)}" aria-label="Permiso para el servidor MCP ${esc(s.name)}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto</option>
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
    const m = await window.sagitari.metaGet(hiloActual());
    const g = m.guardrails || {};
    $('#grSteps').value = g.maxSteps ?? 60;
    $('#grToolCalls').value = g.maxToolCalls ?? 80;
    $('#grMinutes').value = g.maxDurationMs ? Math.round(g.maxDurationMs / 60000) : 0;
    $('#grTokens').value = g.maxTokens ?? 0;
    $('#grLoop').value = g.loopThreshold ?? 3;
    if ($('#grCost')) $('#grCost').value = g.maxCostUsd ?? 0;
    if ($('#grStall')) $('#grStall').value = g.stallThreshold ?? 6;
    if ($('#grDelegations')) $('#grDelegations').value = g.maxDelegations ?? 8;
    /* v4.4: presupuesto del EQUIPO (modo EQUIPO). No es un guardarraíl del turno sino un
       tope por encargo de equipo, y lo sirve `meta:get` junto con el tope de compañeros. */
    if ($('#eqPresupuesto')) $('#eqPresupuesto').value = Number((m.equipo && m.equipo.presupuestoUsd) || 0);
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
    // Aceptar las escrituras sin preguntar: APAGADO por defecto (es el ajuste de más
    // riesgo del panel, así que sólo se lee como encendido si es true de verdad)
    if ($('#swAutoEdits')) $('#swAutoEdits').classList.toggle('on', CFG.settings.autoEdits === true);
    if ($('#verAttempts')) $('#verAttempts').value = CFG.settings.intentosArreglo ?? 2;
    // v2.5: tus hooks. Se guardan como texto tal cual (una línea = un comando).
    if ($('#hookEditar')) $('#hookEditar').value = CFG.settings.hookEditar || '';
    if ($('#hookCerrar')) $('#hookCerrar').value = CFG.settings.hookCerrar || '';
    if (CFG.settings.devMode) {
      devMode = true;
      $('#devModeSw').classList.add('on');
      paintMeta();
    }
  } catch {}
  renderSecurity();
  paintInstrucciones(); // v2.5: qué reglas del proyecto se están leyendo ahora mismo
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
if ($('#grDelegations'))
  $('#grDelegations').onchange = (e) => window.sagitari.secSetGuardrail({ maxDelegations: clampGuardrail(e.target, 8) });
/* v4.4: el presupuesto del equipo se guarda como ajuste (equipoPresupuestoUsd) y admite
   decimales —es dinero, no un número de pasos—, así que no pasa por clampGuardrail. */
if ($('#eqPresupuesto'))
  $('#eqPresupuesto').onchange = async (e) => {
    const v = Number(String(e.target.value).replace(',', '.'));
    const usd = Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0; // 0 = sin tope propio
    e.target.value = usd;
    await window.sagitari.setSettings({ equipoPresupuestoUsd: usd });
    showToast(usd ? 'Presupuesto del equipo: ' + usd.toFixed(2) + ' $ por encargo' : 'El equipo trabajará sin tope de gasto propio');
  };
if ($('#parTools'))
  $('#parTools').onchange = async (e) => {
    const v = clampGuardrail(e.target, 3); // 1 = en orden, como antes
    CFG.settings.parallelTools = v;
    await window.sagitari.setSettings({ parallelTools: v });
    showToast(v === 1 ? 'Las herramientas irán una detrás de otra' : 'Hasta ' + v + ' herramientas a la vez (con cola por recurso)');
  };
if ($('#grLlmTimeout'))
  $('#grLlmTimeout').onchange = async (e) => {
    const v = clampGuardrail(e.target, 120);
    await window.sagitari.setSettings({ llmTimeoutMs: v * 1000 });
    showToast(v ? 'Sin respuesta del modelo: ' + v + ' s' : 'Sin límite de espera del modelo');
  };
if ($('#setMaxTasks'))
  $('#setMaxTasks').onchange = async (e) => {
    const v = Math.max(1, Math.min(4, Number(e.target.value) || 1));
    e.target.value = v;
    await window.sagitari.setSettings({ maxConcurrentTasks: v });
    showToast('Tareas simultáneas: ' + v);
  };
if ($('#swAutoResume'))
  $('#swAutoResume').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    await window.sagitari.setSettings({ autoResumeTasks: on });
  };
if ($('#swAgenteModelo'))
  $('#swAgenteModelo').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.agentRouting = on;
    await window.sagitari.setSettings({ agentRouting: on });
  };
if ($('#swVerificar'))
  $('#swVerificar').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.verifyGate = on;
    await window.sagitari.setSettings({ verifyGate: on });
  };
if ($('#swRevisar'))
  $('#swRevisar').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.reviewGate = on;
    await window.sagitari.setSettings({ reviewGate: on });
    showToast(on ? 'Cada cambio se revisará antes de cerrar' : 'Revisión del cambio desactivada');
  };
if ($('#swCache'))
  $('#swCache').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.promptCache = on;
    await window.sagitari.setSettings({ promptCache: on });
    showToast(on ? 'Se reutilizará el prompt cacheado del proveedor' : 'Caché de prompt desactivado (cada paso se paga entero)');
  };
if ($('#swDiagnosticos'))
  $('#swDiagnosticos').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.diagnosticosEscritura = on;
    await window.sagitari.setSettings({ diagnosticosEscritura: on });
    showToast(on ? 'Al escribir se comprobará el proyecto (los fallos vuelven al instante)' : 'Comprobación al escribir desactivada');
  };
if ($('#swCierre'))
  $('#swCierre').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.verificacionCierre = on;
    await window.sagitari.setSettings({ verificacionCierre: on });
    showToast(on ? 'Antes de cerrar se ejecutarán las pruebas del proyecto' : 'Pruebas de cierre desactivadas');
  };
if ($('#swArboles'))
  $('#swArboles').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.arbolesAislados = on;
    await window.sagitari.setSettings({ arbolesAislados: on });
    showToast(
      on ? 'Los subagentes que escriben trabajarán en un árbol de git aislado' : 'Los subagentes escribirán directamente sobre el proyecto',
    );
  };
if ($('#swAutoEdits'))
  $('#swAutoEdits').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.autoEdits = on;
    await window.sagitari.setSettings({ autoEdits: on });
    showToast(
      on
        ? 'Los cambios en archivos se aceptarán sin preguntar (los comandos y lo que borra siguen pidiendo permiso)'
        : 'Los cambios en archivos volverán a pedir tu permiso',
    );
  };
if ($('#verAttempts'))
  $('#verAttempts').onchange = async (e) => {
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
  try {
    info = await window.sagitari.instruccionesInfo();
  } catch {}
  const fuentes = info.fuentes || [];
  if (!fuentes.length) {
    cont.innerHTML =
      '<span class="instrnone">No hay ninguna: SAGITARI usa solo sus propias reglas. Creando una, tus convenciones mandan sobre ellas.</span>';
  } else {
    cont.innerHTML = fuentes
      .map(
        (f) =>
          '<span class="instrfile" title="' +
          esc(String(f.ruta || '')) +
          '">' +
          '<i data-i="check"></i>' +
          esc(String(f.etiqueta || '')) +
          (f.donde === 'usuario'
            ? ' <em>(tus reglas globales)</em>'
            : ' <em>(' + (f.chars || 0) + ' caracteres leídos' + (f.recortado ? ', recortado' : '') + ')</em>') +
          '</span>',
      )
      .join('');
  }
  cont.querySelectorAll('[data-i]').forEach((el) => {
    el.innerHTML = ic(el.dataset.i);
  });
}
if ($('#instrReload'))
  $('#instrReload').onclick = async () => {
    await paintInstrucciones();
    showToast('Reglas del proyecto releídas');
  };
if ($('#instrCreate'))
  $('#instrCreate').onclick = async () => {
    try {
      const r = await window.sagitari.instruccionesCrear();
      if (r && r.yaExistia) {
        showToast('Ya existe: ' + r.ruta);
        return;
      }
      if (r && r.ok) {
        await paintInstrucciones();
        showToast('Creado ' + r.ruta + ' — ábrelo y escribe tus reglas');
      } else showToast('No se pudo crear: ' + ((r && r.error) || 'error desconocido'));
    } catch (e) {
      showToast('No se pudo crear el archivo');
    }
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
if ($('#swThinking'))
  $('#swThinking').onclick = async (e) => {
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
const mcpPair = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
    })
    .filter(Boolean);
const mcpLines = (obj) =>
  Object.entries(obj || {})
    .map(([k, v]) => k + '=' + v)
    .join('\n');

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
  try {
    MCP_STATE = await window.sagitari.mcpList();
  } catch (e) {
    showToast('No pude leer los servidores MCP: ' + e.message);
    return;
  }
  $('#mcpGlobal').classList.toggle('on', MCP_STATE.enabled !== false);
  if (!(MCP_STATE.servers || []).length) {
    box.innerHTML = '<div class="mcpempty">Ningún servidor MCP. Añade uno o pega el JSON de <code>mcpServers</code> de otro cliente.</div>';
    return;
  }
  box.innerHTML = MCP_STATE.servers
    .map((s) => {
      const st = mcpStatusLabel(s);
      const lista = (s.discovered || [])
        .map((t) => `<span class="mcptool" title="${esc(t.description || '')}">${esc(t.tool)}</span>`)
        .join('');
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
    })
    .join('');
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
  $('#mcpAllow').value = ((s.tools && s.tools.allow) || []).join(', ');
  $('#mcpDeny').value = ((s.tools && s.tools.deny) || []).join(', ');
  // El nivel real vive en security.permissions[<comodín del servidor>] (misma fuente que la
  // vista Seguridad: config:get no expone `security`). Sin esto el desplegable mentiría:
  // diría «Preguntar siempre» con el comodín en 'safe'. El comodín viene en `permKey`
  // (misma normalización que el nombre expuesto); el id crudo solo como respaldo.
  let nivel = 'default';
  if (server && server.id) {
    const clave = server.permKey || 'mcp__' + server.id + '__*';
    try {
      const m = await window.sagitari.metaGet(hiloActual());
      nivel = (m.permissions || {})[clave] || 'default';
    } catch {}
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
      allow: $('#mcpAllow')
        .value.split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      deny: $('#mcpDeny')
        .value.split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    },
  };
}

$('#mcpTransport').onchange = mcpTransportRows;
$('#mcpNew').onclick = () => mcpFormShow(null);
$('#mcpCancel').onclick = () => {
  $('#mcpFormCard').classList.remove('on');
};
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
    const yes = await askConfirm(
      $('#mcpFormCard'),
      '¿Confiar en este servidor MCP?',
      'Ejecutará «' +
        (s.command || '(sin comando)') +
        '» en tu equipo con tus permisos. Solo continúa si sabes qué programa es y de dónde viene.',
    );
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
  if (accion === 'edit') return mcpFormShow(MCP_STATE.servers.find((s) => s.id === id));
  if (accion === 'toggle') {
    const s = MCP_STATE.servers.find((x) => x.id === id);
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
    return showToast(r.log ? r.log.split('\n').slice(-3).join(' · ') : r.error || 'El servidor no ha escrito nada.');
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
  if (!b.hidden) {
    $('#mcpPasteText').value = '';
    $('#mcpPasteText').focus();
  }
};
$('#mcpPasteCancel').onclick = () => {
  $('#mcpPasteBox').hidden = true;
};
$('#mcpPasteGo').onclick = async () => {
  const json = $('#mcpPasteText').value.trim();
  if (!json) return mcpMsg('Pega el bloque mcpServers en el cuadro.');
  const r = await window.sagitari.mcpImport(json);
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  const resumen = r.servers.map((s) => s.id + (s.conflict ? ' (reemplaza el actual)' : '')).join(', ');
  const yes = await askConfirm($('#mcpPasteBox'), '¿Añadir estos servidores?', resumen);
  if (!yes) return;
  for (const s of r.servers) await window.sagitari.mcpSave(s);
  $('#mcpPasteBox').hidden = true;
  mcpMsg('Añadidos: ' + resumen);
  renderMcp();
};

/* ============ Ajustes: pestañas, búsqueda y utilidades ============ */

/* Pestañas de Ajustes. El orden y los nombres tienen que coincidir con los pares
   `#tab-*` / `#setpanel-*` de index.html (la búsqueda y el tablist ARIA se apoyan en
   `data-set` ↔ `data-panel`). */
const SET_TABS = ['model', 'apariencia', 'security', 'agent', 'data', 'about'];
let setTabName = 'model';
try {
  const t = localStorage.getItem('sagi.setTab');
  if (SET_TABS.includes(t)) setTabName = t;
} catch {}

/** Muestra una pestaña de Ajustes (y la recuerda para la próxima vez). */
function showSetTab(panel) {
  const name = SET_TABS.includes(panel) ? panel : 'model';
  setTabName = name;
  try {
    localStorage.setItem('sagi.setTab', name);
  } catch {}
  const tabs = $('#setTabs');
  if (tabs) {
    tabs.setAttribute('role', 'tablist');
    tabs.querySelectorAll('.settab').forEach((b) => {
      const on = b.dataset.set === name;
      b.classList.toggle('on', on);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      /* Roving tabindex: solo la pestaña activa entra en el orden de tabulación —con las
         siete dentro, Tab tenía que atravesarlas todas para llegar al contenido—; para
         moverse entre pestañas están las flechas (ver el keydown de abajo). */
      b.setAttribute('tabindex', on ? '0' : '-1');
    });
  }
  const wrap = $('#setWrap');
  if (wrap) wrap.querySelectorAll('.setpanel').forEach((p) => p.classList.toggle('on', p.dataset.panel === name));
  // Seguridad también se pinta al entrar: sus filas MCP reflejan los servidores de la
  // sesión (conectados, con su número de herramientas) y al pintarse una sola vez al
  // arrancar mostraban datos viejos.
  if (name === 'security') renderSecurity();
  // El espacio de trabajo se puede cambiar desde su propia vista (y desde el asistente),
  // así que al entrar en «Datos» se relee: si no, la carpeta que enseña Ajustes puede ser
  // la de antes (y esa etiqueta es lo único que dice dónde aterrizan los archivos).
  if (name === 'data') window.sagitari.workspaceGet().then(pintarEspacioTrabajo).catch((e) => console.warn('no se pudo leer la carpeta de trabajo:', e && e.message));
  // la pestaña «Acerca de» ya enseña el aviso: el punto del sidebar sobra
  // (solo si Ajustes está a la vista: fillSettings llama aquí al arrancar)
  if (name === 'about' && $('#view-settings').classList.contains('on')) setBadge('#nbUpdate', 0);
}
if ($('#setTabs'))
  $('#setTabs')
    .querySelectorAll('.settab')
    .forEach((b) => {
      b.onclick = () => {
        const q = $('#setSearch');
        if (q && q.value) {
          q.value = '';
          filterSettings('');
        }
        showSetTab(b.dataset.set);
      };
    });

/* Navegación por teclado del tablist (patrón ARIA). Con el roving tabindex de arriba,
   las flechas son la única forma de llegar a las demás pestañas. Mueven el foco Y
   activan —el mismo modelo que ya seguía el clic—, así que se reusa el clic en vez de
   duplicar la activación (y así se limpia la búsqueda igual que con el ratón). */
if ($('#setTabs'))
  $('#setTabs').addEventListener('keydown', (e) => {
    const tabs = [...$('#setTabs').querySelectorAll('.settab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
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

/** Filtra los ajustes por texto. Con búsqueda activa se muestran todas las tarjetas
    cuyas filas (`.srow` y `.themerow`) coincidan. */
const SET_ROWS = '.srow, .themerow';
function filterSettings(query) {
  const wrap = $('#setWrap');
  if (!wrap) return;
  const q = String(query || '')
    .trim()
    .toLowerCase();
  wrap.classList.toggle('searching', !!q);
  // Con búsqueda activa se muestran TODOS los paneles (CSS .setwrap.searching
  // .setpanel), así que cuentan las filas de cualquiera de ellos; sin búsqueda
  // solo hay abierto el panel con .on. Contar las filas de un panel cerrado
  // (display:none) daba por buena una búsqueda cuyo único resultado no se veía
  // y, además, ocultaba el aviso «Ningún ajuste coincide».
  const buscando = wrap.classList.contains('searching');
  let shown = 0;
  wrap.querySelectorAll(SET_ROWS).forEach((row) => {
    const hay = ((row.dataset.keys || '') + ' ' + row.textContent).toLowerCase();
    const hit = !q || hay.includes(q);
    row.hidden = !hit;
    const panel = row.closest('.setpanel');
    if (hit && (buscando || !panel || panel.classList.contains('on'))) shown++;
  });
  wrap.querySelectorAll('.setcard').forEach((card) => {
    card.hidden = !!q && ![...card.querySelectorAll(SET_ROWS)].some((r) => !r.hidden);
  });
  const empty = $('#setNoResults');
  if (empty) empty.hidden = !(q && shown === 0);
}
if ($('#setSearch')) $('#setSearch').addEventListener('input', (e) => filterSettings(e.target.value));

/* ============ v4.2: tarjetas avanzadas plegables ============ */
/* El estado (abierta/cerrada) se recuerda por tarjeta en localStorage: quien toca
   los hooks cada día no debería reabrir la tarjeta en cada sesión. */
const ADV_CARDS = ['advLimitsCard', 'advAgentCard'];
function advAplicar(id, on) {
  const card = document.getElementById(id);
  if (!card) return;
  card.classList.toggle('on', on);
  const head = card.querySelector('.advhead');
  if (head) head.setAttribute('aria-expanded', on ? 'true' : 'false');
}
(function initAdvCards() {
  for (const id of ADV_CARDS) {
    let guardado = false;
    try {
      guardado = localStorage.getItem('sagi.adv.' + id) === '1';
    } catch {}
    advAplicar(id, guardado);
    const card = document.getElementById(id);
    const head = card && card.querySelector('.advhead');
    if (!head) continue;
    head.addEventListener('click', () => {
      const on = !card.classList.contains('on');
      advAplicar(id, on);
      try {
        localStorage.setItem('sagi.adv.' + id, on ? '1' : '0');
      } catch {}
    });
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        head.click();
      }
    });
  }
})();

/* ============ v4.2: wizard de primer uso ============ */
/* Aparece sólo cuando no hay modelo activo y el usuario no lo cerró antes (se
   recuerda en localStorage). Reutiliza los mismos IPC que el formulario de la
   pestaña Modelo (listModels / saveProvider / activateProvider), así que no
   duplica lógica: al activar desde aquí, la pestaña queda sincronizada.
   Y elige el proveedor sobre EL MISMO catálogo (`CFG.presets`, que llega de
   config:get): aquí había una lista copiada a mano con 7 de los 22 proveedores, así
   que todo lo que se añadía a main/providers.js —Gemini, DeepSeek, xAI, Mistral,
   Moonshot, Cerebras, Nvidia, los locales por HTTP…— era invisible para quien empieza
   por el wizard. */
let wzPaso = 1;
let wzPreset = null;
/* Protocolo elegido a mano en el paso 2 (solo se pregunta cuando el proveedor no trae su
   Base URL). Hay que recordarlo: al llegar al paso 3 ese desplegable ya no está en el DOM
   y sin esto la elección se perdería al probar y al guardar. */
let wzFormatoElegido = null;
let wzProvGuardado = null;
/* Lo escrito en el paso 2 (Base URL y clave). Vive aquí y no sólo en el DOM porque el
   paso 3 reemplaza el cuerpo del wizard: al cambiar de página, la dirección se perdía
   —y con ella la detección de modelos y la activación en un perfil nuevo, justo el caso
   para el que existe el asistente— y «Atrás» repintaba la del preset vaciando la clave. */
let wzUrl = '';
let wzKey = '';
let wzBusy = false;
function wizardDebeSalirse() {
  return !!(CFG && CFG.active && CFG.active.model);
}
function wizardMostrar() {
  const w = $('#wizardSetup');
  if (!w) return;
  if (wizardDebeSalirse()) {
    w.classList.remove('on');
    return;
  }
  let saltado = false;
  try {
    saltado = localStorage.getItem('sagi.wizardOmitido') === '1';
  } catch {}
  if (saltado) {
    w.classList.remove('on');
    return;
  }
  w.classList.add('on');
  wizardPintar();
}
function wizardPasoPintar() {
  for (let i = 1; i <= 3; i++) {
    const s = $('#wzStep' + i);
    if (s) s.classList.toggle('done', i <= wzPaso);
  }
}
function wizardPintar() {
  const body = $('#wzBody');
  if (!body) return;
  wizardPasoPintar();
  if (wzPaso === 1) {
    body.innerHTML =
      '<div class="wz-choose">' +
      (CFG.presets || [])
        .map(
          (p) =>
            `<button type="button" class="wz-opt${wzPreset === p.id ? ' on' : ''}" data-wz="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.hint || '')}</small></button>`,
        )
        .join('') +
      '</div>' +
      `<div class="wz-note">¿Un servidor propio? Elige «Personalizado (OpenAI-compatible)». Puedes cambiar de proveedor y de modelo cuando quieras desde la pestaña Modelo.</div>`;
    body.querySelectorAll('[data-wz]').forEach((b) => {
      b.onclick = () => {
        wzPreset = b.dataset.wz;
        wzProvGuardado = null;
        wzFormatoElegido = null; // otro proveedor, otra decisión de protocolo
        wzUrl = ''; // y otra base: la del preset nuevo, no la que se hubiera escrito
        wzKey = '';
        wizardPintar();
      };
    });
  } else if (wzPaso === 2) {
    const p = (CFG.presets || []).find((x) => x.id === wzPreset) || {};
    const local = !p.needsKey;
    /* Cuando el proveedor trae su Base URL, el catálogo ya sabe con qué protocolo habla y
       el wizard no pregunta nada. Cuando la dirección la escribe el usuario (el preset
       «Personalizado»), sí se pregunta: hay bases Anthropic de terceros que no lo dicen
       en la ruta, y elegirlo aquí es la única forma de que funcionen a la primera. */
    const propia = !!p.baseUrl;
    body.innerHTML = `
      <div class="field"><label for="wzUrl">Base URL</label><input type="text" id="wzUrl" value="${esc(wzUrl || p.baseUrl || '')}" placeholder="https://…/v1" /></div>
      ${local ? '' : `<div class="field"><label for="wzKey">API KEY</label><input type="password" id="wzKey" value="${esc(wzKey)}" placeholder="sk-… (vacío para Ollama o LM Studio)" /></div>`}
      ${
        propia
          ? ''
          : `<div class="field"><label for="wzFormat">Protocolo de la API</label><select id="wzFormat">
               <option value="auto">Automático (deducirlo)</option>
               <option value="openai">OpenAI — /chat/completions</option>
               <option value="anthropic">Anthropic — /messages</option>
               <option value="responses">OpenAI Responses — /responses</option>
             </select></div>`
      }
      <div class="subnote">${esc(p.hint || '')}${local ? ' No necesita clave: sólo tiene que estar en marcha.' : ''}</div>`;
    // Al volver «Atrás» se recuerda lo que ya se había elegido.
    if ($('#wzFormat') && wzFormatoElegido) $('#wzFormat').value = wzFormatoElegido;
  } else {
    body.innerHTML = `
      <div class="field"><label for="wzModel">Modelo</label><select id="wzModel"><option value="">— detecta modelos primero —</option></select></div>
      <div class="subnote">Elige el modelo con el que trabajará Sagitari. Puedes cambiarlo en cualquier momento desde la pestaña Modelo.</div>`;
  }
  const foot = document.createElement('div');
  foot.className = 'wz-foot';
  const atras =
    wzPaso > 1 ? `<button class="btn ghost" id="wzAtras">Atrás</button>` : `<button class="btn ghost" id="wzCerrar">Cerrar</button>`;
  const next =
    wzPaso < 3
      ? `<button class="btn primary" id="wzNext"${wzPaso === 1 && !wzPreset ? ' disabled' : ''}>Siguiente</button>`
      : `<button class="btn primary" id="wzActivar">Activar modelo</button>`;
  foot.innerHTML = `<span class="wz-msg" id="wzMsg"></span>` + atras + next;
  body.appendChild(foot);
  if ($('#wzCerrar'))
    $('#wzCerrar').onclick = () => {
      try {
        localStorage.setItem('sagi.wizardOmitido', '1');
      } catch {}
      $('#wizardSetup').classList.remove('on');
    };
  if ($('#wzAtras'))
    $('#wzAtras').onclick = () => {
      wzPaso--;
      wizardPintar();
    };
  if ($('#wzNext'))
    $('#wzNext').onclick = () => {
      if (wzPaso === 2) {
        const url = $('#wzUrl').value.trim();
        if (!url) {
          $('#wzMsg').textContent = 'Escribe la Base URL del proveedor.';
          return;
        }
        // El protocolo elegido a mano se guarda para los pasos siguientes (el
        // desplegable desaparece al pasar de página), y con él la dirección y la clave:
        // el paso 3 ya no tiene esos campos, así que aquí es donde se quedan.
        if ($('#wzFormat')) wzFormatoElegido = $('#wzFormat').value || 'auto';
        wzUrl = url;
        wzKey = ($('#wzKey') && $('#wzKey').value) || '';
        const ya = (CFG.providers || []).find((pr) => pr.baseUrl === url);
        if (ya) wzProvGuardado = ya; // reutiliza el proveedor ya guardado con esa URL
      }
      wzPaso++;
      wizardPintar();
    };
  if ($('#wzActivar')) $('#wzActivar').onclick = () => wizardActivar();
  if (wzPaso === 3) wizardDetectar();
}
function wzMsg(t) {
  const el = $('#wzMsg');
  if (el) el.textContent = t || '';
}
async function wizardDetectar() {
  wzMsg('Detectando modelos…');
  /* La base y la clave se leen del estado del wizard, no del DOM: en este paso (#3) sus
     campos ya no existen. Si no hay ninguna escrita se prueba con la del proveedor que
     ya estuviera guardado con esa URL. */
  const url = wzUrl || (wzProvGuardado && wzProvGuardado.baseUrl) || '';
  const key = String(wzKey || '').trim();
  const pre = (CFG.presets || []).find((x) => x.id === wzPreset) || {};
  try {
    // El protocolo viaja con la petición: sin él, una base Anthropic de terceros se
    // sondearía con Bearer y la detección fallaría justo después de haber dicho cómo habla.
    const r = await window.sagitari.listModels(url, key, {
      format: wzFormato(),
      providerId: pre.baseUrl && pre.baseUrl === url ? pre.id : undefined,
    });
    if (!r.ok) {
      wzMsg('Error: ' + r.error);
      return;
    }
    const sel = $('#wzModel');
    sel.innerHTML = '';
    for (const m of r.models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    wzMsg(r.models.length + ' modelos detectados. Elige uno y activa.');
  } catch (e) {
    wzMsg('Error: ' + ((e && e.message) || e));
  }
}
/** Protocolo con el que el wizard prueba y guarda. Manda, por este orden: lo que el
    usuario haya elegido en el paso 2 (solo se pregunta cuando el proveedor no trae su
    Base URL y el protocolo no se puede deducir del catálogo), el del proveedor ya
    guardado con esa URL —pudo cambiarse en la pestaña Modelo— y el que declara el
    propio preset. Antes se guardaba siempre `'auto'`, así que el formato del proveedor
    elegido se perdía: un preset Anthropic guardado por el wizard acababa yendo por la
    ruta de OpenAI. */
function wzFormato() {
  const sel = $('#wzFormat');
  if (sel) return sel.value || 'auto';
  if (wzFormatoElegido) return wzFormatoElegido;
  const p = (CFG.presets || []).find((x) => x.id === wzPreset) || {};
  return (wzProvGuardado && wzProvGuardado.format) || p.format || 'auto';
}
async function wizardActivar() {
  if (wzBusy) return;
  // Igual que en la detección: lo escrito en el paso 2 vive en el estado del wizard.
  const url = wzUrl || (wzProvGuardado && wzProvGuardado.baseUrl) || '';
  const key = String(wzKey || '').trim();
  const model = $('#wzModel') && $('#wzModel').value;
  if (!url || !model) return wzMsg('Detecta modelos y elige uno.');
  const p = (CFG.presets || []).find((x) => x.id === wzPreset) || {};
  const format = wzFormato();
  wzBusy = true;
  try {
    if (!wzProvGuardado) {
      const guardar = await window.sagitari.saveProvider({
        id: 'prov_' + Date.now().toString(36),
        name: p.name || 'Proveedor',
        baseUrl: url,
        apiKey: key,
        format,
        models: [...$('#wzModel').options].map((o) => o.value).filter(Boolean),
      });
      if (guardar && guardar.ok === false) {
        wzMsg('Error: ' + (guardar.error || 'no se pudo guardar'));
        return;
      }
      wzProvGuardado = (CFG.providers || []).find((pr) => pr.baseUrl === url) || { id: null, name: p.name || 'Proveedor', format };
    } else if (wzFormatoElegido) {
      /* Se reutiliza un proveedor ya guardado con esa URL, pero el usuario ha elegido
         protocolo en este paso: se guarda también en él para que la fila «Usar» de la
         pestaña Modelo no siga reenviando el formato viejo. */
      await window.sagitari.saveProvider({ ...wzProvGuardado, format });
      wzProvGuardado = (CFG.providers || []).find((pr) => pr.baseUrl === url) || { ...wzProvGuardado, format };
    }
    const vision = K && K.looksVision ? K.looksVision(model) : false;
    const r = await window.sagitari.activateProvider(
      wzProvGuardado && wzProvGuardado.id
        ? {
            providerId: wzProvGuardado.id,
            name: wzProvGuardado.name,
            baseUrl: url,
            apiKey: key,
            model,
            vision,
            format: wzProvGuardado.format || format,
          }
        : { name: (wzProvGuardado && wzProvGuardado.name) || 'Proveedor', baseUrl: url, apiKey: key, model, vision, format },
    );
    if (r && r.ok === false) {
      wzMsg('Error: ' + (r.error || 'no se pudo activar'));
      return;
    }
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    updateStatusLabels();
    try {
      localStorage.setItem('sagi.wizardOmitido', '1');
    } catch {}
    $('#wizardSetup').classList.remove('on');
    showToast('Modelo activado: ' + model + '. ¡Todo listo para empezar!');
  } catch (e) {
    wzMsg('Error: ' + ((e && e.message) || e));
  } finally {
    wzBusy = false;
  }
}

// mostrar/ocultar la API key
if ($('#apiKeyReveal'))
  $('#apiKeyReveal').onclick = () => {
    const k = $('#pKey');
    const b = $('#apiKeyReveal');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    b.classList.toggle('on', show);
    b.title = show ? 'Ocultar la clave' : 'Mostrar la clave';
    // el estado se dice, no solo se dibuja: sin esto el botón siempre anunciaba
    // «no pulsado» mientras la clave estaba a la vista
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.setAttribute('aria-label', show ? 'Ocultar la clave' : 'Mostrar la clave');
  };

// restablecer límites a los valores recomendados QUE DEFINE EL AGENTE (main los
// expone en meta:get): antes había una segunda lista hardcodeada aquí que podía
// desincronizarse de la del agente y «restablecer» a algo que ya no era lo suyo
if ($('#secResetGuardrails'))
  $('#secResetGuardrails').onclick = async () => {
    try {
      const m = await window.sagitari.metaGet(hiloActual());
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
if ($('#secResetPerms'))
  $('#secResetPerms').onclick = async () => {
    // Si meta:get no llegó a pintar la tabla, se usa la lista de grupos: es la misma
    // tabla del agente escrita aquí solo como respaldo, nunca como fuente.
    const claves = PERM_KEYS.length ? PERM_KEYS : [...PERM_GROUPS.flatMap((g) => g.keys), 'browser_eval'];
    for (const t of claves) await window.sagitari.secSetToolPerm(t, 'default');
    await renderSecurity();
    showToast('Permisos restablecidos a los recomendados');
  };

// datos: hábitos aprendidos + carpeta de datos
/* Mismo listado, mismo orden y mismas categorías que la sección «Cómo trabajas conmigo»
   de la vista Memoria: se reutilizan `MEM_GRUPOS` y `memFilas` (renderer/memoria-ui.js)
   para que la etiqueta humana y la clave que viaja al proceso principal no se separen. */
async function renderHabitsPreview() {
  const box = $('#habitsPreview');
  if (!box) return;
  let s = null;
  try {
    s = await window.sagitari.habitsGet();
  } catch {}
  if (!s) {
    box.innerHTML = '';
    return;
  }
  const bloques = [];
  for (const g of MEM_GRUPOS) {
    const filas = memFilas(g.cat, s[g.cat]).filter((f) => f.name && f.count > 0);
    if (!filas.length) continue;
    const total = filas.reduce((n, f) => n + f.count, 0);
    bloques.push(
      `<div class="hgrupo" data-cat="${esc(g.cat)}"><span class="hgr-t">${ic(g.icono)} ${esc(g.titulo)}</span>` +
        `<span class="hgr-n">${total} ${total === 1 ? 'uso' : 'usos'}</span>` +
        filas.map((f) => `<span class="hpill">${esc(f.name)} ×${f.count}</span>`).join('') +
        `<button class="btn ghost sq" data-olvidar="${esc(g.olvidar)}" title="Olvidar ${esc(g.titulo.toLowerCase())}" aria-label="Olvidar ${esc(g.titulo.toLowerCase())}">${ic('trash')}</button></div>`,
    );
  }
  box.innerHTML = bloques.length
    ? bloques.join('')
    : '<span class="hdim">Todavía no hay hábitos: se aprenden con el uso normal de la app.</span>';
  box.querySelectorAll('[data-olvidar]').forEach((b) => {
    b.onclick = async () => {
      const categoria = b.dataset.olvidar;
      if (!(await askConfirm(b, '¿Olvidar lo observado en ' + memTituloCategoria(categoria) + '?', 'Dejará de usarse para conocerte.')))
        return;
      b.disabled = true;
      const r = await window.sagitari.habitsForget(categoria);
      if (r && r.ok === false) {
        b.disabled = false;
        showToast('No se pudo olvidar: ' + (r.error || 'error desconocido'));
        return;
      }
      await renderHabitsPreview();
      showToast('Hábitos olvidados: ' + memTituloCategoria(categoria));
    };
  });
}
async function initDataPanel() {
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    const p = $('#dataDirPath');
    if (p && m.dataDir) p.textContent = m.dataDir;
  } catch {}
  renderHabitsPreview();
}
if ($('#habitsResetBtn'))
  $('#habitsResetBtn').onclick = async () => {
    const btn = $('#habitsResetBtn');
    if (btn.disabled) return;
    const anchor = btn.closest('.srow') || btn;
    if (
      !(await askConfirm(
        anchor,
        '¿Reiniciar los hábitos aprendidos?',
        'Se borra lo que Sagitari ha deducido de tu uso: apps, comandos, webs y tu modo preferido.',
      ))
    )
      return;
    btn.disabled = true;
    try {
      await window.sagitari.habitsReset();
      await renderHabitsPreview();
      if ($('#view-agents').classList.contains('on')) renderHabits();
      showToast('Hábitos aprendidos reiniciados');
    } finally {
      btn.disabled = false;
    }
  };
if ($('#openDataDirBtn'))
  $('#openDataDirBtn').onclick = async () => {
    const r = await window.sagitari.openDataDir();
    if (r && r.ok === false) showToast(r.error || 'No se pudo abrir la carpeta');
  };

/* ============ Acerca de: actualizaciones (aviso discreto) ============
   El motor vive en main/updater.js (comprobar, descargar, verificar el sha512 y
   lanzar el instalador): aquí solo se pinta el estado y se pide la acción.
   Nada se descarga ni se instala sin un clic del usuario. */
const updState = {
  kind: null,
  current: null,
  latest: null,
  available: false,
  ready: null,
  pending: null,
  status: 'idle',
  error: null,
  progress: null,
};
let updInitDone = false; // la comprobación al abrir Ajustes se hace UNA vez, no en cada render
let updNotified = false; // el toast de «nueva versión» no se repite en toda la sesión
let updUnsignedArmed = false; // primer clic en Instalar con binario sin firmar: el segundo confirma
let updSignerArmed = false; // primer clic con firmante cambiado: el segundo confirma el cambio

/** «2.3.0» → «v2.3.0»; sin versión conocida, un guion. */
function updVer(v) {
  return v ? 'v' + String(v).replace(/^v/i, '') : '—';
}

/** Tamaño legible («12,4 MB») para la nota de progreso. */
function updSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

/** Mensaje de la tarjeta (vacío lo limpia). */
function updMsg(text) {
  const el = $('#updMsg');
  if (el) el.textContent = text || '';
}

/** Pinta la tarjeta «Actualizaciones». GLOBAL para poder comprobarla desde fuera.
    `state = { kind, current, latest, available, ready, pending, status, error, progress }`
    con `status` ∈ 'idle' | 'checking' | 'downloading' | 'ready'.
    `pending` es una instalación que se intentó y no cuajó (la app se cerró para
    instalarse y al volver seguía la versión vieja): se ofrece reintentarla. */
function renderUpdate(state) {
  const v = state || {};
  const s = {
    kind: v.kind || null,
    current: v.current || null,
    latest: v.latest || null,
    available: !!v.available,
    ready: v.ready || null,
    status: v.status || 'idle',
    error: v.error || null,
    progress: v.progress || null,
    pending: v.pending && v.pending.version ? v.pending : null,
  };
  // un archivo con verificación fallida no existe (main lo descarta): `verified`
  // sólo puede valer true cuando hay algo listo para instalar
  const ready = s.ready && s.ready.verified === true ? s.ready : null;

  const ver = updVer(s.current);
  const cur = $('#updCurrent');
  if (cur) cur.textContent = ver;
  const app = $('#aboutVersion');
  if (app) app.textContent = ver;

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
      if (lbl) lbl.textContent = reintento ? 'Reintentar la instalación' : portable ? 'Abrir carpeta' : 'Instalar y cerrar';
      inst.setAttribute(
        'aria-label',
        portable
          ? 'Abrir la carpeta con el archivo descargado'
          : reintento
            ? 'Volver a intentar la instalación de la versión ' + (s.pending.version || '') + '; Sagitari se cerrará para instalarse'
            : 'Instalar la actualización; Sagitari se cerrará para instalarse',
      );
    }
    inst.disabled = busy;
  }

  // progreso: pct + bytes, con aria-valuenow para los lectores de pantalla
  const downloading = s.status === 'downloading';
  const pct = Math.max(0, Math.min(100, Math.round(Number(s.progress && s.progress.pct) || 0)));
  const prow = $('#updProgressRow');
  if (prow) prow.classList.toggle('on', downloading);
  const bar = $('#updBar');
  if (bar) bar.setAttribute('aria-valuenow', String(pct));
  const fill = $('#updBarFill');
  if (fill) fill.style.transform = 'scaleX(' + pct / 100 + ')';
  const bnote = $('#updBarNote');
  if (bnote && downloading) {
    const total = s.progress && s.progress.total;
    bnote.textContent = 'Descargando… ' + pct + ' %' + (total ? ' (' + updSize(s.progress.received) + ' de ' + updSize(total) + ')' : '');
  }

  // notas: modo de ejecución, firma y qué pasará exactamente al instalar
  const notes = [];
  if (s.kind === 'dev') notes.push('Estás ejecutando desde el código fuente; para actualizarte, compila o usa el instalador.');
  if (s.pending && !ready) {
    notes.push(
      s.pending.exists
        ? 'La instalación de la versión ' +
            s.pending.version +
            ' no llegó a completarse (el asistente no pudo instalarla). El archivo sigue descargado: puedes reintentarlo o abrirlo a mano desde ' +
            s.pending.path +
            '.'
        : 'La instalación de la versión ' +
            s.pending.version +
            ' no llegó a completarse y el archivo descargado ya no está: descarga la actualización otra vez.',
    );
  }
  if (ready) {
    if (ready.signed === false)
      notes.push('Esta actualización no está firmada digitalmente: se instala solo con la verificación SHA-512 publicada en la release.');
    else if (ready.signed === true && ready.signer) notes.push('Firmada digitalmente por ' + ready.signer + '.');
    if (s.kind === 'nsis') notes.push('La app se cerrará para instalarse. Vuelve a abrirla cuando termine.');
    if (s.kind === 'portable') notes.push('Cierra la app y ejecuta el archivo nuevo desde la carpeta que se abrirá.');
  }
  const note = $('#updNote');
  if (note) {
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
  }
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
    updState.pending = r.pending || null; // el motor la descarta sola si ya no aplica
    updState.error = r.ok === false ? r.error || 'error desconocido' : null;
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

if ($('#updDownloadBtn'))
  $('#updDownloadBtn').onclick = async () => {
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
      updUnsignedArmed = false; // otra descarga, otra decisión: el consentimiento no se hereda
      updSignerArmed = false;
      renderUpdate(updState);
    } catch (e) {
      updState.status = updState.ready ? 'ready' : 'idle';
      updState.progress = null;
      renderUpdate(updState);
      updMsg('No se pudo descargar: ' + ((e && e.message) || 'error desconocido'));
    }
  };

if ($('#updInstallBtn'))
  $('#updInstallBtn').onclick = async () => {
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
      const extra = updUnsignedArmed ? { confirmUnsigned: true } : updSignerArmed ? { confirmSignerChange: true } : undefined;
      const r = reintento ? await window.sagitari.updateRetry(extra) : await window.sagitari.updateInstall(extra);
      // Puerta de binario sin firmar: el motor exige consentimiento activo en dos
      // pasos (sin modales nativos: el segundo clic ES la confirmación). El aviso
      // queda escrito en la tarjeta, no solo en un toast que se pierde. Vale para
      // instalar y para reintentar: lo pendiente también puede ir sin firmar.
      if (r && r.ok === false && r.needsUnsignedConfirm) {
        updMsg(
          reintento
            ? 'Sin firma digital: solo SHA-512. Pulsa «Reintentar la instalación» OTRA VEZ para confirmar que la instalas igualmente.'
            : 'Sin firma digital: solo SHA-512. Pulsa «Instalar y cerrar» OTRA VEZ para confirmar que la instalas igualmente.',
        );
        renderUpdate(updState);
        updUnsignedArmed = true;
        return;
      }
      // Puerta de cambio de firmante (TOFU): el binario trae otro firmante que las
      // releases anteriores (o perdió la firma). Mismo patrón de doble clic, con su
      // propio aviso para que el usuario sepa QUÉ cambió.
      if (r && r.ok === false && r.needsSignerConfirm) {
        updMsg(
          'El firmante de esta actualización NO coincide con el de versiones anteriores. Pulsa «Instalar y cerrar» OTRA VEZ solo si confías en el cambio.',
        );
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
      if (!r || r.ok === false) {
        updMsg('No se pudo instalar: ' + ((r && r.error) || 'error desconocido'));
        return;
      }
      updMsg(
        r.manual ? 'Archivo listo: ejecútalo desde la carpeta que se acaba de abrir.' : 'Instalando… la app se cerrará para instalarse.',
      );
    } catch (e) {
      updMsg('No se pudo instalar: ' + ((e && e.message) || 'error desconocido'));
    } finally {
      btn.disabled = false; // si la instalación arranca, la app se cierra antes de llegar aquí
    }
  };

if ($('#updPageBtn'))
  $('#updPageBtn').onclick = async () => {
    const r = await window.sagitari.updatePage();
    if (r && r.ok === false) updMsg('No se pudo abrir la página: ' + (r.error || 'error desconocido'));
  };
if ($('#aboutRelBtn')) $('#aboutRelBtn').onclick = () => window.sagitari.updatePage();
if ($('#aboutRepoBtn')) $('#aboutRepoBtn').onclick = () => window.sagitari.openExternal('https://github.com/dario90vlc/sagitari');

/* Eventos del motor. El aviso es discreto: un punto en Ajustes y UN solo toast
   (nada de modales ni de descargas automáticas). */
if (window.sagitari.onUpdate)
  window.sagitari.onUpdate((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'available') {
      if (ev.current) updState.current = ev.current; // la tarjeta ya sabe qué tienes instalado
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

/* Observador de cada interruptor pulido, para poder desconectarlo: un `.sw` repintado
   (la lista de Skills se rehace entera) deja su nodo suelto, y el observador lo
   mantendría vivo —junto con todo lo que cuelga de él— hasta cerrar la app. */
const swObservados = new Map();

/** Interruptores: teclado + estado ARIA, sin tocar sus handlers ya definidos. */
function polishSwitches() {
  for (const [sw, obs] of swObservados) {
    if (!sw.isConnected) {
      obs.disconnect();
      swObservados.delete(sw);
    }
  }
  $$('.sw').forEach((sw) => {
    if (sw.dataset.polished) return;
    sw.dataset.polished = '1';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('tabindex', '0');
    sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
    sw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        sw.click();
      }
    });
    const obs = new MutationObserver(() => sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false'));
    obs.observe(sw, { attributes: true, attributeFilter: ['class'] });
    swObservados.set(sw, obs);
  });
}
polishSwitches();
