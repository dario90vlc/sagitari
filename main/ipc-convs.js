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
 *   - avisar(titulo, msg): aviso con título propio (el fichero ilegible al arrancar);
 *     main lo encola si la ventana todavía no existe y lo suelta al cargarse
 *   - getWin(): ventana de chat (para el diálogo de carpeta)
 *   - runtimes: registro de agentes vivos por conversación (main/runtimes.js). Antes
 *     había UN agente y cada conv:open lo reapuntaba; ahora cada conversación tiene el
 *     suyo y aquí solo se pide el de la conversación que se abre.
 *   - dialog, app, fs, path: módulos ya importados en main
 * Devuelve { currentConv, convById, saveConvs, ensureConv, getWorkspace }: los usan
 * agentEmit (guardar respuestas) y los handlers de chat.
 */

const { validarWorkspaceRuta } = require('./workspace-ruta');
const i18n = require('../agent/i18n');
/* Los DOS títulos por defecto, en cualquier idioma: el título se guarda en
   conversations.json con el idioma que había al crearla, así que renombrar tiene que
   reconocer el de antes (español) y el actual. */
const DICCIONARIOS_TITULO = [require('../agent/i18n/es'), require('../agent/i18n/en')];
const esTituloPorDefecto = (t) => DICCIONARIOS_TITULO.some((d) => d['conv.nueva'] === t);

function registerConvsIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const runtimes = ctx.runtimes;
  const configDir = () => ctx.configDir();
  const { saveConfig, writeJsonAtomic, dialog, app, fs, path } = ctx;
  const CONV_FILE = path.join(configDir(), 'conversations.json');

  // ---- conversations: separate chats, persisted, restorable ----
  const MAX_CONVS = 300; // techo solo al escribir; en memoria no se poda nada
  let convs = [];
  let currentConvId = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
    // un JSON válido con otra forma (`{}`, un número…) es igual de ilegible que uno roto:
    // antes se descartaba en silencio y el primer guardado pisaba el fichero y el .bak
    if (!Array.isArray(parsed)) {
      /* El motivo viaja al aviso, que se pinta DESPUÉS de fijar el idioma: se guarda la
         CLAVE en el error y se traduce al construir el aviso (aquí el idioma aún no
         está decidido). El mensaje queda para el log. */
      const malo = new Error(i18n.t('conv.forma.fichero'));
      malo.clave = 'conv.forma.fichero';
      throw malo;
    }
    convs = parsed;
  } catch (err) {
    // Antes este fallo se silenciaba y el historial «desaparecía» sin decir nada.
    // Ahora se prueba la copia .bak y, si tampoco sirve, se empieza de cero.
    if (fs.existsSync(CONV_FILE)) {
      /* El fichero ilegible se APARTA antes de seguir: `writeJsonAtomic` copia el fichero
         actual sobre el .bak en cada guardado, así que dejarlo ahí destruía la última
         copia buena con el primer mensaje nuevo. Mismo trato que agent/memory.js
         (`memory.corrupt-<ts>.json`): el usuario lo puede recuperar a mano. */
      const cuarentena = CONV_FILE.replace(/\.json$/i, '') + '.corrupt-' + Date.now() + '.json';
      let conservado = false;
      try {
        fs.renameSync(CONV_FILE, cuarentena);
        conservado = true;
      } catch (e2) {
        console.error('conversations.json: no se pudo conservar el original ilegible:', e2.message);
      }
      let desdeBak = false;
      try {
        convs = JSON.parse(fs.readFileSync(CONV_FILE + '.bak', 'utf8'));
        if (!Array.isArray(convs)) throw new Error(i18n.t('conv.forma.bak'));
        desdeBak = true;
      } catch {
        convs = [];
      }
      console.error('conversations.json ilegible (' + err.message + '): ' + (desdeBak ? 'recuperado desde el .bak' : 'se empieza de cero'));
      // El aviso tiene que llegar a la ventana: en la app empaquetada no hay consola y el
      // toast se suelta cuando la ventana está lista (main.js encola si aún no existe).
      /* Se pasa como FUNCIÓN: este router se monta antes de que main.js lea config.json y
         fije el idioma, así que traducir aquí congelaría el idioma por defecto y el aviso
         saldría siempre en español. `enviarAviso` la resuelve en el momento de mandarlo. */
      const aviso = () => ({
        titulo: i18n.t('conv.aviso.titulo'),
        mensaje: i18n.t('conv.aviso.ilegible', {
          motivo: err.clave ? i18n.t(err.clave) : err.message,
          estado: i18n.t(desdeBak ? 'conv.aviso.ilegible.bak' : 'conv.aviso.ilegible.cero'),
          conservado: conservado ? i18n.t('conv.aviso.ilegible.conservado', { archivo: path.basename(cuarentena) }) : '',
        }),
      });
      if (typeof ctx.avisar === 'function') ctx.avisar(aviso);
      else ctx.onSaveError(aviso);
    }
  }
  function saveConvs() {
    try {
      // Antes se recortaba el array EN MEMORIA a 60 conversaciones en cada guardado:
      // pérdida de historial silenciosa. Ahora se guarda todo y solo se recorta al
      // escribir, y solo si de verdad hay un exceso enorme (con .bak del anterior).
      let out = convs;
      if (convs.length > MAX_CONVS) {
        /* Ninguna conversación ABIERTA puede quedarse fuera del fichero: el usuario
           seguiría viendo y respondiendo sus mensajes en su pestaña y desaparecerían al
           reiniciar. Antes solo se protegía la conversación actual; con varias abiertas
           a la vez, cualquiera de las otras podía caer por la cola. Se protege toda
           conversación con agente vivo (es la que tiene una pestaña trabajando). */
        const vivas = new Set(runtimes.liveIds());
        if (currentConvId) vivas.add(currentConvId);
        const protegidas = [];
        const resto = [];
        for (const c of convs) (vivas.has(c.id) ? protegidas : resto).push(c);
        out = [...protegidas, ...resto].slice(0, MAX_CONVS);
      }
      writeJsonAtomic(CONV_FILE, JSON.stringify(out));
    } catch (err) {
      console.error('saveConvs', err.message);
      // el chat es el dato con más valor del usuario: si no se pudo escribir, se dice
      ctx.onSaveError(i18n.t('conv.aviso.disco', { motivo: err.message }));
    }
  }
  const convById = (id) => convs.find((c) => c.id === id) || null;
  const currentConv = () => convById(currentConvId);
  function ensureConv() {
    if (!currentConv()) {
      const c = {
        id: 'c' + Date.now().toString(36),
        title: i18n.t('conv.nueva'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      convs.unshift(c);
      currentConvId = c.id;
    }
    return currentConv();
  }

  /* El historial se busca por título Y por lo que se dijo dentro. El texto buscable
     viaja ya preparado y acotado (2 KB por conversación): así el filtro es instantáneo
     al teclear, sin pedir nada al proceso principal en cada pulsación, y la promesa de
     la interfaz («busca en la conversación») es verdad. */
  const TEXTO_BUSCA = 2000;
  const buscaDe = (c) => {
    const trozos = [String(c.title || '')];
    for (let i = (c.messages || []).length - 1; i >= 0 && trozos.length < 40; i--) {
      const m = c.messages[i];
      if (typeof m.content === 'string') trozos.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p && p.type === 'text' && p.text) trozos.push(p.text);
      }
    }
    return trozos.join('\n').slice(0, TEXTO_BUSCA).toLowerCase();
  };
  ipcMain.handle('conv:list', () =>
    convs.map((c) => ({
      id: c.id,
      title: c.title,
      count: c.messages.length,
      updatedAt: c.updatedAt,
      // qué conversaciones están trabajando AHORA: la pestaña lo puede marcar sin
      // preguntar por cada una (y sin crearle un agente a las que no tienen)
      busy: runtimes.isBusy(c.id),
      busca: buscaDe(c),
    })),
  );

  // ---- espacio de trabajo: carpeta por defecto donde el agente crea/modifica ----
  const DEFAULT_WORKSPACE = path.join(app.getPath('desktop'), 'Sagitari');
  const getWorkspace = () => cfg().settings.workspace || DEFAULT_WORKSPACE;
  ipcMain.handle('workspace:get', () => getWorkspace());
  ipcMain.handle('workspace:set', (e, dir) => {
    // Un workspace es donde el agente CREA, ESCRIBE y EJECUTA. La validación completa
    // (ruta absoluta, raíz de unidad, carpetas del sistema, directorio de datos de la app)
    // vive en workspace-ruta.js: UNA sola copia para los tres sitios que fijan el workspace.
    try {
      const v = validarWorkspaceRuta(dir, configDir());
      if (!v.ok) return v;
      const real = v.real;
      if (!fs.existsSync(real)) fs.mkdirSync(real, { recursive: true });
      if (!fs.statSync(real).isDirectory()) return { ok: false, error: i18n.t('conv.ruta.no.carpeta') };
      const previo = cfg().settings.workspace;
      cfg().settings.workspace = real;
      // El disco puede fallar (datos en solo lectura, disco lleno, fichero bloqueado) y
      // saveConfig devuelve {ok:false}: hay que reenviarlo o la interfaz da por bueno un
      // cambio que se pierde al reiniciar y el agente trabaja en otra carpeta de la que dice.
      const saved = saveConfig();
      if (!saved.ok) {
        // Y la memoria vuelve al valor anterior: si se queda el nuevo, la interfaz dice
        // «no se pudo» y sigue enseñando la carpeta vieja, pero el agente escribe en la nueva.
        cfg().settings.workspace = previo;
        return { ok: false, error: saved.error };
      }
      return { ok: true, path: real };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('workspace:pick', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    // Misma validación que workspace:set: el diálogo devuelve cualquier carpeta y antes se
    // asignaba sin comprobar (C:\Windows o el CONFIG_DIR colaban).
    const p = String(r.filePaths[0] || '').trim();
    try {
      const v = validarWorkspaceRuta(p, configDir());
      if (!v.ok) return v;
      const real = v.real;
      if (!fs.statSync(real).isDirectory()) return { ok: false, error: i18n.t('conv.ruta.no.carpeta') };
      const previo = cfg().settings.workspace;
      cfg().settings.workspace = real;
      // El disco puede fallar (datos en solo lectura, disco lleno, fichero bloqueado) y
      // saveConfig devuelve {ok:false}: hay que reenviarlo o la interfaz da por bueno un
      // cambio que se pierde al reiniciar y el agente trabaja en otra carpeta de la que dice.
      const saved = saveConfig();
      if (!saved.ok) {
        // Y la memoria vuelve al valor anterior: si se queda el nuevo, la interfaz dice
        // «no se pudo» y sigue enseñando la carpeta vieja, pero el agente escribe en la nueva.
        cfg().settings.workspace = previo;
        return { ok: false, error: saved.error };
      }
      return { ok: true, path: real };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('conv:new', () => {
    const c = {
      id: 'c' + Date.now().toString(36),
      title: i18n.t('conv.nueva'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    convs.unshift(c);
    currentConvId = c.id;
    /* La conversación nueva estrena SU agente (con el historial vacío): antes esto
       repuntaba el único agente, que era el que estaba trabajando en otra pestaña. */
    runtimes.agentFor(c.id);
    saveConvs();
    return { ok: true, id: c.id };
  });
  // reasignar el chat en curso tras la primera respuesta (evita chats fantasma)
  // se invoca desde el renderer cuando cambia el título del chat
  ipcMain.handle('conv:rename', (e, title) => {
    const c = currentConv();
    if (c && esTituloPorDefecto(c.title) && title) {
      c.title = String(title).slice(0, 60);
      c.updatedAt = Date.now();
      saveConvs();
    }
    return { ok: true };
  });
  ipcMain.handle('conv:open', (e, id) => {
    const c = convById(id);
    if (!c) return { ok: false, error: i18n.t('conv.no.encontrada') };
    currentConvId = id;
    /* El agente de ESTA conversación. Si ya existe no se toca: su historial en memoria
       es el vivo (el de la conversación que está trabajando) y rehidratarlo tiraría su
       resumen, sus tareas y su uso acumulado. Si es la primera vez, se hidrata UNA vez
       desde los mensajes guardados. */
    runtimes.agentFor(id);
    // `busy` viaja con el hilo: al volver a una pestaña que siguió trabajando sin
    // mirarla, el renderer tiene que saber que su turno sigue en vuelo (los eventos de
    // esa conversación no se pintan en la pestaña abierta mientras no es la suya)
    return { ok: true, messages: c.messages, busy: runtimes.isBusy(id) };
  });
  ipcMain.handle('conv:del', (e, id) => {
    convs = convs.filter((c) => c.id !== id);
    if (currentConvId === id) currentConvId = null;
    // su agente (y el turno que tuviera en vuelo) se van con la conversación: ya no hay
    // conversación donde guardar su respuesta ni a quién preguntar sus confirmaciones
    runtimes.dispose(id);
    saveConvs();
    return { ok: true };
  });

  /* Bifurcar: copia el hilo (con su título) a una conversación nueva, para probar otro
     camino sin perder el original. El sufijo aleatorio evita chocar con un `conv:new`
     en el mismo milisegundo. */
  ipcMain.handle('conv:fork', (e, id) => {
    const src = convs.find((c) => c.id === id) || currentConv();
    if (!src) return { ok: false, error: i18n.t('conv.no.encontrada') };
    const c = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title: i18n.t('conv.copia', { titulo: src.title || i18n.t('conv.titulo') }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: JSON.parse(JSON.stringify(src.messages || [])),
    };
    convs.unshift(c);
    currentConvId = c.id;
    /* La copia estrena agente con los mensajes copiados. La conversación de origen NO
       se toca: puede estar trabajando y antes esto le robaba el agente a mitad de turno. */
    runtimes.agentFor(c.id);
    saveConvs();
    return { ok: true, id: c.id, titulo: c.title, messages: c.messages };
  });

  /* Rebobinar: vuelve el hilo a un punto. Se conserva hasta `index` sin incluirlo, así que
     rebobinar «aquí» tira ese mensaje y todo lo posterior. El agente tiene que soltar
     además el resumen plegado y la lista de tareas: describen lo que ya no está (lo hace
     `Agent.rebobinar`, que no cambia el id de sesión y por eso no puede delegarlo en
     `useSession`). */
  ipcMain.handle('conv:rebobinar', (e, { id, index } = {}) => {
    const c = convById(id) || currentConv();
    if (!c) return { ok: false, error: i18n.t('conv.no.encontrada') };
    const i = Math.round(Number(index));
    if (!Number.isFinite(i) || i < 0 || i > c.messages.length) return { ok: false, error: i18n.t('conv.rebobinar.fuera') };
    // el turno que hay que respetar es el de ESA conversación, no el de la que esté a la vista
    if (runtimes.isBusy(c.id)) return { ok: false, error: i18n.t('conv.trabajando.rebobinar') };
    c.messages = c.messages.slice(0, i);
    c.updatedAt = Date.now();
    // su agente suelta además el resumen plegado y la lista de tareas (describen lo que ya no está)
    const a = runtimes.peek(c.id);
    if (a) a.rebobinar(c.id, c.messages);
    saveConvs();
    return { ok: true, messages: c.messages };
  });

  return { currentConv, convById, saveConvs, ensureConv, getWorkspace };
}

module.exports = { registerConvsIpc };
