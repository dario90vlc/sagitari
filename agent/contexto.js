'use strict';
/*
 * contexto.js — v2.5: cuánto sitio ocupa lo que le mandamos al modelo.
 *
 *  Un agente con 22 herramientas, el mapa del repositorio, las reglas del proyecto y un
 *  historial que crece manda en cada paso un prompt que no para de engordar. Dos cosas
 *  salen mal cuando eso no se mira:
 *
 *   · el coste y la latencia: cada paso vuelve a pagar el prefijo entero;
 *   · el silencio: el proveedor devuelve un error de contexto lleno y el turno muere
 *     justo cuando el trabajo estaba a punto.
 *
 *  Esto no adivina lo que va a costar: MIDE lo que se va a mandar (mensajes + definiciones
 *  de herramientas, que en un agente son miles de tokens que nadie cuenta) y dice en qué
 *  tramo está. Y cuando está apretado, deja una nota corta para el modelo: en ese momento
 *  lo que ayuda no es más contexto, es que conteste menos.
 *
 *  La estimación es por caracteres (≈4 por token en inglés, ≈3,5 en español y código). No
 *  es exacta y no pretende serlo: para decidir «queda sitio» o «ya no cabe» un margen del
 *  15% sobra, y a cambio no hay que llamar a ningún contador de tokens externo.
 */

const CHARS_POR_TOKEN = 3.6;

/* Ventana de contexto por familia de modelo. Sin esto se asume 128k, que es el mínimo
   cómodo de los modelos actuales: quedarse corto solo hace que se avise antes. */
const VENTANAS = [
  [/claude/i, 200000],
  [/gemini/i, 1000000],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo/i, 128000],
  [/o[1-4](-|$)|gpt-5/i, 200000],
  [/deepseek/i, 128000],
  [/qwen|glm|kimi|minimax|grok|mistral|llama/i, 128000],
];

/** Ventana de contexto de un modelo (`cfg.contextWindow` manda si está puesto). */
function ventanaDe(cfg = {}) {
  const explicito = Number(cfg.contextWindow);
  if (Number.isFinite(explicito) && explicito >= 8000) return explicito;
  const modelo = String(cfg.model || '');
  for (const [re, n] of VENTANAS) if (re.test(modelo)) return n;
  return 128000;
}

/** Estimación de tokens de un texto (o de cualquier cosa serializable). */
function estimarTokens(x) {
  const s = typeof x === 'string' ? x : JSON.stringify(x == null ? '' : x);
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_POR_TOKEN);
}

/**
 * Mide lo que se va a mandar.
 * @returns {{mensajes: number, herramientas: number, total: number, caracteres: number}}
 */
function medir(messages = [], tools = []) {
  let caracteres = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') caracteres += m.content.length;
    else if (Array.isArray(m.content))
      for (const p of m.content) caracteres += (typeof p.text === 'string' ? p.text.length : 0) + (p.image_url ? 2000 : 0);
    if (m.tool_calls) caracteres += JSON.stringify(m.tool_calls).length;
    caracteres += 40; // sobrecarga del envoltorio del mensaje
  }
  const herramientas = tools && tools.length ? estimarTokens(tools.map((t) => t.function || t)) : 0;
  const mensajes = Math.ceil(caracteres / CHARS_POR_TOKEN);
  return { mensajes, herramientas, total: mensajes + herramientas, caracteres };
}

/**
 * Presupuesto de una llamada.
 * @param {{messages: Array, tools: Array, cfg: object, reservaSalida?: number}} opts
 * @returns {{total: number, ventana: number, uso: number, estado: 'hola'|'ajustado'|'apretado',
 *            libre: number, herramientas: number, mensajes: number, reserva: number}}
 */
function presupuesto({ messages = [], tools = [], cfg = {}, reservaSalida = 0 } = {}) {
  const ventana = ventanaDe(cfg);
  const reserva = reservaSalida || Number(cfg.maxTokens) || 4096;
  const m = medir(messages, tools);
  const ocupado = m.total + reserva;
  const uso = ocupado / ventana;
  const estado = uso >= 0.85 ? 'apretado' : uso >= 0.6 ? 'ajustado' : 'hola';
  return { ...m, total: m.total, ventana, uso, estado, reserva, libre: Math.max(0, ventana - ocupado) };
}

/**
 * Nota para el prompt de sistema cuando no sobra sitio. En vez de «tienes poco contexto»
 * (que el modelo no puede usar para nada), se le dice qué hacer con eso.
 */
function notaPresupuesto(p) {
  if (!p || (p.estado !== 'apretado' && p.estado !== 'ajustado')) return '';
  const base =
    'PRESUPUESTO DE CONTEXTO: queda poco sitio en esta conversación (' +
    Math.round(p.uso * 100) +
    '% de la ventana ocupada). Trabaja en pasos cortos, lee solo los ' +
    'tramos que necesitas (por rangos de líneas, no el archivo entero), y no repitas en tu ' +
    'respuesta lo que ya está en el contexto';
  return p.estado === 'apretado'
    ? base + ': si necesitas algo que ya se ha leído, búscalo por símbolo en vez de volver a pegarlo.'
    : base + '.';
}

