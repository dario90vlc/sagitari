'use strict';

// SAGITARI — Electron main process
// Chat window + click-through screen-edge glow overlay + agent + voice + settings.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, dialog, Tray, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

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

const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke');
// Las comprobaciones automáticas (smoke, ui-check) abren la app SIN mostrar
// ventana: hasta ahora la ventana se abría y se cerraba sola dos veces durante
// probar.bat, y eso se ve exactamente igual que «la app se cierra sola».
const HEADLESS = SMOKE || process.argv.includes('--hidden') || process.argv.includes('--test');
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
// Los arranques de prueba escriben en SU PROPIO directorio de datos: ui-check
// navega la interfaz de verdad y acaba guardando ajustes y conversaciones, y no
// puede tocar las claves, las conversaciones ni la memoria reales del usuario.
const CONFIG_DIR = path.join(app.getPath('appData'), HEADLESS ? 'SagitariAI-test' : 'SagitariAI');
const LEGACY_CONFIG = path.join(app.getPath('appData'), 'JarvisAI', 'config.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let config = {
  providers: [],                 // [{id, name, baseUrl, apiKey, models:[], activeModel}]
  active: null,                  // {providerId, name, baseUrl, apiKey, model, temperature, vision}
  settings: { theme: 'violet', uiColor: 'violet', glowColor: 'match', glowStrength: 1, ttsEnabled: true, voiceLang: 'es-ES', glowEnabled: true, userName: 'Darío', mode: 'act', maxConcurrentTasks: 1, autoResumeTasks: true }
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
    loopThreshold: 3,            // llamadas idénticas seguidas antes de parar
    stallThreshold: 6,           // pasos sin progreso antes de parar (0 = sin límite)
  },
};
let providersChanged = false;

function applyConfig(raw) {
  config = { ...config, ...raw, settings: { ...config.settings, ...(raw.settings || {}) } };
  config.security = {
    permissions: { ...(raw.security && raw.security.permissions || {}) },
    guardrails: { ...securityDefaults.guardrails, ...(raw.security && raw.security.guardrails || {}) },
  };
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
    writeJsonAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
    return { ok: true };
  } catch (e) {
    console.error('saveConfig', e.message);
    return { ok: false, error: e.message };
  }
}

/* Persiste y, si falla, avisa al usuario: los controles de Ajustes ya han
   confirmado el cambio en pantalla, así que un console.error silencioso deja al
   usuario creyendo que se guardó algo que se perderá al reiniciar. */
function persistConfig() {
  const r = saveConfig();
  if (!r.ok) {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', { type: 'toast', title: 'No se pudo guardar', message: 'La configuración no se pudo escribir en disco (' + r.error + ').' });
      }
    } catch {}
  }
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
    show: !HEADLESS
  });
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

/* ---- adjuntos del chat: límites y extracción de texto ----
   El texto se extrae en el proceso principal y viaja como texto del mensaje:
   así cualquier modelo lo ve, incluso los que no aceptan archivos. */
const MAX_ATTACH_CHARS = 120000;   // ~30k tokens: margen sobrado, techo real
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml', '.ini', '.cfg', '.env', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.cs', '.php', '.sh', '.bat', '.ps1', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.tex', '.rtf', '.srt', '.vtt']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/* Extensiones claramente binarias: ni intentamos leerlas como texto. Ojo: si
   se anuncia texto y luego sale binario, se degrada a 'binary' con aviso. */
const BINARY_EXTS = new Set(['.exe', '.dll', '.zip', '.rar', '.7z', '.gz', '.tar', '.bin', '.dat', '.db', '.sqlite', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub', '.iso', '.img', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.psd', '.ai']);

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
    const rel = path.relative(CONFIG_DIR, full);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { ok: false, error: 'ruta no permitida' };
    const st = await fsp.stat(full);
    if (!st.isFile()) return { ok: false, error: 'no es un archivo regular' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: `Supera ${Math.round(MAX_FILE_BYTES / 1048576)} MB` };
    const name = path.basename(full);
    const ext = path.extname(full).toLowerCase();
    const kind = IMG_EXTS.has(ext) ? 'image'
      : (TEXT_EXTS.has(ext) || st.size < 512 * 1024 && !BINARY_EXTS.has(ext)) ? 'text' : 'binary';
    if (kind === 'image') {
      const buf = await fsp.readFile(full);
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`;
      return { ok: true, att: { name, kind, size: st.size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` } };
    }
    if (kind === 'text') {
      const buf = await fsp.readFile(full);
      let text = buf.toString('utf8').replace(/\u0000/g, '').trim();
      if (ext === '.srt' || ext === '.vtt') text = text.replace(/^\d+\s*$/gm, '').replace(/-->\s*/g, ' → ');   // subtítulos: solo texto útil
      const printable = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');
      if (printable.length < Math.max(40, text.length * 0.55)) return { ok: true, att: { name, kind: 'binary', size: st.size, note: 'parece binario' } };
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

function agentEmit(e, isBackground) {
  // v1.3: los eventos de tareas en background se marcan para que el renderer NO
  // los mezcle con el chat interactivo (burbujas, estado busy, etc.).
  const out = isBackground ? { ...e, bg: true } : e;
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', out);
  if (e.type === 'tool') glow('work', 'work');
  // solo el chat interactivo escribe en la conversación actual
  if (!isBackground && e.type === 'assistant_done') {
    glow('think');
    const c = currentConv();
    if (c && e.text) {
      c.messages.push({ role: 'assistant', content: e.text, ts: Date.now() });
      c.updatedAt = Date.now();
      saveConvs();
    }
  }
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
    browser
  });
}

