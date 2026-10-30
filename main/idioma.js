'use strict';

/* Idioma de arranque del proceso principal, aparte de main.js para poder probarlo sin
   levantar Electron. `--sag-idioma=es|en` es la anulación EXPLÍCITA (pruebas manuales y
   quien lanza la app desde una consola): manda sobre lo guardado en Ajustes y sobre el
   locale del sistema. Un valor distinto de es/en no anula nada, para que una errata no
   deje la app en un idioma que nadie pidió. */
const i18n = require('../agent/i18n');

function idiomaDeArgumentos(argv) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--sag-idioma='));
  if (!arg) return null;
  const v = arg.slice('--sag-idioma='.length).trim();
  return v === 'es' || v === 'en' ? v : null;
}

function resolverIdiomaArranque(uiLang, locale, argv) {
  return idiomaDeArgumentos(argv) || i18n.resolverIdioma(uiLang, locale);
}

module.exports = { idiomaDeArgumentos, resolverIdiomaArranque };
