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
const marketplace = require('../agent/marketplace');
const models = require('../agent/models');
const habits = require('../agent/habits');
const { McpManager, serverSlug } = require('../agent/mcp');
const mcpConfig = require('./mcp-config');

// Solo para probar el actualizador: apunta la comprobación a otra API de releases
// (p. ej. un JSON local con una versión inventada) y hace que también se compruebe
// en los arranques ocultos. En uso normal no está definida y no cambia nada.
const UPDATE_API = process.env.SAGITARI_UPDATE_API || '';

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
  settings: { theme: 'violet', uiColor: 'violet', glowColor: 'match', glowStrength: 1, ttsEnabled: true, voiceLang: 'es-ES', glowEnabled: true, userName: 'Darío', mode: 'act', maxConcurrentTasks: 1, autoResumeTasks: true, llmTimeoutMs: 120000, showThinking: false, reviewGate: true, parallelTools: 3, diagnosticosEscritura: true, verificacionCierre: true, intentosArreglo: 2, promptCache: true,
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
let whisper = null;          // child process handle for push-to-talk dictation
let whisperBuf = '';

const runlog = require('../agent/runlog');

/* ---- adjuntos del chat: los límites y la extracción de texto viven en
   main/attachments.js (Node puro, con tests propios). Aquí solo se lee el fichero
   y se comprueba que la ruta sea legítima. ---- */
const attach = require('./attachments');

ipcMain.handle('attachments:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Adjuntar a la conversación',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documentos e imágenes', extensions: ['pdf', 'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'vue', 'svelte', 'tex', 'rtf', 'srt', 'vtt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'docx', 'xlsx', 'pptx', 'epub', 'bin', 'exe', 'zip', 'rar', '7z'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths;
  } catch (err) { registrarFallo('attachments:pick', err); return []; }
});

ipcMain.handle('attachments:read', async (e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { ok: false, error: 'ruta inválida' };
    // El drag&drop sí puede leer fuera del selector, pero nunca el directorio de
    // datos de la app (ahí viven las API keys y las conversaciones) ni algo que no
    // sea un archivo regular. realpath resuelve enlaces antes de comprobar.
    let full;
    try { full = await fsp.realpath(filePath); } catch { return { ok: false, error: 'La ruta no existe' }; }
    if (attach.insideDir(full, CONFIG_DIR)) return { ok: false, error: 'ruta no permitida' };
    const st = await fsp.stat(full);
    if (!st.isFile()) return { ok: false, error: 'no es un archivo regular' };
    if (st.size > attach.MAX_FILE_BYTES) return { ok: false, error: `Supera ${Math.round(attach.MAX_FILE_BYTES / 1048576)} MB` };
    const name = path.basename(full);
    const kind = attach.kindOf(name, st.size);
    if (kind === 'image') {
      const buf = await fsp.readFile(full);
      return { ok: true, att: { name, kind, size: st.size, dataUrl: `data:${attach.mimeOf(name)};base64,${buf.toString('base64')}` } };
    }
    if (kind === 'text') {
      const text = attach.textOf(await fsp.readFile(full), name);
      if (text === null) return { ok: true, att: { name, kind: 'binary', size: st.size, note: 'parece binario' } };
      return { ok: true, att: { name, kind: 'text', size: st.size, text } };
    }
    return { ok: true, att: { name, kind: 'binary', size: st.size, note: 'binario' } };
  } catch (err) { return { ok: false, error: err.message }; }
});

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

/* ---- rastro del turno: lo que el usuario ve en las tarjetas ----
   Las tarjetas de herramienta, el razonamiento y sus tiempos NO se guardaban en la
   conversación: al cerrar la app y volver a abrirla, el hilo repintaba solo las burbujas
   de texto y todo el trabajo del turno desaparecía de la vista (el usuario lo notó: «las
   herramientas que usó ya no se muestran»). Aquí se acumula un rastro COMPACTO —nombre,
   argumentos acotados, resultado acotado, duración y si falló— y se cuelga del mensaje del
   asistente al cerrar el turno, que es justo lo que el chat necesita para repintarlo.

   Se acota a propósito: `conversations.json` se lee ENTERO al arrancar la app, así que el
   rastro no puede crecer sin freno (el argumento de un write_file es un archivo completo,
   y un resultado de run_command puede traer miles de líneas). */
const MAX_TRAZA = 80;              // herramientas por turno que se conservan
const clipTraza = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '\n… (recortado: ' + (t.length - n) + ' caracteres más)' : t;
};
function argsTraza(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    // una imagen en base64 o el contenido entero de un archivo no pintan nada en una
    // tarjeta y multiplicarían el tamaño del historial guardado
    out[k] = /^data:[\w/+.-]+;base64,/.test(v) ? '(imagen adjunta, no guardada)' : clipTraza(v, 1200);
  }
  return out;
}
let turnTrace = null;
function trazaNueva() { turnTrace = { tools: [], think: null }; }
function trazaApunta(e) {
  if (!turnTrace) return;
  if (e.type === 'tool') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({ name: e.name, args: argsTraza(e.args), subagent: e.subagent || null });
    }
    return;
  }
  if (e.type === 'tool_result') {
    // cierra la ÚLTIMA llamada de ese nombre que siga abierta: dos llamadas a la misma
    // herramienta en un turno tienen que cerrarse en orden, no todas a la vez
    for (let i = turnTrace.tools.length - 1; i >= 0; i--) {
      const t = turnTrace.tools[i];
      if (t.name === e.name && t.ok === undefined) {
        t.ok = (e.ok === undefined || e.ok === null) ? null : !!e.ok;
        t.ms = Number(e.durationMs) || 0;
        t.result = clipTraza(e.result, 1200);
        return;
      }
    }
    return;
  }
  if (e.type === 'delegate_done') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({
        delegate: String(e.subagent || ''), status: String(e.status || 'OK'),
        ms: Number(e.durationMs) || 0, result: clipTraza(e.result, 900),
      });
    }
    return;
  }
  if (e.type === 'thinking_done') {
    turnTrace.think = { text: clipTraza(e.text, 4000), ms: Number(e.durationMs) || 0 };
  }
}

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
        const conTraza = (turnTrace && (turnTrace.tools.length || (turnTrace.think && turnTrace.think.text))) ? turnTrace : null;
        // Se guarda la narración COMPLETA del turno, no solo el párrafo final:
        // reabrir la conversación enseña lo mismo que se vio en vivo.
        const completo = (e.transcript && e.transcript.length > e.text.length) ? e.transcript : e.text;
        c.messages.push({ role: 'assistant', content: completo, ts: Date.now(), ...(conTraza ? { trace: conTraza } : {}) });
        c.updatedAt = Date.now();
        saveConvs();
      }
      // el turno se cierra: el rastro siguiente es de otro turno
      turnTrace = null;
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
ipcMain.handle('config:get', () => ({
  providers: config.providers,
  active: config.active,
  settings: config.settings,
  presets: PRESETS
}));

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

ipcMain.handle('provider:save', (e, p) => {
  // Validación: un payload vacío (o con una baseUrl de otro esquema) propagaba un
  // TypeError al guardar y dejaba la configuración a medias.
  const bad = validateProvider(p);
  if (bad) return bad;
  const idx = config.providers.findIndex(x => x.id === p.id);
  if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...p };
  else config.providers.push(p);
  return persistConfig();
});

ipcMain.handle('provider:delete', (e, id) => {
  config.providers = config.providers.filter(x => x.id !== id);
  // el proveedor activo puede no llevar providerId (el renderer no siempre lo
  // manda), así que se compara también por id. Comparar una baseUrl con un id
  // (como se hacía antes) podía desactivar el proveedor equivocado.
  const a = config.active;
  if (a && (a.providerId === id || a.id === id)) config.active = null;
  return persistConfig();
});

