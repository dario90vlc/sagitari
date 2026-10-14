'use strict';

/* Pruebas de los textos de la vista Memoria en index.html.

   El pie prometía que la memoria «no sale de este equipo» y que «nada entra sin tu
   aprobación», y las dos cosas eran falsas: los recuerdos y los hábitos que encajan con
   la conversación van dentro del prompt de cada turno al modelo configurado, y la
   herramienta `remember` escribía directo sin pasar por la bandeja. Una promesa de
   privacidad falsa decide lo que el usuario se atreve a contar, así que se vigila aquí.

   Sin spawn: se ejecuta directo con node. */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

/** El trozo de markup de la vista Memoria (sin el resto de la app). */
const VISTA = (() => {
  const i = HTML.indexOf('id="view-memory"');
  const f = HTML.indexOf('id="view-skills"');
  assertOk(i > 0 && f > i, 'la vista Memoria está en index.html');
  return HTML.slice(i, f);
})();

console.log('index.html — promesas de la vista Memoria');

test('no promete que la memoria no salga del equipo', () => {
  assertOk(!/no viaja a ningún servicio/i.test(VISTA), '«no viaja a ningún servicio» es falso: el prompt lleva la memoria');
  assertOk(!/no sale nada de este equipo/i.test(VISTA), '«no sale nada de este equipo» es falso');
  assertOk(!/es solo de este equipo/i.test(VISTA), 'el perfil de hábitos también viaja en el prompt');
});

test('dice que los recuerdos y los hábitos viajan al modelo configurado', () => {
  assertOk(/se\s+envían al modelo que tengas configurado/i.test(VISTA), 'el pie explica el envío al modelo');
  assertOk(/viaja al modelo configurado/i.test(VISTA), 'el bloque de hábitos también');
});

test('la bandeja no promete una aprobación que no existe', () => {
  assertOk(!/nada entra en tu memoria sin que tú lo apruebes/i.test(VISTA), 'la herramienta del agente no pide aprobación');
  assertOk(/espera tu aprobación/i.test(VISTA), 'la bandeja describe lo que hace de verdad');
  assertOk(/guardar sin preguntar/i.test(VISTA), 'y nombra el ajuste que sí guarda sin preguntar');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
