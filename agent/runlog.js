'use strict';

/* Structured run logs (JSONL) for SAGITARI — one file per app session.
   Location: %APPDATA%/SagitariAI/logs/run-<timestamp>.jsonl
   Every agent/tool/model event appends one JSON line:
     { ts, agent, task, tool, action, args, durationMs, success, error, model, tokens, cost }
   Files rotate on boot (keep the newest MAX_LOGS). */

const fs = require('fs');
const path = require('path');
/* La MISMA tabla que exige confirmación al escribir en un campo sensible decide si un
   texto tecleado se puede guardar: dos listas de qué es un campo sensible se separan. */
const { SENSITIVE_FIELD_RX } = require('./guardrails');

const LOG_DIR_DEFAULT = path.join(require('./datadir').dataDir(), 'logs');
let LOG_DIR = LOG_DIR_DEFAULT;
let MAX_LOGS = 20;
let MAX_BYTES = 8 * 1024 * 1024; // tope por archivo: una sesión larga no crece sin límite

let stream = null;
let currentFile = null;
let written = 0; // bytes escritos en el archivo actual

let pruneTimer = null;
const nombresUsados = new Set(); // nombres abiertos en esta sesión (unicidad en memoria)

/**
 * Borra los ficheros sobrantes dejando MAX_LOGS (el de la sesión incluido).
 *
 * Se hace DESPUÉS de abrir el nuevo y con reintentos, no antes: `readdirSync`
 * ejecutado en el instante de rotar puede no ver todavía los ficheros recién
 * creados (el handle se abre de forma asíncrona) y, en Windows, un fichero con
 * el handle cerrándose a medias tampoco se puede borrar. Podando antes, la
 * carpeta de logs crecía sin límite en sesiones largas.
 */
function pruneOldLogs() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => {
    const paso = (intento) => {
      let files = [];
      try {
        files = fs
          .readdirSync(LOG_DIR)
          .filter((f) => f.endsWith('.jsonl'))
          .sort();
      } catch {
        return;
      }
      const activo = currentFile && path.basename(currentFile);
      const otros = files.filter((f) => f !== activo);
      const pendientes = otros.slice(0, Math.max(0, otros.length - (MAX_LOGS - 1)));
      for (const f of pendientes) {
        try {
          fs.unlinkSync(path.join(LOG_DIR, f));
          nombresUsados.delete(f);
        } catch (e) {
          if (e.code !== 'ENOENT') continue;
        } // ENOENT: ya no está
      }
      // Los write streams crean sus archivos de forma asíncrona. Releer la carpeta
      // evita que una poda temprana vea solo el archivo activo y deje los demás.
      // En Windows, además, `unlinkSync` falla con EBUSY/EPERM mientras el handle
      // del stream anterior se cierra: en un runner lento más de 1 s, así que con
      // ~1 s de reintentos la carpeta se quedaba muy por encima del tope. Se
      // reintenta hasta ~10 s (el tope de ficheros no puede depender del reloj).
      if (intento < 100) {
        pruneTimer = setTimeout(() => paso(intento + 1), 100);
        if (pruneTimer.unref) pruneTimer.unref();
      }
    };
    paso(1);
  }, 50);
}

function openStream() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // Nombre de sesión único. Comprobar solo con existsSync no basta: el fichero
  // que se acaba de abrir puede no estar todavía en disco (el handle se abre de
  // forma asíncrona), así que dos rotaciones dentro del mismo milisegundo
  // reutilizaban el nombre, el contador de bytes volvía a cero y el archivo
  // seguía creciendo con flags 'a' muy por encima del tope.
  const base = 'run-' + Date.now();
  let name = base + '.jsonl';
  for (let i = 1; nombresUsados.has(name) || fs.existsSync(path.join(LOG_DIR, name)); i++) name = base + '-' + i + '.jsonl';
  nombresUsados.add(name);
  currentFile = path.join(LOG_DIR, name);
  written = 0;
  stream = fs.createWriteStream(currentFile, { flags: 'a' });
  stream.on('error', () => {
    stream = null;
  });
  pruneOldLogs();
  return stream;
}

function ensureStream() {
  if (stream) return stream;
  try {
    return openStream();
  } catch {
    stream = null;
    return null;
  }
}

