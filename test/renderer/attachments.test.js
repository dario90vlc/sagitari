'use strict';

/* Tests para main/attachments.js — límites y clasificación de adjuntos.
   La última sección monta el renderer REAL (jsdom, ver arnes-renderer.js) para comprobar
   que el hilo reabierto pinta la frase y el chip del adjunto, no el texto que main ya no
   guarda. Sin spawn: se ejecuta directo con node. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const adj = require(path.join(__dirname, '..', '..', 'main', 'attachments.js'));

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

/** Como `test`, pero para lo que necesita `await` (el renderer con jsdom). */
async function atest(name, fn) {
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

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('attachments.js — extOf');

test('devuelve la extensión en minúsculas', () => {
  assertEqual(adj.extOf('C:/fotos/FOTO.PNG'), '.png');
});

test('devuelve cadena vacía sin extensión', () => {
  assertEqual(adj.extOf('LEEME'), '');
});

test('maneja ruta vacía', () => {
  assertEqual(adj.extOf(''), '');
});

console.log('attachments.js — kindOf');

test('reconoce una imagen', () => {
  assertEqual(adj.kindOf('a.png'), 'image');
});

test('reconoce texto', () => {
  assertEqual(adj.kindOf('a.js'), 'text');
});

test('reconoce binario', () => {
  assertEqual(adj.kindOf('a.exe'), 'binary');
});

test('una extensión desconocida no es imagen ni texto', () => {
  const k = adj.kindOf('a.zzz');
  assertOk(k === 'binary' || k === 'unknown', 'debe ser binario o desconocido, no ' + k);
});

console.log('attachments.js — mimeOf');

test('devuelve el MIME de un png', () => {
  assertEqual(adj.mimeOf('a.png'), 'image/png');
});

test('devuelve el MIME de un jpg', () => {
  assertOk(String(adj.mimeOf('a.jpg')).startsWith('image/'), 'debe ser una imagen');
});

console.log('attachments.js — insideDir');

test('un archivo dentro del directorio es de dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws', 'a.js'), path.join('C:', 'ws')), true);
});

test('un archivo fuera del directorio no es de dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'otro', 'a.js'), path.join('C:', 'ws')), false);
});

test('el propio directorio cuenta como dentro', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws'), path.join('C:', 'ws')), true);
});

test('una salida con .. no cuela', () => {
  assertEqual(adj.insideDir(path.join('C:', 'ws', '..', 'secreto.txt'), path.join('C:', 'ws')), false);
});

console.log('attachments.js — límites');

test('los topes son números positivos', () => {
  assertOk(adj.MAX_ATTACH_CHARS > 0, 'MAX_ATTACH_CHARS');
  assertOk(adj.MAX_FILE_BYTES > 0, 'MAX_FILE_BYTES');
  assertOk(adj.PROBE_AS_TEXT_BYTES > 0, 'PROBE_AS_TEXT_BYTES');
});

test('TEXT_EXTS, IMG_EXTS y BINARY_EXTS son Sets no vacíos', () => {
  assertOk(adj.TEXT_EXTS instanceof Set && adj.TEXT_EXTS.size > 0, 'TEXT_EXTS');
  assertOk(adj.IMG_EXTS instanceof Set && adj.IMG_EXTS.size > 0, 'IMG_EXTS');
  assertOk(adj.BINARY_EXTS instanceof Set && adj.BINARY_EXTS.size > 0, 'BINARY_EXTS');
});

console.log('attachments.js — ficha del adjunto (lo que se guarda en el historial)');

test('la ficha lleva nombre, tamaño y tipo, y nunca el texto', () => {
  const ficha = adj.cardFor({ name: 'notas.txt', kind: 'text', size: 2048, text: 'contenido secreto' });
  assertOk(ficha.includes('notas.txt'), 'el nombre va en la ficha: ' + ficha);
  assertOk(ficha.includes('2 KB'), 'y el tamaño: ' + ficha);
  assertOk(ficha.includes('texto'), 'y el tipo: ' + ficha);
  assertOk(!ficha.includes('contenido secreto'), 'pero nunca el texto del archivo');
});

test('una ficha por adjunto, en el orden en que se adjuntaron', () => {
  const fichas = adj.cardsFor([
    { name: 'a.txt', kind: 'text', size: 1024 },
    { name: 'b.png', kind: 'image', size: 1024 },
  ]);
  assertEqual(fichas.split('\n').length, 2, 'dos adjuntos → dos fichas:');
  assertOk(fichas.indexOf('a.txt') < fichas.indexOf('b.png'), 'en el orden original:');
  assertOk(fichas.includes('imagen'), 'la de la imagen se identifica como imagen: ' + fichas);
});

test('sin adjuntos no hay ficha', () => {
  assertEqual(adj.cardsFor([]), '');
  assertEqual(adj.cardsFor(null), '');
});

