'use strict';

// SAGITARI — Electron main process
// Chat window + click-through screen-edge glow overlay + agent + settings.

const { app, ipcMain, desktopCapturer, screen, globalShortcut, shell, dialog } = require('electron');

// Defensa en profundidad (auditoría #12): validar el remitente de cada
// ipcMain.handle. El renderer corre con contextIsolation + sandbox + CSP, así que
// hoy no hay XSS que pueda llamar al puente; fijarlo aquí cierra la puerta a que
// aparezca en el futuro sin tener que tocar los 90 y pico manejadores uno a uno.
const _ipcHandleOriginal = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  const envuelto = async (event, ...args) => {
    const url = event && event.senderFrame && event.senderFrame.url ? String(event.senderFrame.url) : '';
    if (!/^file:/i.test(url)) {
      log.warn('[ipc] remitente no autorizado para ' + channel + ': ' + (url || '(sin url)'));
      return { ok: false, error: i18n.t('error.remitente') };
    }
    return handler(event, ...args);
  };
  return _ipcHandleOriginal(channel, envuelto);
};
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

/* Red de seguridad del proceso, EN LO ALTO. Los `require` de más abajo hacen trabajo real
   al importarse (ipc-convs lee conversations.json, runlog abre su log…) y un fallo ahí se
   quedaba sin red hasta mucho después. `registrarFallo` es una declaración de función (se
   eleva) y tolera que sus dependencias aún no existan: cada acceso frágil va en su try. */
let avisosDeFallo = 0;
process.on('uncaughtException', (err) => registrarFallo('uncaughtException', err));
process.on('unhandledRejection', (reason) => registrarFallo('unhandledRejection', reason));

const {
  KEY_PREFIX,
  encryptionAvailable,
  protectKey,
  revealKey,
  protectServerSecrets,
  revealServerSecrets,
  sinSecretos,
  writeJsonAtomic,
} = require('./config');
const { crearVentana } = require('./ventana');
const { crearBandeja } = require('./bandeja');
const { resolverIdiomaArranque } = require('./idioma');
const { createRuntimes } = require('./runtimes');
const log = require('./log');

const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke');
/* Banco de pruebas de TAREAS: mide al agente (¿hace bien el trabajo?), no al código.
   Va por aquí y no por un script de Node a propósito: la clave del proveedor está
   cifrada con el almacén del sistema y solo este proceso puede descifrarla. */
const BANCO = process.argv.includes('--banco');
// Las comprobaciones automáticas (smoke, ui-check) abren la app SIN mostrar
// ventana: hasta ahora la ventana se abría y se cerraba sola dos veces durante
// probar.bat, y eso se ve exactamente igual que «la app se cierra sola».
const HEADLESS = SMOKE || process.argv.includes('--hidden') || process.argv.includes('--test') || process.argv.includes('--test-visible');
// Y aparte de eso, si la ventana se muestra o no. `--test-visible` usa el perfil de
// pruebas CON ventana: una ventana oculta no compone ni ejecuta requestAnimationFrame,
// así que el movimiento (el glow) no se puede medir ni capturar sin verla.
const HIDDEN = HEADLESS && !process.argv.includes('--test-visible');
// Raíz de datos de la app. Se fija AQUÍ (antes de cargar los módulos de agent/)
// porque cada uno resuelve su ruta al cargarse: es la única forma de que los
// arranques de prueba no escriban en los skills, logs, memoria, hábitos,
// checkpoints, perfiles de navegador y salud de modelos REALES del usuario.
// SAGITARI_TEST_PROFILE (solo arranques de prueba) apunta el perfil a un
// directorio escribible: en un sandbox que restringe el token, Electron no
// puede escribir en %APPDATA% y el bloqueo de instancia no se crea (la app
// sale con «ya está abierta» sin que haya ninguna). No afecta a la app
// instalada: sin la variable, la ruta es siempre la de antes.
const PERFIL = HEADLESS
  ? process.env.SAGITARI_TEST_PROFILE
    ? path.resolve(process.env.SAGITARI_TEST_PROFILE)
    : path.join(app.getPath('appData'), 'SagitariAI-test')
  : path.join(app.getPath('appData'), 'SagitariAI');
const DATA_DIR = PERFIL;
process.env.SAGITARI_DATA_DIR = DATA_DIR;

const { Agent } = require('../agent/agent');
const { DEFAULT_RISK } = require('../agent/guardrails');
const { Browser } = require('../agent/browser');
const { TaskManager } = require('../agent/tasks');
const { PRESETS, listModels } = require('./providers');
const updater = require('./updater');
const skills = require('../agent/skills');
const i18n = require('../agent/i18n');
const { registerSkillsIpc } = require('./ipc-skills');
registerSkillsIpc(ipcMain, { skills, runlog: require('../agent/runlog') });

// ---- memoria/hábitos/salud: router en main/ipc-memory.js (tercer router de la fase 4) ----
const { registerMemoryIpc } = require('./ipc-memory');
registerMemoryIpc(ipcMain, {
  memory: require('../agent/memory'),
  models: require('../agent/models'),
  habits: require('../agent/habits'),
  /* Perezoso a propósito: `getWin` se asigna al crear la ventana (más abajo) y el router
     solo lo necesita cuando el almacén avisa de una propuesta, ya con la app en marcha. */
  getWin: () => getWin(),
});
const marketplace = require('../agent/marketplace');
const habits = require('../agent/habits');
const { McpManager, serverSlug } = require('../agent/mcp');
const { registerMcpIpc } = require('./ipc-mcp');
const mcpConfig = require('./mcp-config');
// config es un único objeto vivo (se muta, no se reasigna): ctx.config() lo lee siempre fresco.
registerMcpIpc(ipcMain, {
  config: () => config,
  wireMcp,
  persistConfig,
  mcpState,
  mcpExport,
  setAgentPolicy: (sec) => {
    for (const a of runtimes.allAgents()) a.setPolicy(sec);
  },
  mcpConfig,
  serverSlug,
});

// Solo para probar el actualizador: apunta la comprobación a otra API de releases
// (p. ej. un JSON local con una versión inventada) y hace que también se compruebe
// en los arranques ocultos. En uso normal no está definida y no cambia nada.
// SEGURIDAD: solo se acepta en compilaciones SIN empaquetar (dev): en la app
// instalada, una variable de entorno heredada de otro proceso podría redirigir el
// feed de actualizaciones a un servidor del atacante (y el sha512 vendría de su
// propio latest.yml). En producción el feed es siempre el oficial.
const UPDATE_API_RAW = process.env.SAGITARI_UPDATE_API || '';
const UPDATE_API = !app.isPackaged ? UPDATE_API_RAW : '';
if (UPDATE_API_RAW && app.isPackaged) {
  try {
    console.warn('SAGITARI_UPDATE_API ignorada en la app instalada (solo dev).');
  } catch {}
}

// Windows usa este identificador para asociar la ventana con su icono y agruparla
// en la barra de tareas. Debe coincidir con el `appId` de electron-builder y se
// fija antes de crear el bloqueo de instancia, incluido el modo desarrollo;
// de lo contrario Windows identifica el proceso como electron.exe.
const APP_USER_MODEL_ID = 'com.sagitari.app';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

