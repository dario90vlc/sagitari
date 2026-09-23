
'use strict';

// SAGITARI — Electron main process
// Chat window + click-through screen-edge glow overlay + agent + voice + settings.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, dialog, Tray, Menu, safeStorage, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

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
const DATA_DIR = path.join(app.getPath('appData'), HEADLESS ? 'SagitariAI-test' : 'SagitariAI');
process.env.SAGITARI_DATA_DIR = DATA_DIR;

const { Agent } = require('../agent/agent');
const { DEFAULT_RISK } = require('../agent/guardrails');
const { Browser } = require('../agent/browser');
const { TaskManager } = require('../agent/tasks');
const { PRESETS, listModels } = require('./providers');
const updater = require('./updater');
const skills = require('../agent/skills');
const { registerSkillsIpc } = require('./ipc-skills');
registerSkillsIpc(ipcMain, { skills, runlog: require('../agent/runlog') });

// ---- memoria/hábitos/salud: router en main/ipc-memory.js (tercer router de la fase 4) ----
const { registerMemoryIpc } = require('./ipc-memory');
registerMemoryIpc(ipcMain, { memory: require('../agent/memory'), models: require('../agent/models'), habits: require('../agent/habits') });
const marketplace = require('../agent/marketplace');
const models = require('../agent/models');
const habits = require('../agent/habits');
const { McpManager, serverSlug } = require('../agent/mcp');
const { registerMcpIpc } = require('./ipc-mcp');
const mcpConfig = require('./mcp-config');
// config es un único objeto vivo (se muta, no se reasigna): ctx.config() lo lee siempre fresco.
registerMcpIpc(ipcMain, { config: () => config, wireMcp, persistConfig, mcpState, mcpExport,
  setAgentPolicy: (sec) => { if (agent) agent.setPolicy(sec); },
  mcpConfig, serverSlug });

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
  try { console.warn('SAGITARI_UPDATE_API ignorada en la app instalada (solo dev).'); } catch {}
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
  try { app.setPath('userData', path.join(app.getPath('appData'), 'SagitariAI-test')); } catch {}
}

// single instance: si ya está abierta, enfoca la ventana existente
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // OJO: salir en silencio aquí es lo que hacía parecer que «la app se cierra».
  // La instancia que ya corre recibe 'second-instance' y se muestra sola.
  try { process.stdout.write('SAGITARI ya está abierta: se muestra la ventana existente.\n'); } catch {}
  app.quit();
}
app.on('second-instance', () => showWindow());

// ---------- config ----------
const CONFIG_DIR = DATA_DIR;   // la misma raíz que usan los módulos de agent/ (ver arriba)
const LEGACY_CONFIG = path.join(app.getPath('appData'), 'JarvisAI', 'config.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let config = {
  providers: [],                 // [{id, name, baseUrl, apiKey, models:[], activeModel}]
  active: null,                  // {providerId, name, baseUrl, apiKey, model, temperature, vision}
  settings: { theme: 'violet', uiColor: 'aurora', glowColor: 'match', glowStrength: 1, glassTint: 1, ttsEnabled: true, voiceLang: 'es-ES', glowEnabled: true, userName: 'Darío', mode: 'act', maxConcurrentTasks: 1, autoResumeTasks: true, llmTimeoutMs: 120000, showThinking: false, reviewGate: true, parallelTools: 3, diagnosticosEscritura: true, verificacionCierre: true, intentosArreglo: 2, promptCache: true,
    hookEditar: '', hookCerrar: '' },
  mcp: { enabled: true, servers: [] },   // servidores MCP del usuario (ver main/mcp-config.js)
};

