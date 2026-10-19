'use strict';

/* Tests para agent/memoria-v2.js — esquema v2, huella de deduplicación, similitud con
   raíz, fusión de duplicados, migración v1→v2, extracción heurística de hechos y reglas
   puras de olvido.

   El módulo es PURO (no toca disco), así que no hay que aislar ningún almacén: lo que se
   prueba es la decisión, no el fichero. Sin spawn: se ejecuta directo con node. */

const path = require('path');
const v2 = require(path.join(__dirname, '..', '..', 'agent', 'memoria-v2.js'));

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || ''} esperado ${b}, obtenido ${a}`);
}

console.log('memoria-v2.js — esquema');

test('normalizarHecho rellena los campos v2 que faltan', () => {
  const h = v2.normalizarHecho({ id: 'a1', text: 'El usuario prefiere informes en PDF', date: '2026-01-02T00:00:00.000Z' });
  assertEqual(h.origen, 'mensaje', 'origen por defecto');
  assertEqual(h.origenTexto, '');
  assertOk(Array.isArray(h.etiquetas));
  assertEqual(h.papelera, null);
  assertOk(/^[0-9a-f]{16}$/.test(h.hash), 'huella hexadecimal de 16');
  assertEqual(h.uses, 0);
  assertEqual(h.importance, 0.5, 'importancia por defecto');
  assertEqual(h.confidence, 0.8);
  assertEqual(h.lastUsed, h.date, 'sin lastUsed, vale la fecha de creación');
});

test('normalizarHecho traduce el `source` de la v1 a `origen`', () => {
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'agent' }).origen, 'herramienta');
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'habit' }).origen, 'habitos');
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'user' }).origen, 'usuario');
  assertEqual(v2.normalizarHecho({ text: 'x', origen: 'mensaje' }).origen, 'mensaje');
});

test('normalizarHecho colapsa espacios y recorta a 500 caracteres', () => {
  assertEqual(v2.normalizarTexto('  hola   mundo  '), 'hola mundo');
  assertEqual(v2.normalizarTexto('x'.repeat(600)).length, 500);
  assertEqual(v2.normalizarTexto(null), '');
});

test('normalizarHecho limpia etiquetas repetidas y acepta importance numérica', () => {
  const h = v2.normalizarHecho({ text: 'x', etiquetas: ['a', 'a', 'b'], importance: 7 });
  assertDeep(h.etiquetas, ['a', 'b']);
  assertEqual(h.importance, 1, 'la importancia se recorta a 0..1');
});

console.log('memoria-v2.js — huella y similitud');

test('la huella no cambia con mayúsculas ni acentos', () => {
  assertEqual(v2.hashTexto('El Usuario se llama Darío'), v2.hashTexto('el usuario se llama dario'));
});

test('la huella es estable entre llamadas y distinta para frases distintas', () => {
  assertEqual(v2.hashTexto('Prefiero el té'), v2.hashTexto('Prefiero el té'));
  assertOk(v2.hashTexto('Prefiero el té') !== v2.hashTexto('Prefiero el café'));
});

test('tokenizar quita acentos, stopwords y palabras de menos de tres letras', () => {
  assertDeep(v2.tokenizar('El usuario se llama Darío'), ['usuario', 'llama', 'dario']);
  assertDeep(v2.tokenizar('de la y o a'), [], 'las stopwords no cuentan');
});

test('tokenizarRaiz hace que llamo, llama y llamar coincidan', () => {
  const a = v2.tokenizarRaiz('me llamo Darío');
  const b = v2.tokenizarRaiz('el usuario se llama Darío');
  assertOk(
    a.every((t) => b.includes(t)),
    `las raíces de «me llamo» deben estar en «se llama»: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );
});

test('similitud reconoce dos frases que hablan de lo mismo', () => {
  const s = v2.similitud('El usuario se llama Darío', 'Recuerda que me llamo Dario');
  assertOk(s >= v2.FUSION_UMBRAL, `debería superar el umbral de fusión, obtuve ${s}`);
});

test('similitud no mezcla temas distintos', () => {
  const s = v2.similitud('El usuario se llama Darío', 'Trabajo con proyectos de Blender y renders');
  assertOk(s < v2.FUSION_UMBRAL, `no debería fusionarse, obtuve ${s}`);
});

test('similitud de un texto consigo mismo es 1 y con vacío es 0', () => {
  assertEqual(v2.similitud('El usuario se llama Darío', 'El usuario se llama Darío'), 1);
  assertEqual(v2.similitud('', 'El usuario se llama Darío'), 0);
});

