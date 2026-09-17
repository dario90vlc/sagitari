'use strict';

/* Ruta REAL de un guion que hay que entregar a PowerShell.
 *
 * `powershell.exe -File <ruta>` NO sabe leer dentro de un archivo `.asar`: el que entiende
 * esa ruta es Node, no el sistema. En la app instalada `__dirname` apunta a
 * `…/resources/app.asar/main/voice`, así que el guion quedaba en `…/app.asar/main/tts.ps1`
 * — una ruta que existe para `fs` pero que PowerShell rechaza con «El argumento … para el
 * parámetro -File no existe» — y el usuario se quedaba sin voz (y sin dictado) sin más
 * pista que ese mensaje. En desarrollo no pasaba: allí `__dirname` es una carpeta normal.
 *
 * Dos caminos, en este orden:
 *  1. `app.asar.unpacked`: electron-builder copia los `.ps1` FUERA del asar (ver
 *     `asarUnpack` en package.json). Es el camino normal: cero trabajo en caliente.
 *  2. Si no hay gemelo desempaquetado (empaquetado distinto, asarUnpack que no se aplicó),
 *     el CONTENIDO se lee con `fs` —que sí atraviesa el asar— y se deja en caché bajo el
 *     temporal del sistema, que es una ruta real para todo el mundo. Así el arreglo no
 *     depende de cómo se haya empaquetado la app.
 *
 * Fuera del asar (desarrollo, o cualquier ruta normal) se devuelve la ruta tal cual: ni
 * copias ni cachés.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ASAR = 'app.asar';
const ASAR_UNPACKED = 'app.asar.unpacked';
/* La caché es la misma en cada arranque a propósito: el nombre del destino depende del
   guion, no de la sesión, así que no se acumulan copias por abrir la app. */
const DIR_CACHE = path.join(os.tmpdir(), 'sagitari-scripts');

/* `…/app.asar/main/tts.ps1` → `…/app.asar.unpacked/main/tts.ps1`. El separador forma
   parte del patrón: sin él, la ruta de un gemelo YA desempaquetado se reescribiría dos
   veces («app.asar.unpacked.unpacked»). */
const gemeloDesempaquetado = (ruta) => ruta.replace(/app\.asar([\\/])/, ASAR_UNPACKED + '$1');

function rutaScriptReal(ruta, { fsMod = fs, dirCache = DIR_CACHE } = {}) {
  if (typeof ruta !== 'string' || !/app\.asar[\\/]/.test(ruta)) return ruta;

  const gemelo = gemeloDesempaquetado(ruta);
  try { if (fsMod.existsSync(gemelo)) return gemelo; } catch {}

  try {
    const contenido = fsMod.readFileSync(ruta);
    fsMod.mkdirSync(dirCache, { recursive: true });
    const destino = path.join(dirCache, path.basename(ruta));
    /* La copia se REFRESCA cuando cambia el contenido: una actualización de la app no
       puede dejar un guion viejo en caché —y el guion es el protocolo de la voz. */
    let iguales = false;
    try { iguales = fsMod.readFileSync(destino).equals(contenido); } catch {}
    if (!iguales) fsMod.writeFileSync(destino, contenido);
    return destino;
  } catch {
    /* Sin copia posible se devuelve la ruta original: el error de PowerShell ya se ve en
       el panel y es más útil que uno inventado aquí. */
    return ruta;
  }
}

module.exports = { rutaScriptReal };
