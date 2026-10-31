'use strict';

/* ============================================================================
   git.js — git de verdad, con estructura (herramientas git_*).

   POR QUÉ: hoy el agente solo llega a git por `run_command`, y la salida de git
   es texto pensado para un humano. Para el modelo, `git status --porcelain` o
   un diff de 400 líneas son contexto caro que además hay que interpretar. Aquí
   se le da ya resuelto: rama, delante/detrás, lista de archivos con su estado,
   diff acotado y log de una línea por commit.

   REGLAS QUE NO SE NEGOCIAN (y por qué):
     · SIN SHELL y con argv: `execFile('git', [...])`. Un nombre de rama o una
       ruta con `&` o `"` jamás se convierte en otro comando.
     · SOLO el espacio de trabajo: nada de `-C` ni de rutas fuera del repo; la
       raíz la dice el propio git (`rev-parse --show-toplevel`).
     · NADA DESTRUCTIVO: no hay reset --hard, checkout --force, clean -f,
       push --force, rebase ni amend. No es una limitación accidental: son las
       operaciones que pierden trabajo del usuario y no se ofrecen detrás de una
       tarjeta de confirmación de un clic. Si hacen falta, las pide el usuario.
     · TOPES: toda salida se acota (un diff enorme no se come el contexto).
   ============================================================================ */

const { execFile } = require('child_process');
const path = require('path');
const { killTree } = require('./proc');
const { decodeOut } = require('./exec-util');
const i18n = require('./i18n');

const TIMEOUT_MS = 30000;
const MAX_BUFFER = 4 * 1024 * 1024; // tope de bytes que se bufferizan del proceso
const MAX_SALIDA = 20000; // caracteres que vuelven al modelo
const MAX_ARCHIVOS = 200; // entradas de `git_status` que se listan
const MAX_COMMITS = 100;
const COMUN = ['-c', 'core.quotepath=false', '--no-pager'];

/* --------------------------------------------------------------------------- *
 *  Ejecución
 * --------------------------------------------------------------------------- */

/**
 * Ejecuta git SIN shell y con argv. Nunca lanza: devuelve
 * `{code, stdout, stderr, matado, error}` (code === null = no se pudo lanzar).
 */
function git(args, opts = {}) {
  return new Promise((resolve) => {
    let termino = false,
      matado = false,
      timer = null;
    const acabar = (r) => {
      if (termino) return;
      termino = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = execFile(
        'git',
        args,
        {
          cwd: opts.workspace || undefined,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          encoding: 'buffer',
          // sin credenciales interactivas ni paginador colgado: esto no habla con nadie
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout, stderr) => {
          acabar({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: decodeOut(stdout || Buffer.alloc(0)),
            stderr: decodeOut(stderr || Buffer.alloc(0)),
            matado,
            error: err || null,
          });
        },
      );
    } catch (e) {
      acabar({ code: null, stdout: '', stderr: String((e && e.message) || e), matado: false, error: e });
      return;
    }
    timer = setTimeout(() => {
      matado = true;
      try {
        killTree(child);
      } catch {}
      setTimeout(() => acabar({ code: null, stdout: '', stderr: '', matado: true, error: null }), 300);
    }, opts.timeoutMs || TIMEOUT_MS);
    if (opts.registerKillable) opts.registerKillable({ stop: () => killTree(child) });
  });
}

/** Recorta lo que se le devuelve al modelo, diciendo que se recortó. */
function acotar(texto, max = MAX_SALIDA) {
  const t = String(texto == null ? '' : texto);
  return t.length > max ? t.slice(0, max) + i18n.t('git.recortado', { max, total: t.length }) : t;
}

/** Primera línea con algo, para resumir el error de git sin el ruido de contexto. */
function motivo(r) {
  if (r.code === null) return i18n.t('git.no.encontrado');
  if (r.matado) return i18n.t('git.tiempo', { s: Math.round(TIMEOUT_MS / 1000) });
  const txt = String(r.stderr || '').trim();
  return txt || i18n.t('git.codigo', { codigo: r.code });
}

