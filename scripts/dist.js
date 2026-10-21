#!/usr/bin/env node
'use strict';

/* ============================================================================
   dist.js — construye la release LOCAL con los mismos pasos que el CI.

   Por qué existe: `npm run dist` era `electron-builder --win nsis portable` a
   secas. El CI, además, COMPLETA `latest.yml` con todos los binarios
   (scripts/latest-yml.js) y lo VERIFICA antes de publicar. Resultado: un build
   local dejaba un `latest.yml` que solo firmaba el Setup — exactamente el estado
   que en la 3.2.1 dejó al portable sin poder actualizarse nunca («no se pudo
   verificar la descarga»)— y era imposible reproducir ese fallo en local porque
   aquí no se daba el paso. Ahora los dos caminos son el mismo.

   Uso:
     npm run dist                    → Setup + portable, yml completo y verificado
     npm run dist:installer          → solo el Setup
     npm run dist:portable           → solo el portable
     npm run dist -- --publish never → los argumentos ajenos van a electron-builder
   ============================================================================ */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIST = path.join(RAIZ, 'dist');
const VERSION = String(require(path.join(RAIZ, 'package.json')).version);
const CLI_BUILDER = path.join(RAIZ, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

function salir(mensaje) {
  console.error('\nDIST::' + mensaje);
  process.exit(1);
}

function correr(etiqueta, args) {
  console.log('\n=== ' + etiqueta + ' ===');
  const r = spawnSync(process.execPath, args, { cwd: RAIZ, stdio: 'inherit', env: process.env });
  if (r.error) salir(etiqueta + ': ' + r.error.message);
  if (r.status !== 0) salir(etiqueta + ': terminó con código ' + r.status);
}

/**
 * Qué objetivos de electron-builder se construyen y qué argumentos son ajenos.
 * `--installer` / `--portable` son nuestras; el resto (`--publish never`, que usa
 * el CI) se reenvía tal cual, sin colarse en los objetivos.
 */
function objetivos(args) {
  const lista = Array.isArray(args) ? args : [];
  const soloInstaller = lista.includes('--installer');
  const soloPortable = lista.includes('--portable');
  const targets = soloInstaller ? ['nsis'] : soloPortable ? ['portable'] : ['nsis', 'portable'];
  const extra = lista.filter((a) => a !== '--installer' && a !== '--portable');
  return { targets, extra };
}

/**
 * Saca de `dist/` los binarios de OTRA versión.
 * `scripts/latest-yml.js` recorre todos los `SAGITARI-*.exe` de la carpeta y los
 * firma en el yml: dejar la 5.1.1 al lado de la 5.2.0 publicaría un manifiesto con
 * dos versiones y la app podría descargar la que no toca. Los de la MISMA versión
 * se quedan: electron-builder los sobrescribe y, si el build falla, no se pierde
 * la última pasada buena.
 * @returns {string[]} ficheros descartados
 */
function limpiarViejos(dir, version) {
  if (!fs.existsSync(dir)) return [];
  const fuera = fs.readdirSync(dir).filter((f) => {
    const m = f.match(/^SAGITARI-.*-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/i);
    return !!m && m[1] !== version;
  });
  for (const f of fuera) fs.rmSync(path.join(dir, f), { force: true });
  return fuera;
}

function resumen() {
  const exes = fs
    .readdirSync(DIST)
    .filter((f) => /^SAGITARI-.*\.exe$/i.test(f))
    .sort();
  console.log('\n=== listo ===');
  for (const f of exes) {
    const mb = (fs.statSync(path.join(DIST, f)).size / (1024 * 1024)).toFixed(1);
    console.log('  ' + f.padEnd(34) + mb + ' MB');
  }
  console.log('\nPublicar: `npm run release` — crea el tag v' + VERSION + ' y el CI compila, instala y publica.');
}

function main() {
  if (!fs.existsSync(CLI_BUILDER)) salir('falta electron-builder en node_modules: ejecuta `npm ci` antes de construir');
  const { targets, extra } = objetivos(process.argv.slice(2));
  console.log('SAGITARI ' + VERSION + ' → ' + targets.join(' + '));
  for (const f of limpiarViejos(DIST, VERSION)) console.log('  fuera de dist/ (de otra versión): ' + f);

  correr('electron-builder', [CLI_BUILDER, '--win', ...targets, ...extra]);
  // El yml: primero se completa con TODOS los binarios, después se comprueba que
  // la firma publicada es la del binario. Mismo lector que la app (main/updater.js).
  correr('latest.yml (completar)', [path.join(__dirname, 'latest-yml.js'), 'dist']);
  correr('latest.yml (verificar)', [path.join(__dirname, 'latest-yml.js'), 'dist', '--check']);
  resumen();
}

if (require.main === module) main();

module.exports = { objetivos, limpiarViejos, VERSION };
