#!/usr/bin/env node
'use strict';

/* ============================================================================
   release.js — un comando para publicar: comprueba, etiqueta, empuja.

   Por qué existe: `.github/workflows/release.yml` NO se dispara con el push a
   main, solo con un tag `v*`. Es decir, la release la crea el TAG — y el tag lo
   creaba una persona a mano. Eso tiene dos finales malos: o se olvida (main
   avanza y no se publica nada) o se publica a mano por la API de GitHub y el CI
   recompila después por su cuenta y pisa los assets. Pasó el 21/10/2026 con la
   5.2.0: los ficheros que quedaron en la release no eran los que se habían
   subido a mano, y el `latest.yml` publicado no casaba con el `.exe` del `dist/`
   local. Este script hace el único camino bueno.

   Qué comprueba, y por qué cada cosa:
     · árbol limpio        → el tag apuntaría a un commit SIN esos cambios
     · main == origin/main → un tag puede subir commits, pero main se quedaría
                             atrás y la próxima release saldría de un estado que
                             nadie tiene
     · RELEASE_NOTES.md tiene la sección de ESTA versión → el CI aborta si falta
                             (el `awk` de release.yml), pero después de crear el
                             tag; mejor saberlo antes de gastar el runner
     · el tag no existe    → reetiquetar una versión ya publicada no actualiza
                             los assets que la gente ya tiene
     · lint + las 2 suites → el CI las repite; esto evita dejar colgando un tag
                             de un commit que ya se sabe rojo
   ============================================================================ */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAIZ = path.join(__dirname, '..');
const VERSION = String(require(path.join(RAIZ, 'package.json')).version);
const NOTAS = path.join(RAIZ, 'RELEASE_NOTES.md');

function paso(mensaje) {
  console.log('  ok  ' + mensaje);
}

function fallo(mensaje) {
  console.error('\n  ✗  ' + mensaje + '\n');
  process.exit(1);
}

/** `5.2.0` → `v5.2.0`. Si ya viene con uve, no se duplica. */
function nombreTag(version) {
  return 'v' + String(version).replace(/^v/, '');
}

/**
 * La sección de ESTA versión en RELEASE_NOTES.md, con la MISMA regla que el
 * `awk` de release.yml: cabecera exacta `# SAGITARI <version>` (o seguida de un
 * espacio) y se corta en la cabecera siguiente. Devuelve '' si no está.
 *
 * La comparación es entera a propósito: `index($0, "# SAGITARI " ver " ")` en
 * awk exige el espacio, así que `5.2.0` no debe casar con `5.2.01` ni con
 * `5.2.0-rc.1`. Un `startsWith` a secas publicaría notas de otra versión.
 */
function seccionNotas(texto, version) {
  const cabecera = '# SAGITARI ' + version;
  const dentro = [];
  let capturando = false;
  for (const linea of String(texto).split(/\r?\n/)) {
    if (/^# SAGITARI /.test(linea)) {
      if (capturando) break;
      if (linea === cabecera || linea.startsWith(cabecera + ' ')) capturando = true;
    }
    if (capturando) dentro.push(linea);
  }
  return dentro.join('\n').trim();
}

function git(args) {
  const r = spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
  if (r.error) fallo('no se pudo ejecutar git: ' + r.error.message);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Los gates que también corre el CI antes de publicar. */
function pruebas() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // `shell` en Windows: desde Node 20, spawnear un `.cmd` sin shell lanza EINVAL
  // (el arreglo de CVE-2024-27980). Los nombres de script son constantes de este
  // fichero, así que no hay nada que interpolar.
  const shell = process.platform === 'win32';
  for (const [etiqueta, script] of [
    ['lint', 'lint'],
    ['pruebas', 'test'],
    ['pruebas de interfaz', 'test:renderer'],
  ]) {
    console.log('\n--- ' + etiqueta + ' ---');
    const r = spawnSync(npm, ['run', script], { cwd: RAIZ, stdio: 'inherit', shell });
    if (r.error) fallo(etiqueta + ': ' + r.error.message);
    if (r.status !== 0) fallo(etiqueta + ' en rojo: no se etiqueta un commit que el CI va a rechazar');
  }
}

function preguntar(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(texto, (respuesta) => {
      rl.close();
      resolve(respuesta);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const rapido = args.includes('--rapido');
  const sinPreguntar = args.includes('--si');
  const tag = nombreTag(VERSION);

  console.log('Publicar SAGITARI ' + VERSION + ' (tag ' + tag + ')\n');

  // 1. El commit que se va a etiquetar tiene que ser exactamente lo que hay.
  if (git(['status', '--porcelain']).out) fallo('hay cambios sin commitear: el tag apuntaría a un commit sin ellos');
  paso('árbol limpio');

  const rama = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (rama !== 'main') fallo('estás en `' + rama + '`: se publica desde main');
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) fallo('main no tiene upstream: `git push -u origin main` una vez y vuelve');
  const pendientes = Number(git(['rev-list', '--count', '@{u}..HEAD']).out || 0);
  if (pendientes > 0) fallo('main tiene ' + pendientes + ' commit(s) sin subir: empújalos antes de etiquetar');
  paso('main al día con ' + upstream.out);

  // 2. Las notas: el CI corta si falta la sección, pero después de crear el tag.
  if (!fs.existsSync(NOTAS)) fallo('no existe RELEASE_NOTES.md');
  if (!seccionNotas(fs.readFileSync(NOTAS, 'utf8'), VERSION)) {
    fallo('RELEASE_NOTES.md no tiene la sección `# SAGITARI ' + VERSION + '`: el CI abortaría y el tag quedaría colgando');
  }
  paso('RELEASE_NOTES.md tiene la sección ' + VERSION);

  // 3. El tag, libre en local y en el remoto.
  if (git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag]).ok) fallo('el tag ' + tag + ' ya existe en local');
  if (git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]).out) {
    fallo('el tag ' + tag + ' ya está publicado en origin: esa versión ya salió');
  }
  paso('el tag ' + tag + ' está libre');

  // 4. Los gates del CI, antes de gastar minutos de runner.
  if (rapido) {
    console.log('\n  · pruebas omitidas (--rapido)');
  } else {
    pruebas();
    paso('lint y las dos suites en verde');
  }

  // 5. Confirmar: esto publica para todo el que tenga la app instalada.
  if (!sinPreguntar) {
    if (!process.stdin.isTTY) fallo('sin terminal interactiva: repite con --si para publicar sin preguntar');
    const respuesta = await preguntar('\n¿Crear y empujar ' + tag + '? [s/N] ');
    if (!/^s/i.test(respuesta.trim())) {
      console.log('nada que hacer');
      return;
    }
  }

  // 6. Etiquetar y empujar. Si el push falla, el tag local se deshace para poder
  //    reintentar sin chocar con él.
  const creado = git(['tag', tag]);
  if (!creado.ok) fallo('no se pudo crear el tag: ' + creado.err);
  const empujado = git(['push', 'origin', tag]);
  if (!empujado.ok) {
    git(['tag', '-d', tag]);
    fallo('no se pudo empujar el tag: ' + empujado.err);
  }

  const url = git(['remote', 'get-url', 'origin'])
    .out.replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  console.log('\n' + tag + ' empujado. El CI compila, prueba e INSTALA el paquete antes de publicar:');
  console.log('  ' + url + '/actions/workflows/release.yml');
  console.log('  ' + url + '/releases');
}

if (require.main === module) main();

module.exports = { nombreTag, seccionNotas, VERSION };
