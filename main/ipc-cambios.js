'use strict';

/* ipc-cambios.js — router IPC del dominio cambios/instrucciones.
 *
 * Undécimo router de la fase 4: deshacer el turno (cambios:*) y reglas del
 * proyecto SAGITARI.md/AGENTS.md (agent:instrucciones*).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - getAgent(): agente del chat (o null; deshacer se niega si trabaja)
 *   - getWorkspace(): espacio de trabajo activo
 *   - cambios, repomap, instrucciones, runlog: módulos (singletons, no cambian)
 *   - fs, path: módulos ya importados en main
 */

function registerCambiosIpc(ipcMain, ctx) {
  const { cambios, repomap, instrucciones, runlog, fs, path } = ctx;
  const ag = () => ctx.getAgent();

  /* Deshacer el turno: vuelve a dejar los archivos como estaban antes de que el agente
     los tocara. La pre-imagen la guarda agent/cambios.js en cada escritura (para revisar el
     cambio), así que aquí solo hay que decidir si se puede y aplicarlo.

     Se niega con el agente trabajando: deshacer mientras hay una escritura en vuelo
     restauraría un archivo que la herramienta está a punto de volver a escribir. */
  ipcMain.handle('cambios:deshacer', async () => {
    if (ag() && ag().isBusy()) return { ok: false, error: 'SAGITARI está trabajando ahora mismo: detén la tarea antes de deshacer' };
    const ws = ctx.getWorkspace();
    if (!cambios.puedeDeshacer(ws)) return { ok: false, error: 'no hay ningún cambio de este turno que deshacer' };
    const plan = cambios.planDeshacer(ws);
    let r;
    try { r = cambios.deshacer(ws); }
    catch (e) { return { ok: false, error: 'no se pudo deshacer: ' + ((e && e.message) || e) } }
    try { repomap.invalidar(ws); } catch {}
    runlog.log({ agent: 'sagitari', event: 'undo_turn', archivos: r.archivos.length, restaurados: r.restaurados, borrados: r.borrados, fallos: r.fallos });
    return { ok: true, ...r, plan: plan.length };
  });

  /** ¿Hay algo que deshacer ahora mismo? (para que la interfaz no ofrezca un botón inútil) */
  ipcMain.handle('cambios:estado', async () => {
    const ws = ctx.getWorkspace();
    const plan = cambios.puedeDeshacer(ws) ? cambios.planDeshacer(ws) : [];
    return { ok: true, puede: plan.length > 0, archivos: plan.map(x => x.ruta) };
  });

  /* Reglas del proyecto (SAGITARI.md / AGENTS.md): la interfaz enseña CUÁLES se están
     leyendo y sus tamaños. Es la respuesta a «¿por qué el agente no hace lo que dice mi
     AGENTS.md?»: porque no hay ninguno, o está en otra carpeta, o se está recortando. */
  ipcMain.handle('agent:instrucciones', async () => {
    const ws = ctx.getWorkspace();
    try {
      const { fuentes } = instrucciones.leer(ws);
      return { ok: true, workspace: ws, fuentes, candidatos: instrucciones.candidatas(ws).map(c => c.etiqueta) };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e), fuentes: [], candidatos: [] } }
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
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
  });
}

module.exports = { registerCambiosIpc };
