(function () {
  'use strict';
  /* Gemelo de agent/i18n.js para la interfaz. Los diccionarios se cargan ANTES que este
     fichero (index.html) como globales, porque el renderer no usa módulos. */
  const ES = window.I18N_ES || {};
  const EN = window.I18N_EN || {};
  /* El idioma lo decide el proceso principal y viaja en `window.sagitari`; sin él (pruebas,
     jsdom) la interfaz habla español, que es el idioma de casa. */
  const idioma = (window.sagitari && window.sagitari.idioma) === 'en' ? 'en' : 'es';
  const TABLA = idioma === 'en' ? EN : ES;

  function t(clave, vars) {
    /* `||` y no `??`: una entrada vacía en el diccionario también tiene que caer al
       español; con `??` pasaría el '' y el nodo se quedaría en blanco. */
    const texto = TABLA[clave] || ES[clave] || '⟦' + clave + '⟧';
    return String(texto).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] !== undefined ? String(vars[k]) : m;
    });
  }

  /* Una sola pasada sobre el marcado. Idempotente: volver a llamarla no cambia nada. */
  function aplicarDOM(raiz) {
    const doc = raiz || document;
    doc.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    doc.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    doc.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    doc.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  window.I18N = { t: t, idioma: idioma, aplicarDOM: aplicarDOM, claves: function (i) { return Object.keys(i === 'en' ? EN : ES); } };
})();
