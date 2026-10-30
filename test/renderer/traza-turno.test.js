'use strict';

/* El turno como TRAZA: razonamiento, tramos de respuesta y herramientas, en el orden en que
   ocurrieron, tanto en vivo como al reabrir la conversación.

   Antes todo caía dentro de UNA burbuja —los tramos de texto, las herramientas y el
   razonamiento— y un turno de veinte pasos se leía como un muro de prosa sin origen. La
   queja del usuario fue literal: «al responder aglutina toda la información». Lo que se
   comprueba aquí es el contrato nuevo: cada pieza es un bloque propio, en orden, y las
   herramientas se quedan a la vista al terminar (antes se plegaban solas).

   Sin spawn: monta el markup real y los guiones como <script> (ver arnes-renderer.js). */

const { montar } = require('./arnes-renderer');

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
      convNew: async () => ({ ok: true, id: 'c2' }),
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

/** Los hijos del turno, por su clase de bloque. `seg` va con `stream`/`stream-done`: el
    bloque es el mismo y lo que cambia es si sigue escribiendo. */
function bloques(m) {
  const turno = m.$('#messages .msg.ai .bubble.blocks');
  assertOk(turno, 'el turno es una columna de bloques (.bubble.blocks)');
  return [...turno.children].map((el) => {
    if (el.classList.contains('seg')) return 'seg';
    if (el.classList.contains('tgroup')) return 'tgroup';
    if (el.classList.contains('thinkblock')) return 'thinkblock';
    return el.className.split(/\s+/)[0];
  });
}

