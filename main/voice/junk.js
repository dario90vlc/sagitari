'use strict';

/* ¿Es basura lo que ha oído el motor?
 *
 * Los motores de dictado inventan frases con el ruido y con el silencio: el de Windows
 * convierte el ambiente en texto y Whisper es famoso por escribir «Gracias por ver el
 * vídeo» cuando no hay voz. Nada de eso puede llegar al agente como si fuera una orden,
 * así que aquí se filtra por lista negra y por reglas de forma y energía.
 */

/* Frases normalizadas (minúsculas, sin signos) que nunca son una orden del usuario.
   La fase 2 amplía esta lista con las alucinaciones propias de Whisper. */
const BASURA = [
  'gracias por ver el video',
  'gracias por ver este video',
  'suscribete al canal',
  'suscribete',
  'subtitulos realizados por',
  'subtitulos por',
  'subtitulos creados por',
  'musica',
  'aplausos',
  'risas',
  'hasta la proxima',
  'no te olvides de suscribirte',
];

const normalizar = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const ACRONIMOS_VALIDOS = new Set([
  'css', 'sql', 'gpt', 'pdf', 'jpg', 'png', 'svg', 'xml', 'txt', 'md',
  'cd', 'ls', 'ps', 'npm', 'git', 'api', 'cli', 'json', 'url', 'http',
  'https', 'ui', 'ux', 'app', 'id', 'os', 'ws', 'db', 'ai', 'llm', 'mcp'
]);

const REGLAS = [
  { motivo: 'no hay texto', prueba: (t) => normalizar(t).length === 0 },
  /* Se mira la forma normalizada y no el texto crudo: la bandera `i` de un regex no
     pliega las vocales acentuadas, así que «sí» se colaba como palabra sin vocales.
     También se aceptan números y acrónimos técnicos usuales en desarrollo/IA. */
  {
    motivo: 'sin vocales: no es una palabra',
    prueba: (t) => {
      const n = normalizar(t);
      if (/[aeiou0-9]/.test(n)) return false;
      const palabras = n.split(/\s+/).filter(Boolean);
      return !palabras.some((p) => ACRONIMOS_VALIDOS.has(p));
    }
  },
  /* `ms` = 0 significa «no se sabe», y el motor de Windows NO manda duración: sin el
     `ms > 0`, toda respuesta corta («sí», «no», «ok») se descartaría como basura y el modo
     voz no podría confirmar nada. Lo cazó la revisión de la tarea. */
  { motivo: 'demasiado corto y sin voz suficiente', prueba: (t, ms) => normalizar(t).replace(/ /g, '').length < 4 && ms > 0 && ms < 350 },
  {
    motivo: 'palabra repetida en bucle',
    prueba: (t) => {
      const w = normalizar(t).split(/\s+/).filter(Boolean);
      return w.length >= 4 && new Set(w).size === 1;
    }
  },
  /* El prefijo solo se aplica a entradas de varias palabras: si no, «música a todo
     volumen» o «risas aparte, abre el navegador» caerían por empezar como una alucinación. */
  { motivo: 'está en la lista negra de alucinaciones', prueba: (t) => { const n = normalizar(t); return BASURA.some((b) => n === b || (b.includes(' ') && n.startsWith(b))); } },
];

function esBasura(text, ms = 0) {
  for (const r of REGLAS) {
    if (r.prueba(text, ms)) return { basura: true, motivo: r.motivo };
  }
  return { basura: false, motivo: '' };
}

module.exports = { esBasura, BASURA };
