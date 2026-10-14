'use strict';

/* v3.0 — Árboles de trabajo por subagente (hueco 6: aislamiento).

   El problema real que resuelve esto: el semáforo de recursos ya serializa las
   escrituras, pero N subagentes sobre EL MISMO árbol no se pisan solo a nivel de
   fichero — se pisan SEMÁNTICAMENTE. Dos especialistas trabajando en el mismo
   proyecto se leen el uno al otro los archivos a medio cambiar, y un refactor
   grande no se puede repartir de verdad.

   La respuesta estructural es un árbol de trabajo de git por subagente: cada uno
   ve el proyecto entero, escribe donde quiera, y al terminar sus cambios vuelven
   al árbol del usuario como UN PARCHE, que se verifica antes de aplicarse.

   Reglas de convivencia (lo que hace que esto no rompa nada):

   · Solo se usa si el proyecto ES un repositorio git y hay un commit del que
     partir. Si no, el subagente trabaja sobre el árbol compartido como siempre:
     la ausencia de git nunca deja una delegación sin hacer.
   · Se parte del estado REAL del usuario —cambios sin commitear incluidos— vía
     `git stash create`, que crea un commit con el árbol de trabajo sin tocar
     nada. Con el árbol limpio se parte de HEAD. Así el subagente no ve una
     versión antigua del proyecto y no «deshace» sin querer lo que había a medias.
   · Los archivos sin seguimiento (los que git no conoce) se copian al árbol: si
     no, el subagente no vería un archivo nuevo que el usuario acaba de crear.
   · La fusión es VERIFICADA: se genera un parche con `--binary` y se comprueba
     con `git apply --check` ANTES de tocar nada (desde la RAÍZ del repositorio: ver
     `fusionar`). Si no entra limpio, no se aplica nada: se deja el árbol en pie y se
     dice dónde está para poder mirarlo.
   · Nunca se toca la historia del usuario: el árbol es detached y su baseline no
     es una referencia del repositorio.
   · El espacio de trabajo puede ser una SUBCARPETA del repositorio. El árbol es un
     checkout del repositorio ENTERO, así que la carpeta de trabajo del subagente es
     LA MISMA ruta relativa dentro del árbol (`dir`), no la raíz del árbol: si el
     usuario trabaja en `proyecto/`, el subagente trabaja en `<árbol>/proyecto`. Sin
     esto una ruta relativa significaba otra cosa que sin aislamiento y sus archivos
     acababan fuera de la carpeta del usuario (`wsDir`, ver `crear`).

   Todo con `git` explícito y sin shell, para que las rutas con espacios y acentos
   lleguen intactas. */

const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const datadir = require('./datadir');

const VIVEN = new Map(); // id -> { ws, dir, base }  (los que siguen en pie)

function nuevoId() {
  return 'arbol-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Ejecuta git SIN shell. Devuelve { code, stdout, stderr }; code -1 = no hay git. */
function git(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message) });
      return;
    }
    let out = '',
      err = '',
      done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code == null ? -1 : code));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(1);
    }, opts.timeout || 120000);
  });
}

/** ¿Se puede aislar este espacio de trabajo? (git disponible y con un commit). */
async function disponible(ws) {
  if (!ws) return false;
  try {
    if (!fs.statSync(ws).isDirectory()) return false;
  } catch {
    return false;
  }
  const dentro = await git(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 15000 });
  if (dentro.code !== 0 || String(dentro.stdout).trim() !== 'true') return false;
  const head = await git(['rev-parse', '--verify', 'HEAD'], ws, { timeout: 15000 });
  return head.code === 0;
}

/** Lista de archivos sin seguimiento del espacio de trabajo (rutas relativas). */
async function sinSeguimiento(ws) {
  const r = await git(['ls-files', '--others', '--exclude-standard', '-z'], ws);
  if (r.code !== 0) return [];
  return String(r.stdout).split('\0').filter(Boolean);
}

