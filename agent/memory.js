'use strict';

/* Memoria avanzada de SAGITARI (v2 — fase 1 del spec de memoria).

   Un hecho duradero es `{ id, text, date, lastUsed, uses, importance, confidence,
   origen, origenTexto, etiquetas, hash, papelera }`. Los nombres de campo siguen
   siendo los de la v1 a propósito: el scoring, el prompt y la vista ya leían `text`,
   `importance` o `lastUsed`, y renombrarlos obligaba a tocar medio repositorio sin
   ganar nada. Lo nuevo es lo que faltaba: de dónde salió (`origen` + `origenTexto`),
   la huella para deduplicar (`hash`), las etiquetas y la papelera.

   Este fichero es el ÚNICO que toca disco: el esquema, la similitud, la fusión y la
   heurística viven en agent/memoria-v2.js (puro, sin fs).

   Ficheros:
     - memory.json      → `{ version: 2, hechos: [...] }` (los hechos, vivos o en papelera)
     - memory-tray.json → `{ version: 2, propuestas: [...] }` (la bandeja «Recién aprendido»)

   Nada se borra en silencio: los hechos viejos bajan de importancia, luego pasan a la
   papelera (30 días de recuperación) y solo entonces desaparecen; el techo del almacén
   manda lo que sobra a la papelera y la bandeja deja de admitir propuestas en vez de
   tirar las viejas. Y antes de cada reescritura hay copia (`.bak` siempre, `.bak-v1` al
   migrar).

   Un fichero que NO se ha podido leer no se pisa jamás: `estado()` lo declara (la vista
   enseña su pantalla de recuperación) y `save()` no escribe hasta que una lectura
   completa funcione. Si lo que falla es el CONTENIDO (JSON ilegible), el original se
   conserva en cuarentena y el almacén sigue siendo utilizable. */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const v2 = require('./memoria-v2');
const { redactToolArgs } = require('./runlog');

const CONFIG_DIR = require('./datadir').dataDir();
let MEMORY_FILE = path.join(CONFIG_DIR, 'memory.json');
const MAX_MEMORIES = 300; // techo de hechos vivos del almacén
const MAX_BANDEJA = 50; // tope de propuestas sin decidir en la bandeja
const MAX_IN_CONTEXT = 30; // tope de recuerdos inyectados en el prompt

const TRAY_FILE_INICIAL = path.join(CONFIG_DIR, 'memory-tray.json');
let TRAY_FILE = TRAY_FILE_INICIAL;

let cache = null;
let trayCache = null;
/* Resultado de la última lectura del almacén. `ok:false` = no se pudo leer (tipo 'io') o
   no se pudo interpretar (tipo 'ilegible'): la vista lo dice y ofrece «Restaurar copia»
   en vez de enseñar una memoria vacía que no es cierta. */
let lectura = { ok: true, tipo: 'ok', error: '' };

/* Avisos para main (dirección main→agent, nunca al revés): el almacén NO conoce la
   ventana, solo dice «hay una propuesta nueva» y quien escuche decide qué hacer. */
const emisor = new EventEmitter();

/** Suscribirse a los avisos del almacén (hoy: 'propuesta', una vez por cada propuesta
    nueva que entra en la bandeja). */
function on(evento, fn) {
  emisor.on(evento, fn);
}

function off(evento, fn) {
  emisor.off(evento, fn);
}

/** Escritura atómica: escribe a .tmp y renombra, conservando el .bak anterior. */
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.copyFileSync(file, file + '.bak');
  } catch {} // aún no había archivo: no es un fallo
  fs.renameSync(tmp, file);
}

/** Conserva un archivo ilegible como memory.corrupt-<ts>.json en vez de perderlo.
    @returns true si el original quedó a salvo (o ya no estaba). */
