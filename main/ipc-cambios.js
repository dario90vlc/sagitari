'use strict';

/* ipc-cambios.js — router IPC del dominio cambios/instrucciones.
 *
 * Undécimo router de la fase 4: deshacer el turno (cambios:*) y reglas del
 * proyecto SAGITARI.md/AGENTS.md (agent:instrucciones*).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - runtimes: registro de agentes vivos por conversación (main/runtimes.js): deshacer
 *     se niega si trabaja LA conversación de esos cambios, y las pre-imágenes se buscan
 *     con el dueño de ESA conversación (dos conversaciones sobre la misma carpeta no se
 *     pisan; ver agent/cambios.js)
 *   - getWorkspace(): espacio de trabajo activo
 *   - cambios, repomap, instrucciones, runlog: módulos (singletons, no cambian)
 *   - fs, path: módulos ya importados en main
 */

function registerCambiosIpc(ipcMain, ctx) {
  const { cambios, repomap, instrucciones, runlog, fs, path } = ctx;
  const i18n = require('../agent/i18n');
  const runtimes = ctx.runtimes;
  /* El dueño de los cambios: la conversación que los hizo. Si el renderer no manda el
     id se resuelve la conversación abierta (lo que hacía el agente único de antes). */
  const dueno = (convId) => runtimes.ownerOf(convId);
  const trabaja = (convId) => {
    const a = runtimes.peek(convId);
    return !!(a && a.isBusy());
  };

  /* Deshacer el turno: vuelve a dejar los archivos como estaban antes de que el agente
     los tocara. La pre-imagen la guarda agent/cambios.js en cada escritura (para revisar el
     cambio), así que aquí solo hay que decidir si se puede y aplicarlo.

     Se niega con el agente trabajando: deshacer mientras hay una escritura en vuelo
     restauraría un archivo que la herramienta está a punto de volver a escribir. */
  ipcMain.handle('cambios:deshacer', async (e, convId) => {
    if (trabaja(convId)) return { ok: false, error: i18n.t('cambios.trabajando.deshacer') };
    const ws = ctx.getWorkspace();
    const d = dueno(convId);
    /* El código viaja junto al texto legible: el renderer decide con `code` y así puede
       traducirse el mensaje sin que el botón de Deshacer se quede colgado. */
    if (!cambios.puedeDeshacer(ws, d)) return { ok: false, code: 'sin_cambios', error: i18n.t('cambios.nada') };
    const plan = cambios.planDeshacer(ws, d);
    let r;
    try {
      r = cambios.deshacer(ws, {}, d);
    } catch (e) {
      return { ok: false, error: i18n.t('cambios.fallo.deshacer', { motivo: (e && e.message) || e }) };
    }
    try {
      repomap.invalidar(ws);
    } catch {}
    runlog.log({
      agent: 'sagitari',
      event: 'undo_turn',
      archivos: r.archivos.length,
      restaurados: r.restaurados,
      borrados: r.borrados,
      fallos: r.fallos,
    });
    /* Con algún archivo sin deshacer la respuesta NO puede ser «ok»: el renderer cantaría
       «deshechos» y la pre-imagen de ese archivo sigue en el mapa para reintentar. Una
       ruta que quedó fuera de su espacio no se puede reintentar, y se dice. */
    if (r.fallos > 0) {
      const reintentables = (r.archivos || []).filter((a) => a && a.accion !== 'fuera-del-espacio').length;
      const error = reintentables
        ? i18n.t('cambios.fallos.reintentar', { n: reintentables })
        : i18n.t('cambios.fallos.fuera', { n: r.fallos });
      return { ok: false, error, ...r, plan: plan.length };
    }
    return { ok: true, ...r, plan: plan.length };
  });

  /** ¿Hay algo que deshacer ahora mismo? (para que la interfaz no ofrezca un botón inútil) */
  ipcMain.handle('cambios:estado', async (e, convId) => {
    const ws = ctx.getWorkspace();
    const d = dueno(convId);
    const plan = cambios.puedeDeshacer(ws, d) ? cambios.planDeshacer(ws, d) : [];
    return { ok: true, puede: plan.length > 0, archivos: plan.map((x) => x.ruta) };
  });

  /* Revisión del cambio: el MISMO diff que ya lee el subagente revisor, pero estructurado
     para que el panel lo pinte (archivos, contadores y hunks con líneas). Antes el usuario
     solo tenía «Deshacer el cambio»: todo el turno o nada, y a ciegas. */
  ipcMain.handle('cambios:diff', async (e, convId) => {
    const ws = ctx.getWorkspace();
    try {
      return { ok: true, archivos: cambios.diffEstructurado(ws, {}, dueno(convId)) || [] };
    } catch (e) {
      return { ok: false, error: i18n.t('cambios.fallo.diff', { motivo: (e && e.message) || e }), archivos: [] };
    }
  });

  /* Vuelve atrás UN archivo del turno, dejando los demás como están. Se niega con el
     agente trabajando por el mismo motivo que deshacer: restauraría un archivo que la
     herramienta está a punto de volver a escribir. */
  ipcMain.handle('cambios:revertir', async (e, convId, archivo) => {
    if (trabaja(convId)) return { ok: false, error: i18n.t('cambios.trabajando.revertir') };
    const ws = ctx.getWorkspace();
    let r;
    try {
      r = cambios.archivoRevertir(ws, archivo, dueno(convId));
    } catch (e2) {
      return { ok: false, error: i18n.t('cambios.fallo.revertir', { archivo: String(archivo), motivo: (e2 && e2.message) || e2 }) };
    }
    try {
      repomap.invalidar(ws);
    } catch {}
    runlog.log({ agent: 'sagitari', event: 'undo_file', archivo: String(archivo), borrado: !!(r && r.borrado) });
    return { ok: true, ...r };
  });

  /* Reglas del proyecto (SAGITARI.md / AGENTS.md): la interfaz enseña CUÁLES se están
     leyendo y sus tamaños. Es la respuesta a «¿por qué el agente no hace lo que dice mi
     AGENTS.md?»: porque no hay ninguno, o está en otra carpeta, o se está recortando. */
  ipcMain.handle('agent:instrucciones', async () => {
    const ws = ctx.getWorkspace();
    try {
      const { fuentes } = instrucciones.leer(ws);
      return { ok: true, workspace: ws, fuentes, candidatos: instrucciones.candidatas(ws).map((c) => c.etiqueta) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), fuentes: [], candidatos: [] };
    }
  });

  /** Crea una plantilla de SAGITARI.md en el proyecto (sin pisar nada si ya existe). */
  ipcMain.handle('agent:instrucciones-crear', async () => {
    const ws = ctx.getWorkspace();
    const destino = path.join(ws, 'SAGITARI.md');
    if (fs.existsSync(destino)) return { ok: true, yaExistia: true, ruta: destino };
    const plantilla = [
      '# Reglas de este proyecto (SAGITARI)',
      '',
      '<!-- SAGITARI lee este archivo SIEMPRE, antes de tocar nada, y también sus subagentes.',
      '     Escribe aquí solo lo que no se deduce del código: convenciones, límites, atajos. -->',
      '',
      '## Cómo se ejecuta esto',
      '- Tests: `npm test`',
      '- Compilar / tipos: `npm run build`',
      '- Lint: `npm run lint`',
      '',
      '## Convenciones',
      '- (idioma de los comentarios, estilo, estructura de carpetas, nombres)',
      '',
      '## No tocar sin permiso',
      '- (carpetas o archivos generados, migraciones, releases)',
      '',
      '## Antes de dar algo por hecho',
      '- (qué hay que ejecutar o comprobar en ESTE proyecto)',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(destino, plantilla, 'utf8');
      runlog.log({ agent: 'sagitari', event: 'instructions_created', ruta: destino });
      return { ok: true, ruta: destino };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

module.exports = { registerCambiosIpc };
