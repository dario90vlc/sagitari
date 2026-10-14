'use strict';

/* Pruebas del auditor de contraste (scripts/contraste.js).

   El auditor sólo miraba los tokens «limpios» contra las superficies compuestas: no veía
   los textos con `opacity` (el color efectivo es la mezcla con el fondo) ni los rótulos
   de un pseudo-elemento. Así se coló el rótulo del menú lateral (`.navgroup::before`,
   `opacity: 0.68` sobre el panel translúcido: 3,6:1, por debajo del 4,5:1 de texto
   normal). Aquí se comprueba que el caso está cubierto de verdad —se mide y se detectaría
   si volviera— y que la paleta sigue sin ningún par por debajo del umbral.

   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const auditor = require(path.join(__dirname, '..', '..', 'scripts', 'contraste.js'));

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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

const MIN_NORMAL = 4.5;

console.log('contraste.js — auditoría de la paleta');

const analisis = auditor.analizar();

test('ningún color de texto baja de 4,5:1 en ninguna superficie', () => {
  const malos = analisis.filas.filter((f) => f.ratio < MIN_NORMAL);
  assertEqual(malos.map((f) => `${f.tn} sobre ${f.sn} (${f.ratio.toFixed(2)}:1)`).join(' | '), '', 'pares por debajo:');
  const combinaciones = Object.keys(analisis.superficies).length * Object.keys(analisis.texto).length;
  assertEqual(analisis.filas.length, combinaciones, 'se miden todas las combinaciones:');
  assertOk(analisis.filas.length >= 40, 'la paleta tiene superficies y textos de sobra:');
});

test('ningún texto compuesto (opacidad o pseudo-elemento) baja de 4,5:1', () => {
  const malos = analisis.compuestos.filter((c) => c.ratio < MIN_NORMAL);
  assertEqual(malos.map((c) => `${c.selector} (${c.ratio.toFixed(2)}:1)`).join(' | '), '', 'textos compuestos por debajo:');
});

test('el rótulo del menú lateral está cubierto por el auditor', () => {
  const ng = analisis.compuestos.find((c) => c.selector === '.navgroup::before');
  assertOk(ng, 'el auditor mide .navgroup::before (rótulo de grupo del menú lateral)');
  assertOk(ng.ratio >= MIN_NORMAL, `su contraste es ${ng.ratio.toFixed(2)}:1`);
});

test('el auditor detectaría una opacidad que vuelva a bajar de 4,5:1', () => {
  /* Mismo patrón del defecto: un rótulo de pseudo-elemento con color propio y opacidad.
     El auditor tiene que MEDIRLO (no ignorarlo) y ver que no llega al umbral. */
  const css = '.x::before { content: attr(data-label); color: #9a90c8; opacity: 0.68; }';
  const { medibles, saltados } = auditor.textosCompuestos(css, analisis.superficies);
  assertEqual(saltados.length, 0, 'no se salta la regla:');
  assertEqual(medibles.length, 1, 'la mide:');
  assertOk(medibles[0].ratio < MIN_NORMAL, `la mide por debajo del umbral (${medibles[0].ratio.toFixed(2)}:1)`);
});

test('el auditor mide los textos con opacidad, no sólo los pseudo-elementos', () => {
  const css = '.y { color: #e8e4ff; opacity: 0.85; }';
  const { medibles } = auditor.textosCompuestos(css, analisis.superficies);
  assertEqual(medibles.length, 1, 'mide el texto con opacidad:');
  assertEqual(medibles[0].opacidad, 0.85, 'con su opacidad:');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