function quarantine(reason) {
  const dest = MEMORY_FILE.replace(/\.json$/i, '') + '.corrupt-' + Date.now() + '.json';
  try {
    fs.renameSync(MEMORY_FILE, dest);
    console.error('memory.load: ' + reason + ' — conservado en ' + dest);
    return true;
  } catch (e2) {
    // Si el fichero ya no estaba (o no se pudo mover) el original sigue donde estaba:
    // mientras no se pueda leer, no se escribe encima.
    console.error(
      'memory.load: ' +
        reason +
        (e2.code === 'ENOENT' ? ' — no había fichero que conservar' : ' y no se pudo conservar el original: ' + e2.message),
    );
    return e2.code === 'ENOENT';
  }
}

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      cache = [];
      lectura = { ok: true, tipo: 'ok', error: '' };
      return cache;
    }
    /* Error de E/S (EBUSY/EPERM transitorios de Windows: antivirus, otro proceso): NO
       significa "no hay memoria". Sin memoizar el resultado, la lectura se reintenta en
       la siguiente llamada (y `save()` no escribe hasta que funcione). */
    lectura = { ok: false, tipo: 'io', error: 'no se pudo leer ' + MEMORY_FILE + ': ' + e.message };
    console.error('memory.load: ' + lectura.error);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Fichero v1 (array plano): se migra y se reescribe en v2. `atomicWrite` ya deja
      // la copia .bak del original antes de pisarlo.
      const r = v2.migrarV1(parsed);
      cache = r.hechos;
      lectura = { ok: true, tipo: 'ok', error: '' };
      /* Se conserva el original v1 con un nombre propio (`.bak-v1`) antes de reescribir:
         es de donde `restaurarCopia()` recupera si el fichero v2 se corrompe luego. */
      try {
        fs.copyFileSync(MEMORY_FILE, MEMORY_FILE.replace(/\.json$/i, '') + '.bak-v1');
      } catch {}
      if (r.fusiones.length) console.error('memory.migrar: ' + r.fusiones.length + ' duplicado(s) fusionado(s) al migrar a v2');
      save();
    } else if (parsed && parsed.version === v2.ESQUEMA && Array.isArray(parsed.hechos)) {
      cache = parsed.hechos.map(v2.normalizarHecho);
      lectura = { ok: true, tipo: 'ok', error: '' };
    } else {
      throw new SyntaxError('esquema desconocido');
    }
  } catch (e) {
    /* JSON truncado/corrupto: lo apartamos (cuarentena) y NO dejamos que un save() lo pise
       con un almacén vacío. El original es lo que `restaurarCopia()` puede reponer; por eso,
       cuando la cuarentena ha funcionado, escribir de nuevo es seguro (el fichero ilegible
       ya no está en su sitio) y el almacén sigue siendo utilizable. */
    const conservado = quarantine(e.message);
    cache = conservado ? [] : null;
    lectura = {
      ok: false,
      tipo: 'ilegible',
      error:
        'el fichero no se pudo interpretar (' +
        e.message +
        ')' +
        (conservado ? '; se ha conservado una copia aparte' : ' y no se pudo conservar una copia aparte'),
    };
  }
  if (cache && cache.length) prune(); // poda automática al cargar (una vez por proceso)
  return cache || [];
}

/**
 * Estado del almacén para quien tenga que contarlo (la vista, vía `memory:list`).
 * Vuelve a intentar la lectura si la última falló: un bloqueo transitorio se resuelve solo.
 */
function estado() {
  load();
  return { ...lectura };
}

/** Escribe el almacén. Devuelve false si no se pudo (nunca lanza). */
function save() {
  if (!cache) return false;
  /* Un almacén que no se ha podido LEER no se pisa: escribir ahora perdería los hechos
     que no hemos visto. Se reescribe en cuanto la lectura funcione. */
  if (lectura.tipo === 'io') return false;
  try {
    atomicWrite(MEMORY_FILE, JSON.stringify({ version: v2.ESQUEMA, hechos: cache }, null, 2));
    lectura = { ok: true, tipo: 'ok', error: '' };
    return true;
  } catch (e) {
    console.error('memory.save', e.message);
    return false;
  }
}

/** El bloqueo por error de E/S, para las operaciones que escriben. `null` = no hay bloqueo. */
function bloqueo() {
  return lectura.tipo === 'io' ? { ok: false, error: lectura.error } : null;
}

/* El esquema y la tokenización viven en el módulo puro: aquí solo se reexportan para no
   tener dos listas de stopwords ni dos formas de normalizar un hecho. */
const normalize = v2.normalizarHecho;
const tokenize = v2.tokenizar;

