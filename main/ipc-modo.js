'use strict';

/* ipc-modo.js — router IPC del dominio modo/agentes/market.
 *
 * Noveno router de la fase 4: preferencia de modo (mode:set), datos vivos
 * del panel de agentes (agents:live), catálogo de skills (market:*) y
 * apertura de la carpeta de skills (skills:openFolder).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - saveConfig(): persiste la configuración
 *   - runtimes: registro de agentes vivos por conversación (main/runtimes.js): el panel
 *     de agentes pregunta por la conversación que tiene delante
 *   - getSkills(): módulo de skills
 *   - getHabits(): módulo de hábitos (observa la preferencia de modo)
 *   - marketplace: módulo del marketplace (singleton, no cambia)
 *   - fsp: fs.promises ya importado en main
 */

function registerModoIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const { saveConfig, marketplace, fsp } = ctx;
  const runtimes = ctx.runtimes;

  // ---- agent mode (Think / Plan / Act / Equipo) — v2.0: observa la preferencia ----
  /* v4.4: el cuarto modo (EQUIPO) es una preferencia más; el motor de agent/equipo.js
     solo se monta cuando el modo activo es 'equipo', así que admitirlo aquí no cambia
     nada de los otros tres. Cualquier otro valor cae a ACT, como siempre. */
  const MODOS = ['think', 'plan', 'act', 'equipo'];
  ipcMain.handle('mode:set', (e, mode) => {
    cfg().settings.mode = MODOS.includes(mode) ? mode : 'act';
    try {
      ctx.getHabits().observe('mode', { mode: cfg().settings.mode });
    } catch {}
    // El modo se aplica en memoria igual, pero si no se pudo persistir la interfaz
    // tiene que enterarse (antes daba el cambio por bueno y al reiniciar volvía el otro).
    const saved = saveConfig();
    if (!saved.ok) return { ok: false, error: saved.error };
    return cfg().settings.mode;
  });

  // ---- agents panel data: which tools fired + activity feed ----
  /* El panel pregunta por SU conversación (convId). Sin runtime (esa conversación no ha
     lanzado nada todavía) no hay nada que contar — y no se le crea un agente por
     preguntar. Sin convId se responde por la conversación abierta, que es lo de antes. */
  ipcMain.handle('agents:live', (e, convId) => {
    const a = runtimes.peek(convId);
    return {
      running: a ? a.isBusy() : false,
      mode: cfg().settings.mode || 'act',
      toolsFired: a ? a.getToolsFired() : [],
    };
  });

  /* Registro de agentes: los siete de serie MÁS los que el usuario haya dejado en
     <datos>/agents/<id>/AGENT.md. La vista de Agentes enseñaba una vitrina fija de seis
     tarjetas que no correspondía al registro real; esto devuelve el registro de verdad,
     con el origen de cada uno para que se vea cuál viene del disco. */
  const listarAgentes = () => {
    try {
      const sub = ctx.getSubagents();
      return { ok: true, agentes: sub.listar(), carpeta: sub.carpetaUsuarios ? sub.carpetaUsuarios() : null };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), agentes: [] };
    }
  };
  ipcMain.handle('agents:list', () => listarAgentes());
  /* Recargar tras editar un AGENT.md: el registro se lee al vuelo, sin reiniciar la app. */
  ipcMain.handle('agents:reload', () => {
    try {
      ctx.getSubagents().recargar();
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), agentes: [] };
    }
    return listarAgentes();
  });

  // ---- v1.7 marketplace + v1.6 routing/health + v2.0 hábitos ----
  ipcMain.handle('market:catalog', async () => {
    const imported = (await ctx.getSkills().listSkills()).map((s) => s.source && s.source.repo).filter(Boolean);
    return marketplace.catalog(imported);
  });
  ipcMain.handle('market:search', async (e, q) => marketplace.searchGitHub(String(q || 'skill')));
  ipcMain.handle('skills:openFolder', async () => {
    const d = ctx.getSkills().skillsDir();
    await fsp.mkdir(d, { recursive: true });
    require('electron').shell.openPath(d);
  });
}

module.exports = { registerModoIpc };
