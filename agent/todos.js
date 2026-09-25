'use strict';
/*
 * todos.js — v2.6: la lista de tareas VIVA del agente.
 *
 *  Los agentes que trabajan de verdad (Claude Code, Hermes) no solo actúan: mantienen un
 *  plan de trabajo visible que se va marcando paso a paso. Esa lista hace dos cosas que
 *  ninguna herramienta hace por sí sola:
 *
 *   · LE DA MEMORIA DE PROGRESO AL MODELO. En un turno largo el historial se recorta y el
 *     volcado de un archivo pesa más que el plan que se decidió al principio. La lista va
 *     en el prompt de sistema en cada paso, así que «ya hice los pasos 1 y 2, voy por el 3»
 *     no se pierde nunca.
 *   · LE ENSEÑA AL USUARIO QUÉ FALTA. El plan del modo PLAN se dibujaba a partir del TEXTO
 *     de la respuesta (frágil y decorativo). Aquí el modelo POSEE la lista: la crea, la
 *     actualiza y el usuario la ve avanzar en pantalla.
 *
 *  Este módulo es PURO (sin estado ni disco): normaliza lo que manda el modelo, lo resume
 *  para él y lo convierte en el bloque que se inyecta en el prompt. El estado vive en el
 *  Agent (agent/agent.js), que es su dueño natural.
 *
 *  Tolerante a propósito con la entrada: los modelos escriben estados en inglés, en español,
 *  con guiones o con sinónimos. Un formato raro no debe romper la lista; se corrige y se
 *  avisa. Lo que NO se tolera es inventarse tareas: si un elemento no trae contenido, se
 *  ignora (o se ignora la llamada entera si no hay un solo elemento válido).
 */

const MAX_TAREAS = 20;    // tope de pasos: una lista de 60 no es un plan, es un volcado
const MAX_TEXTO = 200;    // caracteres por tarea

/* Estados canónicos (los mismos que expone la herramienta al modelo). */
const ESTADOS = ['pending', 'in_progress', 'completed'];

/* Sinónimos frecuentes → estado canónico. Todo en minúsculas. */
const ALIAS_ESTADO = {
  pending: 'pending', pendiente: 'pending', pendientes: 'pending', todo: 'pending', 'por hacer': 'pending', por_hacer: 'pending', abierta: 'pending', nueva: 'pending',
  in_progress: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', 'en curso': 'in_progress', en_curso: 'in_progress', doing: 'in_progress', active: 'in_progress', actual: 'in_progress', en_progreso: 'in_progress', haciendo: 'in_progress',
  completed: 'completed', complete: 'completed', done: 'completed', completada: 'completed', completado: 'completed', hecha: 'completed', hecho: 'completed', listo: 'completed', lista: 'completed', terminada: 'completed', terminado: 'completed',
};

/** Marca de una tarea para los resúmenes de texto (mismo símbolo para el modelo y la UI). */
function marcador(status) {
  return status === 'completed' ? '[x]' : (status === 'in_progress' ? '[>]' : '[ ]');
}

/** Cuenta de estados, para el prompt y la interfaz. */
function estado(todos) {
  const l = Array.isArray(todos) ? todos : [];
  const completadas = l.filter(t => t && t.status === 'completed').length;
  const enCurso = l.filter(t => t && t.status === 'in_progress').length;
  return { total: l.length, completadas, enCurso, pendientes: Math.max(0, l.length - completadas - enCurso) };
}

/** Recorta y aplana un texto de tarea a una línea. */
function limpiar(s, max = MAX_TEXTO) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

/**
 * Normaliza la entrada del modelo.
 *
 * @param {*} entrada — el array `todos` tal cual lo envió el modelo.
 * @returns {{ok: boolean, todos?: Array, aviso?: string, error?: string}}
 *   ok:false solo cuando la entrada no es utilizable (no hay lista); el llamante
 *   convierte `error` en el resultado de la herramienta para que el modelo lo corrija.
 */
