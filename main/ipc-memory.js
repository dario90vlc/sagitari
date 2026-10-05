'use strict';

/* ipc-memory.js — router IPC del dominio memoria/salud/hábitos.
 *
 * Fase 4: primer dominio extraído de main.js. Los handlers son funciones puras
 * sobre los módulos de agent/ (memory, models, habits): no tocan ventana,
 * disco propio ni estado global de main, así que el router solo necesita que
 * se los pasen. main.js lo monta con registerMemoryIpc(ipcMain, { memory,
 * models, habits }).
 */

function registerMemoryIpc(ipcMain, { memory, models, habits }) {
  ipcMain.handle('memory:list', () => memory.list());
  ipcMain.handle('memory:add', (e, item) => {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) {
      return { ok: false, error: 'text es obligatorio' };
    }
    return memory.add({
      text: item.text.trim().slice(0, 2000),
      source: 'user',
      importance: Math.min(1, Math.max(0, Number(item.importance) || 0.5)),
      confidence: 0.8,
    });
  });
  ipcMain.handle('memory:update', (e, { id, patch }) => {
    if (!id || typeof id !== 'string') {
      return { ok: false, error: 'id es obligatorio' };
    }
    return memory.update(id, patch || {});
  });
  ipcMain.handle('memory:remove', (e, id) => {
    if (!id || typeof id !== 'string') {
      return { ok: false, error: 'id es obligatorio' };
    }
    return memory.remove(id);
  });
  ipcMain.handle('health:get', () => models.summary());
  ipcMain.handle('habits:get', () => habits.stats());
  ipcMain.handle('habits:reset', () => {
    habits.reset();
    return { ok: true };
  });
}

module.exports = { registerMemoryIpc };
