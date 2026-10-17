'use strict';

/* Pruebas del enrutado de eventos por conversación (renderer/20-app.js).

   El manejador de `onAgentEvent` es ÚNICO y cada evento del turno viaja con su `convId`.
   Antes escribía siempre en la vista activa, así que la respuesta de una conversación que
   seguía trabajando aparecía en la burbuja de la que estabas mirando (y su `busy`/cierre
   marcaban a la otra). Aquí se comprueba lo que tiene que pasar: un evento de otra pestaña
   NO toca la vista activa y SÍ deja al día a su dueña; el de la conversación a la vista se
   pinta como siempre; y un evento sin conversación (avisos) sigue por el camino de siempre.

   Sin spawn: monta el markup real y los guiones como <script> (ver arnes-renderer.js). */

const { montar } = require('./arnes-renderer');

/* El puente falso descarta los `on*` (devuelve un baja-nada), así que aquí se captura el
   manejador real que registra 20-app.js para poder disparar los mismos eventos que main. */
let handler = null;
function montarChat() {
  handler = null;
  return montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      onAgentEvent: (cb) => {
        handler = cb;
        return () => {};
      },
    },
  });
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

async function main() {
  console.log('eventos del turno — enrutado por conversación');

  await test('un evento de otra conversación no se pinta en la vista activa', async () => {
    const m = montarChat();
    await m.listo();
    assertOk(handler, 'el manejador de eventos quedó registrado:');
    m.w.recordarHilo('c1');
    m.w.recordarHilo('c2');
    await m.listo();
    assertEqual(m.w.hiloActual(), 'c2', 'la conversación a la vista es c2:');

    const erroresAntes = m.w.__errores.length;
    handler({ type: 'delta', convId: 'c1', text: 'RESPUESTA-DE-LA-OTRA-PESTANA' });
    await m.listo();
    assertOk(!/RESPUESTA-DE-LA-OTRA-PESTANA/.test(m.$('#messages').textContent), 'la respuesta de c1 no entra en el hilo de c2:');
    assertEqual(m.w.__errores.length, erroresAntes, 'y no añade errores de interfaz:');
  });

  await test('su pestaña SÍ se queda al día (ocupada) aunque no se pinte el texto', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    m.w.recordarHilo('c2');
    await m.listo();

    handler({ type: 'busy', convId: 'c1', busy: true, mode: 'act' });
    await m.listo();
    const tab1 = m.$('#convTabs .ctab[data-conv="c1"]');
    const tab2 = m.$('#convTabs .ctab[data-conv="c2"]');
    assertOk(tab1, 'la pestaña de c1 existe:');
    assertOk(tab1.classList.contains('busy'), 'la pestaña de c1 se marca ocupada:');
    assertOk(!tab2.classList.contains('busy'), 'y la de c2, que no tiene turno, no:');
    assertOk(!m.w.busy, 'la conversación a la vista no se queda «trabajando»:');

    // y su cierre también llega a la dueña, no a la vista
    handler({ type: 'assistant_done', convId: 'c1', text: 'fin' });
    await m.listo();
    assertOk(!m.$('#convTabs .ctab[data-conv="c1"]').classList.contains('busy'), 'el cierre del turno de c1 suelta SU pestaña:');
  });

  await test('el evento de la conversación a la vista se pinta como siempre', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    m.w.recordarHilo('c2');
    await m.listo();

    handler({ type: 'delta', convId: 'c2', text: 'RESPUESTA-DE-C2' });
    await m.listo();
    assertOk(/RESPUESTA-DE-C2/.test(m.$('#messages').textContent), 'la respuesta de c2 sí se pinta en su hilo:');
  });

  await test('una confirmación de otra conversación SÍ se muestra (su turno la espera)', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    m.w.recordarHilo('c2');
    await m.listo();

    /* La confirmación no es de la pestaña a la vista: es de QUIEN la pide, y su turno se
       queda esperando. Si el enrutado por conversación se la comiera, la herramienta
       acabaría muriendo por timeout sin que nadie pudiera darle permiso. */
    handler({
      type: 'confirm_request',
      convId: 'c1',
      id: 'k1',
      tool: 'run_command',
      description: 'ejecutar «npm test»',
      summary: 'npm test',
    });
    await m.listo();
    const bar = m.$('#confirmBar');
    assertOk(bar && !bar.hidden, 'la barra de confirmación sale:');
    assertOk(/ejecutar/.test(m.$('#confirmTitle').textContent), 'y dice qué pide: ' + m.$('#confirmTitle').textContent);
  });

  await test('un tope de seguridad en otra pestaña avisa y suelta SU pestaña', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    m.w.recordarHilo('c2');
    await m.listo();

    handler({ type: 'busy', convId: 'c1', busy: true, mode: 'act' });
    await m.listo();
    handler({ type: 'guardrail', convId: 'c1', reason: 'tope de pasos del turno' });
    await m.listo();
    assertOk(/tope de pasos/.test(m.$('#toastStack').textContent), 'el aviso de seguridad llega:');
    assertOk(!m.$('#convTabs .ctab[data-conv="c1"]').classList.contains('busy'), 'y su pestaña deja de estar ocupada:');
  });

  await test('un evento sin conversación sigue por el camino general', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c2');
    await m.listo();

    // sin `convId` no hay a quién atribuirlo: se atiende como antes (avisos del sistema)
    const erroresAntes = m.w.__errores.length;
    handler({ type: 'status', text: 'AVISO-SIN-CONV' });
    await m.listo();
    assertOk(/AVISO-SIN-CONV/.test(m.$('#activityFeed').textContent), 'el aviso llega al feed:');
    assertEqual(m.w.__errores.length, erroresAntes, 'sin errores de interfaz:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