/* ---- v1.1 seguridad: permisos por herramienta + guardarraíles (configurables) ---- */
const securityDefaults = {
  permissions: {},               // { toolName: 'safe'|'confirm'|'restricted' } — vacío = defaults
  guardrails: {
    maxSteps: 60,                // 0 = sin límite
    maxToolCalls: 80,            // 0 = sin límite
    maxDurationMs: 15 * 60 * 1000, // 0 = sin límite
    maxTokens: 0,                // 0 = sin límite
    maxCostUsd: 0,               // 0 = sin límite (coste estimado en USD)
    maxDelegations: 8,           // subagentes por turno (0 = sin tope)
    loopThreshold: 3,            // llamadas idénticas seguidas antes de parar
    stallThreshold: 6,           // pasos sin progreso antes de parar (0 = sin límite)
  },
};
let providersChanged = false;

/* ---------- claves de API en disco ----------
   Las claves se guardan cifradas con el almacén del sistema (DPAPI en Windows vía
   safeStorage): un config.json copiado, sincronizado o leído por otro programa ya
   no expone las credenciales. En memoria siempre están en claro porque el agente
   las necesita para llamar al proveedor. Si el sistema no ofrece cifrado, se
   guarda en claro y queda constancia en el log: antes se hacía siempre. */
const KEY_PREFIX = 'enc:v1:';
function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
function protectKey(k) {
  if (typeof k !== 'string' || !k) return k;
  if (k.startsWith(KEY_PREFIX)) return k;                 // ya estaba cifrada
  if (!encryptionAvailable()) return k;
  try { return KEY_PREFIX + safeStorage.encryptString(k).toString('base64'); } catch { return k; }
}
function revealKey(k) {
  if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) return k;
  try { return safeStorage.decryptString(Buffer.from(k.slice(KEY_PREFIX.length), 'base64')); }
  catch {
    // No se pudo descifrar (config copiada de otro equipo o perfil, o clave
    // maestra recreada). Se devuelve el CRIPTOGRAMA tal cual para que el
    // siguiente guardado no lo pise con una cadena vacía: antes la credencial se
    // destruía en silencio (el .bak incluido) y no había vuelta atrás.
    registrarFallo('revealKey', new Error('no se pudo descifrar una clave guardada en este equipo; vuelve a escribirla en Ajustes'));
    return k;
  }
}
/** Cifra los valores de env/headers de un servidor MCP (pueden ser tokens). */
function protectServerSecrets(s) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, protectKey(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}
function revealServerSecrets(s) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, revealKey(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}
/** Copia del config con las claves cifradas, tal y como va a disco. */
function configParaDisco() {
  const paint = (p) => (p && typeof p === 'object' ? { ...p, apiKey: protectKey(p.apiKey) } : p);
  return {
    ...config,
    providers: (config.providers || []).map(paint),
    active: paint(config.active),
    // los tokens de los servidores MCP viven en env/headers: mismo trato que las claves
    mcp: { ...config.mcp, servers: ((config.mcp && config.mcp.servers) || []).map(protectServerSecrets) },
  };
}
/** Alguna clave sin cifrar en memoria → hay que reescribir el fichero. */
function needsKeyEncryption() {
  if (!encryptionAvailable()) return false;
  const sinCifrar = (p) => !!(p && typeof p.apiKey === 'string' && p.apiKey && !p.apiKey.startsWith(KEY_PREFIX));
  if (sinCifrar(config.active) || (config.providers || []).some(sinCifrar)) return true;
  // los secretos de un servidor MCP también cuentan: si se quedaran en claro, un
  // config.json copiado expondría los tokens igual que antes con las claves
  return ((config.mcp && config.mcp.servers) || []).some(s => [...Object.values(s.env || {}), ...Object.values(s.headers || {})]
    .some(v => v && !String(v).startsWith(KEY_PREFIX)));
}

