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
  ipcMain.handle('memory:add', (e, item) => memory.add({
    text: item && item.text,
    source: 'user',
    importance: Number((item && item.importance) ?? 0.5),
    confidence: 0.8,
  }));
  ipcMain.handle('memory:update', (e, { id, patch }) => memory.update(String(id), patch || {}));
  ipcMain.handle('memory:remove', (e, id) => memory.remove(String(id)));
  ipcMain.handle('health:get', () => models.summary());
  ipcMain.handle('habits:get', () => habits.stats());
  ipcMain.handle('habits:reset', () => { habits.reset(); return { ok: true }; });
}

module.exports = { registerMemoryIpc };
