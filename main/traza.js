'use strict';

/* traza.js — rastro compacto del turno (tarjetas de herramienta +
 * razonamiento que se cuelgan del mensaje del asistente).
 * Estado COMPARTIDO entre agentEmit (main.js, cierra el turno) y los handlers
 * chat:send/retry (router ipc-chat.js, abren el turno). Un solo módulo = un
 * solo rastro: antes vivía duplicado y podían divergir.
 *
 * UN rastro POR CONVERSACIÓN: con varias conversaciones a la vez, un único rastro
 * global mezclaría las tarjetas del turno de una pestaña con las del turno de otra
 * (y el cierre de una cerraría el rastro de la que está trabajando). Todo el estado
 * se indexa por el id de conversación; sin id (los usos de antes) la clave es '' y el
 * comportamiento es el de siempre. */

const { enmascararArgs, redactText } = require('../agent/runlog'); // máscara del log: campos sensibles y patrones

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
const MAX_TRAZA = 80; // herramientas por turno que se conservan
/* TODO el texto libre del rastro pasa por aquí, así que la máscara del log vive en este
   único sitio: se enmascaran los patrones ANTES de recortar —al revés, un secreto que
   cayera justo en el corte quedaría medio escrito— y así un resultado de `run_command`
   (un `set` con una clave, un `curl` con `Authorization`, un JWT) no viaja en claro a
   conversations.json. Va aquí y no en cada llamada para que un sitio nuevo que guarde
   texto en el rastro no pueda olvidarse de la máscara. */
const clipTraza = (s, n) => {
  const t = redactText(String(s == null ? '' : s));
  return t.length > n ? t.slice(0, n) + '\n… (recortado: ' + (t.length - n) + ' caracteres más)' : t;
};
function argsTraza(name, args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  /* Recorta TAMBIÉN los argumentos que no son cadenas: `apply_patch` recibe
     `changes: [{path, old_string, new_string}]` con el texto entero de cada cambio, y la
     rama anterior los guardaba tal cual. El rastro se cuelga del mensaje y se persiste en
     conversations.json (que se lee ENTERO al arrancar), así que el mismo contenido que un
     `write_file` sí recortaba entraba por la puerta de al lado sin ningún tope. */
  const clipArg = (v) => {
    if (typeof v === 'string')
      // una imagen en base64 o el contenido entero de un archivo no pintan nada en una
      // tarjeta y multiplicarían el tamaño del historial guardado
      return /^data:[\w/+.-]+;base64,/.test(v) ? '(imagen adjunta, no guardada)' : clipTraza(v, 1200);
    if (Array.isArray(v)) return v.map(clipArg);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipArg(x)]));
    return v;
  };
  // una contraseña tecleada en la web o escrita en el portapapeles no viaja al
  // historial: el rastro se guarda en conversations.json, así que lleva la misma
  // máscara que el log (misma tabla de campos sensibles, un solo sitio que decida).
  // Los patrones de secreto (`Bearer …`, `sk-…`, JWT) los pone clipTraza, igual que
  // `redactValue` en el log.
  for (const [k, v] of Object.entries(enmascararArgs(name, args))) out[k] = clipArg(v);
  return out;
}
const turnTraces = new Map(); // convId -> rastro del turno en curso
const claveTraza = (convId) => String(convId == null ? '' : convId);
function trazaNueva(convId) {
  turnTraces.set(claveTraza(convId), { tools: [], think: null, todos: null });
}
function trazaApunta(convId, e) {
  const turnTrace = turnTraces.get(claveTraza(convId));
  if (!turnTrace) return;
  if (e.type === 'tool') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({ name: e.name, args: argsTraza(e.name, e.args), subagent: e.subagent || null });
    }
    return;
  }
  if (e.type === 'tool_result') {
    // cierra la ÚLTIMA llamada de ese nombre que siga abierta: dos llamadas a la misma
    // herramienta en un turno tienen que cerrarse en orden, no todas a la vez
    for (let i = turnTrace.tools.length - 1; i >= 0; i--) {
      const t = turnTrace.tools[i];
      if (t.name === e.name && t.ok === undefined) {
        t.ok = e.ok === undefined || e.ok === null ? null : !!e.ok;
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
        delegate: String(e.subagent || ''),
        status: String(e.status || 'OK'),
        ms: Number(e.durationMs) || 0,
        result: clipTraza(e.result, 900),
      });
    }
    return;
  }
  if (e.type === 'thinking_done') {
    turnTrace.think = { text: clipTraza(e.text, 4000), ms: Number(e.durationMs) || 0 };
    return;
  }
  /* v2.6: la ÚLTIMA lista de tareas del turno se guarda con el mensaje: al reabrir la
     conversación, el usuario vuelve a ver en qué quedó el trabajo (no solo el texto).
     Se acota cada tarea como todo lo demás del rastro. */
  if (e.type === 'todos') {
    turnTrace.todos = Array.isArray(e.todos)
      ? e.todos.map((t) => ({
          content: clipTraza(t && t.content, 240),
          status: String((t && t.status) || 'pending'),
          activeForm: clipTraza(t && t.activeForm, 240),
        }))
      : [];
  }
}
function trazaActual(convId) {
  return turnTraces.get(claveTraza(convId)) || null;
}
function trazaCerrar(convId) {
  turnTraces.delete(claveTraza(convId));
}

module.exports = { MAX_TRAZA, clipTraza, argsTraza, trazaNueva, trazaApunta, trazaActual, trazaCerrar };