ipcMain.handle('provider:models', async (e, { baseUrl, apiKey }) => {
  // Igual que en activar: el campo de clave se vacía al cambiar de preset, así que
  // si no llega clave se usa la del proveedor guardado con esa URL. Detectar
  // modelos no puede fallar en 401 por una credencial que ya está guardada.
  const key = String(apiKey || '').trim() || providerKeyFor({ baseUrl });
  try { return { ok: true, models: await listModels(baseUrl, key) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('provider:activate', (e, cfg) => {
  // Activar sin validar dejaba el badge en «Conectado» con una URL inservible
  // (o sin modelo) y el chat fallaba en cada envío.
  const bad = validateProvider(cfg, { requireId: false, requireModel: true });
  if (bad) return bad;
  // id resuelto del catálogo: es lo que permite desactivarlo al borrarlo
  const prov = config.providers.find(p => p.baseUrl === cfg.baseUrl && p.model === cfg.model)
    || config.providers.find(p => p.baseUrl === cfg.baseUrl);
  // El formulario manda `apiKey: $('#pKey').value`, y ese campo se vacía al
  // cambiar de preset: activar con el campo vacío dejaba `config.active` SIN
  // clave aunque el proveedor guardado la tuviera, y cada turno salía en 401
  // («Missing API key») hasta caer al modelo de la cadena de fallback. Activar un
  // modelo no puede vaciar una credencial que ya estaba guardada.
  const apiKey = String(cfg.apiKey || '').trim() || providerKeyFor(cfg);
  config.active = { ...cfg, apiKey, providerId: cfg.providerId || cfg.id || (prov && prov.id) || null };
  return persistConfig();
});

/** Clave del proveedor guardado al que corresponde una activación (por id o por URL). */
function providerKeyFor({ providerId, id, baseUrl } = {}) {
  const prov = (config.providers || []).find(p => (providerId && p.id === providerId) || (id && p.id === id) || (baseUrl && p.baseUrl === baseUrl));
  return (prov && prov.apiKey) || '';
}

ipcMain.handle('settings:set', (e, patch) => {
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
  if ('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean) {
    try { if (win && !win.isDestroyed()) win.webContents.send('theme:changed', { uiColor: config.settings.uiColor, glowColor: config.settings.glowColor, glowStrength: config.settings.glowStrength }); } catch {}
    if (config.settings.glowEnabled && !HIDDEN) glow('pulse');
  }
  // el renderer sigue recibiendo los ajustes; si el disco falló, se lo decimos
  // además por el mismo canal (y ya ha recibido el toast de persistConfig)
  return saved.ok ? config.settings : { ...config.settings, saveError: saved.error };
});

// ---- agent mode (Think / Plan / Act) — v2.0: observa la preferencia ----
ipcMain.handle('mode:set', (e, mode) => {
  config.settings.mode = ['think', 'plan', 'act'].includes(mode) ? mode : 'act';
  try { habits.observe('mode', { mode: config.settings.mode }); } catch {}
  saveConfig();
  return config.settings.mode;
});

// ---- agents panel data: which tools fired + activity feed ----
ipcMain.handle('agents:live', () => ({
  running: agent ? agent.isBusy() : false,
  mode: config.settings.mode || 'act',
  toolsFired: agent ? agent.getToolsFired() : []
}));

// ---- v1.2 memoria avanzada: metadata + selección por relevancia (agent/memory.js) ----
const memory = require('../agent/memory');
const checkpoints = require('../agent/checkpoints');
const cambios = require('../agent/cambios');    // v2.5: pre-imágenes del turno (revisión y deshacer)
const repomap = require('../agent/repomap');    // v2.5: hay que invalidarlo cuando se deshace
const instrucciones = require('../agent/instrucciones'); // v2.5: SAGITARI.md / AGENTS.md del proyecto
ipcMain.handle('memory:list', () => memory.list());

// ---------- skills ----------
ipcMain.handle('skills:list', () => skills.listSkills());
ipcMain.handle('skills:toggle', async (e, { id, enabled }) => { await skills.setEnabled(id, enabled); return skills.listSkills(); });
ipcMain.handle('skills:import', async (e, arg) => {
  // Una skill son INSTRUCCIONES que el agente obedecerá, no un texto inerte:
  // la primera llamada devuelve la vista previa y exige un segundo clic con
  // confirm:true (consentimiento informado, sin modales nativos). Acepta el
  // formato antiguo (string) para no romper llamadas existentes.
  const repo = (arg && typeof arg === 'object') ? String(arg.repo || '') : String(arg || '');
  const confirm = !!(arg && typeof arg === 'object' && arg.confirm === true);
  if (!confirm) {
    const preview = await skills.previewImport(repo);
    runlog.log({ agent: 'sagitari', event: 'skills_import_preview', repo: preview.repo, total: preview.total });
    return {
      ok: false, needsConfirm: true, preview,
      error: `«${preview.repo}» trae ${preview.total} skill(s): ` +
        preview.items.map(s => s.name).join(', ') +
        (preview.truncated ? `… (y más)` : '') +
        `. Son instrucciones que el agente obedecerá: pulsa Importar otra vez para confirmar.`,
    };
  }
  return skills.importFromGitHub(repo);
});
ipcMain.handle('skills:create', async (e, data) => skills.createSkill(data || {}));
ipcMain.handle('skills:delete', async (e, id) => skills.deleteSkill(String(id || '')));
ipcMain.handle('skills:search', async (e, q) => skills.searchSkills(String(q || '')));
ipcMain.handle('skills:update', async (e, id) => skills.updateSkill(String(id || '')));
ipcMain.handle('skills:updateAll', async () => skills.updateAll());
ipcMain.handle('skills:read', async (e, id) => { const s = await skills.getSkill(id); return s ? { id: s.id, name: s.name, description: s.description, body: s.body, version: s.version, source: s.source } : null; });

// ---- v1.7 marketplace + v1.6 routing/health + v2.0 hábitos ----
ipcMain.handle('market:catalog', async () => {
  const imported = (await skills.listSkills()).map(s => s.source && s.source.repo).filter(Boolean);
  return marketplace.catalog(imported);
});
ipcMain.handle('market:search', async (e, q) => marketplace.searchGitHub(String(q || 'skill')));
ipcMain.handle('health:get', () => models.summary());
ipcMain.handle('habits:get', () => habits.stats());
ipcMain.handle('habits:reset', () => { habits.reset(); return { ok: true }; });
ipcMain.handle('skills:openFolder', async () => { const d = skills.skillsDir(); await fsp.mkdir(d, { recursive: true }); require('electron').shell.openPath(d); });
ipcMain.handle('memory:add', (e, item) => memory.add({
  text: item && item.text,
  source: 'user',
  importance: Number((item && item.importance) ?? 0.5),
  confidence: 0.8,
}));
ipcMain.handle('memory:update', (e, { id, patch }) => memory.update(String(id), patch || {}));
ipcMain.handle('memory:remove', (e, id) => memory.remove(String(id)));

// ---- conversations: separate chats, persisted, restorable ----
const CONV_FILE = path.join(CONFIG_DIR, 'conversations.json');
const MAX_CONVS = 300;   // techo solo al escribir; en memoria no se poda nada
let convs = [];
let currentConvId = null;
try {
  convs = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
  if (!Array.isArray(convs)) convs = [];
} catch (err) {
  // Antes este fallo se silenciaba y el historial «desaparecía» sin decir nada.
  // Ahora se intenta la copia .bak y, si tampoco sirve, se avisa.
  if (fs.existsSync(CONV_FILE)) {
    try {
      convs = JSON.parse(fs.readFileSync(CONV_FILE + '.bak', 'utf8'));
      if (!Array.isArray(convs)) throw new Error('el .bak no contiene una lista');
      console.error('conversations.json ilegible, recuperado desde conversations.json.bak:', err.message);
    } catch (err2) {
      convs = [];
      console.error('conversations.json ilegible y sin .bak válido; se empieza de cero:', err.message, err2.message);
    }
  }
}
function saveConvs() {
  try {
    // Antes se recortaba el array EN MEMORIA a 60 conversaciones en cada guardado:
    // pérdida de historial silenciosa. Ahora se guarda todo y solo se recorta al
    // escribir, y solo si de verdad hay un exceso enorme (con .bak del anterior).
    let out = convs;
    if (convs.length > MAX_CONVS) {
      out = convs.slice(0, MAX_CONVS);
      // La conversación abierta no puede quedarse fuera del fichero: el usuario
      // seguiría viendo y respondiendo sus mensajes, y desaparecerían al reiniciar.
      const cur = currentConv();
      if (cur && !out.includes(cur)) out = [...out.slice(0, MAX_CONVS - 1), cur];
    }
    writeJsonAtomic(CONV_FILE, JSON.stringify(out));
  } catch (err) {
    console.error('saveConvs', err.message);
    // el chat es el dato con más valor del usuario: si no se pudo escribir, se dice
    avisarDisco('La conversación no se pudo escribir en disco (' + err.message + '). Los mensajes nuevos pueden perderse al cerrar la app.');
  }
}
const currentConv = () => convs.find(c => c.id === currentConvId);
function ensureConv() {
  if (!currentConv()) {
    const c = { id: 'c' + Date.now().toString(36), title: 'Nueva conversación', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    convs.unshift(c);
    currentConvId = c.id;
  }
  return currentConv();
}

ipcMain.handle('conv:list', () => convs.map(c => ({ id: c.id, title: c.title, count: c.messages.length, updatedAt: c.updatedAt })));

// ---- espacio de trabajo: carpeta por defecto donde el agente crea/modifica ----
const DEFAULT_WORKSPACE = path.join(app.getPath('desktop'), 'Sagitari');
const getWorkspace = () => config.settings.workspace || DEFAULT_WORKSPACE;
ipcMain.handle('workspace:get', () => getWorkspace());
ipcMain.handle('workspace:set', (e, dir) => {
  const p = String(dir || '').trim();
  // Un workspace es donde el agente CREA, ESCRIBE y EJECUTA: no puede ser una
  // ruta relativa (¿relativa a qué?), ni la raíz de una unidad, ni las carpetas
  // del sistema, ni el directorio de datos de la app (ahí viven las API keys y
  // las conversaciones). Un bug del renderer no puede convertir esto en un
  // mkdir recursivo donde no toca.
  try {
    if (!path.isAbsolute(p)) return { ok: false, error: 'La ruta tiene que ser absoluta' };
    const norm = path.win32.normalize(p);
    if (/^[a-z]:[\\/]?$/i.test(norm)) return { ok: false, error: 'La raíz de una unidad no puede ser el espacio de trabajo' };
    const low = norm.toLowerCase();
    const sysRx = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)([\\/]|$)/;
    if (sysRx.test(low)) return { ok: false, error: 'Las carpetas del sistema no pueden ser el espacio de trabajo' };
    let real = norm;
    try { real = fs.realpathSync(norm); } catch {}
    const inDir = (f, d) => { const r = path.relative(d, f); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (inDir(real.toLowerCase(), CONFIG_DIR.toLowerCase())) return { ok: false, error: 'El directorio de datos de la app no puede ser el espacio de trabajo' };
    if (!fs.existsSync(real)) fs.mkdirSync(real, { recursive: true });
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'La ruta no es una carpeta' };
    config.settings.workspace = real; saveConfig();
    return { ok: true, path: real };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  config.settings.workspace = r.filePaths[0]; saveConfig();
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('conv:new', () => {
  const c = { id: 'c' + Date.now().toString(36), title: 'Nueva conversación', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  convs.unshift(c);
  currentConvId = c.id;
  if (agent) { agent.history = []; agent.useSession(c.id); }
  saveConvs();
  return { ok: true, id: c.id };
});
// reasignar el chat en curso tras la primera respuesta (evita chats fantasma)
// se invoca desde el renderer cuando cambia el título del chat
ipcMain.handle('conv:rename', (e, title) => {
  const c = currentConv();
  if (c && c.title === 'Nueva conversación' && title) { c.title = String(title).slice(0, 60); c.updatedAt = Date.now(); saveConvs(); }
  return { ok: true };
});
ipcMain.handle('conv:open', (e, id) => {
  const c = convs.find(x => x.id === id);
  if (!c) return { ok: false, error: 'Conversación no encontrada' };
  currentConvId = id;
  if (agent) { agent.history = c.messages.map(m => ({ role: m.role, content: m.content })); agent.useSession(c.id); }
  return { ok: true, messages: c.messages };
});
ipcMain.handle('conv:del', (e, id) => {
  convs = convs.filter(c => c.id !== id);
  if (currentConvId === id) { currentConvId = null; if (agent) agent.history = []; }
  saveConvs();
  return { ok: true };
});

/* Miniatura de un dataUrl de imagen (320 px de ancho) para guardar en la
   conversación: la burbuja al reabrir enseña la miniatura en vez de un chip
   ciego, y el JSON no engorda megabytes por cada pantallazo. Devuelve undefined
   si no se pudo generar (formato raro, imagen vacía): el llamante guarda el
   chip con el nombre. Solo proceso principal (usa nativeImage de Electron). */
function thumbnailOf(dataUrl) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (!img || img.isEmpty()) return undefined;
    const size = img.getSize();
    if (!size || !size.width || !size.height) return undefined;
    if (size.width <= 320) return String(dataUrl);   // ya es pequeña: no se re-comprime
    return img.resize({ width: 320 }).toDataURL();
  } catch { return undefined; }
}

ipcMain.handle('chat:send', async (e, { text, imageDataUrl, attachments }) => {
  // el renderer manda string, pero un bug suyo no puede reventar el handler:
  // `body.slice(0,48)` asumía string y un texto no-string rompía el turno
  if (typeof text !== 'string') text = '';
  if (!agent) wireAgent();
  const c = ensureConv();
  if (agent) agent.useSession(c.id);   // sesión estable por conversación (OpenCode Go)
  // ---- adjuntos: texto plano inline, imágenes como partes multimodales ----
  const atts = Array.isArray(attachments) ? attachments : [];
  const imgAtts = atts.filter(a => a && a.kind === 'image' && a.dataUrl);
  const txtAtts = atts.filter(a => a && a.kind === 'text');
  let body = text || (imgAtts.length && !txtAtts.length ? '(análisis de imagen)' : '');
  if (txtAtts.length) {
    body = (body ? body + '\n\n' : '') + 'He adjuntado archivos para que los uses en tu respuesta:\n\n' + attach.blocksFor(txtAtts);
  }
  if (!body) body = '(adjunto sin texto)';
  // comando manual de skill: "/skill <resto>" — el usuario fuerza la skill
  const sm = String(text || '').match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (sm) {
    const s = await skills.getSkill(sm[1]);
    if (s && s.enabled) {
      // inyecta la skill en el contexto del agente (como mensaje de sistema)
      agent.history.push({ role: 'system', content: `SKILL ACTIVADA POR EL USUARIO: ${s.name}\n\n${s.body}` });
      body = (sm[2] || '').trim() || `Aplica la skill ${s.name}.`;
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'status', text: `Skill ${s.name} aplicada` });
    }
  }
  trazaNueva();   // el rastro del turno anterior ya está guardado con su mensaje
  if (c.messages.length === 0) c.title = body.slice(0, 48);
  // el modo queda grabado con la pregunta: en el chat se ve con qué modo se
  // pidió cada cosa (ACT ejecuta, PLAN planifica, THINK razona)
  const sentMode = (config.settings && config.settings.mode) || 'act';
  // en la conversación guardamos los metadatos de los adjuntos (no el texto
  // completo: las conversaciones pueden ser grandes y se leen en cada arranque).
  // Las imágenes se guardan como MINIATURA (320 px): un pantallazo de 5 MB en
  // base64 se relee entero en cada arranque y nunca se vuelve a enviar al
  // modelo (el turno ya pasó). Sin miniatura, la tarjeta al reabrir enseña el
  // chip con el nombre, igual que los adjuntos de texto.
  const attMeta = atts.map(a => {
    const kind = a.kind || (a.dataUrl ? 'image' : 'text');
    const thumb = kind === 'image' && a.dataUrl ? thumbnailOf(a.dataUrl) : undefined;
    return { name: a.name, kind, size: a.size || 0, ...(thumb ? { dataUrl: thumb } : {}) };
  });
  c.messages.push({ role: 'user', content: body, ts: Date.now(), mode: sentMode, attachments: attMeta.length ? attMeta : undefined });
  c.updatedAt = Date.now();
  saveConvs();
  glow('think');
  // afterglow: no apagar al instante al terminar el stream; deja respirar el glow
  const firstImage = imgAtts.length ? imgAtts[0].dataUrl : imageDataUrl;
  agent.chat(body, config, firstImage, { attachments: atts })
    .catch((err) => registrarFallo('chat:send', err))   // sin esto el fallo se perdía como promesa flotante
    .finally(() => setTimeout(() => glow('off'), 2400));
  return { ok: true };
});

// regenerar: descarta la última respuesta y vuelve a pedírsela al modelo
ipcMain.handle('chat:retry', async () => {
  if (!agent) return { ok: false, error: 'sin agente' };
  // regenerar durante un turno en curso lo pisaría: exigimos que esté libre
  if (agent.isBusy()) return { ok: false, error: 'hay un turno en curso; deténlo antes de regenerar' };
  trazaNueva();   // regenerar es un turno nuevo: su rastro se guarda con su respuesta
  const c = currentConv();
  // quita la última respuesta del historial guardado (y solo esa). Se busca
  // DESPUÉS del último mensaje del usuario: un turno que falló no llega a
  // guardarse (el error no emite assistant_done), así que antes se borraba la
  // respuesta de un turno anterior y el usuario perdía un mensaje por reintento.
  if (c && c.messages.length) {
    let lastUser = -1;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      if (c.messages[i].role === 'user') { lastUser = i; break; }
    }
    for (let i = c.messages.length - 1; i > lastUser; i--) {
      if (c.messages[i].role === 'assistant') { c.messages.splice(i, 1); break; }
    }
    c.updatedAt = Date.now();
    saveConvs();
  }
  return await agent.retry(config);
});

ipcMain.handle('chat:stop', () => { agent && agent.stop(); return { ok: true }; });
ipcMain.handle('chat:pause', () => (agent ? agent.pause() : { ok: false, error: 'sin agente' }));
ipcMain.handle('chat:clear', () => { agent && (agent.history = []); return { ok: true }; });

// ---- v1.2/v1.3 tareas: cola en background, listado, pausa, cancelar, borrar ----
ipcMain.handle('tasks:list', () => (taskManager ? taskManager.list() : checkpoints.list('all')));
ipcMain.handle('tasks:enqueue', (e, data) => wireTaskManager().enqueue({
  goal: data && data.goal,
  mode: (data && data.mode) || 'act',
  scheduledAt: (data && data.scheduledAt) || null,
  origin: (data && data.scheduledAt) ? 'scheduled' : 'background',
}));
ipcMain.handle('tasks:pause', (e, runId) => (taskManager ? taskManager.pause(String(runId || '')) : { ok: false, error: 'sin gestor de tareas' }));
ipcMain.handle('tasks:resume', (e, runId) => wireTaskManager().resume(String(runId || '')));
ipcMain.handle('tasks:cancel', (e, runId) => (taskManager ? taskManager.cancel(String(runId || '')) : { ok: false, error: 'sin gestor de tareas' }));
// borrar una tarea viva exige parar su agente: checkpoints.remove rechaza los
// estados vivos, así que el borrado pasa por el gestor (que sí detiene y olvida)
ipcMain.handle('tasks:remove', (e, runId) => (taskManager ? taskManager.remove(String(runId || '')) : checkpoints.remove(String(runId || ''))));

// ---- v1.1 seguridad: confirmaciones, permisos, guardarraíles, métricas ----
// v1.3: la confirmación puede ir dirigida a un agente de background (runId)
ipcMain.handle('sec:resolve', (e, { id, approved, runId }) => {
  if (runId && taskManager) {
    const a = taskManager.agents.get(String(runId));
    if (a) return { ok: !!a.resolveConfirm(id, approved) };
  }
  if (agent && agent.resolveConfirm(id, approved)) return { ok: true };
  // v1.4: confirmaciones de SUBAGENTES (instancias sin registrar en main)
  const { Agent } = require('../agent/agent');
  if (Agent.routeConfirm(String(id || ''), approved)) return { ok: true };
  // ninguna confirmación viva con ese id: antes se respondía ok y el renderer no
  // podía distinguir «resuelta» de «ya no existe»
  return { ok: false, error: 'la confirmación ya no está pendiente' };
});
ipcMain.handle('sec:setToolPerm', (e, { tool, level }) => {
  if (!config.security) config.security = { permissions: {}, guardrails: securityDefaults.guardrails };
  if (level === 'default') delete config.security.permissions[tool];
  else config.security.permissions[tool] = String(level);
  if (agent) agent.setPolicy(config.security);
  return { ...persistConfig(), permissions: config.security.permissions };
});
ipcMain.handle('sec:setGuardrail', (e, patch) => {
  if (!config.security) config.security = { permissions: {}, guardrails: securityDefaults.guardrails };
  const g = config.security.guardrails;
  // Con un umbral de bucle 0 o 1 la detección salta en la PRIMERA herramienta
  // (cualquier tarea moriría al arrancar): se exige el mínimo que detecta algo.
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in g)) continue;
    g[k] = Math.max(k === 'loopThreshold' ? 2 : 0, Math.floor(Number(v) || 0));
  }
  if (agent) agent.setPolicy(config.security);
  return { ...persistConfig(), guardrails: g };
});
ipcMain.handle('meta:get', () => {
  const g = (config.security && config.security.guardrails) || {};
  return {
    model: (config.active && config.active.model) || null,
    guardrails: g,
    permissions: (config.security && config.security.permissions) || {},
    riskDefaults: DEFAULT_RISK,          // nivel de riesgo recomendado por herramienta
    guardrailDefaults: securityDefaults.guardrails,   // fuente única de los «valores recomendados»
    dataDir: CONFIG_DIR,                 // carpeta de datos del usuario
    run: agent ? agent.getMeta() : null,
    tasks: taskManager ? taskManager.list() : [],
    logFile: runlog.currentLogFile(),
  };
});
ipcMain.handle('logs:recent', (e, n) => runlog.readRecent(Number(n) || 200));

