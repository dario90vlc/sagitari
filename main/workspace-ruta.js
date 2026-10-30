'use strict';

/* Validación ÚNICA del espacio de trabajo de SAGITARI.
 *
 * Un workspace es donde el agente CREA, ESCRIBE y EJECUTA: no puede ser una ruta relativa,
 * ni la raíz de una unidad, ni las carpetas del sistema, ni el directorio de datos de la app
 * (ahí viven las claves y las conversaciones). Antes esta comprobación estaba copiada
 * VERBATIM en `workspace:set` y `workspace:pick` (ipc-convs.js) y `shell:openPath`
 * (ipc-misc.js) asignaba el workspace sin comprobarla en absoluto. Una sola función aquí
 * evita que las tres se separen con el tiempo.
 *
 * Devuelve { ok: true, real } con la ruta ya resuelta (realpath si se puede), o
 * { ok: false, error } con el motivo que se le enseña al usuario. NO crea la carpeta: quien
 * la fije decide si toca crear o no.
 */

const fs = require('fs');
const path = require('path');
const i18n = require('../agent/i18n');

function validarWorkspaceRuta(dir, configDir) {
  const p = String(dir || '').trim();
  if (!path.isAbsolute(p)) return { ok: false, error: i18n.t('ws.absoluta') };
  const sysRx = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)([\\/]|$)/;
  /* La MISMA comprobación sobre la ruta escrita y sobre la RESUELTA (realpath): antes
     `sysRx` solo miraba el texto, así que `C:\Windows.` (Windows ignora el punto final),
     `C:\PROGRA~1` (nombre 8.3) o un junction dentro del perfil que apunta a `C:\Windows`
     colaban y el espacio de trabajo quedaba en una carpeta del sistema. */
  const guardaSistema = (ruta) => {
    const low = String(ruta).toLowerCase();
    if (/^[a-z]:[\\/]?$/i.test(low)) return i18n.t('ws.raiz');
    if (sysRx.test(low)) return i18n.t('ws.sistema');
    return null;
  };
  /* Windows acepta alias que NO son el nombre canónico: el punto/espacio final
     (`C:\Windows.`), el nombre corto 8.3 (`C:\PROGRA~1`) y los junctions. `realpathSync`
     a secas no los resuelve siempre (con `C:\PROGRA~1` devuelve lo mismo que le dieron),
     así que se quita el punto/espacio final de cada tramo y se prueba el realpath NATIVO,
     que sí expande el 8.3. La guarda mira el camino resuelto, no solo el texto escrito. */
  const canonico = (ruta) => {
    let out = String(ruta).replace(/[ .]+(?=[\\/]|$)/g, '');
    for (const rp of [fs.realpathSync.native, fs.realpathSync]) {
      if (typeof rp !== 'function') continue;
      try {
        out = rp(out);
        break;
      } catch {}
    }
    return out;
  };
  const norm = path.win32.normalize(p);
  const malNorm = guardaSistema(norm);
  if (malNorm) return { ok: false, error: malNorm };
  const real = canonico(norm);
  const malReal = guardaSistema(real);
  if (malReal) return { ok: false, error: malReal };
  const inDir = (f, d) => {
    const r = path.relative(d, f);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  if (configDir && inDir(real.toLowerCase(), String(configDir).toLowerCase()))
    return { ok: false, error: i18n.t('ws.datos') };
  return { ok: true, real };
}

module.exports = { validarWorkspaceRuta };
