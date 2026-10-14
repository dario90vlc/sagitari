'use strict';

/* runtimes.js — un agente vivo por conversación.
 *
 * Hasta ahora había UN solo Agent en main.js y cada conversación lo reapuntaba al
 * abrirse: abrir otra pestaña mientras la primera trabajaba le robaba el historial y
 * la ejecución (el agente se reutilizaba para otra cosa a mitad de turno). Aquí vive
 * el registro convId -> agente, para que cada conversación tenga el suyo y pueda estar
 * trabajando a la vez que las demás.
 *
 * Dos reglas que no se pueden saltar:
 *   - El historial se hidrata UNA vez, al crear el runtime. Hidratar
 *     (`agent.history = …`) tira el resumen plegado, la lista de tareas, el uso
 *     acumulado y el rastro del turno; repetirlo en cada `conv:open` borraría el
 *     estado de una conversación que solo se estaba mirando.
 *   - NUNCA se hidrata con el agente trabajando: el bucle tiene cogidas la referencia
 *     al array de mensajes y a su historial, así que reemplazarlos a mitad dejaría el
 *     turno escribiendo en un historial que ya no se envía.
 *
 * Los runtimes ociosos se podan por encima del tope (el más viejo primero). El
 * historial se puede volver a hidratar desde conversations.json, así que podar cuesta el
 * resumen/uso de una conversación que llevaba rato sin tocarse y NADA más: el aviso de
 * descarte viaja con el motivo («podado», «borrada», «cierre») y quien lo escucha decide
 * qué soltar. Un agente trabajando no se poda jamás.
 */

const { sessionFor } = require('../agent/opencode');

const MAX_RUNTIMES = 8;

/** La clave del mapa es el id de conversación tal cual (string). */
const clave = (convId) => String(convId == null ? '' : convId);

/**
 * @param {object} deps
 * @param {(convId: string) => object} deps.createAgent fábrica del agente (main.js: misma que el chat)
 * @param {(convId: string) => Array|null} deps.mensajesDe mensajes guardados de la conversación
 *   (null si ya no existe: la conversación se borró y el runtime está de salida)
 * @param {() => string|null} [deps.convActual] id de la conversación abierta, para las
 *   llamadas que no mandan ninguno (lo que hacía el agente único de antes)
 * @param {(convId: string, motivo: 'podado'|'borrada'|'cierre') => void} [deps.onDispose] al
 *   soltar el runtime de una conversación (borrada, podada o al cerrar la app): lo que main
 *   tenga que limpiar de ella (su rastro del turno) sin que este módulo sepa qué es. El
 *   motivo importa: podar un runtime OCIOSO no es borrar la conversación (main no olvida
 *   las pre-imágenes de un turno podado, porque su «Deshacer el cambio» sigue en pantalla).
 */