/* ---------- v3.1: servidores MCP del usuario ---------- */
/* Estado para la UI: la configuración completa del servidor (command/args/env/headers,
   con el mismo criterio que config:get con las claves de proveedor: el renderer es de
   confianza y sin ellos el formulario de edición no puede editar nada) MÁS el estado
   vivo del gestor. `discovered` es el catálogo REAL descubierto: NO se puede llamar
   `tools` porque `tools` en la configuración son los filtros allow/deny.
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

ipcMain.handle('mcp:list', () => mcpState());

ipcMain.handle('mcp:save', (e, raw) => {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const v = mcpConfig.validateServer(payload);
  if (!v.ok) return { ok: false, error: v.error };
  const server = v.value;
  // el formulario no reenvía los secretos: un valor vacío conserva el guardado
  const previo = (config.mcp.servers || []).find(s => s.id === server.id);
  if (previo) {
    server.env = mcpConfig.mergeSecrets(previo.env, server.env);
    server.headers = mcpConfig.mergeSecrets(previo.headers, server.headers);
    // El formulario no reenvía estos campos: se conservan del servidor guardado para
    // que editar no reactive un servidor apagado ni pierda autoStart/timeout/cwd.
    if (payload.enabled === undefined) server.enabled = previo.enabled !== false;
    if (payload.autoStart === undefined) server.autoStart = previo.autoStart === true;
    if (payload.timeoutMs === undefined) server.timeoutMs = previo.timeoutMs;
    if (payload.cwd === undefined && server.transport === 'stdio') server.cwd = previo.cwd || '';
  }
  config.mcp.servers = [...(config.mcp.servers || []).filter(s => s.id !== server.id), server];
  wireMcp();
  const r = persistConfig();
  // el id saneado y su comodín de permisos viajan de vuelta: la UI necesita el comodín
  // ya normalizado (el id crudo no vale para `mcp__<id>__*` si trae guiones)
  return r.ok
    ? { ok: true, id: server.id, permKey: 'mcp__' + serverSlug(server.id) + '__*', servers: mcpState().servers }
    : { ok: false, error: r.error };
});

ipcMain.handle('mcp:delete', (e, id) => {
  const sid = mcpConfig.rawId(id);
  config.mcp.servers = (config.mcp.servers || []).filter(s => s.id !== sid);
  // los permisos de un servidor borrado quedarían huérfanos (y si vuelve, con
  // los niveles de antes, que el usuario ya no ve en ningún sitio). Las claves se
  // buscan con el slug del nombre expuesto, NO con el id crudo: si no, un id con
  // guion o de más de 16 caracteres dejaría sus permisos ahí para siempre.
  const prefijo = 'mcp__' + serverSlug(sid) + '__';
  for (const k of Object.keys(config.security.permissions || {})) {
    if (k.startsWith(prefijo)) delete config.security.permissions[k];   // cubre `mcp__<slug>__*` y cada `mcp__<slug>__<tool>`
  }
  if (agent) agent.setPolicy(config.security);
  wireMcp();
  // Si el disco falla, el servidor NO está borrado: decirlo ahora evita que el panel
  // cante «eliminado» y el servidor vuelva a estar ahí al reiniciar.
  const r = persistConfig();
  return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
});

ipcMain.handle('mcp:toggle', (e, { id, enabled }) => {
  const sid = mcpConfig.rawId(id);
  const s = (config.mcp.servers || []).find(x => x.id === sid);
  if (!s) return { ok: false, error: 'servidor MCP desconocido' };
  s.enabled = enabled !== false;
  // reconfigure aplica el cambio: apagado suelta el proceso y deja de ofrecer herramientas
  wireMcp();
  // activar una fila debe dejarla lista, no solo marcar la bandera
  if (config.mcp.enabled !== false && s.enabled) wireMcp().ensure(s.id).catch(() => {});
  const r = persistConfig();
  return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
});

ipcMain.handle('mcp:setGlobal', (e, enabled) => {
  config.mcp.enabled = enabled !== false;
  const m = wireMcp();
  // Al reencender el interruptor hay que reconectar lo que el arranque no arrancó:
  // sin esto los servidores autoStart se quedan en 'idle' y MCP no aporta nada.
  if (config.mcp.enabled) for (const s of config.mcp.servers || []) if (s.autoStart && s.enabled) m.ensure(s.id).catch(() => {});
  return persistConfig();
});

ipcMain.handle('mcp:refresh', async (e, id) => {
  const sid = mcpConfig.rawId(id);
  const r = await wireMcp().ensure(sid);
  return { ok: r.ok, error: r.error || null, server: mcpState().servers.find(s => s.id === sid) };
});

ipcMain.handle('mcp:test', async (e, id) => {
  const sid = mcpConfig.rawId(id);
  const r = await wireMcp().ensure(sid);
  return { ok: r.ok, error: r.error || null, server: mcpState().servers.find(s => s.id === sid) };
});

ipcMain.handle('mcp:log', (e, id) => {
  const s = mcpState().servers.find(x => x.id === mcpConfig.rawId(id));
  return { ok: !!s, log: (s && s.logTail) || '', error: (s && s.error) || null };
});

ipcMain.handle('mcp:export', () => ({ ok: true, json: JSON.stringify(mcpExport(), null, 2) }));

ipcMain.handle('mcp:import', (e, json) => {
  // NO escribe: devuelve la vista previa con conflictos para que el usuario confirme
  const r = mcpConfig.parseMcpImport(String(json || ''));
  if (!r.ok) return r;
  const existentes = new Set((config.mcp.servers || []).map(s => s.id));
  return { ok: true, servers: r.servers.map(s => ({ ...s, conflict: existentes.has(s.id) })) };
});

ipcMain.on('glow:set', (e, { mode, color }) => glow(mode, color));

// ---- voice (Windows dictation: WinRT engine + SAPI fallback, UTF-8 protocol) ----
/* El protocolo de línea (`PREFIJO::cuerpo`) se interpreta en `voice/protocolo.js`, que
   es donde está probado: aquí se traducía con un `slice()` a mano por prefijo y la mitad
   de los números estaban mal (ver la cabecera de ese módulo). */