// Los arranques de prueba usan SU PROPIO directorio de datos. El bloqueo de
// instancia única va ligado al userData: si lo compartieran con la app real,
// una prueba que tardara en morir retenía el bloqueo y el lanzamiento final de
// probar.bat se cerraba solo, en silencio. Eso era «la app se cierra».
// Se fija ANTES de pedir el bloqueo, que se calcula a partir de esta ruta.
if (HEADLESS) {
  // Chromium crea el fichero del bloqueo ANTES de crear el userData, así que un
  // perfil que todavía no existe —un clon recién bajado, un arranque de prueba con
  // un directorio nuevo— hacía fallar el bloqueo: la app decía «ya está abierta» sin
  // que hubiera ninguna y el arnés se caía. La carpeta se crea aquí, antes de pedir
  // el bloqueo.
  try {
    fs.mkdirSync(PERFIL, { recursive: true });
  } catch {}
  try {
    app.setPath('userData', PERFIL);
  } catch {}
}

// single instance: si ya está abierta, enfoca la ventana existente
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // OJO: salir en silencio aquí es lo que hacía parecer que «la app se cierra».
  // La instancia que ya corre recibe 'second-instance' y se muestra sola.
  try {
    process.stdout.write('SAGITARI ya está abierta: se muestra la ventana existente.\n');
  } catch {}
  /* En un arranque de PRUEBA, perder el bloqueo es un fallo: el smoke mide que la app
     abra ventana de verdad (su veredicto es el código de salida) y aquí no se llega a
     crear ninguna. Salir con 0 hacía que el arnés lo contara como verde. */
  if (HEADLESS) app.exit(9);
  else app.quit();
}
app.on('second-instance', () => showWindow());

// ---------- config ----------
const CONFIG_DIR = DATA_DIR; // la misma raíz que usan los módulos de agent/ (ver arriba)
const LEGACY_CONFIG = path.join(app.getPath('appData'), 'JarvisAI', 'config.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let config = {
  providers: [], // [{id, name, baseUrl, apiKey, models:[], activeModel}]
  active: null, // {providerId, name, baseUrl, apiKey, model, temperature, vision}
  settings: {
    theme: 'violet',
    uiColor: 'aurora',
    glowColor: 'match',
    glowStrength: 1,
    glassTint: 1,
    glowEnabled: true,
    // El nombre del usuario no viene de fábrica: lo escribe su dueño en
    // Ajustes ▸ Personal. Vacío = no se le manda al modelo y la interfaz dice «Tú».
    userName: '',
    mode: 'act',
    maxConcurrentTasks: 1,
    // v4.4: tope de gasto por encargo de equipo en USD (0 = sin tope propio)
    equipoPresupuestoUsd: 0,
    autoResumeTasks: true,
    llmTimeoutMs: 120000,
    showThinking: false,
    reviewGate: true,
    parallelTools: 3,
    diagnosticosEscritura: true,
    verificacionCierre: true,
    intentosArreglo: 2,
    promptCache: true,
    hookEditar: '',
    hookCerrar: '',
    /* Fase 1 de memoria: aprender de las conversaciones (propone y espera aprobación) y
       guardar sin preguntar (acepta solo lo propuesto). El aprendizaje es opt-out — viene
       encendido porque sin él la memoria no se llena sola—; guardar solo, opt-in. */
    memoryLearn: true,
    memoryAutoSave: false,
  },
  mcp: { enabled: true, servers: [] }, // servidores MCP del usuario (ver main/mcp-config.js)
};

/* Idioma de la interfaz resuelto al arrancar. Se declara con el español puesto porque el
   factory de la ventana se monta ANTES de leer config.json; cuando la ventana se abre de
   verdad (siempre después de loadConfig) ya lleva el valor definitivo. */
let idiomaActivo = 'es';

// Ventana principal: se crea aquí con dependencias lazy (agentes y config se asignan más tarde)
const ventana = crearVentana({
  HIDDEN,
  DEV,
  INDEX_HTML: path.join(__dirname, '..', 'renderer', 'index.html'),
  /* ventana.js solo usa esto para parar el chat cuando el proceso de render se cae
     ('render-process-gone'): con varias conversaciones hay que pararlas TODAS, así que
     se le da el «parar todo» del registro (lo mismo que hace el cierre ordenado). */
  getAgent: () => ({ stop: () => runtimes.stopAll() }),
  getConfig: () => config,
  saveConfig,
  /* La ventana ya está cargada: es el momento de soltar los avisos que llegaron antes de
     que existiera (el historial ilegible se detecta al cargar conversations.json). */
  onListo: () => soltarAvisos(),
  /* Función, no valor: config.json no se ha leído todavía al montar el factory. */
  idioma: () => idiomaActivo,
});
const { createChatWindow, showWindow, glow, getWin } = ventana;

// Bandeja del sistema: sin ella, ocultar la ventana dejaba SAGITARI inalcanzable
const bandeja = crearBandeja({ HEADLESS, showWindow, getWin, app });
const { createTray, getTray } = bandeja;

/* ---- v1.1 seguridad: permisos por herramienta + guardarraíles (configurables) ---- */
const securityDefaults = {
  permissions: {}, // { toolName: 'safe'|'confirm'|'restricted' } — vacío = defaults
  guardrails: {
    maxSteps: 60, // 0 = sin límite
    maxToolCalls: 80, // 0 = sin límite
    maxDurationMs: 15 * 60 * 1000, // 0 = sin límite
    maxTokens: 0, // 0 = sin límite
    maxCostUsd: 0, // 0 = sin límite (coste estimado en USD)
    maxDelegations: 8, // subagentes por turno (0 = sin tope)
    loopThreshold: 3, // llamadas idénticas seguidas antes de parar
    stallThreshold: 6, // pasos sin progreso antes de parar (0 = sin límite)
  },
};

/* ---------- claves de API en disco ----------
   Las claves se guardan cifradas con el almacén del sistema (DPAPI en Windows vía
   safeStorage): un config.json copiado, sincronizado o leído por otro programa ya
   no expone las credenciales. En memoria siempre están en claro porque el agente
   las necesita para llamar al proveedor. Si el sistema no ofrece cifrado, se
   guarda en claro y queda constancia en el log: antes se hacía siempre. */

/** Copia del config con las claves cifradas, tal y como va a disco. */
function configParaDisco() {
  const paint = (p) => (p && typeof p === 'object' ? { ...p, apiKey: protectKey(p.apiKey) } : p);
  return {
    ...config,
    providers: (config.providers || []).map(paint),
    active: paint(config.active),
    // los tokens de los servidores MCP viven en env/headers: mismo trato que las claves
    mcp: { ...config.mcp, servers: ((config.mcp && config.mcp.servers) || []).map(protegerServidorMcp) },
  };
}

/** env/headers siempre cifrados y la URL SOLO si lleva credenciales
    (`https://usuario:token@host` o `?key=…`): un token pegado en la URL no puede quedar
    en claro en config.json (que es justo lo que la migración a cifrado evita) ni viajar
    sin enmascarar a la vista (ver mcpState). Una URL normal se guarda legible. */
