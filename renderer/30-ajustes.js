/* SAGITARI renderer — 30-ajustes.js (antes app.js 2754-4113): ajustes, proveedores, seguridad, MCP, hábitos, datos, updater y acerca de
   Script clásico: comparte el scope global con los demás 1x-*.js.
   El orden de carga en index.html preserva el orden original. */
/* global glowStrengthLabel, glassTintLabel, smsg, hiloActual */
/* glowStrengthLabel y glassTintLabel están definidas en 40-vistas.js y hiloActual en
   10-chat.js (scope compartido); smsg está definida en ajustes-util.js */
/* exported fillSettings, wizardMostrar, initAboutPanel, mostrarAvisoConDeshacer, permitirTodoPermisos, restablecerPermisos, renderSecurity */
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
      $('#pName').value = p.name
        .replace(' (local)', '')
        .replace('Personalizado (OpenAI-compatible)', I18N.t('ajustes.proveedor.miApi'));
      $('#pUrl').value = p.baseUrl;
      $('#pKey').value = '';
      $('#modelSel').innerHTML = '<option value="">' + esc(I18N.t('ajustes.modelo.primero')) + '</option>';
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
  // apariencia: aspecto, color de interfaz, color del glow e intensidad
  $('#uiSkin').value = skinActual(CFG.settings);
  // idioma: el que quedó guardado (o «auto»); no se valida aquí porque main ya lo hace
  if ($('#uiLang')) $('#uiLang').value = CFG.settings.uiLang || 'auto';
  $('#glowColor').value =
    !CFG.settings.glowColor || CFG.settings.glowColor === 'match'
      ? 'match'
      : PALETTES[CFG.settings.glowColor]
        ? CFG.settings.glowColor
        : 'match';
  $('#glowStrength').value = String(Math.min(2, Math.max(0.4, Number(CFG.settings.glowStrength) || 0.7)));
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
  if (!url) return smsg(I18N.t('ajustes.modelo.url.falta'));
  smsg(I18N.t('ajustes.modelo.detectando'));
  /* El protocolo elegido viaja con la petición: sin él, una base Anthropic de terceros
     (sin «/anthropic» en la ruta) se sondeaba con Bearer en vez de x-api-key y la
     detección fallaba justo cuando el usuario acababa de decir cómo habla ese servidor. */
  const pre = (CFG.presets || []).find((p) => p.id === $('#presetSel').value) || {};
  const r = await window.sagitari.listModels(url, $('#pKey').value.trim(), {
    format: apiFormatValue(),
    providerId: pre.baseUrl && pre.baseUrl === url ? pre.id : undefined,
  });
  if (!r.ok) return smsg(I18N.t('ajustes.error', { motivo: r.error }));
  const sel = $('#modelSel');
  sel.innerHTML = '';
  for (const m of r.models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  smsg(I18N.t('ajustes.modelo.detectados', { n: r.models.length }));
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
      if (r && r.ok === false)
        return smsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.protocolo.error.guardar') }));
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
      if (r && r.ok === false)
        return smsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.protocolo.error.aplicar') }));
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels();
    }
    smsg(
      guardado || activo
        ? I18N.t('ajustes.protocolo.aplicado', { protocolo: texto })
        : I18N.t('ajustes.protocolo.elegido', { protocolo: texto }),
    );
  };

$('#btnSaveProv').onclick = async () => {
  const btn = $('#btnSaveProv');
  if (btn.disabled) return;
  if (!$('#pUrl').value.trim()) return smsg(I18N.t('ajustes.modelo.url.faltaProveedor'));
  btn.disabled = true;
  try {
    const r = await window.sagitari.saveProvider({
      id: 'prov_' + Date.now().toString(36),
      name: $('#pName').value.trim() || I18N.t('ajustes.proveedor.nombre'),
      baseUrl: $('#pUrl').value.trim(),
      apiKey: $('#pKey').value.trim(),
      format: apiFormatValue(),
      models: [...$('#modelSel').options].map((o) => o.value).filter(Boolean),
    });
    // main valida la URL y puede rechazar: la UI no puede decir «guardado» sin comprobarlo
    if (r && r.ok === false) return smsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.error.guardar') }));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg(I18N.t('ajustes.proveedor.guardado'));
  } catch (e) {
    smsg(I18N.t('ajustes.error', { motivo: (e && e.message) || e }));
  } finally {
    btn.disabled = false;
  }
};
$('#btnActivate').onclick = async () => {
  const btn = $('#btnActivate');
  if (btn.disabled) return;
  const baseUrl = $('#pUrl').value.trim(),
    model = $('#modelSel').value;
  if (!baseUrl || !model) return smsg(I18N.t('ajustes.modelo.elegirPrimero'));
  const vision = looksVision(model);
  btn.disabled = true;
  try {
    const r = await window.sagitari.activateProvider({
      name: $('#pName').value.trim() || I18N.t('ajustes.proveedor.nombre'),
      baseUrl,
      apiKey: $('#pKey').value.trim(),
      model,
      vision,
      format: apiFormatValue(),
    });
    // activar también valida: si falla, NO se pinta «activo»/«Conectado»
    if (r && r.ok === false) return smsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.error.activar') }));
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    smsg(I18N.t('ajustes.modelo.activado', { modelo: model }));
    updateStatusLabels();
  } catch (e) {
    smsg(I18N.t('ajustes.error', { motivo: (e && e.message) || e }));
  } finally {
    btn.disabled = false;
  }
};