function wireAgent() { agent = createAgent(false); }

// ---- v1.3: TaskManager — cola de tareas en background con notificaciones ----
function wireTaskManager() {
  if (taskManager) return taskManager;
  taskManager = new TaskManager({
    getSettings: () => config,
    agentFactory: () => createAgent(true),
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
  try { return { ok: true, models: await listModels(baseUrl, apiKey) }; }
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
  config.active = { ...cfg, providerId: cfg.providerId || cfg.id || (prov && prov.id) || null };
  return persistConfig();
});

ipcMain.handle('settings:set', (e, patch) => {
  const clean = { ...(patch || {}) };
  // El idioma del dictado llega a voice.ps1 como argumento y allí se usa como
  // comodín (`-like ($Lang + '*')`), así que un `*`/`?` seleccionaría el
  // reconocedor equivocado. Solo se acepta la forma xx-XX; lo demás se ignora.
  if ('voiceLang' in clean && !/^[a-z]{2}-[A-Z]{2}$/.test(String(clean.voiceLang || ''))) delete clean.voiceLang;
  config.settings = { ...config.settings, ...clean };
  const saved = persistConfig();
  if ('glowEnabled' in clean && !clean.glowEnabled) glow('off');
  // si cambió la apariencia, el renderer repinta el tema; si el glow está
  // activo, relanzamos el estado actual para que el nuevo color se vea al momento
  if ('uiColor' in clean || 'glowColor' in clean || 'glowStrength' in clean) {
    try { if (win && !win.isDestroyed()) win.webContents.send('theme:changed', { uiColor: config.settings.uiColor, glowColor: config.settings.glowColor, glowStrength: config.settings.glowStrength }); } catch {}
    if (config.settings.glowEnabled && !HEADLESS) glow('pulse');
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
ipcMain.handle('memory:list', () => memory.list());

// ---------- skills ----------
ipcMain.handle('skills:list', () => skills.listSkills());
ipcMain.handle('skills:toggle', async (e, { id, enabled }) => { await skills.setEnabled(id, enabled); return skills.listSkills(); });
ipcMain.handle('skills:import', async (e, repo) => skills.importFromGitHub(String(repo || '')));
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
    const out = convs.length > MAX_CONVS ? convs.slice(0, MAX_CONVS) : convs;
    writeJsonAtomic(CONV_FILE, JSON.stringify(out));
  } catch (err) { console.error('saveConvs', err.message); }
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
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    if (!fs.statSync(p).isDirectory()) return { ok: false, error: 'La ruta no es una carpeta' };
    config.settings.workspace = p; saveConfig();
    return { ok: true, path: p };
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
    const blocks = txtAtts.map(a => `--- ARCHIVO ADJUNTO: ${a.name} (${a.size ? Math.round(a.size / 1024) + ' KB' : 'n/a'}) ---\n${(a.text || '').slice(0, MAX_ATTACH_CHARS)}${(a.text || '').length > MAX_ATTACH_CHARS ? '\n… (truncado)' : ''}`).join('\n\n');
    body = (body ? body + '\n\n' : '') + 'He adjuntado archivos para que los uses en tu respuesta:\n\n' + blocks;
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
  if (c.messages.length === 0) c.title = body.slice(0, 48);
  // el modo queda grabado con la pregunta: en el chat se ve con qué modo se
  // pidió cada cosa (ACT ejecuta, PLAN planifica, THINK razona)
  const sentMode = (config.settings && config.settings.mode) || 'act';
  // en la conversación guardamos los metadatos de los adjuntos (no el texto
  // completo: las conversaciones pueden ser grandes y se leen en cada arranque)
  const attMeta = atts.map(a => ({ name: a.name, kind: a.kind || (a.dataUrl ? 'image' : 'text'), size: a.size || 0, dataUrl: a.kind === 'image' ? a.dataUrl : undefined }));
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
  const c = currentConv();
  // quita la última respuesta del historial guardado (y solo esa)
  if (c && c.messages.length) {
    for (let i = c.messages.length - 1; i >= 0; i--) {
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

ipcMain.on('glow:set', (e, { mode, color }) => glow(mode, color));

// ---- voice (Windows dictation: WinRT engine + SAPI fallback, UTF-8 protocol) ----
ipcMain.handle('voice:start', async () => {
  if (whisper) return { ok: true, note: 'Ya estaba escuchando' };
  whisperBuf = '';
  const lang = config.settings.voiceLang || 'es-ES';
  // El handle del proceso vive en `p`: cada listener comprueba identidad antes de
  // tocar `whisper`, para que el 'exit' tardío de un proceso viejo no anule la
  // referencia al nuevo.
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice.ps1'), '-Lang', lang, '-NoWinrt'], { windowsHide: true });
  whisper = p;
  p.stdout.on('data', (d) => {
    if (whisper !== p) return;   // proceso ya reemplazado: su salida no interesa
    whisperBuf += d.toString('utf8');
    let idx;
    while ((idx = whisperBuf.indexOf('\n')) >= 0) {
      const line = whisperBuf.slice(0, idx).replace(/\r$/, '').trim(); whisperBuf = whisperBuf.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith('PART::') && win && !win.isDestroyed()) win.webContents.send('voice:partial', line.slice(6));
      else if (line.startsWith('FINAL::') && win && !win.isDestroyed()) win.webContents.send('voice:final', line.slice(6));
      else if (line.startsWith('MODE::') && win && !win.isDestroyed()) win.webContents.send('voice:mode', line.slice(5));
      else if (line.startsWith('HINT::') && win && !win.isDestroyed()) win.webContents.send('voice:hint', line.slice(6));
      else if (line.startsWith('READY::') && win && !win.isDestroyed()) win.webContents.send('voice:ready', line.slice(6));
      else if (line.startsWith('STOPPED::')) {
        try { p.kill(); } catch {}
        if (whisper === p) whisper = null;
      }
      else if (line.startsWith('ERROR::')) {
        if (win && !win.isDestroyed()) win.webContents.send('voice:error', line.slice(7));
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
  });
  return { ok: true };
});

ipcMain.handle('voice:stop', async () => {
  const p = whisper;
  if (p) { whisper = null; try { p.kill(); } catch {} }
  return { ok: true };
});

// ---- TTS (SAPI, Spanish voice if available) ----
let ttsProc = null;
ipcMain.handle('tts:speak', (e, text) => {
  if (!config.settings.ttsEnabled || !text) return { ok: false };
  try {
    if (ttsProc) { try { ttsProc.kill(); } catch {} ttsProc = null; }
    const ps = `
Add-Type -AssemblyName System.Speech
$v = (New-Object System.Speech.Synthesis.SpeechSynthesizer)
$es = $v.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es*' } | Select-Object -First 1
if ($es) { $v.SelectVoice($es.VoiceInfo.Name) }
$v.Rate = 0
$v.Speak([Console]::In.ReadToEnd())`;
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    ttsProc = p;
    // Red de seguridad: una síntesis colgada no puede dejar el proceso vivo (y el
    // glow encendido) para siempre; el 'exit' siempre limpia el temporizador.
    const killTimer = setTimeout(() => { try { p.kill(); } catch {} }, 60000);
    p.stdin.write(String(text).slice(0, 1500));
    p.stdin.end();
    p.on('error', (err) => { console.error('tts:speak', err.message); });
    // al terminar de hablar (o al cortarlo con otra lectura), avisamos al
    // renderer para que el glow de 'speaking' vuelva a su calma
    p.once('exit', () => {
      clearTimeout(killTimer);
      if (ttsProc !== p) return;   // ya lo reemplazó otra lectura: avisará ella
      ttsProc = null;
      try { if (win && !win.isDestroyed()) win.webContents.send('tts:done'); } catch {}
    });
    return { ok: true };
  } catch { return { ok: false }; }
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
    ready: updateReady ? { name: updateReady.name, version: updateReady.version, verified: updateReady.verified } : null,
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
    if (r.assets && r.assets.yml) {
      try {
        const y = await (await fetch(r.assets.yml.url, { headers: { 'User-Agent': 'SAGITARI-updater' } })).text();
        const parsed = updater.parseLatestYml(y);
        expected = (parsed.files.find(f => f.url === asset.name) || {}).sha512 || parsed.sha512 || null;
      } catch {}
    }
    // Sin hash publicado no hay verificación posible: se descarta igual que si
    // no cuadrara. Antes `expected === null` dejaba `verified` en null y el
    // binario se marcaba como listo para ejecutarse SIN comprobar nada.
    const verified = expected ? expected === dl.sha512 : false;
    if (verified !== true) {
      await fsp.rm(target.path, { force: true }).catch(() => {});
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: r.latest, reason: expected ? 'hash' : 'sin hash publicado' });
      sendUpdate({ type: 'error', message: expected
        ? 'La descarga no coincide con la firma publicada; se ha descartado.'
        : 'La release no publica la firma sha512 del binario; se ha descartado por seguridad.' });
      return { ok: false, error: expected
        ? 'la verificación sha512 falló: el archivo se ha descartado'
        : 'no se pudo verificar la descarga (la release no publica latest.yml): descartada' };
    }
    updateReady = { path: target.path, name: asset.name, verified, expected, version: r.latest, kind };
    runlog.log({ agent: 'sagitari', event: 'update_downloaded', version: r.latest, verified });
    sendUpdate({ type: 'downloaded', version: r.latest, name: asset.name, verified });
    return { ok: true, path: target.path, name: asset.name, version: r.latest, verified, kind };
  } catch (e) {
    sendUpdate({ type: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:install', async () => {
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
  try {
    if (updater.sha512Of(d.path) !== d.expected) {
      await fsp.rm(d.path, { force: true }).catch(() => {});
      updateReady = null;
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: d.version, reason: 'hash cambiado antes de instalar' });
      sendUpdate({ type: 'error', message: 'El archivo descargado cambió después de verificarlo; se ha borrado.' });
      return { ok: false, error: 'el instalador ya no coincide con la firma: descartado' };
    }
  } catch (e) { return { ok: false, error: 'no se pudo verificar el instalador: ' + e.message }; }
  try {
    // el instalador no debe arrancar con la app aún viva: se lanza con dos
    // segundos de margen y la app se cierra para que pueda reemplazar archivos.
    // La ruta va por entorno, no interpolada en la línea de comandos: así ni un
    // `&`/`%`/`^` en el nombre de usuario de %TEMP% puede alterar el comando.
    spawn('cmd.exe', ['/d', '/c', 'timeout /t 2 /nobreak >nul & start "" "%SAGITARI_UPDATE%" /S'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, SAGITARI_UPDATE: d.path },
    }).unref();
  } catch (e) { return { ok: false, error: e.message }; }
  runlog.log({ agent: 'sagitari', event: 'update_install', version: d.version });
  // cierre ordenado (cierra Chrome, procesos de voz, tareas) y con margen de 2 s
  // para que el instalador no encuentre archivos en uso
  setTimeout(() => { try { app.quit(); } catch {} }, 500);
  return { ok: true, manual: false };
});

ipcMain.handle('update:page', async () => {
  const url = (lastUpdate && lastUpdate.url) || `https://github.com/${updater.REPO}/releases`;
  try { await shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(() => {
  if (!gotLock) return;
  loadConfig();
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
  createChatWindow();
  createTray();

  // comprobación silenciosa 12 s después de arrancar: si hay versión nueva, el
  // renderer muestra un aviso discreto y el botón queda en Ajustes. Nunca
  // interrumpe ni descarga nada por su cuenta (y no corre en los modos de prueba).
  if (!HEADLESS || UPDATE_API) setTimeout(() => { checkUpdates({ announce: true }).catch(() => {}); }, 12000);

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
      app.exit(0);
    }, 2500);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  if (taskManager) { try { taskManager.stopAll(); } catch {} }      // tareas en background → interrupted
  if (agent && agent.isBusy()) { try { agent.stop(); } catch {} }   // chat en curso
  if (whisper) { try { whisper.kill(); } catch {} }            // dictado en marcha
  if (ttsProc) { try { ttsProc.kill(); } catch {} ttsProc = null; }  // voz en curso: si no, quedaba huérfana
  try { browser.ws && browser.send('Browser.close'); } catch {} // Chrome/Edge lanzado por CDP
  try { runlog.close(); } catch {}                              // logs de sesión
});