function createRuntimes({ createAgent, mensajesDe, convActual = () => null, onDispose = null }) {
  const runtimes = new Map(); // convId -> { convId, agent, lastUsedAt, hidratado }

  /** El id con el que se indexa: el que llega y, si no llega, el de la conversación
      abierta. Devuelve '' si tampoco hay ninguna (nada que resolver todavía). */
  function idDe(convId) {
    const s = clave(convId);
    if (s) return s;
    const actual = convActual();
    return actual ? clave(actual) : '';
  }

  function hidratar(rt) {
    if (!rt || rt.hidratado || rt.agent.isBusy()) return;
    const mensajes = mensajesDe(rt.convId);
    // La conversación se borró mientras el runtime estaba vivo (o nunca existió): no
    // hay nada que hidratar y sí mucho que romper (dejaría el hilo anterior dentro).
    if (!mensajes) return;
    rt.agent.useSession(rt.convId);
    rt.agent.history = mensajes.map((m) => ({ role: m.role, content: m.content }));
    rt.hidratado = true;
  }

  /** Poda LRU: fuera los ociosos más viejos hasta volver al tope. `salvo` es el que se
      acaba de crear y no se toca ni aunque fuera el más viejo (lo es: acaba de entrar).
      El motivo viaja al aviso: podar un runtime OCIOSO no es borrar la conversación, y
      quien escuche no puede tratar las dos cosas igual (main.js no olvida las
      pre-imágenes de un turno podado: su botón «Deshacer el cambio» sigue en pantalla). */
  function podar(salvo = null) {
    if (runtimes.size <= MAX_RUNTIMES) return;
    const ociosos = [...runtimes.values()]
      .filter((rt) => rt.convId !== salvo && !rt.agent.isBusy())
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (runtimes.size > MAX_RUNTIMES && ociosos.length) {
      const rt = ociosos.shift();
      runtimes.delete(rt.convId);
      avisar(rt.convId, 'podado');
    }
  }

  function avisar(convId, motivo) {
    try {
      if (onDispose) onDispose(convId, motivo);
    } catch {}
  }

  /** El agente de esa conversación, creándolo (e hidratándolo) si es la primera vez.
      Devuelve null si no hay conversación que resolver (ni id ni abierta). */
  function agentFor(convId) {
    const id = idDe(convId);
    if (!id) return null;
    let rt = runtimes.get(id);
    if (!rt) {
      rt = { convId: id, agent: createAgent(id), lastUsedAt: Date.now(), hidratado: false };
      runtimes.set(id, rt);
      hidratar(rt);
      podar(id);
    }
    rt.lastUsedAt = Date.now();
    hidratar(rt); // no-op si ya está hidratado; reintenta si antes pilló al agente trabajando
    return rt.agent;
  }

  /** El agente de esa conversación SIN crearlo (para preguntar si trabaja, sin coste). */
  function peek(convId) {
    const rt = runtimes.get(idDe(convId));
    return rt ? rt.agent : null;
  }

  /** ¿Hay un turno en vuelo en esa conversación? */
  function isBusy(convId) {
    const a = peek(convId);
    return !!(a && a.isBusy());
  }

  /** Todos los agentes vivos (la política de seguridad es global: se aplica a todos). */
  function allAgents() {
    return [...runtimes.values()].map((rt) => rt.agent);
  }

  /** Conversaciones con agente vivo (para no tirarlas del fichero al guardar). */
  function liveIds() {
    return [...runtimes.keys()];
  }

  /**
   * El «dueño» de los cambios de esa conversación: la clave con la que agent/cambios.js
   * separa las pre-imágenes de dos conversaciones que compartan espacio de trabajo.
   * Es el id de sesión del agente (lo mismo que usa el agente al escribir), y se puede
   * calcular SIN crear el agente: `sessionFor` es pura (misma conversación → mismo id).
   */
  function ownerOf(convId) {
    const id = idDe(convId);
    if (!id) return '';
    const rt = runtimes.get(id);
    if (rt) return rt.agent.sessionId;
    return sessionFor(id);
  }

  /** Suelta el runtime de una conversación. Si estaba trabajando, se para: su turno ya
      no puede guardar nada (no hay conversación) y sus confirmaciones no las vería nadie. */
  function dispose(convId) {
    const rt = runtimes.get(clave(convId));
    if (!rt) return;
    runtimes.delete(rt.convId);
    try {
      if (rt.agent.isBusy()) rt.agent.stop();
    } catch {}
    avisar(rt.convId, 'borrada');
  }

  /** Para lo que esté en vuelo en TODAS las conversaciones (el cierre de la app, o el
      proceso de render que se cae): el registro se queda como está. */
  function stopAll() {
    for (const rt of runtimes.values()) {
      try {
        if (rt.agent.isBusy()) rt.agent.stop();
      } catch {}
    }
  }

  /** Para todo y vacía el registro (cierre ordenado). */
  function disposeAll() {
    stopAll();
    for (const id of [...runtimes.keys()]) avisar(id, 'cierre');
    runtimes.clear();
  }

  return { agentFor, peek, isBusy, allAgents, liveIds, ownerOf, dispose, stopAll, disposeAll };
}

module.exports = { createRuntimes, MAX_RUNTIMES };
