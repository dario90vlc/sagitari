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

const TICK_MS = 20 * 1000;   // revisión de tareas programadas y de la cola

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
    const a = this.agents.get(runId);
    if (a) { try { a.stop(); } catch {} this.agents.delete(runId); }
    checkpoints.cancel(run, reason || 'Cancelada por el usuario');
    this._update(run, 'Tarea cancelada');
    this.notify(run, 'cancelled');
    return { ok: true };
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
  }

  /** Llamar tras crear el manager: reintenta las tareas interrumpidas (crash/cierre). */
  autoResume() {
    const s = this.getSettings();
    if (s && s.settings && s.settings.autoResumeTasks === false) return { resumed: 0 };
    let resumed = 0;
    for (const t of checkpoints.list('active')) {
      if (t.status === 'interrupted') {
        const run = checkpoints.read(t.runId);
        if (run) {
          checkpoints.setStatus(run, 'pending');
          this._update(run, 'Tarea interrumpida recuperada — en cola');
          resumed++;
        }
      }
    }
    this._pump();
    return { resumed };
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
    checkpoints.resume(run);   // status → running
    const runRef = run;
    let agent;
    try {
      agent = this.agentFactory();
    } catch (e) {
      checkpoints.fail(runRef, { step: 'EXECUTE', message: 'No se pudo crear el agente: ' + e.message });
      this.notify(runRef, 'failed');
      return;
    }
    this.agents.set(runId, agent);
    this._update(runRef, 'Tarea iniciada en background');
    agent.chat(run.goal, settings, null, { task: runRef, background: true })
      .catch(() => {})
      .finally(() => {
        this.agents.delete(runId);
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
    } catch {}
  }

  _update(run, note) {
    this.emit({ type: 'task_update', runId: run.runId, status: run.status, goal: run.goal, note });
  }
}

module.exports = { TaskManager, TICK_MS };
