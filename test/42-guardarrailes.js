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
  eq(fs.existsSync(path.join(fuera, 'nuevo.txt')), false, 'y no al que lo contiene');
  await arbolesMod.descartar(arbol);
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
});

test('árboles: lo que el subagente escribe dentro de una ruta ignorada por git también llega', async () => {
  if (!GIT_OK) return;
  /* El espacio de trabajo del usuario puede caer dentro de una ruta que el proyecto tiene
     en `.gitignore` (el arnés de interfaz trabaja en su carpeta `sagi-ui-ws-…`, ignorada
     por el repositorio; y pasa de verdad con una carpeta de trabajo dentro del repo). El
     parche de la fusión se calcula con `git add -A`, que RESPETA el `.gitignore`: todo lo
     que el subagente escribiera ahí se quedaba fuera del parche y la fusión decía «no hay
     cambios» — trabajo perdido y en silencio, que es la peor forma de perderlo. */
  const raiz = repoDePrueba();
  fs.writeFileSync(path.join(raiz, '.gitignore'), 'ignorada/\n');
  gitEn(raiz, 'add', '-A');
  gitEn(raiz, 'commit', '-qm', 'ignora la carpeta de trabajo');
  const ws = path.join(raiz, 'ignorada');
  fs.mkdirSync(ws);
  const arbol = await arbolesMod.crear(ws);
  ok(arbol, 'debería poder aislarse');
  fs.writeFileSync(path.join(arbol.wsDir, 'nota.txt'), 'del agente\n');
  const f = await arbolesMod.fusionar(arbol);
  eq(f.ok, true, 'debería fusionar: ' + f.conflicto);
  eq(f.vacio, undefined, 'no puede decir que no hubo cambios: el agente escribió');
  eq(f.archivos.join(','), 'ignorada/nota.txt', 'el archivo ignorado viaja en el parche');
  eq(fs.readFileSync(path.join(ws, 'nota.txt'), 'utf8'), 'del agente\n', 'y llega a la carpeta del usuario');
  await arbolesMod.descartar(arbol);
  eq(arbolesMod.vivos().length, 0, 'no debe quedar ningún árbol en pie');
});

/* ---------- La barrera de comandos no depende de CÓMO se escriba la orden ---------- */
/* La auditoría encontró tres evasiones reales: la bandera delante (`format /q c:`),
   los acentos de cmd.exe (`^f^o^r^m^a^t`) y una segunda orden en otra línea. Además,
   el comodín dejaba fuera `del /s /q C:\*`, que borra la raíz igual que `C:\`. */
const comandos = require('../agent/comandos');

test('comandos: las evasiones de cmd no esquivan los prohibidos', () => {
  const casos = [
    'format /q c:',
    '^f^o^r^m^a^t c: /q',
    'echo hola\nformat c: /q',
    'del /s /q C:\\*',
    'rd /s /q C:\\*',
  ];
  for (const c of casos) eq(comandos.clasificar(c).nivel, 'prohibido', JSON.stringify(c));
});

test('comandos: lo inocente sigue siendo inocente', () => {
  for (const c of ['echo 2^2', 'echo "format c: /q"', 'echo format c: /q', 'start notepad', 'echo "^f^o^r^m^a^t"', 'del *.txt']) {
    eq(comandos.clasificar(c).nivel, 'normal', JSON.stringify(c));
  }
});

/* ---------- La tarjeta enseña lo que se va a ejecutar ---------- */
const { Guardrails, summarizeArgs } = require('../agent/guardrails');

test('tarjeta: run_command enseña la carpeta y las MCP sus argumentos', () => {
  const rc = summarizeArgs('run_command', { command: 'del *.txt', cwd: 'C:\\Users\\x\\Documents' });
  ok(rc.includes('del *.txt'), 'el comando sigue en el resumen');
  ok(rc.includes('C:\\Users\\x\\Documents'), 'y se ve dónde se ejecuta: ' + rc);

  const mcp = summarizeArgs('mcp__filesystem__write_file', {
    _mcp: { serverName: 'filesystem', toolName: 'write_file' },
    path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    content: 'x',
  });
  ok(mcp.includes('hosts'), 'se ve la ruta que toca: ' + mcp);
  ok(mcp.includes('filesystem'), 'y de qué servidor viene');
  eq(mcp.includes('_mcp'), false, 'el campo interno no se enseña');
});

/* ---------- El estancamiento se mide por firma, no por nombre ---------- */
/* Seis lecturas de archivos DISTINTOS son seis pasos que avanzan; contar el nombre de
   la herramienta mataba turnos legítimos (leer seis archivos, rellenar seis pasos de un
   formulario). La misma firma repetida sí es un estancamiento. */
test('estancamiento: seis llamadas con argumentos distintos no se detienen', () => {
  const g = new Guardrails({ guardrails: { stallThreshold: 3 } });
  for (let i = 0; i < 6; i++) {
    ok(g.checkStall({ toolName: 'read_file', toolArgs: { path: `archivo-${i}.txt` } }).ok, 'la lectura #' + i + ' avanza');
  }
});

test('estancamiento: la misma firma repetida sí se detiene', () => {
  const g = new Guardrails({ guardrails: { stallThreshold: 3 } });
  const paso = () => g.checkStall({ toolName: 'read_file', toolArgs: { path: 'mismo.txt' } });
  ok(paso().ok, 'primera: progreso');
  ok(paso().ok, 'segunda: 1 sin progreso');
  ok(paso().ok, 'tercera: 2 sin progreso');
  ok(!paso().ok, 'cuarta: 3 sin progreso = estancamiento');
});

test('estancamiento: sin argumentos sigue valiendo el nombre (compatibilidad)', () => {
  const g = new Guardrails({ guardrails: { stallThreshold: 3 } });
  ok(g.checkStall({ toolName: 'read_file' }).ok);
  ok(g.checkStall({ toolName: 'read_file' }).ok);
  ok(g.checkStall({ toolName: 'read_file' }).ok);
  ok(!g.checkStall({ toolName: 'read_file' }).ok, 'tres repeticiones por nombre = estancamiento');
});