function renderProviderList() {
  const box = $('#provList');
  box.innerHTML = '';
  hintStoredKey(); // la lista cambió (guardar/borrar/activar): el aviso del campo se recalcula
  if (!CFG.providers.length) {
    box.innerHTML = '<div class="subnote">' + esc(I18N.t('ajustes.proveedor.vacio')) + '</div>';
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
    /* El diccionario no lleva marcado: la negrita se pone aquí y cada trozo es una clave
       (mismo patrón que las leyes de «Espacio de trabajo»). */
    av.innerHTML =
      '<b>' +
      esc(I18N.t('ajustes.clave.ilegible.titulo')) +
      '</b> ' +
      esc(I18N.t('ajustes.clave.ilegible.texto', { nombres: nombres.join(', ') }));
    box.appendChild(av);
  }
  for (const p of CFG.providers) {
    const item = document.createElement('div');
    item.className = 'provitem';
    const inUse = CFG.active && (CFG.active.providerId === p.id || CFG.active.baseUrl === p.baseUrl);
    item.innerHTML = `<span class="nm">${esc(p.name)} <span class="md">· ${esc(I18N.t('ajustes.proveedor.modelos', { n: (p.models || []).length }))}</span></span>${inUse ? `<span class="badge">${esc(I18N.t('ajustes.proveedor.enUso'))}</span>` : ''}
      <button class="btn ghost sq" data-act="use" title="${esc(I18N.t('ajustes.proveedor.usar'))}">${ic('play')}</button><button class="btn ghost sq danger" data-act="del" title="${esc(I18N.t('ajustes.proveedor.eliminar'))}">${ic('trash')}</button>`;
    item.querySelector('[data-act=use]').onclick = async () => {
      const model = (p.models || [])[0];
      if (!model) return smsg(I18N.t('ajustes.proveedor.sinModelos'));
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
      if (r && r.ok === false) return smsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.error.activar') }));
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels();
      smsg(I18N.t('ajustes.proveedor.usando', { nombre: p.name }));
    };
    item.querySelector('[data-act=del]').onclick = async () => {
      if (!(await askConfirm(item, I18N.t('ajustes.proveedor.borrar.confirmar', { nombre: p.name })))) return;
      await window.sagitari.deleteProvider(p.id);
      CFG = await window.sagitari.getConfig();
      renderProviderList();
      updateStatusLabels(); // si era el activo, main lo desactiva: que se vea
      showToast(I18N.t('ajustes.proveedor.borrado'));
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
    el.placeholder = I18N.t('ajustes.clave.ph.ilegible', { nombre: guardado.name });
    return;
  }
  el.placeholder = guardado
    ? I18N.t('ajustes.clave.ph.guardada', { nombre: guardado.name })
    : I18N.t('ajustes.apikey.ph');
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
    showToast(I18N.t('ajustes.datos.espacio.cambiado', { ruta: r.path }));
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
  syncGlowTiles();
}

/* ---- fila del glow: una decisión, no quince ----
   Mientras el glow sigue al color de la interfaz (el valor por defecto), los 7
   colores de la segunda fila repetían los mismos 7 nombres de arriba: quince
   chips seguidos y el riesgo de teñir la fila equivocada. Se enseñan sólo
   cuando el usuario ha pedido un color distinto; «Otro color…» abre la fila sin
   cambiar el ajuste todavía. */
function syncGlowTiles() {
  const sel = document.getElementById('glowColor');
  const box = document.getElementById('glowColorTiles');
  if (!sel || !box) return;
  const propio = sel.value !== 'match';
  box.classList.toggle('open', propio);
  const hint = document.getElementById('glowColorHint');
  if (hint)
    hint.textContent = propio ? I18N.t('ajustes.glow.hint.propio') : I18N.t('ajustes.glow.hint.igual');
}

/* ---- paletas visuales: las muestras escriben en el select oculto, que sigue
   siendo la fuente de verdad del ajuste (y lo que guarda la app). ---- */
function paintTiles() {
  const ui = document.getElementById('uiColor');
  const gl = document.getElementById('glowColor');
  const skin = document.getElementById('uiSkin');
  if (ui)
    document.querySelectorAll('#uiColorTiles .pal').forEach((b) => b.classList.toggle('on', b.dataset.pal === ui.value));
  if (gl)
    document.querySelectorAll('#glowColorTiles .pal').forEach((b) => b.classList.toggle('on', b.dataset.pal === gl.value));
  if (skin)
    document.querySelectorAll('#uiSkinTiles .pal').forEach((b) => b.classList.toggle('on', b.dataset.pal === skin.value));
}
document.querySelectorAll('.pals .pal').forEach((b) => {
  b.addEventListener('click', () => {
    // «Otro color…» no lleva data-pal: sólo abre la fila (ver syncGlowTiles).
    if (!b.dataset.pal) return;
    const row = b.closest('.themerow');
    const sel = row && row.querySelector('select');
    if (!sel) return;
    sel.value = b.dataset.pal;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    paintTiles();
  });
});
const glowOtherBtn = document.getElementById('glowOtherBtn');
if (glowOtherBtn)
  glowOtherBtn.addEventListener('click', () => {
    const box = document.getElementById('glowColorTiles');
    if (box) box.classList.add('open');
    const hint = document.getElementById('glowColorHint');
    if (hint) hint.textContent = I18N.t('ajustes.glow.hint.elegir');
  });
const btnChangeModel = document.getElementById('btnChangeModel');
if (btnChangeModel)
  btnChangeModel.addEventListener('click', () => {
    const t = document.getElementById('tab-model');
    if (t) t.click();
  });

/* El aspecto se aplica AL MOMENTO: no recarga nada y no toca el color elegido. Los dos
   planos conservan tu paleta como acento; lo que cambia es la materia (ver skins.css). */
$('#uiSkin').onchange = async (e) => {
  const valor = SKINS.includes(e.target.value) ? e.target.value : 'holo';
  CFG.settings.uiSkin = valor;
  applyTheme();
  paintTiles();
  await window.sagitari.setSettings({ uiSkin: valor });
};
/* El idioma NO se repinta en vivo: los textos ya pintados seguirían en el otro idioma a
   medias, así que se guarda y se avisa de que hace falta reiniciar. Si el disco falla se
   revierte el select para que no enseñe una elección que no se guardó. */
if ($('#uiLang'))
  $('#uiLang').onchange = async (e) => {
    const valor = ['auto', 'es', 'en'].includes(e.target.value) ? e.target.value : 'auto';
    const anterior = CFG.settings.uiLang || 'auto';
    CFG.settings.uiLang = valor;
    const r = await window.sagitari.setSettings({ uiLang: valor });
    if (r && r.saveError) {
      CFG.settings.uiLang = anterior;
      e.target.value = anterior;
      showToast(I18N.t('ajustes.idioma.error'));
      return;
    }
    showToast(I18N.t('ajustes.idioma.guardado'));
  };
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
    showToast(I18N.t('ajustes.personal.nombre.error'));
  }
};

// ---- seguridad: permisos por herramienta + guardarraíles (v1.1) ----
/* QUÉ herramientas hay y qué nivel recomienda cada una lo dice el AGENTE
   (agent/tools.js → meta:get.riskDefaults), que es la única fuente: aquí había una
   lista copiada a mano con 8 filas de las 31 claves reales, así que todo lo que se
   añadió después (apply_patch, open_url, web_fetch, los git…) no se podía permitir ni
   bloquear desde Ajustes. Se pinta la tabla ENTERA, agrupada por familia para que se
   lea, y una clave que no esté en ningún grupo no se esconde: cae en «Otras».
   Lo único que se escribe a mano aquí es qué clave del diccionario nombra cada cosa
   (`PERM_INFO`); si falta, se usa el nombre humanizado que da el catálogo (K.tool). */
