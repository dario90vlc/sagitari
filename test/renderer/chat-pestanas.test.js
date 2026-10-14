'use strict';

/* Pruebas de las pestañas de conversación (renderer/10-chat.js).

   Cerrar una pestaña suelta su nodo y su runtime, pero cada runtime crea un
   ResizeObserver sobre su nodo de mensajes: un observador mantiene una referencia
   FUERTE a su target hasta que se desconecta, así que cada ciclo abrir/cerrar dejaba
   un observador y el árbol de mensajes entero retenidos para siempre. El invariante que
   se comprueba aquí es el que hace falta: ningún observador puede seguir apuntando a un
   nodo que ya no está en el documento.

   Se usa un ResizeObserver falso que registra quién observa qué (jsdom no lo trae).
   Corre sobre el markup real de index.html (ver arnes-renderer.js). Sin spawn. */

const { montar } = require('./arnes-renderer');

function montarChat() {
  const m = montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
    },
  });
  return m;
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

/** Observadores que siguen enganchados a un nodo que ya no está en el documento. */
const observadoresHuerfanos = (m) => m.observadores.filter((o) => o.targets.some((t) => !t.isConnected));

async function main() {
  console.log('pestañas de conversación — observadores');

  await test('al cerrar una pestaña se desconecta el observador de su nodo', async () => {
    const m = montarChat();
    await m.listo();
    m.w.abrirRuntime('c1');
    m.w.abrirRuntime('c2');
    await m.listo();
    const tabs = m.$$('#convTabs .ctab');
    assertEqual(tabs.length, 2, 'dos conversaciones abiertas:');
    const x = m.$('#convTabs .ctab[data-conv="c1"] .ctab-x');
    assertOk(x, 'la pestaña de c1 tiene su botón de cerrar:');
    m.clic(x);
    await m.listo();
    assertEqual(m.$$('#convTabs .ctab').length, 1, 'la pestaña se cierra:');
    const huerfanos = observadoresHuerfanos(m);
    assertEqual(huerfanos.length, 0, `ningún observador puede seguir sobre un nodo suelto (${huerfanos.length} huérfano/s)`);
  });

  await test('abrir y cerrar conversaciones en bucle no acumula observadores vivos', async () => {
    const m = montarChat();
    await m.listo();
    for (let i = 0; i < 5; i++) {
      m.w.abrirRuntime('ciclo' + i);
      await m.listo(1);
      const x = m.$(`#convTabs .ctab[data-conv="ciclo${i}"] .ctab-x`);
      if (x) {
        m.clic(x);
        await m.listo(1);
      }
    }
    assertEqual(observadoresHuerfanos(m).length, 0, 'sin observadores colgando de nodos cerrados');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