function protegerServidorMcp(s) {
  const prot = protectServerSecrets(s);
  return s && mcpConfig.urlLlevaCredenciales(s.url) ? { ...prot, url: protectKey(s.url) } : prot;
}
/** Alguna clave sin cifrar en memoria → hay que reescribir el fichero. */
function needsKeyEncryption() {
  if (!encryptionAvailable()) return false;
  const sinCifrar = (p) => !!(p && typeof p.apiKey === 'string' && p.apiKey && !p.apiKey.startsWith(KEY_PREFIX));
  if (sinCifrar(config.active) || (config.providers || []).some(sinCifrar)) return true;
  // los secretos de un servidor MCP también cuentan: si se quedaran en claro, un
  // config.json copiado expondría los tokens igual que antes con las claves. La URL con
  // credenciales es uno de esos secretos (y así migra a cifrado en el siguiente arranque).
  return ((config.mcp && config.mcp.servers) || []).some(
    (s) =>
      [...Object.values(s.env || {}), ...Object.values(s.headers || {})].some((v) => v && !String(v).startsWith(KEY_PREFIX)) ||
      (mcpConfig.urlLlevaCredenciales(s.url) && !String(s.url).startsWith(KEY_PREFIX)),
  );
}

function applyConfig(raw) {
  config = { ...config, ...raw, settings: { ...config.settings, ...(raw.settings || {}) } };
  /* Una clave que NO se puede descifrar (config copiada de otro equipo o perfil, o
     clave maestra recreada) es una condición ESPERADA y recuperable, no un fallo
     interno: la app arranca, el proveedor queda marcado y se le pide al usuario que
     la vuelva a escribir. Antes esto entraba por `registrarFallo` y sacaba un diálogo
     modal «SAGITARI — fallo interno» antes de poder usar nada — con la clave intacta
     en disco, que es justo lo que el propio módulo documenta que debe pasar. */
  const ilegible = (p) => {
    if (!p || typeof p !== 'object') return p;
    try {
      log.warn('[SAGITARI] hay una clave guardada que este equipo no puede descifrar: vuelve a escribirla en Ajustes');
    } catch {}
    try {
      runlog.log({ agent: 'sagitari', event: 'key_unreadable' });
    } catch {}
    return { ...p, keyUnreadable: true };
  };
  // de disco llegan cifradas: en memoria el agente necesita el valor real
  /* `revealKey` avisa por callback SOLO cuando no puede descifrar. Marcar por el hecho
     de llamarla marcaba TODAS las claves, también las que se descifran bien: el usuario
     veía «hay una clave que este equipo no puede descifrar, vuelve a escribirla» en cada
     arranque y el flag `keyUnreadable` quedaba escrito en config.json para siempre. */
  const revelada = (p) => {
    let fallo = null;
    const apiKey = revealKey(p.apiKey, (kind, err) => {
      fallo = err;
    });
    return fallo ? ilegible({ ...p, apiKey }) : { ...p, apiKey, keyUnreadable: false };
  };
  if (config.active && config.active.apiKey) config.active = revelada(config.active);
  config.providers = (config.providers || []).map((p) => (p && p.apiKey ? revelada(p) : p));
  config.security = {
    permissions: { ...((raw.security && raw.security.permissions) || {}) },
    guardrails: { ...securityDefaults.guardrails, ...((raw.security && raw.security.guardrails) || {}) },
    /* Derivado, no un segundo sitio donde guardarlo: `autoEdits` es una preferencia del
       usuario y vive en `settings` (que es lo que lee la interfaz), pero el motor de
       permisos solo recibe la POLÍTICA. Al recomponer `security` en cada arranque, esto
       mantiene al agente y al interruptor de acuerdo sin duplicar el dato. */
    autoEdits: config.settings.autoEdits === true,
  };
  // MCP: la lista de servidores la valida el módulo puro (comando, URL, timeout)
  const mcpRaw = raw.mcp && Array.isArray(raw.mcp.servers) ? raw.mcp.servers : [];
  const servers = [];
  for (const def of mcpRaw) {
    let secretoIlegible = false;
    const marcar = () => {
      secretoIlegible = true;
    };
    /* La URL con credenciales viaja cifrada (ver configParaDisco): se descifra ANTES de
       validarla. Si no se puede descifrar (config copiada de otro equipo o perfil), el
       servidor NO se tumba ni se pierde: se conserva tal cual y se marca, como con env. */
    const s = typeof def.url === 'string' && def.url.startsWith(KEY_PREFIX) ? { ...def, url: revealKey(def.url, marcar) } : def;
    if (typeof s.url === 'string' && s.url.startsWith(KEY_PREFIX)) {
      servers.push({ ...s, secretUnreadable: true });
      continue;
    }
    const v = mcpConfig.validateServer(s);
    // mismos tokens cifrados, mismo trato: ilegible se marca, no tumba el arranque
    if (v.ok) {
      const rev = revealServerSecrets(v.value, (k) => revealKey(k, marcar));
      servers.push(secretoIlegible ? { ...rev, secretUnreadable: true } : rev);
    } else {
      /* Un servidor que no pasa la validación (una entrada editada a mano, o de otra
         versión de la app) NO se puede tirar en silencio: el siguiente guardado —el de
         la geometría de la ventana, por ejemplo— reescribe la lista entera y lo borraría
         del disco sin que nadie se entere. Se conserva marcado, no se arranca solo y la
         vista lo puede enseñar como inválido. */
      servers.push({ ...s, invalid: String((v && v.error) || i18n.t('mcp.invalido')) });
      log.warn('[SAGITARI] servidor MCP conservado pero inválido (no se arranca): ' + (s.id || '?') + ' — ' + (v && v.error));
    }
  }
  config.mcp = { enabled: raw.mcp ? raw.mcp.enabled !== false : true, servers };
}
/* La app anterior (JarvisAI) guardaba las claves EN CLARO en su config. Al migrar se
   copian a SAGITARI —donde `configParaDisco` las cifra—, pero el fichero viejo seguía
   ahí con la credencial a la vista: el cifrado no protegía nada mientras existiera esa
   copia. Se CONSERVA el fichero (por si el usuario vuelve a la versión anterior) pero
   sin secretos; el resto de la configuración se queda como estaba. */
