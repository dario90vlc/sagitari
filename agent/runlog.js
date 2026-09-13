'use strict';

/* Structured run logs (JSONL) for SAGITARI — one file per app session.
   Location: %APPDATA%/SagitariAI/logs/run-<timestamp>.jsonl
   Every agent/tool/model event appends one JSON line:
     { ts, agent, task, tool, action, args, durationMs, success, error, model, tokens, cost }
   Files rotate on boot (keep the newest MAX_LOGS). */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.env.APPDATA || require('os').homedir(), 'SagitariAI', 'logs');
const MAX_LOGS = 20;
const MAX_BYTES = 8 * 1024 * 1024;   // tope por archivo: una sesión larga no crece sin límite

let stream = null;
let currentFile = null;
let written = 0;   // bytes escritos en el archivo actual

function openStream() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // rotate: keep newest MAX_LOGS-1, this session opens a new one
  const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort();
  while (files.length >= MAX_LOGS) {
    try { fs.unlinkSync(path.join(LOG_DIR, files.shift())); } catch {}
  }
  currentFile = path.join(LOG_DIR, 'run-' + Date.now() + '.jsonl');
  written = 0;
  stream = fs.createWriteStream(currentFile, { flags: 'a' });
  stream.on('error', () => { stream = null; });
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

module.exports = { log, readRecent, currentLogFile, close, LOG_DIR };
