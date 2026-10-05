'use strict';

/* Funciones de utilidad para el panel de ajustes.
   Se extraen de 30-ajustes.js para que sean más fáciles de mantener.
   Usan $ (jQuery-like) que es una variable global del renderer.

   Estas funciones se llaman desde OTROS scripts del renderer (30-ajustes.js,
   40-vistas.js), no desde este fichero: ESLint no ve ese uso entre ficheros
   y las da por sin usar. */
/* eslint-disable no-unused-vars */

function smsg(t) {
  $('#saveMsg').textContent = t;
}

/** Aviso del panel MCP (no reutiliza el del formulario de proveedores). */
function mcpMsg(t) {
  const el = $('#mcpMsg');
  if (el) el.textContent = t || '';
}

/** «2.3.0» → «v2.3.0»; sin versión conocida, un guion. */
function updVer(v) {
  return v ? 'v' + String(v).replace(/^v/i, '') : '—';
}

/** Tamaño legible («12,4 MB») para la nota de progreso. */
function updSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

/** Mensaje de la tarjeta (vacío lo limpia). */
function updMsg(text) {
  const el = $('#updMsg');
  if (el) el.textContent = text || '';
}

/* Sin module.exports: este fichero se carga con <script> en index.html, no con
   require(). En el navegador `module` no existe y la línea lanzaba
   «ReferenceError: module is not defined», que abortaba el fichero ENTERO: ninguna
   de las funciones de arriba quedaba definida y 30-ajustes.js se encontraba
   smsg() sin declarar. Al ser funciones de nivel superior ya viven en el scope
   global comparten el resto de los scripts. */
