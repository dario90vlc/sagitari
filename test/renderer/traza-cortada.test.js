'use strict';

/* Un turno más largo de lo que cabe en las PARTES guardadas (MAX_TEXTO_PARTE) no puede
   repintarse a medias al reabrir la conversación: si el rastro viene marcado `cortado`,
   manda el `content` COMPLETO del mensaje (la rama de siempre), no los tramos recortados.
   Sin esto, una respuesta de más de 6.000 caracteres se veía incompleta y «Copiar» copiaba
   el corte.

   Sin spawn: monta el markup real y los guiones como <script> (ver arnes-renderer.js). */

const { montar } = require('./arnes-renderer');

function montarChat() {
  return montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      onAgentEvent: () => () => {},
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

const FINAL = 'FINAL-DEL-TURNO-QUE-NO-CABE';

async function main() {
  console.log('traza cortada — al reabrir manda el texto completo');

  await test('con `cortado` el texto entero aparece una sola vez y las herramientas siguen visibles', async () => {
    const m = montarChat();
    await m.listo();
    const ts = Date.now();
    const completo = 'x'.repeat(6100) + FINAL;
    m.w.resetChatView([
      { role: 'user', content: 'resume esto', ts },
      {
        role: 'assistant',
        content: completo,
        ts,
        trace: {
          cortado: true,
          tools: [{ name: 'read_file', args: { path: 'a.txt' }, ok: true, ms: 40, result: 'hola' }],
          think: null,
          todos: null,
          parts: [
            { k: 'text', text: 'x'.repeat(6000) },
            { k: 'tool', name: 'read_file', args: { path: 'a.txt' }, ok: true, ms: 40, result: 'hola' },
          ],
        },
      },
    ]);
    await m.listo();

    const turno = m.$('#messages .msg.ai .bubble.blocks');
    assertOk(turno, 'el turno es una columna de bloques');
    const segs = [...turno.querySelectorAll(':scope > .seg')];
    assertEqual(segs.length, 1, 'el texto se pinta UNA vez, no una por parte');
    assertOk(segs[0].textContent.includes(FINAL), 'y llega hasta el final del turno, no hasta el corte');
    assertEqual(turno.textContent.split(FINAL).length - 1, 1, 'el final aparece exactamente una vez');

    const grupo = turno.querySelector(':scope > .tgroup');
    assertOk(grupo, 'las herramientas del turno siguen en su sitio');
    assertOk(grupo.classList.contains('open'), 'y a la vista');
    const card = grupo.querySelector('.tcard');
    assertOk(card, 'con su tarjeta');
    assertOk(/a\.txt/.test(card.textContent), 'y sus argumentos: ' + card.textContent);
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
