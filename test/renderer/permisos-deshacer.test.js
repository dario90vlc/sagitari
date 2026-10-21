'use strict';

/* Deshacer de los cambios masivos de permisos.

   «Permitir todo» y «Restablecer permisos recomendados» tocan ~40 claves de golpe.
   Hasta ahora la única vuelta era rehacerlo a mano: el botón de restablecer NO es un
   deshacer, porque pone todo en el nivel de fábrica y se lleva por delante los niveles
   que el usuario tuviera puestos uno a uno. Aquí se comprueba que el aviso ofrece
   «Deshacer» y que al pulsarlo cada clave vuelve EXACTAMENTE a donde estaba.

   Corre sobre el markup real (arnes-renderer). Sin spawn. */

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
function assertOk(v, m) {
  if (!v) throw new Error(m || 'falso');
}
function assertEqual(a, b, m) {
  if (a !== b) throw new Error(`${m || ''} esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);
}

/* El nivel que quedó para cada clave, según las escrituras que recibió el proceso
   principal (la última gana). */
function nivelesEscritos(llamadas) {
  const mapa = {};
  for (const l of llamadas) {
    if (l.canal !== 'secSetToolPermMany' && l.canal !== 'secSetToolPerm') continue;
    const claves = l.canal === 'secSetToolPermMany' ? l.args[0] : [l.args[0]];
    const nivel = l.canal === 'secSetToolPermMany' ? l.args[1] : l.args[1];
    for (const k of claves) mapa[k] = nivel;
  }
  return mapa;
}

console.log('permisos — deshacer del cambio masivo');

module.exports = (async () => {
  const escrituras = [];
  const m = montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {}, security: { permissions: {} } }),
      metaGet: async () => ({
        // Dos niveles puestos a mano por el usuario: son los que hay que recuperar.
        permissions: { run_command: 'restricted', web_fetch: 'safe' },
        riskDefaults: { run_command: 'default', web_fetch: 'default', read_file: 'default' },
        guardrails: {},
      }),
      mcpList: async () => ({ servers: [] }),
      secSetToolPermMany: async (claves, nivel) => {
        escrituras.push({ canal: 'secSetToolPermMany', args: [claves, nivel] });
        return { ok: true };
      },
      secSetToolPerm: async (clave, nivel) => {
        escrituras.push({ canal: 'secSetToolPerm', args: [clave, nivel] });
        return { ok: true };
      },
    },
  });
  await m.listo();
  /* `askConfirm` es una función de los guiones: al cargarse pisa el doble del arnés y
     se queda esperando una pulsación que aquí no llega. Se vuelve a poner después de
     montar (el aviso `showToast` SÍ tiene que ser el de verdad: es el que trae el botón). */
  m.w.askConfirm = async () => true;

  await test('«Permitir todo» pone todas las claves en safe', () => {
    m.clic('#secAllowAll');
  });
  await m.listo(80);

  await test('la escritura es una sola y con el nivel safe', () => {
    assertEqual(escrituras.length, 1, 'escrituras:');
    assertEqual(escrituras[0].canal, 'secSetToolPermMany', 'usa la puerta atómica:');
    assertEqual(escrituras[0].args[1], 'safe', 'nivel:');
    assertOk(escrituras[0].args[0].includes('run_command'), 'entra run_command');
    assertOk(escrituras[0].args[0].includes('web_fetch'), 'entra web_fetch');
  });

  const boton = m.$('#toastStack .toast-act');
  await test('el aviso ofrece deshacer', () => {
    assertOk(boton, 'hay un botón .toast-act en el aviso');
    assertEqual(boton.textContent, 'Deshacer', 'etiqueta:');
  });

  await test('al pulsarlo, cada clave vuelve a SU nivel anterior', () => {
    boton.click();
  });
  await m.listo(40);

  await test('el deshacer restaura los niveles a mano, no el de fábrica', () => {
    const mapa = nivelesEscritos(escrituras.slice(1));
    assertEqual(mapa.run_command, 'restricted', 'run_command estaba bloqueada:');
    assertEqual(mapa.web_fetch, 'safe', 'web_fetch estaba en safe:');
  });

  await test('lo que no tenía nivel propio vuelve a default', () => {
    const mapa = nivelesEscritos(escrituras.slice(1));
    assertEqual(mapa.read_file, 'default', 'read_file no tenía override:');
    assertEqual(mapa.browser_eval, 'default', 'browser_eval no tenía override:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
})();