console.log('memoria-v2.js — fusión y migración');

test('fusionarPar conserva el texto más reciente, suma usos y no baja la importancia', () => {
  const a = v2.normalizarHecho({ id: 'a', text: 'El usuario se llama Darío', date: '2026-01-01T00:00:00.000Z', uses: 2, importance: 0.3 });
  const b = v2.normalizarHecho({
    id: 'b',
    text: 'Recuerda que me llamo Dario',
    date: '2026-02-01T00:00:00.000Z',
    uses: 4,
    importance: 0.9,
  });
  const f = v2.fusionarPar(a, b);
  assertEqual(f.text, 'Recuerda que me llamo Dario', 'gana el texto más reciente');
  assertEqual(f.id, 'b', 'se queda el id del más reciente');
  assertEqual(f.importance, 0.9, 'la importancia es la mayor');
  assertOk(f.uses >= 6, 'los usos se suman');
});

test('migrarV1 fusiona las dos entradas reales del usuario en una', () => {
  const r = v2.migrarV1([
    { id: 'a', text: 'El usuario se llama Darío', date: '2026-10-12T10:00:00.000Z' },
    { id: 'b', text: 'Recuerda que me llamo Dario', date: '2026-10-13T10:00:00.000Z' },
  ]);
  assertEqual(r.version, v2.ESQUEMA);
  assertEqual(r.hechos.length, 1, 'una sola entrada tras fusionar');
  assertEqual(r.hechos[0].text, 'Recuerda que me llamo Dario', 'se conserva el texto más reciente');
  assertEqual(r.fusiones.length, 1);
});

test('migrarV1 con las dos entradas reales del perfil (mismos usos y fecha) deja una sola', () => {
  const r = v2.migrarV1([
    {
      id: 'mmu5rk15nr5hq',
      text: 'El usuario se llama Darío.',
      date: '2026-09-17T16:48:15.323Z',
      lastUsed: '2026-10-01T10:58:25.849Z',
      uses: 53,
      importance: 0.8,
      confidence: 0.8,
      source: 'agent',
    },
    {
      id: 'mmtxa7yco1m8n',
      text: 'Recuerda que me llamo Dario',
      date: '2026-09-11T18:20:48.936Z',
      lastUsed: '2026-10-01T10:58:25.849Z',
      uses: 49,
      importance: 1,
      confidence: 0.8,
      source: 'user',
    },
  ]);
  assertEqual(r.hechos.length, 1, 'los dos «me llamo Darío» quedan en uno');
  assertEqual(r.fusiones.length, 1);
  assertEqual(r.hechos[0].uses, 103, '53 + 49 usos, más el refuerzo de la propia fusión');
  assertEqual(r.hechos[0].importance, 1, 'gana la importancia mayor');
  assertEqual(r.hechos[0].origen, 'herramienta', 'el origen del hecho se conserva');
});

test('migrarV1 conserva los hechos que no se parecen', () => {
  const r = v2.migrarV1([{ text: 'El usuario se llama Darío' }, { text: 'Trabajo con proyectos de Blender y renders' }]);
  assertEqual(r.hechos.length, 2);
  assertEqual(r.fusiones.length, 0);
});

test('migrarV1 suma los usos al fusionar', () => {
  const r = v2.migrarV1([
    { id: 'a', text: 'Prefiero informes en PDF', uses: 2, importance: 0.3 },
    { id: 'b', text: 'Prefiero los informes en PDF', uses: 4, importance: 0.9 },
  ]);
  assertEqual(r.hechos.length, 1);
  assertOk(r.hechos[0].uses >= 6, 'los usos se suman');
  assertEqual(r.hechos[0].importance, 0.9, 'la importancia es la mayor');
});

test('migrarV1 ignora entradas sin texto y listas que no son listas', () => {
  assertEqual(v2.migrarV1([{ id: 'x' }, { text: '' }, null]).hechos.length, 0);
  assertEqual(v2.migrarV1(null).hechos.length, 0);
});

test('migrarV1 deduplica por huella aunque cambien mayúsculas y tildes', () => {
  const r = v2.migrarV1([
    { text: 'Prefiere informes en PDF', date: '2026-01-01T00:00:00.000Z' },
    { text: 'prefiere informes en pdf', date: '2026-01-02T00:00:00.000Z' },
  ]);
  assertEqual(r.hechos.length, 1);
});

