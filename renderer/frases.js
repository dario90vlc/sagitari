'use strict';

/* Troceado de la respuesta PARA LEERLA EN VOZ ALTA mientras se está escribiendo.
 *
 * Por qué un fichero propio: partir el texto por frases parece trivial hasta que se parte
 * por donde no toca. Ya pasó una vez en el proceso principal (`main/voice/protocolo.js`):
 * el punto de un decimal acabó siendo un final de frase y «versión 3.5» se leía «versión
 * tres» y «cinco». Aquí vive la misma regla, y separado del resto de app.js porque es la
 * única pieza de la lectura en flujo que se puede probar sin navegador (`test/run.js` la
 * carga con `require`, igual que el resto de la lógica pura).
 *
 * Se carga ANTES que app.js (como icons.js o orb.js) y deja su API en `window.SagiFrases`.
 */
(function (raiz) {
  /* Cuántos caracteres de `cola` forman ya la siguiente frase COMPLETA. 0 = todavía no hay
     ninguna (falta texto), y entonces quien lee espera al siguiente trozo del stream.
     El salto de línea también cierra: una lista se lee línea a línea, no como un párrafo
     corrido. Con `fin` (la respuesta ha terminado) se consume también la cola sin punto:
     una frase suelta al final se lee, no se pierde. */
  function corteDeFrase(cola, fin) {
    const texto = String(cola == null ? '' : cola);
    let i = 0;
    while (i < texto.length) {
      /* Bloque de código: no se lee. Mientras el cierre no haya llegado no se consume nada
         (el bloque podría terminar en el trozo siguiente); al final, lo que quede de bloque
         abierto se descarta sin leerlo, que es justo lo que se quiere de un bloque abierto. */
      if (texto.startsWith('```', i)) {
        const cierre = texto.indexOf('```', i + 3);
        if (cierre < 0) return i;
        i = cierre + 3;
        continue;
      }
      const resto = texto.slice(i);
      /* `[.!?…]+` seguido de espacio o final de texto. El punto de un decimal no cierra:
         detrás viene un dígito, no un espacio, así que la búsqueda sigue — es la misma
         regla del troceado del proceso principal, escrita dos veces a propósito (el
         renderer no puede `require` ese módulo) y probada en los dos sitios. */
      const finFrase = resto.match(/^[\s\S]*?[.!?…]+(?=\s|$)/);
      const salto = resto.indexOf('\n');
      if (finFrase && (salto < 0 || finFrase[0].length <= salto)) return i + finFrase[0].length;
      if (salto >= 0) return i + salto + 1;
      return fin ? texto.length : 0;
    }
    return 0;
  }

  /* Lo que se manda a la voz: sin markdown y sin código. Una línea de signos (una tabla,
     un separador) no se lee: no aporta nada y gasta una síntesis. El bloque de código se
     sustituye por la palabra que ya usaba la lectura del chat: quien escucha se entera de
     que ahí hay código (leerlo entero en voz alta no le sirve) sin que la respuesta se
     quede muda si consistía sólo en código. */
  function limpiarParaVoz(trozo) {
    return String(trozo == null ? '' : trozo)
      .replace(/```[\s\S]*?```/g, ' código ')
      /* Las comillas del código en línea se quitan pero su CONTENIDO se lee: un
         `npm install` o un nombre de fichero dicho en voz alta sí sirve de algo. */
      .replace(/[*_`#>|«»]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ¿Queda algo que decir en este texto? (Marcadores y espacios no cuentan.) */
  function diceAlgo(texto) {
    return /[\p{L}\p{N}]/u.test(String(texto || ''));
  }

  const api = { corteDeFrase, limpiarParaVoz, diceAlgo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz) raiz.SagiFrases = api;
})(typeof window !== 'undefined' ? window : null);
