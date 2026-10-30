'use strict';

/* Tests de renderer/memoria-ui.js — la vista «Memoria» (fase 1).

   Dos partes: los constructores puros (htmlHecho/htmlPropuesta/htmlPapelera/htmlVacio/
   haceDe) sobre un DOM vacío, y la vista entera sobre el markup REAL de index.html
   cargado en jsdom, con los puentes de `window.sagitari` falsos apuntando lo que reciben.
   Los campos de un hecho son los de la v1 (text/date/lastUsed/uses/importance/origen/
   etiquetas/papelera) y la importancia se enseña en tres niveles: 1 / 0,6 / 0,3.

   Sin spawn (bloqueado en el sandbox de Windows): se ejecuta directo con node, y el
   runner del renderer espera la promesa que exporta `module.exports`. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(RAIZ, 'renderer', 'memoria-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'renderer', 'index.html'), 'utf8');

/* ---------- utilidades del arnés ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Las funciones que el renderer comparte entre scripts, inyectadas en la ventana. */
function globals(w, avisos, copiados) {
  w.esc = esc;
  w.$ = (s) => w.document.querySelector(s);
  w.$$ = (s) => Array.from(w.document.querySelectorAll(s));
  w.ic = () => '<svg class="ic"></svg>';
  w.vListEmpty = (icon, titulo, texto) => `<div class="listempty"><div class="le-mark">${icon}</div><b>${titulo}</b><p>${texto}</p></div>`;
  w.pintarFill = () => {};
  w.showToast = (t) => avisos.push(String(t));
  w.copyText = (t, msg) => copiados.push({ texto: t, msg });
  w.askConfirm = async () => true;
  w.openConversation = () => {};
}

const IDIOMA = ['i18n-es.js', 'i18n-en.js', 'i18n.js'].map((f) => fs.readFileSync(path.join(RAIZ, 'renderer', f), 'utf8'));
/** El renderer carga los diccionarios y i18n.js antes que cualquier vista: sin ellos la
    ventana no tiene idioma y las claves no se resuelven. */
function idioma(w) {
  for (const src of IDIOMA) w.eval(src);
}

/** Carga solo los constructores (DOM vacío): la parte pura del módulo. */
function cargarConstructores() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  globals(dom.window, [], []);
  idioma(dom.window);
  dom.window.eval(SRC);
  return dom.window.MemoriaUI;
}

/* Un hecho con la forma del almacén v1/v2. */
const AHORA = Date.now();
const iso = (dias) => new Date(AHORA - dias * 86400000).toISOString();
function hecho(extra) {
  return {
    id: 'h1',
    text: 'Me llamo Darío',
    date: iso(30),
    lastUsed: iso(3),
    uses: 12,
    importance: 0.6,
    origen: 'mensaje',
    origenTexto: 'me llamo Dario',
    etiquetas: ['identidad'],
    papelera: null,
    ...extra,
  };
}