const PERM_GROUPS = [
  {
    id: 'archivos',
    titulo: 'ajustes.perm.grupo.archivos',
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
  { id: 'terminal', titulo: 'ajustes.perm.grupo.terminal', keys: ['run_command'] },
  {
    id: 'escritorio',
    titulo: 'ajustes.perm.grupo.escritorio',
    keys: ['open_app', 'open_url', 'clipboard', 'notify', 'media_control', 'window_manage', 'screenshot', 'system_info'],
  },
  { id: 'navegador', titulo: 'ajustes.perm.grupo.navegador', keys: ['browser_control', 'browser_eval'] },
  { id: 'git', titulo: 'ajustes.perm.grupo.git', keys: ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit'] },
  { id: 'web', titulo: 'ajustes.perm.grupo.web', keys: ['web_fetch'] },
  { id: 'agente', titulo: 'ajustes.perm.grupo.agente', keys: ['remember', 'use_skill', 'todo_write', 'delegate'] },
];
/* Los `titulo` y las descripciones son CLAVES del diccionario, no frases: el nombre de
   cada fila y qué hace se pintan con `I18N.t(...)` (antes vivían aquí en castellano). */
const PERM_INFO = {
  read_file: 'ajustes.perm.info.read_file',
  write_file: 'ajustes.perm.info.write_file',
  edit_file: 'ajustes.perm.info.edit_file',
  apply_patch: 'ajustes.perm.info.apply_patch',
  list_dir: 'ajustes.perm.info.list_dir',
  search_files: 'ajustes.perm.info.search_files',
  search_code: 'ajustes.perm.info.search_code',
  find_symbol: 'ajustes.perm.info.find_symbol',
  repo_map: 'ajustes.perm.info.repo_map',
  view_image: 'ajustes.perm.info.view_image',
  run_command: 'ajustes.perm.info.run_command',
  open_app: 'ajustes.perm.info.open_app',
  open_url: 'ajustes.perm.info.open_url',
  clipboard: 'ajustes.perm.info.clipboard',
  notify: 'ajustes.perm.info.notify',
  media_control: 'ajustes.perm.info.media_control',
  window_manage: 'ajustes.perm.info.window_manage',
  screenshot: 'ajustes.perm.info.screenshot',
  system_info: 'ajustes.perm.info.system_info',
  browser_control: 'ajustes.perm.info.browser_control',
  browser_eval: 'ajustes.perm.info.browser_eval',
  git_status: 'ajustes.perm.info.git_status',
  git_diff: 'ajustes.perm.info.git_diff',
  git_log: 'ajustes.perm.info.git_log',
  git_branch: 'ajustes.perm.info.git_branch',
  git_commit: 'ajustes.perm.info.git_commit',
  web_fetch: 'ajustes.perm.info.web_fetch',
  remember: 'ajustes.perm.info.remember',
  use_skill: 'ajustes.perm.info.use_skill',
  todo_write: 'ajustes.perm.info.todo_write',
  delegate: 'ajustes.perm.info.delegate',
};
const PERM_OTRAS = 'ajustes.perm.grupo.otras';
/* El nivel 'safe' se llamaba «Seguro», que se lee como «más protección» cuando en
   realidad significa «se ejecuta SIN preguntar». El nombre dice ahora su efecto.
   Se resuelve al LEERLO (getter) porque la tabla de 40-vistas indexa este mapa tal cual
   y el idioma se decide al cargar: con valores fijos, esa tabla se quedaría en un solo
   idioma. */
const RISK_LABEL = {
  get safe() {
    return I18N.t('nivel.safe');
  },
  get confirm() {
    return I18N.t('nivel.confirm');
  },
  get restricted() {
    return I18N.t('nivel.restricted');
  },
};
/* La clave del nivel elegido, escrita ENTERA: el barrido de claves del arnés lee
   literales completos y `'nivel.' + valor` no le enseña ninguna de las cuatro. */
const NIVEL_CLAVE = {
  default: 'nivel.default',
  safe: 'nivel.safe',
  confirm: 'nivel.confirm',
  restricted: 'nivel.restricted',
};
/* Claves reales de la tabla del agente, rellenadas al pintar Seguridad (ver
   _renderSecurity): las usa «Restablecer permisos recomendados».
   `PERM_LABEL`: nombres bonitos que no están en el catálogo del chat (browser_eval no
   es una herramienta suelta, es la acción «eval» de browser_control). */
let PERM_KEYS = [];
const PERM_LABEL = { browser_eval: 'ajustes.perm.label.browser_eval' };

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
    h.textContent = I18N.t(g.titulo);
    permBox.appendChild(h);
    for (const n of g.keys) {
      const lvl = (cfg.permissions && cfg.permissions[n]) || 'default';
      const rec = RISK_LABEL[cfg.riskDefaults[n]] || I18N.t('nivel.confirm');
      /* `PERM_LABEL` y el catálogo del chat guardan la etiqueta de otra forma: el primero
         es una clave de este diccionario y el segundo ya viene traducido por chatkit. */
      const nombre = PERM_LABEL[n] ? I18N.t(PERM_LABEL[n]) : K.tool(n).label; // nunca la clave interna
      const desc = I18N.t(PERM_INFO[n] || g.titulo);
      const row = document.createElement('div');
      row.className = 'permrow';
      row.innerHTML = `<span class="mt"><b>${esc(nombre)}</b><br><small class="md">${esc(desc)}</small><br><small class="pd">${esc(I18N.t('ajustes.perm.recomendado', { nivel: rec }))}</small></span>
      <select data-tool="${esc(n)}" aria-label="${esc(I18N.t('ajustes.perm.aria', { nombre }))}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.defecto'))}</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.siempre'))}</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.preguntar'))}</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.bloqueado'))}</option>
      </select>`;
      const previo = lvl;
      row.querySelector('select').onchange = async (e) => {
        const r = await window.sagitari.secSetToolPerm(n, e.target.value);
        /* main restaura su copia si el disco falló: la interfaz no puede quedarse con un
           nivel que no se guardó (mismo criterio que workspace:set / mode:set). */
        if (r && r.ok === false) {
          e.target.value = previo;
          if (typeof cselPintar === 'function') cselPintar(e.target);
          showToast(
            I18N.t('ajustes.perm.error', {
              nombre,
              motivo: r.error || I18N.t('ajustes.error.desconocido'),
            }),
          );
          return;
        }
        /* El nivel se dice por clave (`nivel.*`), no leyendo el texto del desplegable:
           con el idioma en inglés, `toLowerCase()` de una etiqueta traducida no es una
           frase que quepa en el aviso. */
        showToast(
          I18N.t('ajustes.perm.guardado', { nombre, nivel: I18N.t(NIVEL_CLAVE[e.target.value] || 'nivel.default') }),
        );
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
    hMcp.textContent = I18N.t('ajustes.perm.grupo.mcp');
    permBox.appendChild(hMcp);
  }
  for (const s of mcp.servers || []) {
    const wildcard = s.permKey || 'mcp__' + s.id + '__*';
    const lvl = (cfg.permissions && cfg.permissions[wildcard]) || 'default';
    const n = (s.discovered || []).length;
    const row = document.createElement('div');
    row.className = 'permrow';
    const cuantas = I18N.t(n === 1 ? 'ajustes.perm.mcp.herramientas.uno' : 'ajustes.perm.mcp.herramientas.varios', { n });
    row.innerHTML = `<span class="mt"><b>${esc(s.name)}</b> <small class="md">MCP</small><br><small class="md">${esc(cuantas)}</small><br><small class="pd">${esc(I18N.t('ajustes.perm.mcp.nota'))}</small></span>
      <select data-tool="${esc(wildcard)}" aria-label="${esc(I18N.t('ajustes.perm.mcp.aria', { nombre: s.name }))}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.defecto'))}</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.siempre'))}</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.preguntar'))}</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>${esc(I18N.t('ajustes.perm.bloqueado'))}</option>
      </select>`;
    const previo = lvl;
    row.querySelector('select').onchange = async (e) => {
      const r = await window.sagitari.secSetToolPerm(wildcard, e.target.value);
      if (r && r.ok === false) {
        e.target.value = previo;
        if (typeof cselPintar === 'function') cselPintar(e.target);
        showToast(
          I18N.t('ajustes.perm.mcp.error', {
            nombre: s.name,
            motivo: r.error || I18N.t('ajustes.error.desconocido'),
          }),
        );
        return;
      }
      showToast(
        I18N.t('ajustes.perm.mcp.guardado', {
          nombre: s.name,
          nivel: I18N.t(NIVEL_CLAVE[e.target.value] || 'nivel.default'),
        }),
      );
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
/** Guarda un guardarraíl y, si main no pudo escribirlo, repinta los campos desde
    `meta:get`: main ya restauró su copia y la interfaz no puede quedarse con otro valor
    (mismo criterio que workspace:set / mode:set). */
function guardarGuardrail(patch) {
  return window.sagitari.secSetGuardrail(patch).then(async (r) => {
    if (r && r.ok === false) {
      showToast(I18N.t('ajustes.limite.error', { motivo: r.error || I18N.t('ajustes.error.desconocido') }));
      try {
        await initSecurity();
      } catch {}
    }
  });
}
$('#grSteps').onchange = (e) => guardarGuardrail({ maxSteps: clampGuardrail(e.target, 0) });
$('#grToolCalls').onchange = (e) => guardarGuardrail({ maxToolCalls: clampGuardrail(e.target, 0) });
$('#grMinutes').onchange = (e) => guardarGuardrail({ maxDurationMs: clampGuardrail(e.target, 0) * 60000 });
$('#grTokens').onchange = (e) => guardarGuardrail({ maxTokens: clampGuardrail(e.target, 0) });
$('#grLoop').onchange = (e) => guardarGuardrail({ loopThreshold: clampGuardrail(e.target, 3) });
if ($('#grCost')) $('#grCost').onchange = (e) => guardarGuardrail({ maxCostUsd: clampGuardrail(e.target, 0) });
if ($('#grStall')) $('#grStall').onchange = (e) => guardarGuardrail({ stallThreshold: clampGuardrail(e.target, 0) });
if ($('#grDelegations'))
  $('#grDelegations').onchange = (e) => guardarGuardrail({ maxDelegations: clampGuardrail(e.target, 8) });
/* v4.4: el presupuesto del equipo se guarda como ajuste (equipoPresupuestoUsd) y admite
   decimales —es dinero, no un número de pasos—, así que no pasa por clampGuardrail. */
if ($('#eqPresupuesto'))
  $('#eqPresupuesto').onchange = async (e) => {
    const v = Number(String(e.target.value).replace(',', '.'));
    const usd = Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0; // 0 = sin tope propio
    /* main descarta el valor que supera su tope: el campo y el aviso se pintan con el que
       quedó guardado de verdad, no con el que se tecleó. */
    const r = await window.sagitari.setSettings({ equipoPresupuestoUsd: usd });
    const guardado = Number((r && r.equipoPresupuestoUsd) || 0);
    e.target.value = guardado;
    showToast(
      guardado
        ? I18N.t('ajustes.equipo.presupuesto', { n: guardado.toFixed(2) })
        : I18N.t('ajustes.equipo.sinTope'),
    );
  };
if ($('#parTools'))
  $('#parTools').onchange = async (e) => {
    const v = clampGuardrail(e.target, 3); // 1 = en orden, como antes
    CFG.settings.parallelTools = v;
    await window.sagitari.setSettings({ parallelTools: v });
    showToast(v === 1 ? I18N.t('ajustes.paralelo.uno') : I18N.t('ajustes.paralelo.varios', { n: v }));
  };
if ($('#grLlmTimeout'))
  $('#grLlmTimeout').onchange = async (e) => {
    const v = clampGuardrail(e.target, 120);
    await window.sagitari.setSettings({ llmTimeoutMs: v * 1000 });
    showToast(v ? I18N.t('ajustes.espera.limite', { n: v }) : I18N.t('ajustes.espera.sinLimite'));
  };
if ($('#setMaxTasks'))
  $('#setMaxTasks').onchange = async (e) => {
    const v = Math.max(1, Math.min(4, Number(e.target.value) || 1));
    e.target.value = v;
    await window.sagitari.setSettings({ maxConcurrentTasks: v });
    showToast(I18N.t('ajustes.tareas.vez.aviso', { n: v }));
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
    showToast(on ? I18N.t('ajustes.revisar.on') : I18N.t('ajustes.revisar.off'));
  };
if ($('#swCache'))
  $('#swCache').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.promptCache = on;
    await window.sagitari.setSettings({ promptCache: on });
    showToast(on ? I18N.t('ajustes.cache.on') : I18N.t('ajustes.cache.off'));
  };
if ($('#swDiagnosticos'))
  $('#swDiagnosticos').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.diagnosticosEscritura = on;
    await window.sagitari.setSettings({ diagnosticosEscritura: on });
    showToast(on ? I18N.t('ajustes.comprobar.on') : I18N.t('ajustes.comprobar.off'));
  };
if ($('#swCierre'))
  $('#swCierre').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.verificacionCierre = on;
    await window.sagitari.setSettings({ verificacionCierre: on });
    showToast(on ? I18N.t('ajustes.pruebas.on') : I18N.t('ajustes.pruebas.off'));
  };
if ($('#swArboles'))
  $('#swArboles').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.arbolesAislados = on;
    await window.sagitari.setSettings({ arbolesAislados: on });
    showToast(on ? I18N.t('ajustes.arboles.on') : I18N.t('ajustes.arboles.off'));
  };
if ($('#swAutoEdits'))
  $('#swAutoEdits').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.autoEdits = on;
    await window.sagitari.setSettings({ autoEdits: on });
    showToast(on ? I18N.t('ajustes.autoEdits.on') : I18N.t('ajustes.autoEdits.off'));
  };