/** Comprueba que el espacio de trabajo es un repositorio y devuelve su raíz.
    Devuelve `{error}` (string, para el modelo) o `{raiz}`. */
async function raizDelRepo(workspace, opts) {
  if (!workspace || !String(workspace).trim()) return { error: i18n.err('git.sin.espacio') };
  const r = await git(['rev-parse', '--show-toplevel'], { ...opts, workspace });
  if (r.code !== 0) {
    if (r.code === null || /not a git repository/i.test(r.stderr)) {
      return { error: i18n.err('git.no.repo', { ruta: workspace }) };
    }
    return { error: i18n.err('git.leer.repo', { motivo: motivo(r) }) };
  }
  const raiz = String(r.stdout || '').trim();
  if (!raiz) return { error: i18n.err('git.sin.raiz') };
  return { raiz: path.resolve(raiz) };
}

/** ¿La ruta cae DENTRO del repositorio? (nada de ../ ni rutas absolutas de fuera) */
function dentroDe(raiz, p) {
  const rel = path.relative(raiz, path.resolve(raiz, String(p)));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* --------------------------------------------------------------------------- *
 *  git_status
 * --------------------------------------------------------------------------- */

const LETRAS = { M: 'modificado', A: 'añadido', D: 'borrado', R: 'renombrado', C: 'copiado', T: 'tipo cambiado', U: 'conflicto' };

function estadoHumano(x, y) {
  if (x === '?' && y === '?') return 'sin seguimiento (nuevo)';
  if (x === '!' || y === '!') return 'ignorado';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicto sin resolver';
  const partes = [];
  if (x !== ' ' && x !== '?' && x !== '!') partes.push('preparado: ' + (LETRAS[x] || x));
  if (y !== ' ' && y !== '?' && y !== '!') partes.push('sin preparar: ' + (LETRAS[y] || y));
  return partes.join(' / ') || 'sin cambios';
}

/** Cabecera `## …` del porcelain: rama, upstream y delante/detrás. */
function cabeceraRama(linea) {
  const t = linea.replace(/^##\s*/, '').trim();
  if (/^HEAD \(no branch\)/i.test(t)) return 'rama: (HEAD desacoplado, sin rama)';
  if (/^No commits yet on /i.test(t)) return `rama: ${t.replace(/^No commits yet on /i, '')} (todavía sin commits)`;
  const m = /^([^.\s]+)(?:\.\.\.(\S+))?(?:\s*\[(.+)\])?$/.exec(t);
  if (!m) return 'rama: ' + t;
  let s = `rama: ${m[1]}`;
  if (m[2]) s += ` → ${m[2]}`;
  if (m[3])
    s += ` (${m[3]
      .replace(/ahead (\d+)/i, 'delante $1')
      .replace(/behind (\d+)/i, 'detrás $1')
      .replace(/gone/i, 'remota desaparecida')})`;
  return s;
}

async function status(opts = {}) {
  const base = await raizDelRepo(opts.workspace, opts);
  if (base.error) return base.error;
  const r = await git([...COMUN, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], { ...opts, workspace: base.raiz });
  if (r.code !== 0) return i18n.err('git.status.fallo', { motivo: motivo(r) });

  const lineas = String(r.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean);
  const cabecera = lineas.find((l) => l.startsWith('## '));
  const archivos = lineas.filter((l) => !l.startsWith('## '));
  const out = [`Repositorio: ${base.raiz}`];
  out.push(cabecera ? cabeceraRama(cabecera) : 'rama: (git no la indicó)');
  if (!archivos.length) {
    out.push('Sin cambios: el árbol de trabajo está limpio.');
    return out.join('\n');
  }
  out.push(`Cambios (${archivos.length}):`);
  for (const l of archivos.slice(0, MAX_ARCHIVOS)) {
    const x = l[0] || ' ',
      y = l[1] || ' ';
    out.push(`  ${x}${y} ${estadoHumano(x, y)} — ${l.slice(3)}`);
  }
  if (archivos.length > MAX_ARCHIVOS) out.push(`  … (y ${archivos.length - MAX_ARCHIVOS} archivo(s) más)`);
  return out.join('\n');
}

/* --------------------------------------------------------------------------- *
 *  git_diff
 * --------------------------------------------------------------------------- */

async function diff(args = {}, opts = {}) {
  const base = await raizDelRepo(opts.workspace, opts);
  if (base.error) return base.error;
  const argv = [...COMUN, 'diff', '--no-color'];
  if (args.staged === true) argv.push('--cached');
  if (args.stat === true) argv.push('--stat');
  if (args.path) {
    if (!dentroDe(base.raiz, args.path)) {
      return i18n.err('git.ruta.fuera', { ruta: args.path, raiz: base.raiz });
    }
    argv.push('--', String(args.path));
  }
  const r = await git(argv, { ...opts, workspace: base.raiz });
  if (r.code !== 0) return i18n.err('git.diff.fallo', { motivo: motivo(r) });
  const texto = String(r.stdout || '').trim();
  const ambito = `${args.path ? ` en ${args.path}` : ''}${args.staged === true ? ' (preparado)' : ' (sin preparar)'}`;
  if (!texto) {
    return args.staged === true
      ? `Sin diferencias preparadas${ambito}: no hay nada en el índice que no esté ya en el último commit.`
      : `Sin diferencias${ambito}: no hay cambios en el árbol de trabajo${args.path ? ' para ese archivo' : ''}.`;
  }
  return acotar(`diff${ambito}:\n${texto}`);
}

/* --------------------------------------------------------------------------- *
 *  git_log
 * --------------------------------------------------------------------------- */

async function log(args = {}, opts = {}) {
  const base = await raizDelRepo(opts.workspace, opts);
  if (base.error) return base.error;
  const n = Math.min(Math.max(Math.floor(Number(args.n) || 20), 1), MAX_COMMITS);
  const r = await git([...COMUN, 'log', `--max-count=${n}`, '--date=short', '--pretty=format:%h %ad %s'], {
    ...opts,
    workspace: base.raiz,
  });
  if (r.code !== 0) {
    if (/does not have any commits yet|unknown revision|ambiguous argument 'HEAD'/i.test(r.stderr || '')) {
      return 'El repositorio todavía no tiene ningún commit (no hay historia que enseñar).';
    }
    return i18n.err('git.log.fallo', { motivo: motivo(r) });
  }
  const texto = String(r.stdout || '').trim();
  if (!texto) return 'El repositorio todavía no tiene ningún commit.';
  const lineas = texto.split(/\r?\n/);
  return acotar(`Últimos ${lineas.length} commit(s) (hash fecha asunto):\n${texto}`);
}

/* --------------------------------------------------------------------------- *
 *  git_branch
 * --------------------------------------------------------------------------- */

/** Nombre de rama aceptable para git sin sorpresas (nada que empiece por `-`). */
function nombreValido(n) {
  const s = String(n || '').trim();
  if (!s) return i18n.t('git.rama.sin.nombre');
  if (s.startsWith('-')) return i18n.t('git.rama.guion');
  /* Los caracteres de control (\x00-\x1f) son justo lo que git prohíbe en un ref: el
     aviso de ESLint es por el rango, no por un error — aquí es el punto de la regla. */
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f]/.test(s)) return i18n.t('git.rama.caracteres');
  if (s.includes('..') || s.includes('@{') || s.endsWith('.') || s.endsWith('/') || s.endsWith('.lock'))
    return i18n.t('git.rama.invalido');
  if (s === 'HEAD') return i18n.t('git.rama.head');
  return null;
}

