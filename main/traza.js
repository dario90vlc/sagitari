'use strict';

/* traza.js — rastro compacto del turno (tarjetas de herramienta +
 * razonamiento que se cuelgan del mensaje del asistente).
 * Estado COMPARTIDO entre agentEmit (main.js, cierra el turno) y los handlers
 * chat:send/retry (router ipc-chat.js, abren el turno). Un solo módulo = un
 * solo rastro: antes vivía duplicado y podían divergir. */

/* ---- rastro del turno: lo que el usuario ve en las tarjetas ----
   Las tarjetas de herramienta, el razonamiento y sus tiempos NO se guardaban en la
   conversación: al cerrar la app y volver a abrirla, el hilo repintaba solo las burbujas
   de texto y todo el trabajo del turno desaparecía de la vista (el usuario lo notó: «las
   herramientas que usó ya no se muestran»). Aquí se acumula un rastro COMPACTO —nombre,
   argumentos acotados, resultado acotado, duración y si falló— y se cuelga del mensaje del
   asistente al cerrar el turno, que es justo lo que el chat necesita para repintarlo.

   Se acota a propósito: `conversations.json` se lee ENTERO al arrancar la app, así que el
   rastro no puede crecer sin freno (el argumento de un write_file es un archivo completo,
   y un resultado de run_command puede traer miles de líneas). */
const MAX_TRAZA = 80;              // herramientas por turno que se conservan
const clipTraza = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '\n… (recortado: ' + (t.length - n) + ' caracteres más)' : t;
};
function argsTraza(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    // una imagen en base64 o el contenido entero de un archivo no pintan nada en una
    // tarjeta y multiplicarían el tamaño del historial guardado
    out[k] = /^data:[\w/+.-]+;base64,/.test(v) ? '(imagen adjunta, no guardada)' : clipTraza(v, 1200);
  }
  return out;
}
let turnTrace = null;
function trazaNueva() { turnTrace = { tools: [], think: null }; }
function trazaApunta(e) {
  if (!turnTrace) return;
  if (e.type === 'tool') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({ name: e.name, args: argsTraza(e.args), subagent: e.subagent || null });
    }
    return;
  }
  if (e.type === 'tool_result') {
    // cierra la ÚLTIMA llamada de ese nombre que siga abierta: dos llamadas a la misma
    // herramienta en un turno tienen que cerrarse en orden, no todas a la vez
    for (let i = turnTrace.tools.length - 1; i >= 0; i--) {
      const t = turnTrace.tools[i];
      if (t.name === e.name && t.ok === undefined) {
        t.ok = (e.ok === undefined || e.ok === null) ? null : !!e.ok;
        t.ms = Number(e.durationMs) || 0;
        t.result = clipTraza(e.result, 1200);
        return;
      }
    }
    return;
  }
  if (e.type === 'delegate_done') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({
        delegate: String(e.subagent || ''), status: String(e.status || 'OK'),
        ms: Number(e.durationMs) || 0, result: clipTraza(e.result, 900),
      });
    }
    return;
  }
  if (e.type === 'thinking_done') {
    turnTrace.think = { text: clipTraza(e.text, 4000), ms: Number(e.durationMs) || 0 };
  }
}
function trazaActual() { return turnTrace; }
function trazaCerrar() { turnTrace = null; }

module.exports = { MAX_TRAZA, clipTraza, argsTraza, trazaNueva, trazaApunta, trazaActual, trazaCerrar };
