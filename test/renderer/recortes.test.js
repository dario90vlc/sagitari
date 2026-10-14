'use strict';

/* Pruebas de los recortes de texto de las listas (chatkit.js + 10-chat.js + 40-vistas.js).

   Todos los recortes cortaban por unidades UTF-16 (`slice(0, n)`): un emoji fuera del
   BMP ocupa dos unidades y, si el corte caía en medio, quedaba un sustituto suelto que el
   navegador pinta como «�». Aparece en sitios bien visibles (el encargo de un compañero,
   el resumen de una herramienta, el error de una tarea) y basta con que el modelo use un
   emoji. El corte tiene que ser por PUNTOS DE CÓDIGO.

   Corre sobre el markup real de index.html (ver arnes-renderer.js). Sin spawn. */

const { montar } = require('./arnes-renderer');

/** ¿Queda algún sustituto suelto (mitad de emoji) en el texto? */
function suelto(t) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(t));
}
/** Ni sustituto suelto ni el carácter roto que pinta el navegador. */
function assertSinRotos(texto, msg) {
  if (suelto(texto)) throw new Error(`${msg || ''} deja una mitad de emoji: ${JSON.stringify(String(texto))}`);
  if (String(texto).includes('\uFFFD')) throw new Error(`${msg || ''} deja «�»: ${JSON.stringify(String(texto))}`);
}
/** Cadena de `n` caracteres con un emoji justo a caballo del corte. */
function conEmojiA(n, emoji) {
  return 'a'.repeat(n - 1) + emoji + 'b'.repeat(30);
}

const TAREA = {
  runId: 'r1',
  status: 'completed',
  goal: 'Revisa el proyecto',
  step: 'cerrar',
  steps: 4,
  updatedAt: new Date().toISOString(),
  result: 'Hecho',
};

function montarVistas(api = {}) {
  const confirmaciones = [];
  const m = montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      tasksList: async () => [TAREA],
      taskRemove: async () => ({ ok: true }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      ...api,
    },
  });
  m.w.askConfirm = async (anchor, message, detail) => {
    confirmaciones.push({ message, detail });
    return false; // no hace falta seguir: sólo se mira el texto del aviso
  };
  return { m, confirmaciones };
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
  console.log('recortes de texto — puntos de código');

  await test('clip corta por puntos de código, no por unidades UTF-16', async () => {
    const { m } = montarVistas();
    await m.listo();
    const K = m.w.ChatKit;
    assertEqual(K.clip('😀😀😀😀', 3), '😀😀…', 'cuatro emojis a tres:');
    assertEqual(K.clip('😀😀😀😀😀😀', 8), '😀😀😀😀😀😀', 'seis emojis (12 unidades) en 8 caracteres NO se recortan:');
    assertEqual(K.clip('corto', 8), 'corto', 'lo que cabe se deja igual:');
    assertSinRotos(K.clip(conEmojiA(48, '🧠'), 48), 'clip');
    const r = K.clip('Revisa 20 ficheros del proyecto y resume 🧠 los hallazgos clave', 48);
    assertSinRotos(r, 'clip de un encargo');
    assertOk(r.endsWith('…'), 'recorta con puntos suspensivos:');
  });

  await test('la lista de Tareas no parte el emoji del error ni del resultado', async () => {
    const { m } = montarVistas({
      tasksList: async () => [
        {
          ...TAREA,
          result: conEmojiA(140, '🚀'),
          lastError: { step: 'leer', tool: 'read', message: conEmojiA(120, '✅') },
        },
      ],
    });
    await m.listo();
    await m.w.goto('tasks');
    await m.listo();
    const box = m.$('#tasksList');
    assertOk(box, 'la vista pinta la lista:');
    assertSinRotos(box.textContent, 'la fila de la tarea');
  });

  await test('el aviso de borrar una tarea no parte el emoji del objetivo', async () => {
    const { m, confirmaciones } = montarVistas({
      tasksList: async () => [{ ...TAREA, goal: conEmojiA(160, '🧠') }],
    });
    await m.listo();
    await m.w.goto('tasks');
    await m.listo();
    m.clic('#tasksList .hitem [data-del]');
    await m.listo();
    assertEqual(confirmaciones.length, 1, 'se pide confirmación:');
    assertSinRotos(confirmaciones[0].detail, 'el aviso de borrado');
  });

  await test('la etiqueta del tablero de equipo recorta por puntos de código', async () => {
    const { m } = montarVistas();
    await m.listo();
    const etiqueta = m.w.etiquetaEquipo({ subagent: 'investigador', task: conEmojiA(40, '🧠') });
    assertSinRotos(etiqueta, 'la etiqueta de equipo');
  });

  await test('la primera línea útil de un bloque no parte el emoji', async () => {
    const { m } = montarVistas();
    await m.listo();
    const linea = m.w.primeraLineaUtil('😀'.repeat(200), 130);
    assertSinRotos(linea, 'primeraLineaUtil');
  });

  await test('la inicial del avatar de un nombre con emoji no es media mitad', async () => {
    const { m } = montarVistas();
    await m.listo();
    m.w.eval('CFG.settings.userName = "🧠Darío"');
    m.w.bubble('user');
    const av = m.$('#messages .msg.me .avatar');
    assertOk(av, 'la burbuja del usuario trae avatar:');
    assertSinRotos(av.textContent, 'la inicial del avatar');
    assertEqual(av.textContent, '🧠', 'la inicial es el emoji entero:');
  });

  await test('la cabecera de una tarjeta de herramienta fallida no parte el emoji', async () => {
    const { m } = montarVistas();
    await m.listo();
    const card = m.w.document.createElement('div');
    card.innerHTML =
      '<span class="tcard-ic"></span><div class="tcard-head"><span class="tcard-name">read</span><span class="tcard-time"></span></div><div class="tcard-body"></div>';
    m.w.pintarResultadoTarjeta(card, { name: 'read', ok: false, result: 'Error: ' + conEmojiA(160, '🚀') });
    const nota = card.querySelector('.tcard-note');
    assertOk(nota, 'la tarjeta lleva su línea de error:');
    assertSinRotos(nota.textContent, 'la nota de error');
    assertSinRotos(nota.title, 'el title de la nota');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer espera la promesa que devuelve el módulo. */
module.exports = main();
