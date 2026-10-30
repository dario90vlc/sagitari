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
/* PARTES: el turno como secuencia (texto, razonamiento, herramienta, lista de tareas) para
   que el hilo se pueda repintar INTERCALADO, no como un muro de prosa con las herramientas
   aparte. El usuario lo pidió así: «que vaya mostrando las herramientas que va usando,
   thinking, respuestas». El texto del turno ya se guardaba entero en `content`; esto guarda
   ADEMÁS en qué orden ocurrió cada cosa.
   Dos topes, por el mismo motivo que MAX_TRAZA: conversations.json se lee entero al arrancar.
   Un tramo de texto se corta a 6000 caracteres —lo que se lee al reabrir, no lo que se
   envía al modelo— y el turno no guarda más de 120 partes. */
const MAX_PARTES = 120;
const MAX_TEXTO_PARTE = 6000;
const MAX_TEXTO_TURNO = 24000; // presupuesto de texto de TODO el turno: un turno largo no
// convierte una conversación en megabytes, y el texto completo sigue estando en `content`.
/* El contador vive en una clave SÍMBOLO: `JSON.stringify` la ignora, así que no viaja al
   historial guardado (sería un campo más que nadie lee). */
const TXT = Symbol('textoDelTurno');
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
  turnTraces.set(claveTraza(convId), { tools: [], think: null, todos: null, parts: [] });
}

/* ---- partes: la secuencia real del turno ------------------------------------------
   La parte ABIERTA es siempre la última: un tramo de texto se sigue escribiendo mientras
   lleguen deltas, y se cierra solo cuando llega una herramienta (la siguiente parte ya no
   es de texto). Así el orden de `parts` es el orden en que ocurrió todo. */
function abrirParte(t, parte) {
  if (!t.parts) t.parts = [];
  if (t.parts.length >= MAX_PARTES) return null;
  t.parts.push(parte);
  return parte;
}
function ultimaParte(t, k) {
  if (!t.parts || !t.parts.length) return null;
  const p = t.parts[t.parts.length - 1];
  return p && p.k === k ? p : null;
}
/* Añade texto a una parte sin pasarse de los dos topes (por parte y por turno). */
function anexaTexto(t, p, s) {
  if (!s) return;
  if (!p) {
    // ni una parte más: lo que llegue ya no se puede repintar desde `parts`
    t.cortado = true;
    return;
  }
  const texto = String(s);
  const cabe = Math.min(MAX_TEXTO_PARTE - String(p.text).length, MAX_TEXTO_TURNO - (t[TXT] || 0));
  // el texto que no cabe se pierde: se marca el turno para que al reabrir mande `content`
  if (texto.length > cabe) t.cortado = true;
  if (cabe <= 0) return;
  const trozo = texto.slice(0, cabe);
  p.text = String(p.text) + trozo;
  t[TXT] = (t[TXT] || 0) + trozo.length;
}
function trazaApunta(convId, e) {
  const turnTrace = turnTraces.get(claveTraza(convId));
  if (!turnTrace) return;
  if (e.type === 'tool') {
    if (turnTrace.tools.length < MAX_TRAZA) {
      turnTrace.tools.push({ name: e.name, args: argsTraza(e.name, e.args), subagent: e.subagent || null });
    }
    abrirParte(turnTrace, {
      k: 'tool',
      name: e.name,
      args: argsTraza(e.name, e.args),
      subagent: e.subagent || null,
      member: e.member || null,
    });
    return;
  }
  if (e.type === 'tool_result') {
    if (turnTrace.parts) {
      for (let i = turnTrace.parts.length - 1; i >= 0; i--) {
        const p = turnTrace.parts[i];
        if (p.k === 'tool' && p.name === e.name && p.ok === undefined) {
          p.ok = e.ok === undefined || e.ok === null ? null : !!e.ok;
          p.ms = Number(e.durationMs) || 0;
          p.result = clipTraza(e.result, 1200);
          break;
        }
      }
    }
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
    abrirParte(turnTrace, {
      k: 'delegate',
      subagent: String(e.subagent || ''),
      status: String(e.status || 'OK'),
      ms: Number(e.durationMs) || 0,
      result: clipTraza(e.result, 900),
    });
    return;
  }
  if (e.type === 'thinking_done') {
    turnTrace.think = { text: clipTraza(e.text, 4000), ms: Number(e.durationMs) || 0 };
    // la parte de razonamiento abierta se cierra con el texto definitivo del motor
    const p = ultimaParte(turnTrace, 'think');
    if (p && !p.fin) {
      if (e.text) p.text = clipTraza(e.text, MAX_TEXTO_PARTE);
      p.ms = Number(e.durationMs) || 0;
      p.fin = true;
    }
    return;
  }
  /* ---- y la secuencia, que es lo que pinta el hilo intercalado ---- */
  if (e.type === 'delta') {
    if (e.subagent || !e.text) return; // el de un subagente vive en su tarjeta
    let p = ultimaParte(turnTrace, 'text');
    if (!p) p = abrirParte(turnTrace, { k: 'text', text: '' });
    anexaTexto(turnTrace, p, e.text);
    return;
  }
  if (e.type === 'thinking_delta') {
    if (e.subagent || !e.text) return;
    let p = ultimaParte(turnTrace, 'think');
    if (!p || p.fin) p = abrirParte(turnTrace, { k: 'think', text: '', ms: 0 });
    anexaTexto(turnTrace, p, e.text);
    return;
  }
  if (e.type === 'thinking_reset') {
    // un reintento en otro modelo empieza a pensar de nuevo: el tramo anterior ya no es
    // parte de lo que se lee, y dejarlo suelto en el historial lo haría pasar por trabajo
    const p = ultimaParte(turnTrace, 'think');
    if (p && !p.fin) turnTrace.parts.pop();
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
    /* La lista se actualiza varias veces por turno: en la secuencia va UNA tarjeta, la de
       su último estado, no una por actualización. */
    const p = ultimaParte(turnTrace, 'todos');
    if (p) p.todos = turnTrace.todos;
    else abrirParte(turnTrace, { k: 'todos', todos: turnTrace.todos });
  }
}
function trazaActual(convId) {
  return turnTraces.get(claveTraza(convId)) || null;
}
function trazaCerrar(convId) {
  turnTraces.delete(claveTraza(convId));
}

module.exports = {
  MAX_TRAZA,
  MAX_PARTES,
  MAX_TEXTO_PARTE,
  MAX_TEXTO_TURNO,
  clipTraza,
  argsTraza,
  trazaNueva,
  trazaApunta,
  trazaActual,
  trazaCerrar,
};
