'use strict';

/* ============================================================================
   proyecto.js — el perfil del proyecto del espacio de trabajo.

   Un agente que no sabe cómo se comprueba el proyecto donde trabaja escribe a
   ciegas: da por bueno lo que acaba de teclear y el error aparece tres pasos
   después (o en manos del usuario). Esto mira qué hay en la carpeta y deduce:

     · con qué se ejecutan los TESTS, la COMPILACIÓN y el LINT
     · cómo comprobar la SINTAXIS de un archivo recién escrito, por extensión

   Con eso, el agente recibe en el prompt el bloque PROYECTO (una vez, corto) y
   cada escritura se comprueba al momento: el error vuelve en el MISMO paso, que
   es cuando el modelo todavía tiene el contexto para arreglarlo.

   Es PURO (no lanza procesos): decide QUÉ comprobar y devuelve el comando;
   quien lo ejecuta es el ejecutor, que ya sabe matar procesos y usar el Node
   que la app trae dentro. Así se puede probar sin depender de lo que haya
   instalado en el equipo.
   ============================================================================ */

const fs = require('fs');
const path = require('path');

/* --------------------------------------------------------------------------- *
 *  Comprobación de sintaxis por extensión
 *  `prog` + `extraArgs`: al ejecutar se le añade la ruta del archivo.
 *  json: se valida en el propio proceso (JSON.parse), sin lanzar nada.
 * --------------------------------------------------------------------------- */
const SINTAXIS = {
  '.js':   { etiqueta: 'JavaScript', prog: 'node', extraArgs: ['--check'] },
  '.mjs':  { etiqueta: 'JavaScript', prog: 'node', extraArgs: ['--check'] },
  '.cjs':  { etiqueta: 'JavaScript', prog: 'node', extraArgs: ['--check'] },
  '.jsx':  { etiqueta: 'JavaScript', prog: 'node', extraArgs: ['--check'] },
  '.json': { etiqueta: 'JSON', json: true },
  '.py':   { etiqueta: 'Python', prog: 'python', extraArgs: ['-m', 'py_compile'] },
  '.rb':   { etiqueta: 'Ruby', prog: 'ruby', extraArgs: ['-c'] },
  '.php':  { etiqueta: 'PHP', prog: 'php', extraArgs: ['-l'] },
  '.sh':   { etiqueta: 'Shell', prog: 'bash', extraArgs: ['-n'] },
  '.bash': { etiqueta: 'Shell', prog: 'bash', extraArgs: ['-n'] },
  '.go':   { etiqueta: 'Go', prog: 'gofmt', extraArgs: ['-e'] },
};

/** Descriptor para comprobar la sintaxis de un archivo, o null si no se sabe. */
function comprobacionSintaxis(archivo) {
  const ext = String(path.extname(String(archivo || ''))).toLowerCase();
  const c = SINTAXIS[ext];
  if (!c) return null;
  return c.json ? { etiqueta: c.etiqueta, json: true } : { etiqueta: c.etiqueta, prog: c.prog, extraArgs: c.extraArgs.slice() };
}

/** ¿Qué extensiones sabemos comprobar? (para el prompt y los tests) */
function extensionesCubiertas() { return Object.keys(SINTAXIS); }

/* --------------------------------------------------------------------------- *
 *  Detección del perfil
 * --------------------------------------------------------------------------- */

function leerJSON(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; }
}
function hay(dir, nombre) {
  try { return fs.existsSync(path.join(dir, nombre)); } catch { return false; }
}
function glob1(dir, re) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && re.test(e.name)).map(e => e.name); }
  catch { return []; }
}