async function branch(args = {}, opts = {}) {
  const base = await raizDelRepo(opts.workspace, opts);
  if (base.error) return base.error;
  const accion = String(args.action || 'list').toLowerCase();
  if (!['list', 'create', 'switch'].includes(accion)) {
    return i18n.err('git.rama.accion', { accion: args.action });
  }

  if (accion === 'list') {
    const lista = await git(['for-each-ref', '--format=%(HEAD)|%(refname:short)|%(upstream:short)', 'refs/heads'], {
      ...opts,
      workspace: base.raiz,
    });
    if (lista.code !== 0) return i18n.err('git.rama.listar', { motivo: motivo(lista) });
    const filas = String(lista.stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    const actual = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { ...opts, workspace: base.raiz });
    let rama = actual.code === 0 && actual.stdout.trim() && actual.stdout.trim() !== 'HEAD' ? actual.stdout.trim() : null;
    if (!rama) {
      // sin HEAD no se distingue «desacoplado» de «repo sin commits»: se pregunta
      const hay = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { ...opts, workspace: base.raiz });
      rama = hay.code === 0 ? '(HEAD desacoplado, sin rama)' : '(todavía sin commits)';
    }
    const out = [`Repositorio: ${base.raiz}`, `Rama actual: ${rama}`];
    if (!filas.length) {
      out.push('Todavía no hay ramas: el repositorio no tiene commits.');
      return out.join('\n');
    }
    out.push(`Ramas (${filas.length}):`);
    for (const f of filas) {
      const [marca, nombre, upstream] = f.split('|');
      if (!nombre) continue;
      out.push(`  ${marca === '*' ? '*' : ' '} ${nombre}${upstream ? ` → ${upstream}` : ''}`);
    }
    return out.join('\n');
  }

  const malo = nombreValido(args.name);
  if (malo) return i18n.err('git.rama.invalida', { motivo: malo });

  if (accion === 'create') {
    const r = await git(['branch', String(args.name).trim()], { ...opts, workspace: base.raiz });
    if (r.code !== 0) return i18n.err('git.rama.crear', { motivo: motivo(r) });
    const actual = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { ...opts, workspace: base.raiz });
    return `OK: rama «${String(args.name).trim()}» creada (sigues en ${actual.stdout.trim() || 'la rama actual'}, no he cambiado de rama).`;
  }

  const r = await git(['switch', String(args.name).trim()], { ...opts, workspace: base.raiz });
  if (r.code !== 0) {
    if (/is not a git command/i.test(r.stderr || '')) {
      return i18n.err('git.rama.switch.viejo', { rama: String(args.name).trim() });
    }
    return i18n.err('git.rama.cambiar', { motivo: motivo(r) });
  }
  return `OK: ahora estás en la rama «${String(args.name).trim()}».${String(r.stderr || '').trim() ? `\n${String(r.stderr).trim()}` : ''}`;
}