function applyConfig(raw) {
  config = { ...config, ...raw, settings: { ...config.settings, ...(raw.settings || {}) } };
  // de disco llegan cifradas: en memoria el agente necesita el valor real
  if (config.active && config.active.apiKey) config.active = { ...config.active, apiKey: revealKey(config.active.apiKey) };
  config.providers = (config.providers || []).map(p => (p && p.apiKey ? { ...p, apiKey: revealKey(p.apiKey) } : p));
  config.security = {
    permissions: { ...(raw.security && raw.security.permissions || {}) },
    guardrails: { ...securityDefaults.guardrails, ...(raw.security && raw.security.guardrails || {}) },
  };
  // MCP: la lista de servidores la valida el módulo puro (comando, URL, timeout)
  const mcpRaw = (raw.mcp && Array.isArray(raw.mcp.servers)) ? raw.mcp.servers : [];
  const servers = [];
  for (const s of mcpRaw) {
    const v = mcpConfig.validateServer(s);
    if (v.ok) servers.push(revealServerSecrets(v.value));
  }
  config.mcp = { enabled: raw.mcp ? raw.mcp.enabled !== false : true, servers };
}
function loadConfig() {
  try { applyConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); return; } catch (e) {
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
        return;
      } catch {}
    }
    config.security = { permissions: {}, guardrails: { ...securityDefaults.guardrails } };
  }
}
/* Guardado atómico: se escribe en <archivo>.tmp y se renombra encima, y antes de
   pisar el archivo bueno se conserva una copia .bak. Así un cierre a lo bruto o
   un corte a mitad de escritura no dejan el JSON truncado y sin vuelta atrás. */
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data, 'utf8');
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch {}
  fs.renameSync(tmp, file);
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
function avisarDisco(mensaje) {
  const now = Date.now();
  if (now - avisoDiscoAt < 30000) return;
  avisoDiscoAt = now;
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'toast', title: 'No se pudo guardar', message: mensaje });
    }
  } catch {}
}

/* Persiste y, si falla, avisa al usuario: los controles de Ajustes ya han
   confirmado el cambio en pantalla, así que un console.error silencioso deja al
   usuario creyendo que se guardó algo que se perderá al reiniciar. */
function persistConfig() {
  const r = saveConfig();
  if (!r.ok) avisarDisco('La configuración no se pudo escribir en disco (' + r.error + ').');
  return r;
}

// ---------- windows ----------
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
let win = null;        // chat

function createChatWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // El mínimo de la ventana manda: en pantallas estrechas (área de trabajo
  // < 1088px) `width - 88` quedaba por debajo de minWidth, el SO forzaba 1000 y
  // la ventana se salía por la derecha con la x calculada sobre un ancho menor.
  const W = Math.max(1000, Math.min(1560, width - 88));
  const H = Math.max(620, Math.min(920, height - 88));
  win = new BrowserWindow({
    width: W,
    height: H,
    // mínimo por debajo del cual la ventana no se reduce: el diseño se mantiene
    // intacto hasta este límite (ver media queries en styles.css)
    minWidth: 1000,
    minHeight: 620,
    x: Math.max(0, Math.round((width - W) / 2)),
    y: Math.max(0, Math.round((height - H) / 2)),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,          // el preload solo usa contextBridge + ipcRenderer
      spellcheck: false
    },
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'),
    show: !HIDDEN
  });
  /* Icono de la ventana (barra de tareas). Ya viaja en las opciones de arriba, pero en
     Windows el icono del botón de la barra puede quedarse con el del ejecutable si la
     ventana se crea antes de que el sistema lo pida: fijarlo otra vez al arrancar es la
     forma barata de que salga SIEMPRE el de SAGITARI. En desarrollo el proceso es
     `electron.exe`, así que ahí puede verse el de Electron: es del binario, no de la app
     (las versiones publicadas llevan el nuestro, con sus seis tamaños). */
  if (process.platform === 'win32') {
    try { win.setIcon(path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico')); } catch {}
  }
  win.loadFile(INDEX_HTML);
  // La ventana no navega fuera de su index.html local: si un enlace o un script
  // lo intenta, se cancela (las URLs http/https se abren en el navegador del
  // sistema). Abrir ventanas nuevas queda denegado de plano.
  const appUrl = pathToFileURL(INDEX_HTML).href;
  win.webContents.on('will-navigate', (e, url) => {
    if (String(url).split('#')[0] !== appUrl) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => win.webContents.send('win:maximized', win.isMaximized()));
  // si el renderer se cae, la confirmación pendiente ya no la puede contestar
  // nadie: se detiene el agente en limpio en vez de dejarlo colgado esperando
  win.webContents.on('render-process-gone', () => { try { if (agent) agent.stop(); } catch {} });
  win.on('closed', () => { win = null; });
  // cerrar = cerrar de verdad: X sale de la app completa (antes se ocultaba y
  // quedaban procesos vivos). Para ocultar/mostrar: Ctrl+Alt+S o la bandeja.
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

/* Muestra la ventana existente (o la crea si se cerró). Se usa desde el
   segundo lanzamiento, desde el icono de la bandeja y desde los atajos: es la
   red de seguridad para que la app nunca quede fuera de alcance. */
function showWindow() {
  if (!win || win.isDestroyed()) return createChatWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* Icono en la bandeja del sistema. Sin él, ocultar la ventana (atajo) dejaba
   SAGITARI invisible e inalcanzable: ni barra de tareas ni forma evidente de
   volver. Desde aquí siempre se puede mostrar, ocultar o salir. */
let tray = null;
function createTray() {
  if (tray || HEADLESS) return;
  try {
    const ico = path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico');
    if (!fs.existsSync(ico)) return;
    tray = new Tray(ico);
    tray.setToolTip('SAGITARI — tu asistente');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mostrar SAGITARI', click: () => showWindow() },
      { label: 'Ocultar ventana', click: () => { if (win && !win.isDestroyed()) win.hide(); } },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]));
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch (e) { tray = null; }
}

// El glow vive en el marco de la propia app (renderer), no en un overlay de pantalla.
function glow(mode, color) {
  if (!config.settings.glowEnabled) return;
  if (win && !win.isDestroyed()) win.webContents.send('glow:set', { mode, color: color || config.settings.theme });
}

// ---------- agent wiring (v1.3: agentes de chat Y de background) ----------
const browser = new Browser();
let agent = null;            // agente del chat interactivo
let taskManager = null;      // cola de tareas en background (agent/tasks.js)
// (el dictado push-to-talk vive en main/ipc-voz.js — quinto router de la fase 4)

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
let avisosDeFallo = 0;
function registrarFallo(kind, err) {
  const message = String((err && err.message) || err || 'desconocido');
  const stack = String((err && err.stack) || '').slice(0, 4000);
  try {
    const dir = path.join(CONFIG_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'),
      JSON.stringify({ ts: new Date().toISOString(), kind, version: app.getVersion(), message, stack }) + '\n', 'utf8');
  } catch {}
  try { runlog.log({ agent: 'sagitari', event: 'crash', kind, message: message.slice(0, 300) }); } catch {}
  try { console.error('[SAGITARI] ' + kind + ': ' + message); } catch {}
  // un aviso por tipo como máximo: si el fallo se repite en bucle, no molesta
  if (avisosDeFallo++ < 3) {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'error', message: 'Fallo interno (' + kind + '): ' + message.slice(0, 200) + '\nSe ha guardado en logs\\crash.log' });
      else dialog.showErrorBox('SAGITARI — fallo interno', message.slice(0, 400) + '\n\nDetalle completo en logs\\crash.log');
    } catch {}
  }
  return message;
}
process.on('uncaughtException', (err) => registrarFallo('uncaughtException', err));
process.on('unhandledRejection', (reason) => registrarFallo('unhandledRejection', reason));

/* ---- rastro del turno: el estado compacto vive en main/traza.js y lo comparten
   agentEmit (aquí, cierra el turno) y el router ipc-chat (chat:send/retry, lo abren) ---- */
const { trazaApunta, trazaActual, trazaCerrar } = require('./traza');

