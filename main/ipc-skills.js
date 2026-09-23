'use strict';

/* ipc-skills.js — router IPC del dominio skills.
 *
 * Fase 4 (sigue el patrón de ipc-memory.js): los handlers son lógica sobre el
 * módulo agent/skills; el único acoplamiento con main es el registro de
 * auditoría (runlog). Ambas dependencias se inyectan:
 * registerSkillsIpc(ipcMain, { skills, runlog }).
 */

function registerSkillsIpc(ipcMain, { skills, runlog }) {
  ipcMain.handle('skills:list', () => skills.listSkills());
  ipcMain.handle('skills:toggle', async (e, { id, enabled }) => { await skills.setEnabled(id, enabled); return skills.listSkills(); });
  ipcMain.handle('skills:import', async (e, arg) => {
    // Una skill son INSTRUCCIONES que el agente obedecerá, no un texto inerte:
    // la primera llamada devuelve la vista previa y exige un segundo clic con
    // confirm:true (consentimiento informado, sin modales nativos). Acepta el
    // formato antiguo (string) para no romper llamadas existentes.
    const repo = (arg && typeof arg === 'object') ? String(arg.repo || '') : String(arg || '');
    const confirm = !!(arg && typeof arg === 'object' && arg.confirm === true);
    if (!confirm) {
      const preview = await skills.previewImport(repo);
      runlog.log({ agent: 'sagitari', event: 'skills_import_preview', repo: preview.repo, total: preview.total });
      return {
        ok: false, needsConfirm: true, preview,
        error: `«${preview.repo}» trae ${preview.total} skill(s): ` +
          preview.items.map(s => s.name).join(', ') +
          (preview.truncated ? `… (y más)` : '') +
          `. Son instrucciones que el agente obedecerá: pulsa Importar otra vez para confirmar.`,
      };
    }
    return skills.importFromGitHub(repo);
  });
  ipcMain.handle('skills:create', async (e, data) => skills.createSkill(data || {}));
  ipcMain.handle('skills:delete', async (e, id) => skills.deleteSkill(String(id || '')));
  ipcMain.handle('skills:search', async (e, q) => skills.searchSkills(String(q || '')));
  ipcMain.handle('skills:update', async (e, id) => skills.updateSkill(String(id || '')));
  ipcMain.handle('skills:updateAll', async () => skills.updateAll());
  ipcMain.handle('skills:read', async (e, id) => { const s = await skills.getSkill(id); return s ? { id: s.id, name: s.name, description: s.description, body: s.body, version: s.version, source: s.source } : null; });
}

module.exports = { registerSkillsIpc };