/* --------------------------------------------------------------------------- *
 *  git_commit
 * --------------------------------------------------------------------------- */

async function commit(args = {}, opts = {}) {
  const base = await raizDelRepo(opts.workspace, opts);
  if (base.error) return base.error;
  const mensaje = String(args.message == null ? '' : args.message).trim();
  if (!mensaje) return i18n.err('git.commit.sin.mensaje');
  if (mensaje.length > 5000) return i18n.err('git.commit.largo', { max: 5000 });

  const rutas = Array.isArray(args.paths) ? args.paths.map((p) => String(p).trim()).filter(Boolean) : [];
  for (const p of rutas) {
    if (!dentroDe(base.raiz, p)) return i18n.err('git.commit.fuera', { ruta: p, raiz: base.raiz });
  }

  /* Con rutas: se prepara SOLO lo pedido y se commitea SOLO eso (git lo permite con
     `-- <rutas>`, que deja el resto del índice como estaba). Sin rutas: se commitea
     exactamente lo que ya estaba preparado, sin tocar el índice. Nunca se hace `add -A`. */
  if (rutas.length) {
    const add = await git(['add', '--', ...rutas], { ...opts, workspace: base.raiz });
    if (add.code !== 0) return i18n.err('git.commit.preparar', { motivo: motivo(add) });
    const r = await git(['commit', '-m', mensaje, '--', ...rutas], { ...opts, workspace: base.raiz });
    return await cierreCommit(r, rutas, opts);
  }

  const preparado = await git(['diff', '--cached', '--quiet'], { ...opts, workspace: base.raiz });
  if (preparado.code === 0) {
    return 'No hay nada preparado para commitear: no he hecho `git add` de nada (no preparo archivos por mi cuenta). Prepara lo que quieras o pásame las rutas en paths.';
  }
  const r = await git(['commit', '-m', mensaje], { ...opts, workspace: base.raiz });
  return await cierreCommit(r, [], opts);
}

