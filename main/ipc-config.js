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

/* v4.4: tope duro del presupuesto de un encargo de equipo (USD). El ajuste admite
   0..este valor; se exporta para que la vista Equipo y meta:get compartan el número
   en vez de copiarlo. */
const EQUIPO_PRESUPUESTO_MAX_USD = 50;

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
  /* La URL se compara NORMALIZADA (sin espacios y sin barra final): el campo del
     formulario guarda lo que escribe el usuario, así que «https://x/v1/» y
     «https://x/v1» son el mismo proveedor. Sin esto, una diferencia de un carácter
     dejaba «Detectar modelos» sin credencial aunque la clave estuviera guardada (401). */
  const limpia = (u) => String(u || '').trim().replace(/\/+$/, '');
  const buscada = limpia(baseUrl);
  const prov = (config.providers || []).find(
    (p) => (providerId && p.id === providerId) || (id && p.id === id) || (buscada && limpia(p.baseUrl) === buscada),
  );
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
      presets: PRESETS,
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
    const prev = config.providers.find((x) => x.id === p.id);
    const guardada = (prev && prev.apiKey) || '';
    const payload = { ...p, apiKey: desenmascararApiKey(p.apiKey, guardada) };
    const idx = config.providers.findIndex((x) => x.id === payload.id);
    if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...payload };
    else config.providers.push(payload);
    return persistConfig();
  });

  ipcMain.handle('provider:delete', (e, id) => {
    const config = cfg();
    config.providers = config.providers.filter((x) => x.id !== id);
    // el proveedor activo puede no llevar providerId (el renderer no siempre lo
    // manda), así que se compara también por id. Comparar una baseUrl con un id
    // (como se hacía antes) podía desactivar el proveedor equivocado.
    const a = config.active;
    if (a && (a.providerId === id || a.id === id)) config.active = null;
    return persistConfig();
  });

  ipcMain.handle('provider:models', async (e, { baseUrl, apiKey, format, providerId, model } = {}) => {
    const config = cfg();
    // Igual que en activar: el campo de clave se vacía al cambiar de preset, así que
    // si no llega clave se usa la del proveedor guardado con esa URL. Detectar
    // modelos no puede fallar en 401 por una credencial que ya está guardada.
    // '••••' = la UI reenvía la máscara de config:get: también es «usar la guardada».
    const recibida = String(apiKey || '').trim();
    const key = !recibida || recibida === SECRETO_MASK ? claveGuardadaPara(config, { baseUrl, providerId }) : recibida;
    /* El protocolo con el que se sondea no se puede deducir siempre de la URL: hay
       bases Anthropic de terceros cuyo path no lo dice (y se detectarían con Bearer).
       La interfaz manda `format`/`providerId`/`model` hasta aquí para que «Detectar
       modelos» use las MISMAS cabeceras que usará luego la petición real. `listModels`
       recibe `undefined` como fetchFn a propósito: así vale su fetch por defecto y no
       se toca el orden posicional (test/40-agente.js lo llama con el 3.º = spy). */
    try {
      return {
        ok: true,
        models: await listModels(baseUrl, key, undefined, { format, providerId, model }),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('provider:activate', (e, provCfg) => {
    const config = cfg();
    // Activar sin validar dejaba el badge en «Conectado» con una URL inservible
    // (o sin modelo) y el chat fallaba en cada envío.
    const bad = validateProvider(provCfg, { requireId: false, requireModel: true });
    if (bad) return bad;
    // id resuelto del catálogo: es lo que permite desactivarlo al borrarlo
    const prov =
      config.providers.find((p) => p.baseUrl === provCfg.baseUrl && p.model === provCfg.model) ||
      config.providers.find((p) => p.baseUrl === provCfg.baseUrl);
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

  /* Claves que settings:set puede escribir. Antes se fusionaba el patch ENTERO sobre
   config.settings sin mirar qué claves traía: el renderer (o cualquier bug suyo) podía
   colar `workspace` —que el agente usa para crear/ejecutar— saltándose la validación de
   los canales dedicados (`workspace:set`/`workspace:pick`), o pisar cualquier otra cosa.
   La lista son SOLO los ajustes editables desde Ajustes y sus canales (enumerados de
   renderer/30-ajustes.js, renderer/40-vistas.js y los defaults de main.js); `workspace`
   y cualquier clave con secretos quedan FUERA a propósito. */
  const CLAVES_AJUSTES_PERMITIDAS = new Set([
    // apariencia
    'theme',
    'uiColor',
    'glowColor',
    'glowStrength',
    'glassTint',
    'glowEnabled',
    // agente
    'userName',
    'mode',
    'maxConcurrentTasks',
    /* v4.4: tope de gasto por encargo de equipo (0 = sin tope propio). Se expone en
       meta:get para que la interfaz lo enseñe sin copiar el número. */
    'equipoPresupuestoUsd',
    'autoResumeTasks',
    'llmTimeoutMs',
    'showThinking',
    'reviewGate',
    'verifyGate',
    'parallelTools',
    'diagnosticosEscritura',
    'verificacionCierre',
    'intentosArreglo',
    'promptCache',
    'arbolesAislados',
    /* Aceptar automáticamente las ESCRITURAS de archivo (nunca comandos ni
       ejecución): el usuario lo enciende a mano en Ajustes ▸ Seguridad. */
    'autoEdits',
    /* Fase 1 de memoria: `memoryLearn` es la puerta (con `false` no se propone nada) y
       `memoryAutoSave` decide si lo propuesto se guarda sin preguntar. La vista los llama
       «Que aprenda de nuestras conversaciones» y «guardar sin preguntar». */
    'memoryLearn',
    'memoryAutoSave',
    'agentRouting',
    'memSensitivity',
    'hookEditar',
    'hookCerrar',
    'devMode',
  ]);

  ipcMain.handle('settings:set', (e, patch) => {
    const config = cfg();
    const clean = { ...(patch || {}) };
    // Allowlist ANTES de validar: lo que no sea un ajuste conocido se descarta aquí.
    for (const k of Object.keys(clean)) if (!CLAVES_AJUSTES_PERMITIDAS.has(k)) delete clean[k];
    /* Razonamiento visible (v2.3): booleano estricto. Un «true»/«false» en texto significaría
       verdadero siempre, y el ajuste no se podría apagar. */
    if ('showThinking' in clean && typeof clean.showThinking !== 'boolean') delete clean.showThinking;
    if ('reviewGate' in clean && typeof clean.reviewGate !== 'boolean') delete clean.reviewGate;
    // v2.5: herramientas del mismo mensaje que corren a la vez (1 = una detrás de otra)
    if ('parallelTools' in clean) {
      const n = Math.round(Number(clean.parallelTools));
      if (!Number.isFinite(n) || n < 1 || n > 4) delete clean.parallelTools;
      else clean.parallelTools = n;
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
    /* Aceptar automáticamente las escrituras de archivo: booleano estricto, como los
       demás interruptores de seguridad. Un «false» en texto no puede dejarlo encendido,
       y un «true» en texto no puede encenderlo sin querer: es un ajuste de riesgo. */
    if ('autoEdits' in clean && typeof clean.autoEdits !== 'boolean') delete clean.autoEdits;
    /* Fase 1 de memoria: booleanos estrictos, como los demás interruptores. Aquí importa más
       que en otros sitios: con un «true»/«false» en texto, `memoryLearn` quedaría encendido
       siempre —o `memoryAutoSave` guardando sin preguntar— sin poder apagarlo. */
    if ('memoryLearn' in clean && typeof clean.memoryLearn !== 'boolean') delete clean.memoryLearn;
    if ('memoryAutoSave' in clean && typeof clean.memoryAutoSave !== 'boolean') delete clean.memoryAutoSave;
    if ('intentosArreglo' in clean) {
      const n = Math.round(Number(clean.intentosArreglo));
      if (!Number.isFinite(n) || n < 0 || n > 5) delete clean.intentosArreglo;
      else clean.intentosArreglo = n;
    }
    /* v4.4 — presupuesto del encargo de equipo, en USD. 0 = sin tope propio (lo hereda
       de los guardarraíles). Un valor fuera de 0..50 casi siempre es un número pegado
       de otra casilla (tokens, milisegundos) o una errata: se rechaza en vez de aceptar
       un tope que cortaría el equipo a la primera llamada. NO se redondea: son dólares,
       y 0.25 es un tope válido. */
    if ('equipoPresupuestoUsd' in clean) {
      const n = Number(clean.equipoPresupuestoUsd);
      if (!Number.isFinite(n) || n < 0 || n > EQUIPO_PRESUPUESTO_MAX_USD) delete clean.equipoPresupuestoUsd;
      else clean.equipoPresupuestoUsd = n;
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
    /* `autoEdits` es una preferencia del usuario (vive en `settings`, que es lo que lee la
       interfaz) pero el motor de permisos solo ve la POLÍTICA. Se refleja en las dos y se
       empuja al agente vivo: sin este puente el interruptor se guardaba y no hacía nada
       hasta reiniciar la app. */
    if ('autoEdits' in clean) {
      config.security = { ...(config.security || {}), autoEdits: clean.autoEdits === true };
      if (typeof ctx.setAgentPolicy === 'function') ctx.setAgentPolicy(config.security);
    }
    const saved = persistConfig();
    if ('glowEnabled' in clean && !clean.glowEnabled) glow('off');
    // si cambió la apariencia, el renderer repinta el tema; si el glow está
    // activo, relanzamos el estado actual para que el nuevo color se vea al momento
    if ('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean || 'glassTint' in clean) {
      try {
        const win = getWin();
        if (win && !win.isDestroyed())
          win.webContents.send('theme:changed', {
            uiColor: config.settings.uiColor,
            glowColor: config.settings.glowColor,
            glowStrength: config.settings.glowStrength,
            glassTint: config.settings.glassTint,
          });
      } catch {}
      /* El pulso es acuse de la LUZ del marco: solo si cambia algo de la luz.
         glassTint tiñe los paneles — se repinta con theme:changed (arriba), pero
         el marco no debe destellar en cada movimiento del slider del vidrio. */
      if (('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean) && config.settings.glowEnabled && !isHidden())
        glow('pulse');
    }
    // el renderer sigue recibiendo los ajustes; si el disco falló, se lo decimos
    // además por el mismo canal (y ya ha recibido el toast de persistConfig)
    return saved.ok ? config.settings : { ...config.settings, saveError: saved.error };
  });
}

module.exports = {
  registerConfigIpc,
  SECRETO_MASK,
  EQUIPO_PRESUPUESTO_MAX_USD,
  enmascararApiKey,
  desenmascararApiKey,
  enmascararMapaSecretos,
  validateProvider,
  claveGuardadaPara,
};
