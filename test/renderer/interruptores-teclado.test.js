'use strict';

/* Pruebas de teclado de los interruptores de la vista Skills (renderer/40-vistas.js).

   Los `.sw` se pintan como <label> y su accesibilidad la pone polishSwitches()
   (30-ajustes.js: role=switch, tabindex=0 y Enter/Espacio), que sólo se ejecutaba al
   cargar y al final de goto(). La propia vista se repinta al activar una skill, al
   actualizarla o al importar, así que los interruptores nuevos quedaban fuera del orden
   de tabulación y sin teclado hasta salir y volver a entrar en la vista.

   Corre sobre el markup real de index.html (ver arnes-renderer.js). Sin spawn. */

const { montar } = require('./arnes-renderer');

const SKILLS = [{ id: 's1', name: 'Revisar PRs', description: 'Cómo revisar un PR', enabled: true, bodyChars: 400 }];

function montarVista() {
  const toggles = [];
  const m = montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      skillsList: async () => SKILLS.map((s) => ({ ...s })),
      skillsToggle: async (id, on) => {
        toggles.push({ id, on });
        return { ok: true };
      },
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
    },
  });
  return { m, toggles };
}

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

/** ¿El elemento es un interruptor alcanzable y operable por teclado? */
function pulido(el) {
  return el.getAttribute('role') === 'switch' && el.getAttribute('tabindex') === '0';
}

async function main() {
  console.log('interruptores de Skills — teclado');

  await test('al entrar en la vista el interruptor es alcanzable por teclado', async () => {
    const { m } = montarVista();
    await m.listo();
    await m.w.goto('skills');
    await m.listo();
    const sw = m.$('#skillsList [data-sw]');
    assertOk(sw, 'la skill se pinta:');
    assertOk(pulido(sw), 'role=switch y tabindex=0');
  });

  await test('tras el repintado de la propia skill el interruptor sigue siendo alcanzable', async () => {
    const { m, toggles } = montarVista();
    await m.listo();
    await m.w.goto('skills');
    await m.listo();
    const antes = m.$('#skillsList [data-sw]');
    antes.click(); // activar/desactivar: la vista se repinta desde su propio handler
    await m.listo();
    assertEqual(toggles.length, 1, 'se pidió alternar la skill:');
    const despues = m.$('#skillsList [data-sw]');
    assertOk(despues !== antes, 'el nodo del interruptor es nuevo:');
    assertOk(pulido(despues), 'el interruptor repintado debe seguir siendo alcanzable');
  });

  await test('el interruptor repintado responde a Enter y a Espacio', async () => {
    const { m, toggles } = montarVista();
    await m.listo();
    await m.w.goto('skills');
    await m.listo();
    m.$('#skillsList [data-sw]').click();
    await m.listo();
    const sw = m.$('#skillsList [data-sw]');
    const tecla = (key) => {
      const ev = new m.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      sw.dispatchEvent(ev);
    };
    tecla('Enter');
    await m.listo();
    assertEqual(toggles.length, 2, 'Enter alterna la skill:');
    tecla(' ');
    await m.listo();
    assertEqual(toggles.length, 3, 'Espacio alterna la skill:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
