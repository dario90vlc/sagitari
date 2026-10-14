'use strict';

/* ipc-memory.js — router IPC del dominio memoria/salud/hábitos.
 *
 * Fase 4: primer dominio extraído de main.js. Los handlers de la fase anterior son
 * funciones puras sobre los módulos de agent/ (memory, models, habits): no tocan
 * ventana, disco propio ni estado global de main, así que el router solo necesita
 * que se los pasen. main.js lo monta con registerMemoryIpc(ipcMain, { memory,
 * models, habits, getWin }).
 *
 *  Memoria v2 (2026-10-14): la bandeja de aprobación («Recién aprendido»), la
 *  papelera, la exportación, el olvido y la recuperación de una copia viven en
 *  agent/memory.js, y el borrado por categoría en agent/habits.js (frente del
 *  núcleo). Aquí solo se validan los argumentos y se reenvían: ninguna regla del
 *  almacén se duplica en el proceso principal. Mientras el almacén no exponga una
 *  de esas funciones, su canal responde `{ ok:false, error:'almacén no disponible' }`
 *  en vez de reventar: la vista puede decirlo y el resto de la memoria sigue igual.
 *
 *  Almacén que no se ha podido leer (error de E/S o fichero ilegible): `memory:list` y
 *  `memory:trash:list` LANZAN con el motivo (la vista pinta su pantalla de recuperación
 *  en vez de una memoria vacía que no es cierta) y lo que escribiría se rechaza con
 *  `{ ok:false, error }`, porque guardar encima perdería los hechos que no se han leído.
 *  `memory:wipe` es además quien borra el perfil de hábitos: es lo que promete la
 *  confirmación de la vista («los hechos, la papelera, la bandeja y tus hábitos»).
 */

/** Categorías de hábitos que la vista puede olvidar, en su orden de pantalla
 *  (Herramientas, Aplicaciones, Comandos, Carpetas, Webs, Modos, Permisos; «todo» = las
 *  siete). El almacén valida y traduce a sus claves reales; aquí solo se cierra la lista
 *  para que un valor inventado no llegue al perfil. */
const CATEGORIAS_HABITOS = new Set(['herramientas', 'aplicaciones', 'comandos', 'carpetas', 'webs', 'modos', 'permisos', 'todo']);

const SIN_ALMACEN = { ok: false, error: 'almacén no disponible' };

/** Id de una entrada: llega del renderer, así que se comprueba antes de tocar el almacén. */
const idValido = (payload) => !!(payload && typeof payload.id === 'string' && payload.id.trim());

/* Estado del almacén de hechos (v2). Un fichero que no se ha podido leer NO se puede
   contar como memoria vacía: la vista tiene que poder decirlo y ofrecer «Restaurar copia»
   (es lo que hace la pantalla de recuperación de la vista Memoria al recibir el error).
   Con un almacén anterior a v2 (sin `estado`) todo sigue como siempre. */
