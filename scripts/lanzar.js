'use strict';

/* ============================================================================
   lanzar.js — arranca SAGITARI en un entorno con el token restringido.

   En un sandbox que restringe el token (el de este harness), Electron no puede
   escribir en %APPDATA% ni en %TEMP%: el bloqueo de instancia no se crea y el
   proceso sale con STATUS_CONTROL_C_EXIT antes de abrir ninguna ventana. Tres
   cosas hacen falta y ninguna es culpa de la app:

     1. ELECTRON_RUN_AS_NODE no puede estar definido. Con él Electron se
        comporta como Node: `app` no existe y no hay ventana.
     2. El perfil de datos tiene que ser escribible. SAGITARI_TEST_PROFILE
        (ver main/main.js) lo apunta dentro del workspace.
     3. --no-sandbox --disable-gpu: sin el primero no se levanta el sandbox de
        Chromium; sin el segundo falla el proceso de GPU en un escritorio sin
        GPU. En un entorno normal no hacen falta, pero no cambian el
        comportamiento de la app.

   Uso: node scripts/lanzar.js [--smoke|--dev|--test-visible] [más flags de Electron]
   Todo lo que se pasa se reenvía a Electron, así que sigue valiendo
   `node scripts/lanzar.js --smoke` igual que `electron . --smoke`.
   ============================================================================ */

const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron'); // en un proceso Node normal: la ruta del binario
const APP_DIR = path.join(__dirname, '..');

const args = process.argv.slice(2);
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
env.SAGITARI_TEST_PROFILE = path.join(APP_DIR, '.perfil-pruebas');

const child = spawn(electron, ['--no-sandbox', '--disable-gpu', ...args, '.'], {
  cwd: APP_DIR,
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code == null ? 0 : code));