function limpiarSecretosLegado() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
    const limpio = sinSecretos(raw);
    const yaLimpio = JSON.stringify(limpio) === JSON.stringify(raw);
    if (yaLimpio) return; // nada que borrar (ya migrado antes)
    writeJsonAtomic(LEGACY_CONFIG, JSON.stringify(limpio, null, 2));
    log.info('[SAGITARI] config de la versión anterior migrada: sus claves ya solo están cifradas en SAGITARI');
  } catch (e) {
    // no es fatal: la app ya arrancó con la configuración migrada
    log.warn('[SAGITARI] no se pudieron borrar las claves del config anterior: ' + ((e && e.message) || e));
  }
}
function loadConfig() {
  try {
    applyConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    return;
  } catch (e) {
    // config.json ilegible: antes de dar la configuración por perdida se prueba
    // la copia .bak que deja cada guardado.
    try {
      applyConfig(JSON.parse(fs.readFileSync(CONFIG_FILE + '.bak', 'utf8')));
      console.error('config.json ilegible, recuperado desde config.json.bak:', e.message);
      return;
    } catch {}
    // migración desde la app anterior (JarvisAI → SAGITARI); nunca en los modos
    // de prueba, que no deben leer la configuración real del usuario
    if (!HEADLESS) {
      try {
        applyConfig(JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8')));
        config.security = { permissions: {}, guardrails: { ...securityDefaults.guardrails } };
        saveConfig();
        // el original ya no puede quedarse con la clave en claro
        limpiarSecretosLegado();
        return;
      } catch {}
    }
    config.security = { permissions: {}, guardrails: { ...securityDefaults.guardrails } };
  }
}
function saveConfig() {
  try {
    writeJsonAtomic(CONFIG_FILE, JSON.stringify(configParaDisco(), null, 2));
    return { ok: true };
  } catch (e) {
    console.error('saveConfig', e.message);
    return { ok: false, error: e.message };
  }
}

/** Aviso al usuario cuando un guardado en disco falla (configuración o
    conversaciones): los controles ya lo dieron por bueno en pantalla, así que un
    console.error silencioso le deja creyendo que se guardó algo que se perderá al
    reiniciar. Se limita a un aviso cada 30 s: un disco lleno no debe inundar el chat. */
let avisoDiscoAt = 0;
/* Avisos que llegan ANTES de que exista la ventana (el historial de conversaciones
   ilegible se detecta al cargar conversations.json, en el arranque): se guardan y se
   sueltan en cuanto la ventana está cargada. Antes se enviaban a una ventana que aún no
   existía y el usuario no se enteraba de nada (en la app empaquetada no hay consola). */
const avisosPendientes = [];
/* `titulo`/`mensaje` pueden llegar como FUNCIÓN: un router se monta antes de que se fije
   el idioma. Se encola la función TAL CUAL y se resuelve aquí, con la ventana ya delante
   y el idioma fijado: resolver antes del chequeo de ventana congelaría el idioma por
   defecto en el aviso encolado (era el fallo del historial ilegible). */
function enviarAviso(titulo, mensaje) {
  const w = getWin();
  if (!w || w.isDestroyed()) {
    if (avisosPendientes.length < 5) avisosPendientes.push({ titulo, mensaje });
    return;
  }
  if (typeof titulo === 'function') ({ titulo, mensaje } = titulo());
  else if (typeof mensaje === 'function') mensaje = mensaje();
  try {
    w.webContents.send('agent:event', { type: 'toast', title: titulo, message: mensaje });
  } catch {}
}
/** La ventana ya está cargada: se sueltan los avisos que no cabían antes. */
function soltarAvisos() {
  if (!getWin() || getWin().isDestroyed()) return;
  while (avisosPendientes.length) {
    const a = avisosPendientes.shift();
    enviarAviso(a.titulo, a.mensaje);
  }
}
function avisarDisco(mensaje) {
  const now = Date.now();
  if (now - avisoDiscoAt < 30000) return;
  avisoDiscoAt = now;
  enviarAviso(i18n.t('aviso.guardar.titulo'), mensaje);
}

/* Persiste y, si falla, avisa al usuario: los controles de Ajustes ya han
   confirmado el cambio en pantalla, así que un console.error silencioso deja al
   usuario creyendo que se guardó algo que se perderá al reiniciar. */
function persistConfig() {
  const r = saveConfig();
  if (!r.ok) avisarDisco(i18n.t('aviso.config.disco', { motivo: r.error }));
  return r;
}

// ---------- agent wiring (v1.3: agentes de chat Y de background) ----------
const browser = new Browser();
/* v4.3: ya no hay UN agente del chat. Cada conversación tiene el suyo en `runtimes`
   (main/runtimes.js) y pueden trabajar varias a la vez; antes cada `conv:open`
   reapuntaba el único agente y abrir otra pestaña le robaba el turno a la primera. */
let taskManager = null; // cola de tareas en background (agent/tasks.js)

const runlog = require('../agent/runlog');

// ---- adjuntos del chat (attachments:*): router en main/ipc-chat.js (octavo router de la fase 4) ----

/* ---------------------------------------------------------------------------
   Fallos del proceso principal.
   Sin esto, un error no capturado mata la app de golpe y sin rastro: la ventana
   desaparece y no queda nada escrito en ningún sitio (el log por sesión se
   pierde, porque su buffer no llega a volcarse). Ahora todo queda en
   logs/crash.log y se avisa en pantalla. La app NO se cierra: casi siempre el
   fallo está en una operación concreta y el resto sigue funcionando.
   --------------------------------------------------------------------------- */
function registrarFallo(kind, err) {
  const message = String((err && err.message) || err || 'desconocido');
  const stack = String((err && err.stack) || '').slice(0, 4000);
  try {
    const dir = path.join(CONFIG_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'crash.log'),
      JSON.stringify({ ts: new Date().toISOString(), kind, version: app.getVersion(), message, stack }) + '\n',
      'utf8',
    );
  } catch {}
  try {
    runlog.log({ agent: 'sagitari', event: 'crash', kind, message: message.slice(0, 300) });
  } catch {}
  try {
    console.error('[SAGITARI] ' + kind + ': ' + message);
  } catch {}
  // un aviso por tipo como máximo: si el fallo se repite en bucle, no molesta
  if (avisosDeFallo++ < 3) {
    try {
      if (getWin() && !getWin().isDestroyed())
        getWin().webContents.send('agent:event', {
          type: 'error',
          message: i18n.t('error.interno.aviso', { tipo: kind, mensaje: message.slice(0, 200) }),
        });
      else
        dialog.showErrorBox(
          i18n.t('error.interno.titulo'),
          i18n.t('error.interno.detalle', { mensaje: message.slice(0, 400) }),
        );
    } catch {}
  }
  return message;
}

/* ---- rastro del turno: el estado compacto vive en main/traza.js y lo comparten
   agentEmit (aquí, cierra el turno) y el router ipc-chat (chat:send/retry, lo abren).
   UN rastro POR conversación: con varias pestañas a la vez, uno solo mezclaría las
   tarjetas de un turno con las de otro. ---- */
const { trazaApunta, trazaActual, trazaCerrar } = require('./traza');

function agentEmit(convId, e, isBackground) {
  // v1.3: los eventos de tareas en background se marcan para que el renderer NO
  // los mezcle con el chat interactivo (burbujas, estado busy, etc.).
  // v4.3: y todo evento del chat viaja con SU conversación: con varias pestañas, el
  // renderer necesita saber a cuál pertenece cada burbuja, cada tarjeta y cada aviso
  // (es lo que decide, por ejemplo, en qué pestaña sale la barra de deshacer).
  const out = isBackground ? { ...e, bg: true } : { ...e, convId };
  if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('agent:event', out);
  if (e.type === 'tool') glow('work', 'work');
  // solo el chat interactivo escribe en la conversación de la que sale el evento
  if (!isBackground) {
    trazaApunta(convId, e);
    if (e.type === 'assistant_done') {
      /* El turno ha terminado: la luz vuelve a la CALMA. Antes se ponía en `think`, así
         que el panel lateral se quedaba encendido para siempre al acabar cada turno —
         el estado se veía como si el agente siguiera pensando. */
      glow('off');
      const c = convsApi.convById(convId);
      if (c && e.text) {
        const tt = trazaActual(convId);
        const conTraza = tt && (tt.tools.length || (tt.think && tt.think.text) || (tt.todos && tt.todos.length)) ? tt : null;
        // Se guarda la narración COMPLETA del turno, no solo el párrafo final:
        // reabrir la conversación enseña lo mismo que se vio en vivo.
        const completo = e.transcript && e.transcript.length > e.text.length ? e.transcript : e.text;
        c.messages.push({ role: 'assistant', content: completo, ts: Date.now(), ...(conTraza ? { trace: conTraza } : {}) });
        c.updatedAt = Date.now();
        saveConvs();
      }
      // el turno se cierra: el rastro siguiente es de otro turno
      trazaCerrar(convId);
    }
  }
}