/**
 * Agrupa los mensajes en bloques que se pueden soltar enteros: un mensaje y sus
 * resultados de herramienta. Soltar un `assistant` con `tool_calls` y dejar sus `tool`
 * sueltos haría que el proveedor rechazara la petición entera, así que van juntos.
 */
function enBloques(messages) {
  const bloques = [];
  for (const m of messages) {
    if (m.role === 'system') {
      bloques.push([m]);
      continue;
    }
    if (m.role === 'tool' && bloques.length && bloques[bloques.length - 1].some((x) => x.role !== 'system' && x.role !== 'user')) {
      bloques[bloques.length - 1].push(m);
      continue;
    }
    bloques.push([m]);
  }
  return bloques;
}

/* Marca del mensaje que trae la petición del turno EN CURSO. Es un Symbol y no una
   propiedad normal: no viaja al proveedor ni aparece en el JSON del historial, y el
   mensaje sigue siendo el MISMO objeto que se manda. Sin ella la frontera era «el último
   mensaje de usuario», y la puerta de cierre (que empuja sus instrucciones al final)
   convertía la pregunta del turno en un turno viejo y la soltaba. */
const TURNO = Symbol('turno');
function marcarTurno(msg) {
  if (msg && typeof msg === 'object') Object.defineProperty(msg, TURNO, { value: true, configurable: true });
  return msg;
}
function esTurno(msg) {
  return !!(msg && msg[TURNO]);
}

/**
 * Suelta los bloques MÁS ANTIGUOS del request hasta que quepa.
 *
 * Ojo al matiz, que es lo importante: se recorta lo que SE MANDA, no lo que se guarda.
 * La conversación sigue entera en el historial (y se pliega en el resumen rodante); lo
 * que se deja de pagar es volver a mandar el volcado de un archivo que ya se leyó hace
 * veinte pasos. Se conserva siempre el bloque de sistema y los últimos interesantes.
 *
 * @returns {{messages: Array, quitados: number, tokensLiberados: number}}
 */
function recortarMensajes(messages = [], tools = [], cfg = {}, { objetivo = 0.75, minimo = 6 } = {}) {
  const antes = medir(messages, tools).total;
  const bloques = enBloques(messages);
  const ventana = ventanaDe(cfg);
  const tope = Math.max(8000, ventana * objetivo - (Number(cfg.maxTokens) || 4096) - medir([], tools).total);
  let quitados = 0;
  const i = 1;
  /* Índice VIVO del bloque que trae la petición del usuario del turno EN CURSO. Se
     recalcula en cada vuelta porque al soltar turnos antiguos todos los índices bajan:
     con el índice calculado una sola vez al principio, una conversación de varios turnos
     acababa enviando SOLO el prompt del sistema (el mensaje del usuario se iba con los
     turnos viejos). Manda la marca si la hay; sin marca (historiales viejos) se mantiene
     el último mensaje de usuario, que es lo que hacía antes. */
  const turnoEnCurso = () => {
    const marcado = bloques.reduce((acc, b, idx) => (b.some((m) => esTurno(m)) ? idx : acc), -1);
    if (marcado >= 0) return marcado;
    return bloques.reduce((acc, b, idx) => (b.some((m) => m.role === 'user') ? idx : acc), 0);
  };
  while (medir(bloques.flat(), []).total > tope && bloques.length - i > minimo) {
    const enCurso = turnoEnCurso();
    if (i < enCurso) {
      // quedan turnos antiguos por delante: se suelta el bloque y, tras él, lo que
      // pertenece a ese mismo turno hasta el siguiente mensaje del usuario
      bloques.splice(i, 1);
      quitados++;
      while (bloques[i] && bloques[i][0] && bloques[i][0].role !== 'user' && i < turnoEnCurso()) {
        bloques.splice(i, 1);
        quitados++;
      }
      continue;
    }
    /* Solo queda el turno en curso: se sueltan sus pasos YA CERRADOS (bloques de
       assistant + sus resultados de herramienta) empezando por el más antiguo, SIN tocar
       el mensaje del usuario y sin partir una llamada de sus resultados —los proveedores
       exigen que cada `tool_call` vaya seguido de los suyos, y un bloque es justo eso—. */
    const j2 = bloques.findIndex((b, idx) => idx > enCurso && !b.some((m) => m.role === 'user'));
    if (j2 < 0) break; // ya no hay nada que soltar sin romper el envío
    bloques.splice(j2, 1);
    quitados++;
  }
  if (!quitados) return { messages, quitados: 0, tokensLiberados: 0 };
  return { messages: bloques.flat(), quitados, tokensLiberados: Math.max(0, antes - medir(bloques.flat(), tools).total) };
}

module.exports = { estimarTokens, medir, ventanaDe, presupuesto, notaPresupuesto, recortarMensajes, enBloques, marcarTurno, esTurno, CHARS_POR_TOKEN, VENTANAS };
