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
const crypto = require('crypto');

let TASKS_DIR = path.join(require('./datadir').dataDir(), 'tasks');
const HISTORY_MAX = 60; // eventos conservados por run.json

const ALL_STATUS = ['pending', 'scheduled', 'running', 'paused', 'interrupted', 'failed', 'completed', 'cancelled'];
const LIVE_STATUS = ['running', 'pending', 'scheduled']; // vivos: no se borran sin detenerlos antes
const ARCHIVED_STATUS = ['completed', 'failed', 'cancelled']; // histórico (sujeto a poda)

function dirFor(status) {
  if (status === 'completed') return path.join(TASKS_DIR, 'completed');
  if (status === 'failed') return path.join(TASKS_DIR, 'failed');
  if (status === 'cancelled') return path.join(TASKS_DIR, 'cancelled');
  return TASKS_DIR;
}

/* El runId es el ÚNICO id que llega del renderer y termina dentro de una ruta
   (`tasks/<status>/<runId>/run.json`). Sin comprobarlo, un `..\..\..\Temp\victima`
   hacía que `remove()` borrara recursivamente una carpeta cualquiera del disco y que
   pause/cancel reescribieran un `run.json` de fuera. Mismo trato que los demás ids que
   también acaban en una ruta: `safeSkillDir` (skills), `rawId` (MCP) y el hash de los
   perfiles de navegador. Rechaza separadores, `..`, rutas absolutas y nombres vacíos.
   @returns {string|null} el id normalizado, o null si no es un runId. */
const RUN_ID_RX = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
function safeRunId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || s === '.' || s === '..') return null;
  if (s.includes('..') || /[\\/]/.test(s) || path.isAbsolute(s) || path.win32.isAbsolute(s)) return null;
  return RUN_ID_RX.test(s) ? s : null;
}

