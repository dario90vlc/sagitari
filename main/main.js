'use strict';

// SAGITARI — Electron main process
// Chat window + click-through screen-edge glow overlay + agent + voice + settings.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, dialog, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const { Agent } = require('../agent/agent');
const { DEFAULT_RISK } = require('../agent/guardrails');
const { Browser } = require('../agent/browser');
const { TaskManager } = require('../agent/tasks');
const { PRESETS, listModels } = require('./providers');
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
const CONFIG_DIR = path.join(app.getPath('appData'), 'SagitariAI');
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

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...raw, settings: { ...config.settings, ...(raw.settings || {}) } };
    config.security = {
      permissions: { ...(raw.security && raw.security.permissions || {}) },
      guardrails: { ...securityDefaults.guardrails, ...(raw.security && raw.security.guardrails || {}) },
    };
  } catch {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      config = { ...config, ...legacy, settings: { ...config.settings, ...(legacy.settings || {}) } };
      config.security = { permissions: {}, guardrails: { ...securityDefaults.guardrails } };
      saveConfig();
    } catch {
      config.security = { permissions: {}, guardrails: { ...securityDefaults.guardrails } };
    }
  }
}
function saveConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) { console.error('saveConfig', e.message); }
}

// ---------- windows ----------
let win = null;        // chat
let closing = false;

function createChatWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = Math.min(1560, width - 88);
  const H = Math.min(920, height - 88);
  win = new BrowserWindow({
    width: W,
    height: H,
    // mínimo por debajo del cual la ventana no se reduce: el diseño se mantiene
    // intacto hasta este límite (ver media queries en styles.css)
    minWidth: 1000,
    minHeight: 620,
    x: Math.round((width - W) / 2),
    y: Math.round((height - H) / 2),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    },
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'),
    show: !HEADLESS
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => win.webContents.send('win:maximized', win.isMaximized()));
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
      { label: 'Salir', click: () => { closing = true; app.quit(); } },
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
    const st = await fsp.stat(filePath);
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: `Supera ${Math.round(MAX_FILE_BYTES / 1048576)} MB` };
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const kind = IMG_EXTS.has(ext) ? 'image'
      : (TEXT_EXTS.has(ext) || st.size < 512 * 1024 && !BINARY_EXTS.has(ext)) ? 'text' : 'binary';
    if (kind === 'image') {
      const buf = await fsp.readFile(filePath);
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`;
      return { ok: true, att: { name, kind, size: st.size, dataUrl: `data:${mime};base64,${buf.toString('base64')}` } };
    }
    if (kind === 'text') {
      const buf = await fsp.readFile(filePath);
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

ipcMain.handle('provider:save', (e, p) => {
  const idx = config.providers.findIndex(x => x.id === p.id);
  if (idx >= 0) config.providers[idx] = { ...config.providers[idx], ...p };
  else config.providers.push(p);
  saveConfig();
  return { ok: true };
});

ipcMain.handle('provider:delete', (e, id) => {
  config.providers = config.providers.filter(x => x.id !== id);
  if (config.active && config.active.providerId === id) config.active = null;
  saveConfig();
  return { ok: true };
});

ipcMain.handle('provider:models', async (e, { baseUrl, apiKey }) => {
  try { return { ok: true, models: await listModels(baseUrl, apiKey) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('provider:activate', (e, cfg) => {
  config.active = cfg;
  saveConfig();
  return { ok: true };
});

ipcMain.handle('settings:set', (e, patch) => {
  config.settings = { ...config.settings, ...patch };
  saveConfig();
  if ('glowEnabled' in patch && !patch.glowEnabled) glow('off');
  // si cambió la apariencia, el renderer repinta el tema; si el glow está
  // activo, relanzamos el estado actual para que el nuevo color se vea al momento
  if ('uiColor' in patch || 'glowColor' in patch || 'glowStrength' in patch) {
    try { if (win && !win.isDestroyed()) win.webContents.send('theme:changed', { uiColor: config.settings.uiColor, glowColor: config.settings.glowColor, glowStrength: config.settings.glowStrength }); } catch {}
    if (config.settings.glowEnabled && !HEADLESS) glow('pulse');
  }
  return config.settings;
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
ipcMain.handle('memory:addText', (e, text) => memory.add({ text, source: 'user', importance: 0.5 }));
ipcMain.handle('memory:update', (e, { id, patch }) => memory.update(String(id), patch || {}));
ipcMain.handle('memory:remove', (e, id) => memory.remove(String(id)));

// ---- conversations: separate chats, persisted, restorable ----
const CONV_FILE = path.join(CONFIG_DIR, 'conversations.json');
let convs = [];
let currentConvId = null;
try { convs = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); } catch {}
function saveConvs() {
  try {
    convs = convs.slice(0, 60);
    fs.writeFileSync(CONV_FILE, JSON.stringify(convs));
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
  agent.chat(body, config, firstImage, { attachments: atts }).finally(() => setTimeout(() => glow('off'), 2400));
  return { ok: true };
});

// regenerar: descarta la última respuesta y vuelve a pedírsela al modelo
ipcMain.handle('chat:retry', async () => {
  if (!agent) return { ok: false, error: 'sin agente' };
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
ipcMain.handle('tasks:remove', (e, runId) => checkpoints.remove(String(runId || '')));

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
  return { ok: true };
});
ipcMain.handle('sec:setToolPerm', (e, { tool, level }) => {
  if (!config.security) config.security = { permissions: {}, guardrails: securityDefaults.guardrails };
  if (level === 'default') delete config.security.permissions[tool];
  else config.security.permissions[tool] = String(level);
  if (agent) agent.setPolicy(config.security);
  saveConfig();
  return { ok: true, permissions: config.security.permissions };
});
ipcMain.handle('sec:setGuardrail', (e, patch) => {
  if (!config.security) config.security = { permissions: {}, guardrails: securityDefaults.guardrails };
  const g = config.security.guardrails;
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in g) g[k] = Math.max(0, Number(v) || 0);   // 0 = sin límite
  }
  if (agent) agent.setPolicy(config.security);
  saveConfig();
  return { ok: true, guardrails: g };
});
ipcMain.handle('meta:get', () => {
  const g = (config.security && config.security.guardrails) || {};
  return {
    model: (config.active && config.active.model) || null,
    guardrails: g,
    permissions: (config.security && config.security.permissions) || {},
    riskDefaults: DEFAULT_RISK,          // nivel de riesgo recomendado por herramienta
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
  whisper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice.ps1'), '-Lang', lang, '-Nowinrt'], { windowsHide: true });
  whisper.stdout.on('data', (d) => {
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
        try { whisper.kill(); } catch {}
        whisper = null;
      }
      else if (line.startsWith('ERROR::')) {
        if (win && !win.isDestroyed()) win.webContents.send('voice:error', line.slice(7));
        try { whisper.kill(); } catch {}
        whisper = null;
      }
    }
  });
  whisper.stderr.on('data', () => {});
  whisper.on('exit', () => { whisper = null; if (win && !win.isDestroyed()) win.webContents.send('voice:stopped'); });
  return { ok: true };
});

ipcMain.handle('voice:stop', async () => {
  if (whisper) { try { whisper.kill(); } catch {} whisper = null; }
  return { ok: true };
});

// ---- TTS (SAPI, Spanish voice if available) ----
let ttsProc = null;
ipcMain.handle('tts:speak', (e, text) => {
  if (!config.settings.ttsEnabled || !text) return { ok: false };
  try {
    if (ttsProc) try { ttsProc.kill(); } catch {}
    const ps = `
Add-Type -AssemblyName System.Speech
$v = (New-Object System.Speech.Synthesis.SpeechSynthesizer)
$es = $v.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es*' } | Select-Object -First 1
if ($es) { $v.SelectVoice($es.VoiceInfo.Name) }
$v.Rate = 0
$v.Speak([Console]::In.ReadToEnd())`;
    ttsProc = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    ttsProc.stdin.write(String(text).slice(0, 1500));
    ttsProc.stdin.end();
    ttsProc.on('error', () => {});
    // al terminar de hablar (o al cortarlo con otra lectura), avisamos al
    // renderer para que el glow de 'speaking' vuelva a su calma
    ttsProc.once('exit', () => { try { if (win && !win.isDestroyed()) win.webContents.send('tts:done'); } catch {} });
    return { ok: true };
  } catch { return { ok: false }; }
});

// ---- misc ----
ipcMain.handle('app:quit', () => { closing = true; app.quit(); });
ipcMain.handle('app:minimize', () => win && win.minimize());   // minimizado real: sigue en la barra de tareas
ipcMain.handle('app:openExternal', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('app:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:openDataDir', async () => {
  try { await fsp.mkdir(CONFIG_DIR, { recursive: true }); } catch {}
  const err = await shell.openPath(CONFIG_DIR);
  return err ? { ok: false, error: err } : { ok: true, path: CONFIG_DIR };
});
ipcMain.handle('shell:openPath', async (e, p) => {
  const { shell } = require('electron');
  const explicit = String(p || '').trim();
  let target = explicit.replace(/^~(?=\/|\\|$)/, app.getPath('home'));
  if (!target) target = app.getPath('desktop');
  try {
    const st = fs.statSync(target);
    if (st.isFile()) target = path.dirname(target);
  } catch {
    return { ok: false, error: 'La ruta no existe: ' + target };
  }
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

app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.platform === 'win32') {
    const ico = path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico');
    try { app.setAppUserModelId('com.sagitari.app'); if (fs.existsSync(ico)) app.setAppUserModelId('SAGITARI'); } catch {}
  }
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
  closing = true;
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  if (taskManager) { try { taskManager.stopAll(); } catch {} }      // tareas en background → interrupted
  if (agent && agent.isBusy()) { try { agent.stop(); } catch {} }   // chat en curso
  if (whisper) { try { whisper.kill(); } catch {} }            // dictado en marcha
  try { browser.ws && browser.send('Browser.close'); } catch {} // Chrome/Edge lanzado por CDP
  try { runlog.close(); } catch {}                              // logs de sesión
});