/* Sonda de la auditoría: cuatro entradas v1 distintas se quedaban en dos («prefiero el
   café» se fusionaba con «prefiero el té» y «…en Windows» con «…en Linux») porque la
   migración decidía por parecido de texto. El valor tiene que mandar también al migrar. */
test('migrarV1 no fusiona hechos distintos que se parecen (el valor manda)', () => {
  const r = v2.migrarV1([
    { id: 'c1', text: 'Prefiero el café' },
    { id: 'c2', text: 'Prefiero el té' },
    { id: 'w1', text: 'El usuario usa VS Code en Windows' },
    { id: 'w2', text: 'El usuario usa VS Code en Linux' },
  ]);
  assertDeep(
    r.hechos.map((h) => h.text).sort(),
    ['El usuario usa VS Code en Linux', 'El usuario usa VS Code en Windows', 'Prefiero el café', 'Prefiero el té'],
    'no se puede perder ningún hecho distinto',
  );
  assertEqual(r.fusiones.length, 0, 'no hay nada que fusionar');
});

test('migrarV1 registra los DOS ids distintos de cada fusión', () => {
  const r = v2.migrarV1([
    { id: 'viejo', text: 'El usuario se llama Darío', date: '2026-01-01T00:00:00.000Z' },
    { id: 'nuevo', text: 'Me llamo Darío', date: '2026-02-01T00:00:00.000Z' },
  ]);
  assertEqual(r.hechos.length, 1, 'el mismo dato sigue quedando en uno');
  assertEqual(r.fusiones.length, 1);
  assertEqual(r.fusiones[0].seQueda, 'nuevo', 'se queda el id del más reciente');
  assertEqual(r.fusiones[0].seFusiona, 'viejo', 'y se registra el absorbido, distinto del anterior');
  assertEqual(r.fusiones[0].texto, 'Me llamo Darío');
  assertEqual(r.fusiones[0].textoFusionado, 'El usuario se llama Darío', 'se puede reconstruir qué se fusionó');
});

test('migrarV1 es idempotente: migrar el resultado no vuelve a fusionar nada', () => {
  const src = [
    { id: 'a', text: 'El usuario se llama Darío', date: '2026-10-12T10:00:00.000Z' },
    { id: 'b', text: 'Recuerda que me llamo Dario', date: '2026-10-13T10:00:00.000Z' },
    { id: 'c', text: 'Prefiero el café' },
    { id: 'd', text: 'Prefiero el té' },
  ];
  /* El resultado de la PRIMERA pasada se fija aquí: sin esto, «la segunda no cambia nada»
     se cumple también con el algoritmo viejo, que fusionaba «café» con «té» por parecido
     y ya dejaba dos hechos en la primera pasada (la segunda no tenía nada que hacer en
     ninguno de los dos casos, así que la prueba no discriminaba). */
  const uno = v2.migrarV1(src);
  assertDeep(
    uno.hechos.map((h) => h.text),
    ['Recuerda que me llamo Dario', 'Prefiero el café', 'Prefiero el té'],
    'la primera pasada deja un hecho por dato, sin fundir los que solo se parecen',
  );
  assertEqual(uno.fusiones.length, 1, 'solo las dos formas del mismo nombre se fusionan');
  assertEqual(uno.fusiones[0].seQueda, 'b', 'y se queda el texto más reciente');
  assertEqual(uno.fusiones[0].seFusiona, 'a', 'con el absorbido registrado aparte');
  const dos = v2.migrarV1(uno.hechos);
  assertDeep(dos.hechos.map((h) => h.text), uno.hechos.map((h) => h.text), 'la segunda pasada no cambia nada');
  assertEqual(dos.fusiones.length, 0, 'no queda nada por fusionar');
});

test('mismoHecho solo fusiona por valor o por huella, nunca por parecido', () => {
  assertOk(v2.mismoHecho('El usuario se llama Darío', 'Recuerda que me llamo Dario'), 'mismo dato, otra forma');
  assertOk(v2.mismoHecho('Prefiere informes en PDF', 'prefiere informes en pdf'), 'misma huella');
  assertOk(!v2.mismoHecho('Prefiero el té', 'Prefiero el café'), 'se parecen y son datos distintos');
  assertOk(!v2.mismoHecho('El usuario usa VS Code en Windows', 'El usuario usa VS Code en Linux'), 'sin clave no hay valor que comparar');
  assertOk(!v2.mismoHecho('El usuario vive en Madrid', 'El usuario trabaja en Madrid'), 'predicados distintos');
});

