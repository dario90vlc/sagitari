'use strict';

/* Ventana principal de SAGITARI.
   El glow vive en el marco de la propia app (renderer), no en un overlay de pantalla.
   Patrón factory: recibe las dependencias y retorna las funciones de ventana.
   Así main.js puede inyectar `agent`, `config`, etc. sin dependencias circulares. */

/* pathToFileURL viene de `url` de Node, no de `electron`: en este Electron (44.2.0)
   la API existe en el binario pero no la expone `require('electron')`, y la línea
   60 rompía con «pathToFileURL is not a function». La de Node está en el proceso
   principal desde siempre. */
const { BrowserWindow, screen, shell, dialog, app } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

function crearVentana({ HIDDEN, DEV, INDEX_HTML, getAgent, getConfig, saveConfig, onListo = null }) {
  let win = null; // chat
  let boundsTimer = null;
  let recuperacionTimer = null; // reintento de carga tras caerse el renderer

  /* Geometría de arranque: la GUARDADA (si cae dentro de algún monitor conectado) o la
     centrada por defecto. Persistir sin validar dejaría la ventana fuera de todo al
     desconectar un monitor: se busca el monitor que contiene el centro y se CLAMPEA a su
     área de trabajo, así una ventana guardada en una pantalla que ya no está vuelve a
     aparecer. minWidth/minHeight se respetan siempre. */
  function geometria() {
    const cfg = getConfig();
    const b = cfg && cfg.settings && cfg.settings.windowBounds;
    if (b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))) {
      const W = Math.max(1000, Math.round(b.width));
      const H = Math.max(620, Math.round(b.height));
      const cx = b.x + W / 2,
        cy = b.y + H / 2;
      const d =
        screen
          .getAllDisplays()
          .find(
            (s) =>
              cx >= s.workArea.x && cx < s.workArea.x + s.workArea.width && cy >= s.workArea.y && cy < s.workArea.y + s.workArea.height,
          ) || screen.getPrimaryDisplay();
      const wa = d.workArea;
      return {
        width: W,
        height: H,
        x: Math.min(Math.max(Math.round(b.x), wa.x), Math.max(wa.x, wa.x + wa.width - W)),
        y: Math.min(Math.max(Math.round(b.y), wa.y), Math.max(wa.y, wa.y + wa.height - H)),
      };
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // El mínimo de la ventana manda: en pantallas estrechas (área de trabajo
    // < 1088px) `width - 88` quedaba por debajo de minWidth, el SO forzaba 1000 y
    // la ventana se salía por la derecha con la x calculada sobre un ancho menor.
    const W = Math.max(1000, Math.min(1560, width - 88));
    const H = Math.max(620, Math.min(920, height - 88));
    return { width: W, height: H, x: Math.max(0, Math.round((width - W) / 2)), y: Math.max(0, Math.round((height - H) / 2)) };
  }

  /* Guarda los bounds SOLO si la ventana está en estado «normal»: minimizada/maximizada,
     getBounds() devuelve lo que decidió el SO, no lo que eligió el usuario. Best-effort,
     nunca debe romper el cierre. */
  function guardarBounds() {
    try {
      if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      const cfg = getConfig();
      if (!cfg || !cfg.settings) return;
      cfg.settings.windowBounds = win.getBounds();
      if (saveConfig) saveConfig();
    } catch {}
  }
  const debounceBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(guardarBounds, 500);
  };

  function createChatWindow() {
    const g = geometria();
    win = new BrowserWindow({
      width: g.width,
      height: g.height,
      // mínimo por debajo del cual la ventana no se reduce: el diseño se mantiene
      // intacto hasta este límite (ver media queries en styles.css)
      minWidth: 1000,
      minHeight: 620,
      x: g.x,
      y: g.y,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // el preload solo usa contextBridge + ipcRenderer
        spellcheck: false,
      },
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'),
      show: !HIDDEN,
    });
    /* Icono de la ventana (barra de tareas). Ya viaja en las opciones de arriba, pero en
       Windows el icono del botón de la barra puede quedarse con el del ejecutable si la
       ventana se crea antes de que el sistema lo pida: fijarlo otra vez al arrancar es la
       forma barata de que salga SIEMPRE el de SAGITARI. En desarrollo el proceso es
       `electron.exe`, así que ahí puede verse el de Electron: es del binario, no de la app
       (las versiones publicadas llevan el nuestro, con sus seis tamaños). */
    if (process.platform === 'win32') {
      try {
        win.setIcon(path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico'));
      } catch {}
    }
    win.loadFile(INDEX_HTML);
    // La ventana no navega fuera de su index.html local: si un enlace o un script
    // lo intenta, se cancela (las URLs http/https se abren en el navegador del
    // sistema). Abrir ventanas nuevas queda denegado de plano.
    const appUrl = pathToFileURL(INDEX_HTML).href;
    win.webContents.on('will-navigate', (e, url) => {
      if (String(url).split('#')[0] !== appUrl) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('win:maximized', win.isMaximized());
      // la ventana ya puede recibir avisos (los que llegaron antes se encolaron en main)
      if (onListo) {
        try {
          onListo();
        } catch {}
      }
    });
    // si el renderer se cae, la confirmación pendiente ya no la puede contestar
    // nadie: se detiene el agente en limpio en vez de dejarlo colgado esperando
    win.webContents.on('render-process-gone', (_e, detalles) => {
      try {
        if (getAgent()) getAgent().stop();
      } catch {}
      recuperarRenderer(detalles);
    });
    const estaVentana = win;
    win.on('closed', () => {
      clearTimeout(boundsTimer);
      clearTimeout(recuperacionTimer);
      guardarBounds();
      // recrear la ventana no puede dejar el puntero a null: 'closed' de la vieja
      // llegaría DESPUÉS de crear la nueva (y la app se quedaría sin ventana)
      if (win === estaVentana) win = null;
    });
    // Persistir tamaño/posición (con retardo): sin esto la ventana se recalculaba centrada
    // en cada arranque y el usuario la movía siempre otra vez. No se guarda mientras está
    // minimizada/maximizada: getBounds() devolvería el estado del SO, no lo que eligió.
    win.on('resize', debounceBounds);
    win.on('move', debounceBounds);
    // cerrar = cerrar de verdad: X sale de la app completa (antes se ocultaba y
    // quedaban procesos vivos). Para ocultar/mostrar: Ctrl+Alt+S o la bandeja.
    win.on('maximize', () => win.webContents.send('win:maximized', true));
    win.on('unmaximize', () => win.webContents.send('win:maximized', false));
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  }

  /* El renderer se ha caído. La ventana no tiene marco ni controles propios
     (`frame:false` + transparente), así que sin recuperarla queda una ventana vacía que
     solo se puede cerrar desde la bandeja o el Administrador de tareas. Se recarga la
     vista y, si en 8 s no ha vuelto, se recrea; como último recurso un diálogo nativo
     ofrece reiniciar la interfaz (o cerrar la app). */
  function recuperarRenderer(detalles) {
    console.error('[SAGITARI] el proceso de render se cayó:', (detalles && detalles.reason) || 'motivo desconocido');
    const w = win;
    if (!w || w.isDestroyed()) return recrearVentana();
    let volvio = false;
    const alCargar = () => {
      volvio = true;
    };
    try {
      w.webContents.once('did-finish-load', alCargar);
      w.webContents.reload();
    } catch {}
    clearTimeout(recuperacionTimer);
    recuperacionTimer = setTimeout(() => {
      if (volvio) return;
      try {
        w.webContents.removeListener('did-finish-load', alCargar);
      } catch {}
      preguntarReiniciarInterfaz();
    }, 8000);
  }

  /** Crea una ventana nueva (la actual puede estar destruida o en blanco). */
  function recrearVentana() {
    const previa = win;
    try {
      if (previa && !previa.isDestroyed()) previa.destroy();
    } catch {}
    try {
      createChatWindow();
    } catch (e) {
      console.error('[SAGITARI] no se pudo recrear la ventana:', (e && e.message) || e);
    }
  }

  /** Último recurso: un diálogo nativo, porque la interfaz no puede pintar nada. */
  function preguntarReiniciarInterfaz() {
    let eleccion = 1;
    try {
      eleccion = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : null, {
        type: 'error',
        title: 'SAGITARI — la interfaz no ha vuelto',
        message: 'La interfaz de SAGITARI se ha caído y no ha podido recargarse.',
        detail: 'Puedes reiniciarla sin cerrar la aplicación.',
        buttons: ['Reiniciar la interfaz', 'Cerrar SAGITARI'],
        defaultId: 0,
        cancelId: 1,
      });
    } catch {}
    if (eleccion === 0) recrearVentana();
    else app.quit();
  }

  /* Muestra la ventana existente (o la crea si se cerró). Se usa desde el
     segundo lanzamiento, desde el icono de la bandeja y desde los atajos: es la
     red de seguridad para que la app nunca quede fuera de alcance. */
  function showWindow() {
    if (!win || win.isDestroyed()) return createChatWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function glow(mode, color) {
    const cfg = getConfig();
    if (!cfg || !cfg.settings || !cfg.settings.glowEnabled) return;
    if (win && !win.isDestroyed()) win.webContents.send('glow:set', { mode, color: color || cfg.settings.theme });
  }

  return {
    createChatWindow,
    showWindow,
    glow,
    getWin: () => win,
    setWin: (w) => {
      win = w;
    },
  };
}

module.exports = { crearVentana };
