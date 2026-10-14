'use strict';
/* Suite SAGITARI — regresiones de la auditoría en los módulos de guardarraíles y
   escrituras: agent/arboles.js (aquí), y guardrails.js/cambios.js/runlog.js en
   test/renderer/*.test.js. Los tests de árboles vivían en 40-agente.js (agente: otro
   dueño), así que este bloque los trae a su propio fichero.
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, tmpDir, test, eq, ok } = require('./comun');
const arbolesMod = require('../agent/arboles');
const { execFileSync } = require('child_process');

const GIT_OK = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const gitEn = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();

/** Repositorio de prueba con un commit (mismo patrón que el bloque de 40-agente.js). */
function repoDePrueba() {
  const ws = tmpDir('sagitari-git-');
  gitEn(ws, 'init', '-q');
  gitEn(ws, 'config', 'user.email', 't@t.t');
  gitEn(ws, 'config', 'user.name', 't');
  // sin esto la configuración global del equipo (autocrlf) decide los finales de línea
  gitEn(ws, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 1;\n');
  gitEn(ws, 'add', '-A');
  gitEn(ws, 'commit', '-qm', 'inicio');
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 2;\n'); // sin commitear
  return ws;
}

test('árboles: un conflicto conserva el directorio pero NO deja registro en el repositorio', async () => {
  if (!GIT_OK) return; // en un equipo sin git esto no aplica (el CI lo tiene)
  const ws = repoDePrueba();
  const arbol = await arbolesMod.crear(ws);
  ok(arbol, 'debería poder aislarse');
  fs.writeFileSync(path.join(arbol.dir, 'a.js'), 'module.exports = "agente";\n');
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = "usuario";\n'); // el usuario escribe encima
  const f = await arbolesMod.fusionar(arbol);
  eq(f.ok, false, 'un choque de contexto no puede pasar por fusión limpia');

  await arbolesMod.descartar(arbol, { conservar: true });
  /* Conservar el DIRECTORIO (para poder mirar el trabajo) no obliga a conservar el
     REGISTRO: cada conflicto dejaba un `arbol-<id>` dentro de `.git/worktrees` del
     repositorio DEL USUARIO para siempre, y no hay ningún camino que lo limpie. */
  eq(/arbol-/.test(gitEn(ws, 'worktree', 'list')), false, 'no puede quedar un registro fantasma en el repositorio del usuario');
  eq(fs.existsSync(arbol.dir), true, 'y el directorio se conserva para poder mirarlo');
  eq(fs.readFileSync(path.join(arbol.dir, 'a.js'), 'utf8'), 'module.exports = "agente";\n', 'con el trabajo del subagente dentro');
  eq(arbol.conservadoDir, arbol.dir, 'el árbol dice dónde quedó la copia conservada');

  await arbolesMod.descartar(arbol);
  eq(fs.existsSync(arbol.dir), false, 'y la copia conservada se limpia al descartar de verdad');
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
});

/* ---------- El aislamiento no puede depender de CÓMO se escriba la carpeta ---------- */
/* El aislamiento averiguaba dónde cae el espacio de trabajo dentro del repositorio
   RESTANDO la raíz que da git (`--show-toplevel`) y la ruta del espacio de trabajo. Basta
   con que la misma carpeta se escriba de dos formas —el nombre corto de Windows, un
   enlace, la forma de MSYS— para que la resta diga «fuera del repositorio» y el
   aislamiento entero se rechace: el CI caía así en TODAS las pruebas de árboles, porque
   su %TEMP% llega en ruta corta (`C:\Users\RUNNER~1\...`) y git responde con la larga.
   La ruta relativa la calcula git (`--show-prefix`); aquí se fija que siga siendo así. */

/** Un enlace a la misma carpeta: el sistema lo resuelve y git contesta con la ruta REAL,
    así que el espacio de trabajo y la raíz que dice git se escriben de dos maneras. En
    Windows se hace con una unión, que no pide permisos. */
function enlaceA(destino) {
  const puente = path.join(tmpDir('sagitari-enlace-'), 'puente');
  fs.symlinkSync(destino, puente, process.platform === 'win32' ? 'junction' : 'dir');
  return puente;
}

/** La ruta corta (8.3) de una carpeta: es la forma en la que el %TEMP% de la CI llega al
    proceso mientras git responde con la larga. Si el sistema no tiene nombres cortos
    devuelve la misma ruta (las comprobaciones siguen valiendo; solo que ahí no hay dos
    formas que puedan no coincidir). */
function rutaCorta(p) {
  if (process.platform !== 'win32') return p;
  try {
    const salida = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p}').ShortPath`],
      { stdio: 'pipe' },
    )
      .toString()
      .trim();
    return salida || p;
  } catch {
    return p;
  }
}