if ($('#verAttempts'))
  $('#verAttempts').onchange = async (e) => {
    const v = Math.max(0, Math.min(5, Number(e.target.value) || 0));
    e.target.value = v;
    CFG.settings.intentosArreglo = v;
    await window.sagitari.setSettings({ intentosArreglo: v });
    showToast(v ? I18N.t('ajustes.intentos.aviso', { n: v }) : I18N.t('ajustes.intentos.ninguno'));
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
    cont.innerHTML = '<span class="instrnone">' + esc(I18N.t('ajustes.reglas.vacio')) + '</span>';
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
            ? ' <em>' + esc(I18N.t('ajustes.reglas.globales')) + '</em>'
            : ' <em>' +
              esc(
                I18N.t(f.recortado ? 'ajustes.reglas.chars.recortado' : 'ajustes.reglas.chars', { n: f.chars || 0 }),
              ) +
              '</em>') +
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
    showToast(I18N.t('ajustes.reglas.releidas'));
  };
if ($('#instrCreate'))
  $('#instrCreate').onclick = async () => {
    try {
      const r = await window.sagitari.instruccionesCrear();
      if (r && r.yaExistia) {
        showToast(I18N.t('ajustes.reglas.existe', { ruta: r.ruta }));
        return;
      }
      if (r && r.ok) {
        await paintInstrucciones();
        showToast(I18N.t('ajustes.reglas.creado', { ruta: r.ruta }));
      } else
        showToast(
          I18N.t('ajustes.reglas.crear.error', { motivo: (r && r.error) || I18N.t('ajustes.error.desconocido') }),
        );
    } catch (e) {
      showToast(I18N.t('ajustes.reglas.crear.fallo'));
    }
  };