function agentEmit(e, isBackground) {
  // v1.3: los eventos de tareas en background se marcan para que el renderer NO
  // los mezcle con el chat interactivo (burbujas, estado busy, etc.).
  const out = isBackground ? { ...e, bg: true } : e;
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', out);
  if (e.type === 'tool') glow('work', 'work');
  // solo el chat interactivo escribe en la conversación actual
  if (!isBackground) {
    trazaApunta(e);
    if (e.type === 'assistant_done') {
      glow('think');
      const c = currentConv();
      if (c && e.text) {
        const tt = trazaActual();
        const conTraza = (tt && (tt.tools.length || (tt.think && tt.think.text))) ? tt : null;
        // Se guarda la narración COMPLETA del turno, no solo el párrafo final:
        // reabrir la conversación enseña lo mismo que se vio en vivo.
        const completo = (e.transcript && e.transcript.length > e.text.length) ? e.transcript : e.text;
        c.messages.push({ role: 'assistant', content: completo, ts: Date.now(), ...(conTraza ? { trace: conTraza } : {}) });
        c.updatedAt = Date.now();
        saveConvs();
      }
      // el turno se cierra: el rastro siguiente es de otro turno
      trazaCerrar();
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

function createAgent(isBackground = false) {
  return new Agent({
    guardrailsPolicy: config.security,
    emit: (e) => agentEmit(e, isBackground),
    screenshotFn: async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size });
      const s = sources[0];
      const png = s.thumbnail.toPNG();
      const b64 = 'data:image/png;base64,' + png.toString('base64');
      return { dataUrl: b64, w: s.thumbnail.getSize().width, h: s.thumbnail.getSize().height };
    },
    browser,
    mcp: wireMcp(),   // el ejecutor despacha mcp__*: sin esto, «no hay servidores MCP en esta ejecución»
  });
}

function wireAgent() { agent = createAgent(false); }