function normalizar(entrada) {
  if (entrada === undefined || entrada === null) {
    return { ok: false, error: 'Falta el campo "todos": debe ser una lista de tareas. Envía [] para borrar la lista.' };
  }
  if (!Array.isArray(entrada)) {
    return { ok: false, error: '"todos" debe ser una LISTA de objetos {content, status}. Recibido: ' + typeof entrada + '.' };
  }
  const todos = [];
  const avisos = [];
  const vistos = new Set();
  let truncada = false;
  for (const raw of entrada) {
    if (todos.length >= MAX_TAREAS) { truncada = true; break; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { avisos.push('se ignoró un elemento que no es un objeto'); continue; }
    const content = limpiar(raw.content != null ? raw.content : (raw.text != null ? raw.text : raw.tarea));
    if (!content) { avisos.push('se ignoró una tarea sin "content"'); continue; }
    const clave = content.toLowerCase();
    if (vistos.has(clave)) { avisos.push('se ignoró una tarea duplicada: «' + content.slice(0, 60) + '»'); continue; }
    vistos.add(clave);
    const bruto = raw.status != null ? raw.status : (raw.estado != null ? raw.estado : 'pending');
    const status = ALIAS_ESTADO[String(bruto).toLowerCase().trim()] || 'pending';
    const activeForm = limpiar(raw.activeForm != null ? raw.activeForm : raw.active_form);
    todos.push({ id: 'T' + (todos.length + 1), content, status, activeForm });
  }
  /* Una sola tarea en curso: dos «in_progress» a la vez no describen nada y la lista
     dejaría de decir qué se está haciendo AHORA. Se conserva la primera y el resto pasan
     a pendientes, con aviso para que el modelo lo sepa. */
  let enCurso = 0;
  for (const t of todos) {
    if (t.status !== 'in_progress') continue;
    enCurso++;
    if (enCurso > 1) {
      t.status = 'pending';
      avisos.push('solo puede haber una tarea "in_progress": «' + t.content.slice(0, 50) + '» pasó a pendiente');
    }
  }
  if (truncada) avisos.push('la lista se recortó a ' + MAX_TAREAS + ' tareas');
  return { ok: true, todos, aviso: avisos.length ? avisos.join('; ') : '' };
}

/**
 * Resultado que recibe el modelo tras llamar a todo_write. Le devuelve la lista entera
 * (no solo un «ok») para que reaparezca en su contexto aunque el bloque del sistema se
 * haya recortado, y termina con el siguiente paso a dar.
 */
function resumen(todos) {
  const l = Array.isArray(todos) ? todos : [];
  const e = estado(l);
  if (!e.total) return 'Lista de tareas vacía: no hay nada pendiente.';
  const cab = `Lista de tareas actualizada — ${e.completadas} de ${e.total} completadas, ${e.enCurso} en curso, ${e.pendientes} pendientes.`;
  const cuerpo = l.map(t => `- ${marcador(t.status)} ${t.content}`).join('\n');
  const siguiente = (e.pendientes || e.enCurso)
    ? 'Sigue con la tarea en curso y vuelve a llamar a todo_write al terminarla.'
    : 'Todas completadas: cierra con tu resumen.';
  return cab + '\n' + cuerpo + '\n' + siguiente;
}

/**
 * Bloque para el prompt de sistema. Va vacío si no hay lista (nada de bloques muertos).
 * Se inyecta en CADA paso: es lo que sobrevive a los recortes de contexto.
 */
function bloquePrompt(todos) {
  const l = Array.isArray(todos) ? todos : [];
  if (!l.length) return '';
  const e = estado(l);
  const cuerpo = l.map(t => `- ${marcador(t.status)} ${t.content}`).join('\n');
  return 'LISTA DE TAREAS DEL TURNO (la mantiene todo_write; es tu memoria de progreso y sobrevive a los recortes de contexto)\n'
    + cuerpo + '\n'
    + `Progreso: ${e.completadas}/${e.total} completadas, ${e.enCurso} en curso, ${e.pendientes} pendientes.`
    + '\nManténla al día: marca completed en cuanto termines un paso y pon en in_progress solo el que estés haciendo ahora. '
    + 'Si aparece un paso nuevo, añádelo reenviando la lista COMPLETA.';
}

/** Primer texto de tarea apto para voz/etiqueta (presente si lo hay, si no el imperativo). */
function etiquetaActiva(t) {
  if (!t) return '';
  return (t.status === 'in_progress' && t.activeForm) ? t.activeForm : t.content;
}

module.exports = {
  MAX_TAREAS, MAX_TEXTO, ESTADOS, ALIAS_ESTADO,
  marcador, estado, limpiar, normalizar, resumen, bloquePrompt, etiquetaActiva,
};