function clamp01(n) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/* La memoria se persiste en disco, se exporta y viaja al modelo dentro del prompt: ni el
   hecho ni la frase de la que salió pueden llevar una clave. El registro (runlog) y el
   perfil de hábitos ya se redactan con la lista de patrones del repositorio; aquí se pasa
   por esa MISMA lista (no se copia) en el único sitio por el que pasan TODOS los hechos,
   vengan del cierre de turno o de la herramienta `remember`. */
function sinSecretos(texto) {
  const s = String(texto == null ? '' : texto);
  return s ? redactToolArgs('memoria', { texto: s }).texto : '';
}

/* ---------- scoring ---------- */

/**
 * Score de un hecho frente a un texto de contexto: mezcla solapamiento léxico
 * (Jaccard sobre tokens) con importancia y frescura. Determinista, sin embeddings:
 * evita introducir memoria irrelevante en el contexto.
 */
function scoreAgainst(mem, contextText) {
  const a = new Set(tokenize(contextText));
  const b = new Set(tokenize(mem.text));
  if (!a.size || !b.size) return { score: mem.importance * 0.3, overlap: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const overlap = inter / (a.size + b.size - inter); // Jaccard 0..1
  const ageDays = (Date.now() - Date.parse(mem.date || 0)) / 86400000;
  const freshness = 1 / (1 + ageDays / 30); // decae con ~1 mes de constante
  return {
    overlap,
    score: overlap * 2.0 + mem.importance * 0.6 + mem.confidence * 0.2 + freshness * 0.4,
  };
}

/**
 * Hechos relevantes para inyectar en el prompt.
 * @param {string} contextText  texto de la petición (e historial reciente si se pasa)
 * @param {object} opts  { limit, minScore }  minScore: umbral de score (sensibilidad 0-3)
 * Devuelve [{mem, score, overlap}] ordenados por score, con solapamiento > 0;
 * si NADA solapa, cae a los más importantes (para no quedarse nunca vacío).
 */
function relevantMemories(contextText, opts = {}) {
  const activos = load().filter((m) => !m.papelera);
  const limit = Math.min(Math.max(opts.limit || MAX_IN_CONTEXT, 1), MAX_IN_CONTEXT);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.4;
  /* Los hechos de identidad (nombre, idioma) van SIEMPRE: son lo que hace que el agente
     te llame por tu nombre sin que se lo repitas. Ocupan el presupuesto primero. */
  const identidad = activos
    .filter((m) => (m.etiquetas || []).includes('identidad'))
    .map((m) => ({ mem: m, score: 1, overlap: 1 }))
    .slice(0, limit);
  const yaEstan = new Set(identidad.map((x) => x.mem.id));
  const scored = activos
    .filter((m) => !yaEstan.has(m.id))
    .map((m) => ({ mem: m, ...scoreAgainst(m, contextText) }))
    .filter((x) => x.overlap > 0 && x.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, limit - identidad.length));
  const resultado = identidad.concat(scored);
  if (scored.length || identidad.length) {
    // toca lastUsed/uses de los recuperados (recuerdo usado = recuerdo vivo)
    for (const s of resultado) {
      s.mem.lastUsed = new Date().toISOString();
      s.mem.uses++;
    }
    save();
    return resultado;
  }
  // fallback: los más importantes (nunca contexto vacío si hay memoria)
  return activos
    .map((m) => ({ mem: m, score: m.importance * 0.6, overlap: 0 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.min(5, limit));
}

/* ---------- CRUD ---------- */

/** Los hechos vivos: la papelera se mira aparte, en `listTrash()`. */
function list() {
  return load()
    .filter((m) => !m.papelera)
    .map((m) => ({ ...m }));
}

/**
 * Añade un hecho, consolidando en vez de duplicar.
 *
 * La regla la decide el VALOR, no solo el parecido léxico (ver `claveHecho`):
 *   - mismo dato (mismo valor, aunque cambie la forma) → se consolida y se refuerza.
 *   - valor distinto de un dato único (nombre, idioma, dónde vives…) → sustituye, y el
 *     hecho viejo va a la PAPELERA (recuperable y visible, nunca se pierde).
 *   - valor distinto de algo que admite varios (preferencias) → hecho nuevo: los dos son
 *     ciertos y el usuario los dijo.
 *   - polaridad invertida sobre el mismo objeto («me gusta el té» / «no me gusta el té»)
 *     → sustituye, porque se contradicen.
 *
 * @returns el hecho creado o, si se consolidó con uno parecido,
 *          `{ ...hecho, fusionado: true, antes: <hecho previo> }` (para poder deshacer).
 *          Si sustituyó a uno viejo: `{ ...hecho, sustituido: true, antes }`.
 *          `null` si no hay nada que guardar o si el almacén no se puede leer.
 */
function add({ text, source = 'user', origen, importance = 0.5, confidence = 0.8, etiquetas, origenTexto } = {}) {
  const bloqueado = bloqueo();
  if (bloqueado) return null; // sin poder leer el almacén, se escriba lo que se escriba se perdería
  const t = v2.normalizarTexto(sinSecretos(text));
  if (!t) return null;
  origenTexto = sinSecretos(origenTexto);
  const list0 = load();
  // 1) texto idéntico: se refuerza en su lugar (comportamiento de siempre). Los hechos
  //    de la papelera quedan fuera: volver a contarlo no debe resucitar nada solo.
  const dup = list0.find((m) => !m.papelera && m.text.toLowerCase() === t.toLowerCase());
  if (dup) {
    dup.importance = v2.normalizarHecho({ ...dup, importance: Math.max(dup.importance, importance) }).importance;
    dup.uses++;
    dup.lastUsed = new Date().toISOString();
    save();
    return { ...dup };
  }
  // 2) El mismo dato (o uno parecido) ya está en la memoria.
  const clave = v2.claveHecho(t);
  let i = -1;
  if (clave) {
    i = list0.findIndex((m) => {
      if (m.papelera) return false;
      const otra = v2.claveHecho(m.text);
      return !!otra && otra.pred === clave.pred;
    });
  }
  if (i < 0) i = list0.findIndex((m) => !m.papelera && v2.similitud(m.text, t) >= v2.FUSION_UMBRAL);
  const creado = () => v2.normalizarHecho({ text: t, origen, source, importance, confidence, etiquetas, origenTexto });
  if (i >= 0) {
    const antes = { ...list0[i] };
    const relacion = clave ? v2.relacionHechos(antes.text, t) : null;
    if (relacion === 'contradice' || (relacion === 'cambia' && clave.unico)) {
      /* El dato viejo no se borra: va a la papelera (30 días) y la vista lo puede
         devolver. Así corregir un valor no deja dos hechos contradictorios ni pierde el
         anterior por el camino. */
      list0[i] = { ...antes, papelera: new Date().toISOString() };
      const m = creado();
      list0.splice(i, 0, m); // ocupa el sitio del viejo: la lista sigue ordenada por llegada
      cache = recortar(list0);
      save();
      return { ...m, sustituido: true, antes };
    }
    if (relacion === 'cambia' || relacion === 'otro') {
      /* 'cambia': el predicado admite varios valores (preferencias), así que los dos son
         ciertos y conviven. 'otro': declaran datos distintos (otro predicado), así que
         tampoco se pisan aunque se parezcan. */
      const m = creado();
      list0.unshift(m);
      cache = recortar(list0);
      save();
      return { ...m };
    }
    const fusionado = v2.fusionarPar(antes, creado());
    // fusionarPar conserva el texto más reciente: aquí el recién llegado es el nuevo
    list0[i] = { ...fusionado, text: t };
    cache = recortar(list0);
    save();
    return { ...list0[i], fusionado: true, antes };
  }
  const m = v2.normalizarHecho({ text: t, origen, source, importance, confidence, etiquetas, origenTexto });
  list0.unshift(m);
  cache = recortar(list0);
  save();
  return { ...m };
}

/** El techo del almacén tampoco borra en silencio: lo que sobra pasa a la papelera. */
function recortar(list0) {
  if (list0.length <= MAX_MEMORIES) return list0;
  const ahora = new Date().toISOString();
  let fuera = 0;
  for (const m of list0.slice(MAX_MEMORIES)) {
    if (m.papelera) continue;
    m.papelera = ahora;
    fuera++;
  }
  if (fuera) console.error('memory: ' + fuera + ' hecho(s) antiguo(s) a la papelera por el techo de ' + MAX_MEMORIES);
  return list0;
}

/** «Olvidar» un hecho: NO se borra, se manda a la papelera (30 días para arrepentirse). */
function remove(id) {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const m = load().find((x) => x.id === id);
  if (!m) return { ok: false, error: 'recuerdo no encontrado' };
  m.papelera = new Date().toISOString();
  save();
  return { ok: true };
}

/** Actualiza metadata (importancia, texto, etiquetas) desde la UI. */
function update(id, patch = {}) {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const m = load().find((x) => x.id === id);
  if (!m) return { ok: false, error: 'recuerdo no encontrado' };
  if (patch.importance !== undefined) m.importance = clamp01(patch.importance);
  if (patch.confidence !== undefined) m.confidence = clamp01(patch.confidence);
  if (patch.text !== undefined) {
    const t = v2.normalizarTexto(sinSecretos(patch.text));
    m.text = t;
    m.hash = v2.hashTexto(t); // la huella es del texto: si cambia el texto, cambia la huella
  }
  if (Array.isArray(patch.etiquetas)) m.etiquetas = [...new Set(patch.etiquetas.map(String).filter(Boolean))];
  save();
  return { ok: true, memory: { ...m } };
}

/**
 * Olvido por antigüedad (se llama al cargar y desde la vista). Ya NO borra en silencio:
 * lo que lleva OLVIDO_BAJA_DIAS sin usarse baja a importancia baja, lo que lleva
 * OLVIDO_PAPELERA_DIAS pasa a la papelera y solo lo caducado en papelera desaparece.
 */
function prune() {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const ahora = Date.now();
  let cambiado = false;
  for (const m of load()) {
    if (m.papelera) {
      if (v2.expiradoEnPapelera(m, ahora)) cambiado = true;
      continue;
    }
    const d = v2.decidirOlvido(m, ahora);
    if (!d) continue;
    cambiado = true;
    if (d.accion === 'baja') m.importance = Math.min(m.importance, 0.3);
    else m.papelera = new Date(ahora).toISOString();
  }
  if (cambiado) {
    cache = load().filter((m) => !(m.papelera && v2.expiradoEnPapelera(m, ahora)));
    save();
  }
  return { ok: true };
}

/* ---------- papelera / exportar / borrar ---------- */

/** Los hechos que están en la papelera (recuperables 30 días). */
function listTrash() {
  return load()
    .filter((m) => m.papelera)
    .map((m) => ({ ...m }));
}

/** Saca un hecho de la papelera: vuelve a la lista activa. */
function restore(id) {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const m = load().find((x) => x.id === id);
  if (!m) return { ok: false, error: 'recuerdo no encontrado' };
  m.papelera = null;
  m.lastUsed = new Date().toISOString();
  save();
  return { ok: true, memory: { ...m } };
}

/** «Vaciar la papelera» (spec §5): aquí sí se borra de verdad, porque el usuario lo pidió. */
function trashEmpty() {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const l = load();
  const borradas = l.filter((m) => m.papelera).length;
  cache = l.filter((m) => !m.papelera);
  save();
  return { ok: true, borradas };
}

/** Volcado legible para el botón «Exportar mi memoria». */
function exportar() {
  const l = load();
  return {
    version: v2.ESQUEMA,
    exportado: new Date().toISOString(),
    hechos: l.filter((m) => !m.papelera).map((m) => ({ ...m })),
    papelera: l.filter((m) => m.papelera).map((m) => ({ ...m })),
  };
}

/** «Olvídalo todo»: vacía el almacén y la bandeja (la copia .bak del fichero anterior se
    conserva). El perfil de hábitos lo borra el router (`memory:wipe`), que es quien
    conoce los dos almacenes. */
function wipe() {
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const borrados = load().length;
  cache = [];
  lectura = { ok: true, tipo: 'ok', error: '' };
  trayCache = [];
  save();
  traySave();
  return { ok: true, borrados };
}

/**
 * «Restaurar copia» del estado «no se pudo leer el almacén» (spec §5): prueba las copias
 * de más reciente a más antigua —la que deja cada escritura (`memory.json.bak`), el
 * original v1 (`.bak-v1`) y, como último recurso, la cuarentena más nueva— y se queda con
 * la primera que se pueda leer. Antes de pisar nada, el fichero ilegible actual se
 * conserva como `memory.json.roto-<fecha>`.
 */
function restaurarCopia() {
  const base = MEMORY_FILE.replace(/\.json$/i, '');
  const dir = path.dirname(MEMORY_FILE);
  const cuarentenas = [];
  try {
    for (const f of fs.readdirSync(dir)) if (/^memory\.corrupt-\d+\.json$/.test(f)) cuarentenas.push(path.join(dir, f));
  } catch {}
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  cuarentenas.sort((a, b) => mtime(b) - mtime(a));
  const candidatas = [MEMORY_FILE + '.bak', base + '.bak-v1', ...cuarentenas].filter((f) => fs.existsSync(f));
  if (!candidatas.length) return { ok: false, code: 'sin_copia', error: 'no hay ninguna copia que restaurar' };
  /* Una copia ilegible no puede abortar la recuperación: se prueba la siguiente. Si
     ninguna sirve, se devuelve el motivo de la última que falló (dice más que un «no»). */
  let origen = null;
  let hechos = null;
  let ultimoError = 'no hay ninguna copia que restaurar';
  for (const f of candidatas) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      const leidos = Array.isArray(parsed)
        ? v2.migrarV1(parsed).hechos
        : parsed && Array.isArray(parsed.hechos)
          ? parsed.hechos.map(v2.normalizarHecho)
          : null;
      if (leidos) {
        origen = f;
        hechos = leidos;
        break;
      }
      ultimoError = 'la copia no tiene un formato reconocible';
    } catch (e) {
      ultimoError = 'la copia no se pudo leer: ' + e.message;
    }
  }
  if (!origen) return { ok: false, error: ultimoError };
  /* Lo ilegible no se tira: si sigue en su sitio se copia a `.roto-<fecha>`; si la
     cuarentena ya se lo llevó, ese fichero ES la copia de lo roto. El nombre conserva
     el `memory.json` entero para que se vea de un vistazo qué fichero se rompió. */
  try {
    const roto = fs.existsSync(MEMORY_FILE) ? MEMORY_FILE : cuarentenas[0];
    if (roto) fs.copyFileSync(roto, MEMORY_FILE + '.roto-' + Date.now() + '.json');
  } catch {}
  cache = hechos;
  lectura = { ok: true, tipo: 'ok', error: '' };
  /* Si el almacén no se puede escribir (fichero bloqueado, disco lleno), no se canta la
     restauración: la vista tiene que poder decirlo. */
  if (!save()) return { ok: false, error: 'la copia se leyó, pero no se pudo escribir el almacén' };
  return { ok: true, restaurado: hechos.length, origen };
}

