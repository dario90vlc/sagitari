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

let stream = null;
let currentFile = null;

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // rotate: keep newest MAX_LOGS-1, this session opens a new one
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort();
    while (files.length >= MAX_LOGS) {
      try { fs.unlinkSync(path.join(LOG_DIR, files.shift())); } catch {}
    }
    currentFile = path.join(LOG_DIR, 'run-' + Date.now() + '.jsonl');
    stream = fs.createWriteStream(currentFile, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch { stream = null; }
  return stream;
}

/** Append one structured event. Never throws — logging must not break the agent. */
function log(event) {
  const s = ensureStream();
  if (!s) return;
  try {
    const rec = { ts: new Date().toISOString(), ...event };
    s.write(JSON.stringify(rec) + '\n');
  } catch {}
}

function currentLogFile() { return currentFile; }

/** Read the last N events across all log files (newest last), for the dev panel. */
function readRecent(n = 200) {
  const out = [];
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort().slice(-3);
    for (const f of files) {
      const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
      for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
    }
  } catch {}
  return out.slice(-n);
}

function close() { try { stream && stream.end(); } catch {} stream = null; }

module.exports = { log, readRecent, currentLogFile, close, LOG_DIR };