/**
 * Crea un árbol de trabajo aislado del estado ACTUAL del usuario.
 * Devuelve { id, ws, wsDir, rel, topLevel, dir, base, gitDir } — `wsDir` es la carpeta del
 * subagente dentro del árbol (= `ws` en rutas relativas) y `topLevel` la raíz del
 * repositorio contra la que se aplica el parche. Devuelve null si no se puede (y entonces
 * se trabaja sobre el árbol compartido, como antes).
 */
async function crear(ws, opts = {}) {
  if (!(await disponible(ws))) return null;
  const id = opts.id || nuevoId();
  /* El directorio de git del repositorio donde vive el espacio de trabajo. Se guarda para
     poder desmontar el árbol cuando el espacio de trabajo YA NO EXISTE (ver `podar`): es el
     caso que dejaba registros fantasma dentro del repositorio del usuario. */
  const gdir = await git(['rev-parse', '--absolute-git-dir'], ws, { timeout: 15000 });
  const gitDir = gdir.code === 0 ? String(gdir.stdout).trim() : '';
  /* Dónde cae el espacio de trabajo DENTRO del repositorio: `''` si el espacio de trabajo
     ES la raíz. El árbol es un checkout del repositorio entero (ver la cabecera), así que
     la carpeta del subagente es `dir` con esta misma ruta relativa — no la raíz del
     árbol—. Se calcula antes de crear nada: si el espacio de trabajo no cae dentro del
     árbol (una ruta con enlaces que git resuelve de otra forma), no se aísla y se trabaja
     sobre el árbol compartido, que es el camino seguro. */
  const top = await git(['rev-parse', '--show-toplevel'], ws, { timeout: 15000 });
  const topLevel = top.code === 0 ? path.resolve(String(top.stdout).trim()) : '';
  const rel = topLevel ? path.relative(topLevel, path.resolve(ws)) : '';
  if (!topLevel || rel.split(path.sep)[0] === '..') return null;
  const dir = path.join(os.tmpdir(), 'sagitari-arboles', id);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(path.dirname(dir), { recursive: true }).catch(() => {});

  // `stash create` devuelve el sha de un commit con el árbol de trabajo real
  // (incluidos los cambios ya preparados) SIN tocar ni la rama ni el índice.
  // Con el árbol limpio no devuelve nada: entonces se parte de HEAD.
  let base = '';
  const stash = await git(['stash', 'create'], ws);
  if (stash.code === 0 && String(stash.stdout).trim()) base = String(stash.stdout).trim();
  else {
    const head = await git(['rev-parse', 'HEAD'], ws);
    if (head.code !== 0) return null;
    base = String(head.stdout).trim();
  }

  const add = await git(['worktree', 'add', '--detach', dir, base], ws);
  if (add.code !== 0) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await podar({ gitDir }); // el add pudo registrar el árbol antes de fallar
    return null;
  }

  /* La carpeta del subagente dentro del árbol, y lo que el árbol no trae de git. */
  const wsDir = rel ? path.join(dir, rel) : dir;
  await fsp.mkdir(wsDir, { recursive: true }).catch(() => {});
  // los archivos que git no conoce no viajan en el commit: se copian a mano
  for (const sinTrackear of await sinSeguimiento(ws)) {
    const src = path.join(ws, sinTrackear);
    const dst = path.join(dir, rel, sinTrackear);
    try {
      const st = await fsp.lstat(src);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
    } catch {}
  }

  /* Línea base: un commit DENTRO del árbol con el estado exacto de partida,
     incluidos los archivos sin seguimiento que se acaban de copiar. Sin esto el
     parche final incluía esos archivos como «nuevos» (estaban fuera del índice) y
     la fusión fallaba con «nuevo.txt does not exist in index»: ruido del usuario
     presentado como trabajo del subagente. Con la línea base, el parche contiene
     SOLO lo que cambió el subagente. */
  await git(['add', '-A'], dir);
  const commit = await git(
    [
      '-c',
      'user.email=sagitari@local',
      '-c',
      'user.name=SAGITARI',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'linea base de SAGITARI',
    ],
    dir,
  );
  if (commit.code === 0) {
    const rev = await git(['rev-parse', 'HEAD'], dir);
    if (rev.code === 0) base = String(rev.stdout).trim();
  }

  const arbol = { id, ws, wsDir, rel, topLevel, dir, base, gitDir, creado: Date.now() };
  VIVEN.set(id, arbol);
  return arbol;
}