console.log('memoria-v2.js — proponerHechos (extracción heurística)');

/* Casos verificados por el frente de extracción antes del congelado v2. El riesgo real
   es proponer de MÁS: una bandeja con ruido se apaga y la memoria nunca se llena, así
   que la batería de negativos es tan importante como la de positivos. */
const POSITIVOS = [
  ['Me llamo Darío.', 'El usuario se llama Darío', ['identidad'], 0.9],
  ['Mi nombre es Darío.', 'El usuario se llama Darío', ['identidad'], 0.9],
  ['Soy ingeniero de software.', 'El usuario es ingeniero de software', ['identidad'], 0.75],
  ['Recuerda que me llamo Darío.', 'El usuario se llama Darío', ['identidad'], 0.9],
  ['No, en realidad me llamo Darío.', 'El usuario se llama Darío', ['identidad'], 0.95],
  ['Mejor dicho, prefiero el té.', 'El usuario prefiere el té', ['preferencia'], 0.85],
  ['No, en realidad vivo en Madrid.', 'Vivo en Madrid', ['correccion'], 0.7],
  ['Prefiero las respuestas cortas.', 'El usuario prefiere las respuestas cortas', ['preferencia'], 0.75],
  ['No me gusta el café.', 'Al usuario no le gusta el café', ['preferencia'], 0.75],
  ['Siempre hago las pruebas antes de subir.', 'El usuario siempre hace las pruebas antes de subir', ['preferencia'], 0.7],
  ['Trabajo en C:\\proyectos\\web', 'El usuario trabaja en C:\\proyectos\\web', ['proyecto'], 0.8],
  ['Mi proyecto es SAGITARI.', 'El proyecto del usuario es SAGITARI', ['proyecto'], 0.8],
  ['Háblame en inglés.', 'El usuario prefiere que le hable en inglés', ['idioma'], 0.85],
];

for (const [entrada, texto, etiquetas, confianza] of POSITIVOS) {
  test(`propone: «${entrada}»`, () => {
    const p = v2.proponerHechos(entrada);
    assertEqual(p.length, 1, 'un solo hecho: ' + JSON.stringify(p));
    assertEqual(p[0].texto, texto);
    assertDeep(p[0].etiquetas, etiquetas);
    assertEqual(p[0].confianza, confianza);
    assertEqual(p[0].origen, 'mensaje');
    assertEqual(p[0].origenTexto, v2.normalizarTexto(entrada), 'el texto literal se conserva');
    assertOk(p[0].motivo, 'explica por qué se propuso');
  });
}

test('propone los dos hechos de una frase compuesta, en orden', () => {
  const p = v2.proponerHechos('Me llamo Darío y prefiero el té.');
  assertDeep(
    p.map((x) => x.texto),
    ['El usuario se llama Darío', 'El usuario prefiere el té'],
  );
});

test('no propone dos veces el mismo hecho en el mismo mensaje', () => {
  assertEqual(v2.proponerHechos('Me llamo Darío. Me llamo Darío.').length, 1);
});

test('ignora «mi proyecto es sagitari.app» sin partir el dominio', () => {
  const p = v2.proponerHechos('Mi proyecto es sagitari.app');
  assertEqual(p.length, 1);
  assertEqual(p[0].texto, 'El proyecto del usuario es sagitari.app', 'el punto del dominio no corta la frase');
});

const NEGATIVOS = [
  '¿Cómo me llamo?',
  'Dime cómo me llamo, ¿vale?',
  'Si me llamo Darío, avísame.',
  'Cuando prefiero algo, lo digo.',
  'No me llamo Darío.',
  'No soy ingeniero.',
  'Soy consciente de que eso falla.',
  'Soy muy desordenado con los nombres.',
  'Juan dice que me llamo Darío.',
  'Me dijo: "prefiero el té".',
  'Según mi jefe, soy un desastre.',
  "if (me llamo == 'Darío') { return true; }",
  'const meLlamo = "Darío";',
  'Prefiero más.',
  'Me llamo.',
  '',
  '   ',
  null,
  undefined,
];

for (const entrada of NEGATIVOS) {
  test(`no propone: ${JSON.stringify(entrada)}`, () => {
    assertDeep(v2.proponerHechos(entrada), []);
  });
}

/* El atajo de «corrección» proponía CUALQUIER frase que empezara por «en realidad…»:
   una petición pasajera se convertía en memoria duradera. Ahora una corrección solo se
   propone si aporta un valor concreto (un nombre propio, una ruta, un número); sin él es
   conversación, no memoria. */
