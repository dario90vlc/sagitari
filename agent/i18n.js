'use strict';
/* Idioma del motor. Un solo sitio decide qué idioma se habla y traduce lo que puede
   acabar en pantalla. El renderer tiene su gemelo (renderer/i18n.js): son dos
   diccionarios distintos porque son dos procesos distintos, con las mismas reglas. */
const DICCIONARIOS = { es: require('./i18n/es'), en: require('./i18n/en') };
let activo = 'es';

/** 'es' | 'en' explícitos; 'auto' o cualquier cosa, por el locale del sistema.
    Sin locale (suite sin Electron) se queda en español. */
function resolverIdioma(uiLang, locale) {
  if (uiLang === 'es' || uiLang === 'en') return uiLang;
  const l = String(locale || '').trim();
  if (!l) return 'es';
  return /^es\b/i.test(l) ? 'es' : 'en';
}

function configurar(idioma) {
  activo = idioma === 'en' ? 'en' : 'es';
}
function idiomaActual() {
  return activo;
}

function t(clave, vars) {
  const texto = (DICCIONARIOS[activo] && DICCIONARIOS[activo][clave]) ?? DICCIONARIOS.es[clave] ?? '⟦' + clave + '⟧';
  return String(texto).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
}

/** Mensaje de error de herramienta: el prefijo es el MISMO en los dos idiomas porque el
    agente decide el fallo por él (`text.startsWith`). Si algún día se cambia, se rompe. */
function err(clave, vars) {
  return t('comun.error') + ': ' + t(clave, vars);
}

function claves(idioma) {
  return Object.keys(DICCIONARIOS[idioma] || {});
}

module.exports = { resolverIdioma, configurar, idiomaActual, t, err, claves };
