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

const REGLAS = [
  { motivo: 'no hay texto', prueba: (t) => normalizar(t).length === 0 },
  /* Se mira la forma normalizada y no el texto crudo: la bandera `i` de un regex no
     pliega las vocales acentuadas, así que «sí» se colaba como palabra sin vocales. */
  { motivo: 'sin vocales: no es una palabra', prueba: (t) => !/[aeiou]/.test(normalizar(t)) },
  { motivo: 'demasiado corto y sin voz suficiente', prueba: (t, ms) => normalizar(t).replace(/ /g, '').length < 4 && ms < 350 },
  { motivo: 'palabra repetida en bucle', prueba: (t) => { const w = normalizar(t).split(' '); return w.length >= 4 && new Set(w).size === 1; } },
  { motivo: 'está en la lista negra de alucinaciones', prueba: (t) => { const n = normalizar(t); return BASURA.some((b) => n === b || n.startsWith(b)); } },
];

function esBasura(text, ms = 0) {
  for (const r of REGLAS) {
    if (r.prueba(text, ms)) return { basura: true, motivo: r.motivo };
  }
  return { basura: false, motivo: '' };
}

module.exports = { esBasura, BASURA };