test('una corrección sin ningún valor concreto no se propone', () => {
  assertDeep(v2.proponerHechos('En realidad quiero que me lo digas otra vez'), []);
  assertDeep(v2.proponerHechos('Más bien explícamelo con otras palabras'), []);
});

test('una corrección con un valor concreto sí se propone', () => {
  const p = v2.proponerHechos('En realidad tengo 3 gatos');
  assertEqual(p.length, 1, 'un dato con número: ' + JSON.stringify(p));
  assertEqual(p[0].texto, 'Tengo 3 gatos');
  const r = v2.proponerHechos('Mejor dicho, la carpeta es C:\\dev\\notas');
  assertEqual(r.length, 1, 'una ruta: ' + JSON.stringify(r));
});

test('proponerHechos: invariante de forma sobre una lista de frases reales', () => {
  const validas = ['identidad', 'preferencia', 'proyecto', 'idioma', 'correccion'];
  for (const frase of ['Me llamo Darío.', 'Prefiero el té.', 'Trabajo en C:\\web', 'Háblame en inglés.', 'No me gusta el café.']) {
    const p = v2.proponerHechos(frase);
    assertEqual(p.length, 1, 'una propuesta por frase: ' + frase);
    assertOk(p[0].texto.length > 0, 'texto no vacío');
    assertOk(p[0].etiquetas.length > 0, 'etiquetas no vacías');
    assertOk(
      p[0].etiquetas.every((e) => validas.includes(e)),
      'etiquetas dentro de la lista válida',
    );
    assertOk(p[0].confianza > 0 && p[0].confianza <= 1, 'confianza en (0, 1]');
  }
});

test('proponerHechos no se cae con tipos raros', () => {
  assertDeep(v2.proponerHechos(12345), []);
  assertDeep(v2.proponerHechos({ texto: 'me llamo Darío' }), []);
});

console.log('memoria-v2.js — mismo dato o cosa distinta (claves de hecho)');

/* El defecto que vigilan estas pruebas: «prefiero el té» y «prefiero el café» no son el
   mismo dato, pero la similitud léxica los daba por iguales (0,667) y el almacén se
   quedaba con uno: el otro desaparecía sin pasar por la papelera. La clave descompone el
   hecho en predicado + valor (+ polaridad) para poder distinguir «hablo del mismo dato»
   (mismo valor, aunque cambie la forma) de «hablo de otra cosa» (valor distinto) y de
   una contradicción (mismo objeto, polaridad invertida). */

test('la clave reconoce el predicado del hecho tal como lo guarda la memoria', () => {
  assertEqual(v2.claveHecho('El usuario se llama Darío').pred, 'nombre');
  assertEqual(v2.claveHecho('El usuario prefiere el té').pred, 'prefiere');
  assertEqual(v2.claveHecho('Al usuario le gusta el café').pred, 'gusto');
  assertEqual(v2.claveHecho('Al usuario no le gusta el café').pred, 'gusto');
  assertEqual(v2.claveHecho('El usuario trabaja en SAGITARI').pred, 'trabajo');
  assertEqual(v2.claveHecho('El proyecto del usuario es SAGITARI').pred, 'proyecto');
  assertEqual(v2.claveHecho('El usuario prefiere que le hable en inglés').pred, 'idioma');
  assertEqual(v2.claveHecho('El usuario vive en Madrid').pred, 'vive');
});

test('la clave entiende también la frase tal como la escribe el usuario', () => {
  assertEqual(v2.claveHecho('Me llamo Darío').pred, 'nombre');
  assertEqual(v2.claveHecho('Prefiero el té').pred, 'prefiere');
  assertEqual(v2.claveHecho('Vivo en Madrid').pred, 'vive');
  assertEqual(v2.claveHecho('Háblame en inglés').pred, 'idioma');
  assertEqual(v2.claveHecho('Trabajo en APPS').pred, 'trabajo');
  assertEqual(v2.claveHecho('No me gusta el café').pred, 'gusto');
});

test('una frase que no declara ningún dato no tiene clave', () => {
  assertEqual(v2.claveHecho('Nos vemos mañana por la tarde'), null);
  assertEqual(v2.claveHecho(''), null);
  assertEqual(v2.claveHecho(null), null);
});

