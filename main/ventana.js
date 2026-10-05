'use strict';

/* Ventana principal de SAGITARI.
   El glow vive en el marco de la propia app (renderer), no en un overlay de pantalla.
   Patrón factory: recibe las dependencias y retorna las funciones de ventana.
   Así main.js puede inyectar `agent`, `config`, etc. sin dependencias circulares. */

/* pathToFileURL viene de `url` de Node, no de `electron`: en este Electron (44.2.0)
   la API existe en el binario pero no la expone `require('electron')`, y la línea
   60 rompía con «pathToFileURL is not a function». La de Node está en el proceso
   principal desde siempre. */
const { BrowserWindow, screen, shell } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

function crearVentana({ HIDDEN, DEV, INDEX_HTML, getAgent, getConfig }) {
  let win = null; // chat

  function createChatWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // El mínimo de la ventana manda: en pantallas estrechas (área de trabajo
    // < 1088px) `width - 88` quedaba por debajo de minWidth, el SO forzaba 1000 y
    // la ventana se salía por la derecha con la x calculada sobre un ancho menor.
    const W = Math.max(1000, Math.min(1560, width - 88));
    const H = Math.max(620, Math.min(920, height - 88));
    win = new BrowserWindow({
      width: W,
      height: H,
      // mínimo por debajo del cual la ventana no se reduce: el diseño se mantiene
      // intacto hasta este límite (ver media queries en styles.css)
      minWidth: 1000,
      minHeight: 620,
      x: Math.max(0, Math.round((width - W) / 2)),
      y: Math.max(0, Math.round((height - H) / 2)),
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
    win.webContents.on('did-finish-load', () => win.webContents.send('win:maximized', win.isMaximized()));
    // si el renderer se cae, la confirmación pendiente ya no la puede contestar
    // nadie: se detiene el agente en limpio en vez de dejarlo colgado esperando
    win.webContents.on('render-process-gone', () => {
      try {
        if (getAgent()) getAgent().stop();
      } catch {}
    });
    win.on('closed', () => {
      win = null;
    });
    // cerrar = cerrar de verdad: X sale de la app completa (antes se ocultaba y
    // quedaban procesos vivos). Para ocultar/mostrar: Ctrl+Alt+S o la bandeja.
    win.on('maximize', () => win.webContents.send('win:maximized', true));
    win.on('unmaximize', () => win.webContents.send('win:maximized', false));
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
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
