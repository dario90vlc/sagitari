#!/usr/bin/env node
'use strict';

/* ============================================================================
   limpia.js — borra los restos que dejan los arranques de prueba.

   Por qué existe: cada ejecución de las suites, del arnés de interfaz o de
   `npm run shots` crea su propio perfil al lado del código (`.perfil-pruebas`,
   `.perfil-uicheck…`, `sagi-ui-ws-*`, `.tmp-arboles`). Están en .gitignore, así
   que no ensucian el repo, pero no se los lleva nadie: hoy eran 17 carpetas y
   40 MB. Y como el nombre lleva la versión del perfil, no hay forma de saber
   cuáles sobran sin mirarlas una a una.

   Uso:
     npm run limpia          → borra y cuenta lo que ha liberado
     npm run limpia -- --ver → solo enseña qué borraría (no toca nada)

   Nunca toca nada fuera de la raíz del proyecto ni ningún directorio que no
   empiece por los patrones de abajo: los datos reales de la app viven en
   %APPDATA%\SagitariAI y este script no los mira.
   ============================================================================ */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
// Solo restos de pruebas. `anuncio/`, `shots/`, `dist/` y `.impeccable/` son
// trabajo y material del proyecto: se limpian a mano, no aquí.
const PATRONES = [/^\.perfil-/, /^sagi-ui-ws-/, /^\.tmp-arboles$/];

function tamano(dir) {
  let total = 0;
  const pendientes = [dir];
  while (pendientes.length) {
    const actual = pendientes.pop();
    let entradas;
    try {
      entradas = fs.readdirSync(actual, { withFileTypes: true });
    } catch {
      continue; // sin permisos o borrado a mitad: se cuenta lo que se pueda
    }
    for (const e of entradas) {
      const ruta = path.join(actual, e.name);
      if (e.isDirectory()) pendientes.push(ruta);
      else {
        try {
          total += fs.statSync(ruta).size;
        } catch {}
      }
    }
  }
  return total;
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1) + ' MB';
}

function main() {
  const ver = process.argv.includes('--ver');
  const restos = fs
    .readdirSync(RAIZ, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PATRONES.some((p) => p.test(e.name)))
    .map((e) => ({ nombre: e.name, bytes: tamano(path.join(RAIZ, e.name)) }))
    .sort((a, b) => b.bytes - a.bytes);

  if (!restos.length) {
    console.log('nada que limpiar: no hay perfiles de prueba en la raíz');
    return;
  }

  let total = 0;
  for (const r of restos) {
    total += r.bytes;
    console.log('  ' + r.nombre.padEnd(34) + mb(r.bytes));
    if (!ver) {
      try {
        fs.rmSync(path.join(RAIZ, r.nombre), { recursive: true, force: true });
      } catch (e) {
        console.log('    (no se pudo borrar: ' + e.message + ')');
        total -= r.bytes;
      }
    }
  }

  console.log('\n' + restos.length + ' carpeta(s) · ' + mb(total) + (ver ? '  — modo --ver: no se ha borrado nada' : '  liberados'));
}

main();
