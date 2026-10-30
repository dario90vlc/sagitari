'use strict';
/* La pasada del DOM: marca → texto. Se prueba contra el index.html REAL, que es el que
   se rompe si una clave no existe o si el atributo se escribe mal. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pasaron = 0;
let fallaron = 0;
function check(nombre, fn) {
  try {
    fn();
    pasaron++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallaron++;
    console.log('  FAIL ' + nombre + ' — ' + e.message);
  }
}
const eq = (a, b, msg) => {
  if (a !== b) throw new Error((msg || '') + ' esperado ' + JSON.stringify(b) + ', obtenido ' + JSON.stringify(a));
};

const RAIZ = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'renderer', 'index.html'), 'utf8');

/** Los dos diccionarios del renderer, ya evaluados (se cargan como globales). */
function diccionarios() {
  const cargar = (f) => {
    const w = new JSDOM('', { runScripts: 'outside-only' }).window;
    w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', f), 'utf8'));
    return w.I18N_ES ? w.I18N_ES : w.I18N_EN;
  };
  return { es: cargar('i18n-es.js'), en: cargar('i18n-en.js') };
}

check('idioma: aplicarDOM rellena texto y atributos, y no toca lo que no lleva marca', () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-es.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-en.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n.js'), 'utf8'));
  const el = w.document.createElement('span');
  el.setAttribute('data-i18n', 'prueba.texto');
  w.document.body.appendChild(el);
  const ph = w.document.createElement('input');
  ph.setAttribute('data-i18n-ph', 'prueba.ph');
  w.document.body.appendChild(ph);
  const tt = w.document.createElement('button');
  tt.setAttribute('data-i18n-title', 'prueba.title');
  w.document.body.appendChild(tt);
  const aria = w.document.createElement('button');
  aria.setAttribute('data-i18n-aria', 'prueba.aria');
  w.document.body.appendChild(aria);
  // Un nodo sin marcas: la pasada no puede reescribir texto que no le pertenece.
  const libre = w.document.createElement('span');
  libre.textContent = 'sin marca';
  w.document.body.appendChild(libre);
  w.I18N.aplicarDOM();
  eq(el.textContent, 'Hola', 'el texto sale del diccionario');
  eq(ph.getAttribute('placeholder'), 'Escribe aquí', 'y el atributo también');
  eq(tt.getAttribute('title'), 'Título de prueba', 'el title se traduce');
  eq(aria.getAttribute('aria-label'), 'Etiqueta de prueba', 'y el aria-label');
  eq(libre.textContent, 'sin marca', 'lo que no lleva marca se queda igual');
  eq(w.document.documentElement.lang, w.I18N.idioma, 'el lang del documento sigue al idioma');
});

check('idioma: con inglés el mismo marcado queda en inglés', () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  w.sagitari = { idioma: 'en' };
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-es.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-en.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n.js'), 'utf8'));
  const el = w.document.createElement('span');
  el.setAttribute('data-i18n', 'prueba.texto');
  w.document.body.appendChild(el);
  w.I18N.aplicarDOM();
  eq(el.textContent, 'Hello', 'se pinta el inglés');
  eq(w.document.documentElement.lang, 'en', 'y el <html lang> pasa a inglés');
});

check('idioma: toda clave marcada en index.html existe en los dos diccionarios', () => {
  const claves = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-ph|-title|-aria|-label)?="([^"]+)"/g)) claves.add(m[1]);
  const cargar = (f) => {
    const w = new JSDOM('', { runScripts: 'outside-only' }).window;
    w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', f), 'utf8'));
    return w.I18N_ES ? w.I18N_ES : w.I18N_EN;
  };
  const es = cargar('i18n-es.js');
  const en = cargar('i18n-en.js');
  const faltanEs = [...claves].filter((k) => !(k in es));
  const faltanEn = [...claves].filter((k) => !(k in en));
  if (faltanEs.length) throw new Error('faltan en español: ' + faltanEs.slice(0, 5).join(', '));
  if (faltanEn.length) throw new Error('faltan en inglés: ' + faltanEn.slice(0, 5).join(', '));
  eq(claves.size > 0, true, 'tiene que haber claves marcadas');
});

