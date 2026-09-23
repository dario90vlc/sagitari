'use strict';

/* ipc-chat.js — router IPC del dominio chat/adjuntos/traza.
 *
 * Octavo router de la fase 4: envío y control del turno (chat:*),
 * lectura de adjuntos (attachments:*) y rastro compacto del turno
 * (tarjetas de herramienta + razonamiento que se guardan con el mensaje).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - getAgent()/ensureAgent(): agente del chat (el segundo lo crea si falta)
 *   - convsApi: { currentConv, saveConvs, ensureConv } del router ipc-convs
 *   - getSkills(): módulo de skills (comando manual /skill)
 *   - getGlow(): efecto de luz glow(mode, color)
 *   - getWin(): ventana de chat (o null si está destruida)
 *   - configDir(): directorio de datos (los adjuntos no pueden salir de ahí)
 *   - onError(kind, err): registra el fallo (crash.log + aviso)
 *   - dialog, fsp, fs, path, attach: módulos ya importados en main
 * El rastro del turno vive en main/traza.js (compartido con agentEmit
 * en main): este router no devuelve nada.
 */

function registerChatIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const ag = () => ctx.getAgent();
  const ensureAgent = () => ctx.ensureAgent();
  const configDir = () => ctx.configDir();
  const convsApi = ctx.convsApi;
  const { getSkills, getGlow: glow, onError, dialog, fsp, fs, path, attach } = ctx;

/* ---- adjuntos del chat: los límites y la extracción de texto viven en
   main/attachments.js (Node puro, con tests propios). Aquí solo se lee el fichero
   y se comprueba que la ruta sea legítima. ---- */

ipcMain.handle('attachments:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Adjuntar a la conversación',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documentos e imágenes', extensions: ['pdf', 'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'vue', 'svelte', 'tex', 'rtf', 'srt', 'vtt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'docx', 'xlsx', 'pptx', 'epub', 'bin', 'exe', 'zip', 'rar', '7z'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths;
  } catch (err) { ctx.onError('attachments:pick', err); return []; }
});

ipcMain.handle('attachments:read', async (e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { ok: false, error: 'ruta inválida' };
    // El drag&drop sí puede leer fuera del selector, pero nunca el directorio de
    // datos de la app (ahí viven las API keys y las conversaciones) ni algo que no
    // sea un archivo regular. realpath resuelve enlaces antes de comprobar.
    let full;
    try { full = await fsp.realpath(filePath); } catch { return { ok: false, error: 'La ruta no existe' }; }
    if (attach.insideDir(full, configDir())) return { ok: false, error: 'ruta no permitida' };
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

/* ---- rastro del turno: lo que el usuario ve en las tarjetas ----
/* El rastro compacto del turno vive en main/traza.js (estado compartido con
   agentEmit en main.js): aquí solo se abre un rastro nuevo por turno. */
const { trazaNueva } = require('./traza');
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
  if (!ag()) ensureAgent();
  const c = convsApi.ensureConv();
  if (ag()) ag().useSession(c.id);   // sesión estable por conversación (OpenCode Go)
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
    const s = await getSkills().getSkill(sm[1]);
    if (s && s.enabled) {
      // inyecta la skill en el contexto del agente (como mensaje de sistema)
      ag().history.push({ role: 'system', content: `SKILL ACTIVADA POR EL USUARIO: ${s.name}\n\n${s.body}` });
      body = (sm[2] || '').trim() || `Aplica la skill ${s.name}.`;
      if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('agent:event', { type: 'status', text: `Skill ${s.name} aplicada` });
    }
  }
  trazaNueva();   // el rastro del turno anterior ya está guardado con su mensaje
  if (c.messages.length === 0) c.title = body.slice(0, 48);
  // el modo queda grabado con la pregunta: en el chat se ve con qué modo se
  // pidió cada cosa (ACT ejecuta, PLAN planifica, THINK razona)
  const sentMode = (cfg().settings && cfg().settings.mode) || 'act';
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
  convsApi.saveConvs();
  glow('think');
  // afterglow: no apagar al instante al terminar el stream; deja respirar el glow
  const firstImage = imgAtts.length ? imgAtts[0].dataUrl : imageDataUrl;
  ag().chat(body, cfg(), firstImage, { attachments: atts })
    .catch((err) => ctx.onError('chat:send', err))   // sin esto el fallo se perdía como promesa flotante
    .finally(() => setTimeout(() => glow('off'), 2400));
  return { ok: true };
});

// regenerar: descarta la última respuesta y vuelve a pedírsela al modelo
ipcMain.handle('chat:retry', async () => {
  if (!ag()) return { ok: false, error: 'sin agente' };
  // regenerar durante un turno en curso lo pisaría: exigimos que esté libre
  if (ag().isBusy()) return { ok: false, error: 'hay un turno en curso; deténlo antes de regenerar' };
  trazaNueva();   // regenerar es un turno nuevo: su rastro se guarda con su respuesta
  const c = convsApi.currentConv();
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
    convsApi.saveConvs();
  }
  return await ag().retry(cfg());
});

ipcMain.handle('chat:stop', () => { ag() && ag().stop(); return { ok: true }; });
ipcMain.handle('chat:pause', () => (ag() ? ag().pause() : { ok: false, error: 'sin agente' }));
ipcMain.handle('chat:clear', () => { ag() && (ag().history = []); return { ok: true }; });

}

module.exports = { registerChatIpc };
