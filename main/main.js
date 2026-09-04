'use strict';

// SAGITARI — Electron main process
// Chat window + click-through screen-edge glow overlay + agent + voice + settings.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const { Agent } = require('../agent/agent');
const { Browser } = require('../agent/browser');
const { PRESETS, listModels } = require('./providers');
const skills = require('../agent/skills');

const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke');

// single instance: si ya está abierta, enfoca la ventana existente
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// ---------- config ----------
const CONFIG_DIR = path.join(app.getPath('appData'), 'SagitariAI');
const LEGACY_CONFIG = path.join(app.getPath('appData'), 'JarvisAI', 'config.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let config = {
  providers: [],                 // [{id, name, baseUrl, apiKey, models:[], activeModel}]
  active: null,                  // {providerId, name, baseUrl, apiKey, model, temperature, vision}
  settings: { theme: 'violet', ttsEnabled: true, voiceLang: 'es-ES', glowEnabled: true, userName: 'Darío', mode: 'act' }
};
let providersChanged = false;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...raw, settings: { ...config.settings, ...(raw.settings || {}) } };
  } catch {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      config = { ...config, ...legacy, settings: { ...config.settings, ...(legacy.settings || {}) } };
      saveConfig();
    } catch {}
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
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico')
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => win.webContents.send('win:maximized', win.isMaximized()));
  win.on('closed', () => { win = null; });
  // cerrar = cerrar de verdad: X sale de la app completa (antes se ocultaba y
  // quedaban procesos vivos). Alt+Espacio sigue disponible para ocultar/mostrar.
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// El glow vive en el marco de la propia app (renderer), no en un overlay de pantalla.
function glow(mode, color) {
  if (!config.settings.glowEnabled) return;
  if (win && !win.isDestroyed()) win.webContents.send('glow:set', { mode, color: color || config.settings.theme });
}

// ---------- agent wiring ----------
const browser = new Browser();
let agent = null;
let whisper = null;          // child process handle for push-to-talk dictation
let whisperBuf = '';

function wireAgent() {
  agent = new Agent({
    emit: (e) => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', e);
      if (e.type === 'tool') glow('work', 'work');
      if (e.type === 'assistant_done') {
        glow('think');
        const c = currentConv();
        if (c && e.text) {
          c.messages.push({ role: 'assistant', content: e.text, ts: Date.now() });
          c.updatedAt = Date.now();
          saveConvs();
        }
      }
    },
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
  return config.settings;
});

// ---- agent mode (Think / Plan / Act) ----
ipcMain.handle('mode:set', (e, mode) => {
  config.settings.mode = ['think', 'plan', 'act'].includes(mode) ? mode : 'act';
  saveConfig();
  return config.settings.mode;
});

// ---- agents panel data: which tools fired + activity feed ----
ipcMain.handle('agents:live', () => ({
  running: agent ? agent.isBusy() : false,
  mode: config.settings.mode || 'act',
  toolsFired: agent ? agent.getToolsFired() : []
}));

// ---- memory: simple persistent notes the agent can use later ----
let memory = [];
try { memory = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'memory.json'), 'utf8')); } catch {}
function saveMemory() { try { fs.writeFileSync(path.join(CONFIG_DIR, 'memory.json'), JSON.stringify(memory, null, 2)); } catch {} }
ipcMain.handle('memory:list', () => memory);

// ---------- skills ----------
ipcMain.handle('skills:list', () => skills.listSkills());
ipcMain.handle('skills:toggle', async (e, { id, enabled }) => { await skills.setEnabled(id, enabled); return skills.listSkills(); });
ipcMain.handle('skills:import', async (e, repo) => skills.importFromGitHub(String(repo || '')));
ipcMain.handle('skills:create', async (e, data) => skills.createSkill(data || {}));
ipcMain.handle('skills:delete', async (e, id) => skills.deleteSkill(String(id || '')));
ipcMain.handle('skills:read', async (e, id) => { const s = await skills.getSkill(id); return s ? { id: s.id, name: s.name, description: s.description, body: s.body } : null; });
ipcMain.handle('skills:openFolder', async () => { const d = skills.skillsDir(); await fsp.mkdir(d, { recursive: true }); require('electron').shell.openPath(d); });
ipcMain.handle('memory:add', (e, item) => {
  memory.unshift({ id: 'm' + Date.now().toString(36), text: String(item.text || '').slice(0, 500), date: new Date().toISOString() });
  memory = memory.slice(0, 200);
  saveMemory();
  return { ok: true };
});
ipcMain.handle('memory:remove', (e, id) => { memory = memory.filter(m => m.id !== id); saveMemory(); return { ok: true }; });
ipcMain.handle('memory:addText', (e, text) => {
  memory.unshift({ id: 'm' + Date.now().toString(36), text: String(text).slice(0, 500), date: new Date().toISOString() });
  memory = memory.slice(0, 200);
  saveMemory();
  return { ok: true };
});

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
  if (agent) agent.history = [];
  saveConvs();
  return { ok: true, id: c.id };
});
ipcMain.handle('conv:open', (e, id) => {
  const c = convs.find(x => x.id === id);
  if (!c) return { ok: false, error: 'Conversación no encontrada' };
  currentConvId = id;
  if (agent) agent.history = c.messages.map(m => ({ role: m.role, content: m.content }));
  return { ok: true, messages: c.messages };
});
ipcMain.handle('conv:del', (e, id) => {
  convs = convs.filter(c => c.id !== id);
  if (currentConvId === id) { currentConvId = null; if (agent) agent.history = []; }
  saveConvs();
  return { ok: true };
});

ipcMain.handle('chat:send', async (e, { text, imageDataUrl }) => {
  if (!agent) wireAgent();
  const c = ensureConv();
  let body = text || '(análisis de pantalla)';
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
  c.messages.push({ role: 'user', content: body, ts: Date.now() });
  c.updatedAt = Date.now();
  saveConvs();
  glow('think');
  // afterglow: no apagar al instante al terminar el stream; deja respirar el glow
  agent.chat(body, config, imageDataUrl).finally(() => setTimeout(() => glow('off'), 2400));
  return { ok: true };
});

ipcMain.handle('chat:stop', () => { agent && agent.stop(); return { ok: true }; });
ipcMain.handle('chat:clear', () => { agent && (agent.history = []); return { ok: true }; });

ipcMain.on('glow:set', (e, { mode, color }) => glow(mode, color));

// ---- voice (Windows dictation: WinRT engine + SAPI fallback, UTF-8 protocol) ----
ipcMain.handle('voice:start', async () => {
  if (whisper) return { ok: true, note: 'Ya estaba escuchando' };
  whisperBuf = '';
  const lang = config.settings.voiceLang || 'es-ES';
  whisper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice.ps1'), '-Lang', lang], { windowsHide: true });
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
  createChatWindow();

  globalShortcut.register('Alt+Space', () => {
    if (!win) return createChatWindow();
    win.isVisible() ? win.hide() : (win.show(), win.focus());
  });
  globalShortcut.register('Alt+Shift+S', () => { if (win) { win.show(); win.focus(); } });
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
  if (whisper) { try { whisper.kill(); } catch {} }            // dictado en marcha
  try { browser.ws && browser.send('Browser.close'); } catch {} // Chrome/Edge lanzado por CDP
});