test('el mismo valor escrito de otra forma es el mismo dato', () => {
  assertEqual(v2.relacionHechos('El usuario se llama Darío', 'El usuario se llama Dario'), 'mismo');
  assertEqual(v2.relacionHechos('Prefiero informes en PDF', 'Prefiero los informes en PDF'), 'mismo');
  assertEqual(v2.relacionHechos('Vivo en Madrid', 'El usuario vive en Madrid'), 'mismo');
});

test('un valor distinto NO es el mismo dato (el defecto de la fusión a ciegas)', () => {
  assertEqual(v2.relacionHechos('El usuario prefiere el té', 'El usuario prefiere el café'), 'cambia');
  assertEqual(v2.relacionHechos('Al usuario le gusta el té', 'No me gusta el café'), 'cambia');
  assertEqual(v2.relacionHechos('Vivo en Barcelona', 'Vivo en Madrid'), 'cambia');
  assertEqual(v2.relacionHechos('El usuario se llama Darío', 'Me llamo Ana'), 'cambia');
});

test('el mismo objeto con la polaridad invertida se contradice', () => {
  assertEqual(v2.relacionHechos('Al usuario le gusta el té', 'Al usuario no le gusta el té'), 'contradice');
  assertEqual(v2.relacionHechos('Al usuario no le gusta el café', 'Me gusta el café'), 'contradice');
});

test('predicados distintos no se comparan entre sí', () => {
  assertEqual(v2.relacionHechos('El usuario se llama Darío', 'El usuario prefiere el té'), 'otro');
  assertEqual(v2.relacionHechos('El usuario se llama Darío', 'Nos vemos mañana'), null);
  assertEqual(v2.relacionHechos('Nos vemos mañana', 'Hasta luego'), null);
});

test('cada predicado sabe si admite un solo valor o varios', () => {
  assertEqual(v2.claveHecho('Vivo en Madrid').unico, true, 'una persona vive en un sitio:');
  assertEqual(v2.claveHecho('Me llamo Darío').unico, true, 'un nombre:');
  assertEqual(v2.claveHecho('El usuario prefiere que le hable en inglés').unico, true, 'un idioma:');
  assertEqual(v2.claveHecho('Prefiero el té').unico, false, 'se pueden preferir varias cosas:');
  assertEqual(v2.claveHecho('Me gusta el café').unico, false, 'y gustar varias cosas:');
});

console.log('memoria-v2.js — olvido');

const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('un hecho reciente no se toca', () => {
  assertEqual(v2.decidirOlvido({ lastUsed: dias(1) }), null);
});

test('a los 180 días sin usarse baja a importancia baja', () => {
  const d = v2.decidirOlvido({ lastUsed: dias(200) });
  assertEqual(d && d.accion, 'baja');
});

test('a los 365 días sin usarse pasa a la papelera', () => {
  const d = v2.decidirOlvido({ lastUsed: dias(400) });
  assertEqual(d && d.accion, 'papelera');
});

test('lo que ya está en la papelera no vuelve a decidirse', () => {
  assertEqual(v2.decidirOlvido({ lastUsed: dias(400), papelera: dias(1) }), null);
});

test('sin lastUsed la antigüedad se mide desde la creación', () => {
  assertEqual(v2.decidirOlvido({ date: dias(200) }).accion, 'baja');
  assertEqual(v2.decidirOlvido({ date: dias(10) }), null);
});

test('las fronteras son exactas: 180 días ya baja, 365 ya es papelera', () => {
  const ahora = Date.now();
  const justo = (d) => new Date(ahora - d * 86400000).toISOString();
  assertEqual(v2.decidirOlvido({ lastUsed: justo(180) }, ahora).accion, 'baja');
  assertEqual(v2.decidirOlvido({ lastUsed: justo(364) }, ahora).accion, 'baja');
  assertEqual(v2.decidirOlvido({ lastUsed: justo(365) }, ahora).accion, 'papelera');
});

test('un hecho en papelera más de 30 días caduca', () => {
  assertOk(v2.expiradoEnPapelera({ papelera: dias(40) }));
  assertOk(!v2.expiradoEnPapelera({ papelera: dias(5) }));
  assertOk(!v2.expiradoEnPapelera({ papelera: null }));
});

test('las constantes de olvido son las del diseño', () => {
  assertEqual(v2.OLVIDO_BAJA_DIAS, 180);
  assertEqual(v2.OLVIDO_PAPELERA_DIAS, 365);
  assertEqual(v2.PAPELERA_DIAS, 30);
  assertEqual(v2.FUSION_UMBRAL, 0.5);
  assertEqual(v2.ESQUEMA, 2);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