test('árboles: el trabajo llega aunque git vea la carpeta del usuario por su ruta real', async () => {
  if (!GIT_OK) return; // en un equipo sin git esto no aplica (el CI lo tiene)
  const raiz = repoDePrueba();
  const ws = path.join(raiz, 'proyecto');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'nota.txt'), 'lo que ya había\n');
  gitEn(raiz, 'add', '-A');
  gitEn(raiz, 'commit', '-qm', 'proyecto');
  const puente = enlaceA(ws);
  const arbol = await arbolesMod.crear(puente);
  ok(arbol, 'debería poder aislarse aunque git resuelva el enlace a su ruta real');
  eq(arbol.rel, 'proyecto', 'la ruta relativa la dice git, no una resta de rutas nuestras');
  eq(arbol.wsDir, path.join(arbol.dir, 'proyecto'), 'el subagente trabaja en SU carpeta dentro del árbol');
  eq(fs.readFileSync(path.join(arbol.wsDir, 'nota.txt'), 'utf8'), 'lo que ya había\n', 'y ve lo que el usuario ya tenía en su carpeta');
  // aislamiento REAL: mientras el test corre, git tiene el árbol registrado de verdad
  ok(gitEn(raiz, 'worktree', 'list').includes(path.basename(arbol.dir)), 'git lista el árbol de trabajo: no es una carpeta copiada a mano');
  fs.writeFileSync(path.join(arbol.wsDir, 'nuevo.txt'), 'del agente\n');
  const f = await arbolesMod.fusionar(arbol);
  eq(f.ok, true, 'debería fusionar: ' + f.conflicto);
  eq(fs.readFileSync(path.join(ws, 'nuevo.txt'), 'utf8'), 'del agente\n', 'y su trabajo llega a ESA carpeta');
  eq(fs.existsSync(path.join(raiz, 'nuevo.txt')), false, 'nada fuera de la carpeta del usuario');
  await arbolesMod.descartar(arbol);
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
  eq(/arbol-/.test(gitEn(raiz, 'worktree', 'list')), false, 'ni registro fantasma en el repositorio del usuario');
});

test('árboles: con el espacio de trabajo en ruta corta (8.3) tampoco se pierde el aislamiento', async () => {
  if (!GIT_OK) return;
  const largo = repoDePrueba();
  const ws = rutaCorta(largo);
  const arbol = await arbolesMod.crear(ws);
  ok(arbol, 'debería poder aislarse con la ruta corta (' + ws + ')');
  eq(arbol.wsDir, arbol.dir, 'es la raíz de su repositorio: trabaja en la raíz del árbol');
  fs.writeFileSync(path.join(arbol.wsDir, 'nuevo.js'), 'const x = 1;\n');
  const f = await arbolesMod.fusionar(arbol);
  eq(f.ok, true, 'debería fusionar: ' + f.conflicto);
  eq(f.archivos.join(','), 'nuevo.js', 'el parche va relativo a la raíz del repositorio');
  eq(fs.readFileSync(path.join(largo, 'nuevo.js'), 'utf8'), 'const x = 1;\n', 'y el archivo llega a la carpeta del usuario');
  await arbolesMod.descartar(arbol);
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
});

test('árboles: un repositorio anidado aísla la carpeta del usuario, no la que lo contiene', async () => {
  if (!GIT_OK) return;
  const fuera = repoDePrueba();
  const ws = path.join(fuera, 'proyecto');
  fs.mkdirSync(ws);
  gitEn(ws, 'init', '-q');
  gitEn(ws, 'config', 'user.email', 't@t.t');
  gitEn(ws, 'config', 'user.name', 't');
  gitEn(ws, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(ws, 'nota.txt'), 'lo que ya había\n');
  gitEn(ws, 'add', '-A');
  gitEn(ws, 'commit', '-qm', 'dentro');
  const arbol = await arbolesMod.crear(ws);
  ok(arbol, 'debería poder aislarse');
  eq(arbol.rel, '', 'la raíz es la del repositorio del usuario, no la del que lo contiene');
  eq(arbol.wsDir, arbol.dir, 'y su carpeta dentro del árbol es la raíz');
  fs.writeFileSync(path.join(arbol.wsDir, 'nuevo.txt'), 'del agente\n');
  const f = await arbolesMod.fusionar(arbol);
  eq(f.ok, true, 'debería fusionar: ' + f.conflicto);
  eq(f.archivos.join(','), 'nuevo.txt', 'el parche va contra la raíz del repositorio del usuario');
  eq(fs.readFileSync(path.join(ws, 'nuevo.txt'), 'utf8'), 'del agente\n', 'el trabajo llega a su repositorio');
  eq(fs.existsSync(path.join(fuera, 'nuevo.txt')), false, 'y no al repositorio que lo contiene');
  await arbolesMod.descartar(arbol);
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
});