/* ---- el hilo reabierto: lo que main guarda es lo que el usuario vuelve a ver ----
   Se guarda el mensaje con el router REAL de main (main/ipc-chat.js) y se pinta con el
   resetChatView REAL del renderer sobre el markup de index.html. Así la prueba cubre la
   cadena entera: lo que se escribe en conversations.json y lo que aparece en la burbuja. */

/** Mensaje tal y como lo guardaría main/ipc-chat.js para ese texto y esos adjuntos. */
async function mensajeGuardado(text, attachments) {
  const { registerChatIpc } = require(path.join(__dirname, '..', '..', 'main', 'ipc-chat.js'));
  const handlers = {};
  const conv = { id: 'c1', title: 'Prueba', messages: [], updatedAt: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-adj-hilo-'));
  const rutaConvs = path.join(dir, 'conversations.json');
  registerChatIpc(
    { handle: (n, f) => (handlers[n] = f) },
    {
      config: () => ({ settings: {} }),
      runtimes: { agentFor: () => ({ chat: async () => {}, isBusy: () => false }) },
      convsApi: {
        convById: () => conv,
        currentConv: () => conv,
        ensureConv: () => conv,
        saveConvs: () => fs.writeFileSync(rutaConvs, JSON.stringify({ convs: [conv] })),
      },
      getSkills: () => ({ getSkill: async () => null }),
      getGlow: () => () => {},
      getWin: () => null,
      configDir: () => dir,
      onError: () => {},
      dialog: {},
      fsp: fs.promises,
      fs,
      path,
      attach: adj,
    },
  );
  await handlers['chat:send'](null, { convId: 'c1', text, attachments });
  return { msg: conv.messages[0], enDisco: fs.readFileSync(rutaConvs, 'utf8') };
}

/** Monta el renderer y repinta el hilo con esos mensajes; devuelve la burbuja del usuario. */
async function pintarHilo(mensajes) {
  const { montar } = require('./arnes-renderer');
  const m = montar({
    api: {
      getConfig: async () => ({ providers: [], active: null, presets: [], settings: {} }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({ guardrails: {} }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
    },
  });
  await m.listo();
  m.w.abrirRuntime('c1');
  await m.listo();
  m.w.resetChatView(mensajes);
  await m.listo();
  return { m, burbuja: m.$('#messages .msg.me') };
}

async function seccionHilo() {
  console.log('attachments.js — el hilo reabierto pinta la ficha del adjunto');

  await atest('al reabrir se ve la frase del usuario y el chip del adjunto, no su texto', async () => {
    const relleno = 'TEXTO-DEL-ADJUNTO '.repeat(20000); // muy por encima del tope por archivo
    const { msg, enDisco } = await mensajeGuardado('resume esto', [
      { name: 'notas.txt', kind: 'text', size: relleno.length, text: relleno },
    ]);
    assertOk(!enDisco.includes('TEXTO-DEL-ADJUNTO'), 'conversations.json no lleva el texto del adjunto:');
    const { burbuja } = await pintarHilo([msg]);
    assertOk(burbuja, 'falta la burbuja del mensaje del usuario');
    const texto = burbuja.textContent;
    assertOk(texto.includes('resume esto'), 'la burbuja enseña la frase: ' + JSON.stringify(texto.slice(0, 80)));
    assertOk(texto.includes('notas.txt'), 'y el chip con el nombre del adjunto: ' + JSON.stringify(texto.slice(0, 120)));
    assertOk(!texto.includes('TEXTO-DEL-ADJUNTO'), 'y no el texto del adjunto');
    assertOk(!texto.includes('He adjuntado'), 'ni la ficha (que es para el modelo, no para la vista)');
  });

  await atest('un hilo guardado por la versión anterior (con el volcado dentro) se sigue viendo bien', async () => {
    // Compatibilidad hacia atrás: las conversaciones ya guardadas llevan el volcado en
    // `content`; el renderer lo recorta igual, así que no hay que migrar nada.
    const viejo = {
      role: 'user',
      ts: Date.now(),
      content:
        'resume esto\n\nHe adjuntado archivos para que los uses en tu respuesta:\n\n--- ARCHIVO ADJUNTO: notas.txt (293 KB) ---\nTEXTO-DEL-ADJUNTO ...',
      attachments: [{ name: 'notas.txt', kind: 'text', size: 300000 }],
    };
    const { burbuja } = await pintarHilo([viejo]);
    assertOk(burbuja, 'falta la burbuja del mensaje del usuario');
    const texto = burbuja.textContent;
    assertOk(texto.includes('resume esto'), 'la frase se sigue viendo: ' + JSON.stringify(texto.slice(0, 80)));
    assertOk(texto.includes('notas.txt'), 'y el chip del adjunto');
    assertOk(!texto.includes('TEXTO-DEL-ADJUNTO'), 'sin el volcado');
  });
}

/* El renderer necesita jsdom: el resumen tiene que salir DESPUÉS de esta sección. */
module.exports = (async () => {
  await seccionHilo();
  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
})();
