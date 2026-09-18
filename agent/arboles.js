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
     con `git apply --check --3way` ANTES de tocar nada. Si no entra limpio, no se
     aplica nada: se deja el árbol en pie y se dice dónde está para poder mirarlo.
   · Nunca se toca la historia del usuario: el árbol es detached y su baseline no
     es una referencia del repositorio.

   Todo con `git` explícito y sin shell, para que las rutas con espacios y acentos
   lleguen intactas. */

const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const VIVEN = new Map();   // id -> { ws, dir, base }  (los que siguen en pie)

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
    let out = '', err = '', done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code == null ? -1 : code));
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(1); }, opts.timeout || 120000);
  });
}

/** ¿Se puede aislar este espacio de trabajo? (git disponible y con un commit). */
async function disponible(ws) {
  if (!ws) return false;
  try {
    if (!fs.statSync(ws).isDirectory()) return false;
  } catch { return false; }
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
 * Devuelve { id, ws, dir, base } o null si no se puede (y entonces se trabaja
 * sobre el árbol compartido, como antes).
 */
async function crear(ws, opts = {}) {
  if (!(await disponible(ws))) return null;
  const id = opts.id || nuevoId();
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
    return null;
  }

  // los archivos que git no conoce no viajan en el commit: se copian a mano
  for (const rel of await sinSeguimiento(ws)) {
    const src = path.join(ws, rel);
    const dst = path.join(dir, rel);
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
  const commit = await git([
    '-c', 'user.email=sagitari@local', '-c', 'user.name=SAGITARI', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', 'linea base de SAGITARI',
  ], dir);
  if (commit.code === 0) {
    const rev = await git(['rev-parse', 'HEAD'], dir);
    if (rev.code === 0) base = String(rev.stdout).trim();
  }

  const arbol = { id, ws, dir, base, creado: Date.now() };
  VIVEN.set(id, arbol);
  return arbol;
}

/**
 * Fusiona lo que hizo el subagente en el árbol con el del usuario.
 * Devuelve { ok, vacio, archivos, conflicto, parche } — y NUNCA aplica nada si
 * la comprobación previa falla.
 *
 * opts.preparar(archivosRel) se llama justo antes de aplicar: es el gancho para
 * que el usuario pueda deshacer la fusión como cualquier otro cambio del turno.
 */
async function fusionar(arbol, opts = {}) {
  if (!arbol) return { ok: false, vacio: true, archivos: [], conflicto: 'no hay árbol' };
  const { ws, dir, base } = arbol;
  const add = await git(['add', '-A'], dir);
  if (add.code !== 0) return { ok: false, archivos: [], conflicto: 'no se pudo preparar el árbol: ' + (add.stderr || add.stdout).trim() };

  const diff = await git(['diff', '--cached', '--binary', base], dir, { timeout: 120000 });
  if (diff.code !== 0) return { ok: false, archivos: [], conflicto: 'no se pudo calcular el parche: ' + (diff.stderr || '').trim() };
  const parche = String(diff.stdout);
  if (!parche.trim()) return { ok: true, vacio: true, archivos: [], parche: '' };

  const nombres = await git(['diff', '--cached', '--name-only', base], dir);
  const archivos = String(nombres.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);

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
  const check = await git(['apply', '--check', '--whitespace=nowarn', tmp], ws);
  if (check.code !== 0) {
    arbol.parche = tmp;
    return {
      ok: false, archivos, parche: tmp,
      conflicto: (check.stderr || check.stdout || '').trim() || 'el parche no entra limpio',
    };
  }
  if (opts.preparar) { try { opts.preparar(archivos); } catch {} }
  const apply = await git(['apply', '--whitespace=nowarn', tmp], ws);
  return {
    ok: apply.code === 0,
    archivos,
    parche: tmp,
    conflicto: apply.code === 0 ? null : ((apply.stderr || apply.stdout || '').trim() || 'git apply falló'),
  };
}

/** Desmonta el árbol (siempre se llama, haya ido bien o mal la fusión). */
async function descartar(arbol, opts = {}) {
  if (!arbol) return;
  VIVEN.delete(arbol.id);
  if (opts.conservar) {
    // un conflicto merece que el usuario pueda mirar el árbol antes de perderlo
    arbol.conservado = true;
    return;
  }
  await git(['worktree', 'remove', '--force', arbol.dir], arbol.ws).catch(() => {});
  await fsp.rm(arbol.dir, { recursive: true, force: true }).catch(() => {});
  try { await fsp.rm(arbol.parche, { force: true }); } catch {}
}

/** Cuántos árboles siguen en pie (diagnóstico y pruebas). */
function vivos() { return Array.from(VIVEN.values()); }

module.exports = { disponible, crear, fusionar, descartar, vivos, sinSeguimiento, __test: { _reset: () => VIVEN.clear() } };
