'use strict';
/* Suite SAGITARI — publicar (tag → CI → release).

   Qué guarda esta bloque, y por qué existe:

     · el TAG es lo que publica (release.yml solo escucha `push` de tags `v*`) y
       hasta ahora lo creaba una persona a mano. En la 5.2.0 se creó a la vez que
       se subían los assets por la API: el CI recompiló por su cuenta y pisó los
       ficheros, así que la release acabó con un `latest.yml` que no casaba con el
       `.exe` del `dist/` local. `npm run release` es ahora el único camino, y su
       regla de «¿hay notas de ESTA versión?» se prueba aquí.
     · `npm run dist` construía en local SIN los dos pasos que el CI sí da
       (completar `latest.yml` y verificarlo), o sea que el fallo de la 3.2.1
       —el portable sin firma publicada, sin poder actualizarse nunca— era
       irreproducible en local. Ahora los dos caminos son el mismo script.
     · el CI compila el instalador y lo publica, pero nunca lo ABRE: `npm run
       smoke` arranca desde el árbol de fuentes. Por eso el fallo de
       `copyFileSync` contra `app.asar` (instalación nueva sin NINGUNA skill de
       serie) viajó a producción con las dos suites en verde. El paso de
       instalación real se comprueba aquí para que nadie lo borre sin enterarse.

   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, test, eq, ok } = require('./comun');

const RAIZ = path.join(__dirname, '..');
const { nombreTag, seccionNotas } = require('../scripts/release');
const { objetivos } = require('../scripts/dist');
const pkg = require('../package.json');

/* ---------- el tag ---------- */

test('release: el tag sale de la versión, con una sola uve', () => {
  eq(nombreTag('5.2.0'), 'v5.2.0', 'v + versión');
  eq(nombreTag('v5.2.0'), 'v5.2.0', 'si ya trae uve, no se duplica');
  eq(nombreTag(pkg.version), 'v' + pkg.version, 'la versión real del paquete');
});

/* ---------- las notas ---------- */

test('release: solo se publica si hay notas de ESTA versión', () => {
  const notas = fs.readFileSync(path.join(RAIZ, 'RELEASE_NOTES.md'), 'utf8');
  ok(seccionNotas(notas, pkg.version).startsWith('# SAGITARI ' + pkg.version), 'la sección de la versión actual existe');

  eq(seccionNotas(notas, '0.0.1'), '', 'una versión sin sección devuelve vacío: no cuela la de al lado');

  // El corte: la sección no se come la de la versión anterior.
  const dos = '# SAGITARI 9.9.9\ncuerpo\n# SAGITARI 9.9.8\notro\n';
  eq(seccionNotas(dos, '9.9.9'), '# SAGITARI 9.9.9\ncuerpo', 'se corta en la cabecera siguiente');

  // Misma regla que el awk de release.yml (`index($0, "# SAGITARI " ver " ")`):
  // una versión que es PREFIJO de otra no puede casar.
  eq(seccionNotas('# SAGITARI 5.2.01\nx\n', '5.2.0'), '', 'la cabecera se compara entera, no por prefijo');
  eq(seccionNotas('# SAGITARI 5.2.0-rc.1\nx\n', '5.2.0'), '', 'ni con un sufijo pegado');
  ok(seccionNotas('# SAGITARI 5.2.0 — resumen\nx\n', '5.2.0').length > 0, 'pero sí con un guion y texto detrás');
});

/* ---------- la construcción ---------- */

test('dist: objetivos y argumentos ajenos de electron-builder', () => {
  eq(objetivos([]).targets.join(','), 'nsis,portable', 'por defecto, instalador y portable');
  eq(objetivos(['--installer']).targets.join(','), 'nsis', '--installer deja solo el Setup');
  eq(objetivos(['--portable']).targets.join(','), 'portable', '--portable deja solo el portable');
  eq(objetivos(['--publish', 'never']).extra.join(' '), '--publish never', 'lo ajeno se reenvía tal cual');
  eq(objetivos(['--installer', '--publish', 'never']).extra.join(' '), '--publish never', 'y la bandera propia no se cuela en la orden');
});

test('dist: los binarios de otra versión no entran en el manifiesto', () => {
  const { limpiarViejos } = require('../scripts/dist');
  const dir = require('./comun').tmpDir('sagi-dist-');
  for (const f of [
    'SAGITARI-Setup-5.2.0.exe',
    'SAGITARI-Portable-5.2.0.exe',
    'SAGITARI-Setup-5.1.1.exe',
    'SAGITARI-Setup-5.1.1.exe.blockmap',
    'latest.yml',
  ]) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  const fuera = limpiarViejos(dir, '5.2.0').sort();
  eq(fuera.join(','), 'SAGITARI-Setup-5.1.1.exe,SAGITARI-Setup-5.1.1.exe.blockmap', 'se descarta lo de la 5.1.1');
  eq(fs.existsSync(path.join(dir, 'SAGITARI-Setup-5.2.0.exe')), true, 'lo de la versión en curso se respeta');
  eq(fs.existsSync(path.join(dir, 'latest.yml')), true, 'y latest.yml lo reescribe electron-builder');
});

test('publicar: el camino local y el del CI son el mismo', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'dist.js'), 'utf8');
  ok(/latest-yml\.js/.test(src), 'construir en local completa latest.yml');
  ok(/--check/.test(src), 'y lo verifica antes de dar el build por bueno');
  eq(pkg.scripts.dist, 'node scripts/dist.js', '`npm run dist` ya no es electron-builder a pelo');
  eq(pkg.scripts.release, 'node scripts/release.js', 'publicar es un comando del paquete');
  eq(/electron-builder/.test(pkg.scripts.dist), false, 'nadie puede saltarse los dos pasos por la puerta de atrás');
});

/* ---------- el paquete instalado ---------- */

test('publicar: el CI abre el paquete INSTALADO antes de subirlo', () => {
  const wf = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'release.yml'), 'utf8');
  const ini = wf.indexOf('Instalación real del paquete');
  ok(ini > 0, 'existe el paso de instalación real');
  ok(/Start-Process/.test(wf.slice(ini)), 'ejecuta el .exe instalado, no el árbol de fuentes');
  ok(/skills-starter/.test(wf.slice(ini)), 'compara lo sembrado con las skills incluidas');
  ok(/SMOKE::/.test(wf.slice(ini)), 'y exige la marca del arranque de prueba');
  ok(ini < wf.lastIndexOf('action-gh-release'), 'antes de publicar, no después');
});