/* ---------- bandeja de aprobación («Recién aprendido») ---------- */

function trayLoad() {
  if (trayCache) return trayCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TRAY_FILE, 'utf8'));
    trayCache = Array.isArray(raw) ? raw : Array.isArray(raw && raw.propuestas) ? raw.propuestas : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('memory.tray: no se pudo leer ' + TRAY_FILE + ': ' + e.message);
    trayCache = [];
  }
  return trayCache;
}

function traySave() {
  try {
    atomicWrite(TRAY_FILE, JSON.stringify({ version: v2.ESQUEMA, propuestas: trayCache || [] }, null, 2));
  } catch (e) {
    console.error('memory.tray.save', e.message);
  }
}

function trayList() {
  return trayLoad().map((p) => ({ ...p }));
}

/** Encola propuestas nuevas: ignora las vacías, las repetidas (misma huella), las que ya
    son hechos y las que no caben. Al llegar al tope NO se tiran las más viejas por detrás
    (eso borraba en silencio): la bandeja deja de admitir hasta que el usuario decida las
    que tiene. */
function trayProponer(props) {
  const lista = trayLoad();
  const yaHechos = new Set(load().map((m) => m.hash));
  const yaEnBandeja = new Set(lista.map((p) => p.hash));
  const nuevas = [];
  for (const p of Array.isArray(props) ? props : []) {
    const texto = v2.normalizarTexto(sinSecretos(p.texto));
    if (!texto) continue; // sin texto no hay nada que aprobar (quien propone debe mirarlo antes)
    const hash = v2.hashTexto(texto);
    if (yaHechos.has(hash) || yaEnBandeja.has(hash)) continue;
    if (lista.length >= MAX_BANDEJA) {
      console.error('memory.tray: la bandeja está llena (' + MAX_BANDEJA + ' propuestas sin decidir): «' + texto + '» no se encola');
      break;
    }
    const prop = {
      id: p.id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      texto,
      etiquetas: Array.isArray(p.etiquetas) ? p.etiquetas : [],
      confianza: clamp01(p.confianza !== undefined ? p.confianza : 0.5),
      origen: p.origen || 'mensaje',
      motivo: p.motivo || '',
      origenTexto: v2.normalizarTexto(sinSecretos(p.origenTexto)),
      hash,
      creado: p.creado || new Date().toISOString(),
      convId: p.convId || null,
      convTitulo: p.convTitulo || '',
    };
    lista.push(prop);
    yaEnBandeja.add(hash);
    nuevas.push(prop);
  }
  if (nuevas.length) {
    trayCache = lista;
    traySave();
    // Un aviso por propuesta NUEVA: las repetidas no vuelven a avisar (nadie quiere
    // que el contador de «Recién aprendido» baile sin motivo).
    for (const prop of nuevas) emisor.emit('propuesta', prop);
  }
  return nuevas;
}