/* --------------------------------------------------------------------------- *
 *  Redacción de secretos antes de persistir.
 *
 *  El log JSONL vive en disco en claro: los args de una herramienta pueden
 *  llevar una contraseña (type en campo sensible), el texto del portapapeles,
 *  una API key en args MCP o el contenido entero de un fichero. Sin esto, una
 *  copia del log filtra secretos. Se redacta al escribir, no al leer: lo que
 *  nunca se guardó no hay que perseguirlo después.
 *  Lógica pura (sin I/O) para poder probarla entera.
 * --------------------------------------------------------------------------- */

/* Claves cuyo valor nunca se guarda (comparación en minúsculas, sin guiones). */
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'contrasena',
  'contraseña',
  'pin',
  'token',
  'apikey',
  'api_key',
  'auth',
  'authorization',
  'secret',
  'secreto',
  'cvv',
  'cvc',
  'tarjeta',
  'cardnumber',
  'iban',
  'ssn',
  'dni',
]);

/* Patrones de secretos dentro de texto libre (claves, Bearer, base64 de -enc). */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9-_]{8,}/g, // OpenAI / compatibles
  /xox[bpas]-[A-Za-z0-9-]+/g, // Slack
  /gh[pousr]_[A-Za-z0-9]{8,}/g, // GitHub
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, // cabeceras de autorización
  /(?<=["'=:]\s*)eyJ[A-Za-z0-9-_]{8,}\.[A-Za-z0-9-_]{8,}\.[A-Za-z0-9-_]{4,}/g, // JWT
];

const normKey = (k) =>
  String(k || '')
    .toLowerCase()
    .replace(/[-_]/g, '');

function redactText(v) {
  let s = String(v);
  for (const rx of SECRET_PATTERNS) {
    rx.lastIndex = 0;
    s = s.replace(rx, '[REDACTED]');
  }
  return s;
}

/* Campos largos que inundan el log y pueden arrastrar secretos: se recortan aquí, que es
   la forma «lista para guardar» de los args. El tope que NO depende de esta lista vive en
   `log()` (ver `acotarCadenas`): es el único sitio por el que pasa todo lo que se escribe. */
const TRUNCATE_KEYS = new Set(['content', 'text', 'body', 'result', 'output', 'command', 'error']);
const MAX_ARG_CHARS = 300;

/* --------------------------------------------------------------------------- *
 *  Texto libre que puede ser un secreto aunque la clave no lo diga.
 *
 *  La clave `text` de un `browser_control` no dice nada por sí sola: escribir
 *  «hunter2» en `#password` es una contraseña, y escribir «Madrid» en `#ciudad`
 *  no lo es. Lo decide el CAMPO (selector/name/id) con la misma tabla que exige
 *  confirmación al escribir (SENSITIVE_FIELD_RX), así que fuera de un campo
 *  sensible el texto se sigue leyendo: saber QUÉ se escribió es justo lo que
 *  hace útil el log al depurar un formulario.
 *  El portapapeles y la expresión de `eval` no tienen campo que los blanquee:
 *  se enmascaran siempre. Se tapa el VALOR, no la clave: `[REDACTED n chars]`
 *  deja ver que había algo y de qué tamaño, nunca el contenido.
 * --------------------------------------------------------------------------- */

/** ¿Este texto libre puede llevar un secreto? (misma tabla que la confirmación). */
function textoLibreSensible(tool, args, key) {
  const accion = String((args && args.action) || '');
  if (tool === 'clipboard') return accion === 'write' && (key === 'text' || key === 'content');
  if (tool !== 'browser_control') return false;
  if (accion === 'eval') return key === 'expression';
  if (accion !== 'type' || key !== 'text') return false;
  const campo = [args.selector, args.name, args.id].map((x) => String(x || '')).join(' ');
  return SENSITIVE_FIELD_RX.test(campo);
}

/** Copia de los args con el texto libre potencialmente secreto enmascarado. */
function enmascararArgs(tool, args) {
  if (!args || typeof args !== 'object') return args;
  let out = args;
  for (const k of Object.keys(args)) {
    if (typeof args[k] !== 'string') continue;
    if (!textoLibreSensible(tool, args, k)) continue;
    if (out === args) out = { ...args };
    out[k] = '[REDACTED ' + args[k].length + ' chars]';
  }
  return out;
}

function redactValue(key, v, tool) {
  if (typeof v === 'string') {
    if (SECRET_KEYS.has(normKey(key))) return '[REDACTED]';
    if (TRUNCATE_KEYS.has(normKey(key)) && v.length > MAX_ARG_CHARS) {
      /* Primero se enmascaran los patrones y DESPUÉS se recorta: al revés, un secreto que
         cayera justo en el corte se escribiría a medias. */
      return redactText(v).slice(0, MAX_ARG_CHARS) + '…[truncado]';
    }
    return redactText(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(key, x, tool));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactValue(k, v[k], tool);
    return out;
  }
  return v;
}

/** Args de una herramienta listos para guardar: secretos fuera, largos recortados. */
function redactToolArgs(tool, args) {
  if (!args || typeof args !== 'object') return args;
  const limpios = enmascararArgs(tool, args); // texto libre que puede ser un secreto
  const out = {};
  for (const k of Object.keys(limpios)) out[k] = redactValue(k, limpios[k], tool);
  return out;
}

function redactEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const out = { ...event };
  if (out.args && typeof out.args === 'object') out.args = redactToolArgs(out.tool, out.args);
  if (typeof out.error === 'string') out.error = redactText(out.error.slice(0, 200));
  return out;
}