/**
 * Fusiona lo que hizo el subagente en el árbol con el del usuario.
 * Devuelve { ok, vacio, archivos, conflicto, parche } — y NUNCA aplica nada si
 * la comprobación previa falla.
 *
 * `archivos` viene en rutas relativas a la RAÍZ del árbol (= raíz del repositorio).
 *
 * opts.preparar(archivosRel) se llama justo antes de aplicar: es el gancho para
 * que el usuario pueda deshacer la fusión como cualquier otro cambio del turno.
 */
async function fusionar(arbol, opts = {}) {
  if (!arbol) return { ok: false, vacio: true, archivos: [], conflicto: 'no hay árbol' };
  const { ws, dir, base } = arbol;
  /* `git apply` corre en la RAÍZ DEL REPOSITORIO, no en el espacio de trabajo: desde una
     subcarpeta, git IGNORA los caminos del parche que caen fuera de ella y sale con código
     0. Con el espacio de trabajo en una subcarpeta (`proyecto/`) eso significaba «fusión
     correcta» sin aplicar NADA: el trabajo del subagente se quedaba en el árbol y se
     descartaba en silencio. El parche se generó contra la raíz del árbol, así que se aplica
     contra la raíz del árbol, que es donde los caminos significan lo mismo. */
  const raiz = arbol.topLevel || ws;
  const add = await git(['add', '-A'], dir);
  if (add.code !== 0) return { ok: false, archivos: [], conflicto: 'no se pudo preparar el árbol: ' + (add.stderr || add.stdout).trim() };

  const diff = await git(['diff', '--cached', '--binary', base], dir, { timeout: 120000 });
  if (diff.code !== 0) return { ok: false, archivos: [], conflicto: 'no se pudo calcular el parche: ' + (diff.stderr || '').trim() };
  const parche = String(diff.stdout);
  if (!parche.trim()) return { ok: true, vacio: true, archivos: [], parche: '' };

  const nombres = await git(['diff', '--cached', '--name-only', base], dir);
  const archivos = String(nombres.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const tmp = path.join(os.tmpdir(), 'sagitari-arboles', arbol.id + '.patch');
  await fsp.mkdir(path.dirname(tmp), { recursive: true }).catch(() => {});
  await fsp.writeFile(tmp, parche, 'utf8');

  /* Se comprueba ANTES de tocar el árbol del usuario: si no entra limpio, no se
     aplica nada (mejor un conflicto visible que un árbol a medias).

     SIN `--3way` a propósito: esa opción compara contra el ÍNDICE del usuario, y el
     usuario tiene cambios sin preparar —o sea, la comparación es contra una versión
     antigua del archivo y fallaba siempre («does not match index»). `git apply` a
     secas compara contra el archivo tal y como está en el disco, que es justo lo que
     hay que respetar; y si el usuario lo ha tocado por medio, el contexto ya no
     cuadra y sale un conflicto honesto. */
  const check = await git(['apply', '--check', '--whitespace=nowarn', tmp], raiz);
  if (check.code !== 0) {
    arbol.parche = tmp;
    return {
      ok: false,
      archivos,
      parche: tmp,
      conflicto: (check.stderr || check.stdout || '').trim() || 'el parche no entra limpio',
    };
  }
  if (opts.preparar) {
    try {
      opts.preparar(archivos);
    } catch {}
  }
  const apply = await git(['apply', '--whitespace=nowarn', tmp], raiz);
  return {
    ok: apply.code === 0,
    archivos,
    parche: tmp,
    conflicto: apply.code === 0 ? null : (apply.stderr || apply.stdout || '').trim() || 'git apply falló',
  };
}

/** Poda los registros de árboles cuya carpeta ya no está. Se llama SOLO cuando el
    desmontaje normal no pudo correr: si el comando de git falla (el espacio de trabajo
    desapareció bajo los pies, git no está en el PATH, la carpeta está bloqueada), el
    registro se queda dentro del repositorio DEL USUARIO y `git worktree list` acumula
    fantasmas. La poda va contra el DIRECTORIO DE GIT y corre desde el temporal: es lo único
    que sigue existiendo cuando lo que falla es, precisamente, el espacio de trabajo. */
async function podar(arbol) {
  if (!arbol || !arbol.gitDir) return;
  await git(['--git-dir', arbol.gitDir, 'worktree', 'prune'], os.tmpdir(), { timeout: 15000 });
}

/** Conserva el árbol para que el usuario pueda mirarlo SIN dejar su registro dentro del
    repositorio DEL USUARIO: se MUEVE a la carpeta de datos de la app (fuera del control de
    git) y se poda la entrada de `.git/worktrees` — con la carpeta ya fuera de su sitio
    original, `git worktree prune` la quita. Conservar el DIRECTORIO no obliga a conservar
    el REGISTRO: cada conflicto dejaba un `arbol-<id>` fantasma para siempre, y ningún
    camino del código volvía a llamar a `descartar` para él (el árbol sale de VIVEN). */
async function conservarFueraDeGit(arbol) {
  const destino = path.join(datadir.dataDir(), 'arboles', arbol.id);
  let movido = false;
  try {
    await fsp.rm(destino, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(destino), { recursive: true });
    await fsp.rename(arbol.dir, destino); // casi siempre el mismo disco: instantáneo
    movido = true;
  } catch {
    try {
      await fsp.cp(arbol.dir, destino, { recursive: true, force: true });
      await fsp.rm(arbol.dir, { recursive: true, force: true });
      movido = true;
    } catch {}
  }
  arbol.conservado = true;
  if (!movido) return; // no se pudo mover: se queda donde estaba (peor sitio, pero intacto)
  /* El `.git` del árbol apunta al registro que se acaba de podar: si se queda, la carpeta
     conservada parece un árbol de trabajo roto en vez de una copia para mirar. */
  await fsp.rm(path.join(destino, '.git'), { force: true, recursive: true }).catch(() => {});
  arbol.conservadoDir = destino;
  arbol.dir = destino;
  await podar(arbol);
}

/** Desmonta el árbol (siempre se llama, haya ido bien o mal la fusión). */
async function descartar(arbol, opts = {}) {
  if (!arbol) return;
  VIVEN.delete(arbol.id);
  if (opts.conservar) {
    // un conflicto merece que el usuario pueda mirar el árbol antes de perderlo, pero sin
    // dejar el registro dentro de su repositorio (ver `conservarFueraDeGit`)
    await conservarFueraDeGit(arbol);
    return arbol.conservadoDir ? { conservadoEn: arbol.conservadoDir } : {};
  }
  /* Primero el camino normal. Si el comando no puede correr —el espacio de trabajo ya no
     existe, git no está en el PATH, la carpeta está bloqueada— el registro del árbol no se
     puede quedar dentro del repositorio DEL USUARIO: se reintenta contra el directorio de
     git, que sigue en pie aunque el espacio de trabajo se haya ido. */
  const quitado = await git(['worktree', 'remove', '--force', arbol.dir], arbol.ws);
  await fsp.rm(arbol.dir, { recursive: true, force: true }).catch(() => {});
  if (quitado.code !== 0) {
    if (arbol.gitDir) await git(['--git-dir', arbol.gitDir, 'worktree', 'remove', '--force', arbol.dir], os.tmpdir(), { timeout: 15000 });
    await podar(arbol); // y sin carpeta que conservar, la poda cierra el caso
  }
  try {
    await fsp.rm(arbol.parche, { force: true });
  } catch {}
}

/** Cuántos árboles siguen en pie (diagnóstico y pruebas). */
function vivos() {
  return Array.from(VIVEN.values());
}

module.exports = { disponible, crear, fusionar, descartar, vivos, sinSeguimiento, __test: { _reset: () => VIVEN.clear() } };
