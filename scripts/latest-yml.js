#!/usr/bin/env node
'use strict';

/* Completar y comprobar `latest.yml` antes de publicar.

   Por qué existe: electron-builder solo escribe la firma del **Setup** en
   `latest.yml`. El binario portable no aparece, así que quien usa el portable
   descargaba la actualización y la app la **descartaba** («no se pudo verificar la
   descarga»), porque sin firma publicada no hay nada contra lo que comparar: una
   edición portable no podía actualizarse nunca. Pasó de verdad en la 3.2.1.

   Este script es la única fuente de verdad de esa firma y lo usa dos veces el CI:

     node scripts/latest-yml.js dist            → completa el yml con TODOS los .exe
     node scripts/latest-yml.js dist --check     → falla si alguno no tiene firma válida

   Lee y escribe con `main/updater.js`, es decir, con **el mismo lector que la app**
   (`parseLatestYml` / `sha512For`): lo que aquí se da por bueno es exactamente lo
   que la app va a encontrar. Si el yml publicara una firma que no fuera la del
   binario, o faltara una entrada, el `--check` corta la release antes de subirla.

   El `sha512` de nivel superior y `path` siguen señalando al Setup: eso es lo que
   espera cualquier consumidor de `latest.yml` (electron-updater incluido). Las
   demás entradas van en `files:`, que es donde las busca la app por nombre. */

const fs = require('fs');
const path = require('path');
const u = require('../main/updater.js');

const NOMBRE_YML = 'latest.yml';

/** Los binarios que la release publica (y que, por tanto, deben estar firmados). */
function binarios(dir) {
  return fs.readdirSync(dir).filter(f => /^SAGITARI-.*\.exe$/i.test(f)).sort();
}

/**
 * Estado de la firma de cada binario según el yml.
 * @returns {{faltan: string[], malas: string[], ok: string[]}}
 */
function revisar(dir, parsed) {
  const faltan = [];
  const malas = [];
  const bien = [];
  for (const f of binarios(dir)) {
    const publicada = u.sha512For(parsed, f);
    if (!publicada) { faltan.push(f); continue; }
    (publicada === u.sha512Of(path.join(dir, f)) ? bien : malas).push(f);
  }
  return { faltan, malas, ok: bien };
}

/** Reconstruye el yml con todos los binarios firmados. Devuelve el texto nuevo. */
function completar(dir, parsed, original) {
  const exes = binarios(dir);
  const setup = exes.find(f => /-Setup-/i.test(f)) || exes[0];
  if (!setup) throw new Error('no hay ningún SAGITARI-*.exe en ' + dir);
  // El hash superior es el del fichero `path` (el Setup). Se conserva el que ya
  // traía el yml si sigue siendo el del Setup; si no, se recalcula.
  const pathOriginal = parsed.path && exes.includes(parsed.path) ? parsed.path : setup;
  const shaSuperior = u.sha512For(parsed, pathOriginal) || u.sha512Of(path.join(dir, pathOriginal));
  const fecha = (String(original || '').match(/^releaseDate:\s*(.+)$/m) || [])[1] || "'" + new Date().toISOString() + "'";
  const lineas = ['version: ' + parsed.version, 'files:'];
  for (const f of [pathOriginal, ...exes.filter(f => f !== pathOriginal)]) {
    lineas.push('  - url: ' + f);
    lineas.push('    sha512: ' + u.sha512Of(path.join(dir, f)));
    lineas.push('    size: ' + fs.statSync(path.join(dir, f)).size);
  }
  lineas.push('path: ' + pathOriginal);
  lineas.push('sha512: ' + shaSuperior);
  lineas.push('releaseDate: ' + fecha);
  return lineas.join('\n') + '\n';
}

function salir(mensaje) {
  console.error('LATEST-YML::' + mensaje);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const check = process.argv.includes('--check');
  const dir = path.resolve(args[0] || 'dist');
  const ymlPath = path.join(dir, NOMBRE_YML);
  if (!fs.existsSync(dir)) salir('no existe la carpeta ' + dir);
  if (!fs.existsSync(ymlPath)) salir('falta ' + ymlPath + ': electron-builder no generó el manifiesto');
  const exes = binarios(dir);
  if (!exes.length) salir('no hay ningún SAGITARI-*.exe en ' + dir);

  let texto = fs.readFileSync(ymlPath, 'utf8');
  let parsed = u.parseLatestYml(texto);
  if (!parsed.version) salir(ymlPath + ' no trae `version`: no se puede publicar');

  if (!check) {
    const antes = revisar(dir, parsed);
    if (antes.malas.length) {
      // Un yml que firma mal un binario es peor que uno incompleto: se regenera.
      console.log('firmas que no coinciden con el binario (se corrigen): ' + antes.malas.join(', '));
    }
    if (antes.faltan.length) console.log('binarios sin firma en el yml: ' + antes.faltan.join(', '));
    texto = completar(dir, parsed, texto);
    fs.writeFileSync(ymlPath, texto);
    parsed = u.parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));   // se relee lo escrito
    console.log('latest.yml completado con ' + exes.length + ' binarios');
  }

  const estado = revisar(dir, parsed);
  if (estado.faltan.length) salir('latest.yml no publica la firma de: ' + estado.faltan.join(', '));
  if (estado.malas.length) salir('la firma publicada no es la del binario: ' + estado.malas.join(', '));
  console.log('LATEST-YML::{"ok":true,"version":"' + parsed.version + '","firmados":' + JSON.stringify(estado.ok) + '}');
}

if (require.main === module) main();

module.exports = { binarios, revisar, completar, NOMBRE_YML };
