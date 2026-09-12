'use strict';

/* TaskManager de SAGITARI (v1.3 — Tasks + Background Agents).
   Permite que SAGITARI trabaje en segundo plano: varias tareas independientes
   sin bloquear el chat, con cola, concurrencia configurable, tareas programadas,
   pausa/cancelación y notificación al terminar.

   Cada tarea en background tiene SU PROPIO Agent (con guardrails/permisos
   propios) y su checkpoint en agent/checkpoints.js. El chat interactivo sigue
   usando el agente principal de main.js.

   Flujo de estados:
     scheduled → pending → running → completed | failed | interrupted | paused | cancelled

   Este módulo es puro Node (sin Electron): el main le inyecta
   { getSettings, agentFactory, emit, notify } para desacoplar la UI. */

const checkpoints = require('./checkpoints');
const runlog = require('./runlog');

const TICK_MS = 20 * 1000;   // revisión de tareas programadas y de la cola
const MAX_ATTEMPTS = 3;      // reintentos automáticos por tarea (autoResume)
const RETRY_BACKOFF_MS = 60 * 1000;   // backoff exponencial base
const LIVE_STATUS = ['running', 'pending', 'scheduled'];   // estados vivos (no borrables)
const RESUME_TAIL = 12;      // eventos del historial que resume el prompt de reanudación

/**
 * Prompt de reanudación: el agente nuevo arranca con history=[] así que hay que
 * darle lo ya hecho (run.history / lastOkStep) y lo pendiente (run.plan) para que
 * no repita acciones con efectos (escrituras, comandos, descargas). No toca agent.js.
 */
function buildResumePrompt(run) {
  const history = Array.isArray(run.history) ? run.history : [];
  if (!history.length) return run.goal;   // primer arranque: no hay nada que resumir
  const done = history.slice(-RESUME_TAIL)
    .filter(h => !String(h.summary || '').includes('[REANUDACIÓN]'))   // no arrastrar prompts previos
    .map(h => {
      const what = [h.step, h.tool].filter(Boolean).join(' · ');
      const detail = String(h.summary || '').replace(/\s+/g, ' ').slice(0, 160);
      const mark = h.ok === false ? 'FALLÓ' : 'ok';
      return '- ' + (what || 'paso') + ' [' + mark + ']' + (detail ? ': ' + detail : '');
    });
  const plan = (Array.isArray(run.plan) ? run.plan : [])
    .filter(p => !p || p.done !== true)
    .map(p => '- ' + (typeof p === 'string' ? p : (p.text || p.title || p.step || '')))
    .filter(l => l.length > 2);
  const parts = [
    '[REANUDACIÓN] Esta tarea ya se estaba ejecutando y se retoma ahora. NO repitas las acciones que ya se completaron; continúa a partir de lo hecho.',
    'Objetivo: ' + run.goal,
  ];
  if (run.lastOkStep) parts.push('Último paso completado: ' + run.lastOkStep);
  if (done.length) parts.push('Progreso registrado (lo más reciente):\n' + done.join('\n'));
  if (plan.length) parts.push('Pendiente según el plan:\n' + plan.join('\n'));
  if (run.lastError && run.lastError.message) parts.push('Último error: ' + run.lastError.message);
  return parts.join('\n\n');
}

