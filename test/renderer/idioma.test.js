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
});

console.log('\n' + pasaron + ' pasaron, ' + fallaron + ' fallaron');
process.exit(fallaron ? 1 : 0);