const guardarHook = (id, campo, aviso) => {
  const el = $(id);
  if (!el) return;
  el.onchange = async () => {
    const v = String(el.value || '').trim();
    if (/\n/.test(String(el.value || ''))) showToast(I18N.t('ajustes.hook.unaLinea'));
    el.value = v;
    CFG.settings[campo] = v;
    await window.sagitari.setSettings({ [campo]: v });
    showToast(v ? aviso : I18N.t('ajustes.hook.desactivado'));
  };
};
guardarHook('#hookEditar', 'hookEditar', I18N.t('ajustes.hook.editar.aviso'));
guardarHook('#hookCerrar', 'hookCerrar', I18N.t('ajustes.hook.cerrar.aviso'));
if ($('#swThinking'))
  $('#swThinking').onclick = async (e) => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    CFG.settings.showThinking = on;
    await window.sagitari.setSettings({ showThinking: on });
    showToast(on ? I18N.t('ajustes.razonamiento.on') : I18N.t('ajustes.razonamiento.off'));
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

/** Estados del servidor, tal y como los ve el usuario (texto ya traducido). */
function mcpStatusLabel(s) {
  if (!s.enabled) return { text: I18N.t('ajustes.mcp.estado.apagado'), cls: 'off' };
  const n = (s.discovered || []).length;
  if (s.state === 'ready')
    return {
      text: I18N.t(n === 1 ? 'ajustes.mcp.estado.listo.uno' : 'ajustes.mcp.estado.listo.varios', { n }),
      cls: 'ok',
    };
  if (s.state === 'starting') return { text: I18N.t('ajustes.mcp.estado.conectando'), cls: 'wait' };
  if (s.state === 'dead')
    return {
      text: I18N.t('ajustes.error', { motivo: s.error || I18N.t('ajustes.mcp.estado.sinArrancar') }),
      cls: 'err',
    };
  return { text: I18N.t('ajustes.mcp.estado.sinProbar'), cls: 'off' };
}

