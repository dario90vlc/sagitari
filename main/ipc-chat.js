'use strict';

/* ipc-chat.js — router IPC del dominio chat/adjuntos/traza.
 *
 * Octavo router de la fase 4: envío y control del turno (chat:*),
 * lectura de adjuntos (attachments:*) y rastro compacto del turno
 * (tarjetas de herramienta + razonamiento que se guardan con el mensaje).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - runtimes: registro de agentes vivos por conversación (main/runtimes.js). Cada
 *     handler resuelve el agente de LA conversación que manda el renderer: dos
 *     conversaciones pueden tener un turno en vuelo a la vez.
 *   - convsApi: { currentConv, convById, saveConvs, ensureConv } del router ipc-convs
 *   - getSkills(): módulo de skills (comando manual /skill)
 *   - getGlow(): efecto de luz glow(mode, color)
 *   - getWin(): ventana de chat (o null si está destruida)
 *   - configDir(): directorio de datos (los adjuntos no pueden salir de ahí)
 *   - onError(kind, err): registra el fallo (crash.log + aviso)
 *   - dialog, fsp, fs, path, attach: módulos ya importados en main
 * El rastro del turno vive en main/traza.js (compartido con agentEmit
 * en main): este router no devuelve nada.
 */

/* Tamaño al que reducir una imagen para guardarla como miniatura, o `null` si ya cabe.
   Se mide el LADO MAYOR y los bytes: una captura de 320×20000 px pasa el ancho pero no es
   «pequeña», y guardarla entera metía la imagen completa en conversations.json (que se
   reescribe en cada turno y se relee al arrancar). */
const MAX_MINIATURA_ANCHO = 320;
const MAX_MINIATURA_ALTO = 480;
const MAX_MINIATURA_BYTES = 120 * 1024;
function tamanoMiniatura(size, bytes) {
  const w = Number(size && size.width) || 0;
  const h = Number(size && size.height) || 0;
  if (!w || !h) return null;
  if (w <= MAX_MINIATURA_ANCHO && h <= MAX_MINIATURA_ALTO && Number(bytes) <= MAX_MINIATURA_BYTES) return null;
  const escala = Math.min(MAX_MINIATURA_ANCHO / w, MAX_MINIATURA_ALTO / h, 1);
  return { width: Math.max(1, Math.round(w * escala)), height: Math.max(1, Math.round(h * escala)) };
}

function registerChatIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const runtimes = ctx.runtimes;
  const configDir = () => ctx.configDir();
  const convsApi = ctx.convsApi;
  const { getSkills, getGlow: glow, dialog, fsp, path, attach, memory } = ctx;

  /* La conversación que pide el renderer manda. Si no llega el id (una llamada suelta,
     o antes de que haya ninguna conversación en pantalla) se usa la que está abierta,
     que es lo que hacía este router cuando solo había una. */
  const convDe = (id) => (id ? convsApi.convById(id) : convsApi.currentConv());

  /* ---- adjuntos del chat: los límites y la extracción de texto viven en
   main/attachments.js (Node puro, con tests propios). Aquí solo se lee el fichero
   y se comprueba que la ruta sea legítima. ---- */

  ipcMain.handle('attachments:pick', async () => {
    try {
      const r = await dialog.showOpenDialog(getWin(), {
        title: 'Adjuntar a la conversación',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Documentos e imágenes',
            extensions: [
              'pdf',
              'txt',
              'md',
              'markdown',
              'json',
              'csv',
              'tsv',
              'log',
              'xml',
              'yml',
              'yaml',
              'ini',
              'cfg',
              'js',
              'ts',
              'tsx',
              'jsx',
              'py',
              'rb',
              'go',
              'rs',
              'java',
              'kt',
              'c',
              'cpp',
              'h',
              'cs',
              'php',
              'sh',
              'bat',
              'ps1',
              'sql',
              'html',
              'htm',
              'css',
              'vue',
              'svelte',
              'tex',
              'rtf',
              'srt',
              'vtt',
              'png',
              'jpg',
              'jpeg',
              'gif',
              'webp',
              'bmp',
              'svg',
              'docx',
              'xlsx',
              'pptx',
              'epub',
              'bin',
              'exe',
              'zip',
              'rar',
              '7z',
            ],
          },
          { name: 'Todos los archivos', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths.length) return [];
      return r.filePaths;
    } catch (err) {
      ctx.onError('attachments:pick', err);
      return [];
    }
  });

  ipcMain.handle('attachments:read', async (e, filePath) => {
    try {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { ok: false, error: 'ruta inválida' };
      // El drag&drop sí puede leer fuera del selector, pero nunca el directorio de
      // datos de la app (ahí viven las API keys y las conversaciones) ni algo que no
      // sea un archivo regular. realpath resuelve enlaces antes de comprobar.
      let full;
      try {
        full = await fsp.realpath(filePath);
      } catch {
        return { ok: false, error: 'La ruta no existe' };
      }
      // La guarda compara en el MISMO espacio: `full` ya viene resuelto por realpath, así
      // que el directorio de datos también tiene que estarlo. Comparando contra la ruta
      // sin resolver, un junction o symlink por el que se llegue al directorio de datos
      // (una carpeta redirigida, por ejemplo) no se parecía a la ruta real y el fichero
      // se colaba como adjunto: ahí viven las API keys y las conversaciones.
      let dataDir = configDir();
      try {
        dataDir = await fsp.realpath(dataDir);
      } catch {
        // El directorio de datos todavía no existe (primer arranque): se compara tal cual.
      }
      if (attach.insideDir(full, dataDir)) return { ok: false, error: 'ruta no permitida' };
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
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
      const destino = tamanoMiniatura(img.getSize(), String(dataUrl).length);
      if (!destino) return String(dataUrl); // ya es pequeña: no se re-comprime
      return img.resize(destino).toDataURL();
    } catch {
      return undefined;
    }
  }

  ipcMain.handle('chat:send', async (e, { convId, text, imageDataUrl, attachments }) => {
    // el renderer manda string, pero un bug suyo no puede reventar el handler:
    // `body.slice(0,48)` asumía string y un texto no-string rompía el turno
    if (typeof text !== 'string') text = '';
    // La conversación destino: la que manda el renderer, o la abierta (y si no hay
    // ninguna todavía, se estrena una como antes). El id explícito se valida: si no
    // existe, no se contesta en otra conversación por error.
    const c = convId ? convsApi.convById(convId) : convsApi.ensureConv();
    if (!c) return { ok: false, error: 'Conversación no encontrada' };
    const a = runtimes.agentFor(c.id); // su agente: se crea (e hidrata desde el hilo guardado) la primera vez
    // ---- adjuntos: texto plano inline, imágenes como partes multimodales ----
    const atts = Array.isArray(attachments) ? attachments : [];
    const imgAtts = atts.filter((a) => a && a.kind === 'image' && a.dataUrl);
    const txtAtts = atts.filter((a) => a && a.kind === 'text');
    // `frase` es lo que el usuario escribió: lo que se pinta en la burbuja y lo que se
    // guarda. El VOLCADO de los adjuntos viaja solo en `body`, que es el mensaje de ESTE
    // turno: antes se guardaba `body` entero, así que cada adjunto metía hasta
    // `attach.MAX_ADJUNTOS_CHARS` caracteres en conversations.json —un fichero que se lee
    // completo al arrancar y se reescribe en cada turno, con copia `.bak`— y el renderer
    // tenía que recortarlos con una expresión regular al repintar.
    let frase = text || (imgAtts.length && !txtAtts.length ? '(análisis de imagen)' : '');
    if (!frase && !txtAtts.length) frase = '(adjunto sin texto)';
    // Este marcador lo recorta el renderer al repintar (renderer/40-vistas.js): la ficha
    // guardada tiene que empezar por el mismo texto o la burbuja al reabrir enseñaría la
    // ficha como si fuera prosa del usuario.
    const marcaAdj = 'He adjuntado archivos para que los uses en tu respuesta:\n\n';
    const fichaAdj = atts.length ? marcaAdj + attach.cardsFor(atts) : '';
    let body = frase;
    if (txtAtts.length) {
      body = (body ? body + '\n\n' : '') + marcaAdj + attach.blocksFor(txtAtts);
    }
    if (!body) body = '(adjunto sin texto)';
    // comando manual de skill: "/skill <resto>" — el usuario fuerza la skill
    const sm = String(text || '').match(/^\/([\w-]+)\s*([\s\S]*)$/);
    if (sm) {
      const s = await getSkills().getSkill(sm[1]);
      if (s && s.enabled) {
        // inyecta la skill en el contexto del agente (como mensaje de sistema)
        a.history.push({ role: 'system', content: `SKILL ACTIVADA POR EL USUARIO: ${s.name}\n\n${s.body}` });
        // la skill manda: su texto sustituye al de la frase (y sigue siendo lo único que
        // se envía y lo único que se guarda, igual que antes)
        frase = (sm[2] || '').trim() || `Aplica la skill ${s.name}.`;
        body = frase;
        if (getWin() && !getWin().isDestroyed())
          getWin().webContents.send('agent:event', { type: 'status', convId: c.id, text: `Skill ${s.name} aplicada` });
      }
    }
    trazaNueva(c.id); // cada conversación estrena su rastro; el anterior ya está guardado con su mensaje
    if (c.messages.length === 0) c.title = body.slice(0, 48);
    // el modo queda grabado con la pregunta: en el chat se ve con qué modo se
    // pidió cada cosa (ACT ejecuta, PLAN planifica, THINK razona)
    const sentMode = (cfg().settings && cfg().settings.mode) || 'act';
    // en la conversación guardamos la frase del usuario y la FICHA de los adjuntos (no el
    // texto completo: las conversaciones pueden ser grandes y se leen en cada arranque).
    // El marcador de la ficha es el mismo que el renderer recorta al repintar, así que al
    // reabrir el hilo se ve la frase con su chip, como antes. Las imágenes se guardan como
    // MINIATURA (320 px): un pantallazo de 5 MB en base64 se relee entero en cada arranque
    // y nunca se vuelve a enviar al modelo (el turno ya pasó). Sin miniatura, la tarjeta al
    // reabrir enseña el chip con el nombre, igual que los adjuntos de texto.
    const attMeta = atts.map((a) => {
      const kind = a.kind || (a.dataUrl ? 'image' : 'text');
      const thumb = kind === 'image' && a.dataUrl ? thumbnailOf(a.dataUrl) : undefined;
      return { name: a.name, kind, size: a.size || 0, ...(thumb ? { dataUrl: thumb } : {}) };
    });
    // Al reabrir el hilo —y en los turnos siguientes, que el agente se hidrata de aquí— el
    // modelo ve la frase y la ficha, no el volcado: el adjunto se reenvía entero en el turno
    // en que se adjunta y solo en él, así que un turno posterior («regenerar») no puede
    // contar con ese contenido y la ficha se lo dice al usuario (vuelve a adjuntarlo).
    const guardado = [frase, fichaAdj].filter(Boolean).join('\n\n');
    c.messages.push({
      role: 'user',
      content: guardado || '(adjunto sin texto)',
      ts: Date.now(),
      mode: sentMode,
      attachments: attMeta.length ? attMeta : undefined,
    });
    c.updatedAt = Date.now();
    convsApi.saveConvs();
    glow('think');
    // afterglow: no apagar al instante al terminar el stream; deja respirar el glow
    const firstImage = imgAtts.length ? imgAtts[0].dataUrl : imageDataUrl;
    a.chat(body, cfg(), firstImage, { attachments: atts })
      /* Al CERRAR el turno (no al empezarlo): la heurística mira la frase del usuario y la
         bandeja de «Recién aprendido» se llena sola con lo que huela a hecho duradero. Con
         el interruptor apagado no se propone nada; con «guardar sin preguntar», se guarda.
         Es gratis: no llama al modelo. Y va dentro de su propio try: un fallo de memoria no
         puede tumbar un turno de chat que ya terminó bien.
         El aviso a la vista NO se emite aquí: el almacén emite 'propuesta' y el router de
         memoria lo reenvía como `memory:nueva`. Un solo punto de emisión, un solo formato. */
      .then(() => {
        try {
          const s = cfg().settings || {};
          if (s.memoryLearn === false) return; // apagado: ni propone ni guarda
          memory().proponerDeTurno(text || body, { convId: c.id, convTitulo: c.title, autoGuardar: s.memoryAutoSave === true });
        } catch (err) {
          ctx.onError('memory:proponer', err);
        }
      })
      .catch((err) => ctx.onError('chat:send', err)) // sin esto el fallo se perdía como promesa flotante
      .finally(() => setTimeout(() => glow('off'), 2400));
    return { ok: true };
  });

  // regenerar: descarta la última respuesta y vuelve a pedírsela al modelo
  ipcMain.handle('chat:retry', async (e, convId) => {
    const c = convDe(convId);
    if (!c) return { ok: false, error: 'sin conversación' };
    const a = runtimes.agentFor(c.id);
    // regenerar durante un turno en curso lo pisaría: exigimos que esté libre
    if (a.isBusy()) return { ok: false, error: 'hay un turno en curso; deténlo antes de regenerar' };
    trazaNueva(c.id); // regenerar es un turno nuevo: su rastro se guarda con su respuesta
    // quita la última respuesta del historial guardado (y solo esa). Se busca
    // DESPUÉS del último mensaje del usuario: un turno que falló no llega a
    // guardarse (el error no emite assistant_done), así que antes se borraba la
    // respuesta de un turno anterior y el usuario perdía un mensaje por reintento.
    if (c.messages.length) {
      let lastUser = -1;
      for (let i = c.messages.length - 1; i >= 0; i--) {
        if (c.messages[i].role === 'user') {
          lastUser = i;
          break;
        }
      }
      for (let i = c.messages.length - 1; i > lastUser; i--) {
        if (c.messages[i].role === 'assistant') {
          c.messages.splice(i, 1);
          break;
        }
      }
      c.updatedAt = Date.now();
      convsApi.saveConvs();
    }
    return await a.retry(cfg());
  });

  ipcMain.handle('chat:stop', (e, convId) => {
    // Detener es de ESA conversación: la otra pestaña, si también está trabajando,
    // sigue trabajando (antes las paraba todas a la vez, porque eran la misma).
    const c = convDe(convId);
    const a = c ? runtimes.peek(c.id) : null;
    if (a) a.stop();
    return { ok: true };
  });
  ipcMain.handle('chat:pause', (e, convId) => {
    const c = convDe(convId);
    const a = c ? runtimes.peek(c.id) : null;
    return a ? a.pause() : { ok: false, error: 'sin agente' };
  });
  /* Órdenes de barra que necesitan el proceso principal. El renderer reconoce la orden y
     NO la manda como mensaje: entra por aquí y devuelve el texto que se pinta como línea
     de sistema. Nada de esto entra en la conversación (compactar SÍ la cambia, a propósito),
     así que no se guarda ni se envía al modelo como si fuera un turno. */
  ipcMain.handle('chat:command', async (e, { convId, name, args } = {}) => {
    const c = convDe(convId);
    if (!c) return { ok: false, error: 'la conversación todavía no está lista' };
    // El agente de ESA conversación: /cost y /compact son de su hilo, no del de la
    // pestaña que esté a la vista.
    const a = runtimes.agentFor(c.id);
    const cmd = String(name || '')
      .toLowerCase()
      .replace(/^\//, '');
    /* /cost solo LEE el gasto: es justo cuando hay un turno en marcha cuando interesa
       preguntarlo, así que va antes de la guarda. Esa guarda nació para /compact, que
       reescribe el contexto y con un turno en vuelo se pisaría consigo mismo. */
    if (cmd === 'cost') {
      const u = typeof a.usageResumen === 'function' ? a.usageResumen() : null;
      if (!u || !u.turns) return { ok: true, text: 'Todavía no hay consumo que contar en esta conversación.' };
      const tokens = Number(u.tokens || 0).toLocaleString('es-ES');
      const turnos = u.turns === 1 ? '1 turno' : u.turns + ' turnos';
      return {
        ok: true,
        text: `Esta conversación: ${tokens} tokens en ${turnos}${u.costUsd ? ' · ' + Number(u.costUsd).toFixed(4) + ' USD' : ''}.`,
      };
    }
    if (a.isBusy()) return { ok: false, error: 'SAGISTARI está trabajando ahora mismo: espera a que termine o detén la tarea' };
    if (cmd === 'compact') {
      let r;
      try {
        r = await a.compact(cfg());
      } catch (err) {
        return { ok: false, error: 'no se pudo compactar: ' + ((err && err.message) || err) };
      }
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'no se pudo compactar' };
      return {
        ok: true,
        text: `Contexto compactado: ${r.antes} mensajes → ${r.despues}. El resumen queda como punto de partida.`,
      };
    }
    void args;
    return { ok: false, error: 'orden desconocida: /' + cmd };
  });
  /* `chat:clear` se ha eliminado: no lo llamaba nadie (ni el renderer ni el puente). */
}

module.exports = { registerChatIpc, tamanoMiniatura };
