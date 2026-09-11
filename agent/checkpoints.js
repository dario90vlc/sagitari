'use strict';

/* Checkpoints y recuperación de tareas de SAGITARI (v1.2; v1.3 añade estados de cola).
   Persiste el estado de una tarea larga para poder pausar, reanudar, recuperar
   tras un cierre/crash y mostrar qué paso falló y por qué.

   Estructura en %APPDATA%/SagitariAI/tasks/<runId>/run.json:
     { runId, status: 'pending'|'scheduled'|'running'|'paused'|'interrupted'|'failed'|'completed'|'cancelled',
       goal, mode, createdAt, updatedAt, scheduledAt, origin, result,
       step: 'UNDERSTAND'|'PLAN'|'EXECUTE'|'VERIFY'|'RECOVER'|'DONE',
       lastOkStep, plan: [...], history: [{step, tool, args, ok, summary, ts}] (recortado),
       lastError: { step, tool, message } | null }

   Carpetas lógicas: tasks/ (activas: pending|scheduled|running|paused|interrupted),
   tasks/completed/, tasks/failed/ y tasks/cancelled/ (histórico). */

const fs = require('fs');
const path = require('path');

let TASKS_DIR = path.join(process.env.APPDATA || require('os').homedir(), 'SagitariAI', 'tasks');
const HISTORY_MAX = 60;   // eventos conservados por run.json

const ALL_STATUS = ['pending', 'scheduled', 'running', 'paused', 'interrupted', 'failed', 'completed', 'cancelled'];

function dirFor(status) {
  if (status === 'completed') return path.join(TASKS_DIR, 'completed');
  if (status === 'failed') return path.join(TASKS_DIR, 'failed');
  if (status === 'cancelled') return path.join(TASKS_DIR, 'cancelled');
  return TASKS_DIR;
}

function fileFor(run) { return path.join(dirFor(run.status), run.runId, 'run.json'); }

function newRun({ goal, mode, step, status = 'running', scheduledAt = null, origin = 'chat' }) {
  return {
    runId: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    status: ALL_STATUS.includes(status) ? status : 'running',
    goal: String(goal || '').slice(0, 400),
    mode: mode || 'act',
    step: step || 'EXECUTE',
    scheduledAt: scheduledAt || null,   // ISO: tarea programada (v1.3)
    origin,                              // 'chat' | 'background' | 'scheduled'
    lastOkStep: null,
    plan: [],
    history: [],
    lastError: null,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Guarda (o mueve si cambió el estado) el run.json de una tarea. Nunca lanza. */
function save(run) {
  if (!run || !run.runId) return run;
  run.updatedAt = new Date().toISOString();
  try {
    const dest = fileFor(run);
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    // Mueve el run.json si vivía en otra carpeta (p.ej. activa → completed) y
    // elimina la copia obsoleta: read() debe devolver SIEMPRE el estado nuevo.
    for (const s of ALL_STATUS) {
      const otherDir = path.join(dirFor(s), run.runId);
      if (otherDir === destDir) continue;
      if (fs.existsSync(path.join(otherDir, 'run.json'))) {
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.renameSync(otherDir, destDir);
        break;   // tras esta corrección la tarea solo vive en un sitio
      }
    }
    const copy = { ...run };
    if (copy.history && copy.history.length > HISTORY_MAX) copy.history = copy.history.slice(-HISTORY_MAX);
    fs.writeFileSync(dest, JSON.stringify(copy, null, 2), 'utf8');
  } catch (e) { console.error('checkpoints.save', e.message); }
  return run;
}

function read(runId) {
  for (const s of ALL_STATUS) {
    const f = path.join(dirFor(s), runId, 'run.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}

/** Lista tareas por carpeta. status='all' → activas + histórico. */
function list(status = 'all') {
  const out = [];
  const ARCHIVED = ['completed', 'failed', 'cancelled'];
  const dirs = status === 'all'
    ? [['', null], ['completed', null], ['failed', null], ['cancelled', null]]
    : status === 'active'
      ? [['', null]]                                // SOLO activas: pending|scheduled|running|paused|interrupted
      : [[ARCHIVED.includes(status) ? status : '', null]];
  for (const [sub] of dirs) {
    const base = sub ? path.join(TASKS_DIR, sub) : TASKS_DIR;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(base, e.name, 'run.json');
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.push({
          runId: r.runId, status: r.status, goal: r.goal, step: r.step, mode: r.mode,
          lastOkStep: r.lastOkStep, lastError: r.lastError, result: r.result,
          scheduledAt: r.scheduledAt || null, origin: r.origin || 'chat',
          steps: (r.history || []).length,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        });
      } catch {}
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Añade un evento al historial y persiste (checkpoint del último paso completado). */
function record(run, event) {
  if (!run) return run;
  run.history = run.history || [];
  run.history.push({ ts: new Date().toISOString(), ...event });
  if (event.ok !== false) run.lastOkStep = event.step || run.step;
  return save(run);
}

/** Marca el paso actual. */
function setStep(run, step) { if (run) { run.step = step; save(run); } return run; }

/** Registra un fallo: qué paso falló y por qué. */
function fail(run, { step, tool, message }) {
  if (!run) return run;
  run.lastError = { step: step || run.step, tool: tool || null, message: String(message || '').slice(0, 500), ts: new Date().toISOString() };
  run.status = 'failed';
  return save(run);
}

function complete(run, result) {
  if (!run) return run;
  run.status = 'completed';
  run.result = String(result || '').slice(0, 2000);
  run.step = 'DONE';
  return save(run);
}

function pause(run) { if (run) { run.status = 'paused'; save(run); } return run; }
function resume(run) { if (run) { run.status = 'running'; save(run); } return run; }

/** Marca como interrumpida (crash/cierre): candidata a recuperación. */
function interrupt(run) { if (run) { run.status = 'interrupted'; save(run); } return run; }

/** v1.3: cambia a cualquier estado (cola del TaskManager). */
function setStatus(run, status) {
  if (run && ALL_STATUS.includes(status)) { run.status = status; save(run); }
  return run;
}

/** v1.3: cancelación — la tarea deja de estar activa y se archiva como cancelled. */
function cancel(run, reason) {
  if (!run) return run;
  run.status = 'cancelled';
  run.lastError = { step: run.step || 'EXECUTE', tool: null, message: String(reason || 'Cancelada por el usuario').slice(0, 300), ts: new Date().toISOString() };
  return save(run);
}

/** Tareas recuperables: interrumpidas (y pausadas si el usuario lo pide). */
function recoverable() {
  return list('active').filter(t => t.status === 'interrupted' || t.status === 'paused');
}

/** Borra una tarea del disco. */
function remove(runId) {
  for (const s of ALL_STATUS) {
    try { fs.rmSync(path.join(dirFor(s), runId), { recursive: true, force: true }); } catch {}
  }
  return { ok: true };
}

/** Para tests: redirige el directorio de tareas. */
function _resetForTests(dir) { TASKS_DIR = dir; }
function _dir() { return TASKS_DIR; }

module.exports = { newRun, save, read, list, record, setStep, fail, complete, pause, resume, interrupt, cancel, setStatus, recoverable, remove, _dir, __test: { _resetForTests, ALL_STATUS } };