/* ---- MCP: el gestor vive aquí y el catálogo lo consulta tools.js por turno ---- */
let mcp = null;
function wireMcp() {
  if (!mcp) mcp = new McpManager({ servers: [], dataDir: CONFIG_DIR, clientVersion: app.getVersion(), log: (e) => runlog.log(e) });
  mcp.configure(config.mcp.servers || []);
  // El interruptor global se aplica AQUÍ: si está apagado, el catálogo que ve el
  // modelo no incluye ninguna herramienta MCP (el renderer no puede quitarlas).
  // Y el catálogo se pide en cada turno: conectar un servidor no exige reiniciar la app.
  require('../agent/tools').setDynamicToolProvider(() => (config.mcp.enabled === false ? [] : mcp.toolDefs()));
  return mcp;
}

function createAgent(isBackground = false, convId = null) {
  return new Agent({
    guardrailsPolicy: config.security,
    emit: (e) => agentEmit(convId, e, isBackground),
    screenshotFn: async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size });
      const s = sources[0];
      const png = s.thumbnail.toPNG();
      const b64 = 'data:image/png;base64,' + png.toString('base64');
      return { dataUrl: b64, w: s.thumbnail.getSize().width, h: s.thumbnail.getSize().height };
    },
    browser,
    mcp: wireMcp(), // el ejecutor despacha mcp__*: sin esto, «no hay servidores MCP en esta ejecución»
  });
}

/* ---- v4.3: registro de agentes vivos, uno por conversación (main/runtimes.js) ----
   `convsApi` se consulta DENTRO de las funciones: el router de conversaciones se
   registra más abajo, cuando ya existe el historial guardado. */
const runtimes = createRuntimes({
  createAgent: (convId) => createAgent(false, convId),
  mensajesDe: (convId) => {
    const c = convsApi.convById(convId);
    return c ? c.messages : null;
  },
  convActual: () => {
    const c = convsApi.currentConv();
    return c ? c.id : null;
  },
  /* Al soltar una conversación (borrada, podada o al cerrar la app) se tira también lo
     que solo a ella pertenecía: su rastro del turno y las pre-imágenes de sus cambios
     (guardan CONTENIDO de archivos, así que dejarlas sería retener megas de una
     conversación que ya no existe). El dueño se deriva del id de la conversación, que es
     lo que el agente usa como dueño (ver agent/cambios.js).
     EXCEPCIÓN: podar un runtime ocioso NO es borrar la conversación. Sus pre-imágenes son
     las del ÚLTIMO turno, y el botón «Deshacer el cambio» sigue en pantalla: olvidarlas
     dejaba el botón dando error. Se olvidan cuando la conversación desaparece o al cerrar
     (y el siguiente turno de esa conversación las reemplaza él mismo). */
  onDispose: (convId, motivo) => {
    trazaCerrar(convId);
    if (motivo !== 'podado') cambios.olvidar(getWorkspace(), runtimes.ownerOf(convId));
  },
});

