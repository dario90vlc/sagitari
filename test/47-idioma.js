'use strict';
/* Idioma del motor: resolución, fallback y paridad de claves. El diccionario del motor
   solo lleva lo que puede acabar en pantalla (mensajes, motivos, estados). */
const { test, eq, ok } = require('./helpers');

test('idioma: resolverIdioma decide por el locale y respeta lo elegido', () => {
  const i18n = require('../agent/i18n');
  eq(i18n.resolverIdioma('auto', 'es-ES'), 'es', 'español de España');
  eq(i18n.resolverIdioma('auto', 'es-AR'), 'es', 'cualquier región española');
  eq(i18n.resolverIdioma('auto', 'en-GB'), 'en', 'inglés de Reino Unido');
  eq(i18n.resolverIdioma('auto', 'fr-FR'), 'en', 'cualquier otro idioma va a inglés');
  eq(i18n.resolverIdioma('auto', undefined), 'es', 'sin locale (pruebas) se queda en español');
  eq(i18n.resolverIdioma('en', 'es-ES'), 'en', 'lo elegido manda sobre el locale');
  eq(i18n.resolverIdioma('inventado', 'es-ES'), 'es', 'un valor inválido cae en auto');
});

test('idioma: t() interpola y nunca queda vacío', () => {
  const i18n = require('../agent/i18n');
  i18n.configurar('es');
  eq(i18n.t('comun.error'), 'Error');
  eq(i18n.t('comun.detenido.motivo', { motivo: 'cupo' }), 'Ejecución detenida: cupo', 'interpola {motivo}');
  i18n.configurar('en');
  ok(i18n.err('comun.detenido').startsWith('Error: '), 'err lleva el prefijo del contrato');
  eq(i18n.t('comun.detenido.motivo', { motivo: 'budget' }), 'Run stopped: budget', 'interpola también en inglés');
  eq(i18n.t('no.existe.esta.clave'), '⟦no.existe.esta.clave⟧', 'una clave desconocida se ve, no se vacía');
  i18n.configurar('es');
});

test('idioma: los dos diccionarios del motor tienen exactamente las mismas claves', () => {
  const i18n = require('../agent/i18n');
  const es = i18n.claves('es').sort();
  const en = i18n.claves('en').sort();
  const soloEs = es.filter((k) => !en.includes(k));
  const soloEn = en.filter((k) => !es.includes(k));
  eq(soloEs.join(','), '', 'claves que faltan en inglés');
  eq(soloEn.join(','), '', 'claves que sobran en inglés');
  ok(es.length > 0, 'el diccionario no puede estar vacío');
});
