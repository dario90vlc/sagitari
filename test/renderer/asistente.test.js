'use strict';

/* Pruebas del asistente de primer uso (renderer/30-ajustes.js, wizard #wizardSetup).

   El caso que se cubre es el de un perfil NUEVO (providers: []) en el que el usuario
   escribe o acepta una Base URL en el paso 2 y sigue al paso 3: la dirección tiene que
   llegar a la detección de modelos y a la activación, y «Atrás» no puede borrar lo
   escrito. Sin esto, quien acaba de instalar la app se queda atrapado en el paso 3 con
   «baseUrl debe ser http(s) o localhost» y sin ningún modelo que activar.

   Corre sobre el markup real de index.html (ver arnes-renderer.js). Sin spawn. */

const { montar } = require('./arnes-renderer');

const PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, format: 'openai', hint: 'GPT' },
  { id: 'custom', name: 'Personalizado (OpenAI-compatible)', baseUrl: '', needsKey: true, format: 'openai', hint: 'Cualquiera' },
];

const CONFIG = () => ({ providers: [], active: null, presets: PRESETS, settings: {} });

/** Monta el wizard con un listModels que se comporta como el del proceso principal:
    rechaza una base vacía o no http(s)/localhost (main/providers.js). */
function montarWizard(extra = {}) {
  const detectadas = [];
  const guardados = [];
  const activados = [];
  const m = montar({
    api: {
      getConfig: async () => CONFIG(),
      listModels: async (url, key, opts) => {
        detectadas.push({ url, key, opts });
        if (!/^https?:\/\//i.test(url) && !/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
          throw new Error('baseUrl debe ser http(s) o localhost');
        }
        return { ok: true, models: ['gpt-4o-mini', 'gpt-4o'] };
      },
      saveProvider: async (p) => {
        guardados.push(p);
        return { ok: true };
      },
      activateProvider: async (p) => {
        activados.push(p);
        return { ok: true };
      },
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      ...extra.api,
    },
  });
  return { m, detectadas, guardados, activados };
}

/** Paso 1 → elegir proveedor y avanzar: deja el wizard en el paso 2. */
function irAlPasoDos(m, preset) {
  m.clic(`[data-wz="${preset}"]`);
  m.clic('#wzNext');
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
function assertMatch(value, regex, msg) {
  if (!regex.test(String(value))) throw new Error(`${msg || ''} ${JSON.stringify(value)} no cumple ${regex}`);
}

async function main() {
  console.log('asistente de primer uso — wizard');

  await test('el paso 2 ofrece la Base URL del preset y el botón de seguir está activo', async () => {
    const { m } = montarWizard();
    await m.listo();
    assertOk(m.$('#wizardSetup').classList.contains('on'), 'el wizard debe abrirse sin modelo activo');
    irAlPasoDos(m, 'openai');
    assertEqual(m.$('#wzUrl').value, 'https://api.openai.com/v1', 'la URL del preset:');
    assertOk(!m.$('#wzNext').disabled, '«Siguiente» habilitado:');
  });

  await test('la Base URL escrita en el paso 2 llega a la detección de modelos del paso 3', async () => {
    const { m, detectadas } = montarWizard();
    await m.listo();
    irAlPasoDos(m, 'openai');
    m.$('#wzUrl').value = 'https://mi-servidor.example/v1';
    m.$('#wzKey').value = 'sk-secreta';
    m.clic('#wzNext');
    await m.listo();
    assertEqual(detectadas.length, 1, 'se detecta una vez:');
    assertEqual(detectadas[0].url, 'https://mi-servidor.example/v1', 'la URL que se sondea:');
    assertEqual(detectadas[0].key, 'sk-secreta', 'la clave que se sondea:');
    const opciones = Array.from(m.$('#wzModel').options).map((o) => o.value);
    assertEqual(opciones.join(','), 'gpt-4o-mini,gpt-4o', 'los modelos en el desplegable:');
    assertMatch(m.$('#wzMsg').textContent, /2 modelos detectados/, 'el aviso del paso 3:');
  });

  await test('«Activar modelo» activa el proveedor con lo escrito (perfil nuevo)', async () => {
    const { m, activados } = montarWizard();
    await m.listo();
    irAlPasoDos(m, 'openai');
    m.$('#wzUrl').value = 'https://mi-servidor.example/v1';
    m.$('#wzKey').value = 'sk-secreta';
    m.clic('#wzNext');
    await m.listo();
    m.clic('#wzActivar');
    await m.listo();
    assertEqual(activados.length, 1, 'se activa una vez:');
    assertEqual(activados[0].baseUrl, 'https://mi-servidor.example/v1', 'la URL activada:');
    assertEqual(activados[0].apiKey, 'sk-secreta', 'la clave activada:');
    assertEqual(activados[0].model, 'gpt-4o-mini', 'el modelo activado:');
    assertOk(!m.$('#wizardSetup').classList.contains('on'), 'el wizard se cierra al activar');
  });

  await test('con el proveedor «Personalizado» (sin Base URL en el preset) también funciona', async () => {
    const { m, detectadas } = montarWizard();
    await m.listo();
    irAlPasoDos(m, 'custom');
    assertEqual(m.$('#wzUrl').value, '', 'el preset no trae URL:');
    m.$('#wzUrl').value = 'http://127.0.0.1:8080/v1';
    m.clic('#wzNext');
    await m.listo();
    assertEqual(detectadas[0].url, 'http://127.0.0.1:8080/v1', 'la URL escrita a mano:');
  });

  await test('«Atrás» desde el paso 3 conserva la URL y la clave escritas', async () => {
    const { m } = montarWizard();
    await m.listo();
    irAlPasoDos(m, 'openai');
    m.$('#wzUrl').value = 'https://otro.example/v1';
    m.$('#wzKey').value = 'sk-otra';
    m.clic('#wzNext');
    await m.listo();
    m.clic('#wzAtras');
    assertEqual(m.$('#wzUrl').value, 'https://otro.example/v1', 'la URL al volver:');
    assertEqual(m.$('#wzKey').value, 'sk-otra', 'la clave al volver:');
  });

  await test('cambiar de proveedor en el paso 1 sí reinicia la URL al del nuevo preset', async () => {
    const { m } = montarWizard();
    await m.listo();
    irAlPasoDos(m, 'custom');
    m.$('#wzUrl').value = 'https://otro.example/v1';
    m.clic('#wzAtras');
    m.clic('[data-wz="openai"]');
    m.clic('#wzNext');
    assertEqual(m.$('#wzUrl').value, 'https://api.openai.com/v1', 'vuelve a la del preset:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