/** Tope DURO a cualquier cadena del evento, esté donde esté y se llame como se llame.
    `redactValue` recorta por lista de claves; esto recorta por tamaño, sin lista: una
    clave nueva (`old_string`/`new_string` de una edición, o la que traiga mañana otra
    herramienta) no puede depender de que alguien se acuerde de añadirla. Va en `log`, el
    único sitio que escribe en disco, y DESPUÉS de enmascarar: un secreto que caiga en el
    corte ya está fuera. */
function acotarCadenas(v, max = MAX_ARG_CHARS) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…[truncado]' : v;
  if (Array.isArray(v)) return v.map((x) => acotarCadenas(x, max));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = acotarCadenas(v[k], max);
    return out;
  }
  return v;
}

/** Append one structured event. Never throws — logging must not break the agent. */
function log(event) {
  let s = ensureStream();
  if (!s) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...acotarCadenas(redactEvent(event)) }) + '\n';
    // El tope se mide en BYTES, no en caracteres: con acentos y eñes (y emojis)
    // un `line.length` en UTF-16 subestima el tamaño real hasta 3-4×, así que el
    // fichero crecía muy por encima de MAX_BYTES antes de rotar.
    const size = Buffer.byteLength(line, 'utf8');
    // el tope también se aplica dentro de la sesión, no solo al arrancar
    if (written + size > MAX_BYTES) {
      try {
        stream && stream.end();
      } catch {}
      stream = null;
      s = ensureStream();
      if (!s) return;
    }
    written += size;
    s.write(line);
  } catch {}
}

function currentLogFile() {
  return currentFile;
}

/** Últimas líneas de un archivo sin cargarlo entero (los logs pueden ser grandes). */
function tailLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // la primera línea puede venir cortada
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the last N events across all log files (newest last), for the dev panel. */
function readRecent(n = 200) {
  const out = [];
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .slice(-3);
    for (const f of files) {
      for (const l of tailLines(path.join(LOG_DIR, f), 512 * 1024)) {
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
    }
  } catch {}
  return out.slice(-n);
}

function close() {
  try {
    stream && stream.end();
  } catch {}
  stream = null;
}

module.exports = {
  log,
  readRecent,
  currentLogFile,
  close,
  LOG_DIR,
  redactToolArgs,
  redactEvent,
  enmascararArgs,
  /* Patrones de secreto en texto libre (`Bearer …`, `sk-…`, JWT…). Se exporta para que
     quien persista texto fuera del log —la traza del turno en `main/traza.js`— use esta
     misma tabla en vez de copiarla: dos listas divergen y una se queda vieja. */
  redactText,
  /* Redirige el almacén y los topes para poder probar rotación y tamaño sin
     escribir 8 MB ni tocar los logs reales del usuario. */
  __test: {
    _resetForTests: ({ dir, maxBytes, maxLogs } = {}) => {
      // Una poda en curso no debe tocar el almacén que se configura ahora: puede
      // seguir reintentando segundos después de cambiar de carpeta.
      clearTimeout(pruneTimer);
      try {
        stream && stream.end();
      } catch {}
      stream = null;
      currentFile = null;
      written = 0;
      LOG_DIR = dir || LOG_DIR_DEFAULT;
      MAX_BYTES = maxBytes || 8 * 1024 * 1024;
      MAX_LOGS = maxLogs || 20;
    },
  },
};
