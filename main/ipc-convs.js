'use strict';

/* ipc-convs.js — router IPC del dominio conversaciones/workspace.
 *
 * Séptimo router de la fase 4: historial de conversaciones persistido
 * (conv:*), espacio de trabajo validado (workspace:*) y carga desde disco
 * con recuperación desde .bak. Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - saveConfig(): persiste la configuración
 *   - configDir(): directorio de datos (el workspace no puede estar dentro)
 *   - writeJsonAtomic(file, data): escritura atómica con .bak
 *   - onSaveError(msg): avisa al usuario si el historial no se pudo guardar
 *   - getWin(): ventana de chat (para el diálogo de carpeta)
 *   - getAgent(): agente del chat vivo o null (historial/sesión por conversación)
 *   - dialog, app, fs, path: módulos ya importados en main
 * Devuelve { currentConv, saveConvs, ensureConv, getWorkspace }: los usan
 * agentEmit (guardar respuestas) y los handlers de chat.
 */

function registerConvsIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const ag = () => ctx.getAgent();
  const configDir = () => ctx.configDir();
  const { saveConfig, writeJsonAtomic, dialog, app, fs, path } = ctx;
  const CONV_FILE = path.join(configDir(), 'conversations.json');

// ---- conversations: separate chats, persisted, restorable ----
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
    ctx.onSaveError('La conversación no se pudo escribir en disco (' + err.message + '). Los mensajes nuevos pueden perderse al cerrar la app.');
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
const getWorkspace = () => cfg().settings.workspace || DEFAULT_WORKSPACE;
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
    if (inDir(real.toLowerCase(), configDir().toLowerCase())) return { ok: false, error: 'El directorio de datos de la app no puede ser el espacio de trabajo' };
    if (!fs.existsSync(real)) fs.mkdirSync(real, { recursive: true });
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'La ruta no es una carpeta' };
    cfg().settings.workspace = real; saveConfig();
    return { ok: true, path: real };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  // Misma validación que workspace:set: el diálogo devuelve cualquier carpeta y
  // antes se asignaba sin comprobar (C:\Windows o el CONFIG_DIR colaban).
  const p = String(r.filePaths[0] || '').trim();
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
    if (inDir(real.toLowerCase(), configDir().toLowerCase())) return { ok: false, error: 'El directorio de datos de la app no puede ser el espacio de trabajo' };
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'La ruta no es una carpeta' };
    cfg().settings.workspace = real; saveConfig();
    return { ok: true, path: real };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('conv:new', () => {
  const c = { id: 'c' + Date.now().toString(36), title: 'Nueva conversación', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  convs.unshift(c);
  currentConvId = c.id;
  if (ag()) { ag().history = []; ag().useSession(c.id); }
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
  if (ag()) { ag().history = c.messages.map(m => ({ role: m.role, content: m.content })); ag().useSession(c.id); }
  return { ok: true, messages: c.messages };
});
ipcMain.handle('conv:del', (e, id) => {
  convs = convs.filter(c => c.id !== id);
  if (currentConvId === id) { currentConvId = null; if (ag()) ag().history = []; }
  saveConvs();
  return { ok: true };
});

  return { currentConv, saveConvs, ensureConv, getWorkspace };
}

module.exports = { registerConvsIpc };