check('idioma: los dos diccionarios del renderer tienen exactamente las mismas claves', () => {
  /* La comprobación de arriba solo mira las claves MARCADAS en index.html, que son un
     subconjunto: las que usa el JS para pintar filas y avisos no las revisaba nadie, y
     una clave que falte en un idioma cae al español sin que nada chille. */
  const { es, en } = diccionarios();
  const soloEs = Object.keys(es).filter((k) => !(k in en));
  const soloEn = Object.keys(en).filter((k) => !(k in es));
  eq(soloEs.slice(0, 5).join(', '), '', 'claves que faltan en inglés');
  eq(soloEn.slice(0, 5).join(', '), '', 'claves que sobran en inglés');
  eq(Object.keys(es).length > 0, true, 'el diccionario no puede estar vacío');
});

check('idioma: toda clave que usa el JS del renderer existe en los dos diccionarios', () => {
  const { es, en } = diccionarios();
  const RAIZ_JS = path.join(RAIZ, 'renderer');
  const ficheros = fs
    .readdirSync(RAIZ_JS)
    .filter((f) => f.endsWith('.js') && !f.startsWith('i18n') && !f.endsWith('.min.js'));
  /* Clave literal: `I18N.t('x')` y `I18N.t("x")`, con el `t(` en la línea de al lado. */
  const LITERAL = /I18N\.t\(\s*(['"])([^'"]+)\1/g;
  /* Familias que se arman con `'prefijo.' + valor`: sus claves no están en ningún
     literal, así que se enumeran aquí. Si aparece una familia nueva, la prueba falla
     pidiendo que se añada —si no, sus claves se quedarían sin vigilar. */
  const FAMILIAS = {
    // los cuatro `<option value>` del desplegable de permisos (Seguridad y MCP)
    nivel: ['default', 'safe', 'confirm', 'restricted'],
  };
  const PREFIJO = /I18N\.t\(\s*(['"])([a-z0-9_]+\.)\1\s*\+/g;
  const usadas = new Set();
  const familias = new Set();
  for (const f of ficheros) {
    const src = fs.readFileSync(path.join(RAIZ_JS, f), 'utf8');
    for (const m of src.matchAll(LITERAL)) {
      // `'nivel.'` es el prefijo de una familia, no una clave: lo cubre `FAMILIAS`
      if (!m[2].endsWith('.')) usadas.add(m[2]);
    }
    for (const m of src.matchAll(PREFIJO)) familias.add(m[2].slice(0, -1));
  }
  for (const nombre of familias) {
    eq(Array.isArray(FAMILIAS[nombre]), true, 'la familia de claves ' + nombre + '.* no está enumerada en esta prueba');
    for (const valor of FAMILIAS[nombre]) usadas.add(nombre + '.' + valor);
  }
  const faltanEs = [...usadas].filter((k) => !(k in es));
  const faltanEn = [...usadas].filter((k) => !(k in en));
  eq(faltanEs.join(', '), '', 'claves que el JS usa y faltan en español');
  eq(faltanEn.join(', '), '', 'claves que el JS usa y faltan en inglés');
  eq(usadas.size > 0, true, 'tiene que haber claves en el JS');
});

check('idioma: los rótulos que pinta el CSS se traducen por data-i18n-label', () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  w.sagitari = { idioma: 'en' };
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-es.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-en.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n.js'), 'utf8'));
  w.I18N.aplicarDOM();
  const grupo = w.document.querySelector('.navgroup');
  eq(grupo.getAttribute('data-label'), 'Main', 'el data-label que lee el CSS queda en inglés');
});

console.log('\n' + pasaron + ' pasaron, ' + fallaron + ' fallaron');
process.exit(fallaron ? 1 : 0);
