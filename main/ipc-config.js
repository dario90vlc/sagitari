'use strict';

/* ipc-config.js — router IPC del dominio configuración/proveedores/ajustes.
 *
 * Fase 4 (sigue el patrón de ipc-memory.js / ipc-skills.js / ipc-mcp.js):
 * los handlers `config:get`, `provider:*` y `settings:set` viven aquí.
 * Todo lo que tocan de main.js viaja en `ctx`:
 *   - config: el objeto de configuración vivo (se lee fresco vía getter)
 *   - persistConfig(): guarda config en disco, devuelve { ok, error }
 *   - PRESETS: catálogo de proveedores para la UI
 *   - listModels(baseUrl, key): detección de modelos del proveedor
 *   - glow(mode): efecto de luz de la ventana
 *   - getWin(): ventana de chat (o null si está destruida)
 *   - isHidden(): true cuando la app corre sin ventana visible
 *
 * Los helpers de secretos también viven aquí y se exportan: `mcpState()`
 * (dominio MCP, todavía en main.js) los usa para enmascarar env/headers.
 * Los secretos NUNCA viajan en claro al renderer: config:get devuelve la
 * máscara '••••' en lugar de la clave real; el renderer la reenvía tal cual
 * al guardar, y save/activate la interpretan como «conservar la guardada».
 */

const SECRETO_MASK = '••••';

function enmascararApiKey(p) {
  if (!p || typeof p !== 'object') return p;
  if (!p.apiKey) return p;
  return { ...p, apiKey: SECRETO_MASK };
}

/** '••••' (o vacío) = el formulario no trae secreto nuevo: se conserva el guardado. */
function desenmascararApiKey(valor, guardada) {
  const v = String(valor == null ? '' : valor);
  if (!v || v === SECRETO_MASK) return String(guardada || '');
  return v.trim();
}

function enmascararMapaSecretos(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    out[k] = String(v == null ? '' : v) ? SECRETO_MASK : '';
  }
  return out;
}

/* Validación compartida de un proveedor: guardar y activar deben exigir lo mismo
   (antes activar no comprobaba nada y el badge decía «Conectado» con una URL rota).
   `activate` no exige id (el catálogo lo resuelve después) pero sí modelo. */
