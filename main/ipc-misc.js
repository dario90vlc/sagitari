'use strict';

/* ipc-misc.js — router IPC del dominio misceláneo app/shell/glow.
 *
 * Décimo router de la fase 4: controles de ventana (app:*), apertura de
 * rutas y selector de carpeta (shell:*), y ajuste del halo (glow:set).
 * Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - saveConfig(): persiste la configuración
 *   - getWin(): ventana principal (o null)
 *   - getWorkspace(): espacio de trabajo activo
 *   - configDir(): directorio de datos
 *   - getGlow(): efecto de luz glow(mode, color)
 *   - app, shell, dialog, fsp, fs, path: módulos ya importados en main
 */

function registerMiscIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const { saveConfig, app, shell, dialog, fsp, fs, path } = ctx;
  const getWin = () => ctx.getWin();
  const glow = (...a) => ctx.getGlow(...a);

  ipcMain.on('glow:set', (e, { mode, color }) => glow(mode, color));

  // ---- misc ----
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:minimize', () => getWin() && getWin().minimize());   // minimizado real: sigue en la barra de tareas
  ipcMain.handle('app:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:maximize', () => {
    const w = getWin();
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.handle('app:openDataDir', async () => {
    try { await fsp.mkdir(ctx.configDir(), { recursive: true }); } catch {}
    const err = await shell.openPath(ctx.configDir());
    return err ? { ok: false, error: err } : { ok: true, path: ctx.configDir() };
  });
  ipcMain.handle('shell:openPath', async (e, p) => {
    const explicit = String(p || '').trim();
    // UNC (\\servidor\recurso) fuera: no es una carpeta local y no debe poder fijar
    // el espacio de trabajo de la app.
    if (/^[\\/]{2}/.test(explicit)) return { ok: false, error: 'Ruta de red no permitida' };
    let target = explicit.replace(/^~(?=\/|\\|$)/, app.getPath('home'));
    if (!target) target = app.getPath('desktop');
    let st;
    try { st = fs.statSync(target); } catch { return { ok: false, error: 'La ruta no existe: ' + target }; }
    if (st.isFile()) {
      target = path.dirname(target);   // un archivo abre su carpeta contenedora
      try { st = fs.statSync(target); } catch { return { ok: false, error: 'La ruta no es una carpeta: ' + target }; }
    }
    if (!st.isDirectory()) return { ok: false, error: 'La ruta no es una carpeta: ' + target };
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    // Proyectos = espacio de trabajo: abrir una carpeta aquí la convierte en la activa
    // (con campo vacío se abre el Escritorio SIN cambiar el espacio configurado)
    if (explicit) { cfg().settings.workspace = target; saveConfig(); }
    return { ok: true, path: target, workspace: ctx.getWorkspace() };
  });
  ipcMain.handle('shell:pickFolder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? { ok: false } : { ok: true, path: r.filePaths[0] };
  });
}

module.exports = { registerMiscIpc };
