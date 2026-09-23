'use strict';

/* ipc-modo.js — router IPC del dominio modo/agentes/market.
 *
 * Noveno router de la fase 4: preferencia de modo (mode:set), datos vivos
 * del panel de agentes (agents:live), catálogo de skills (market:*) y
 * apertura de la carpeta de skills (skills:openFolder).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - saveConfig(): persiste la configuración
 *   - getAgent(): agente del chat (o null)
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
  const ag = () => ctx.getAgent();

  // ---- agent mode (Think / Plan / Act) — v2.0: observa la preferencia ----
  ipcMain.handle('mode:set', (e, mode) => {
    cfg().settings.mode = ['think', 'plan', 'act'].includes(mode) ? mode : 'act';
    try { ctx.getHabits().observe('mode', { mode: cfg().settings.mode }); } catch {}
    saveConfig();
    return cfg().settings.mode;
  });

  // ---- agents panel data: which tools fired + activity feed ----
  ipcMain.handle('agents:live', () => ({
    running: ag() ? ag().isBusy() : false,
    mode: cfg().settings.mode || 'act',
    toolsFired: ag() ? ag().getToolsFired() : []
  }));

  // ---- v1.7 marketplace + v1.6 routing/health + v2.0 hábitos ----
  ipcMain.handle('market:catalog', async () => {
    const imported = (await ctx.getSkills().listSkills()).map(s => s.source && s.source.repo).filter(Boolean);
    return marketplace.catalog(imported);
  });
  ipcMain.handle('market:search', async (e, q) => marketplace.searchGitHub(String(q || 'skill')));
  ipcMain.handle('skills:openFolder', async () => { const d = ctx.getSkills().skillsDir(); await fsp.mkdir(d, { recursive: true }); require('electron').shell.openPath(d); });
}

module.exports = { registerModoIpc };
