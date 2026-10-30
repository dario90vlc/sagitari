'use strict';

/* Bandeja del sistema de SAGITARI.
   Sin ella, ocultar la ventana (atajo) dejaba SAGITARI invisible e inalcanzable:
   ni barra de tareas ni forma evidente de volver. Desde aquí siempre se puede
   mostrar, ocultar o salir. */

const { Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const i18n = require('../agent/i18n');

function crearBandeja({ HEADLESS, showWindow, getWin, app }) {
  let tray = null;

  function createTray() {
    if (tray || HEADLESS) return;
    try {
      const ico = path.join(__dirname, '..', 'renderer', 'assets', 'sagitari.ico');
      if (!fs.existsSync(ico)) return;
      tray = new Tray(ico);
      tray.setToolTip(i18n.t('bandeja.tooltip'));
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: i18n.t('bandeja.mostrar'), click: () => showWindow() },
          {
            label: i18n.t('bandeja.ocultar'),
            click: () => {
              const win = getWin();
              if (win && !win.isDestroyed()) win.hide();
            },
          },
          { type: 'separator' },
          { label: i18n.t('bandeja.salir'), click: () => app.quit() },
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