const { partirLinea } = require('./voice/protocolo');
/* `powershell.exe -File` no puede leer dentro de `app.asar`: en la app instalada el
   dictado clásico apuntaba a `…/app.asar/main/voice.ps1` y PowerShell lo rechazaba.
   El resolver devuelve la ruta desempaquetada (o una copia real) — ver voice/ruta-script.js. */
const { rutaScriptReal } = require('./voice/ruta-script');

ipcMain.handle('voice:start', async () => {
  if (whisper) return { ok: true, note: 'Ya estaba escuchando' };
  dictando = true;                       // hay intención de dictar: la muerte del motor tiene reintento
  whisperBuf = '';
  arrancarDictado();
  return { ok: true };
});

/* ¿Quiere el usuario que el dictado siga vivo? Lo pone `voice:start` y lo quita
   `voice:stop` (ambos son acciones suyas): el reintento automático no puede revivir un
   dictado que ya se cerró, ni arrancar uno durante el cierre de la app. */
let dictando = false;
let saliendo = false;

/* Arranca el proceso de dictado y cablea sus listeners. Va en su propia función para que
   el reintento automático (el 'exit' no pedido) pueda relanzar el MISMO arranque sin
   duplicar el cableado. */
function arrancarDictado() {
  const lang = config.settings.voiceLang || 'es-ES';
  // El handle del proceso vive en `p`: cada listener comprueba identidad antes de
  // tocar `whisper`, para que el 'exit' tardío de un proceso viejo no anule la
  // referencia al nuevo.
  /* Sin `-NoWinrt`: el motor moderno de Windows (WinRT) es el que reconoce de verdad
     el dictado libre, y es el único que oye bien en español. La versión anterior lo
     capaba aquí y dejaba al usuario con el clásico (SAPI 8.0), mucho peor: `voice.ps1`
     ya sabe caer solo al clásico —y decir por qué— cuando WinRT no está disponible,
     así que caparlo aquí era perder precisión sin ganar fiabilidad ninguna. */
  /* El PARSEO del protocolo vive en `voice/protocolo.js` (mismo módulo que el modo voz):
     aquí había una segunda copia a mano con los mismos `slice()` mal contados que ya se
     corrigieron allí. Dos fuentes de verdad para el mismo protocolo es un bug futuro. */
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rutaScriptReal(path.join(__dirname, 'voice.ps1')), '-Lang', lang], { windowsHide: true });
  whisper = p;
  p.stdout.on('data', (d) => {
    if (whisper !== p) return;   // proceso ya reemplazado: su salida no interesa
    whisperBuf += d.toString('utf8');
    let idx;
    while ((idx = whisperBuf.indexOf('\n')) >= 0) {
      const line = whisperBuf.slice(0, idx).replace(/\r$/, '').trim(); whisperBuf = whisperBuf.slice(idx + 1);
      if (!line) continue;
      const parte = partirLinea(line);
      if (parte) {
        const { prefijo, cuerpo } = parte;
        const vivo = win && !win.isDestroyed();
        switch (prefijo) {
          case 'PART::': if (vivo) win.webContents.send('voice:partial', cuerpo); break;
          case 'FINAL::': if (vivo) win.webContents.send('voice:final', cuerpo); break;
          case 'MODE::': if (vivo) win.webContents.send('voice:mode', cuerpo); break;
          /* `NOTE::` es la explicación del motor (por qué cae al clásico): viaja como
             aviso, igual que en el motor del modo voz, en vez de perderse. */
          case 'HINT::': case 'NOTE::': if (vivo) win.webContents.send('voice:hint', cuerpo); break;
          case 'READY::': if (vivo) win.webContents.send('voice:ready', cuerpo); break;
          default: if (vivo) win.webContents.send('voice:error', cuerpo); break;
        }
        /* Un ERROR:: de este motor NO se toma como «el proceso ha muerto»: los avisos
           que importan (política de voz en línea, por ejemplo) los dice y sigue vivo,
           bajando al motor clásico. Matarlo aquí dejaba al usuario sin dictado justo
           después de haberle prometido que seguiría escuchando. Si de verdad se cae,
           sale por su propio `exit` y lo cuenta el listener de abajo. */
        if (prefijo === 'ERROR::') {
          console.error('[SAGITARI] voz: ' + cuerpo);
          try { runlog.log({ agent: 'voice', event: 'error', message: cuerpo.slice(0, 300) }); } catch {}
        }
        continue;
      }
      if (line.startsWith('STOPPED::')) {
        try { p.kill(); } catch {}
        if (whisper === p) whisper = null;
      }
    }
  });
  // El stderr deja de descartarse: un fallo de PowerShell (binding, ejecución,
  // permisos) se perdía en silencio y el dictado parecía «no hacer nada».
  let errBuf = '';
  p.stderr.on('data', (d) => {
    const chunk = d.toString('utf8');
    errBuf = (errBuf + chunk).slice(-2000);
    const msg = chunk.trim();
    if (!msg) return;
    console.error('[SAGITARI] voice.ps1: ' + msg.slice(0, 500));
    try { runlog.log({ agent: 'voice', event: 'stderr', message: msg.slice(0, 300) }); } catch {}
  });
  p.on('exit', () => {
    const current = whisper === p;
    if (current) whisper = null;
    // solo el proceso vigente puede reportar el error de su arranque
    if (current && errBuf.trim() && win && !win.isDestroyed()) win.webContents.send('voice:error', errBuf.trim().slice(0, 500));
    if (win && !win.isDestroyed()) win.webContents.send('voice:stopped');
    /* Red de seguridad del DICTADO: si el motor muere sin que nadie lo pidiera (crash de
       PowerShell, cierre del micro por el sistema), el dictado no se queda muerto para
       siempre: UN intento tras 2 s, solo si el usuario sigue queriendo dictar y no hay
       otro motor en pie. Si el entorno rompe el motor de nuevo, martillarlo con más
       intentos solo llenaría el log: el usuario ya ve el aviso y puede reabrir el micro. */
    if (current && dictando && !saliendo) {
      setTimeout(() => { if (dictando && !whisper && !saliendo) arrancarDictado(); }, 2000);
    }
  });
}

ipcMain.handle('voice:stop', async () => {
  dictando = false;   // un cierre pedido desarma el reintento automático
  const p = whisper;
  if (p) { whisper = null; try { p.kill(); } catch {} }
  return { ok: true };
});

// ---- TTS (SAPI, Spanish voice if available) ----
const { createTtsWindows } = require('./voice/tts-windows');
/* Una sola tubería de voz: el VoiceManager trocea y sintetiza por frases; el renderer las
   reproduce (tiene el analizador de audio para el orbe y puede cortar al instante). El
   manager se crea aquí si hace falta: hablar no necesita el modo voz abierto.
   Se conserva el nombre `tts:speak` y su contrato de silencio en arranques automatizados:
   hay una comprobación de ui-check que depende de eso. */
ipcMain.handle('tts:speak', async (e, text, opts) => {
  /* Un arranque automatizado (--smoke/--hidden/--test) NUNCA habla. Los bancos de
     prueba conducen conversaciones simuladas —el modelo de ui-check contesta «listo»—
     con la ventana OCULTA, así que la voz salía por los altavoces del usuario sin nada
     en pantalla que la explicase: parecía que la app saludaba sola al arrancar. Es la
     misma regla que ya rige el glow al arrancar (!HIDDEN), pero aquí pesa más porque el
     sonido sale del equipo. */
  if (HEADLESS) return { ok: false };
  if (!text) return { ok: false };
  /* El ajuste de Ajustes no manda cuando el modo voz lo pide con `forzar`: es un modo de
     oído y negarse a hablar ahí sería absurdo. El permiso viaja por el canal porque quien
     conoce los ajustes es el renderer; el silencio de los arranques de prueba va ANTES y
     no se toca. */
  if (!config.settings.ttsEnabled && !(opts && opts.forzar)) return { ok: false };
  try {
    const voz = managerDeVoz();
    /* Una lectura nueva CORTA la anterior (lo mismo que hacía el proceso viejo al morir):
       sin esto, tras dos turnos seguidos el usuario oiría entera la respuesta anterior
       antes de la nueva y la cola crecería turno a turno.
       `encolar` es el otro caso, y es el que hace que la voz suene como la de un asistente
       de verdad: la respuesta se lee POR FRASES según el modelo la va escribiendo, y cada
       frase nueva se AÑADE a la cola en vez de cortar la que está sonando (si la cortara,
       sólo se oiría el final de cada frase). */
    if (!(opts && opts.encolar)) voz.stopSpeaking();
    voz.say(String(text));
    return { ok: true };
  } catch { return { ok: false }; }
});

/* Motor de síntesis del sistema. La síntesis por frases la orquesta el VoiceManager
   (tarea 5) y el audio lo reproduce el renderer (tarea 9); aquí solo se expone. */
let ttsEngine = null;
function sintetizador() {
  if (!ttsEngine) ttsEngine = createTtsWindows({ dataDir: DATA_DIR });
  return ttsEngine;
}

ipcMain.handle('tts:list', async () => {
  try { return { ok: true, voices: await sintetizador().listarVoces() }; } catch { return { ok: false, voices: [] }; }
});

// ---- modo voz (fase 1: motores de Windows) ----
const { createVoiceManager } = require('./voice/manager');
const { createSttWindows } = require('./voice/stt-windows');
/* Motor de dictado LOCAL de alta precisión (whisper.cpp): se construye perezoso y avisa
   él solo si falta instalarlo — no tumba los motores de Windows, que siguen de relevo. */
const { createWhisper } = require('./voice/whisper');
/* Voz local ligera de alta calidad (Piper): binario + voz es-ES bajo DATA_DIR, mismo
   contrato que el motor de Windows y con este de relevo por frase. */
const { createTtsLocal, usarVozLocal } = require('./voice/tts-local');

let voiceManager = null;
/* Motor de dictado LOCAL (Whisper) y quién está de guardia. Viven AQUÍ, al nivel de los
   handlers de IPC: varios (voice:open, voice:pcm, voice:installStatus) tienen que
   leerlos — declararlos dentro de managerDeVoz() los dejaba inaccesibles y cada apertura
   del modo voz moría con «motorActual is not defined». */
let motorWhisper = null;
let motorActual = 'windows';
let motorWindows = null;   // el motor de Windows de guardia (winrt o clásico)

/* El permiso de micrófono se concede SOLO a nuestra propia página. Hoy el renderer es
   un fichero local nuestro, pero la comprobación deja escrito el límite: si mañana
   carga contenido de fuera, ese contenido no hereda el micrófono del usuario. */
