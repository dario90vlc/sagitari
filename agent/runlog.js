'use strict';

/* Structured run logs (JSONL) for SAGITARI — one file per app session.
   Location: %APPDATA%/SagitariAI/logs/run-<timestamp>.jsonl
   Every agent/tool/model event appends one JSON line:
     { ts, agent, task, tool, action, args, durationMs, success, error, model, tokens, cost }
   Files rotate on boot (keep the newest MAX_LOGS). */

const fs = require('fs');
const path = require('path');

const LOG_DIR_DEFAULT = path.join(require('./datadir').dataDir(), 'logs');
let LOG_DIR = LOG_DIR_DEFAULT;
let MAX_LOGS = 20;
let MAX_BYTES = 8 * 1024 * 1024;   // tope por archivo: una sesión larga no crece sin límite

let stream = null;
let currentFile = null;
let written = 0;   // bytes escritos en el archivo actual

let pruneTimer = null;
const nombresUsados = new Set();   // nombres abiertos en esta sesión (unicidad en memoria)

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
      try { files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort(); } catch { return; }
      const activo = currentFile && path.basename(currentFile);
      const otros = files.filter(f => f !== activo);
      const pendientes = otros.slice(0, Math.max(0, otros.length - (MAX_LOGS - 1)));
      for (const f of pendientes) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); nombresUsados.delete(f); }
        catch (e) { if (e.code !== 'ENOENT') continue; } // ENOENT: ya no está
      }
      // Los write streams crean sus archivos de forma asíncrona. Releer la carpeta
      // evita que una poda temprana vea solo el archivo activo y deje los demás.
      if (intento < 10) {
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
  stream.on('error', () => { stream = null; });
  pruneOldLogs();
  return stream;
}

function ensureStream() {
  if (stream) return stream;
  try { return openStream(); } catch { stream = null; return null; }
}

/** Append one structured event. Never throws — logging must not break the agent. */
function log(event) {
  let s = ensureStream();
  if (!s) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    // El tope se mide en BYTES, no en caracteres: con acentos y eñes (y emojis)
    // un `line.length` en UTF-16 subestima el tamaño real hasta 3-4×, así que el
    // fichero crecía muy por encima de MAX_BYTES antes de rotar.
    const size = Buffer.byteLength(line, 'utf8');
    // el tope también se aplica dentro de la sesión, no solo al arrancar
    if (written + size > MAX_BYTES) {
      try { stream && stream.end(); } catch {}
      stream = null;
      s = ensureStream();
      if (!s) return;
    }
    written += size;
    s.write(line);
  } catch {}
}

function currentLogFile() { return currentFile; }

/** Últimas líneas de un archivo sin cargarlo entero (los logs pueden ser grandes). */
function tailLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();   // la primera línea puede venir cortada
    return lines.filter(Boolean);
  } finally { fs.closeSync(fd); }
}

/** Read the last N events across all log files (newest last), for the dev panel. */
function readRecent(n = 200) {
  const out = [];
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort().slice(-3);
    for (const f of files) {
      for (const l of tailLines(path.join(LOG_DIR, f), 512 * 1024)) {
        try { out.push(JSON.parse(l)); } catch {}
      }
    }
  } catch {}
  return out.slice(-n);
}

function close() { try { stream && stream.end(); } catch {} stream = null; }

module.exports = {
  log, readRecent, currentLogFile, close, LOG_DIR,
  /* Redirige el almacén y los topes para poder probar rotación y tamaño sin
     escribir 8 MB ni tocar los logs reales del usuario. */
  __test: {
    _resetForTests: ({ dir, maxBytes, maxLogs } = {}) => {
      try { stream && stream.end(); } catch {}
      stream = null; currentFile = null; written = 0;
      LOG_DIR = dir || LOG_DIR_DEFAULT;
      MAX_BYTES = maxBytes || 8 * 1024 * 1024;
      MAX_LOGS = maxLogs || 20;
    },
  },
};