/** Monta la app mínima: markup real + módulo + puentes falsos que apuntan las llamadas. */
function montar(opts = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const llamadas = [];
  const avisos = [];
  const copiados = [];
  const suscripciones = [];

  const api = {
    memoryList: async () => {
      llamadas.push({ canal: 'memoryList' });
      return opts.hechos || [];
    },
    memoryAdd: async (text, importance) => {
      llamadas.push({ canal: 'memoryAdd', text, importance });
      return { ok: true, id: 'nuevo1' };
    },
    memoryUpdate: async (id, patch) => {
      llamadas.push({ canal: 'memoryUpdate', id, patch });
      return { ok: true };
    },
    memoryRemove: async (id) => {
      llamadas.push({ canal: 'memoryRemove', id });
      return { ok: true };
    },
    memoryTrayList: async () => {
      llamadas.push({ canal: 'memoryTrayList' });
      return opts.bandeja || [];
    },
    memoryTrayAccept: async (id) => {
      llamadas.push({ canal: 'memoryTrayAccept', id });
      return { ok: true, entrada: { id: 'hecho-de-' + id } };
    },
    memoryTrayDiscard: async (id) => {
      llamadas.push({ canal: 'memoryTrayDiscard', id });
      return { ok: true };
    },
    memoryTrashList: async () => {
      llamadas.push({ canal: 'memoryTrashList' });
      return opts.papelera || [];
    },
    memoryTrashRestore: async (id) => {
      llamadas.push({ canal: 'memoryTrashRestore', id });
      return opts.restaurar !== undefined ? opts.restaurar : { ok: false, error: 'no está en la papelera' };
    },
    memoryTrashEmpty: async () => {
      llamadas.push({ canal: 'memoryTrashEmpty' });
      return { ok: true, borradas: 2 };
    },
    memoryExport: async () => {
      llamadas.push({ canal: 'memoryExport' });
      return { version: 2, exportado: iso(0), hechos: opts.hechos || [], papelera: [] };
    },
    memoryWipe: async () => {
      llamadas.push({ canal: 'memoryWipe' });
      return { ok: true, borrados: 3 };
    },
    memoryRestoreBackup: async () => {
      llamadas.push({ canal: 'memoryRestoreBackup' });
      /* La forma REAL del almacén cuando no hay ninguna copia (antes el doble devolvía
         «sin copia disponible», un texto que el backend no produce nunca). */
      return opts.copia || { ok: false, code: 'sin_copia', error: 'no hay ninguna copia que restaurar' };
    },
    habitsGet: async () => opts.habitos || {},
    habitsForget: async (categoria) => {
      llamadas.push({ canal: 'habitsForget', categoria });
      return { ok: true };
    },
    setSettings: async (patch) => {
      llamadas.push({ canal: 'setSettings', patch });
      return { ok: true };
    },
    onMemoriaNueva: (cb) => {
      suscripciones.push(cb);
      return () => {};
    },
    ...(opts.puentes || {}),
  };
  for (const k of opts.quitar || []) delete api[k];

  w.sagitari = api;
  w.CFG = { settings: { memoryLearn: true, memoryAutoSave: false, ...(opts.settings || {}) } };
  globals(w, avisos, copiados);
  idioma(w);
  w.eval(SRC);

  return {
    dom,
    w,
    M: w.MemoriaUI,
    llamadas,
    avisos,
    copiados,
    suscripciones,
    $(sel) {
      return w.document.querySelector(sel);
    },
    $$(sel) {
      return Array.from(w.document.querySelectorAll(sel));
    },
    async listo() {
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

const canal = (llamadas, name) => llamadas.filter((l) => l.canal === name);
const textoDe = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const espera = () => new Promise((r) => setTimeout(r, 5));

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
function assertIncludes(hay, needle, msg) {
  if (!String(hay == null ? '' : hay).includes(needle))
    throw new Error(`${msg || ''} ${JSON.stringify(hay)} no contiene ${JSON.stringify(needle)}`);
}

async function main() {
  const UI = cargarConstructores();

  console.log('memoria-ui.js — constructores');

  await test('htmlHecho pinta el texto, la procedencia y el uso', () => {
    const html = UI.htmlHecho({
      id: 'a1',
      text: 'El usuario se llama Darío',
      date: '2026-10-12T10:00:00.000Z',
      lastUsed: new Date().toISOString(),
      uses: 3,
      importance: 0.9,
      origen: 'mensaje',
      etiquetas: ['identidad'],
    });
    assertIncludes(html, 'El usuario se llama Darío', 'lleva el texto:');
    assertIncludes(html, 'de tu frase', 'lleva la procedencia:');
    assertIncludes(html, '3 veces', 'lleva el uso:');
    assertIncludes(html, 'identidad', 'lleva la etiqueta:');
    assertIncludes(html, 'data-imp="1"', 'los tres niveles de importancia:');
  });

  await test('htmlHecho escapa el texto (no inyecta HTML)', () => {
    const html = UI.htmlHecho({
      id: 'x',
      text: '<script>alert(1)</script>',
      date: '2026-01-01T00:00:00.000Z',
      lastUsed: '2026-01-01T00:00:00.000Z',
      importance: 0.5,
    });
    assertOk(!html.includes('<script>'), 'el texto va escapado');
  });

  await test('htmlHecho marca el nivel activo y ninguno más', () => {
    assertIncludes(UI.htmlHecho({ id: 'a', text: 'x', importance: 1 }), 'aria-checked="true"', 'el activo:');
    const alto = UI.htmlHecho({ id: 'a', text: 'x', importance: 1 });
    assertEqual((alto.match(/aria-checked="true"/g) || []).length, 1, 'solo uno activo:');
    assertIncludes(UI.htmlHecho({ id: 'a', text: 'x', importance: 0.3 }), 'data-imp="0.3"', 'baja:');
    assertIncludes(UI.htmlHecho({ id: 'a', text: 'x', importance: 0.6 }), 'data-imp="0.6"', 'normal:');
  });

  await test('htmlHecho no inventa un uso cuando no se ha usado nunca', () => {
    const html = UI.htmlHecho({ id: 'n1', text: 'Un recuerdo sin usar', date: iso(400), lastUsed: iso(380), uses: 0, importance: 0.6 });
    assertIncludes(html, 'todavía no lo he usado', 'el hecho sin uso:');
    assertOk(!/\d+ veces/.test(html), 'no debe decir «0 veces» junto a una fecha de uso');
  });

  await test('htmlPropuesta pinta los tres botones y el texto literal', () => {
    const html = UI.htmlPropuesta({
      id: 'p1',
      texto: 'El usuario se llama Darío',
      motivo: 'parece tu nombre',
      origenTexto: 'me llamo Darío',
    });
    assertIncludes(html, 'data-acc="guardar"');
    assertIncludes(html, 'data-acc="editar"');
    assertIncludes(html, 'data-acc="descartar"');
    assertIncludes(html, 'me llamo Darío', 'enseña la frase literal:');
  });

  await test('htmlPapelera trae el botón de restaurar', () => {
    assertIncludes(UI.htmlPapelera({ id: 't1', text: 'Dato viejo', papelera: new Date().toISOString() }), 'data-acc="restaurar"');
  });

  await test('htmlVacio explica qué hacer', () => {
    const html = UI.htmlVacio('Aún no sé nada de ti', 'Deja que aprenda de lo que le cuentas.');
    assertIncludes(html, 'Aún no sé nada de ti');
    assertIncludes(html, 'Deja que aprenda');
  });

  await test('haceDe describe el último uso en lenguaje humano', () => {
    assertEqual(UI.haceDe(new Date().toISOString()), 'hoy');
    assertEqual(UI.haceDe(new Date(Date.now() - 86400000).toISOString()), 'ayer');
    assertEqual(UI.haceDe(new Date(Date.now() - 3 * 86400000).toISOString()), 'hace 3 días');
    assertEqual(UI.haceDe(new Date(Date.now() - 200 * 86400000).toISOString()), 'hace 6 meses');
    assertEqual(UI.haceDe(null), 'nunca');
  });

  await test('procedencia no pinta una fecha ilegible como «Invalid Date»', () => {
    /* Un fichero migrado o editado a mano puede traer `date: "ayer"`: la ficha del hecho
       no puede quedar como «de tu frase del Invalid Date». */
    assertEqual(UI.procedencia({ origen: 'mensaje', date: 'ayer' }), 'de tu frase');
    assertEqual(UI.procedencia({ origen: 'mensaje', date: '2026-13-45' }), 'de tu frase');
    assertOk(!/Invalid/.test(UI.procedencia({ origen: 'mensaje', date: 'ayer' })));
    assertOk(
      /^de tu frase del /.test(UI.procedencia({ origen: 'mensaje', date: '2026-10-12T10:00:00.000Z' })),
      'una fecha buena sigue saliendo:',
    );
    assertOk(!/Invalid/.test(UI.htmlHecho({ id: 'x', text: 'Un recuerdo', date: 'ayer', importance: 0.5 })));
  });

  console.log('Memoria — markup y estado de la vista');

  await test('index.html trae las cinco secciones, en su orden', () => {
    const { w } = montar();
    const v = w.document.querySelector('#view-memory');
    assertOk(v, 'falta #view-memory');
    const titulos = Array.from(v.querySelectorAll('h3.memsec-t')).map((h) => textoDe(h));
    const orden = ['Lo que sé de ti', 'Recién aprendido', 'Cómo trabajas conmigo', 'Buscar en lo que hemos hablado', 'Papelera'];
    assertEqual(titulos.length, orden.length, `secciones: ${titulos.join(' · ')}`);
    titulos.forEach((t, i) => assertOk(t.startsWith(orden[i]), `la sección ${i + 1} debería ser «${orden[i]}» y es «${t}»`));
  });

  await test('los contenedores y los controles del pie existen con su nombre', () => {
    const { w } = montar();
    for (const id of [
      'memList',
      'memFiltro',
      'memSearch',
      'memBandeja',
      'memHabitos',
      'memBuscar',
      'memPapelera',
      'memExport',
      'memWipe',
      'swMemLearn',
      'swMemAuto',
      'memOlvidarTodo',
    ]) {
      assertOk(w.document.getElementById(id), `falta #${id}`);
    }
    assertOk(w.document.querySelector('#view-memory h1'), 'la vista no tiene h1');
  });

  await test('el módulo expone los constructores y los pintores de sección', () => {
    const { M } = montar();
    for (const f of [
      'renderMemoria',
      'htmlHecho',
      'htmlPropuesta',
      'htmlPapelera',
      'htmlVacio',
      'haceDe',
      'procedencia',
      'pintarHechos',
      'pintarBandeja',
      'pintarHabitos',
      'pintarPapelera',
    ]) {
      assertEqual(typeof M[f], 'function', `${f} debe ser una función:`);
    }
  });

  console.log('Memoria — «Lo que sé de ti»');

  await test('pinta un registro por hecho con su texto', async () => {
    const app = montar({ hechos: [hecho(), hecho({ id: 'h2', text: 'Trabajo en APPS' })] });
    await app.M.renderMemoria();
    const items = app.$$('#memList .memitem');
    assertEqual(items.length, 2, 'número de tarjetas:');
    assertIncludes(textoDe(items[0]), 'Me llamo Darío');
    assertIncludes(textoDe(items[1]), 'Trabajo en APPS');
  });

  await test('la ficha dice de dónde salió y cuándo se usó', async () => {
    const app = montar({ hechos: [hecho()] });
    await app.M.renderMemoria();
    const md = textoDe(app.$('#memList .memitem .md'));
    assertIncludes(md, 'de tu frase del', 'la procedencia:');
    assertIncludes(md, 'usado hace 3 días, 12 veces', 'el uso:');
  });

  await test('cambiar la importancia guarda con memoryUpdate (0..1)', async () => {
    const app = montar({ hechos: [hecho({ id: 'hx' })] });
    await app.M.renderMemoria();
    app.$('#memList .memitem [data-imp="1"]').click();
    await espera();
    const u = canal(app.llamadas, 'memoryUpdate')[0];
    assertOk(u, 'no llamó a memoryUpdate');
    assertEqual(u.id, 'hx');
    assertEqual(u.patch.importance, 1);
  });

  await test('editar en el sitio: el texto se guarda tal cual se escribió', async () => {
    const app = montar({ hechos: [hecho({ id: 'he1' })] });
    await app.M.renderMemoria();
    app.$('#memList [data-edit]').click();
    const txt = app.$('#memList .memtxt');
    assertEqual(txt.getAttribute('contenteditable'), 'true', 'el texto se vuelve editable:');
    txt.textContent = 'Me llamo Darío y prefiero respuestas cortas';
    app.$('#memList [data-edit]').click();
    await espera();
    const u = canal(app.llamadas, 'memoryUpdate')[0];
    assertOk(u, 'no llamó a memoryUpdate');
    assertEqual(u.patch.text, 'Me llamo Darío y prefiero respuestas cortas');
  });

  await test('vaciar el texto editado no guarda nada y lo avisa', async () => {
    const app = montar({ hechos: [hecho({ id: 'he1', text: 'Un recuerdo' })] });
    await app.M.renderMemoria();
    app.$('#memList [data-edit]').click();
    app.$('#memList .memtxt').textContent = '   ';
    app.$('#memList [data-edit]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryUpdate').length, 0, 'no debe guardar un recuerdo vacío:');
    assertOk(
      app.avisos.some((a) => a.includes('sin texto')),
      `aviso de recuerdo vacío (avisos: ${app.avisos.join(' | ')})`,
    );
  });

  await test('borrar llama a memoryRemove y ofrece deshacer en la sección', async () => {
    const app = montar({ hechos: [hecho({ id: 'hb', text: 'Uso siempre la carpeta APPS' })] });
    await app.M.renderMemoria();
    app.$('#memList [data-del]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryRemove')[0].id, 'hb');
    assertOk(app.$('#memUndoBox [data-deshacer]'), 'no aparece la acción de deshacer');
    assertIncludes(textoDe(app.$('#memUndoBox')), 'APPS', 'el aviso recuerda qué se olvidó:');
  });

  await test('deshacer recupera el hecho de la papelera cuando el borrado fue suave', async () => {
    const app = montar({ hechos: [hecho({ id: 'hb' })], restaurar: { ok: true, memory: hecho({ id: 'hb' }) } });
    await app.M.renderMemoria();
    app.$('#memList [data-del]').click();
    await espera();
    app.$('#memUndoBox [data-deshacer]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrashRestore')[0].id, 'hb');
    assertEqual(canal(app.llamadas, 'memoryAdd').length, 0, 'no debe volver a escribirlo si se pudo restaurar:');
  });

  await test('deshacer vuelve a escribir el hecho si ya no estaba en la papelera', async () => {
    const app = montar({ hechos: [hecho({ id: 'hb', text: 'Me gusta el té' })] });
    await app.M.renderMemoria();
    app.$('#memList [data-del]').click();
    await espera();
    app.$('#memUndoBox [data-deshacer]').click();
    await espera();
    const a = canal(app.llamadas, 'memoryAdd')[0];
    assertOk(a, 'no volvió a añadir el hecho');
    assertEqual(a.text, 'Me gusta el té');
  });

  await test('el filtro por etiqueta deja solo los hechos de esa etiqueta', async () => {
    const app = montar({
      hechos: [hecho({ id: 'a', etiquetas: ['trabajo'] }), hecho({ id: 'b', text: 'Vivo en Madrid', etiquetas: ['personal'] })],
    });
    await app.M.renderMemoria();
    assertEqual(app.$$('#memList .memitem').length, 2, 'sin filtro:');
    app.$('#memFiltro [data-tag="trabajo"]').click();
    await espera();
    const items = app.$$('#memList .memitem');
    assertEqual(items.length, 1, 'con filtro:');
    assertEqual(items[0].dataset.id, 'a');
    assertIncludes(textoDe(app.$('#memFichaCuenta')), '1 de 2', 'el recuento del filtro:');
  });

  await test('el buscador propio de la ficha filtra por texto', async () => {
    const app = montar({ hechos: [hecho({ id: 'a' }), hecho({ id: 'b', text: 'Vivo en Madrid' })] });
    await app.M.renderMemoria();
    const caja = app.$('#memSearch');
    caja.value = 'madrid';
    caja.dispatchEvent(new app.w.Event('input', { bubbles: true }));
    await espera();
    const items = app.$$('#memList .memitem');
    assertEqual(items.length, 1);
    assertEqual(items[0].dataset.id, 'b');
  });

  await test('añadir un hecho a mano pasa por memoryAdd', async () => {
    const app = montar({ hechos: [] });
    await app.M.renderMemoria();
    app.$('#memInput').value = 'Prefiero respuestas cortas';
    app.$('#memAdd').click();
    await espera();
    const a = canal(app.llamadas, 'memoryAdd')[0];
    assertOk(a, 'no llamó a memoryAdd');
    assertEqual(a.text, 'Prefiero respuestas cortas');
    assertEqual(app.$('#memInput').value, '', 'el campo se vacía:');
  });

  await test('estado vacío de la ficha: explica qué es, no un panel en blanco', async () => {
    const app = montar({ hechos: [] });
    await app.M.renderMemoria();
    const vacio = app.$('#memList .listempty');
    assertOk(vacio, 'falta el estado vacío');
    assertIncludes(textoDe(vacio), 'Aún no sé nada de ti');
    assertIncludes(textoDe(vacio), 'Escribe un recuerdo');
  });

  await test('error de lectura del almacén: lo dice y ofrece restaurar copia', async () => {
    const app = montar({
      puentes: {
        memoryList: async () => {
          throw new Error('memory.json ilegible');
        },
      },
    });
    await app.M.renderMemoria();
    const t = textoDe(app.$('#memList'));
    assertIncludes(t, 'No pude leer tu memoria', 'el error se explica en humano:');
    assertIncludes(t, 'memory.json', 'dice de qué fichero habla:');
    assertOk(app.$('#memList [data-copiar-restaurar]'), 'falta la salida «Restaurar copia»');
  });

  await test('restaurar copia repone el almacén y recarga la vista', async () => {
    let lecturas = 0;
    const app = montar({
      copia: { ok: true, restaurado: 2, origen: 'memory.json.bak' },
      puentes: {
        memoryList: async () => {
          lecturas++;
          if (lecturas === 1) throw new Error('memory.json ilegible');
          return [hecho()];
        },
      },
    });
    await app.M.renderMemoria();
    app.$('#memList [data-copiar-restaurar]').click();
    await espera();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryRestoreBackup').length, 1, 'llamadas a memoryRestoreBackup:');
    assertOk(lecturas > 1, 'tras restaurar debe releer la memoria');
    assertEqual(app.$$('#memList .memitem').length, 1, 'los hechos restaurados:');
    assertOk(
      app.avisos.some((a) => a.includes('restaurada')),
      `el aviso de éxito (avisos: ${app.avisos.join(' | ')})`,
    );
  });

  await test('sin copia disponible lo dice con el motivo real, sin fingir un éxito', async () => {
    const app = montar({
      puentes: {
        memoryList: async () => {
          throw new Error('memory.json ilegible');
        },
        /* El almacén real responde así cuando no hay ninguna copia que restaurar. */
        memoryRestoreBackup: async () => ({ ok: false, code: 'sin_copia', error: 'no hay ninguna copia que restaurar' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memList [data-copiar-restaurar]').click();
    await espera();
    const motivo = textoDe(app.$('#memList [data-motivo]'));
    assertIncludes(motivo, 'memory.json', 'explica dónde vive el fichero:');
    assertIncludes(motivo, 'copia', 'y por qué no hay copia:');
    assertEqual(app.avisos.filter((a) => a.includes('restaurada')).length, 0, 'ningún aviso de éxito falso:');
  });

  await test('un fallo distinto al restaurar se cuenta con su motivo, no con el texto de «sin copia»', async () => {
    const app = montar({
      puentes: {
        memoryList: async () => {
          throw new Error('memory.json ilegible');
        },
        memoryRestoreBackup: async () => ({ ok: false, error: 'la copia no se pudo leer: JSON roto' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memList [data-copiar-restaurar]').click();
    await espera();
    const motivo = textoDe(app.$('#memList [data-motivo]'));
    assertIncludes(motivo, 'la copia no se pudo leer', 'el motivo real:');
    assertOk(!motivo.includes('todavía no existe'), 'no se disfraza de «no hay copia»:');
  });

  console.log('Memoria — «Recién aprendido»');

  await test('la bandeja lista las propuestas con su frase literal y el motivo', async () => {
    const app = montar({
      bandeja: [
        {
          id: 'p1',
          texto: 'El usuario se llama Darío',
          origenTexto: 'me llamo Dario',
          motivo: 'parece tu nombre',
          etiquetas: ['identidad'],
        },
      ],
    });
    await app.M.renderMemoria();
    const items = app.$$('#memBandeja .memitem');
    assertEqual(items.length, 1);
    const t = textoDe(items[0]);
    assertIncludes(t, 'El usuario se llama Darío', 'el hecho propuesto:');
    assertIncludes(t, 'me llamo Dario', 'la frase literal de la que salió:');
    assertIncludes(t, 'parece tu nombre', 'el motivo:');
  });

  await test('la bandeja tiene las tres acciones', async () => {
    const app = montar({ bandeja: [{ id: 'p1', texto: 'Algo' }] });
    await app.M.renderMemoria();
    for (const a of ['guardar', 'editar', 'descartar']) assertOk(app.$(`#memBandeja [data-acc="${a}"]`), `falta la acción ${a}`);
  });

  await test('guardar una propuesta tal cual la acepta', async () => {
    const app = montar({ bandeja: [{ id: 'p1', texto: 'Vivo en Madrid' }] });
    await app.M.renderMemoria();
    app.$('#memBandeja [data-acc="guardar"]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrayAccept')[0].id, 'p1');
    assertEqual(canal(app.llamadas, 'memoryTrayDiscard').length, 0, 'sin corregirla, no se descarta:');
  });

  await test('si el usuario corrige el texto, el hecho conserva sus etiquetas y su origen', async () => {
    const app = montar({
      bandeja: [{ id: 'p1', texto: 'El usuario se llama Dario', origenTexto: 'me llamo Dario', etiquetas: ['identidad'] }],
      puentes: {
        memoryTrayAccept: async (id) => {
          app.llamadas.push({ canal: 'memoryTrayAccept', id });
          return { ok: true, memory: { id: 'hecho-de-' + id, etiquetas: ['identidad'], origenTexto: 'me llamo Dario' } };
        },
      },
    });
    await app.M.renderMemoria();
    app.$('#memBandeja [data-acc="editar"]').click();
    const txt = app.$('#memBandeja .memtxt');
    assertEqual(txt.getAttribute('contenteditable'), 'true', 'el texto se vuelve editable:');
    txt.textContent = 'El usuario se llama Darío';
    app.$('#memBandeja [data-acc="guardar"]').click();
    await espera();
    /* Se acepta la PROPUESTA (es la que lleva las etiquetas y la frase original) y luego se
       corrige el texto del hecho ya guardado: crear uno nuevo por el camino del «añadir»
       perdía la etiqueta «identidad» (y con ella la inyección siempre en el prompt). */
    assertEqual(canal(app.llamadas, 'memoryTrayAccept')[0].id, 'p1', 'se acepta la propuesta:');
    const u = canal(app.llamadas, 'memoryUpdate')[0];
    assertOk(u, 'y se corrige el texto del hecho guardado');
    assertEqual(u.id, 'hecho-de-p1', 'sobre el hecho que acaba de entrar:');
    assertEqual(u.patch.text, 'El usuario se llama Darío');
    assertEqual(canal(app.llamadas, 'memoryAdd').length, 0, 'no se crea un hecho nuevo sin etiquetas:');
    assertEqual(canal(app.llamadas, 'memoryTrayDiscard').length, 0, 'ni se descarta la propuesta:');
  });

  await test('descartar una propuesta la tira', async () => {
    const app = montar({ bandeja: [{ id: 'p9', texto: 'Algo' }] });
    await app.M.renderMemoria();
    app.$('#memBandeja [data-acc="descartar"]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrayDiscard')[0].id, 'p9');
  });

  await test('bandeja vacía: lo dice y explica de dónde salen las propuestas', async () => {
    const app = montar({ bandeja: [] });
    await app.M.renderMemoria();
    const t = textoDe(app.$('#memBandeja'));
    assertIncludes(t, 'Nada nuevo por aprobar');
    assertIncludes(t, 'aparecerá aquí');
  });

  await test('una propuesta nueva refresca la bandeja sola (onMemoriaNueva)', async () => {
    const app = montar({ bandeja: [] });
    await app.M.renderMemoria();
    assertEqual(app.suscripciones.length, 1, 'suscripciones a onMemoriaNueva:');
    app.$('#view-memory').classList.add('on');
    const antes = canal(app.llamadas, 'memoryTrayList').length;
    app.suscripciones[0]({ id: 'pN', texto: 'Nuevo hecho' });
    await espera();
    assertOk(canal(app.llamadas, 'memoryTrayList').length > antes, 'la bandeja no se refrescó');
  });

  console.log('Memoria — «Cómo trabajas conmigo»');

  await test('agrupa los hábitos en lenguaje humano con su recuento', async () => {
    const app = montar({
      habitos: { sites: [{ name: 'github.com', count: 9 }], folders: [{ name: 'APPS', count: 4 }], confirms: { approved: 31, denied: 2 } },
    });
    await app.M.renderMemoria();
    const t = textoDe(app.$('#memHabitos'));
    assertIncludes(t, 'github.com', 'las webs:');
    assertIncludes(t, 'APPS', 'las carpetas:');
    assertIncludes(t, '31', 'las aprobaciones:');
    assertIncludes(t, '9 usos', 'el recuento del grupo:');
  });

  await test('cada grupo tiene su «olvidar» y viaja en español', async () => {
    const app = montar({
      habitos: {
        tools: [{ name: 'read_file', count: 3 }],
        apps: [{ name: 'spotify', count: 2 }],
        commands: [{ name: 'git', count: 5 }],
        folders: [{ name: 'APPS', count: 4 }],
        sites: [{ name: 'github.com', count: 9 }],
        modes: { act: 7 },
        confirms: { approved: 31, denied: 2 },
      },
    });
    await app.M.renderMemoria();
    const claves = app.$$('#memHabitos [data-olvidar]').map((b) => b.dataset.olvidar);
    assertEqual(claves.join(','), 'herramientas,aplicaciones,comandos,carpetas,webs,modos,permisos');
    app.$('#memHabitos [data-olvidar="webs"]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'habitsForget')[0].categoria, 'webs');
  });

  await test('«olvidar todo lo observado» está en el pie y confirma antes', async () => {
    const app = montar({ habitos: { sites: [{ name: 'github.com', count: 9 }] } });
    await app.M.renderMemoria();
    app.$('#memOlvidarTodo').click();
    await espera();
    assertEqual(canal(app.llamadas, 'habitsForget')[0].categoria, 'todo');
  });

  await test('sin hábitos observados lo dice, no pinta un panel vacío', async () => {
    const app = montar({ habitos: {} });
    await app.M.renderMemoria();
    assertIncludes(textoDe(app.$('#memHabitos')), 'Todavía no he observado nada');
  });

  console.log('Memoria — «Buscar en lo que hemos hablado»');

  await test('sin índice de conversaciones la caja queda desactivada y lo explica', async () => {
    const app = montar();
    await app.M.renderMemoria();
    assertEqual(app.$('#memBuscar').disabled, true, 'la caja desactivada:');
    assertEqual(app.$('#memBuscarBtn').disabled, true, 'el botón desactivado:');
    assertIncludes(textoDe(app.$('#memBuscarNota')), 'fase 3', 'la línea que lo explica:');
  });

  console.log('Memoria — Papelera');

  await test('la papelera lista lo olvidado y lo restaura', async () => {
    const app = montar({ papelera: [{ id: 't1', text: 'Dato viejo', papelera: iso(3) }] });
    await app.M.renderMemoria();
    const item = app.$('#memPapelera .memitem');
    assertOk(item, 'no listó la papelera');
    assertIncludes(textoDe(item), 'Dato viejo');
    assertIncludes(textoDe(item), 'en papelera desde hace 3 días', 'desde cuándo:');
    item.querySelector('[data-acc="restaurar"]').click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrashRestore')[0].id, 't1');
  });

  await test('vaciar la papelera pide una segunda pulsación antes de borrar', async () => {
    const app = montar({ papelera: [{ id: 't1', text: 'Dato viejo', papelera: iso(3) }] });
    await app.M.renderMemoria();
    const b = app.$('#memPapeleraVaciar');
    assertOk(b, 'falta el botón de vaciar');
    b.click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrashEmpty').length, 0, 'no debe vaciar al primer clic:');
    assertIncludes(textoDe(b), 'Pulsa otra vez', 'el botón avisa en la segunda:');
    b.click();
    await espera();
    assertEqual(canal(app.llamadas, 'memoryTrashEmpty').length, 1, 'al segundo clic:');
  });

  await test('papelera vacía lo dice', async () => {
    const app = montar({ papelera: [] });
    await app.M.renderMemoria();
    assertIncludes(textoDe(app.$('#memPapelera')), 'La papelera está vacía');
    assertEqual(
      app.$('#memPapeleraVaciar').hidden || app.$('#memPapeleraBarra').hidden,
      true,
      'sin nada que vaciar, el botón no se ofrece:',
    );
  });

  console.log('Memoria — pie: aprendizaje, exportar, olvidarlo todo');

  await test('el interruptor de aprendizaje refleja los ajustes y los guarda', async () => {
    const app = montar({ settings: { memoryLearn: true } });
    await app.M.renderMemoria();
    const sw = app.$('#swMemLearn');
    assertEqual(sw.getAttribute('aria-checked'), 'true', 'aprende por defecto:');
    sw.click();
    await espera();
    assertEqual(canal(app.llamadas, 'setSettings')[0].patch.memoryLearn, false);
    assertEqual(sw.getAttribute('aria-checked'), 'false', 'estado tras pulsar:');
  });

  await test('el interruptor «guardar sin preguntar» guarda memoryAutoSave', async () => {
    const app = montar({ settings: { memoryAutoSave: false } });
    await app.M.renderMemoria();
    const sw = app.$('#swMemAuto');
    assertEqual(sw.getAttribute('aria-checked'), 'false', 'no guarda solo por defecto:');
    sw.click();
    await espera();
    assertEqual(canal(app.llamadas, 'setSettings')[0].patch.memoryAutoSave, true);
  });

  await test('el interruptor deja CFG al día: al volver a la vista no se pinta con el valor viejo', async () => {
    const app = montar({ settings: { memoryLearn: true } });
    await app.M.renderMemoria();
    app.$('#swMemLearn').click();
    await espera();
    assertEqual(app.w.CFG.settings.memoryLearn, false, 'CFG se actualiza al apagarlo:');
    /* Al volver a la vista (goto('memory') → renderMemoria) el interruptor se repinta desde
       CFG: si CFG no se hubiera tocado, aparecería encendido con el ajuste apagado. */
    await app.M.renderMemoria();
    assertEqual(app.$('#swMemLearn').getAttribute('aria-checked'), 'false', 'sigue apagado al volver:');
    app.$('#swMemLearn').click();
    await espera();
    assertEqual(
      canal(app.llamadas, 'setSettings')
        .map((l) => l.patch.memoryLearn)
        .join(','),
      'false,true',
      'y se puede volver a encender (los dos clics persisten lo que dice la pantalla):',
    );
  });

  await test('el interruptor toma el valor que devuelve el canal (lo que de verdad se guardó)', async () => {
    const app = montar({
      settings: { memoryAutoSave: false },
      puentes: { setSettings: async () => ({ memoryAutoSave: false, saveError: 'no se pudo guardar' }) },
    });
    await app.M.renderMemoria();
    app.$('#swMemAuto').click();
    await espera();
    assertEqual(app.w.CFG.settings.memoryAutoSave, false, 'manda lo persistido, no lo pulsado:');
    assertEqual(app.$('#swMemAuto').getAttribute('aria-checked'), 'false', 'y la pantalla lo refleja:');
  });

  await test('el pie explica qué hace y qué no (sin prometer privacidad falsa)', async () => {
    const app = montar();
    await app.M.renderMemoria();
    const pie = textoDe(app.$('.mempie'));
    /* El pie decía «No sale nada de este equipo… y no viaja a ningún servicio», pero los
       recuerdos y los hábitos viajan en el prompt de cada turno: el límite que se cuenta
       tiene que ser el de verdad. */
    assertIncludes(pie, 'vive en un fichero local', 'el límite verdadero:');
    assertIncludes(pie, 'se envían al modelo', 'lo que sí sale del equipo:');
    assertOk(!/no viaja a ningún servicio/.test(pie), 'ya no promete que no sale nada:');
    assertIncludes(pie, 'sin tu aprobación', 'la puerta de aprobación:');
  });

  await test('exportar mi memoria copia el volcado legible', async () => {
    const app = montar();
    await app.M.renderMemoria();
    app.$('#memExport').click();
    await espera();
    assertOk(canal(app.llamadas, 'memoryExport')[0], 'no llamó a memoryExport');
    assertOk(app.copiados.length, 'no copió el volcado');
    assertIncludes(app.copiados[0].texto, '"version": 2', 'el JSON legible:');
  });

  await test('«Olvídalo todo» exige escribir OLVIDAR', async () => {
    const app = montar();
    await app.M.renderMemoria();
    app.$('#memWipe').click();
    await espera();
    const caja = app.$('#memWipeBox');
    assertOk(caja && !caja.hidden, 'la confirmación debe quedar visible');
    const ir = app.$('#memWipeGo');
    assertEqual(ir.disabled, true, 'sin escribir nada el botón está apagado:');
    const escribir = (v) => {
      app.$('#memWipeInput').value = v;
      app.$('#memWipeInput').dispatchEvent(new app.w.Event('input', { bubbles: true }));
    };
    escribir('olvidar');
    await espera();
    assertEqual(ir.disabled, true, 'en minúsculas tampoco vale:');
    escribir('OLVIDAR');
    await espera();
    assertEqual(ir.disabled, false, 'con OLVIDAR se habilita:');
    ir.click();
    await espera();
    assertOk(canal(app.llamadas, 'memoryWipe')[0], 'no llamó a memoryWipe');
  });

  await test('restaurar de la papelera no canta éxito si el almacén lo rechaza', async () => {
    const app = montar({
      papelera: [{ id: 't1', text: 'Dato viejo', papelera: iso(3) }],
      puentes: {
        memoryTrashRestore: async () => ({ ok: false, error: 'recuerdo no encontrado' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memPapelera [data-acc="restaurar"]').click();
    await espera();
    assertOk(
      app.avisos.some((a) => a.includes('No se pudo')),
      `debe avisar del fallo (avisos: ${app.avisos.join(' | ')})`,
    );
    assertEqual(app.avisos.filter((a) => /restaurado/i.test(a)).length, 0, 'sin aviso de éxito falso:');
  });

  await test('vaciar la papelera no dice que la vació cuando el canal la rechazó', async () => {
    const app = montar({
      papelera: [{ id: 't1', text: 'Dato viejo', papelera: iso(3) }],
      puentes: {
        memoryTrashEmpty: async () => ({ ok: false, error: 'almacén no disponible' }),
      },
    });
    await app.M.renderMemoria();
    const b = app.$('#memPapeleraVaciar');
    b.click();
    await espera();
    b.click();
    await espera();
    assertOk(
      app.avisos.some((a) => a.includes('No se pudo')),
      `debe avisar del fallo (avisos: ${app.avisos.join(' | ')})`,
    );
    assertEqual(app.avisos.filter((a) => /vaciada/i.test(a)).length, 0, 'sin «Papelera vaciada» falso:');
  });

  await test('«olvídalo todo» no canta éxito si el almacén lo rechaza', async () => {
    const app = montar({
      puentes: {
        memoryWipe: async () => ({ ok: false, error: 'almacén no disponible' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memWipe').click();
    app.$('#memWipeInput').value = 'OLVIDAR';
    app.$('#memWipeInput').dispatchEvent(new app.w.Event('input', { bubbles: true }));
    app.$('#memWipeGo').click();
    await espera();
    assertOk(
      app.avisos.some((a) => a.includes('No se pudo')),
      `debe avisar del fallo (avisos: ${app.avisos.join(' | ')})`,
    );
    assertEqual(app.avisos.filter((a) => /olvidado todo/i.test(a)).length, 0, 'sin éxito falso:');
    assertEqual(app.$('#memWipeBox').hidden, false, 'la confirmación sigue abierta para reintentar:');
  });

  await test('exportar no copia un error al portapapeles como si fuera la memoria', async () => {
    const app = montar({
      puentes: {
        memoryExport: async () => ({ ok: false, error: 'almacén no disponible' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memExport').click();
    await espera();
    assertEqual(app.copiados.length, 0, 'no se copia nada al portapapeles:');
    assertOk(
      app.avisos.some((a) => a.includes('No se pudo exportar')),
      `debe avisar del fallo (avisos: ${app.avisos.join(' | ')})`,
    );
  });

  await test('añadir a mano avisa si el almacén no pudo guardarlo', async () => {
    const app = montar({
      puentes: {
        memoryAdd: async () => ({ ok: false, error: 'almacén no disponible' }),
      },
    });
    await app.M.renderMemoria();
    app.$('#memInput').value = 'Un recuerdo';
    app.$('#memAdd').click();
    await espera();
    assertOk(
      app.avisos.some((a) => a.includes('No se pudo')),
      `debe avisar del fallo (avisos: ${app.avisos.join(' | ')})`,
    );
    assertEqual(app.avisos.filter((a) => /Añadido/.test(a)).length, 0, 'sin éxito falso:');
  });

  console.log('Memoria — estados y accesibilidad');

  await test('cargando: la vista lo dice antes de tener datos', async () => {
    let resolver = null;
    const app = montar({
      puentes: {
        memoryList: () =>
          new Promise((r) => {
            resolver = r;
          }),
      },
    });
    const p = app.M.renderMemoria();
    assertIncludes(textoDe(app.$('#memList')), 'Cargando', 'el estado de carga:');
    resolver([hecho()]);
    await p;
    assertEqual(app.$$('#memList .memitem').length, 1, 'tras cargar:');
  });

  await test('los controles de la vista tienen nombre accesible', async () => {
    const app = montar({
      hechos: [hecho()],
      bandeja: [{ id: 'p1', texto: 'Algo' }],
      papelera: [{ id: 't1', text: 'Viejo', papelera: iso(1) }],
      habitos: { sites: [{ name: 'x.com', count: 3 }] },
    });
    await app.M.renderMemoria();
    const sinNombre = app
      .$$('#view-memory button, #view-memory input')
      .filter((el) => {
        const id = el.getAttribute('id');
        if (id && app.$(`label[for="${id}"]`)) return false;
        return !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim());
      })
      .map((el) => el.outerHTML.slice(0, 90));
    assertEqual(sinNombre.length, 0, `controles sin nombre: ${sinNombre.join(' | ')}`);
  });

  await test('la vista no inventa puentes: todo lo que llama existe en preload', () => {
    const preload = fs.readFileSync(path.join(RAIZ, 'main', 'preload.js'), 'utf8');
    const citados = [...new Set([...SRC.matchAll(/window\.sagitari\.([a-zA-Z]+)/g)].map((m) => m[1]))];
    assertOk(citados.length >= 10, `no encontré llamadas que revisar (${citados.length})`);
    const inventados = citados.filter((c) => !preload.includes(c + ':'));
    assertEqual(inventados.join(','), '', 'puentes que no existen en main/preload.js:');
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

module.exports = main();
