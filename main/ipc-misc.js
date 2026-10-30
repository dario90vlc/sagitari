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

const { validarWorkspaceRuta } = require('./workspace-ruta');
const i18n = require('../agent/i18n');

function registerMiscIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const { saveConfig, app, shell, dialog, fsp, fs, path } = ctx;
  const getWin = () => ctx.getWin();
  const glow = (...a) => ctx.getGlow(...a);

  ipcMain.on('glow:set', (e, payload = {}) => glow(payload.mode, payload.color));

  // ---- misc ----
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:minimize', () => getWin() && getWin().minimize()); // minimizado real: sigue en la barra de tareas
  ipcMain.handle('app:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:maximize', () => {
    const w = getWin();
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.handle('app:openDataDir', async () => {
    try {
      await fsp.mkdir(ctx.configDir(), { recursive: true });
    } catch {}
    const err = await shell.openPath(ctx.configDir());
    return err ? { ok: false, error: err } : { ok: true, path: ctx.configDir() };
  });
  ipcMain.handle('shell:openPath', async (e, p) => {
    const explicit = String(p || '').trim();
    // UNC (\\servidor\recurso) fuera: no es una carpeta local y no debe poder fijar
    // el espacio de trabajo de la app.
    if (/^[\\/]{2}/.test(explicit)) return { ok: false, error: i18n.t('misc.red') };
    let target = explicit.replace(/^~(?=\/|\\|$)/, app.getPath('home'));
    if (!target) target = app.getPath('desktop');
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      return { ok: false, error: i18n.t('misc.ruta.no.existe', { ruta: target }) };
    }
    if (st.isFile()) {
      target = path.dirname(target); // un archivo abre su carpeta contenedora
      try {
        st = fs.statSync(target);
      } catch {
        return { ok: false, error: i18n.t('misc.ruta.no.carpeta', { ruta: target }) };
      }
    }
    if (!st.isDirectory()) return { ok: false, error: i18n.t('misc.ruta.no.carpeta', { ruta: target }) };
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    // Proyectos = espacio de trabajo: abrir una carpeta aquí la convierte en la activa
    // (con campo vacío se abre el Escritorio SIN cambiar el espacio configurado).
    // Abrir NO es fijar: la ruta pasa por la MISMA validación que workspace:set —
    // antes se asignaba solo con que existiese y fuese carpeta, así que C:\Windows o el
    // directorio de datos de la app colaban por aquí y el agente escribía ahí.
    if (explicit) {
      const v = validarWorkspaceRuta(target, ctx.configDir());
      if (v.ok) {
        const previo = cfg().settings.workspace;
        cfg().settings.workspace = v.real;
        // Igual que workspace:set: si el disco no traga la configuración hay que decirlo,
        // o la interfaz cree que la carpeta quedó fijada y al reiniciar vuelve la anterior.
        const saved = saveConfig();
        if (!saved.ok) {
          // Y la memoria vuelve al valor anterior: si se queda el nuevo, la interfaz dice
          // «no se pudo» y sigue enseñando la carpeta vieja, pero el agente escribe en la nueva.
          cfg().settings.workspace = previo;
          return { ok: false, error: saved.error };
        }
      } else {
        // La carpeta se abre igual en el Explorador; solo se rechaza fijarla como workspace.
        return { ok: true, path: target, workspace: ctx.getWorkspace(), workspaceError: v.error };
      }
    }
    return { ok: true, path: target, workspace: ctx.getWorkspace() };
  });
  ipcMain.handle('shell:pickFolder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    return r.canceled || !r.filePaths.length ? { ok: false } : { ok: true, path: r.filePaths[0] };
  });
}

module.exports = { registerMiscIpc };