// ---- v1.3: TaskManager — cola de tareas en background con notificaciones ----
function wireTaskManager() {
  if (taskManager) return taskManager;
  taskManager = new TaskManager({
    getSettings: () => config,
    agentFactory: () => createAgent(true),
    // el chat y las tareas comparten run store: «Reanudar» no puede lanzar un
    // segundo agente sobre el run que el chat está ejecutando ahora mismo
    // (y el chat puede ser CUALQUIERA de las conversaciones abiertas)
    isRunBusy: (runId) => runtimes.allAgents().some((a) => a.isBusy() && a.currentRunId === runId),
    emit: (e) => {
      if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('agent:event', e);
    },
    notify: (run, kind) => {
      const ESTADO = {
        completed: 'aviso.tarea.completada',
        failed: 'aviso.tarea.fallo',
        cancelled: 'aviso.tarea.cancelada',
        paused: 'aviso.tarea.pausada',
      };
      const title = i18n.t('aviso.tarea.titulo', { estado: i18n.t(ESTADO[kind] || 'aviso.tarea.actualizada') });
      const body = String(run.goal || '').slice(0, 120);
      try {
        const { Notification } = require('electron');
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch {}
      if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('agent:event', { type: 'toast', title, message: body });
      runlog.log({ agent: 'sagitari', task: run.runId, event: 'task_notify', kind });
    },
  });
  return taskManager;
}

// ---------- IPC ----------
/* Los handlers de configuración, proveedores y ajustes viven en ipc-config.js
   (cuarto router de la fase 4). Los helpers de secretos se importan aquí porque
   mcpState() (dominio MCP) los usa para enmascarar env/headers. */
const { registerConfigIpc, enmascararMapaSecretos, claveGuardadaPara } = require('./ipc-config');
registerConfigIpc(ipcMain, {
  config: () => config,
  persistConfig,
  PRESETS,
  listModels,
  glow,
  getWin: () => getWin(),
  isHidden: () => HIDDEN,
  // un ajuste de seguridad puede llegar por `settings:set` (autoEdits) y hay que
  // empujarlo a los agentes vivos: el motor de permisos lee la política, no los ajustes
  setAgentPolicy: (sec) => {
    for (const a of runtimes.allAgents()) a.setPolicy(sec);
  },
});

// ---- modo/agentes/market: router en main/ipc-modo.js (noveno router de la fase 4) ----
const { registerModoIpc } = require('./ipc-modo');
registerModoIpc(ipcMain, {
  config: () => config,
  saveConfig,
  runtimes,
  getSkills: () => skills,
  getHabits: () => habits,
  marketplace,
  fsp,
  // Registro de agentes: los de serie más los que el usuario deja en disco.
  getSubagents: () => require('../agent/subagents'),
});

// ---- chat/adjuntos/traza: router en main/ipc-chat.js (octavo router de la fase 4) ----

const checkpoints = require('../agent/checkpoints');
const cambios = require('../agent/cambios'); // v2.5: pre-imágenes del turno (revisión y deshacer)
const repomap = require('../agent/repomap'); // v2.5: hay que invalidarlo cuando se deshace
const instrucciones = require('../agent/instrucciones'); // v2.5: SAGITARI.md / AGENTS.md del proyecto

// ---- tareas/seguridad/meta: router en main/ipc-tareas.js (sexto router de la fase 4) ----
const { registerTareasIpc } = require('./ipc-tareas');
registerTareasIpc(ipcMain, {
  config: () => config,
  persistConfig,
  getTaskManager: () => wireTaskManager(),
  peekTaskManager: () => taskManager,
  checkpoints,
  runtimes,
  securityDefaults,
  DEFAULT_RISK,
  CONFIG_DIR,
  runlog,
  getWin: () => getWin(),
});

// ---- conversaciones/workspace: router en main/ipc-convs.js (séptimo router de la fase 4) ----
const { registerConvsIpc } = require('./ipc-convs');
const convsApi = registerConvsIpc(ipcMain, {
  config: () => config,
  saveConfig,
  configDir: () => CONFIG_DIR,
  writeJsonAtomic,
  onSaveError: (m) => avisarDisco(m),
  /* Aviso CON título propio: se usa cuando el historial no se pudo leer (y hay que decir
     qué se ha hecho con el fichero ilegible). Llega al renderer por el mismo canal que el
     aviso de disco, y se encola si la ventana todavía no existe. */
  avisar: (titulo, mensaje) => enviarAviso(titulo, mensaje),
  getWin: () => getWin(),
  runtimes,
  dialog,
  app,
  fs,
  path,
});
const { saveConvs, getWorkspace } = convsApi;

// ---- cambios/instrucciones: router en main/ipc-cambios.js (undécimo router de la fase 4) ----
const { registerCambiosIpc } = require('./ipc-cambios');
registerCambiosIpc(ipcMain, {
  runtimes,
  getWorkspace,
  cambios,
  repomap,
  instrucciones,
  runlog,
  fs,
  path,
});

// ---- app/shell/glow: router en main/ipc-misc.js (décimo router de la fase 4) ----
const { registerMiscIpc } = require('./ipc-misc');
registerMiscIpc(ipcMain, {
  config: () => config,
  saveConfig,
  getWin: () => getWin(),
  getWorkspace,
  configDir: () => CONFIG_DIR,
  getGlow: (...a) => glow(...a),
  app,
  shell,
  dialog,
  fsp,
  fs,
  path,
});

// ---- chat/adjuntos/traza: router en main/ipc-chat.js (octavo router de la fase 4) ----
const { registerChatIpc } = require('./ipc-chat');
registerChatIpc(ipcMain, {
  config: () => config,
  runtimes,
  convsApi,
  getSkills: () => skills,
  getGlow: (...a) => glow(...a),
  /* El almacén de memoria, para el gancho de aprendizaje al cerrar el turno. Perezoso,
     como los demás: `require` en el arranque ya no aporta nada y el módulo se resuelve
     igual en cada cierre de turno. */
  memory: () => require('../agent/memory'),
  getWin: () => getWin(),
  configDir: () => CONFIG_DIR,
  onError: (k, err) => registrarFallo(k, err),
  dialog,
  fsp,
  fs,
  path,
  attach: require('./attachments'),
});

/* ---------- v3.1: servidores MCP del usuario ---------- */
/* Estado para la UI: la configuración del servidor MÁS el estado vivo del gestor.
   Los secretos (env/headers, que suelen ser tokens) viajan ENMASCARADOS ('••••'):
   el formulario los reenvía tal cual y mcp:save los interpreta como «conservar»
   (ver mergeSecrets en mcp-config.js). Antes viajaban en claro y un XSS los robaba.
   `discovered` es el catálogo REAL descubierto: NO se puede llamar `tools` porque
   `tools` en la configuración son los filtros allow/deny.
   `permKey` es el comodín de permisos de TODAS sus herramientas, con la MISMA
   normalización que el nombre expuesto: se calcula aquí y la UI lo usa tal cual, porque
   con un id con guion o de más de 16 caracteres el id crudo no coincidiría con el
   nombre real (y el nivel por servidor no llegaría a aplicarse). */
function mcpState() {
  const vivo = new Map(
    wireMcp()
      .status()
      .map((s) => [s.id, s]),
  );
  return {
    enabled: config.mcp.enabled !== false,
    servers: (config.mcp.servers || []).map((s) => {
      const v = vivo.get(s.id) || {};
      return {
        ...s,
        // una URL `https://usuario:token@host` o `?key=SECRETO` es un secreto: viaja
        // enmascarada y mcp:save recupera la guardada si el formulario la reenvía así
        url: mcpConfig.enmascararUrl(s.url),
        env: enmascararMapaSecretos(s.env),
        headers: enmascararMapaSecretos(s.headers),
        permKey: 'mcp__' + serverSlug(s.id) + '__*',
        enabled: v.enabled !== undefined ? v.enabled : s.enabled,
        state: v.state || 'idle',
        error: v.error || null,
        // el stderr de un servidor puede traer su token en un error: misma máscara que env/headers
        logTail: runlog.redactText(v.logTail || ''),
        discovered: v.tools || [],
      };
    }),
  };
}

/* Exporta los servidores en el formato `mcpServers` de otros clientes, con los
   valores EN CLARO: el usuario los pide justo para copiarlos en otra app y en disco
   ya viven cifrados. La UI avisa de que el texto contiene sus secretos. */
function mcpExport() {
  const mcpServers = {};
  for (const s of config.mcp.servers || []) {
    mcpServers[s.id] =
      s.transport === 'http'
        ? { url: s.url, headers: { ...(s.headers || {}) } }
        : { command: s.command, args: [...(s.args || [])], env: { ...(s.env || {}) } };
  }
  return { mcpServers };
}

// ---------- app lifecycle ----------
// copia las skills incluidas (skills-starter/) al perfil del usuario UNA sola vez
function seedStarterSkills() {
  try {
    // La siembra es de una sola vez y queda apuntada en `migraciones` (igual que la
    // reparación del nombre de fábrica): si corriera en cada arranque, una skill de
    // serie borrada desde la interfaz reaparecería al reiniciar, que es justo lo que
    // el diálogo de borrado promete que no pasa («no se puede deshacer»).
    const src = path.join(__dirname, '..', 'skills-starter');
    const mig = (config.migraciones = config.migraciones || {});
    let cambios = false;

    /* Copia la carpeta ENTERA de una skill, no solo su SKILL.md: las que traen
       references/, scripts/ y assets/ (oil-ui) quedaban sin sus piezas y el agente
       no podía abrir nada de lo que el cuerpo le manda leer. Se lee y se escribe, NO
       `copyFileSync`: dentro del paquete el origen vive en `app.asar` y copyFile no
       sabe abrir un archivo del archivo empaquetado. */
    const copiarSkill = (name) => {
      const origen = path.join(src, name);
      if (!fs.existsSync(path.join(origen, 'SKILL.md'))) return false; // no es una skill
      // ya instalada: no se pisa (lo que el usuario haya editado se queda)
      if (fs.existsSync(path.join(skills.skillsDir(), name, 'SKILL.md'))) return false;
      const copiar = (de, a) => {
        fs.mkdirSync(a, { recursive: true });
        /* `statSync` y no el `Dirent` de `readdirSync`: así se recorre igual dentro
           del paquete, donde las carpetas las sintetiza el soporte de `app.asar`. */
        for (const nombre of fs.readdirSync(de)) {
          const desde = path.join(de, nombre);
          const hasta = path.join(a, nombre);
          if (fs.statSync(desde).isDirectory()) copiar(desde, hasta);
          else fs.writeFileSync(hasta, fs.readFileSync(desde));
        }
      };
      copiar(origen, path.join(skills.skillsDir(), name));
      return true;
    };

    // 1) primera instalación del perfil: todas las skills de serie, de una vez
    if (!mig.skillsStarter) {
      for (const name of fs.readdirSync(src)) if (copiarSkill(name)) cambios = true;
      mig.skillsStarter = true;
      cambios = true;
    }

    /* 2) skills de serie que llegan DESPUÉS de la siembra inicial: se ofrecen UNA vez
       a los perfiles que ya existían. Quedan apuntadas como ofrecidas, así que una que
       el usuario borre después no resucita en el siguiente arranque. */
    const NUEVAS = ['oil-ui'];
    const ofrecidas = Array.isArray(mig.skillsStarterNuevas) ? mig.skillsStarterNuevas : [];
    for (const name of NUEVAS) {
      if (ofrecidas.includes(name)) continue;
      if (copiarSkill(name)) cambios = true;
      ofrecidas.push(name);
      cambios = true;
    }
    mig.skillsStarterNuevas = ofrecidas;

    if (cambios) saveConfig();
  } catch (e) {
    console.error('seedStarterSkills', e.message);
  }
}

// ---- actualizaciones: router en main/ipc-update.js (duodécimo router de la fase 4) ----
const { registerUpdateIpc } = require('./ipc-update');
const updateApi = registerUpdateIpc(ipcMain, {
  config: () => config,
  saveConfig,
  getWin: () => getWin(),
  updater,
  UPDATE_API,
  DATA_DIR,
  runlog,
  app,
  shell,
  fsp,
  fs,
  path,
});

// ---- cambios/instrucciones: router en main/ipc-cambios.js (undécimo router de la fase 4) ----

/* --------------------------------------------------------------------------- *
 *  `--banco`: el banco de pruebas de tareas (npm run banco)
 *
 *  Usa TU proveedor real, con tu configuración y tus ajustes, porque lo que se mide es
 *  el agente tal y como lo usas. Escribe en el registro de la app (son corridas de
 *  verdad) y no abre ninguna ventana: corre y sale con un código que sirve para el CI
 *  cuando se compara con la línea base.
 * --------------------------------------------------------------------------- */
async function correrBancoYsalir() {
  const banco = require('../agent/banco');
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
  };
  const hay = (n) => process.argv.includes(n);
  if (!config.active || !config.active.baseUrl || !config.active.model) {
    console.error('[banco] no hay proveedor activo con modelo: configúralo en Ajustes y vuelve a intentarlo');
    app.exit(2);
    return;
  }
  const dirTareas = arg('--dir') || banco.DIR_POR_DEFECTO;
  const filtro = arg('--tarea');
  log.info('[banco] ' + config.active.model + (filtro ? ' · solo «' + filtro + '»' : ' · todas las tareas'));
  const informe = await banco.correrTodo({
    dir: dirTareas,
    filtro,
    settings: config,
    conservar: hay('--conservar'),
    // Cada tarea estrena agente: reutilizarlo arrastraría el historial de la anterior
    // (y mediría un agente con ventaja, que es justo lo que no queremos).
    nuevoAgente: () => {
      const a = new Agent({
        emit: (e) => {
          if (e && e.type === 'tool' && e.name) process.stdout.write('    · ' + e.name + '\n');
        },
      });
      a.setPolicy(config.security);
      return a;
    },
  });
  for (const m of informe.malas) console.error('[banco] tarea ignorada — ' + m.error);
  log.info('\n' + banco.tabla(informe));
  /* El informe en una línea va CRUDO a stdout: es la parte que lee una máquina
     (scripts/banco.js extrae la línea que empieza por «{»). Con `log.info` la línea sale
     con el prefijo «[fecha] [INFO] », así que el lanzador no la encontraba NI pasándole
     el flag: `npm run banco -- --json` no imprimía nada. */
  if (hay('--json')) process.stdout.write(JSON.stringify(informe) + '\n');
  try {
    const f = path.join(DATA_DIR, 'banco', 'informe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(informe, null, 2));
    log.info('  Informe: ' + f);
  } catch {}
  let codigo = informe.resumen.pasaron === informe.resumen.tareas ? 0 : 1;
  if (hay('--guardar-base') || hay('--base')) {
    const fBase = path.join(__dirname, '..', 'bench', 'linea-base.json');
    if (hay('--guardar-base')) {
      banco.guardarBase(fBase, informe);
      log.info('  Línea base actualizada: ' + fBase);
    }
    if (hay('--base')) {
      const base = banco.leerBase(fBase);
      if (!base) log.info('  (sin línea base con la que comparar)');
      else {
        const c = banco.comparar(informe, base);
        log.info('  Comparado con la línea base de ' + (base.cuando || '?') + (base.modelo ? ' (' + base.modelo + ')' : ''));
        for (const r of c.regresiones) log.info('    REGRESIÓN  ' + r.nombre + ': ' + (r.motivos || []).join('; '));
        for (const r of c.mejoras) log.info('    mejor      ' + r.nombre);
        for (const r of c.nuevos) log.info('    nueva      ' + r.nombre + (r.pasa ? ' (pasa)' : ' (falla)'));
        for (const r of c.faltantes) log.info('    ya no está ' + r.nombre);
        for (const a of c.avisos)
          log.info(
            '    más caro   ' +
              a.nombre +
              ': ' +
              Math.round(a.antesMs / 1000) +
              's→' +
              Math.round(a.ms / 1000) +
              's, ' +
              a.antesTokens +
              '→' +
              a.tokens +
              ' tokens',
          );
        if (c.hayRegresion) codigo = 1;
      }
    }
  }
  app.exit(codigo);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  // Deniega por defecto cualquier petición de permiso (cámara, micrófono,
  // geolocalización…). El modo voz se retiró y no hay contenido remoto, así que hoy
  // no se pide nada; fijarlo cierra la puerta a que aparezca sin querer.
  try {
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      log.warn('[permisos] denegado por defecto: ' + permission);
      callback(false);
    });
  } catch (e) {
    log.warn('[permisos] no se pudo fijar el manejador: ' + ((e && e.message) || e));
  }
  loadConfig();
  /* Idioma: UNA lectura al arrancar, con la configuración ya cargada y antes de crear la
     ventana. Lo elegido en Ajustes manda; si está en «auto» decide el locale del sistema,
     y `--sag-idioma=es|en` se impone a las dos (main/idioma.js, fuera de aquí para poder
     probarlo sin Electron). El motor queda configurado aquí para todos sus mensajes. */
  idiomaActivo = resolverIdiomaArranque(config.settings && config.settings.uiLang, app.getLocale(), process.argv);
  i18n.configurar(idiomaActivo);
  if (BANCO) {
    correrBancoYsalir().catch((e) => {
      console.error('[banco] ' + ((e && e.message) || e));
      app.exit(1);
    });
    return;
  }
  // ¿se quedó una instalación a medias en la sesión anterior? `pendingFor` la
  // descarta sola si ya estamos en la versión nueva (o si el aviso está roto).
  updateApi.setPending(updater.pendingFor(updateApi.readPending(), app.getVersion()));
  if (!updateApi.getPending()) {
    updateApi.clearPendingFile();
  }
  // migración: un config.json de una versión anterior trae las claves en claro;
  // se reescribe cifrado en cuanto arranca (el .bak conserva la copia previa)
  if (needsKeyEncryption()) {
    const r = saveConfig();
    if (r.ok) log.info('[SAGITARI] claves de API cifradas con el almacén del sistema (' + CONFIG_FILE + ')');
  } else if (!encryptionAvailable() && (config.providers || []).some((p) => p && p.apiKey)) {
    console.warn('[SAGITARI] el sistema no ofrece cifrado: las claves se guardan en claro en config.json');
  }
  /* Reparación: hasta la 5.0.1 el nombre del usuario venía PUESTO de fábrica
     («Darío», el del autor) y todo perfil que hubiera guardado sus ajustes lo
     tiene escrito en config.json: el agente se dirigía al dueño de la máquina
     con el nombre de otro. Se retira UNA vez y se apunta en `migraciones` (mirar
     solo el valor no basta: a quien de verdad se llame así se lo quitaríamos en
     cada arranque). Escribirlo en Ajustes ▸ Personal ya no se toca nunca más. */
  if (!config.migraciones || !config.migraciones.nombreFabrica) {
    config.migraciones = { ...(config.migraciones || {}), nombreFabrica: true };
    if (String(config.settings.userName || '').trim() === 'Darío') {
      config.settings.userName = '';
      log.info('[SAGITARI] nombre de usuario de fábrica retirado: escríbelo en Ajustes ▸ Personal');
    }
    saveConfig();
  }
  // Reparación: si el proveedor activo se quedó sin clave pero el proveedor
  // guardado con la misma URL la tiene, se recupera. Una activación con el campo
  // de clave vacío dejaba la app en 401 en cada turno sin que el usuario pudiera
  // verlo en Ajustes (la clave sí estaba, pero en el proveedor, no en el activo).
  if (config.active && !String(config.active.apiKey || '').trim()) {
    const k = claveGuardadaPara(config, config.active);
    if (k) {
      config.active = { ...config.active, apiKey: k };
      saveConfig();
      log.info('[SAGITARI] la clave del proveedor activo se recuperó del proveedor guardado');
    }
  }
  seedStarterSkills();
  // v1.3 recuperación: las 'running' de un crash/cierre pasan a 'interrupted' y el
  // TaskManager las re-encola automáticamente (respetando autoResumeTasks)
  try {
    for (const t of checkpoints.list('active')) {
      if (t.status === 'running') {
        const r = checkpoints.read(t.runId);
        if (r) checkpoints.interrupt(r);
      }
    }
    wireTaskManager().autoResume();
  } catch {}
  runlog.log({ agent: 'sagitari', event: 'app_boot', version: app.getVersion() });
  // MCP: el gestor y su catálogo se montan con la configuración ya cargada (y su
  // migración a cifrado hecha), y los servidores habilitados se conectan en segundo
  // plano: uno que tarde en arrancar no retrasa la ventana.
  wireMcp();
  /* Con el interruptor global apagado no se conecta nada: arrancar procesos para un
     catálogo que no se va a servir es trabajo y ruido inútiles.
     Y `autoStart` NO decide aquí: no hay ningún control que lo ponga, así que quedaba en
     `false` para siempre y el catálogo MCP nacía vacío en cada arranque (`toolDefs` solo
     ofrece servidores `ready`): el modelo no veía ninguna herramienta MCP hasta que el
     usuario probaba cada servidor a mano. El interruptor real es `enabled`. */
  if (config.mcp.enabled !== false)
    for (const s of config.mcp.servers || []) if (s.enabled !== false && !s.invalid) mcp.ensure(s.id).catch(() => {});
  createChatWindow();
  createTray();

  // comprobación silenciosa 12 s después de arrancar: si hay versión nueva, el
  // renderer muestra un aviso discreto y el botón queda en Ajustes. Nunca
  // interrumpe ni descarga nada por su cuenta (y no corre en los modos de prueba).
  if (!HEADLESS || UPDATE_API)
    setTimeout(() => {
      updateApi.checkUpdates({ announce: true }).catch(() => {});
    }, 12000);
  // Si la sesión anterior se quedó a medias instalando, el usuario tiene que
  // enterarse (y poder reintentarlo): para instalar se cierra la app, así que
  // este es el único momento en que se le puede contar.
  if (updateApi.getPending() && (!HEADLESS || UPDATE_API))
    setTimeout(() => {
      updateApi.sendUpdate({
        type: 'install-failed',
        version: updateApi.getPending().version,
        path: updateApi.getPending().path,
        exists: fs.existsSync(updateApi.getPending().path),
      });
    }, 12000);

  // Alt+Espacio era el atajo para ocultar la ventana, pero es el menú de sistema
  // de Windows: robarlo a nivel global con la app oculta y sin bandeja dejaba
  // SAGITARI invisible e irrecuperable salvo por Alt+Mayús+S (que nadie sabe).
  // Ahora ocultar/mostrar usa una combinación propia y la bandeja siempre está.
  globalShortcut.register('CommandOrControl+Alt+S', () => {
    if (!getWin() || getWin().isDestroyed()) return createChatWindow();
    getWin().isVisible() ? getWin().hide() : showWindow();
  });
  globalShortcut.register('Alt+Shift+S', () => showWindow());
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    getWin() && getWin().isVisible() ? glow('pulse') : null;
  });

  if (SMOKE) {
    setTimeout(async () => {
      const ok = { window: !!getWin() && !getWin().isDestroyed(), configDir: CONFIG_DIR };
      log.info('SMOKE::' + JSON.stringify(ok));
      // Salir con 0 SIEMPRE hacía que este paso no pudiera fallar: publicaba si
      // había ventana, pero nadie leía esa línea y el job quedaba verde con una
      // app que no abre ninguna. El código de salida es el veredicto.
      app.exit(ok.window ? 0 : 1);
    }, 2500);
  }
});