function estadoAlmacen(memory) {
  if (!memory || typeof memory.estado !== 'function') return { ok: true };
  try {
    return memory.estado() || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Escribir con un almacén que no se ha podido leer perdería hechos: se rechaza y se dice. */
function bloqueadoParaEscribir(memory) {
  const est = estadoAlmacen(memory);
  return est.ok ? null : { ok: false, error: est.error || 'no se pudo leer el almacén' };
}

/** Ventana a la que empujar los avisos. main.js pasa getWin, como a los demás
 *  routers; el respaldo por BrowserWindow evita que el aviso se pierda en silencio
 *  si un montaje se olvida de pasarlo (y no existe en tiempo de test). */
function ventanaPrincipal() {
  try {
    const { BrowserWindow } = require('electron');
    const abiertas = BrowserWindow.getAllWindows();
    return abiertas.length ? abiertas[0] : null;
  } catch {
    return null;
  }
}

function registerMemoryIpc(ipcMain, ctx) {
  const memory = ctx.memory;
  const models = ctx.models;
  const habits = ctx.habits;
  const getWin = typeof ctx.getWin === 'function' ? ctx.getWin : ventanaPrincipal;

  /* La lista es lo que la vista pinta: si el almacén no se pudo leer, LANZA con el motivo
     (la vista enseña la pantalla de recuperación en vez de un «Aún no sé nada de ti»
     falso). Los canales anteriores a esta corrección devolvían siempre un array. */
  ipcMain.handle('memory:list', () => {
    const est = estadoAlmacen(memory);
    if (!est.ok) throw new Error(est.error || 'no se pudo leer el almacén');
    return memory.list();
  });
  ipcMain.handle('memory:add', (e, item) => {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) {
      return { ok: false, error: 'text es obligatorio' };
    }
    const bloqueo = bloqueadoParaEscribir(memory);
    if (bloqueo) return bloqueo;
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
    const bloqueo = bloqueadoParaEscribir(memory);
    if (bloqueo) return bloqueo;
    return memory.update(id, patch || {});
  });
  ipcMain.handle('memory:remove', (e, id) => {
    if (!id || typeof id !== 'string') {
      return { ok: false, error: 'id es obligatorio' };
    }
    const bloqueo = bloqueadoParaEscribir(memory);
    if (bloqueo) return bloqueo;
    return memory.remove(id);
  });

  /* ---- v2: bandeja de aprobación («Recién aprendido») ---- */
  ipcMain.handle('memory:tray:list', () => (typeof memory.trayList === 'function' ? memory.trayList() : SIN_ALMACEN));
  ipcMain.handle('memory:tray:accept', (e, payload) => {
    if (!idValido(payload)) return { ok: false, error: 'id es obligatorio' };
    return typeof memory.trayAceptar === 'function' ? memory.trayAceptar(payload.id) : SIN_ALMACEN;
  });
  ipcMain.handle('memory:tray:discard', (e, payload) => {
    if (!idValido(payload)) return { ok: false, error: 'id es obligatorio' };
    return typeof memory.trayDescartar === 'function' ? memory.trayDescartar(payload.id) : SIN_ALMACEN;
  });

  /* ---- v2: papelera (lo olvidado, recuperable 30 días) ---- */
  ipcMain.handle('memory:trash:list', () => {
    const est = estadoAlmacen(memory);
    if (!est.ok) throw new Error(est.error || 'no se pudo leer el almacén');
    return typeof memory.listTrash === 'function' ? memory.listTrash() : SIN_ALMACEN;
  });
  ipcMain.handle('memory:trash:restore', (e, payload) => {
    if (!idValido(payload)) return { ok: false, error: 'id es obligatorio' };
    return typeof memory.restore === 'function' ? memory.restore(payload.id) : SIN_ALMACEN;
  });
  ipcMain.handle('memory:trash:empty', () => (typeof memory.trashEmpty === 'function' ? memory.trashEmpty() : SIN_ALMACEN));

  /* ---- v2: exportar (JSON legible), olvidarlo todo y recuperar una copia ---- */
  ipcMain.handle('memory:export', () => {
    const bloqueo = bloqueadoParaEscribir(memory);
    if (bloqueo) return bloqueo; // exportar un almacén que no se ha leído copiaría un volcado falso
    return typeof memory.exportar === 'function' ? memory.exportar() : SIN_ALMACEN;
  });
  /* «Olvídalo todo» promete «todos los hechos, la papelera, la bandeja y tus hábitos», y
     el perfil observado vive en agent/habits.js: se borra desde aquí, que es el único
     sitio que conoce los dos almacenes (lo que preveía el plan de la fase 1). Si los
     hechos no se pudieron olvidar, no se toca el perfil: media promesa es peor que
     ninguna. */
  ipcMain.handle('memory:wipe', () => {
    if (typeof memory.wipe !== 'function') return SIN_ALMACEN;
    const r = memory.wipe();
    if (r && r.ok !== false && habits && typeof habits.reset === 'function') habits.reset();
    return r;
  });
  /* Salida cuando memory.json no se pudo leer: el almacén conserva una copia. */
  ipcMain.handle('memory:restore-backup', () => (typeof memory.restaurarCopia === 'function' ? memory.restaurarCopia() : SIN_ALMACEN));

  /* ---- hábitos: olvidar una categoría ---- */
  ipcMain.handle('habits:forget', (e, payload) => {
    const categoria = payload && payload.categoria;
    if (!CATEGORIAS_HABITOS.has(categoria)) return { ok: false, error: 'categoría no válida' };
    return typeof habits.olvidar === 'function' ? habits.olvidar(categoria) : SIN_ALMACEN;
  });

  /* El almacén avisa cuando la extracción deja una propuesta: el aviso nace en
     agent/ (que no sabe de ventanas) y se reenvía al renderer desde aquí. Un solo
     emisor, suscrito una sola vez al montar el router. */
  if (typeof memory.on === 'function') {
    memory.on('propuesta', (propuesta) => {
      const w = getWin();
      if (w && !w.isDestroyed()) w.webContents.send('memory:nueva', propuesta);
    });
  }

  ipcMain.handle('health:get', () => models.summary());
  ipcMain.handle('habits:get', () => habits.stats());
  ipcMain.handle('habits:reset', () => {
    habits.reset();
    return { ok: true };
  });
}

module.exports = { registerMemoryIpc };