async function main() {
  console.log('turno como traza — bloques en orden');

  await test('en vivo: razonamiento, respuesta, herramientas y respuesta, en ese orden', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    await m.listo();
    assertOk(handler, 'el manejador de eventos quedó registrado');
    /* El arnés monta Ajustes con un catálogo vacío y `fillSettings` deja un aviso al
       montar (no tiene que ver con el turno). Se mide la diferencia: lo que importa es que
       el turno no añada ninguno. */
    const erroresAntes = m.w.__errores.length;

    handler({ type: 'busy', convId: 'c1', busy: true, mode: 'act' });
    handler({ type: 'delta', convId: 'c1', text: 'Empiezo por el inventario.' });
    await m.listo();
    handler({ type: 'thinking_delta', convId: 'c1', text: 'Miro el disco.' });
    await m.listo();
    handler({ type: 'thinking_done', convId: 'c1', text: 'Miro el disco.', durationMs: 900 });
    handler({ type: 'tool', convId: 'c1', name: 'run_command', args: { command: 'df -h' } });
    handler({ type: 'tool_result', convId: 'c1', name: 'run_command', ok: true, durationMs: 120, result: '/ 40G' });
    handler({ type: 'delta', convId: 'c1', text: 'El disco está lleno.' });
    await m.listo();
    handler({ type: 'assistant_done', convId: 'c1', text: 'Empiezo por el inventario.\n\nEl disco está lleno.' });
    await m.listo();

    assertEqual(bloques(m).join(','), 'seg,thinkblock,tgroup,seg', 'cada pieza es su bloque, en orden');

    const turno = m.$('#messages .msg.ai .bubble.blocks');
    const segs = [...turno.querySelectorAll(':scope > .seg')];
    assertEqual(segs.length, 2, 'dos tramos de respuesta');
    assertOk(/Empiezo por el inventario/.test(segs[0].textContent), 'el primero dice lo que dijo antes de trabajar');
    assertOk(/El disco está lleno/.test(segs[1].textContent), 'y el segundo continúa después de la herramienta');

    // la herramienta quedó EN MEDIO, no al final del turno
    const hijos = [...turno.children];
    const iSeg0 = hijos.indexOf(segs[0]);
    const iGrupo = hijos.findIndex((el) => el.classList.contains('tgroup'));
    const iSeg1 = hijos.indexOf(segs[1]);
    assertOk(iSeg0 < iGrupo && iGrupo < iSeg1, 'la tanda de herramientas va donde ocurrió');

    // y sigue a la vista al cerrar el turno (antes se plegaba sola)
    const grupo = turno.querySelector('.tgroup');
    assertOk(grupo.classList.contains('open'), 'el grupo se queda abierto al terminar');
    assertOk(!grupo.classList.contains('closed'), 'y no se pliega solo');
    const card = grupo.querySelector('.tcard');
    assertOk(card, 'con la tarjeta de la herramienta dentro');
    assertOk(card.classList.contains('done'), 'cerrada con su resultado');
    assertOk(/df -h/.test(card.textContent), 'y sus argumentos a la vista: ' + card.textContent);
    assertOk(/\/ 40G/.test(card.textContent), 'y el resultado guardado en la tarjeta');
    assertEqual(
      m.w.__errores.length,
      erroresAntes,
      'el turno no añade errores de interfaz: ' + JSON.stringify(m.w.__errores.slice(erroresAntes)),
    );
  });

  await test('una segunda tanda de herramientas abre su grupo debajo del texto nuevo', async () => {
    const m = montarChat();
    await m.listo();
    m.w.recordarHilo('c1');
    await m.listo();

    handler({ type: 'tool', convId: 'c1', name: 'run_command', args: { command: 'uno' } });
    handler({ type: 'tool_result', convId: 'c1', name: 'run_command', ok: true, durationMs: 10, result: 'ok' });
    handler({ type: 'delta', convId: 'c1', text: 'Ahora miro otra cosa.' });
    await m.listo();
    handler({ type: 'tool', convId: 'c1', name: 'read_file', args: { path: 'a.txt' } });
    handler({ type: 'tool_result', convId: 'c1', name: 'read_file', ok: true, durationMs: 10, result: 'hola' });
    await m.listo();
    handler({ type: 'assistant_done', convId: 'c1', text: 'Ahora miro otra cosa.' });
    await m.listo();

    assertEqual(
      bloques(m).join(','),
      'tgroup,seg,tgroup',
      'dos tandas separadas por la narración que las une, no un solo grupo al final',
    );
  });

  await test('al reabrir: las PARTES guardadas se repintan en el mismo orden', async () => {
    const m = montarChat();
    await m.listo();
    const ts = Date.now();
    m.w.resetChatView([
      { role: 'user', content: 'analiza mi PC', ts },
      {
        role: 'assistant',
        content: 'Empiezo por el inventario.\n\nEl disco está lleno.',
        ts,
        trace: {
          tools: [{ name: 'run_command', args: { command: 'df -h' }, ok: true, ms: 120, result: '/ 40G' }],
          think: { text: 'Miro el disco.', ms: 900 },
          todos: null,
          parts: [
            { k: 'think', text: 'Miro el disco.', ms: 900, fin: true },
            { k: 'text', text: 'Empiezo por el inventario.' },
            { k: 'tool', name: 'run_command', args: { command: 'df -h' }, ok: true, ms: 120, result: '/ 40G' },
            { k: 'text', text: 'El disco está lleno.' },
          ],
        },
      },
    ]);
    await m.listo();

    assertEqual(bloques(m).join(','), 'thinkblock,seg,tgroup,seg', 'la traza guardada se lee igual que en vivo');
    const turno = m.$('#messages .msg.ai .bubble.blocks');
    assertOk(!/Miro el disco/.test(turno.querySelector('.seg').textContent), 'el razonamiento no se mezcla con la respuesta');
    const razon = turno.querySelector('.thinkblock');
    assertOk(razon.classList.contains('closed'), 'el razonamiento queda plegado, con su resumen');
    const grupo = turno.querySelector('.tgroup');
    assertOk(grupo.classList.contains('open'), 'y las herramientas quedan a la vista');
    assertOk(/df -h/.test(grupo.textContent) && /\/ 40G/.test(grupo.textContent), 'con sus argumentos y su resultado');
  });

  await test('un mensaje guardado SIN partes sigue repintándose (compatibilidad)', async () => {
    const m = montarChat();
    await m.listo();
    const ts = Date.now();
    m.w.resetChatView([
      { role: 'user', content: 'hola', ts },
      {
        role: 'assistant',
        content: 'Respuesta vieja.',
        ts,
        trace: {
          tools: [{ name: 'read_file', args: { path: 'a.txt' }, ok: false, ms: 40, result: 'Error: no existe' }],
          think: { text: 'Pienso.', ms: 300 },
          todos: null,
        },
      },
    ]);
    await m.listo();

    assertEqual(bloques(m).join(','), 'thinkblock,tgroup,seg', 'razonamiento, herramientas y respuesta');
    const turno = m.$('#messages .msg.ai .bubble.blocks');
    assertOk(/Respuesta vieja/.test(turno.textContent), 'y el texto guardado no se pierde');
    assertOk(turno.querySelector('.tcard').classList.contains('err'), 'el fallo se sigue viendo como fallo');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