app.on('window-all-closed', () => app.quit());

/* Cierre ordenado en DOS FASES. Un handler `async` no sirve aquí: Electron NO espera la
   promesa de `before-quit`, así que todo lo que va DESPUÉS del primer `await` es una
   continuación desligada —la bandeja, taskManager.stopAll(), los agentes del chat, mcp.shutdown(),
   el `Browser.close` de CDP y runlog.close() podían no llegar a ejecutarse antes de que el
   proceso muriera (hijos MCP, Chrome/Edge huérfanos; últimas líneas de log perdidas)—. Se
   previene el primer cierre, se limpia de verdad y entonces `app.quit()` vuelve a disparar
   'before-quit', que ya pasa de largo. */
let quitEnCurso = false;
app.on('before-quit', (e) => {
  if (quitEnCurso) return;
  quitEnCurso = true; // marca antes de prevenir: un 2.º intento no repite la limpieza
  e.preventDefault();
  cerrarYsalir();
});
async function cerrarYsalir() {
  globalShortcut.unregisterAll();
  if (getTray()) {
    try {
      getTray().destroy();
    } catch {}
    bandeja.setTray(null);
  }
  if (taskManager) {
    try {
      taskManager.stopAll();
    } catch {}
  } // tareas en background → interrupted
  runtimes.disposeAll(); // chat: para cada conversación en vuelo y vacía el registro
  if (mcp) {
    try {
      mcp.shutdown();
    } catch {}
  } // servidores MCP: procesos hijos fuera
  try {
    if (browser.ws) browser.send('Browser.close').catch(() => {});
    // Respaldo: si Chrome no atiende la orden (o el lanzamiento falló a medias), el
    // proceso no se queda vivo con el perfil del usuario. taskkill /T /F mata el árbol.
    try {
      browser.kill();
    } catch {}
  } catch {} // Chrome/Edge lanzado por CDP
  try {
    runlog.close();
  } catch {} // logs de sesión
  app.quit();
}