class TaskManager {
  /**
   * @param {object} deps
   * @param {() => object} deps.getSettings     config completa (providers, settings, security)
   * @param {() => object} deps.agentFactory    crea un Agent nuevo ({ emit, guardrailsPolicy, ... })
   * @param {(event) => void} deps.emit         eventos hacia la UI (se les añade runId)
   * @param {(run, kind) => void} deps.notify   notificación al usuario (toast + nativa)
   */
  constructor({ getSettings, agentFactory, emit, notify }) {
    this.getSettings = getSettings || (() => ({}));
    this.agentFactory = agentFactory || (() => { throw new Error('agentFactory no configurado'); });
    this.emit = emit || (() => {});
    this.notify = notify || (() => {});
    this.agents = new Map();     // runId -> Agent en ejecución
    this._liveRuns = new Map();  // runId -> objeto run vivo que muta el agente (para cancelar/borrar)
    this._timer = setInterval(() => this._tick(), TICK_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /* ================= API pública ================= */

  /**
   * Crea una tarea y la mete en cola. Si scheduledAt es futuro queda 'scheduled';
   * si no, 'pending' y arranca en cuanto haya hueco de concurrencia.
   * @returns {object} { ok, runId }
   */
  enqueue({ goal, mode, scheduledAt = null, origin = 'background' }) {
    const text = String(goal || '').trim();
    if (!text) return { ok: false, error: 'Falta el objetivo de la tarea.' };
    let status = 'pending';
    if (scheduledAt) {
      const t = Date.parse(scheduledAt);
      if (Number.isNaN(t)) return { ok: false, error: 'Fecha de programación inválida.' };
      if (t > Date.now() + 5000) status = 'scheduled';
    }
    const run = checkpoints.newRun({ goal: text, mode: mode || 'act', status, scheduledAt, origin });
    checkpoints.save(run);
    this._update(run, 'Tarea ' + (status === 'scheduled' ? 'programada' : 'en cola'));
    this._pump();
    return { ok: true, runId: run.runId };
  }

  /** Pausa una tarea: en ejecución aborta con checkpoint; pendiente/programada pasa a pausada. */
  pause(runId) {
    const run = checkpoints.read(runId);
    if (!run) return { ok: false, error: 'Tarea no encontrada.' };
    if (run.status === 'paused') return { ok: true };   // ya está pausada: no-op
    if (run.status === 'running') {
      const a = this.agents.get(runId);
      if (a) { a.pause(); return { ok: true }; }   // el agente emite 'paused' con checkpoint
      checkpoints.pause(run);
      this._update(run, 'Tarea pausada');
      return { ok: true };
    }
    if (run.status === 'pending' || run.status === 'scheduled') {
      checkpoints.pause(run);
      this._update(run, 'Tarea pausada (estaba en cola)');
      return { ok: true };
    }
    return { ok: false, error: 'La tarea no se puede pausar en estado ' + run.status };
  }

  /** Reanuda una tarea pausada/interrupta/pendiente: la (re)arranca ahora mismo. */
  resume(runId) {
    const run = checkpoints.read(runId);
    if (!run) return { ok: false, error: 'Tarea no encontrada.' };
    if (!['paused', 'interrupted', 'pending', 'failed'].includes(run.status)) {
      return { ok: false, error: 'La tarea está ' + run.status + ' y no se puede reanudar.' };
    }
    run.attempts = 0;              // reanudación manual: presupuesto de reintentos limpio
    run.nextAttemptAt = null;
    checkpoints.setStatus(run, 'pending');
    this._update(run, 'Tarea reanudada — en cola');
    this._pump();
    return { ok: true };
  }

  /** Cancela una tarea en cualquier estado activo (archivada como cancelled). */
  cancel(runId, reason) {
    const run = checkpoints.read(runId);
    if (!run) return { ok: false, error: 'Tarea no encontrada.' };
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return { ok: false, error: 'La tarea ya está ' + run.status + '.' };
    }
    const live = this._liveRuns.get(runId);
    if (live) {
      // Marca el objeto que retiene el agente: sus record/fail/complete posteriores
      // escriben sobre él y no pueden devolver el run a 'running' (antes resucitaba).
      live.cancelRequested = true;
      live.closed = true;   // el agente deja de registrar pasos de esta tarea
    }
    const a = this.agents.get(runId);
    if (a) { try { a.stop(); } catch {} this.agents.delete(runId); }
    checkpoints.cancel(run, reason || 'Cancelada por el usuario');
    this._update(run, 'Tarea cancelada');
    this.notify(run, 'cancelled');
    return { ok: true };
  }

  /**
   * Borra una tarea definitivamente: detiene y olvida su agente y después elimina
   * los archivos. Es el camino que debe usar el IPC tasks:remove (checkpoints.remove
   * a secas rechaza los estados vivos y dejaría el agente huérfano).
   */
  remove(runId) {
    const run = checkpoints.read(runId);
    if (!run) return { ok: false, error: 'Tarea no encontrada.' };
    const a = this.agents.get(runId);
    if (a) { try { a.stop(); } catch {} this.agents.delete(runId); }
    const live = this._liveRuns.get(runId);
    if (live) {
      live.removed = true;   // ninguna escritura suya debe recrear la carpeta borrada
      live.closed = true;
      live.cancelRequested = true;
    }
    this._liveRuns.delete(runId);
    if (LIVE_STATUS.includes(run.status)) checkpoints.cancel(run, 'Eliminada por el usuario');
    const res = checkpoints.remove(runId);
    if (res.ok) this._update(run, 'Tarea eliminada');
    return res;
  }

  /** Lista de tareas con estado vivo (meta del agente si está corriendo). */
  list() {
    return checkpoints.list('all').map(t => {
      const a = this.agents.get(t.runId);
      if (a) {
        const m = a.getMeta();
        return { ...t, live: { busy: m.busy, tokensIn: m.tokensIn, tokensOut: m.tokensOut, costUsd: m.costUsd, toolCalls: m.toolCalls, toolsFired: a.getToolsFired() } };
      }
      return t;
    });
  }

  /** True si algún agente en background sigue vivo (para app quit). */
  hasRunning() { return this.agents.size > 0; }

  /** Detiene todas las tareas en background (al cerrar la app: quedan interrumpidas). */
  stopAll() {
    for (const [runId, a] of this.agents) {
      try { a.stop(); } catch {}
      const run = checkpoints.read(runId);
      if (run && run.status === 'running') checkpoints.interrupt(run);
    }
    this.agents.clear();
    this._liveRuns.clear();
  }

  /**
   * Llamar tras crear el manager: reintenta las tareas interrumpidas (crash/cierre).
   * Acotado por intentos (attempts) y backoff: no re-encola sin límite en cada arranque.
   */
  autoResume() {
    const s = this.getSettings();
    if (s && s.settings && s.settings.autoResumeTasks === false) return { resumed: 0 };
    let resumed = 0, abandoned = 0;
    for (const t of checkpoints.list('active')) {
      if (t.status !== 'interrupted') continue;
      const run = checkpoints.read(t.runId);
      if (!run) continue;
      const attempts = Number(run.attempts) || 0;
      if (attempts >= MAX_ATTEMPTS) {
        // Presupuesto agotado: se archiva como fallida y deja de re-encolarse.
        checkpoints.fail(run, { step: run.step || 'EXECUTE', tool: null, message: 'Sin reanudar: ' + attempts + ' reintentos automáticos agotados' });
        this._update(run, 'Tarea no reanudada: reintentos automáticos agotados');
        abandoned++;
        continue;
      }
      if (run.nextAttemptAt && Date.parse(run.nextAttemptAt) > Date.now()) continue;   // aún en backoff
      run.attempts = attempts + 1;
      run.nextAttemptAt = new Date(Date.now() + RETRY_BACKOFF_MS * Math.pow(2, Math.min(attempts, 6))).toISOString();
      checkpoints.setStatus(run, 'pending');
      this._update(run, 'Tarea interrumpida recuperada — en cola');
      resumed++;
    }
    this._pump();
    return { resumed, abandoned };
  }

  /** Cierra el manager (tests / quit). */
  dispose() { if (this._timer) clearInterval(this._timer); }

  /* ================= motor interno ================= */

  /** Arranca tareas pendientes hasta agotar la concurrencia configurada. */
  _pump() {
    const s = this.getSettings();
    const max = Math.max(1, Math.min(4, Number(s && s.settings && s.settings.maxConcurrentTasks) || 1));
    if (this.agents.size >= max) return;
    const pendings = checkpoints.list('active')
      .filter(t => t.status === 'pending')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));   // FIFO
    for (const t of pendings) {
      if (this.agents.size >= max) break;
      this._start(t.runId);
    }
  }

  _start(runId) {
    const run = checkpoints.read(runId);
    if (!run) return;
    const settings = this.getSettings();
    const cfg = settings && settings.active;
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      checkpoints.pause(run);
      this._update(run, 'Tarea en pausa: no hay proveedor/modelo activo');
      return;
    }
    const prompt = buildResumePrompt(run);   // reanudar lleva el progreso ya hecho
    checkpoints.resume(run);                 // status → running
    if (run.status !== 'running') {          // cancelada entre medias: no arrancar
      this._update(run, 'Tarea no iniciada: ' + run.status);
      return;
    }
    const runRef = run;
    this._liveRuns.set(runId, runRef);       // objeto vivo que retiene el agente
    let agent;
    try {
      agent = this.agentFactory();
    } catch (e) {
      this._liveRuns.delete(runId);
      this._noteFailure(runRef, 'No se pudo crear el agente: ' + e.message);
      this.notify(runRef, 'failed');
      return;
    }
    this.agents.set(runId, agent);
    this._update(runRef, 'Tarea iniciada en background');
    Promise.resolve()
      .then(() => agent.chat(prompt, settings, null, { task: runRef, background: true }))
      .then(
        () => {},
        (e) => this._chatFailed(runRef, runId, e)   // antes .catch(() => {}): el fallo se perdía
      )
      .finally(() => {
        this.agents.delete(runId);
        this._liveRuns.delete(runId);
        // estado final: el agente ya marcó completed/failed/interrupted/paused
        const after = checkpoints.read(runId);
        if (after && after.status === 'running') {
          checkpoints.interrupt(after);   // el chat terminó sin cerrar el checkpoint
        }
        const final = checkpoints.read(runId);
        if (final) this.notify(final, final.status);
        this._pump();   // siguiente tarea de la cola
      });
  }

  /** El chat de una tarea lanzó una excepción: queda registrada en disco y en el runlog. */
  _chatFailed(run, runId, e) {
    const message = 'Error en el chat de la tarea: ' + (e && e.message ? e.message : String(e));
    console.error('TaskManager: ' + runId + ' — ' + message);
    try { runlog.log({ agent: 'sagitari', task: runId, event: 'task_error', message }); } catch {}
    try {
      checkpoints.record(run, { step: run.step || 'EXECUTE', tool: null, ok: false, summary: message.slice(0, 160) });
      this._noteFailure(run, message);
    } catch (e2) { console.error('TaskManager._chatFailed', e2.message); }
  }

  /** Fallo persistente: incrementa attempts y fija el backoff para el siguiente intento. */
  _noteFailure(run, message) {
    if (!run || run.status === 'cancelled' || run.status === 'completed') return;
    const attempts = (Number(run.attempts) || 0) + 1;
    run.attempts = attempts;
    run.nextAttemptAt = new Date(Date.now() + RETRY_BACKOFF_MS * Math.pow(2, Math.min(attempts - 1, 6))).toISOString();
    checkpoints.fail(run, { step: run.step || 'EXECUTE', tool: null, message });
  }

  /** Revisión periódica: programa vencidas → pendientes, y rellena huecos de la cola. */
  _tick() {
    try {
      let due = false;
      for (const t of checkpoints.list('active')) {
        if (t.status === 'scheduled' && t.scheduledAt && Date.parse(t.scheduledAt) <= Date.now()) {
          const run = checkpoints.read(t.runId);
          if (run) { checkpoints.setStatus(run, 'pending'); due = true; this._update(run, 'Tarea programada: llega la hora'); }
        }
      }
      if (due || checkpoints.list('active').some(t => t.status === 'pending')) this._pump();
    } catch (e) {
      // Un fallo del tick no puede quedar invisible (antes: catch {} vacío).
      console.error('TaskManager._tick', e.message);
      try { runlog.log({ agent: 'sagitari', event: 'tick_error', message: e.message }); } catch {}
    }
  }

  _update(run, note) {
    this.emit({ type: 'task_update', runId: run.runId, status: run.status, goal: run.goal, note });
  }
}

module.exports = { TaskManager, TICK_MS, __test: { buildResumePrompt, MAX_ATTEMPTS, RETRY_BACKOFF_MS } };
