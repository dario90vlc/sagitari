'use strict';

/* Funciones puras de historial y transcripción del agente.
   Se extraen de agent.js para que sean testeables y reutilizables.
   No dependen de nada externo: solo reciben datos y devuelven datos. */

/* Tope de mensajes que viajan al modelo (el historial completo vive en la UI). */
const MAX_HISTORY = 40;

/**
 * Recorta el historial sin partir un intercambio de herramientas: si el corte
 * dejara un mensaje 'tool' al principio, quedaría huérfano (sin su assistant) y
 * el proveedor rechazaría la petición.
 */
function trimHistory(history, max = MAX_HISTORY) {
  if (history.length <= max) return history;
  let start = history.length - max;
  while (start < history.length && history[start].role === 'tool') start++;
  return history.slice(start);
}

/**
 * Convierte el historial en mensajes válidos para la API. La API exige que cada
 * `tool_call` de un assistant tenga su respuesta `tool` con el mismo id; un corte
 * a mitad de un intercambio (error, Detener, recorte) dejaría el historial
 * inválido y el proveedor devolvería 400 en el siguiente turno. Aquí se
 * descartan los pares incompletos en vez de enviarlos.
 */
function payloadMessages(history) {
  const out = [];
  const pending = new Set(); // tool_call_id esperando su respuesta
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.role === 'tool') {
      if (!pending.has(h.tool_call_id)) continue; // huérfano: se descarta
      pending.delete(h.tool_call_id);
      out.push({ role: 'tool', tool_call_id: h.tool_call_id, ...(h.name ? { name: h.name } : {}), content: h.content });
      continue;
    }
    if (h.role === 'assistant' && h.tool_calls && h.tool_calls.length) {
      const answered = new Set();
      for (let j = i + 1; j < history.length && history[j].role === 'tool'; j++) answered.add(history[j].tool_call_id);
      const calls = h.tool_calls.filter((tc) => answered.has(tc.id));
      if (!calls.length) {
        if (h.content) out.push({ role: 'assistant', content: h.content });
        continue;
      }
      const msg = { role: 'assistant', content: h.content || '', tool_calls: calls };
      if (!msg.content) delete msg.content;
      out.push(msg);
      for (const tc of calls) pending.add(tc.id);
      continue;
    }
    out.push({ role: h.role, content: h.content });
  }
  return out;
}

/* Tope de la narración guardada por turno (15k caracteres): un turno de 40
   herramientas narra mucho y la conversación se relee entera en cada arranque.
   Se recorta por el MEDIO (el principio dice qué se pidió, el final qué quedó),
   nunca por el final, que es lo que el usuario relee. Lógica pura. */
const MAX_TRANSCRIPT = 15000;
function recortarTranscripcion(t) {
  const s = String(t || '');
  if (s.length <= MAX_TRANSCRIPT) return s;
  return s.slice(0, 4000) + '\n\n[…se omite parte de la narración intermedia…]\n\n' + s.slice(-11000);
}

/* Id de confirmación irrepetible: dos tarjetas en el mismo milisegundo no deben
   compartir id (la UI las distingue por él). */
function newConfirmId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  MAX_HISTORY,
  MAX_TRANSCRIPT,
  trimHistory,
  payloadMessages,
  recortarTranscripcion,
  newConfirmId,
};
