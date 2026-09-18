'use strict';
/*
 * instrucciones.js — v2.5: la «constitución» del proyecto.
 *
 *  Todo agente bueno lee las reglas de la casa antes de tocar nada. Aquí se leen de
 *  ficheros de texto que el usuario controla:
 *
 *   · del proyecto:  SAGITARI.md, AGENTS.md, CLAUDE.md, .sagitari/AGENTS.md
 *   · tuyas, para todos los proyectos a la vez:  <carpeta de datos>/AGENTS.md
 *
 *  Y se inyectan en el prompt de sistema del agente principal Y de los subagentes.
 *  No es memoria ni contexto recuperado: es texto que se lee SIEMPRE y manda sobre
 *  las manías del modelo («en este repo los tests se llaman así», «no toques esta
 *  carpeta»). Por eso el bloque va marcado como obligatorio.
 *
 *  Reglas de esta pieza:
 *   · se lee con caché de firma (mtime+tamaño): releerlo en cada paso sería gratis
 *     en CPU pero carísimo en tokens, y un fichero que cambia se nota igual.
 *   · hay un tope de tamaño por archivo y en total: un AGENTS.md de 200 KB no puede
 *     comerse la ventana de contexto. Si se recorta, se dice.
 *   · si no hay ficheros, devuelve ''. Nada de bloques vacíos en el prompt.
 */

const fs = require('fs');
const path = require('path');

const NOMBRES = ['SAGITARI.md', 'AGENTS.md', 'CLAUDE.md', 'sagitari.md', 'agents.md'];
const NOMBRES_EXTRA = [path.join('.sagitari', 'AGENTS.md'), path.join('.github', 'SAGITARI.md')];
const MAX_POR_ARCHIVO = 6000;   // caracteres por fichero (≈1.500 tokens)
const MAX_TOTAL = 9000;         // caracteres del bloque entero

let _cache = new Map();   // ws -> { firma, texto, fuentes }

/** Fichero de instrucciones global (tuyo, vale para todos los proyectos). */
function rutaGlobal() {
  try { return path.join(require('./datadir').dataDir(), 'AGENTS.md'); } catch { return null; }
}

/** Rutas candidatas, en orden de prioridad (el proyecto primero). */
function candidatas(workspace) {
  const out = [];
  if (workspace) {
    const ws = path.resolve(workspace);
    for (const n of [...NOMBRES, ...NOMBRES_EXTRA]) out.push({ ruta: path.join(ws, n), donde: 'proyecto', etiqueta: n.replace(/\\/g, '/') });
  }
  const g = rutaGlobal();
  if (g) out.push({ ruta: g, donde: 'usuario', etiqueta: 'AGENTS.md (tus reglas globales)' });
  return out;
}

/** Firma barata del conjunto: si no cambia, no se vuelve a leer el contenido. */
function firmaDe(lista) {
  const partes = [];
  for (const c of lista) {
    try { const st = fs.statSync(c.ruta); partes.push(c.ruta + ':' + st.mtimeMs + ':' + st.size); }
    catch { /* no existe: no cuenta */ }
  }
  return partes.join('|');
}

/**
 * Lee las instrucciones del proyecto (y las globales).
 * @returns {{texto: string, fuentes: Array<{etiqueta: string, ruta: string, donde: string, chars: number, recortado: boolean}>}}
 */
function leer(workspace) {
  const lista = candidatas(workspace);
  const clave = String(workspace || '');
  const firma = firmaDe(lista);
  const hit = _cache.get(clave);
  if (hit && hit.firma === firma) return { texto: hit.texto, fuentes: hit.fuentes };

  const fuentes = [];
  const partes = [];
  const vistos = new Set();
  let total = 0;
  for (const c of lista) {
    /* En Windows y macOS el sistema NO distingue mayúsculas: `SAGITARI.md` y
       `sagitari.md` son el mismo archivo, así que sin esto las reglas entrarían
       DUPLICADAS en el prompt (mismo texto dos veces, y el doble de tokens). La
       comparación se hace por ruta real, no por el nombre que hemos escrito. */
    let real = c.ruta;
    try { real = fs.realpathSync(c.ruta); } catch { /* no existe: se ignora abajo */ }
    const clave = process.platform === 'linux' ? real : real.toLowerCase();
    if (vistos.has(clave)) continue;
    let bruto = '';
    try { bruto = fs.readFileSync(c.ruta, 'utf8'); } catch { continue; }
    vistos.add(clave);
    bruto = String(bruto).replace(/\r\n/g, '\n').trim();
    if (!bruto) continue;
    let recortado = false;
    if (bruto.length > MAX_POR_ARCHIVO) { bruto = bruto.slice(0, MAX_POR_ARCHIVO).trimEnd(); recortado = true; }
    if (total + bruto.length > MAX_TOTAL) {
      const queda = MAX_TOTAL - total;
      if (queda < 200) { recortado = true; fuentes.push({ etiqueta: c.etiqueta, ruta: c.ruta, donde: c.donde, chars: 0, recortado: true }); continue; }
      bruto = bruto.slice(0, queda).trimEnd();
      recortado = true;
    }
    total += bruto.length;
    partes.push({ titulo: c.etiqueta + (c.donde === 'usuario' ? '' : ' — ' + c.etiqueta) , texto: bruto, donde: c.donde, recortado });
    fuentes.push({ etiqueta: c.etiqueta, ruta: c.ruta, donde: c.donde, chars: bruto.length, recortado });
  }

  let texto = '';
  if (partes.length) {
    const trozos = partes.map(p => `— ${p.titulo}:\n${p.texto}`);
    texto = 'INSTRUCCIONES DEL PROYECTO (las ha escrito el usuario: son OBLIGATORIAS, ' +
      'mandan sobre tus costumbres y sobre lo que recuerdes de otros repositorios):\n' +
      trozos.join('\n\n');
    if (partes.some(p => p.recortado)) texto += '\n(recortado por tamaño: léelo entero con read_file si te hace falta)';
  }
  _cache.set(clave, { firma, texto, fuentes });
  return { texto, fuentes };
}

/** Bloque listo para pegar en el prompt de sistema, o '' si no hay instrucciones. */
function bloquePrompt(workspace) {
  try { return leer(workspace).texto; } catch { return ''; }
}

/** ¿Hay instrucciones en este espacio de trabajo? (para la UI) */
function hay(workspace) {
  try { return leer(workspace).fuentes.length > 0; } catch { return false; }
}

function _resetForTests() { _cache = new Map(); }

module.exports = { leer, bloquePrompt, hay, candidatas, rutaGlobal, NOMBRES, _resetForTests };
