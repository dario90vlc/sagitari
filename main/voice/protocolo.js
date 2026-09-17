'use strict';

/* Protocolo de línea del motor de dictado (`main/voice.ps1`): una línea por suceso,
 * `PREFIJO::cuerpo`, y la frase con su confianza detrás de un separador de unidad.
 *
 * Vive en su propio módulo porque el corte del prefijo se hacía a mano con un `slice()`
 * por caso y el número estaba mal en la mitad de ellos: `FINAL::` y `READY::` se cortaban
 * con 6 en vez de 7 y `MODE::` con 5 en vez de 6. Ese fallo no es ruidoso —no lanza—, así
 * que el «:» del prefijo se colaba dentro de lo dictado, el motor nunca coincidía con el
 * que estaba puesto y el aviso del motor clásico no salía jamás. Aquí el corte es
 * `slice(prefijo.length)`: no hay número que contar a mano.
 */

/* Todos los prefijos del protocolo, en el orden en que se buscan. */
const PREFIJOS = ['PART::', 'FINAL::', 'MODE::', 'HINT::', 'NOTE::', 'READY::', 'ERROR::'];

/* Separador de unidad: no aparece en texto normal, así que sirve de frontera. */
const SEP_CONFIANZA = '\u001f';

/* La frase, sin su confianza. La confianza es del protocolo, no parte de lo dictado: si
   se dejaba, lo dictado acababa con un carácter de control y un número pegados detrás. */
function textoDictado(crudo) {
  const texto = String(crudo == null ? '' : crudo);
  const corte = texto.indexOf(SEP_CONFIANZA);
  return (corte >= 0 ? texto.slice(0, corte) : texto).trim();
}

/* Línea del motor → { prefijo, cuerpo }, o null si no es una línea del protocolo (una
   traza de PowerShell, por ejemplo: no se inventa un canal para ella). */
function partirLinea(linea) {
  const texto = String(linea == null ? '' : linea).trim();
  const prefijo = PREFIJOS.find((p) => texto.startsWith(p));
  if (!prefijo) return null;
  const bruto = texto.slice(prefijo.length);
  return { prefijo, cuerpo: prefijo === 'FINAL::' ? textoDictado(bruto) : bruto.trim() };
}

/* Trocea un texto para sintetizarlo frase a frase (TTS). Primero por saltos de línea —una
   respuesta con lista se lee mucho mejor frase a frase que como un párrafo corrido— y
   luego por final de frase. NO se fusionan frases cortas (una versión anterior lo hacía y
   contradecía el test de la tarea). Los espacios se colapsan DESPUÉS de partir por líneas,
   que si no el colapso se come los saltos.
   Y un punto NO cierra frase cuando va seguido de dígitos: es un decimal («versión 3.5»,
   «10.000 resultados»), no un final. Antes se partía en «versión tres» + «cinco». La coma
   decimal castellana no tiene este problema, pero el código y las cifras anglosajonas sí.
   El punto decimal entra como carácter normal vía la alternativa `\.(?=\d)`: el resto
   de signos y los dígitos siempre son texto normal, así que «tarea 3» no pierde el 3. */
function trocear(texto) {
  const limpio = String(texto || '').replace(/```[\s\S]*?```/g, ' (código) ').trim();
  if (!limpio) return [];
  const out = [];
  for (const linea of limpio.split(/\r?\n/)) {
    const l = linea.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    for (const f of l.match(/(?:[^.!?…]|\.(?=\d))+[.!?…]*/g) || [l]) {
      const t = f.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

module.exports = { PREFIJOS, SEP_CONFIANZA, textoDictado, partirLinea, trocear };