async function renderMcp() {
  const box = $('#mcpList');
  if (!box) return;
  try {
    MCP_STATE = await window.sagitari.mcpList();
  } catch (e) {
    showToast(I18N.t('ajustes.mcp.leer.error', { motivo: e.message }));
    return;
  }
  $('#mcpGlobal').classList.toggle('on', MCP_STATE.enabled !== false);
  if (!(MCP_STATE.servers || []).length) {
    box.innerHTML = '<div class="mcpempty">' + esc(I18N.t('ajustes.mcp.vacio')) + '</div>';
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
        <span class="mcpdo">${s.transport === 'http' ? 'URL' : esc(I18N.t('ajustes.mcp.local'))}</span>
      </div>
      <div class="mcptools">${lista}</div>
      <div class="mcpacts">
        <button class="btn ghost" data-mcp="test">${esc(I18N.t('ajustes.mcp.probar'))}</button>
        <button class="btn ghost" data-mcp="log">${esc(I18N.t('ajustes.mcp.verLog'))}</button>
        <button class="btn ghost" data-mcp="edit">${esc(I18N.t('ajustes.mcp.editar'))}</button>
        <button class="btn ghost" data-mcp="toggle">${esc(I18N.t(s.enabled ? 'ajustes.mcp.desactivar' : 'ajustes.mcp.activar'))}</button>
        <button class="btn ghost" data-mcp="del">${esc(I18N.t('ajustes.mcp.eliminar'))}</button>
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
  $('#mcpFormTitle').textContent = I18N.t(server ? 'ajustes.mcp.titulo.editar' : 'ajustes.mcp.titulo.nuevo');
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
      I18N.t('ajustes.mcp.confiar.titulo'),
      I18N.t('ajustes.mcp.confiar.detalle', {
        comando: s.command || I18N.t('ajustes.mcp.sinComando'),
      }),
    );
    if (!yes) return;
  }
  const r = await window.sagitari.mcpSave(s);
  if (!r.ok) return mcpMsg(I18N.t('ajustes.error', { motivo: r.error }));
  // El nivel elegido se aplica SIEMPRE al comodín del servidor (el MISMO que edita
  // Seguridad), también con 'default': así el desplegable no es decorativo y se puede
  // volver atrás (sec:setToolPerm borra el comodín cuando recibe 'default'). La clave la
  // devuelve main ya normalizada (`permKey`): construirla con el id crudo dejaría el
  // nivel sin aplicar en cuanto el id traiga guiones o pase de 16 caracteres.
  const wildcard = r.permKey || (r.id ? 'mcp__' + r.id + '__*' : '');
  if (wildcard && nivel) await window.sagitari.secSetToolPerm(wildcard, nivel);
  $('#mcpFormCard').classList.remove('on');
  mcpMsg(I18N.t('ajustes.mcp.guardado'));
  const t = await window.sagitari.mcpTest(r.id || s.id);
  mcpMsg(
    t.ok
      ? I18N.t('ajustes.mcp.conectado', { n: t.server ? t.server.discovered.length : 0 })
      : I18N.t('ajustes.mcp.noConecta', { motivo: t.error }),
  );
  renderMcp();
};
$('#mcpFormDelete').onclick = async () => {
  const id = $('#mcpId').value.trim();
  const yes = await askConfirm(
    $('#mcpFormCard'),
    I18N.t('ajustes.mcp.borrar.confirmar', { id }),
    I18N.t('ajustes.mcp.borrar.detalle'),
  );
  if (!yes) return;
  const r = await window.sagitari.mcpDelete(id);
  $('#mcpFormCard').classList.remove('on');
  mcpMsg(r.ok ? I18N.t('ajustes.mcp.borrado') : I18N.t('ajustes.error', { motivo: r.error }));
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
    const yes = await askConfirm(
      btn,
      I18N.t('ajustes.mcp.borrar.confirmarCorto', { id }),
      I18N.t('ajustes.mcp.borrar.detalle'),
    );
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
    return showToast(r.log ? r.log.split('\n').slice(-3).join(' · ') : r.error || I18N.t('ajustes.mcp.sinSalida'));
  }
  if (accion === 'test') {
    btn.textContent = I18N.t('ajustes.mcp.probando');
    const r = await window.sagitari.mcpTest(id);
    btn.textContent = I18N.t('ajustes.mcp.probar');
    mcpMsg(
      r.ok
        ? I18N.t('ajustes.mcp.conectado', { n: r.server ? r.server.discovered.length : 0 })
        : I18N.t('ajustes.mcp.noConecta', { motivo: r.error }),
    );
    return renderMcp();
  }
};
$('#mcpExportBtn').onclick = async () => {
  const r = await window.sagitari.mcpExport();
  if (!r.ok) return mcpMsg(I18N.t('ajustes.error', { motivo: r.error }));
  copyText(r.json, I18N.t('ajustes.mcp.json.copiado'));
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
  if (!json) return mcpMsg(I18N.t('ajustes.mcp.pegar.json'));
  const r = await window.sagitari.mcpImport(json);
  if (!r.ok) return mcpMsg(I18N.t('ajustes.error', { motivo: r.error }));
  const resumen = r.servers
    .map((s) => s.id + (s.conflict ? ' ' + I18N.t('ajustes.mcp.reemplaza') : ''))
    .join(', ');
  const yes = await askConfirm($('#mcpPasteBox'), I18N.t('ajustes.mcp.anadir.confirmar'), resumen);
  if (!yes) return;
  for (const s of r.servers) await window.sagitari.mcpSave(s);
  $('#mcpPasteBox').hidden = true;
  mcpMsg(I18N.t('ajustes.mcp.anadidos', { lista: resumen }));
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
  /* En un aspecto PLANO las filas de luz y vidrio no existen (las retira applyTheme):
     una búsqueda no puede resucitarlas, o buscar «glow» en Consola ofrecería controles
     que no hacen nada sobre un aspecto que no tiene ni filo ni cristal. */
  const plano = skinActual(CFG.settings) !== 'holo';
  let shown = 0;
  wrap.querySelectorAll(SET_ROWS).forEach((row) => {
    const hay = ((row.dataset.keys || '') + ' ' + row.textContent).toLowerCase();
    const hit = !q || hay.includes(q);
    const oculta = plano && row.hasAttribute('data-solo-holo');
    row.hidden = !hit || oculta;
    const panel = row.closest('.setpanel');
    if (hit && !oculta && (buscando || !panel || panel.classList.contains('on'))) shown++;
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
      `<div class="wz-note">${esc(I18N.t('ajustes.wizard.propio.nota'))}</div>`;
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
      <div class="field"><label for="wzUrl">${esc(I18N.t('ajustes.modelo.baseUrl'))}</label><input type="text" id="wzUrl" value="${esc(wzUrl || p.baseUrl || '')}" placeholder="https://…/v1" /></div>
      ${local ? '' : `<div class="field"><label for="wzKey">${esc(I18N.t('ajustes.apikey'))}</label><input type="password" id="wzKey" value="${esc(wzKey)}" placeholder="${esc(I18N.t('ajustes.apikey.ph'))}" /></div>`}
      ${
        propia
          ? ''
          : `<div class="field"><label for="wzFormat">${esc(I18N.t('ajustes.protocolo'))}</label><select id="wzFormat">
               <option value="auto">${esc(I18N.t('ajustes.protocolo.auto'))}</option>
               <option value="openai">OpenAI — /chat/completions</option>
               <option value="anthropic">Anthropic — /messages</option>
               <option value="responses">OpenAI Responses — /responses</option>
             </select></div>`
      }
      <div class="subnote">${esc(p.hint || '')}${local ? ' ' + esc(I18N.t('ajustes.wizard.local.nota')) : ''}</div>`;
    // Al volver «Atrás» se recuerda lo que ya se había elegido.
    if ($('#wzFormat') && wzFormatoElegido) $('#wzFormat').value = wzFormatoElegido;
  } else {
    body.innerHTML = `
      <div class="field"><label for="wzModel">${esc(I18N.t('ajustes.modelo'))}</label><select id="wzModel"><option value="">${esc(I18N.t('ajustes.modelo.primero'))}</option></select></div>
      <div class="subnote">${esc(I18N.t('ajustes.wizard.modelo.nota'))}</div>`;
  }
  const foot = document.createElement('div');
  foot.className = 'wz-foot';
  const atras =
    wzPaso > 1
      ? `<button class="btn ghost" id="wzAtras">${esc(I18N.t('ajustes.wizard.atras'))}</button>`
      : `<button class="btn ghost" id="wzCerrar">${esc(I18N.t('ajustes.wizard.cerrar'))}</button>`;
  const next =
    wzPaso < 3
      ? `<button class="btn primary" id="wzNext"${wzPaso === 1 && !wzPreset ? ' disabled' : ''}>${esc(I18N.t('ajustes.wizard.siguiente'))}</button>`
      : `<button class="btn primary" id="wzActivar">${esc(I18N.t('ajustes.wizard.activar'))}</button>`;
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
          $('#wzMsg').textContent = I18N.t('ajustes.wizard.url.falta');
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
  wzMsg(I18N.t('ajustes.modelo.detectando'));
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
      wzMsg(I18N.t('ajustes.error', { motivo: r.error }));
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
    wzMsg(I18N.t('ajustes.wizard.detectados', { n: r.models.length }));
  } catch (e) {
    wzMsg(I18N.t('ajustes.error', { motivo: (e && e.message) || e }));
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
  if (!url || !model) return wzMsg(I18N.t('ajustes.modelo.elegirPrimero'));
  const p = (CFG.presets || []).find((x) => x.id === wzPreset) || {};
  const format = wzFormato();
  wzBusy = true;
  try {
    if (!wzProvGuardado) {
      const guardar = await window.sagitari.saveProvider({
        id: 'prov_' + Date.now().toString(36),
        name: p.name || I18N.t('ajustes.proveedor.nombre'),
        baseUrl: url,
        apiKey: key,
        format,
        models: [...$('#wzModel').options].map((o) => o.value).filter(Boolean),
      });
      if (guardar && guardar.ok === false) {
        wzMsg(I18N.t('ajustes.error', { motivo: guardar.error || I18N.t('ajustes.error.guardar') }));
        return;
      }
      wzProvGuardado = (CFG.providers || []).find((pr) => pr.baseUrl === url) || {
        id: null,
        name: p.name || I18N.t('ajustes.proveedor.nombre'),
        format,
      };
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
        : {
            name: (wzProvGuardado && wzProvGuardado.name) || I18N.t('ajustes.proveedor.nombre'),
            baseUrl: url,
            apiKey: key,
            model,
            vision,
            format,
          },
    );
    if (r && r.ok === false) {
      wzMsg(I18N.t('ajustes.error', { motivo: r.error || I18N.t('ajustes.error.activar') }));
      return;
    }
    CFG = await window.sagitari.getConfig();
    renderProviderList();
    updateStatusLabels();
    try {
      localStorage.setItem('sagi.wizardOmitido', '1');
    } catch {}
    $('#wizardSetup').classList.remove('on');
    showToast(I18N.t('ajustes.wizard.activado', { modelo: model }));
  } catch (e) {
    wzMsg(I18N.t('ajustes.error', { motivo: (e && e.message) || e }));
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
    b.title = I18N.t(show ? 'ajustes.clave.ocultar' : 'ajustes.clave.mostrar');
    // el estado se dice, no solo se dibuja: sin esto el botón siempre anunciaba
    // «no pulsado» mientras la clave estaba a la vista
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.setAttribute('aria-label', I18N.t(show ? 'ajustes.clave.ocultar' : 'ajustes.clave.mostrar'));
  };

// restablecer límites a los valores recomendados QUE DEFINE EL AGENTE (main los
// expone en meta:get): antes había una segunda lista hardcodeada aquí que podía
// desincronizarse de la del agente y «restablecer» a algo que ya no era lo suyo
if ($('#secResetGuardrails'))
  $('#secResetGuardrails').onclick = async () => {
    try {
      const m = await window.sagitari.metaGet(hiloActual());
      const d = m && m.guardrailDefaults;
      if (!d) throw new Error(I18N.t('ajustes.limites.sinDefaults'));
      const r = await window.sagitari.secSetGuardrail(d);
      if (r && r.ok === false) throw new Error(r.error || I18N.t('ajustes.error.guardar'));
      await initSecurity();
      showToast(I18N.t('ajustes.limites.restablecidos'));
    } catch (e) {
      showToast(I18N.t('ajustes.limites.restablecer.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
    }
  };
/* ---- atajos de permiso: «Permitir todo» y la vuelta a lo recomendado ----
   La lista de claves sale de la MISMA fuente que pinta la tabla (meta:get) más el
   comodín de cada servidor MCP. No se escribe a mano aquí: si el agente añade una
   herramienta, entra sola en los dos botones. */
async function clavesDePermisos() {
  const claves = new Set(PERM_KEYS);
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    Object.keys((m && m.riskDefaults) || {}).forEach((k) => claves.add(k));
  } catch {}
  claves.add('browser_eval'); // sub-permisión de browser_control: no está en la tabla
  try {
    const l = await window.sagitari.mcpList();
    (l.servers || []).forEach((s) => claves.add(s.permKey || 'mcp__' + s.id + '__*'));
  } catch {}
  return [...claves].filter(Boolean);
}

/** Aplica un nivel a TODAS las claves de una vez: main valida la lista entera y
    persiste una sola vez (`sec:setToolPermMany`). Si esa puerta no existiera, se
    recorre a mano — misma validación, N escrituras. */
async function aplicarNivelAPermisos(claves, nivel) {
  if (window.sagitari.secSetToolPermMany) {
    const r = await window.sagitari.secSetToolPermMany(claves, nivel);
    if (r && r.ok === false) throw new Error(r.error || I18N.t('ajustes.permisos.guardar.fallo'));
    return;
  }
  for (const t of claves) await window.sagitari.secSetToolPerm(t, nivel);
}

/* ---- deshacer del último cambio masivo ----
   «Permitir todo» toca ~40 permisos de golpe y la única vuelta era «Restablecer
   permisos recomendados», que NO es lo mismo: eso pone todo en el nivel de fábrica
   y se lleva por delante los niveles que tuvieras puestos a mano. Aquí se guarda el
   mapa anterior y se ofrece deshacer en el propio aviso. */
let ultimoCambioPermisos = null;

/** Los niveles guardados AHORA (sólo las claves con override; el resto está en
    «default», que es lo mismo que no tener nada). */
async function mapaPermisosActual() {
  try {
    const m = await window.sagitari.metaGet(hiloActual());
    return { ...((m && m.permissions) || {}) };
  } catch {
    return {};
  }
}

/** Devuelve cada clave al nivel que tenía. Las que no estaban en el mapa anterior
    vuelven a «default» (el recomendado), que es de donde salieron. */
async function restaurarMapaPermisos(previo, claves) {
  const porNivel = new Map();
  for (const k of claves) {
    const nivel = (previo && previo[k]) || 'default';
    if (!porNivel.has(nivel)) porNivel.set(nivel, []);
    porNivel.get(nivel).push(k);
  }
  for (const [nivel, ks] of porNivel) await aplicarNivelAPermisos(ks, nivel);
}

/** Avisa del cambio y, si hay algo que deshacer, ofrece el botón. */
function mostrarAvisoConDeshacer(texto) {
  const cambio = ultimoCambioPermisos;
  if (!cambio) {
    showToast(texto);
    return;
  }
  showToast(texto, {
    etiqueta: I18N.t('ajustes.permisos.deshacer'),
    fn: async () => {
      try {
        await restaurarMapaPermisos(cambio.previo, cambio.claves);
        ultimoCambioPermisos = null;
        await renderSecurity();
        showToast(I18N.t('ajustes.permisos.deshacer.hecho'));
      } catch (e) {
        showToast(I18N.t('ajustes.permisos.deshacer.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
      }
    },
  });
}

/** Pone TODAS las herramientas en «permitir siempre». Es la acción más peligrosa
    de la app —el agente deja de pedir permiso para todo—, así que siempre pasa por
    askConfirm y dice cuántos permisos va a tocar. Devuelve true si se aplicó. */
async function permitirTodoPermisos(anchor) {
  const claves = await clavesDePermisos();
  if (!claves.length) {
    showToast(I18N.t('ajustes.permisos.nada'));
    return false;
  }
  const ok = await askConfirm(
    anchor || null,
    I18N.t('ajustes.permisos.todos.confirmar', { n: claves.length }),
    I18N.t('ajustes.permisos.todos.detalle'),
  );
  if (!ok) return false;
  const previo = await mapaPermisosActual();
  try {
    await aplicarNivelAPermisos(claves, 'safe');
  } catch (e) {
    showToast(I18N.t('ajustes.permisos.guardar.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
    return false;
  }
  ultimoCambioPermisos = { previo, claves };
  return true;
}

/** Devuelve todas las claves al nivel recomendado («por defecto»). */
async function restablecerPermisos() {
  const claves = await clavesDePermisos();
  const previo = await mapaPermisosActual();
  try {
    await aplicarNivelAPermisos(claves, 'default');
  } catch (e) {
    showToast(I18N.t('ajustes.limites.restablecer.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
    return false;
  }
  ultimoCambioPermisos = { previo, claves };
  return true;
}

if ($('#secResetPerms'))
  $('#secResetPerms').onclick = async () => {
    if (!(await restablecerPermisos())) return;
    await renderSecurity();
    mostrarAvisoConDeshacer(I18N.t('ajustes.permisos.restablecidos'));
  };
if ($('#secAllowAll'))
  $('#secAllowAll').onclick = async () => {
    if (!(await permitirTodoPermisos($('#secAllowAll')))) return;
    await renderSecurity();
    mostrarAvisoConDeshacer(I18N.t('ajustes.permisos.todos'));
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
    const usos = I18N.t(total === 1 ? 'ajustes.habitos.usos.uno' : 'ajustes.habitos.usos.varios');
    const olvidar = I18N.t('ajustes.habitos.olvidar', { titulo: g.titulo.toLowerCase() });
    bloques.push(
      `<div class="hgrupo" data-cat="${esc(g.cat)}"><span class="hgr-t">${ic(g.icono)} ${esc(g.titulo)}</span>` +
        `<span class="hgr-n">${total} ${esc(usos)}</span>` +
        filas.map((f) => `<span class="hpill">${esc(f.name)} ×${f.count}</span>`).join('') +
        `<button class="btn ghost sq" data-olvidar="${esc(g.olvidar)}" title="${esc(olvidar)}" aria-label="${esc(olvidar)}">${ic('trash')}</button></div>`,
    );
  }
  box.innerHTML = bloques.length
    ? bloques.join('')
    : '<span class="hdim">' + esc(I18N.t('ajustes.habitos.vacio')) + '</span>';
  box.querySelectorAll('[data-olvidar]').forEach((b) => {
    b.onclick = async () => {
      const categoria = b.dataset.olvidar;
      if (
        !(await askConfirm(
          b,
          I18N.t('ajustes.habitos.olvidar.confirmar', { titulo: memTituloCategoria(categoria) }),
          I18N.t('ajustes.habitos.olvidar.detalle'),
        ))
      )
        return;
      b.disabled = true;
      const r = await window.sagitari.habitsForget(categoria);
      if (r && r.ok === false) {
        b.disabled = false;
        showToast(I18N.t('ajustes.habitos.olvidar.error', { motivo: r.error || I18N.t('ajustes.error.desconocido') }));
        return;
      }
      await renderHabitsPreview();
      showToast(I18N.t('ajustes.habitos.olvidados', { titulo: memTituloCategoria(categoria) }));
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
        I18N.t('ajustes.habitos.reiniciar.confirmar'),
        I18N.t('ajustes.habitos.reiniciar.detalle'),
      ))
    )
      return;
    btn.disabled = true;
    try {
      await window.sagitari.habitsReset();
      await renderHabitsPreview();
      if ($('#view-agents').classList.contains('on')) renderHabits();
      showToast(I18N.t('ajustes.habitos.reiniciados'));
    } finally {
      btn.disabled = false;
    }
  };
if ($('#openDataDirBtn'))
  $('#openDataDirBtn').onclick = async () => {
    const r = await window.sagitari.openDataDir();
    if (r && r.ok === false) showToast(r.error || I18N.t('ajustes.carpeta.error'));
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
    if (s.status === 'checking') st.textContent = I18N.t('ajustes.upd.buscando');
    else if (s.status === 'downloading')
      st.textContent = I18N.t('ajustes.upd.descargandoVersion', { v: s.latest || '' });
    else if (s.error) st.textContent = I18N.t('ajustes.upd.error', { motivo: s.error });
    else if (s.available) st.textContent = I18N.t('ajustes.upd.nueva', { v: s.latest || '' });
    else if (s.current || s.latest) st.textContent = I18N.t('ajustes.upd.aldia');
    else st.textContent = I18N.t('ajustes.upd.sinComprobar');
  }

  const busy = s.status === 'checking' || s.status === 'downloading';
  const check = $('#updCheckBtn');
  if (check) {
    check.disabled = busy;
    const lbl = $('#updCheckLabel');
    if (lbl) lbl.textContent = I18N.t(s.status === 'checking' ? 'ajustes.upd.buscandoCorto' : 'ajustes.upd.buscar');
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
      if (lbl)
        lbl.textContent = I18N.t(
          reintento
            ? 'ajustes.upd.instalar.reintentar'
            : portable
              ? 'ajustes.upd.instalar.abrirCarpeta'
              : 'ajustes.upd.instalar.ahora',
        );
      inst.setAttribute(
        'aria-label',
        I18N.t(
          portable
            ? 'ajustes.upd.aria.abrirCarpeta'
            : reintento
              ? 'ajustes.upd.aria.reintentar'
              : 'ajustes.upd.aria.instalar',
          reintento ? { v: s.pending.version || '' } : undefined,
        ),
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
    bnote.textContent = total
      ? I18N.t('ajustes.upd.progreso.total', {
          pct,
          recibido: updSize(s.progress.received),
          total: updSize(total),
        })
      : I18N.t('ajustes.upd.progreso', { pct });
  }

  // notas: modo de ejecución, firma y qué pasará exactamente al instalar
  const notes = [];
  if (s.kind === 'dev') notes.push(I18N.t('ajustes.upd.nota.dev'));
  if (s.pending && !ready) {
    notes.push(
      s.pending.exists
        ? I18N.t('ajustes.upd.nota.pendienteRuta', { v: s.pending.version, ruta: s.pending.path })
        : I18N.t('ajustes.upd.nota.pendiente', { v: s.pending.version }),
    );
  }
  if (ready) {
    if (ready.signed === false) notes.push(I18N.t('ajustes.upd.nota.sinFirma'));
    else if (ready.signed === true && ready.signer) notes.push(I18N.t('ajustes.upd.nota.firmada', { firmante: ready.signer }));
    if (s.kind === 'nsis') notes.push(I18N.t('ajustes.upd.nota.nsis'));
    if (s.kind === 'portable') notes.push(I18N.t('ajustes.upd.nota.portable'));
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
    if (!r) throw new Error(I18N.t('ajustes.upd.respuestaVacia'));
    updState.current = r.current || updState.current;
    updState.latest = r.latest || null;
    updState.available = !!r.available;
    updState.kind = r.kind || updState.kind;
    updState.ready = r.ready || updState.ready;
    updState.pending = r.pending || null; // el motor la descarta sola si ya no aplica
    updState.error = r.ok === false ? r.error || I18N.t('ajustes.error.desconocido') : null;
  } catch (e) {
    updState.error = String((e && e.message) || e || I18N.t('ajustes.error.desconocido'));
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
        updMsg(I18N.t('ajustes.upd.descargar.error', { motivo: (r && r.error) || I18N.t('ajustes.error.desconocido') }));
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
      updMsg(I18N.t('ajustes.upd.descargar.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
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
      updMsg(I18N.t('ajustes.upd.preparando'));
      const extra = updUnsignedArmed ? { confirmUnsigned: true } : updSignerArmed ? { confirmSignerChange: true } : undefined;
      const r = reintento ? await window.sagitari.updateRetry(extra) : await window.sagitari.updateInstall(extra);
      // Puerta de binario sin firmar: el motor exige consentimiento activo en dos
      // pasos (sin modales nativos: el segundo clic ES la confirmación). El aviso
      // queda escrito en la tarjeta, no solo en un toast que se pierde. Vale para
      // instalar y para reintentar: lo pendiente también puede ir sin firmar.
      if (r && r.ok === false && r.needsUnsignedConfirm) {
        updMsg(I18N.t(reintento ? 'ajustes.upd.sinFirma.reintentar' : 'ajustes.upd.sinFirma.instalar'));
        renderUpdate(updState);
        updUnsignedArmed = true;
        return;
      }
      // Puerta de cambio de firmante (TOFU): el binario trae otro firmante que las
      // releases anteriores (o perdió la firma). Mismo patrón de doble clic, con su
      // propio aviso para que el usuario sepa QUÉ cambió.
      if (r && r.ok === false && r.needsSignerConfirm) {
        updMsg(I18N.t('ajustes.upd.firmante'));
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
        updMsg(I18N.t('ajustes.upd.instalar.error', { motivo: (r && r.error) || I18N.t('ajustes.error.desconocido') }));
        return;
      }
      updMsg(I18N.t(r.manual ? 'ajustes.upd.manual' : 'ajustes.upd.instalando'));
    } catch (e) {
      updMsg(I18N.t('ajustes.upd.instalar.error', { motivo: (e && e.message) || I18N.t('ajustes.error.desconocido') }));
    } finally {
      btn.disabled = false; // si la instalación arranca, la app se cierra antes de llegar aquí
    }
  };

if ($('#updPageBtn'))
  $('#updPageBtn').onclick = async () => {
    const r = await window.sagitari.updatePage();
    if (r && r.ok === false)
      updMsg(I18N.t('ajustes.upd.pagina.error', { motivo: r.error || I18N.t('ajustes.error.desconocido') }));
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
        showToast(I18N.t('ajustes.upd.toast.nueva', { v: ev.version || '' }));
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
      showToast(I18N.t('ajustes.upd.toast.fallo', { v: ev.version || I18N.t('ajustes.upd.versionNueva') }));
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
      if (descargando) updMsg(I18N.t('ajustes.upd.descargar.error', { motivo: ev.message || I18N.t('ajustes.error.desconocido') }));
      else updState.error = ev.message || I18N.t('ajustes.error.desconocido');
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