/** Gestor de paquetes de Node por el fichero de bloqueo (npm si no hay ninguno). */
function gestorNode(dir) {
  if (hay(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (hay(dir, 'yarn.lock')) return 'yarn';
  if (hay(dir, 'bun.lockb') || hay(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

/** Comando de un script de package.json, con el gestor que toque. */
function scriptDe(dir, gestor, nombre) {
  const pkg = leerJSON(path.join(dir, 'package.json'));
  const s = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
  if (!s || typeof s[nombre] !== 'string' || !s[nombre].trim()) return null;
  return nombre === 'test' ? `${gestor} test` : `${gestor} run ${nombre}`;
}

/**
 * Perfil del proyecto del espacio de trabajo.
 * Devuelve { raiz, tipos, gestor, tests, build, lint, indicadores } — todo lo que
 * no se haya podido deducir va a null.
 */
function detectar(workspace) {
  const dir = workspace;
  const p = { raiz: dir, tipos: [], gestor: null, tests: null, build: null, lint: null, indicadores: [] };
  if (!dir || !fs.existsSync(dir)) return p;

  /* ---- Node / JavaScript / TypeScript ---- */
  if (hay(dir, 'package.json')) {
    p.tipos.push('node');
    p.gestor = gestorNode(dir);
    p.indicadores.push('package.json');
    p.tests = scriptDe(dir, p.gestor, 'test');
    p.build = scriptDe(dir, p.gestor, 'build');
    p.lint = scriptDe(dir, p.gestor, 'lint');
    // TypeScript: los tipos se comprueban con su tsconfig, no archivo a archivo
    if (hay(dir, 'tsconfig.json')) {
      p.tipos.push('typescript');
      p.indicadores.push('tsconfig.json');
      const local = hay(dir, path.join('node_modules', '.bin', 'tsc'));
      if (!p.build) p.build = (local ? `${p.gestor} exec tsc --noEmit` : 'npx tsc --noEmit');
    }
  }

  /* ---- Python ---- */
  const pyCfg = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'tox.ini', 'pytest.ini'].filter(n => hay(dir, n));
  if (pyCfg.length) {
    p.tipos.push('python');
    p.indicadores.push(...pyCfg);
    const pytest = hay(dir, 'pytest.ini') || hay(dir, 'tox.ini') || pyCfg.includes('pyproject.toml');
    p.tests = pytest ? 'python -m pytest -q' : 'python -m unittest';
    const lint = ['ruff.toml', '.ruff.toml', '.flake8'].find(n => hay(dir, n));
    if (lint) { p.indicadores.push(lint); p.lint = lint.includes('ruff') ? 'ruff check .' : 'flake8'; }
  }

  /* ---- Go ---- */
  if (hay(dir, 'go.mod')) {
    p.tipos.push('go');
    p.indicadores.push('go.mod');
    p.tests = p.tests || 'go test ./...';
    p.build = p.build || 'go build ./...';
    p.lint = p.lint || 'go vet ./...';
  }

  /* ---- Rust ---- */
  if (hay(dir, 'Cargo.toml')) {
    p.tipos.push('rust');
    p.indicadores.push('Cargo.toml');
    p.tests = p.tests || 'cargo test';
    p.build = p.build || 'cargo build';
    p.lint = p.lint || 'cargo clippy -q';
  }

  /* ---- .NET ---- */
  const dotnet = glob1(dir, /\.(sln|csproj|fsproj)$/i);
  if (dotnet.length) {
    p.tipos.push('dotnet');
    p.indicadores.push(dotnet[0]);
    p.tests = p.tests || 'dotnet test';
    p.build = p.build || 'dotnet build';
  }

  /* ---- Java / JVM ---- */
  if (hay(dir, 'pom.xml')) {
    p.tipos.push('java');
    p.indicadores.push('pom.xml');
    p.tests = p.tests || 'mvn -q test';
    p.build = p.build || 'mvn -q package -DskipTests';
  } else if (glob1(dir, /^build\.gradle(\.kts)?$/).length) {
    p.tipos.push('java');
    p.indicadores.push('build.gradle');
    p.tests = p.tests || 'gradle test';
    p.build = p.build || 'gradle build';
  }

  /* ---- PHP / Ruby ---- */
  if (hay(dir, 'composer.json')) {
    const pkg = leerJSON(path.join(dir, 'composer.json'));
    p.tipos.push('php');
    p.indicadores.push('composer.json');
    if (pkg && pkg.scripts && pkg.scripts.test) p.tests = p.tests || 'composer test';
  }
  if (hay(dir, 'Gemfile') || hay(dir, 'Rakefile')) {
    p.tipos.push('ruby');
    p.indicadores.push(hay(dir, 'Gemfile') ? 'Gemfile' : 'Rakefile');
    if (hay(dir, 'spec')) p.tests = p.tests || 'bundle exec rspec';
    else if (hay(dir, 'Rakefile')) p.tests = p.tests || 'bundle exec rake test';
  }

  /* ---- Makefile: solo si declara el objetivo (un `make` a secas puede hacer cualquier cosa) */
  if (hay(dir, 'Makefile') || hay(dir, 'makefile')) {
    const mk = ['Makefile', 'makefile'].find(n => hay(dir, n));
    try {
      const txt = fs.readFileSync(path.join(dir, mk), 'utf8');
      if (/^test:/m.test(txt)) { p.tests = p.tests || 'make test'; p.indicadores.push(mk); }
      if (/^build:/m.test(txt)) p.build = p.build || 'make build';
    } catch {}
  }

  return p;
}

/* El perfil se relee cuando cambian los indicadores, no en cada turno: leer el
   package.json en cada prompt es barato, pero el agente lo pide varias veces por
   turno (prompt, cierre, revisión) y no tiene por qué cambiar en medio. */
let cache = null;   // { raiz, firma, perfil }

/** Firma barata: nombres + mtime/tamaño de los indicadores que pueden cambiar. */
function firma(dir) {
  const nombres = ['package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
    'pytest.ini', 'tox.ini', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'composer.json', 'Gemfile', 'Rakefile', 'Makefile', 'makefile', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  const partes = [];
  for (const n of nombres) {
    try { const s = fs.statSync(path.join(dir, n)); partes.push(n + ':' + s.mtimeMs + ':' + s.size); } catch {}
  }
  const otros = glob1(dir, /\.(sln|csproj|fsproj)$/i).sort().join(',');
  return partes.join('|') + '|' + otros;
}

/** Perfil con caché: se recalcula solo si cambió alguno de los indicadores. */
function perfil(workspace) {
  const dir = workspace;
  if (!dir) return detectar(dir);
  const f = firma(dir);
  if (cache && cache.raiz === dir && cache.firma === f) return cache.perfil;
  const p = detectar(dir);
  cache = { raiz: dir, firma: f, perfil: p };
  return p;
}

function _resetForTests() { cache = null; }

/* --------------------------------------------------------------------------- *
 *  Bloque para el prompt
 * --------------------------------------------------------------------------- */

/**
 * Texto corto con lo que se sabe del proyecto, o '' si no hay nada que decir.
 * Solo se nombran los comandos que EXISTEN: inventar un `npm test` en un
 * proyecto sin tests es peor que no decir nada.
 */
function bloquePrompt(workspace) {
  const p = perfil(workspace);
  if (!p.tipos.length) return '';
  const lineas = [`PROYECTO (${p.tipos.join(' + ')}${p.indicadores.length ? ' — ' + p.indicadores.slice(0, 4).join(', ') : ''}):`];
  if (p.tests) lineas.push(`- Tests: ${p.tests}  ← ejecútalo para verificar lo que cambias antes de dar algo por hecho.`);
  if (p.build) lineas.push(`- Compilación/tipos: ${p.build}`);
  if (p.lint) lineas.push(`- Lint: ${p.lint}`);
  lineas.push('- Al escribir código se comprueba sola la SINTAXIS, y además pasan los comprobadores del proyecto sobre lo que has cambiado: si te llega un error, arréglalo en el mismo turno (los que ya estaban en el archivo antes de que lo tocaras se te dicen aparte: no los arregles salvo que se te pida).');
  if (p.tests || p.build) lineas.push('- Al terminar el turno, la comprobación de arriba se EJECUTA sobre lo que hay en disco; si falla, se te devuelve la salida y tienes que arreglarlo antes de cerrar.');
  return lineas.join('\n');
}

module.exports = {
  detectar, perfil, firma, bloquePrompt, comprobacionSintaxis, extensionesCubiertas, _resetForTests,
};
