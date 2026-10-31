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

test('idioma: el renderer lee el idioma de argv (canal único, sin IPC)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/--sag-idioma=/.test(src), 'el preload tiene que leer el argumento');
  ok(/idioma:/.test(src), 'y exponerlo como idioma');
  const ventana = fs.readFileSync(path.join(__dirname, '..', 'main', 'ventana.js'), 'utf8');
  ok(/additionalArguments:\s*\[/.test(ventana), 'la ventana tiene que pasar el argumento');
});

test('idioma: --sag-idioma=es|en se impone a los ajustes y al locale del sistema', () => {
  const { idiomaDeArgumentos, resolverIdiomaArranque } = require('../main/idioma');
  eq(idiomaDeArgumentos(['--sag-idioma=en']), 'en');
  eq(idiomaDeArgumentos(['x', '--sag-idioma=es']), 'es');
  eq(idiomaDeArgumentos(['--sag-idioma=fr']), null, 'un valor inválido no anula nada');
  eq(idiomaDeArgumentos([]), null, 'sin flag no hay anulación');
  eq(resolverIdiomaArranque('es', 'es-ES', ['--sag-idioma=en']), 'en', 'manda sobre lo guardado en Ajustes');
  eq(resolverIdiomaArranque('auto', 'es-ES', []), 'es', 'sin flag, como siempre');
  eq(resolverIdiomaArranque('en', 'es-ES', ['--sag-idioma=basura']), 'en', 'una errata no cambia lo elegido');
  // main tiene que pasarle los argumentos: si no, el flag existiría y no haría nada
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  ok(
    /resolverIdiomaArranque\(config\.settings[^;]*process\.argv\)/.test(src),
    'main resuelve el idioma con los argumentos del proceso',
  );
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

test('idioma: el resumen de /compact se pide en el idioma del usuario, no en español fijo', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
  ok(!/Responde ÚNICAMENTE con el resumen, en español/.test(src), 'no puede fijar el español');
  ok(
    /Responde ÚNICAMENTE con el resumen, en el idioma del usuario/.test(src),
    'la línea del prompt tiene que pedir el resumen en el idioma del usuario',
  );
});
