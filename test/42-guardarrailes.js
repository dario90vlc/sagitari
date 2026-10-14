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