/** Aprobar una propuesta: pasa por `add`, así que si se parece a un hecho vivo se
    consolida en vez de duplicarlo. El `origen` viaja con ella (de dónde salió) y el
    texto se puede corregir sin perder las etiquetas ni la frase original. */
function trayAceptar(id, patch = {}) {
  const lista = trayLoad();
  const p = lista.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'propuesta no encontrada' };
  const bloqueado = bloqueo();
  if (bloqueado) return bloqueado;
  const m = add({
    text: patch.text !== undefined ? patch.text : p.texto,
    origen: p.origen,
    importance: patch.importance !== undefined ? patch.importance : 0.6,
    etiquetas: patch.etiquetas || p.etiquetas,
    origenTexto: p.origenTexto,
  });
  if (!m) return { ok: false, error: 'no se pudo guardar el hecho' };
  trayCache = lista.filter((x) => x.id !== id);
  traySave();
  return { ok: true, memory: m };
}

function trayDescartar(id) {
  trayCache = trayLoad().filter((x) => x.id !== id);
  traySave();
  return { ok: true };
}

/** El gancho del cierre de turno: mira la frase del usuario y propone hechos duraderos.
    Con `autoGuardar` (ajuste «guardar sin preguntar») se guardan directamente. */
function proponerDeTurno(texto, { convId = null, convTitulo = '', autoGuardar = false } = {}) {
  const props = v2.proponerHechos(texto).map((p) => ({ ...p, convId, convTitulo }));
  if (!props.length) return [];
  if (autoGuardar) {
    const creados = [];
    for (const p of props) {
      // `add` consolida por sí solo: si el hecho ya existe, refuerza en vez de duplicar
      const m = add({ text: p.texto, origen: p.origen, importance: 0.6, etiquetas: p.etiquetas, origenTexto: p.origenTexto });
      if (m) creados.push(m);
    }
    return creados;
  }
  return trayProponer(props);
}

/** Para tests: reinicia el singleton apuntando a otro archivo. */
function _resetForTests(file) {
  cache = null;
  lectura = { ok: true, tipo: 'ok', error: '' };
  if (file) MEMORY_FILE = file;
}

/** Para tests: aísla la bandeja en otro archivo. */
function _resetTray(file) {
  trayCache = null;
  TRAY_FILE = file || TRAY_FILE_INICIAL;
}

module.exports = {
  list,
  add,
  remove,
  update,
  prune,
  relevantMemories,
  scoreAgainst,
  tokenize,
  estado,
  listTrash,
  restore,
  trashEmpty,
  exportar,
  wipe,
  restaurarCopia,
  trayList,
  trayProponer,
  trayAceptar,
  trayDescartar,
  proponerDeTurno,
  on,
  off,
  __file: () => MEMORY_FILE,
  __test: { _resetForTests, _resetTray, normalize, MAX_MEMORIES, MAX_BANDEJA, MAX_IN_CONTEXT },
};