function fileFor(run) {
  const id = safeRunId(run && run.runId);
  return id ? path.join(dirFor(run.status), id, 'run.json') : null;
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

/** Copias persistidas de un run (puede haber más de una si un save anterior murió a medias). */
function copiesOf(runId) {
  const out = [];
  const id = safeRunId(runId);
  if (!id) return out; // un id con recorrido no puede leer fuera del almacén
  for (const s of ALL_STATUS) {
    const file = path.join(dirFor(s), id, 'run.json');
    try {
      out.push({ file, run: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {}
  }
  return out;
}

/** Ordena copias por recencia; en empate gana 'cancelled' (terminal) y luego ALL_STATUS. */
function newerCopy(a, b) {
  const t = String(b.run.updatedAt || '').localeCompare(String(a.run.updatedAt || ''));
  if (t) return t;
  const ca = a.run.status === 'cancelled' ? 1 : 0;
  const cb = b.run.status === 'cancelled' ? 1 : 0;
  if (ca !== cb) return cb - ca;
  return ALL_STATUS.indexOf(a.run.status) - ALL_STATUS.indexOf(b.run.status);
}

/** runId único: UUID (formato anterior como fallback) verificando que no exista ya. */
function newRunId() {
  for (let i = 0; i < 5; i++) {
    let id = null;
    try {
      id = crypto.randomUUID();
    } catch {}
    if (!id) break; // Node sin randomUUID: usa el formato clásico
    if (!copiesOf(id).length) return id;
  }
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function newRun({ goal, mode, step, status = 'running', scheduledAt = null, origin = 'chat' }) {
  return {
    runId: newRunId(),
    status: ALL_STATUS.includes(status) ? status : 'running',
    // El objetivo se guarda entero: el prompt de reanudación se construye desde
    // aquí, así que recortarlo hacía que una tarea larga se retomara con el
    // enunciado mutilado. Solo se acota para no escribir un fichero absurdo.
    goal: String(goal || '').slice(0, 4000),
    mode: mode || 'act',
    step: step || 'EXECUTE',
    scheduledAt: scheduledAt || null, // ISO: tarea programada (v1.3)
    origin, // 'chat' | 'background' | 'scheduled'
    lastOkStep: null,
    plan: [],
    history: [],
    lastError: null,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Guarda (o mueve de carpeta si cambió el estado) el run.json de una tarea. Nunca lanza. */
function save(run) {
  if (!run || !run.runId || run.removed) return run;
  const copies = copiesOf(run.runId);
  // La cancelación es terminal e irreversible: ni el objeto vivo (marcado por el
  // TaskManager) ni una copia ya persistida como 'cancelled' pueden volver a running.
  if (run.cancelRequested || copies.some((c) => c.run.status === 'cancelled')) {
    run.cancelRequested = true;
    run.status = 'cancelled';
  }
  run.updatedAt = new Date().toISOString();
  try {
    const dest = fileFor(run);
    if (!dest) return run; // runId no válido: no se escribe fuera del almacén
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    const copy = { ...run };
    delete copy.cancelRequested; // marcas de control en vivo: no forman parte del checkpoint
    delete copy.removed;
    if (copy.history && copy.history.length > HISTORY_MAX) copy.history = copy.history.slice(-HISTORY_MAX);
    atomicWrite(dest, JSON.stringify(copy, null, 2));
    // Elimina copias obsoletas del mismo run en OTRAS carpetas; el destino ya está
    // escrito, así que nunca se borra antes de renombrar (EPERM/EBUSY de Windows).
    for (const c of copies) {
      const dir = path.dirname(c.file);
      if (dir === destDir) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  } catch (e) {
    console.error('checkpoints.save', e.message);
  }
  // poda solo al archivar (una vez por tarea): el histórico no puede crecer sin techo
  if (ARCHIVED_STATUS.includes(run.status)) pruneArchived();
  return run;
}

/** Poda las carpetas de histórico: el agente crea un run por tarea y nada los
    borraba, así que `list()` (síncrono, en el hilo que pinta la interfaz) acababa
    leyendo y parseando cientos de run.json. Conserva los más recientes. */
const ARCHIVE_KEEP = 200;
function pruneArchived(keep = ARCHIVE_KEEP) {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const base = dirFor(status);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    if (entries.length <= keep) continue;
    const dated = entries
      .map((e) => {
        let t = 0;
        try {
          t = fs.statSync(path.join(base, e.name)).mtimeMs;
        } catch {}
        return { name: e.name, t };
      })
      .sort((a, b) => b.t - a.t);
    for (const e of dated.slice(keep)) {
      try {
        fs.rmSync(path.join(base, e.name), { recursive: true, force: true });
      } catch {}
    }
  }
}

/** Lee la copia más reciente de un run (no la primera carpeta de ALL_STATUS). */
function read(runId) {
  const copies = copiesOf(runId);
  if (!copies.length) return null;
  copies.sort(newerCopy);
  return copies[0].run;
}

/** Lista tareas por carpeta. status='all' → activas + histórico. */
function list(status = 'all') {
  const out = [];
  const ARCHIVED = ['completed', 'failed', 'cancelled'];
  const dirs =
    status === 'all'
      ? [
          ['', null],
          ['completed', null],
          ['failed', null],
          ['cancelled', null],
        ]
      : status === 'active'
        ? [['', null]] // SOLO activas: pending|scheduled|running|paused|interrupted
        : [[ARCHIVED.includes(status) ? status : '', null]];
  for (const [sub] of dirs) {
    const base = sub ? path.join(TASKS_DIR, sub) : TASKS_DIR;
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(base, e.name, 'run.json');
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.push({
          runId: r.runId,
          status: r.status,
          goal: r.goal,
          step: r.step,
          mode: r.mode,
          lastOkStep: r.lastOkStep,
          lastError: r.lastError,
          result: r.result,
          scheduledAt: r.scheduledAt || null,
          origin: r.origin || 'chat',
          steps: (r.history || []).length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      } catch {}
    }
  }
  // Un run puede quedar en dos carpetas si un save murió a medias: manda la copia
  // más reciente (misma regla que read()) para no imponer un estado viejo.
  const byId = new Map();
  for (const t of out) {
    const prev = byId.get(t.runId);
    if (!prev || newerCopy({ run: t }, { run: prev }) < 0) byId.set(t.runId, t);
  }
  return [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
function setStep(run, step) {
  if (run) {
    run.step = step;
    save(run);
  }
  return run;
}

/** Registra un fallo: qué paso falló y por qué. */
function fail(run, { step, tool, message }) {
  if (!run) return run;
  run.lastError = {
    step: step || run.step,
    tool: tool || null,
    message: String(message || '').slice(0, 500),
    ts: new Date().toISOString(),
  };
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

function pause(run) {
  if (run) {
    run.status = 'paused';
    save(run);
  }
  return run;
}
function resume(run) {
  if (run) {
    run.status = 'running';
    save(run);
  }
  return run;
}

/** Marca como interrumpida (crash/cierre): candidata a recuperación. */
function interrupt(run) {
  if (run) {
    run.status = 'interrupted';
    save(run);
  }
  return run;
}

/** v1.3: cambia a cualquier estado (cola del TaskManager). */
function setStatus(run, status) {
  if (run && ALL_STATUS.includes(status)) {
    run.status = status;
    save(run);
  }
  return run;
}

/** v1.3: cancelación — la tarea deja de estar activa y se archiva como cancelled. */
function cancel(run, reason) {
  if (!run) return run;
  run.cancelRequested = true; // irreversible: ninguna escritura posterior puede reactivarla
  run.status = 'cancelled';
  run.lastError = {
    step: run.step || 'EXECUTE',
    tool: null,
    message: String(reason || 'Cancelada por el usuario').slice(0, 300),
    ts: new Date().toISOString(),
  };
  return save(run);
}

/** Tareas recuperables: interrumpidas (y pausadas si el usuario lo pide). */
function recoverable() {
  return list('active').filter((t) => t.status === 'interrupted' || t.status === 'paused');
}

/**
 * Borra una tarea del disco. Rechaza los estados vivos (running/pending/scheduled):
 * borrarlos dejaría al agente huérfano ejecutando efectos y el siguiente save
 * recrearía la carpeta. El TaskManager usa remove() tras detener el agente.
 */
function remove(runId) {
  const id = safeRunId(runId);
  if (!id) return { ok: false, error: 'Identificador de tarea no válido.' };
  const run = read(id);
  if (!run) return { ok: false, error: 'Tarea no encontrada.' };
  if (LIVE_STATUS.includes(run.status)) {
    return { ok: false, error: 'La tarea está ' + run.status + ': deténla o cancélala antes de borrarla.' };
  }
  let fallos = 0;
  /* `fs.rmSync(..., { force: true })` NO falla si la ruta no existe, así que contar los
     intentos como «éxito» no decía nada: de las 8 carpetas de estado basta que 7 no
     existan para que el borrado se diera por bueno aunque la que SÍ existía no se
     pudiera borrar (EPERM/EBUSY típicos de Windows: antivirus, fichero abierto). Se
     mira el resultado de verdad: solo cuenta lo que existía y hay que comprobar que ya
     no está. Si queda algo, la tarea reaparecería al listar y la interfaz no puede
     decir «eliminada». */
  for (const s of ALL_STATUS) {
    const dir = path.join(dirFor(s), id);
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      fallos++;
    }
    if (fs.existsSync(dir)) fallos++;
  }
  if (fallos > 0) return { ok: false, error: 'No se pudo borrar la tarea del disco.' };
  return { ok: true };
}

/** Para tests: redirige el directorio de tareas. */
function _resetForTests(dir) {
  TASKS_DIR = dir;
}
function _dir() {
  return TASKS_DIR;
}

module.exports = {
  newRun,
  save,
  read,
  list,
  record,
  setStep,
  fail,
  complete,
  pause,
  resume,
  interrupt,
  cancel,
  setStatus,
  recoverable,
  remove,
  safeRunId,
  _dir,
  __test: { _resetForTests, ALL_STATUS, LIVE_STATUS, ARCHIVED_STATUS, ARCHIVE_KEEP, copiesOf, pruneArchived },
};
