'use strict';

/* Funciones de utilidad para el panel de ajustes.
   Se extraen de 30-ajustes.js para que sean más fáciles de mantener.
   Usan $ (jQuery-like) que es una variable global del renderer. */

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

module.exports = { smsg, mcpMsg, updVer, updSize, updMsg };