function esNuestraPagina(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase().endsWith('renderer/index.html');
  } catch { return false; }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    /* OJO: lo que NO sea 'media' se deja como estaba. Escribir aquí
       `cb(permission === 'media' && …)` deniega permisos que Electron aprueba por defecto
       (notificaciones, pantalla completa…): es un fallo que la revisión cazó en el plan. */
    if (permission !== 'media') { cb(true); return; }
    const url = (details && details.requestingUrl) || wc.getURL();
    const soloAudio = !details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
    cb(soloAudio && esNuestraPagina(url));
  });
  /* El de comprobación responde a las consultas internas de Chromium: solo se limita
     'media' (lo demás sigue como estaba) para no romper nada más. */
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return true;
    const url = (details && details.requestingUrl) || origin || '';
    return esNuestraPagina(url) && (!details || !details.mediaType || details.mediaType === 'audio');
  });
});

function emitVoz(ev) { try { if (win && !win.isDestroyed()) win.webContents.send('voice:event', ev); } catch {} }

/* El único sitio donde nace el manager. Hablar NO necesita micrófono: la lectura del chat
   también pasa por aquí (una sola tubería de frases), así que se crea de forma perezosa
   desde `tts:speak` y no solo al abrir el modo voz. El constructor no arranca ningún motor
   —el micrófono lo pide `open()` y la síntesis, la primera frase—, así que tenerlo vivo sin
   modo voz no cuesta nada. */
function managerDeVoz() {
  if (voiceManager) return voiceManager;
  /* La voz LOCAL (Piper) manda si está instalada: es la ligera de alta calidad y no
     depende del almacén de Windows. Si falta (o falla una frase), el motor de Windows
     sigue de relevo: el wrapper lo decide por frase, no por sesión. */
  const winTts = createTtsWindows({ dataDir: DATA_DIR });
  const localTts = createTtsLocal({ dataDir: DATA_DIR });
  ttsEngine = {
    nombre: 'auto',
    capacidades: winTts.capacidades,
    sintetizar: async (texto, opts) => {
      const est = (() => { try { return localTts.estado(); } catch { return { disponible: false }; } })();
      /* La decisión vive en tts-local.js (con sus tres casos escritos y sus pruebas):
         aquí sólo se le dan los datos, incluido si la voz guardada la eligió el usuario. */
      const quiereLocal = usarVozLocal({
        disponible: !!est.disponible,
        voice: (opts && opts.voice) || '',
        fijo: !!config.settings.ttsVoiceFijo,
      });
      if (quiereLocal) {
        const r = await localTts.sintetizar(texto, opts);
        if (r && r.wav) return r;
      }
      return winTts.sintetizar(texto, opts);
    },
    listarVoces: async () => {
      const a = await localTts.listarVoces().catch(() => []);
      const b = await winTts.listarVoces().catch(() => []);
      return [...a, ...b];
    },
    dispose: () => { try { localTts.dispose(); } catch {} try { winTts.dispose(); } catch {} },
  };
  /* El motor de escuchar nace la primera vez que se ABRE el modo, no al crear el manager:
     el manager también nace solo para leer el chat (sin micrófono) y, si se construyera
     aquí, se quedaría con el idioma que hubiera en los ajustes en ese momento. `stop()` sin
     motor no hace nada (no hay proceso que parar). */
  const motorEscucha = () => {
    /* El Ajuste «motor de escucha clásico» (sttClasico) arranca DIRECTAMENTE en clásico:
       para las máquinas donde el moderno nunca recibe audio, hacer que el usuario espere
       al vigilante (voz sin texto → rescate) era un minuto de panel sordo cada vez que
       abría el modo. Con el ajuste, desde la primera frase. */
    if (!motorWindows) motorWindows = createSttWindows({ emit: (ev) => voiceManager.ingest(ev), lang: config.settings.voiceLang || 'es-ES', forzarClasico: !!config.settings.sttClasico });
    return motorWindows;
  };
  const motorLocal = () => {
    /* La raíz del motor local es SIEMPRE la del instalador (voice-engine junto a los
       datos del usuario): dos raíces distintas harían una instalación que el motor
       nunca encontraría. */
    if (!motorWhisper) motorWhisper = createWhisper({ emit: (ev) => voiceManager.ingest(ev), lang: config.settings.voiceLang || 'es-ES', dirRaiz: path.join(DATA_DIR, 'voice-engine') });
    return motorWhisper;
  };
  /* La ELECCIÓN de motor: whisper si está instalado (o si el usuario lo fijó con
     motor='whisper'); windows si no. El wrapper desvía start/push/stop al motor
     elegido; motorAlternativo/usarClasico son señales de los motores de Windows
     (sordera de WinRT/SAPI) y no aplican si el activo es whisper. */
  const sttWrapper = {
    start: async () => {
      const w = motorLocal();
      if (w.estado().disponible || config.settings.motor === 'whisper') { motorActual = 'whisper'; return w.start(); }
      motorActual = 'windows';
      return motorEscucha().start();
    },
    push: (pcm) => { if (motorActual === 'whisper' && motorWhisper) motorWhisper.push(pcm); },
    stop: async () => {
      if (motorWhisper) await motorWhisper.stop();
      return motorWindows ? motorWindows.stop() : Promise.resolve();
    },
    motorAlternativo: () => (motorActual === 'windows' ? motorEscucha().motorAlternativo() : Promise.resolve()),
    usarClasico: () => (motorActual === 'windows' ? motorEscucha().usarClasico() : Promise.resolve()),
  };
  voiceManager = createVoiceManager({
    emit: emitVoz,
    stt: sttWrapper,
    tts: ttsEngine,
    onPhrase: (p) => { try { if (win && !win.isDestroyed()) win.webContents.send('tts:phrase', p); } catch {} },
    /* Los ajustes van EN VIVO: se guardan reemplazando el objeto, así que el manager tiene
       que leerlos cada vez (voz, velocidad e idioma) y no quedarse con una copia. */
    settings: () => config.settings,
  });
  return voiceManager;
}

