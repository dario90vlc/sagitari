'use strict';
/*
 * hooks.js — v2.5: tus comandos, enganchados a los momentos del agente.
 *
 *  La idea es la de siempre en un editor: que la herramienta encaje en TU proyecto
 *  en vez de traer sus manías metidas a fuego. Dos enganches:
 *
 *   · `hookEditar`  — después de escribir en un archivo (formatear, lint --fix,
 *                     regenerar, lo que quieras). Su salida se le enseña al modelo.
 *   · `hookCerrar`  — antes de dar el turno por cerrado (lint del proyecto, pruebas,
 *                     lo que quieras). Si falla, el turno NO cierra: el modelo ve la
 *                     salida y lo arregla, igual que con las pruebas del proyecto.
 *
 *  Aquí solo vive la parte pura (expansión de la plantilla); quien ejecuta es
 *  `executors.ejecutarHook` (usa el mismo lanzador de comandos que el resto de la app,
 *  con su resolución de `node`/`npm` en Windows y su cwd en el espacio de trabajo).
 *
 *  Marcadores disponibles en la plantilla:
 *   {{file}}  → el primer archivo escrito, entre comillas
 *   {{files}} → todos los archivos escritos en ese paso, entre comillas
 *   {{dir}}   → el espacio de trabajo, entre comillas
 *
 *  Las comillas importan: las rutas de Windows llevan espacios.
 */

const path = require('path');

const MAX_POR_HOOK = 2000;   // caracteres de salida que se le enseñan al modelo

/** Cita una ruta para que sobreviva a los espacios (cmd.exe y sh entienden comillas dobles). */
function citar(ruta) {
  return '"' + String(ruta).replace(/"/g, '\\"') + '"';
}

/**
 * Sustituye los marcadores de la plantilla.
 * @param {string} plantilla
 * @param {{ws?: string, archivos?: string[]}} ctx
 * @returns {string} comando listo para lanzar (sin marcadores)
 */
function expandir(plantilla, { ws = '', archivos = [] } = {}) {
  const abs = (archivos || []).map(f => (path.isAbsolute(f) ? f : path.join(ws || '.', f)));
  const comando = String(plantilla == null ? '' : plantilla);
  return comando
    .replace(/\{\{\s*file\s*\}\}/gi, () => citar(abs[0] || path.join(ws || '.', '')))
    .replace(/\{\{\s*files\s*\}\}/gi, () => abs.map(citar).join(' '))
    .replace(/\{\{\s*dir\s*\}\}/gi, () => citar(ws || '.'));
}

/** ¿La plantilla usa algún marcador? (para avisar en Ajustes de una plantilla sosa) */
function tieneMarcadores(plantilla) {
  return /\{\{\s*(file|files|dir)\s*\}\}/i.test(String(plantilla || ''));
}

/** Recorta la salida de un hook para que no inunde el contexto. */
function recortar(texto, max = MAX_POR_HOOK) {
  const t = String(texto == null ? '' : texto).trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + '\n[…salida recortada]';
}

/** Texto que se le enseña al modelo (y al usuario) con el resultado de un hook. */
function resumen(resultado, { etiqueta = 'Hook', comando = '' } = {}) {
  if (!resultado) return '';
  const salida = recortar(resultado.texto);
  if (resultado.ok) {
    return salida
      ? `${etiqueta} «${comando}» OK:\n${salida}`
      : `${etiqueta} «${comando}» OK (sin salida).`;
  }
  const motivo = resultado.code === null || resultado.code === undefined
    ? `no se pudo ejecutar${resultado.texto ? ': ' + recortar(resultado.texto, 300) : ''}`
    : `falló (código ${resultado.code})`;
  return `${etiqueta} «${comando}» ${motivo}${salida ? ':\n' + salida : ''}`;
}

module.exports = { expandir, tieneMarcadores, recortar, resumen, citar, MAX_POR_HOOK };
