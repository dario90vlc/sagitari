'use strict';

/* Los tres ASPECTOS: Holo (la identidad de la casa) y los dos planos, Consola y Lienzo.
   Comparten la misma base; lo que cambia es la materia (fondos, radios, desenfoque, luz).

   Lo que se comprueba aquí es el cableado, no el color: que elegir un aspecto ponga el
   atributo en <html>, que en los planos se SUELTE la rampa de color del tema (Consola es
   negro neutro, no violeta tintado), que la luz y el vidrio se apaguen y desaparezcan de
   Ajustes, y que las dos hojas nuevas existan de verdad.

   Sin spawn: monta el markup real y los guiones como <script> (ver arnes-renderer.js). */

const fs = require('fs');
const path = require('path');
const { montar } = require('./arnes-renderer');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

function montarApp(skin = 'holo') {
  return montar({
    api: {
      getConfig: async () => ({
        providers: [],
        active: null,
        presets: [],
        settings: { uiSkin: skin, uiColor: 'aurora', glowStrength: 0.7, glassTint: 1 },
      }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      onAgentEvent: () => () => {},
    },
  });
}

/** Aplica un aspecto por el mismo camino que el usuario (ajuste + applyTheme). */
function elegirAspecto(m, skin) {
  m.w.eval(`CFG.settings.uiSkin = ${JSON.stringify(skin)}; applyTheme();`);
}

async function main() {
  console.log('aspectos de la interfaz — Holo, Consola y Lienzo');

  await test('Holo no deja atributo; Consola y Lienzo lo ponen en <html>', async () => {
    const m = montarApp();
    await m.listo();
    const html = m.w.document.documentElement;
    assertOk(!html.hasAttribute('data-skin'), 'la app arranca en Holo, sin capa encima');

    // el aspecto guardado se aplica AL ARRANCAR, no al tocarlo: reabrir con Consola guardado
    const otra = montarApp('console');
    await otra.listo();
    assertEqual(otra.w.document.documentElement.getAttribute('data-skin'), 'console', 'el aspecto guardado vuelve al abrir la app');

    elegirAspecto(m, 'console');
    assertEqual(html.getAttribute('data-skin'), 'console', 'Consola se aplica al momento');

    elegirAspecto(m, 'canvas');
    assertEqual(html.getAttribute('data-skin'), 'canvas', 'y Lienzo también');

    elegirAspecto(m, 'holo');
    assertOk(!html.hasAttribute('data-skin'), 'volver a Holo quita la capa: la identidad de la casa es la hoja base');
  });

  await test('en los planos se suelta la rampa del tema y se apaga la luz', async () => {
    const m = montarApp();
    await m.listo();
    const st = m.w.document.documentElement.style;
    elegirAspecto(m, 'holo');
    assertOk(st.getPropertyValue('--bg0-rgb').trim(), 'Holo deriva los fondos de la paleta');
    assertEqual(st.getPropertyValue('--glow-str').trim(), '0.7', 'y respeta la intensidad elegida');

    elegirAspecto(m, 'console');
    assertEqual(st.getPropertyValue('--bg0-rgb').trim(), '', 'Consola NO deja el fondo del tema: los suyos son neutros');
    assertEqual(st.getPropertyValue('--glow-str').trim(), '0', 'y el filo del marco se apaga (una superficie plana no brilla)');

    elegirAspecto(m, 'canvas');
    assertEqual(st.getPropertyValue('--bg0-rgb').trim(), '', 'Lienzo tampoco hereda los fondos tintados');
    assertEqual(st.getPropertyValue('--glow-str').trim(), '0');

    elegirAspecto(m, 'holo');
    assertOk(st.getPropertyValue('--bg0-rgb').trim(), 'al volver, la rampa del tema regresa');
    assertEqual(st.getPropertyValue('--glow-str').trim(), '0.7', 'con su intensidad guardada, no con la del plano');
  });

  await test('las filas de luz y vidrio no se ofrecen en un aspecto plano', async () => {
    const m = montarApp();
    await m.listo();
    const filas = m.w.document.querySelectorAll('[data-solo-holo]');
    assertEqual(filas.length, 4, 'son cuatro: glow, color del glow, intensidad y vidrio');

    elegirAspecto(m, 'console');
    assertOk([...filas].every((f) => f.hidden), 'en Consola no hay nada que iluminar ni que teñir');

    elegirAspecto(m, 'holo');
    assertOk([...filas].every((f) => !f.hidden), 'y en Holo vuelven');
  });

  await test('Ajustes refleja el aspecto guardado y tiene su selector', async () => {
    const m = montarApp();
    await m.listo();
    assertOk(m.$('#uiSkin'), 'existe el selector de aspecto');
    assertEqual(m.$('#uiSkin').value, 'holo', 'y arranca en el guardado');
    assertEqual(m.$$('#uiSkinTiles .pal').length, 3, 'con sus tres opciones');

    m.$('#uiSkin').value = 'canvas';
    m.$('#uiSkin').dispatchEvent(new m.w.Event('change', { bubbles: true }));
    await m.listo();
    assertEqual(m.w.document.documentElement.getAttribute('data-skin'), 'canvas', 'elegir en Ajustes aplica el aspecto');
    assertOk(
      m.llamadas.some((l) => l.canal === 'setSettings' && l.args[0] && l.args[0].uiSkin === 'canvas'),
      'y lo guarda: ' + JSON.stringify(m.llamadas.filter((l) => l.canal === 'setSettings').slice(-2)),
    );
    assertOk(m.$('#uiSkinTiles .pal.on').dataset.pal === 'canvas', 'la opción elegida queda marcada');
  });

  await test('buscar lo que solo vive en Holo no resucita esas filas en un aspecto plano', async () => {
    const m = montarApp('console');
    await m.listo();
    const busca = m.$('#setSearch');
    assertOk(busca, 'existe el buscador de ajustes');
    // «tintado» solo aparece en la fila del VIDRIO: la búsqueda no puede devolverla
    busca.value = 'tintado';
    busca.dispatchEvent(new m.w.Event('input', { bubbles: true }));
    await m.listo();
    assertOk([...m.$$('[data-solo-holo]')].every((f) => f.hidden), 'la fila del vidrio sigue oculta tras buscar');
    assertOk(m.$('#setNoResults') && !m.$('#setNoResults').hidden, 'y Ajustes dice que no hay coincidencias, en vez de mostrar una fila fantasma');
  });

  await test('la hoja de los aspectos define los dos planos y apaga el desenfoque', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'skins.css'), 'utf8');
    assertOk(/html\[data-skin='console'\]/.test(css), 'Consola tiene su bloque de tokens');
    assertOk(/html\[data-skin='canvas'\]/.test(css), 'y Lienzo el suyo');
    assertOk(/--blur:\s*0px/.test(css), 'los dos apagan el desenfoque de una vez');
    assertOk(/\.filo/.test(css) && /display:\s*none/.test(css), 'y retiran el filo vivo, que en un plano no existe');
    // la LETRA también es materia, no un detalle aparte
    assertOk(/--font-display:\s*'Cascadia Mono'/.test(css), 'Consola lleva los títulos a monoespaciada');
    assertOk(/--font-ui:\s*'Cascadia Mono'/.test(css), 'y la interfaz entera: es lo que la hace sonar a terminal');
    assertOk(/--font-display:\s*'Space Grotesk'/.test(css), 'Lienzo titula con la geométrica de la interfaz, no con Sora');
    assertOk(!/html\[data-skin='canvas'\][\s\S]{0,400}--font-ui/.test(css), 'Lienzo no cambia la familia de la interfaz: una sola voz');
  });

  await test('index.html carga la hoja y no la mete en el HTML de nadie', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'index.html'), 'utf8');
    assertOk(/href="skins\.css"/.test(html), 'skins.css va enlazada');
    assertOk(html.indexOf('skins.css') > html.indexOf('styles.css'), 'y después de la hoja base: es una capa encima');
    assertOk(/id="uiSkin"/.test(html) && /id="uiSkinTiles"/.test(html), 'con su selector en Ajustes ▸ Apariencia');
    assertEqual((html.match(/data-solo-holo/g) || []).length, 4, 'y las cuatro filas que solo tienen sentido en Holo');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
