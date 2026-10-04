'use strict';

/* Bandeja del sistema de SAGITARI.
   Sin ella, ocultar la ventana (atajo) dejaba SAGITARI invisible e inalcanzable:
   ni barra de tareas ni forma evidente de volver. Desde aquí siempre se puede
   mostrar, ocultar o salir. */

const { Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

function crearBandeja({ HEADLESS, showWindow, getWin, app }) {
  let tray = null;

  function createTray() {
    if (tray || HEADLESS) return;
    try {
      const ico = path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico');
      if (!fs.existsSync(ico)) return;
      tray = new Tray(ico);
      tray.setToolTip('SAGITARI — tu asistente');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Mostrar SAGITARI', click: () => showWindow() },
          {
            label: 'Ocultar ventana',
            click: () => {
              const win = getWin();
              if (win && !win.isDestroyed()) win.hide();
            },
          },
          { type: 'separator' },
          { label: 'Salir', click: () => app.quit() },
        ]),
      );
      tray.on('click', () => showWindow());
      tray.on('double-click', () => showWindow());
    } catch (e) {
      tray = null;
    }
  }

  return {
    createTray,
    getTray: () => tray,
    setTray: (t) => {
      tray = t;
    },
  };
}

module.exports = { crearBandeja };
