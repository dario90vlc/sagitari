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
 *   - runtimes: registro de agentes vivos por conversación (main/runtimes.js): las
 *     confirmaciones y la política de seguridad son POR conversación (la política, de todas)
 *   - securityDefaults, DEFAULT_RISK, CONFIG_DIR: constantes de seguridad
 *   - runlog: registro de sesión (readRecent/currentLogFile)
 *   - getWin(): ventana de chat (o null si está destruida)
 */

const { EQUIPO_PRESUPUESTO_MAX_USD } = require('./ipc-config');

/* v4.4 — topes del encargo de equipo, expuestos en meta:get para que la interfaz no los
   copie a mano. El presupuesto lo valida settings:set (ipc-config); el MÁXIMO DE
   MIEMBROS es del motor (agent/equipo.js) y se lee de su constante en vez de repetir el
   número aquí. El require es perezoso porque este router se monta antes de que el motor
   se use y no debe encadenar el arranque a ese módulo. */
let _moduloEquipo = null;
function limiteMiembrosEquipo() {
  try {
    if (!_moduloEquipo) _moduloEquipo = require('../agent/equipo');
    return _moduloEquipo.LIMITE_MIEMBROS;
  } catch {
    return null;
  }
}

function registerTareasIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const tm = () => ctx.getTaskManager();
  const tmPeek = () => ctx.peekTaskManager();
  const runtimes = ctx.runtimes;
  const { persistConfig, checkpoints, securityDefaults, DEFAULT_RISK, CONFIG_DIR, runlog } = ctx;

  // ---- v1.2/v1.3 tareas: cola en background, listado, pausa, cancelar, borrar ----
  /* El runId llega del renderer y termina dentro de una ruta (`tasks/<id>/run.json`).
     Se valida AQUÍ, antes de tocar el gestor o el almacén, con la MISMA guarda que usa
     agent/checkpoints.js (defensa en profundidad: `remove()` construye rutas y borra
     recursivamente, y pause/cancel reescriben el run.json apuntado). */
  const runIdOk = (runId) => checkpoints.safeRunId(runId);
  const ID_MALO = { ok: false, error: 'Identificador de tarea no válido.' };
  ipcMain.handle('tasks:list', () => (tmPeek() ? tmPeek().list() : checkpoints.list('all')));
  ipcMain.handle('tasks:enqueue', (e, data) =>
    tm().enqueue({
      goal: data && data.goal,
      mode: (data && data.mode) || 'act',
      scheduledAt: (data && data.scheduledAt) || null,
      origin: data && data.scheduledAt ? 'scheduled' : 'background',
    }),
  );
  ipcMain.handle('tasks:pause', (e, runId) => {
    const id = runIdOk(runId);
    if (!id) return ID_MALO;
    return tmPeek() ? tmPeek().pause(id) : { ok: false, error: 'sin gestor de tareas' };
  });
  ipcMain.handle('tasks:resume', (e, runId) => {
    const id = runIdOk(runId);
    return id ? tm().resume(id) : ID_MALO;
  });
  ipcMain.handle('tasks:cancel', (e, runId) => {
    const id = runIdOk(runId);
    if (!id) return ID_MALO;
    return tmPeek() ? tmPeek().cancel(id) : { ok: false, error: 'sin gestor de tareas' };
  });
  // borrar una tarea viva exige parar su agente: checkpoints.remove rechaza los
  // estados vivos, así que el borrado pasa por el gestor (que sí detiene y olvida)
  ipcMain.handle('tasks:remove', (e, runId) => {
    const id = runIdOk(runId);
    if (!id) return ID_MALO;
    return tmPeek() ? tmPeek().remove(id) : checkpoints.remove(id);
  });

  // ---- v1.1 seguridad: confirmaciones, permisos, guardarraíles, métricas ----
  // v1.3: la confirmación puede ir dirigida a un agente de background (runId)
  ipcMain.handle('sec:resolve', (e, { convId, id, approved, runId }) => {
    if (runId && tmPeek()) {
      const a = tmPeek().agents.get(String(runId));
      if (a) return { ok: !!a.resolveConfirm(id, approved) };
    }
    // La conversación que abrió el diálogo es la que tiene la confirmación pendiente.
    const propio = runtimes.peek(convId);
    if (propio && propio.resolveConfirm(id, approved)) return { ok: true };
    // Y si no, cualquier otra conversación viva: el id de la confirmación es único, y el
    // renderer puede no saber de cuál era (o venir de antes de este cambio).
    for (const a of runtimes.allAgents()) {
      if (a !== propio && a.resolveConfirm(id, approved)) return { ok: true };
    }
    /* v4.4: confirmaciones de COMPAÑEROS de equipo. Los compañeros son instancias de
       Agent igual que los subagentes, así que al pedir permiso se registran solos en
       `Agent.CONFIRM_ROUTES` (agent/agent.js) y la línea de abajo los resuelve por el id
       —no hace falta un registro aparte en main (lo confirmó el dueño del motor)—. */
    // v1.4: confirmaciones de SUBAGENTES (instancias sin registrar en main)
    const { Agent } = require('../agent/agent');
    if (Agent.routeConfirm(String(id || ''), approved)) return { ok: true };
    // ninguna confirmación viva con ese id: antes se respondía ok y el renderer no
    // podía distinguir «resuelta» de «ya no existe»
    return { ok: false, error: 'la confirmación ya no está pendiente' };
  });
  /* Validación de sec:setToolPerm. La clave y el nivel existían SOLO en el desplegable del
   renderer: main aceptaba cualquier nombre y cualquier nivel. Se valida contra la MISMA
   fuente que usa el resto de la app —la tabla de riesgo de agent/tools.js, que llega como
   DEFAULT_RISK— más la sub-permisión 'browser_eval' de la vista Seguridad, y el comodín por
   servidor MCP (`mcp__<slug>__*`) que guarda el renderer. */
  const NIVELES_PERMISO = ['safe', 'confirm', 'restricted'];
  const CLAVES_HERRAMIENTA = new Set([...Object.keys(DEFAULT_RISK || {}), 'browser_eval']);
  const COMODIN_MCP_RX = /^mcp__[a-z0-9_]+__\*$/;
  ipcMain.handle('sec:setToolPerm', (e, { tool, level } = {}) => {
    const t = String(tool || '');
    if (!CLAVES_HERRAMIENTA.has(t) && !COMODIN_MCP_RX.test(t)) return { ok: false, error: 'herramienta desconocida: ' + t };
    if (level !== 'default' && !NIVELES_PERMISO.includes(level)) return { ok: false, error: 'nivel no válido: ' + level };
    if (!cfg().security) cfg().security = { permissions: {}, guardrails: securityDefaults.guardrails };
    if (level === 'default') delete cfg().security.permissions[t];
    else cfg().security.permissions[t] = level;
    // la política es GLOBAL: la llevan todas las conversaciones vivas, no solo una
    for (const a of runtimes.allAgents()) a.setPolicy(cfg().security);
    return { ...persistConfig(), permissions: cfg().security.permissions };
  });
  ipcMain.handle('sec:setGuardrail', (e, patch) => {
    if (!cfg().security) cfg().security = { permissions: {}, guardrails: securityDefaults.guardrails };
    const g = cfg().security.guardrails;
    // Con un umbral de bucle 0 o 1 la detección salta en la PRIMERA herramienta
    // (cualquier tarea moriría al arrancar): se exige el mínimo que detecta algo.
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in g)) continue;
      /* `maxCostUsd` es un tope en DÓLARES y el panel lo edita con decimales (0,5 $):
         `Math.floor` lo dejaba en 0, y 0 es «sin tope» para el motor de guardarraíles
         (`agent/guardrails.js`: solo corta con `maxCostUsd > 0`), así que el guardarraíl
         que el usuario creía activo quedaba apagado. El resto de claves son cuentas
         enteras (pasos, repeticiones). */
      if (k === 'maxCostUsd') {
        const n = Number(v);
        g[k] = Number.isFinite(n) && n > 0 ? n : 0;
        continue;
      }
      g[k] = Math.max(k === 'loopThreshold' ? 2 : 0, Math.floor(Number(v) || 0));
    }
    // la política es GLOBAL: la llevan todas las conversaciones vivas, no solo una
    for (const a of runtimes.allAgents()) a.setPolicy(cfg().security);
    return { ...persistConfig(), guardrails: g };
  });
  ipcMain.handle('meta:get', (e, convId) => {
    const g = (cfg().security && cfg().security.guardrails) || {};
    const s = cfg().settings || {};
    // `run` es el estado vivo de la conversación que pregunta (su agente); el resto de
    // lo que devuelve esto es global y no depende de ninguna conversación.
    const a = runtimes.agentFor(convId);
    // v4.4: presupuesto por encargo de equipo tal y como está guardado (0 = sin tope).
    // El valor podría venir de un config viejo o tocado a mano: se sanea aquí para que
    // la interfaz nunca pinte un tope imposible.
    const presupuesto = Number(s.equipoPresupuestoUsd);
    return {
      model: (cfg().active && cfg().active.model) || null,
      guardrails: g,
      permissions: (cfg().security && cfg().security.permissions) || {},
      riskDefaults: DEFAULT_RISK, // nivel de riesgo recomendado por herramienta
      guardrailDefaults: securityDefaults.guardrails, // fuente única de los «valores recomendados»
      dataDir: CONFIG_DIR, // carpeta de datos del usuario
      run: a ? a.getMeta() : null,
      tasks: tmPeek() ? tmPeek().list() : [],
      // topes del encargo de equipo (modo EQUIPO): miembros máx. y presupuesto en USD
      equipo: {
        limiteMiembros: limiteMiembrosEquipo(),
        presupuestoUsd: Number.isFinite(presupuesto) && presupuesto >= 0 && presupuesto <= EQUIPO_PRESUPUESTO_MAX_USD ? presupuesto : 0,
      },
      logFile: runlog.currentLogFile(),
    };
  });
  ipcMain.handle('logs:recent', (e, n) => runlog.readRecent(Number(n) || 200));
}

module.exports = { registerTareasIpc };