ipcMain.handle('voice:open', async () => {
  try {
    await managerDeVoz().open();
    const escuchar = (motorActual === 'whisper') ? 'whisper' : ((config.settings.sttClasico || sttInfo().motor === 'sapi') ? 'windows-clasico' : 'windows-moderno');
    /* Qué voz va a sonar: se pregunta al motor local de verdad (si está instalado, la
       lectura NO pasa por Windows, así que decir «windows» aquí era mentira). */
    let hablar = 'windows';
    try {
      const local = createTtsLocal({ dataDir: DATA_DIR }).estado();
      if (usarVozLocal({ disponible: !!local.disponible, voice: config.settings.ttsVoice || '', fijo: !!config.settings.ttsVoiceFijo })) hablar = 'piper';
    } catch {}
    return { ok: true, motores: { escuchar, hablar } };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* Motor que está de guardia (para el panel: whisper / windows-moderno / windows-clasico). */
function sttInfo() {
  if (motorActual === 'whisper') return { motor: 'whisper', idioma: '' };
  return motorWindows ? motorWindows.info() : {};
}

ipcMain.handle('voice:close', async () => {
  try { if (voiceManager) await voiceManager.close(); } catch {}
  voiceManager = null;
  ttsEngine = null;
  return { ok: true };
});

/* Rescate del motor de escucha: el renderer detectó voz real del micrófono sin NINGÚN
   texto (motor sordo: NVIDIA Broadcast y similares enganchan el camino de audio moderno
   que usa WinRT; el clásico usa otro y sí oye) y pide el cambio. Es idempotente —si ya
   está en el clásico, el motor no toca nada— y devuelve ok aunque no hubiera manager
   (no hay rescate posible sin modo voz, pero tampoco nada que reportar). */
/* ¿El tap de audio del renderer se está consumiendo? Lo pregunta el renderer cada vez
   que abre el modo (o cada pocos segundos mientras está abierto) para decidir si manda
   PCM — evita copiar audio que nadie va a usar. */
ipcMain.handle('voice:pcmActivo', () => !!(voiceManager && motorActual === 'whisper'));

/* Estado del dictado local para Ajustes y para la franja del panel: qué hay instalado,
   si está transcribiendo y qué motor de escucha está DE GUARDIA ahora mismo. */
ipcMain.handle('voice:installStatus', () => {
  try {
    const w = motorWhisper ? motorWhisper.estado() : null;
    let piper = { disponible: false };
    try { piper = createTtsLocal({ dataDir: DATA_DIR }).estado(); } catch {}
    return {
      ok: true,
      instalando: !!instalandoVoz || !!instalandoPiper,
      disponible: !!(w && w.disponible),
      modeloNombre: (w && w.modeloNombre) || '',
      transcribiendo: !!(w && w.transcribiendo),
      motor: motorActual === 'whisper' ? 'whisper' : (motorWindows ? motorWindows.info().motor : ''),
      /* Telemetría del tap: cuánto audio real ha llegado por voice:pcm y hace cuánto. */
      pcmMs: Math.round(pcmMs),
      pcmMsAgo: pcmUltimo ? Date.now() - pcmUltimo : -1,
      rescatesTap,
      piperDisponible: !!piper.disponible,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('voice:rescue', async () => {
  try {
    if (voiceManager && voiceManager.rescatarMotor) await voiceManager.rescatarMotor();
    /* Con whisper de guardia, el rescate real es REABRIR el tap del renderer (su captura
       es la única fuente del motor local): la orden viaja como evento y el renderer
       reconecta su capturador sin tocar la sesión del panel. */
    if (motorActual === 'whisper' && win && !win.isDestroyed()) {
      rescatesTap++;
      win.webContents.send('voice:event', { type: 'reabrir-tap' });
    }
  } catch {}
  return { ok: true, rescatesTap };
});

ipcMain.on('voice:event', (e, ev) => { if (voiceManager) voiceManager.ingest(ev); });

/* Audio crudo del micrófono (Int16 mono 16 kHz, trozos pequeños): es lo que consume el
   motor local de dictado (whisper). Lo envía el tap del AudioWorklet del renderer, el
   único camino de captura sano en todas las máquinas probadas. Ignorado si el activo no
   es whisper — los motores de Windows capturan por su cuenta. Contar MILISEGUNDOS de
   audio recibido es el único termómetro honesto del tap: «orbe se mueve y no hay
   texto» era indistinguible a distancia de «tap muerto». */
let pcmMs = 0, pcmUltimo = 0, rescatesTap = 0;
ipcMain.on('voice:pcm', (e, pcm) => {
  try {
    if (motorActual === 'whisper' && motorWhisper) {
      const b = Buffer.from(pcm);
      pcmMs += (b.length / 2 / 16000) * 1000;
      pcmUltimo = Date.now();
      motorWhisper.push(b);
    }
  } catch {}
});

/* Instalación del motor local (whisper.cpp): binario + modelo, con progreso al renderer.
   Sin dependencias: descarga directa de las URLs estables del proyecto. El handler espera
   el final de la instalación y el progreso en vivo viaja por 'voice:installProgress' —
   el botón de Ajustes pinta esa marcha mientras el invoke sigue abierto. */
let instalandoVoz = null;
const TAM_BINARIO = 8.6 * 1024 * 1024;        // referencias para el porcentaje del binario (medido: 8,2 MB)
/* El modelo que se instala es el SMALL cuantizado q5_1 (181 MB): es el que se midió en el
   diseño (RTF 0,14 con voz humana, más rápido que tiempo real) y el que de verdad acierta
   con el español. El base (148 MB) se queda como respaldo si ya estaba instalado — el
   motor lo prefiere a él sólo cuando no hay small — porque su precisión en nombres propios
   y frases largas era justo la queja que este motor vino a resolver. */
const MODELO_ARCHIVO = 'ggml-small-q5_1.bin';
const MODELO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + MODELO_ARCHIVO;
const TAM_MODELO = 181 * 1024 * 1024;         // referencia del proyecto para el porcentaje
const MIN_MODELO = 120 * 1024 * 1024;         // por debajo de esto la descarga está cortada
/* La release «latest» de whisper.cpp NO adjunta binarios: los publican en tags de build
   (b5130, b5127, …). Se pregunta a la API cuál de las últimas los trae y se toma su URL
   de descarga — inmutable a que muevan o renombren tags. */
function urlBinarioWhisper() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10', { headers: { 'User-Agent': 'SAGITARI-voice', 'Accept': 'application/vnd.github+json' } }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const releases = JSON.parse(d);
          for (const r of releases || []) {
            const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
            if (a && a.browser_download_url) { resolve(a.browser_download_url); return; }
          }
          reject(new Error('ninguna release reciente trae whisper-bin-x64.zip'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
ipcMain.handle('voice:install', async () => {
  if (instalandoVoz) return { ok: false, error: 'ya se está instalando' };
  const fsPromises = require('fs/promises');
  const https = require('https');
  /* La raíz es el MISMO directorio de datos que usa el motor en whisper.js: dos raíces
     distintas harían una instalación que el motor nunca encontraría. */
  const raiz = path.join(DATA_DIR, 'voice-engine');
  const dirBin = path.join(raiz, 'bin');
  const dirModelos = path.join(raiz, 'models');
  try { fs.mkdirSync(dirBin, { recursive: true }); fs.mkdirSync(dirModelos, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  const bajar = (url, destino, tamRef, tipo) => new Promise((resolve, reject) => {
    const archivo = fs.createWriteStream(destino);
    let recibido = 0;
    let total = tamRef;
    const pedir = (u) => {
      https.get(u, { headers: { 'User-Agent': 'SAGITARI-voice' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return pedir(res.headers.location); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' descargando ' + path.basename(destino))); }
        const cl = Number(res.headers['content-length']);
        if (Number.isFinite(cl) && cl > 0) total = cl;
        res.on('data', (c) => {
          recibido += c.length;
          try { if (win && !win.isDestroyed()) win.webContents.send('voice:installProgress', { tipo, recibido, total }); } catch {}
        });
        res.pipe(archivo);
      }).on('error', reject);
    };
    archivo.on('error', reject);
    archivo.on('finish', () => resolve());
    pedir(url);
  });
  instalandoVoz = (async () => {
    try {
      const zipBin = path.join(raiz, 'whisper-bin.zip');
      await bajar(await urlBinarioWhisper(), zipBin, TAM_BINARIO, 'binario');
      try { if (win && !win.isDestroyed()) win.webContents.send('voice:installProgress', { tipo: 'extrayendo' }); } catch {}
      const { execSync } = require('child_process');
      execSync('powershell.exe -NoProfile -Command "Expand-Archive -Force \'' + zipBin + '\' \'' + dirBin + '\'"', { windowsHide: true, timeout: 120000 });
      await fsPromises.unlink(zipBin).catch(() => {});
      // whisper.cpp mete los ejecutables dentro de subcarpetas (Release/, o el nombre de
      // la build): se aplana hasta que el binario quede junto a sus DLL — whisper.js
      // busca en bin/ sin profundidad.
      try {
        for (let nivel = 0; nivel < 4; nivel++) {
          const carpetas = fs.readdirSync(dirBin).filter((n) => fs.statSync(path.join(dirBin, n)).isDirectory());
          if (!carpetas.length) break;
          for (const c of carpetas) {
            for (const f of fs.readdirSync(path.join(dirBin, c))) {
              const destino = path.join(dirBin, f);
              if (fs.existsSync(destino)) continue;   // nunca se pisa un binario con otro
              fs.renameSync(path.join(dirBin, c, f), destino);
            }
            fs.rmdirSync(path.join(dirBin, c));
          }
        }
      } catch {}
      const modeloPath = path.join(dirModelos, MODELO_ARCHIVO);
      await bajar(MODELO_URL, modeloPath, TAM_MODELO, 'modelo');
      /* Un modelo a medias (proxy que corta la conexión, disco lleno) no es un modelo:
         whisper.cpp cargaría un archivo truncado y devolvería basura en cada frase, que
         se ve exactamente como «el dictado local no acierta». Antes de darlo por bueno
         se mira el tamaño y, si no cuadra, se borra y se dice. */
      let tamModelo = 0;
      try { tamModelo = fs.statSync(modeloPath).size; } catch {}
      if (tamModelo < MIN_MODELO) {
        await fsPromises.unlink(modeloPath).catch(() => {});
        throw new Error('el modelo de dictado llegó incompleto (' + Math.round(tamModelo / 1024 / 1024) + ' MB de ~181 MB): vuelve a intentarlo');
      }
      // Listo: si el modo voz está abierto, el motor local toma la escucha ya.
      try {
        if (voiceManager && motorWhisper) { motorWhisper.resolver(); if (motorActual === 'whisper' || motorWhisper.estado().disponible) motorActual = 'whisper'; }
      } catch {}
      try { if (win && !win.isDestroyed()) win.webContents.send('voice:installProgress', { tipo: 'listo' }); } catch {}
      return { ok: true };
    } catch (err) {
      try { if (win && !win.isDestroyed()) win.webContents.send('voice:installProgress', { tipo: 'error', error: err.message }); } catch {}
      return { ok: false, error: err.message };
    } finally { instalandoVoz = null; }
  })();
});
/* Voz local (Piper davefx es-ES): binario win-x64 (~21 MB) + voz (~60 MB). Misma
   raíz que el motor en tts-local.js: dos raíces harían una instalación que el motor
   nunca encontraría. El zip de Piper trae subcarpeta `piper/`: se aplana igual que
   el binario de Whisper para que piper.exe quede junto a sus DLL y espeak-ng-data. */
let instalandoPiper = null;
const TAM_PIPER_BIN = 22 * 1024 * 1024;
const TAM_PIPER_VOZ = 61 * 1024 * 1024;
ipcMain.handle('tts:install', async () => {
  if (instalandoPiper) return { ok: false, error: 'ya se está instalando' };
  const fsPromises = require('fs/promises');
  const https = require('https');
  const raiz = path.join(DATA_DIR, 'voice-engine', 'tts');
  try { fs.mkdirSync(raiz, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  const bajar = (url, destino, tamRef, tipo) => new Promise((resolve, reject) => {
    const archivo = fs.createWriteStream(destino);
    let recibido = 0;
    let total = tamRef;
    const pedir = (u) => {
      https.get(u, { headers: { 'User-Agent': 'SAGITARI-voice' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return pedir(res.headers.location); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' descargando ' + path.basename(destino))); }
        const cl = Number(res.headers['content-length']);
        if (Number.isFinite(cl) && cl > 0) total = cl;
        res.on('data', (c) => {
          recibido += c.length;
          try { if (win && !win.isDestroyed()) win.webContents.send('tts:installProgress', { tipo, recibido, total }); } catch {}
        });
        res.pipe(archivo);
      }).on('error', reject);
    };
    archivo.on('error', reject);
    archivo.on('finish', () => resolve());
    pedir(url);
  });
  instalandoPiper = (async () => {
    try {
      const zipBin = path.join(raiz, 'piper-bin.zip');
      await bajar('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', zipBin, TAM_PIPER_BIN, 'binario');
      try { if (win && !win.isDestroyed()) win.webContents.send('tts:installProgress', { tipo: 'extrayendo' }); } catch {}
      const { execSync } = require('child_process');
      execSync('powershell.exe -NoProfile -Command "Expand-Archive -Force \'' + zipBin + '\' \'' + raiz + '\'"', { windowsHide: true, timeout: 120000 });
      await fsPromises.unlink(zipBin).catch(() => {});
      try {
        for (let nivel = 0; nivel < 4; nivel++) {
          const carpetas = fs.readdirSync(raiz).filter((n) => fs.statSync(path.join(raiz, n)).isDirectory());
          if (!carpetas.length) break;
          for (const c of carpetas) {
            if (c === 'piper' && nivel === 0) {
              for (const f of fs.readdirSync(path.join(raiz, c))) {
                const destino = path.join(raiz, f);
                if (fs.existsSync(destino)) continue;
                fs.renameSync(path.join(raiz, c, f), destino);
              }
              try { fs.rmdirSync(path.join(raiz, c)); } catch {}
              break;
            }
          }
          break;
        }
      } catch {}
      await bajar('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx?download=true', path.join(raiz, 'voz-davefx.onnx'), TAM_PIPER_VOZ, 'voz');
      await bajar('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json', path.join(raiz, 'voz-davefx.onnx.json'), 8192, 'config');
      try { if (win && !win.isDestroyed()) win.webContents.send('tts:installProgress', { tipo: 'listo' }); } catch {}
      return { ok: true };
    } catch (err) {
      try { if (win && !win.isDestroyed()) win.webContents.send('tts:installProgress', { tipo: 'error', error: err.message }); } catch {}
      return { ok: false, error: err.message };
    } finally { instalandoPiper = null; }
  })();
  const rp = await instalandoPiper;
  return rp;
});
ipcMain.on('tts:played', (e, id) => {
  if (!voiceManager) return;
  voiceManager.spoken(id);
  /* El fin de la lectura, que es el aviso del que depende que el glow vuelva a su calma
     en el renderer: el manager se queda en «escuchando» cuando vacía su cola de frases.
     Antes lo emitía la salida del proceso de PowerShell de `tts:speak`, que ya no existe
     porque la lectura entera la orquesta el manager. */
  if (voiceManager.estado() === 'escuchando') { try { if (win && !win.isDestroyed()) win.webContents.send('tts:done'); } catch {} }
});
ipcMain.on('tts:stop', () => { if (voiceManager) voiceManager.stopSpeaking(); });
/* «Habla el usuario»: interrumpir deja de tirar la cola (stopSpeaking) pero el contador
   de frases seguía donde estaba. La frase siguiente a la interrupción recibía un id de
   UNA sesión anterior, el renderer la tocaba y al terminar su aviso se descartaba en
   `spoken()` («no es la que suena») y la cola se detenía: se oía la primera frase de la
   respuesta siguiente y el resto de la respuesta enmudecía para siempre. Reiniciar el
   contador arranca la nueva secuencia en 1 de nuevo. */
ipcMain.on('tts:reset', () => {
  /* La interrupción sólo necesita reiniciar el contador de frases; el motor de dictado y
     el de síntesis tienen que seguir vivos. Antes se destría y nacía otro manager: el close
     apagaba el motor de dictado con el micrófono abierto —nadie traducía su audio— y el modo
     voz quedaba sordo hasta cerrarlo y reabrirlo; y el stt nuevo heredaba el idioma de los
     ajustes del momento, no el de la sesión. El manager expone `reiniciar()`: seq vuelve a 0
     y el renderer vuelve a mandar `ttsPlayed` para cada frase nueva (el método devuelve ese
     primer id: nadie más necesita saberlo). */
  if (!voiceManager) return;
  try { voiceManager.reiniciar(); } catch {}
});

// ---- misc ----
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:minimize', () => win && win.minimize());   // minimizado real: sigue en la barra de tareas
ipcMain.handle('app:openExternal', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('app:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('app:openDataDir', async () => {
  try { await fsp.mkdir(CONFIG_DIR, { recursive: true }); } catch {}
  const err = await shell.openPath(CONFIG_DIR);
  return err ? { ok: false, error: err } : { ok: true, path: CONFIG_DIR };
});
ipcMain.handle('shell:openPath', async (e, p) => {
  const { shell } = require('electron');
  const explicit = String(p || '').trim();
  // UNC (\\servidor\recurso) fuera: no es una carpeta local y no debe poder fijar
  // el espacio de trabajo de la app.
  if (/^[\\/]{2}/.test(explicit)) return { ok: false, error: 'Ruta de red no permitida' };
  let target = explicit.replace(/^~(?=\/|\\|$)/, app.getPath('home'));
  if (!target) target = app.getPath('desktop');
  let st;
  try { st = fs.statSync(target); } catch { return { ok: false, error: 'La ruta no existe: ' + target }; }
  if (st.isFile()) {
    target = path.dirname(target);   // un archivo abre su carpeta contenedora
    try { st = fs.statSync(target); } catch { return { ok: false, error: 'La ruta no es una carpeta: ' + target }; }
  }
  if (!st.isDirectory()) return { ok: false, error: 'La ruta no es una carpeta: ' + target };
  const err = await shell.openPath(target);
  if (err) return { ok: false, error: err };
  // Proyectos = espacio de trabajo: abrir una carpeta aquí la convierte en la activa
  // (con campo vacío se abre el Escritorio SIN cambiar el espacio configurado)
  if (explicit) { config.settings.workspace = target; saveConfig(); }
  return { ok: true, path: target, workspace: getWorkspace() };
});
ipcMain.handle('shell:pickFolder', async () => {
  const r = await require('electron').dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? { ok: false } : { ok: true, path: r.filePaths[0] };
});

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

/* ---------- actualizaciones (releases de GitHub) ----------
   Sin dependencias: se consulta la API pública, se descarga el binario de esta
   plataforma y se verifica su sha512 contra el `latest.yml` que publica el CI
   antes de ejecutarlo. El aviso al usuario es discreto: un toast y un punto en
   Ajustes; nada se descarga ni se instala sin que él lo pida. */
let lastUpdate = null;        // último resultado de la comprobación
let updateReady = null;       // binario ya descargado y verificado

/* Una instalación que se intentó y no llegó a cuajar. Como para instalar hay que
   cerrar la app, el intento no puede contarlo nada al usuario en el momento: se
   deja anotado en disco y el siguiente arranque, si la versión sigue siendo la
   vieja, se lo dice con el botón para reintentarlo. Sin esto, un fallo deja al
   usuario en un bucle de «se cierra y no pasa nada» sin saber por qué. */
const UPDATE_PENDING_FILE = path.join(DATA_DIR, 'update-pending.json');
let updatePending = null;

function savePending(p) {
  updatePending = p;
  try { fs.writeFileSync(UPDATE_PENDING_FILE, JSON.stringify(p, null, 2)); } catch {}
}
function clearPending() {
  updatePending = null;
  try { fs.rmSync(UPDATE_PENDING_FILE, { force: true }); } catch {}
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(UPDATE_PENDING_FILE, 'utf8')); } catch { return null; }
}
function pendingInfo() {
  return updatePending
    ? { version: updatePending.version, path: updatePending.path, at: updatePending.at || null, exists: fs.existsSync(updatePending.path), signed: updatePending.signed }
    : null;
}

function sendUpdate(ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('update:event', ev); } catch {}
}

async function checkUpdates({ announce = false } = {}) {
  const r = await updater.checkForUpdate({ currentVersion: app.getVersion(), ...(UPDATE_API ? { api: UPDATE_API } : {}) });
  lastUpdate = r;
  if (r.available) {
    runlog.log({ agent: 'sagitari', event: 'update_available', version: r.latest });
    if (announce) sendUpdate({ type: 'available', version: r.latest, current: r.current, url: r.url });
  } else if (announce) {
    sendUpdate({ type: r.ok ? 'up-to-date' : 'error', version: r.latest, current: r.current, message: r.error || null });
  }
  return r;
}

ipcMain.handle('update:check', async () => {
  const r = await checkUpdates();
  return {
    ok: r.ok,
    error: r.error || null,
    current: r.current || app.getVersion(),
    latest: r.latest || null,
    available: !!r.available,
    url: r.url || `https://github.com/${updater.REPO}/releases`,
    publishedAt: r.publishedAt || null,
    notes: r.notes || null,
    kind: updater.hostKind({ isPackaged: app.isPackaged }),
    ready: updateReady ? { name: updateReady.name, version: updateReady.version, verified: updateReady.verified, signed: updateReady.signed, signer: updateReady.signer } : null,
    pending: pendingInfo(),
  };
});

ipcMain.handle('update:download', async () => {
  const r = (lastUpdate && lastUpdate.available) ? lastUpdate : await checkUpdates();
  if (!r.available) return { ok: false, error: 'no hay ninguna actualización disponible' };
  const kind = updater.hostKind({ isPackaged: app.isPackaged });
  const asset = updater.assetFor(kind, r.assets);
  if (!asset) return { ok: false, error: 'esta release no trae binarios para Windows' };
  const target = updater.downloadTarget({ kind, assetName: asset.name });
  runlog.log({ agent: 'sagitari', event: 'update_download_start', version: r.latest, asset: asset.name });
  try {
    const dl = await updater.downloadTo(asset.url, target.path, { onProgress: (p) => sendUpdate({ type: 'progress', ...p }) });
    // el sha512 publicado manda: si no cuadra, ese archivo no se ejecuta
    let expected = null;
    let errorYml = null;
    if (r.assets && r.assets.yml) {
      try {
        const y = await (await fetch(r.assets.yml.url, { headers: { 'User-Agent': 'SAGITARI-updater' }, signal: AbortSignal.timeout(15000) })).text();
        const parsed = updater.parseLatestYml(y);
        // El hash de nivel superior es el del fichero `path` del yml (el Setup): la
        // edición portable no podía actualizarse nunca porque se comparaba contra
        // el hash del Setup (updater.sha512For documenta la regla).
        expected = updater.sha512For(parsed, asset.name);
      } catch (e) { errorYml = e.message; }
    }
    // Por qué no hay firma con la que comparar. Antes se contaba siempre como «la
    // release no publica latest.yml», que era falso y despistaba cuando el yml
    // existía pero no listaba este binario (le pasó al portable en la 3.2.1).
    const motivo = updater.motivoSinFirma({
      tieneYml: !!(r.assets && r.assets.yml), assetName: asset.name, expected, error: errorYml,
    });
    // Sin hash publicado no hay verificación posible: se descarta igual que si
    // no cuadrara. Antes `expected === null` dejaba `verified` en null y el
    // binario se marcaba como listo para ejecutarse SIN comprobar nada.
    const verified = expected ? expected === dl.sha512 : false;
    if (verified !== true) {
      await fsp.rm(target.path, { force: true }).catch(() => {});
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: r.latest, asset: asset.name, reason: expected ? 'hash' : motivo });
      sendUpdate({ type: 'error', message: expected
        ? 'La descarga no coincide con la firma publicada; se ha descartado.'
        : 'La release no publica la firma sha512 de este archivo; se ha descartado por seguridad.' });
      return { ok: false, error: expected
        ? 'la verificación sha512 falló: el archivo se ha descartado'
        : motivo + ': descartado por seguridad. Puedes instalarlo a mano desde ' + (r.url || 'https://github.com/' + updater.REPO + '/releases') };
    }
    updateReady = { path: target.path, name: asset.name, verified, expected, version: r.latest, kind };
    // firma Authenticode: se consulta para poder decírselo al usuario. El hash
    // demuestra integridad, no autenticidad: si el repo se compromete, el binario
    // y su hash cambian a la vez. Con un binario sin firmar, el usuario debe saberlo.
    try {
      const sig = await updater.signatureOf(target.path);
      if (sig) {
        updateReady.signed = sig.status === 'Valid';
        updateReady.signer = sig.signer;
        runlog.log({ agent: 'sagitari', event: 'update_signature', version: r.latest, status: sig.status, signer: sig.signer });
      }
    } catch {}
    runlog.log({ agent: 'sagitari', event: 'update_downloaded', version: r.latest, verified });
    sendUpdate({ type: 'downloaded', version: r.latest, name: asset.name, verified, signed: updateReady.signed, signer: updateReady.signer });
    return { ok: true, path: target.path, name: asset.name, version: r.latest, verified, signed: updateReady.signed, kind };
  } catch (e) {
    sendUpdate({ type: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
});

/**
 * Lanza el instalador FUERA de la app y la cierra.
 *
 * Antes esto era un `cmd.exe /c "timeout … & start \"\" …"`: esa forma no
 * lanzaba nada (el intérprete de `cmd.exe` y el escapado de Node se comían las
 * comillas; comprobado con un señuelo, que nunca llegaba a ejecutarse), y el
 * usuario veía una ventana de consola aparecer y cerrarse sin más. Ahora el
 * instalador lo arranca un ayudante de PowerShell OCULTO que espera a que no
 * quede ninguna instancia de SAGITARI (por eso también desaparece la ventana de
 * terminal) y luego ejecuta el Setup en silencio. Que la app esté cerrada importa:
 * el instalador de electron-builder mira el proceso PADRE para decidir si hay
 * una app en ejecución, así que lanzado desde la propia app se saltaba esa
 * comprobación y se quedaba a medias con los ficheros en uso.
 */
async function lanzarInstalador(d) {
  const logPath = path.join(path.dirname(d.path), 'instalar.log');
  const comun = {
    name: path.basename(process.execPath, '.exe'),
    installer: d.path,
    // silencio total + «es una actualización, no una instalación nueva» + que la app
    // vuelva a abrirse al terminar (sin esto el usuario ve «se cierra y no pasa nada»
    // justo cuando SÍ ha pasado algo)
    args: '/S --updated --force-run',
    logPath,
  };
  // El diario del intento anterior confundiría la comprobación de abajo.
  try { await fsp.rm(logPath, { force: true }); } catch {}
  // Vía principal (3.3.4): el Programador de tareas ejecuta al ayudante en el
  // servicio del sistema, no como hijo de la app —sobrevive a su cierre por
  // construcción, que es justo lo que el cmd desligado no garantizaba—.
  let via = 'tarea programada';
  try {
    await updater.programarInstalacion({ dir: path.dirname(d.path), ...comun });
  } catch (e) {
    // Plan B: el cmd desligado de siempre. En las máquinas donde el árbol
    // sobrevive funciona (3/3 medido); donde no, el diario con latido dirá
    // hasta dónde llegó. Mejor intentarlo que dejar al usuario sin nada.
    via = 'clásica';
    runlog.log({ agent: 'sagitari', event: 'update_install_fallback', version: d.version, reason: e.message });
    const plan = updater.afterExitCommand(comun);
    let hijo;
    try {
      hijo = spawn(plan.file, plan.args, plan.spawnOpts);
      // desligado y sin referencia: el ayudante tiene que seguir ahí cuando la app ya
      // no esté (es justo lo que fallaba), y a Node no le toca esperarlo
      try { hijo.unref(); } catch {}
    } catch (e2) {
      return { ok: false, error: 'no se pudo preparar el instalador: ' + e2.message };
    }
    hijo.on('error', () => {});
  }
  /* LA comprobación que importa, y ANTES de cerrar la app: se espera a que el
     ASISTENTE escriba su primera línea en el diario.

     No se comprueba «¿sigue vivo el proceso que lancé?», y esa es justo la lección
     de este fallo: el ayudante estaba vivo, escribía su primera línea… y moría con la
     app, dejando el diario cortado para siempre y al usuario con la ventana cerrada y
     nada instalado. «Vivo» no prueba nada; lo que prueba algo es su rastro, y además
     que ese rastro llegue con la app todavía en marcha y el proceso ya desligado.

     El presupuesto es amplio a propósito: PowerShell en frío tarda en arrancar. */
  const arrancado = await new Promise((resolve) => {
    const t0 = Date.now();
    const mirar = async () => {
      try {
        const t = await fsp.readFile(logPath, 'utf8');
        if (t.includes('asistente iniciado')) return resolve(true);
      } catch {}
      if (Date.now() - t0 >= 30000) return resolve(false);
      setTimeout(mirar, 200);
    };
    setTimeout(mirar, 150);
  });
  if (!arrancado) {
    const reason = 'el asistente no llegó a arrancar (vía ' + via + ': sin PowerShell, tarea bloqueada o política del equipo)';
    runlog.log({ agent: 'sagitari', event: 'update_install_failed', version: d.version, reason });
    savePending({ version: d.version, path: d.path, expected: d.expected || null, signed: d.signed === true, at: new Date().toISOString() });
    const pendiente2 = pendingInfo();
    return { ok: false, error: 'no se pudo arrancar el asistente de instalación: ' + reason + '. Puedes instalar a mano: ' + d.path, pending: pendiente2 };
  }
  savePending({ version: d.version, path: d.path, expected: d.expected || null, signed: d.signed === true, at: new Date().toISOString() });
  const pendiente = pendingInfo();
  runlog.log({ agent: 'sagitari', event: 'update_install', version: d.version, log: logPath, via });
  // cierre ordenado (cierra Chrome, procesos de voz, tareas). El ayudante espera
  // a que la app desaparezca de verdad, así que no hace falta adivinar un margen.
  setTimeout(() => { try { app.quit(); } catch {} }, 500);
  return { ok: true, manual: false, pending: pendiente };
}

ipcMain.handle('update:install', async (e, opts) => {
  const d = updateReady;
  if (!d) return { ok: false, error: 'todavía no hay ninguna actualización descargada' };
  if (!fs.existsSync(d.path)) return { ok: false, error: 'el archivo descargado ya no está en su sitio' };
  if (d.kind === 'portable') {
    // un portable no puede reemplazarse a sí mismo mientras se ejecuta:
    // se deja al lado y se le enseña al usuario dónde está
    try { shell.showItemInFolder(d.path); } catch {}
    return { ok: true, manual: true, name: d.name, path: d.path };
  }
  if (d.kind === 'dev') return { ok: false, error: 'estás ejecutando desde el código fuente: instala con el instalador' };
  // Un binario sin verificar no se ejecuta nunca. Y el fichero vive en %TEMP%,
  // que cualquier proceso del usuario puede escribir: se vuelve a comprobar el
  // hash justo antes de lanzarlo para cerrar esa ventana (TOCTOU).
  if (d.verified !== true || !d.expected) return { ok: false, error: 'esta actualización no está verificada; descártala y vuelve a intentarlo' };
  // Puerta de binario sin firmar: el SHA-512 demuestra integridad pero no
  // autenticidad (un repo comprometido sirve binario y hash a la vez), y los
  // binarios actuales no llevan firma Authenticode. No se puede bloquear sin
  // romper las actualizaciones propias, así que se exige consentimiento ACTIVO:
  // la primera llamada vuelve con needsUnsignedConfirm y la instalación solo
  // arranca cuando la UI reintenta con confirmUnsigned. Un aviso pasivo en la
  // tarjeta no basta para ejecutar código arbitrario.
  if (d.signed !== true && !(opts && opts.confirmUnsigned === true)) {
    runlog.log({ agent: 'sagitari', event: 'update_unsigned_gate', version: d.version, signed: d.signed === true });
    return {
      ok: false, needsUnsignedConfirm: true,
      error: d.signed === false
        ? 'esta actualización NO está firmada digitalmente (solo verificada por SHA-512). Pulsa Instalar otra vez si aceptas instalarla igualmente.'
        : 'no se pudo comprobar la firma digital de esta actualización (solo verificada por SHA-512). Pulsa Instalar otra vez si aceptas instalarla igualmente.',
    };
  }
  try {
    if (updater.sha512Of(d.path) !== d.expected) {
      await fsp.rm(d.path, { force: true }).catch(() => {});
      updateReady = null;
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: d.version, reason: 'hash cambiado antes de instalar' });
      sendUpdate({ type: 'error', message: 'El archivo descargado cambió después de verificarlo; se ha borrado.' });
      return { ok: false, error: 'el instalador ya no coincide con la firma: descartado' };
    }
  } catch (e) { return { ok: false, error: 'no se pudo verificar el instalador: ' + e.message }; }
  return lanzarInstalador(d);
});

// Reintento de una instalación que se quedó a medias (el caso «se cierra y no
// pasa nada»): se vuelve a comprobar el hash del fichero que quedó pendiente y
// solo entonces se lanza otra vez.
ipcMain.handle('update:retry', async (e, opts) => {
  const p = updatePending;
  if (!p) return { ok: false, error: 'no hay ninguna instalación pendiente', pending: null };
  if (!fs.existsSync(p.path)) {
    clearPending();
    return { ok: false, error: 'el instalador descargado ya no está en su sitio: vuelve a descargar la actualización', pending: null };
  }
  if (p.expected && updater.sha512Of(p.path) !== p.expected) {
    await fsp.rm(p.path, { force: true }).catch(() => {});
    clearPending();
    runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: p.version, reason: 'hash cambiado antes de reintentar' });
    return { ok: false, error: 'el instalador ya no coincide con la firma publicada: vuelve a descargar la actualización', pending: null };
  }
  // Misma puerta que update:install: lo pendiente de versiones anteriores no
  // trae estado de firma (signed undefined), y eso también exige confirmación.
  if (p.signed !== true && !(opts && opts.confirmUnsigned === true)) {
    runlog.log({ agent: 'sagitari', event: 'update_unsigned_gate', version: p.version, signed: false, retry: true });
    return {
      ok: false, needsUnsignedConfirm: true, pending: pendingInfo(),
      error: 'esta actualización NO está firmada digitalmente (solo verificada por SHA-512). Pulsa Reintentar otra vez si aceptas instalarla igualmente.',
    };
  }
  const r = await lanzarInstalador({ path: p.path, version: p.version, expected: p.expected, signed: p.signed === true, kind: 'nsis', verified: true });
  // el intento pudo volver a quedar a medias; la tarjeta se queda con lo que hay ahora
  return { ...r, pending: r.ok ? r.pending : pendingInfo() };
});

/* Deshacer el turno: vuelve a dejar los archivos como estaban antes de que el agente
   los tocara. La pre-imagen la guarda agent/cambios.js en cada escritura (para revisar el
   cambio), así que aquí solo hay que decidir si se puede y aplicarlo.

   Se niega con el agente trabajando: deshacer mientras hay una escritura en vuelo
   restauraría un archivo que la herramienta está a punto de volver a escribir. */
ipcMain.handle('cambios:deshacer', async () => {
  if (agent && agent.isBusy()) return { ok: false, error: 'SAGITARI está trabajando ahora mismo: detén la tarea antes de deshacer' };
  const ws = getWorkspace();
  if (!cambios.puedeDeshacer(ws)) return { ok: false, error: 'no hay ningún cambio de este turno que deshacer' };
  const plan = cambios.planDeshacer(ws);
  let r;
  try { r = cambios.deshacer(ws); }
  catch (e) { return { ok: false, error: 'no se pudo deshacer: ' + ((e && e.message) || e) } }
  try { repomap.invalidar(ws); } catch {}
  runlog.log({ agent: 'sagitari', event: 'undo_turn', archivos: r.archivos.length, restaurados: r.restaurados, borrados: r.borrados, fallos: r.fallos });
  return { ok: true, ...r, plan: plan.length };
});

/** ¿Hay algo que deshacer ahora mismo? (para que la interfaz no ofrezca un botón inútil) */
ipcMain.handle('cambios:estado', async () => {
  const ws = getWorkspace();
  const plan = cambios.puedeDeshacer(ws) ? cambios.planDeshacer(ws) : [];
  return { ok: true, puede: plan.length > 0, archivos: plan.map(x => x.ruta) };
});

/* Reglas del proyecto (SAGITARI.md / AGENTS.md): la interfaz enseña CUÁLES se están
   leyendo y sus tamaños. Es la respuesta a «¿por qué el agente no hace lo que dice mi
   AGENTS.md?»: porque no hay ninguno, o está en otra carpeta, o se está recortando. */
ipcMain.handle('agent:instrucciones', async () => {
  const ws = getWorkspace();
  try {
    const { fuentes } = instrucciones.leer(ws);
    return { ok: true, workspace: ws, fuentes, candidatos: instrucciones.candidatas(ws).map(c => c.etiqueta) };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), fuentes: [], candidatos: [] } }
});

/** Crea una plantilla de SAGITARI.md en el proyecto (sin pisar nada si ya existe). */
ipcMain.handle('agent:instrucciones-crear', async () => {
  const ws = getWorkspace();
  const destino = path.join(ws, 'SAGITARI.md');
  if (fs.existsSync(destino)) return { ok: true, yaExistia: true, ruta: destino };
  const plantilla = [
    '# Reglas de este proyecto (SAGITARI)',
    '',
    '<!-- SAGITARI lee este archivo SIEMPRE, antes de tocar nada, y también sus subagentes.',
    '     Escribe aquí solo lo que no se deduce del código: convenciones, límites, atajos. -->',
    '',
    '## Cómo se ejecuta esto',
    '- Tests: `npm test`',
    '- Compilar / tipos: `npm run build`',
    '- Lint: `npm run lint`',
    '',
    '## Convenciones',
    '- (idioma de los comentarios, estilo, estructura de carpetas, nombres)',
    '',
    '## No tocar sin permiso',
    '- (carpetas o archivos generados, migraciones, releases)',
    '',
    '## Antes de dar algo por hecho',
    '- (qué hay que ejecutar o comprobar en ESTE proyecto)',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(destino, plantilla, 'utf8');
    runlog.log({ agent: 'sagitari', event: 'instructions_created', ruta: destino });
    return { ok: true, ruta: destino };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
});

ipcMain.handle('update:page', async () => {
  const url = (lastUpdate && lastUpdate.url) || `https://github.com/${updater.REPO}/releases`;
  try { await shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

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
  updatePending = updater.pendingFor(readPending(), app.getVersion());
  if (!updatePending) { try { fs.rmSync(UPDATE_PENDING_FILE, { force: true }); } catch {} }
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
    const k = providerKeyFor(config.active);
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
  if (!HEADLESS || UPDATE_API) setTimeout(() => { checkUpdates({ announce: true }).catch(() => {}); }, 12000);
  // Si la sesión anterior se quedó a medias instalando, el usuario tiene que
  // enterarse (y poder reintentarlo): para instalar se cierra la app, así que
  // este es el único momento en que se le puede contar.
  if (updatePending && (!HEADLESS || UPDATE_API)) setTimeout(() => {
    sendUpdate({ type: 'install-failed', version: updatePending.version, path: updatePending.path, exists: fs.existsSync(updatePending.path) });
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
  saliendo = true;   // el reintento del dictado no debe arrancar nada durante el cierre
  dictando = false;
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  if (taskManager) { try { taskManager.stopAll(); } catch {} }      // tareas en background → interrupted
  if (agent && agent.isBusy()) { try { agent.stop(); } catch {} }   // chat en curso
  if (whisper) { try { whisper.kill(); } catch {} }            // dictado en marcha
  /* Modo voz: cierra también el proceso de escuchar (su PowerShell) y el motor de
     síntesis —la lectura en curso, si la había, se corta ahí y su PowerShell no queda
     huérfano—. `close()` resuelve en microtareas (mata y libera, sin esperar a nadie),
     así que el resto del cierre de abajo sigue corriendo antes de que la app salga. */
  try { if (voiceManager) await voiceManager.close(); } catch {}
  voiceManager = null;
  if (mcp) { try { mcp.shutdown(); } catch {} }                 // servidores MCP: procesos hijos fuera
  try { browser.ws && browser.send('Browser.close'); } catch {} // Chrome/Edge lanzado por CDP
  try { runlog.close(); } catch {}                              // logs de sesión
});
