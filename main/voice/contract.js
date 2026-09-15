'use strict';

/* Contrato del modo voz: una sola forma de evento y de motor.
 *
 * Existe porque los motores cambian de fase en fase (hoy Windows; mañana Whisper y
 * Piper) y el resto de la app no debería enterarse. Las pruebas inyectan motores de
 * mentira por este mismo contrato, así que lo que se prueba es lo que se usará.
 */

const ESTADOS = ['escuchando', 'oyendo', 'pensando', 'hablando', 'confirmando', 'error'];
const TIPOS = ['state', 'level', 'partial', 'final', 'notice', 'error'];
const CAPACIDADES_BASE = { partials: false, confidence: false, level: false };

function assertEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('evento de voz vacío');
  if (!TIPOS.includes(ev.type)) throw new Error('tipo de evento desconocido: ' + ev.type + ' (válidos: ' + TIPOS.join(', ') + ')');
  switch (ev.type) {
    case 'state':
      if (!ESTADOS.includes(ev.state)) throw new Error('estado de voz desconocido: ' + ev.state);
      break;
    case 'level':
      if (typeof ev.value !== 'number' || ev.value < 0 || ev.value > 1) throw new Error('nivel fuera de 0..1: ' + ev.value);
      break;
    case 'partial':
    case 'notice':
      if (typeof ev.text !== 'string') throw new Error(ev.type + ' sin texto');
      break;
    case 'final':
      if (typeof ev.text !== 'string') throw new Error('final sin texto');
      if (ev.confidence !== null && ev.confidence !== undefined && typeof ev.confidence !== 'number') throw new Error('confianza no numérica');
      break;
    case 'error':
      if (typeof ev.text !== 'string') throw new Error('error sin texto');
      if (ev.fix !== undefined && typeof ev.fix !== 'string') throw new Error('el arreglo del error debe ser texto');
      break;
    default:
      break;
  }
}

function assertEngine(engine) {
  if (!engine || typeof engine !== 'object') throw new Error('motor vacío');
  if (typeof engine.nombre !== 'string' || !engine.nombre) throw new Error('el motor necesita nombre');
  if (!engine.capacidades || typeof engine.capacidades !== 'object') throw new Error('el motor necesita capacidades');
  for (const cap of ['partials', 'confidence', 'level']) {
    if (typeof engine.capacidades[cap] !== 'boolean') throw new Error('capacidad mal declarada: ' + cap);
  }
  for (const fn of ['start', 'push', 'stop']) {
    if (typeof engine[fn] !== 'function') throw new Error('al motor le falta ' + fn + '()');
  }
}

module.exports = { ESTADOS, TIPOS, CAPACIDADES_BASE, assertEvent, assertEngine };