/** Cierra un commit: éxito con hash, o un motivo claro (nada que commitear, hooks…). */
async function cierreCommit(r, rutas, opts) {
  if (r.code !== 0) {
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(r.stdout + r.stderr)) {
      return `No había cambios que commitear${rutas.length ? ' en ' + rutas.join(', ') : ''}: el índice y el árbol están iguales que el último commit.`;
    }
    return i18n.err('git.commit.fallo', { motivo: motivo(r) });
  }
  const ref = await git(['rev-parse', '--short', 'HEAD'], { ...opts });
  if (ref.code !== 0) {
    // el commit SÍ entró: no se puede convertir un éxito en un error por no leer el hash
    return `OK: commit hecho${rutas.length ? ` (solo ${rutas.join(', ')})` : ''}.\n${String(r.stdout || '').trim()}`;
  }
  const resumen = String(r.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return `OK: commit ${ref.stdout.trim()} hecho${rutas.length ? ` (solo ${rutas.join(', ')})` : ''}.\n${resumen || ''}`.trim();
}

/* --------------------------------------------------------------------------- *
 *  Definiciones de herramientas (las registra tools.js, patrón de `delegate`)
 * --------------------------------------------------------------------------- */

function gitToolDefs() {
  const gitHint = 'Los comandos git_* trabajan sobre el repositorio del ESPACIO DE TRABAJO y nunca sobre otra ruta.';
  return [
    {
      type: 'function',
      function: {
        name: 'git_status',
        description: `Muestra el estado del repositorio ya interpretado: rama actual, relación con su remota (delante/detrás) y la lista de archivos cambiados diciendo si están preparados (staged), sin preparar o sin seguimiento. Es la forma barata de saber «¿qué hay sin guardar?». ${gitHint}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: `Muestra el diff del repositorio (acotado: si se recorta, lo dice). Sin argumentos: los cambios sin preparar. Con staged: true, lo que está preparado (lo que entraría en el commit). Con path: solo un archivo. Con stat: el resumen de líneas por archivo. ${gitHint}`,
        parameters: {
          type: 'object',
          properties: {
            staged: { type: 'boolean', description: 'Mirar lo PREPARADO (git diff --cached) en vez del árbol de trabajo' },
            path: { type: 'string', description: 'Ruta (relativa al repositorio) para limitar el diff a un archivo' },
            stat: { type: 'boolean', description: 'Resumen por archivo (cuántas líneas añadidas/borradas) en vez del diff completo' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_log',
        description: `Últimos commits, uno por línea: hash corto, fecha y asunto. Úsalo para saber qué se ha hecho últimamente o para buscar el commit del que hablar. ${gitHint}`,
        parameters: {
          type: 'object',
          properties: { n: { type: 'number', description: 'Cuántos commits (por defecto 20, máximo 100)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_branch',
        description: `Lista las ramas locales (action: list, por defecto) o crea (create) y cambia (switch) de rama. NO borra ni fuerza nada: eso se le pide al usuario. ${gitHint}`,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'switch'], description: 'list (por defecto), create o switch' },
            name: { type: 'string', description: 'Nombre de la rama (obligatorio para create y switch)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_commit',
        description: `Hace un commit. Con paths: prepara SOLO esos archivos y commitea SOLO esos (el resto del índice se queda como estaba). Sin paths: commitea exactamente lo que ya estuviera preparado, sin preparar nada por su cuenta (y si no hay nada preparado, lo dice). Nunca hace add -A, ni amend, ni toca la historia. ${gitHint}`,
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Mensaje del commit' },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Rutas (relativas al repositorio) que entran en el commit. Si no se pasan, se commitea lo ya preparado',
            },
          },
          required: ['message'],
        },
      },
    },
  ];
}

module.exports = {
  status,
  diff,
  log,
  branch,
  commit,
  gitToolDefs,
  nombreValido,
  dentroDe,
  estadoHumano,
  MAX_SALIDA,
};
