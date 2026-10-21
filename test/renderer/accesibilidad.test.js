'use strict';

/* Accesibilidad del markup real, con axe-core sobre renderer/index.html.

   Por qué existe: los arreglos de accesibilidad de la 5.2.0 (los tamaños por debajo de
   11 px, el `text-transform` en vez de `.toUpperCase()` en JS) se hicieron a mano y nada
   impedía que volvieran.

   Qué encontró la primera pasada, y qué es de verdad: axe marca doce `<div class="sw"
   aria-label>` sin rol y `#mcpGlobal` con `role="switch"` pero sin `aria-checked`. En la
   app EN MARCHA eso no se ve mal, porque `polishSwitches()` (30-ajustes.js) añade rol,
   estado y teclado al cargar — pero el MARKUP del que sale todo eso no lo traía, y ese es
   el que se audita sin ejecutar nada: cualquier día en que el script no llegue (fallo de
   carga, orden, un redibujado antes de pulir) el control se queda sin anunciar. Los
   atributos se han movido al HTML y aquí se comprueba que siguen ahí.

   Lo que NO se comprueba aquí: el contraste. axe lo necesita con layout y aquí no hay CSS
   aplicado (jsdom no carga hojas), así que lo mide su propio test — contrastes calculados
   a mano desde los tokens — en contraste.test.js.

   Sin spawn: se ejecuta directo con node. */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const axe = require('axe-core');

const RAIZ = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'renderer', 'index.html'), 'utf8');
const AJUSTES_JS = fs.readFileSync(path.join(RAIZ, 'renderer', '30-ajustes.js'), 'utf8');

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

console.log('accesibilidad — axe-core sobre el markup de index.html');

async function main() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: vc });
  const doc = dom.window.document;

  /* axe-core en Node deduce el documento de los globales `window`/`document` (lo dice su
     propio error). Se apuntan a ESTA ventana y se devuelven como estaban al terminar:
     este fichero se carga en el mismo proceso que el resto de la suite y dejar un
     `window` global mentiroso cambiaría el comportamiento de los módulos siguientes. */
  const previo = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = doc;

  let informe;
  try {
    informe = await axe.run(doc.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: {
        // Necesitan layout y aquí no hay CSS: los cubre contraste.test.js token a token.
        'color-contrast': { enabled: false },
        'color-contrast-enhanced': { enabled: false },
      },
    });
  } finally {
    if (previo.window === undefined) delete global.window;
    else global.window = previo.window;
    if (previo.document === undefined) delete global.document;
    else global.document = previo.document;
  }

  test('el markup no tiene ninguna violación WCAG A/AA', () => {
    const lista = informe.violations.map((v) => `${v.id} ×${v.nodes.length} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
    assertEqual(lista.join(' | '), '', 'violaciones:');
    assertOk(informe.passes.length >= 15, `axe evaluó de verdad (${informe.passes.length} reglas en verde)`);
  });

  test('ningún interruptor se queda sin rol ni sin estado', () => {
    const sw = [...doc.querySelectorAll('.sw')];
    assertOk(sw.length >= 13, `hay interruptores que revisar (${sw.length})`);
    const sinRol = sw.filter((el) => el.getAttribute('role') !== 'switch').map((el) => '#' + el.id);
    assertEqual(sinRol.join(', '), '', 'sin role="switch":');
    const sinEstado = sw.filter((el) => !['true', 'false'].includes(el.getAttribute('aria-checked'))).map((el) => '#' + el.id);
    assertEqual(sinEstado.join(', '), '', 'sin aria-checked:');
  });

  test('el estado visual y el anunciado no se pueden separar', () => {
    // La clase `on` es lo que se ve; aria-checked es lo que se oye, y quien los copia es
    // polishSwitches(). Si alguien lo borra, la casilla anuncia el estado anterior: peor
    // que no anunciar nada.
    const fn = (AJUSTES_JS.match(/function polishSwitches\(\)[\s\S]*?\n\}/) || [''])[0];
    assertOk(fn, 'existe polishSwitches() en 30-ajustes.js');
    assertOk(/aria-checked/.test(fn), 'copia la clase `on` en aria-checked');
    assertOk(/MutationObserver/.test(fn), 'y la mantiene al día cuando el estado cambia');
    assertOk(/e\.key === 'Enter' \|\| e\.key === ' '/.test(fn), 'Enter y Espacio cuentan como clic');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

module.exports = main();