// ---- v1.3: TaskManager — cola de tareas en background con notificaciones ----
function wireTaskManager() {
  if (taskManager) return taskManager;
  taskManager = new TaskManager({
    getSettings: () => config,
    agentFactory: () => createAgent(true),
    // el chat y las tareas comparten run store: «Reanudar» no puede lanzar un
    // segundo agente sobre el run que el chat está ejecutando ahora mismo
    isRunBusy: (runId) => !!(agent && agent.isBusy() && agent.currentRunId === runId),
    emit: (e) => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', e); },
    notify: (run, kind) => {
      const title = 'SAGITARI — tarea ' + (kind === 'completed' ? 'completada' : kind === 'failed' ? 'falló' : kind === 'cancelled' ? 'cancelada' : kind === 'paused' ? 'pausada' : 'actualizada');
      const body = String(run.goal || '').slice(0, 120);
      try {
        const { Notification } = require('electron');
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch {}
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'toast', title, message: body });
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
registerConfigIpc(ipcMain, { config: () => config, persistConfig, PRESETS, listModels,
  glow, getWin: () => win, isHidden: () => HIDDEN });

// ---- modo/agentes/market: router en main/ipc-modo.js (noveno router de la fase 4) ----
const { registerModoIpc } = require('./ipc-modo');
registerModoIpc(ipcMain, {
  config: () => config,
  saveConfig,
  getAgent: () => agent,
  getSkills: () => skills,
  getHabits: () => habits,
  marketplace,
  fsp,
});


// ---- chat/adjuntos/traza: router en main/ipc-chat.js (octavo router de la fase 4) ----

const checkpoints = require('../agent/checkpoints');
const cambios = require('../agent/cambios');    // v2.5: pre-imágenes del turno (revisión y deshacer)
const repomap = require('../agent/repomap');    // v2.5: hay que invalidarlo cuando se deshace
const instrucciones = require('../agent/instrucciones'); // v2.5: SAGITARI.md / AGENTS.md del proyecto

// ---- tareas/seguridad/meta: router en main/ipc-tareas.js (sexto router de la fase 4) ----
const { registerTareasIpc } = require('./ipc-tareas');
registerTareasIpc(ipcMain, { config: () => config, persistConfig, getTaskManager: () => wireTaskManager(), peekTaskManager: () => taskManager, checkpoints, getAgent: () => agent, securityDefaults, DEFAULT_RISK, CONFIG_DIR, runlog, getWin: () => win });

// ---- conversaciones/workspace: router en main/ipc-convs.js (séptimo router de la fase 4) ----
const { registerConvsIpc } = require('./ipc-convs');
const convsApi = registerConvsIpc(ipcMain, { config: () => config, saveConfig, configDir: () => CONFIG_DIR, writeJsonAtomic, onSaveError: (m) => avisarDisco(m), getWin: () => win, getAgent: () => agent, dialog, app, fs, path });
const { currentConv, saveConvs, ensureConv, getWorkspace } = convsApi;

// ---- cambios/instrucciones: router en main/ipc-cambios.js (undécimo router de la fase 4) ----
const { registerCambiosIpc } = require('./ipc-cambios');
registerCambiosIpc(ipcMain, {
  getAgent: () => agent,
  getWorkspace,
  cambios, repomap, instrucciones, runlog, fs, path,
});

// ---- app/shell/glow: router en main/ipc-misc.js (décimo router de la fase 4) ----
const { registerMiscIpc } = require('./ipc-misc');
registerMiscIpc(ipcMain, {
  config: () => config,
  saveConfig,
  getWin: () => win,
  getWorkspace,
  configDir: () => CONFIG_DIR,
  getGlow: (...a) => glow(...a),
  app, shell, dialog, fsp, fs, path,
});

// ---- chat/adjuntos/traza: router en main/ipc-chat.js (octavo router de la fase 4) ----
const { registerChatIpc } = require('./ipc-chat');
registerChatIpc(ipcMain, {
  config: () => config,
  getAgent: () => agent,
  ensureAgent: () => { if (!agent) wireAgent(); return agent; },
  convsApi,
  getSkills: () => skills,
  getGlow: (...a) => glow(...a),
  getWin: () => win,
  configDir: () => CONFIG_DIR,
  onError: (k, err) => registrarFallo(k, err),
  dialog, fsp, fs, path, attach: require('./attachments'),
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
  const vivo = new Map(wireMcp().status().map(s => [s.id, s]));
  return {
    enabled: config.mcp.enabled !== false,
    servers: (config.mcp.servers || []).map(s => {
      const v = vivo.get(s.id) || {};
      return {
        ...s,
        env: enmascararMapaSecretos(s.env),
        headers: enmascararMapaSecretos(s.headers),
        permKey: 'mcp__' + serverSlug(s.id) + '__*',
        enabled: v.enabled !== undefined ? v.enabled : s.enabled,
        state: v.state || 'idle',
        error: v.error || null,
        logTail: v.logTail || '',
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
    mcpServers[s.id] = s.transport === 'http'
      ? { url: s.url, headers: { ...(s.headers || {}) } }
      : { command: s.command, args: [...(s.args || [])], env: { ...(s.env || {}) } };
  }
  return { mcpServers };
}



// ---- voz/TTS/dictado: router en main/ipc-voz.js (quinto router de la fase 4) ----
const { registerVozIpc } = require('./ipc-voz');
const vozApi = registerVozIpc(ipcMain, { config: () => config, isHeadless: () => HEADLESS, getWin: () => win, DATA_DIR });

// ---------- app lifecycle ----------
// copia las skills incluidas (skills-starter/) al perfil del usuario en el primer arranque
function seedStarterSkills() {
  try {
    const src = path.join(__dirname, '..', 'skills-starter');
    for (const name of fs.readdirSync(src)) {
      const dest = path.join(skills.skillsDir(), name, 'SKILL.md');
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(src, name, 'SKILL.md'), dest);
      }
    }
  } catch (e) { console.error('seedStarterSkills', e.message); }
}

// ---- actualizaciones: router en main/ipc-update.js (duodécimo router de la fase 4) ----
const { registerUpdateIpc } = require('./ipc-update');
const updateApi = registerUpdateIpc(ipcMain, {
  config: () => config,
  saveConfig,
  getWin: () => win,
  updater, UPDATE_API, DATA_DIR, runlog,
  app, shell, fsp, fs, path,
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
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; };
  const hay = (n) => process.argv.includes(n);
  if (!config.active || !config.active.baseUrl || !config.active.model) {
    console.error('[banco] no hay proveedor activo con modelo: configúralo en Ajustes y vuelve a intentarlo');
    app.exit(2); return;
  }
  const dirTareas = arg('--dir') || banco.DIR_POR_DEFECTO;
  const filtro = arg('--tarea');
  console.log('[banco] ' + config.active.model + (filtro ? ' · solo «' + filtro + '»' : ' · todas las tareas'));
  const informe = await banco.correrTodo({
    dir: dirTareas,
    filtro,
    settings: config,
    conservar: hay('--conservar'),
    // Cada tarea estrena agente: reutilizarlo arrastraría el historial de la anterior
    // (y mediría un agente con ventaja, que es justo lo que no queremos).
    nuevoAgente: () => {
      const a = new Agent({ emit: (e) => {
        if (e && e.type === 'tool' && e.name) process.stdout.write('    · ' + e.name + '\n');
      } });
      a.setPolicy(config.security);
      return a;
    },
  });
  for (const m of informe.malas) console.error('[banco] tarea ignorada — ' + m.error);
  console.log('\n' + banco.tabla(informe));
  if (hay('--json')) console.log(JSON.stringify(informe));
  try {
    const f = path.join(DATA_DIR, 'banco', 'informe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(informe, null, 2));
    console.log('  Informe: ' + f);
  } catch {}
  let codigo = informe.resumen.pasaron === informe.resumen.tareas ? 0 : 1;
  if (hay('--guardar-base') || hay('--base')) {
    const fBase = path.join(__dirname, '..', 'bench', 'linea-base.json');
    if (hay('--guardar-base')) { banco.guardarBase(fBase, informe); console.log('  Línea base actualizada: ' + fBase); }
    if (hay('--base')) {
      const base = banco.leerBase(fBase);
      if (!base) console.log('  (sin línea base con la que comparar)');
      else {
        const c = banco.comparar(informe, base);
        console.log('  Comparado con la línea base de ' + (base.cuando || '?') + (base.modelo ? ' (' + base.modelo + ')' : ''));
        for (const r of c.regresiones) console.log('    REGRESIÓN  ' + r.nombre + ': ' + (r.motivos || []).join('; '));
        for (const r of c.mejoras) console.log('    mejor      ' + r.nombre);
        for (const r of c.nuevos) console.log('    nueva      ' + r.nombre + (r.pasa ? ' (pasa)' : ' (falla)'));
        for (const r of c.faltantes) console.log('    ya no está ' + r.nombre);
        for (const a of c.avisos) console.log('    más caro   ' + a.nombre + ': ' + Math.round(a.antesMs / 1000) + 's→' + Math.round(a.ms / 1000) + 's, ' + a.antesTokens + '→' + a.tokens + ' tokens');
        if (c.hayRegresion) codigo = 1;
      }
    }
  }
  app.exit(codigo);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  loadConfig();
  if (BANCO) { correrBancoYsalir().catch((e) => { console.error('[banco] ' + ((e && e.message) || e)); app.exit(1); }); return; }
  // ¿se quedó una instalación a medias en la sesión anterior? `pendingFor` la
  // descarta sola si ya estamos en la versión nueva (o si el aviso está roto).
  updateApi.setPending(updater.pendingFor(updateApi.readPending(), app.getVersion()));
  if (!updateApi.getPending()) { updateApi.clearPendingFile(); }
  // migración: un config.json de una versión anterior trae las claves en claro;
  // se reescribe cifrado en cuanto arranca (el .bak conserva la copia previa)
  if (needsKeyEncryption()) {
    const r = saveConfig();
    if (r.ok) console.log('[SAGITARI] claves de API cifradas con el almacén del sistema (' + CONFIG_FILE + ')');
  } else if (!encryptionAvailable() && ((config.providers || []).some(p => p && p.apiKey))) {
    console.warn('[SAGITARI] el sistema no ofrece cifrado: las claves se guardan en claro en config.json');
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
      console.log('[SAGITARI] la clave del proveedor activo se recuperó del proveedor guardado');
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
  // migración a cifrado hecha), y los servidores marcados como automáticos se
  // conectan en segundo plano: uno que tarde en arrancar no retrasa la ventana.
  wireMcp();
  // Con el interruptor global apagado no se conecta nada: arrancar procesos para un
  // catálogo que no se va a servir es trabajo y ruido inútiles.
  if (config.mcp.enabled !== false) for (const s of config.mcp.servers || []) if (s.autoStart && s.enabled) mcp.ensure(s.id).catch(() => {});
  createChatWindow();
  createTray();

  // comprobación silenciosa 12 s después de arrancar: si hay versión nueva, el
  // renderer muestra un aviso discreto y el botón queda en Ajustes. Nunca
  // interrumpe ni descarga nada por su cuenta (y no corre en los modos de prueba).
  if (!HEADLESS || UPDATE_API) setTimeout(() => { updateApi.checkUpdates({ announce: true }).catch(() => {}); }, 12000);
  // Si la sesión anterior se quedó a medias instalando, el usuario tiene que
  // enterarse (y poder reintentarlo): para instalar se cierra la app, así que
  // este es el único momento en que se le puede contar.
  if (updateApi.getPending() && (!HEADLESS || UPDATE_API)) setTimeout(() => {
    sendUpdate({ type: 'install-failed', version: updateApi.getPending().version, path: updateApi.getPending().path, exists: fs.existsSync(updateApi.getPending().path) });
  }, 12000);

  // Alt+Espacio era el atajo para ocultar la ventana, pero es el menú de sistema
  // de Windows: robarlo a nivel global con la app oculta y sin bandeja dejaba
  // SAGITARI invisible e irrecuperable salvo por Alt+Mayús+S (que nadie sabe).
  // Ahora ocultar/mostrar usa una combinación propia y la bandeja siempre está.
  globalShortcut.register('CommandOrControl+Alt+S', () => {
    if (!win || win.isDestroyed()) return createChatWindow();
    win.isVisible() ? win.hide() : showWindow();
  });
  globalShortcut.register('Alt+Shift+S', () => showWindow());
  globalShortcut.register('CommandOrControl+Shift+G', () => { win && win.isVisible() ? glow('pulse') : null; });

  if (SMOKE) {
    setTimeout(async () => {
      const ok = { window: !!win && !win.isDestroyed(), configDir: CONFIG_DIR };
      console.log('SMOKE::' + JSON.stringify(ok));
      // Salir con 0 SIEMPRE hacía que este paso no pudiera fallar: publicaba si
      // había ventana, pero nadie leía esa línea y el job quedaba verde con una
      // app que no abre ninguna. El código de salida es el veredicto.
      app.exit(ok.window ? 0 : 1);
    }, 2500);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async () => {
  try { await vozApi.cerrar(); } catch {}   // dictado + modo voz: reintento desarmado, procesos fuera
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  if (taskManager) { try { taskManager.stopAll(); } catch {} }      // tareas en background → interrupted
  if (agent && agent.isBusy()) { try { agent.stop(); } catch {} }   // chat en curso
  if (mcp) { try { mcp.shutdown(); } catch {} }                 // servidores MCP: procesos hijos fuera
  try { browser.ws && browser.send('Browser.close'); } catch {} // Chrome/Edge lanzado por CDP
  try { runlog.close(); } catch {}                              // logs de sesión
});
