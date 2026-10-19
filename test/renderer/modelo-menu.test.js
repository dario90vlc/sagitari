'use strict';

/* Pruebas del pie «Detectar nuevo» del menú de modelos (renderer/40-vistas.js).

   El sondeo del pie llamaba a `listModels(baseUrl, apiKey)` sin decir el protocolo,
   así que main asumía Bearer/OpenAI. Un proveedor de terceros con `format` anthropic
   o responses cuya URL no lo delata (no lleva «/anthropic») se sondeaba por el camino
   equivocado y la detección fallaba (401/404) justo donde la pestaña Modelo sí acierta
   porque ésa sí manda `{format, providerId}`.

   Corre sobre el markup real de index.html (ver arnes-renderer.js). Sin spawn. */

const { montar } = require('./arnes-renderer');

const URL = 'https://miapi.example/v1';
/* Proveedor de terceros que habla Anthropic: la URL no lo delata (no lleva «/anthropic»),
   así que sólo `format` permite a main elegir x-api-key y la ruta correcta. */
const PROV = {
  id: 'p1',
  name: 'Tercero Anthropic',
  baseUrl: URL,
  apiKey: 'sk-secreta',
  format: 'anthropic',
  models: ['claude-x'],
};
const CONFIG = () => ({
  providers: [PROV],
  active: { providerId: 'p1', model: 'claude-x', baseUrl: URL },
  presets: [],
  settings: {},
});

/** Monta la app con un `listModels` que apunta lo que recibe, como el puente real. */
function montarPie() {
  const sondas = [];
  const m = montar({
    api: {
      getConfig: async () => CONFIG(),
      metaGet: async () => ({ guardrails: {} }),
      listModels: async (url, key, opts) => {
        sondas.push({ url, key, opts });
        return { ok: true, models: ['claude-x', 'claude-y'] };
      },
      saveProvider: async (p) => ({ ok: true, ...p }),
    },
  });
  // jsdom no trae scrollIntoView y el menú lo llama al marcar el modelo activo.
  m.w.Element.prototype.scrollIntoView = function () {};
  return { m, sondas };
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

/** Abre el menú de modelos y pulsa «Detectar nuevo». */
async function detectarDesdeElPie(m) {
  await m.listo();
  m.w.openModelMenu();
  await m.listo();
  const fila = m.$('#modelMenu .sm-item[data-act="detect"]');
  if (!fila) throw new Error('el pie «Detectar nuevo» no está en el menú');
  fila.click();
  await m.listo();
}

async function main() {
  console.log('pie «Detectar nuevo» del menú de modelos');

  await test('el sondeo del pie manda el format y el providerId del proveedor activo', async () => {
    const { m, sondas } = montarPie();
    await detectarDesdeElPie(m);
    assertEqual(sondas.length, 1, 'se sondea una vez:');
    assertEqual(sondas[0].url, URL, 'la URL del activo:');
    assertEqual(sondas[0].key, 'sk-secreta', 'la clave del activo:');
    assertEqual(sondas[0].opts && sondas[0].opts.format, 'anthropic', 'el format del activo:');
    assertEqual(sondas[0].opts && sondas[0].opts.providerId, 'p1', 'el providerId del activo:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