function validateProvider(p, { requireId = true, requireModel = false } = {}) {
  if (!p || typeof p !== 'object') return { ok: false, error: 'proveedor inválido' };
  if (requireId && (typeof p.id !== 'string' || !p.id.trim())) return { ok: false, error: 'id requerido' };
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
  if (!baseUrl || (!/^https?:\/\//i.test(baseUrl) && !/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(baseUrl))) {
    return { ok: false, error: 'baseUrl debe ser http(s) o localhost' };
  }
  if (requireModel && (typeof p.model !== 'string' || !p.model.trim())) {
    return { ok: false, error: 'selecciona un modelo antes de activar' };
  }
  return null;
}

/** Clave del proveedor guardado al que corresponde una activación (por id o por URL). */
function claveGuardadaPara(config, { providerId, id, baseUrl } = {}) {
  const prov = (config.providers || []).find(p => (providerId && p.id === providerId) || (id && p.id === id) || (baseUrl && p.baseUrl === baseUrl));
  return (prov && prov.apiKey) || '';
}

function registerConfigIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const { persistConfig, PRESETS, listModels, glow, getWin, isHidden } = ctx;

  ipcMain.handle('config:get', () => {
    const config = cfg();
    return {
      providers: (config.providers || []).map(enmascararApiKey),
      active: config.active ? enmascararApiKey(config.active) : config.active,
      settings: config.settings,
      presets: PRESETS
    };
  });

  ipcMain.handle('provider:save', (e, p) => {
    const config = cfg();
    // Validación: un payload vacío (o con una baseUrl de otro esquema) propagaba un
    // TypeError al guardar y dejaba la configuración a medias.
    const bad = validateProvider(p);
    if (bad) return bad;
    // '••••' = la UI reenvía la máscara (no trae secreto nuevo): se conserva la
    // clave guardada en vez de pisarla con la máscara.
    const prev = config.providers.find(x => x.id === p.id);
    const guardada = (prev && prev.apiKey) || '';
    const payload = { ...p, apiKey: desenmascararApiKey(p.apiKey, guardada) };
    const idx = config.providers.findIndex(x => x.id === payload.id);
    if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...payload };
    else config.providers.push(payload);
    return persistConfig();
  });

  ipcMain.handle('provider:delete', (e, id) => {
    const config = cfg();
    config.providers = config.providers.filter(x => x.id !== id);
    // el proveedor activo puede no llevar providerId (el renderer no siempre lo
    // manda), así que se compara también por id. Comparar una baseUrl con un id
    // (como se hacía antes) podía desactivar el proveedor equivocado.
    const a = config.active;
    if (a && (a.providerId === id || a.id === id)) config.active = null;
    return persistConfig();
  });

  ipcMain.handle('provider:models', async (e, { baseUrl, apiKey }) => {
    const config = cfg();
    // Igual que en activar: el campo de clave se vacía al cambiar de preset, así que
    // si no llega clave se usa la del proveedor guardado con esa URL. Detectar
    // modelos no puede fallar en 401 por una credencial que ya está guardada.
    // '••••' = la UI reenvía la máscara de config:get: también es «usar la guardada».
    const recibida = String(apiKey || '').trim();
    const key = (!recibida || recibida === SECRETO_MASK) ? claveGuardadaPara(config, { baseUrl }) : recibida;
    try { return { ok: true, models: await listModels(baseUrl, key) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('provider:activate', (e, provCfg) => {
    const config = cfg();
    // Activar sin validar dejaba el badge en «Conectado» con una URL inservible
    // (o sin modelo) y el chat fallaba en cada envío.
    const bad = validateProvider(provCfg, { requireId: false, requireModel: true });
    if (bad) return bad;
    // id resuelto del catálogo: es lo que permite desactivarlo al borrarlo
    const prov = config.providers.find(p => p.baseUrl === provCfg.baseUrl && p.model === provCfg.model)
      || config.providers.find(p => p.baseUrl === provCfg.baseUrl);
    // El formulario manda la clave de su campo, y ese campo se vacía al
    // cambiar de preset: activar con el campo vacío dejaba `config.active` SIN
    // clave aunque el proveedor guardado la tuviera, y cada turno salía en 401
    // («Missing API key») hasta caer al modelo de la cadena de fallback. Activar un
    // modelo no puede vaciar una credencial que ya estaba guardada. Lo mismo vale
    // para la máscara '••••' que ahora devuelve config:get (el renderer la reenvía).
    const apiKey = desenmascararApiKey(provCfg.apiKey, claveGuardadaPara(config, provCfg));
    config.active = { ...provCfg, apiKey, providerId: provCfg.providerId || provCfg.id || (prov && prov.id) || null };
    return persistConfig();
  });

  ipcMain.handle('settings:set', (e, patch) => {
    const config = cfg();
    const clean = { ...(patch || {}) };
    // El idioma del dictado llega a voice.ps1 como argumento y allí se usa como
    // comodín (`-like ($Lang + '*')`), así que un `*`/`?` seleccionaría el
    // reconocedor equivocado. Solo se acepta la forma xx-XX; lo demás se ignora.
    if ('voiceLang' in clean && !/^[a-z]{2}-[A-Z]{2}$/.test(String(clean.voiceLang || ''))) delete clean.voiceLang;
    /* Interruptor del motor de escucha clásico: booleano estricto (un «true» en texto de
       un formulario sería veraz y el ajuste no se podría apagar nunca). */
    if ('sttClasico' in clean && typeof clean.sttClasico !== 'boolean') delete clean.sttClasico;
    /* Motor de dictado: 'whisper' lo fija a mano (aunque falte instalarlo, para que al
       terminar la instalación ya esté en marcha); cualquier otro valor borra la fijación. */
    if ('motor' in clean && clean.motor !== 'whisper') delete clean.motor;
    /* ¿La voz de la lectura la eligió el usuario a mano? Booleano estricto, por lo mismo
       que `sttClasico`: un «true» en texto no debe poder fijar el ajuste. */
    if ('ttsVoiceFijo' in clean && typeof clean.ttsVoiceFijo !== 'boolean') delete clean.ttsVoiceFijo;
    /* Razonamiento visible (v2.3): booleano estricto. Un «true»/«false» en texto significaría
       verdadero siempre, y el ajuste no se podría apagar. */
    if ('showThinking' in clean && typeof clean.showThinking !== 'boolean') delete clean.showThinking;
    if ('reviewGate' in clean && typeof clean.reviewGate !== 'boolean') delete clean.reviewGate;
    // v2.5: herramientas del mismo mensaje que corren a la vez (1 = una detrás de otra)
    if ('parallelTools' in clean) {
      const n = Math.round(Number(clean.parallelTools));
      if (!Number.isFinite(n) || n < 1 || n > 4) delete clean.parallelTools; else clean.parallelTools = n;
    }
    /* v2.5 — verificación real: booleanos estrictos (como verifyGate) para que un «false»
       en texto no pueda dejarlos encendidos sin querer, y el número de vueltas de arreglo
       topado: sin tope, un proyecto que no compila dejaba el turno girando para siempre. */
    // v2.5: caché de prompt del proveedor (activo por defecto; se apaga si un proveedor
    // compatible rechaza el campo `cache_control`)
    if ('promptCache' in clean && typeof clean.promptCache !== 'boolean') delete clean.promptCache;
    if ('diagnosticosEscritura' in clean && typeof clean.diagnosticosEscritura !== 'boolean') delete clean.diagnosticosEscritura;
    if ('verificacionCierre' in clean && typeof clean.verificacionCierre !== 'boolean') delete clean.verificacionCierre;
    /* v3.0 — aislamiento: los subagentes que ESCRIBEN trabajan en su propio árbol de
       trabajo de git y sus cambios vuelven como un parche verificado. Activo por defecto;
       se puede apagar para que escriban directamente sobre el proyecto (más rápido, pero
       dos especialistas a la vez vuelven a pisarse). */
    if ('arbolesAislados' in clean && typeof clean.arbolesAislados !== 'boolean') delete clean.arbolesAislados;
    if ('intentosArreglo' in clean) {
      const n = Math.round(Number(clean.intentosArreglo));
      if (!Number.isFinite(n) || n < 0 || n > 5) delete clean.intentosArreglo; else clean.intentosArreglo = n;
    }
    /* v2.5 — tus hooks (Ajustes ▸ Agente). Una sola línea cada uno y sin saltos de línea:
       un hook es UN comando; si alguien pega un guion de varias líneas, se queda la primera
       y se le dice, en vez de ejecutar algo que no ha leído. */
    for (const k of ['hookEditar', 'hookCerrar']) {
      if (!(k in clean)) continue;
      let v = String(clean[k] == null ? '' : clean[k]).trim();
      if (v.length > 500) v = v.slice(0, 500).trim();
      clean[k] = v;
    }
    config.settings = { ...config.settings, ...clean };
    const saved = persistConfig();
    if ('glowEnabled' in clean && !clean.glowEnabled) glow('off');
    // si cambió la apariencia, el renderer repinta el tema; si el glow está
    // activo, relanzamos el estado actual para que el nuevo color se vea al momento
    if ('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean || 'glassTint' in clean) {
      try {
        const win = getWin();
        if (win && !win.isDestroyed()) win.webContents.send('theme:changed', { uiColor: config.settings.uiColor, glowColor: config.settings.glowColor, glowStrength: config.settings.glowStrength, glassTint: config.settings.glassTint });
      } catch {}
      /* El pulso es acuse de la LUZ del marco: solo si cambia algo de la luz.
         glassTint tiñe los paneles — se repinta con theme:changed (arriba), pero
         el marco no debe destellar en cada movimiento del slider del vidrio. */
      if (('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean)
        && config.settings.glowEnabled && !isHidden()) glow('pulse');
    }
    // el renderer sigue recibiendo los ajustes; si el disco falló, se lo decimos
    // además por el mismo canal (y ya ha recibido el toast de persistConfig)
    return saved.ok ? config.settings : { ...config.settings, saveError: saved.error };
  });
}

module.exports = {
  registerConfigIpc,
  SECRETO_MASK,
  enmascararApiKey,
  desenmascararApiKey,
  enmascararMapaSecretos,
  validateProvider,
  claveGuardadaPara,
};
