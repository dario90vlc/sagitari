'use strict';

/* ipc-tareas.js — router IPC del dominio tareas/seguridad/meta.
 *
 * Sexto router de la fase 4: cola de tareas en background (tasks:*),
 * confirmaciones y política de seguridad (sec:*), vista agregada para
 * la UI (meta:get) y registro reciente (logs:recent).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - persistConfig(): guarda config en disco, devuelve { ok, error }
 *   - getTaskManager(): crea/devuelve el gestor (enqueue/resume, como wireTaskManager)
 *   - peekTaskManager(): gestor vivo o null SIN crearlo (list/pause/cancel/remove)
 *   - checkpoints: persistencia de tareas (fallback de list/remove sin gestor)
 *   - getAgent(): agente del chat vivo o null
 *   - securityDefaults, DEFAULT_RISK, CONFIG_DIR: constantes de seguridad
 *   - runlog: registro de sesión (readRecent/currentLogFile)
 *   - getWin(): ventana de chat (o null si está destruida)
 */

function registerTareasIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const tm = () => ctx.getTaskManager();
  const tmPeek = () => ctx.peekTaskManager();
  const ag = () => ctx.getAgent();
  const { persistConfig, checkpoints, securityDefaults, DEFAULT_RISK, CONFIG_DIR, runlog } = ctx;

// ---- v1.2/v1.3 tareas: cola en background, listado, pausa, cancelar, borrar ----
ipcMain.handle('tasks:list', () => (tmPeek() ? tmPeek().list() : checkpoints.list('all')));
ipcMain.handle('tasks:enqueue', (e, data) => tm().enqueue({
  goal: data && data.goal,
  mode: (data && data.mode) || 'act',
  scheduledAt: (data && data.scheduledAt) || null,
  origin: (data && data.scheduledAt) ? 'scheduled' : 'background',
}));
ipcMain.handle('tasks:pause', (e, runId) => (tmPeek() ? tmPeek().pause(String(runId || '')) : { ok: false, error: 'sin gestor de tareas' }));
ipcMain.handle('tasks:resume', (e, runId) => tm().resume(String(runId || '')));
ipcMain.handle('tasks:cancel', (e, runId) => (tmPeek() ? tmPeek().cancel(String(runId || '')) : { ok: false, error: 'sin gestor de tareas' }));
// borrar una tarea viva exige parar su agente: checkpoints.remove rechaza los
// estados vivos, así que el borrado pasa por el gestor (que sí detiene y olvida)
ipcMain.handle('tasks:remove', (e, runId) => (tmPeek() ? tmPeek().remove(String(runId || '')) : checkpoints.remove(String(runId || ''))));

// ---- v1.1 seguridad: confirmaciones, permisos, guardarraíles, métricas ----
// v1.3: la confirmación puede ir dirigida a un agente de background (runId)
ipcMain.handle('sec:resolve', (e, { id, approved, runId }) => {
  if (runId && tmPeek()) {
    const a = tmPeek().agents.get(String(runId));
    if (a) return { ok: !!a.resolveConfirm(id, approved) };
  }
  if (ag() && ag().resolveConfirm(id, approved)) return { ok: true };
  // v1.4: confirmaciones de SUBAGENTES (instancias sin registrar en main)
  const { Agent } = require('../agent/agent');
  if (Agent.routeConfirm(String(id || ''), approved)) return { ok: true };
  // ninguna confirmación viva con ese id: antes se respondía ok y el renderer no
  // podía distinguir «resuelta» de «ya no existe»
  return { ok: false, error: 'la confirmación ya no está pendiente' };
});
ipcMain.handle('sec:setToolPerm', (e, { tool, level }) => {
  if (!cfg().security) cfg().security = { permissions: {}, guardrails: securityDefaults.guardrails };
  if (level === 'default') delete cfg().security.permissions[tool];
  else cfg().security.permissions[tool] = String(level);
  if (ag()) ag().setPolicy(cfg().security);
  return { ...persistConfig(), permissions: cfg().security.permissions };
});
ipcMain.handle('sec:setGuardrail', (e, patch) => {
  if (!cfg().security) cfg().security = { permissions: {}, guardrails: securityDefaults.guardrails };
  const g = cfg().security.guardrails;
  // Con un umbral de bucle 0 o 1 la detección salta en la PRIMERA herramienta
  // (cualquier tarea moriría al arrancar): se exige el mínimo que detecta algo.
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in g)) continue;
    g[k] = Math.max(k === 'loopThreshold' ? 2 : 0, Math.floor(Number(v) || 0));
  }
  if (ag()) ag().setPolicy(cfg().security);
  return { ...persistConfig(), guardrails: g };
});
ipcMain.handle('meta:get', () => {
  const g = (cfg().security && cfg().security.guardrails) || {};
  return {
    model: (cfg().active && cfg().active.model) || null,
    guardrails: g,
    permissions: (cfg().security && cfg().security.permissions) || {},
    riskDefaults: DEFAULT_RISK,          // nivel de riesgo recomendado por herramienta
    guardrailDefaults: securityDefaults.guardrails,   // fuente única de los «valores recomendados»
    dataDir: CONFIG_DIR,                 // carpeta de datos del usuario
    run: ag() ? ag().getMeta() : null,
    tasks: tmPeek() ? tmPeek().list() : [],
    logFile: runlog.currentLogFile(),
  };
});
ipcMain.handle('logs:recent', (e, n) => runlog.readRecent(Number(n) || 200));

}

module.exports = { registerTareasIpc };
