'use strict';

/* ============================================================================
   diagnosticos.js — lo que el PROYECTO sabe de lo que acabas de escribir.

   `proyecto.js` dice cómo se comprueba el proyecto y comprueba la SINTAXIS de
   cada archivo. Eso pilla un `}` de más, pero no pilla lo que de verdad rompe el
   trabajo: un tipo que no cuadra, una variable que no existe, un import que ya no
   apunta a nada. Eso solo lo sabe el comprobador del proyecto (tsc, eslint, ruff,
   mypy, go vet, clippy) y hasta ahora había que esperar al final del turno —o al
   usuario— para enterarse.

   Este módulo aporta las dos mitades que faltaban:

     · QUÉ comprobar sobre los archivos tocados, con el comando exacto (plan)
     · CÓMO leer la salida de cada herramienta, de verdad, con su formato real
       (parsear), y qué hallazgos son NUEVOS y cuáles ya estaban ahí (clasificar)

   Y una regla que vale para todo: un hallazgo que cae en una línea que el agente
   no ha tocado es PREEXISTENTE. Se cuenta, no se le exige. Culpar al agente del
   desorden que ya había en el archivo es la forma más rápida de que se ponga a
   refactorizar lo que nadie le pidió.

   Es PURO igual que `proyecto.js`: no lanza procesos ni escribe nada. Quien
   ejecuta los comandos es el ejecutor (que ya sabe matarlos y usar el Node que la
   app trae dentro).
   ============================================================================ */

const fs = require('fs');
const path = require('path');

/* --------------------------------------------------------------------------- *
 *  Qué se puede comprobar por archivo (y con qué)
 * --------------------------------------------------------------------------- */

function hay(dir, rel) {
  try { return fs.existsSync(path.join(dir, rel)); } catch { return false; }
}

/** ¿Hay config de ESLint en la raíz o algún package con el binario del proyecto? */
function eslintDisponible(ws) {
  if (hay(ws, path.join('node_modules', 'eslint', 'bin', 'eslint.js'))) return true;
  return ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc'].some(f => hay(ws, f));
}

const EXT_JS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro'];
const EXT_PY = ['.py', '.pyi'];

/**
 * Comprobadores POR ARCHIVO disponibles en este proyecto, con el comando exacto.
 *
 * Solo se propone lo que de verdad se puede ejecutar: si el binario o la config no
 * están, no se propone (y si al lanzarlo resulta que el equipo no lo tiene, el
 * ejecutor lo trata como «no hay con qué comprobar», nunca como un error del
 * código — ver `pareceFalloDeHerramienta`).
 *
 * @param {string} workspace raíz del proyecto
 * @param {string[]} archivos rutas (absolutas o relativas) que se acaban de escribir
 * @returns {Array<{id, etiqueta, formato, clase, entrada?, prog?, args, timeoutMs}>}
 */
function planPorArchivos(workspace, archivos = []) {
  const out = [];
  const ws = String(workspace || '');
  if (!ws) return out;
  const lista = (Array.isArray(archivos) ? archivos : [archivos]).filter(Boolean).map(String);
  const exts = new Set(lista.map(a => path.extname(a).toLowerCase()));

  /* ---- ESLint (JS/TS): el binario del proyecto, invocado con el Node del equipo ----
     Se llama al JS de ESLint, no al .cmd: así no hace falta shell y una ruta con
     espacios o acentos llega intacta. */
  if (EXT_JS.some(e => exts.has(e)) && eslintDisponible(ws)) {
    out.push({
      id: 'eslint', etiqueta: 'ESLint', formato: 'eslint', clase: 'node-entrada',
      entrada: path.join('node_modules', 'eslint', 'bin', 'eslint.js'),
      args: ['--format', 'json', '--no-color', '--no-error-on-unmatched-pattern'],
      timeoutMs: 25000,
    });
  }

  /* ---- Python: ruff (binario), flake8 y mypy (módulo). Solo si el proyecto lo declara. */
  if (EXT_PY.some(e => exts.has(e))) {
    const decl = () => {
      const pistas = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'setup.cfg', 'dev-requirements.txt'];
      return pistas.map(f => { try { return fs.readFileSync(path.join(ws, f), 'utf8'); } catch { return ''; } }).join('\n');
    };
    const texto = decl();
    if (hay(ws, 'ruff.toml') || hay(ws, '.ruff.toml') || /\bruff\b/.test(texto)) {
      out.push({ id: 'ruff', etiqueta: 'Ruff', formato: 'ruff', clase: 'comando', prog: 'ruff', args: ['check', '--output-format', 'concise', '--quiet'], timeoutMs: 20000 });
    }
    if (hay(ws, '.flake8') || /(^|\n)\s*flake8\b/.test(texto)) {
      out.push({ id: 'flake8', etiqueta: 'Flake8', formato: 'ruff', clase: 'py-modulo', modulo: 'flake8', args: ['--format', '%(path)s:%(row)d:%(col)d: %(code)s %(text)s'], timeoutMs: 20000 });
    }
    if (/mypy/.test(texto) || hay(ws, 'mypy.ini')) {
      out.push({ id: 'mypy', etiqueta: 'Mypy', formato: 'mypy', clase: 'py-modulo', modulo: 'mypy', args: ['--no-color-output', '--no-error-summary', '--show-error-codes'], timeoutMs: 30000 });
    }
  }

  return out.map(c => ({ ...c, args: c.args.slice() }));
}

/**
 * La comprobación de CIERRE: la que vale para todo el proyecto y por eso se ejecuta
 * una sola vez, cuando el agente ya terminó de escribir. Si hay pruebas, mandan las
 * pruebas; si no, la compilación/los tipos.
 *
 * @returns {{id, etiqueta, comando, formato, timeoutMs}|null}
 */
function planCierre(perfil) {
  const p = perfil || {};
  if (!p.tests && !p.build) return null;
  if (p.tests) return { id: 'pruebas', etiqueta: 'Pruebas del proyecto', comando: p.tests, formato: 'pruebas', timeoutMs: 300000 };
  return {
    id: 'compilacion', etiqueta: 'Compilación / tipos', comando: p.build,
    formato: /\btsc\b/.test(String(p.build)) ? 'tsc' : 'generico', timeoutMs: 240000,
  };
}

/* --------------------------------------------------------------------------- *
 *  Parsear la salida REAL de cada herramienta
 * --------------------------------------------------------------------------- */

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

/** Resuelve una ruta del diagnóstico contra la raíz; null si está fuera del proyecto. */
function aAbsoluta(raiz, p) {
  const s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  const abs = path.isAbsolute(s) ? path.normalize(s) : path.resolve(raiz || '.', s);
  if (!raiz) return abs;
  const r = path.normalize(raiz).replace(/[\\/]+$/, '').toLowerCase();
  return abs.toLowerCase().startsWith(r) ? abs : null;
}

/** Clave de comparación de rutas (Windows no distingue mayúsculas). */
const clave = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();

const SEV = (s) => (/^(error|err|e)$/i.test(String(s)) ? 'error' : 'aviso');

/**
 * Convierte la salida de una herramienta en hallazgos.
 *
 * Formatos soportados (los de verdad, tal cual salen):
 *   tsc      src/a.ts(12,5): error TS2322: Type 'string' is not assignable …
 *   eslint   JSON (--format json): [{filePath, messages:[{line,column,severity,ruleId,message}]}]
 *   ruff     src/a.py:12:5: F401 `x` imported but unused   (también vale el de flake8)
 *   mypy     src/a.py:12: error: Incompatible types …   [code]
 *   go       ./a.go:12:5: undefined: cosa
 *   clippy   error[E0308]: mismatched types  \n  --> src/a.rs:12:5
 *   generico cualquier cosa con file:linea:columna: mensaje  (y file:linea: mensaje)
 *
 * @returns {{hallazgos: Array, sinUbicar: number}}
 */
function parsear(texto, { formato = 'generico', raiz = '', herramienta = null } = {}) {
  const src = String(texto == null ? '' : texto).replace(/\r\n?/g, '\n');
  const hallazgos = [];
  let sinUbicar = 0;
  const push = (archivo, linea, columna, sev, codigo, mensaje) => {
    const abs = aAbsoluta(raiz, archivo);
    if (!abs) { sinUbicar++; return; }
    hallazgos.push({
      archivo: abs,
      linea: Number(linea) || null,
      columna: Number(columna) || null,
      severidad: SEV(sev),
      codigo: codigo ? String(codigo).trim() : null,
      mensaje: clip(String(mensaje || '').trim(), 300),
      herramienta: herramienta || formato,
    });
  };

  if (formato === 'eslint') {
    let datos = null;
    try {
      const ini = src.indexOf('[');
      datos = JSON.parse(src.slice(ini >= 0 ? ini : 0));
    } catch { datos = null; }
    if (Array.isArray(datos)) {
      for (const archivo of datos) {
        for (const m of (archivo && archivo.messages) || []) {
          // severity 2 = error, 1 = aviso (los de configuración no traen archivo útil)
          push(archivo.filePath, m.line, m.column, m.severity === 2 ? 'error' : 'aviso', m.ruleId, m.message);
        }
      }
      return { hallazgos, sinUbicar };
    }
    // salida no JSON (una versión vieja o un fallo): cae al genérico
  }

  if (formato === 'tsc') {
    for (const m of src.matchAll(/^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+)?:?\s*(.*)$/gm)) {
      push(m[1], m[2], m[3], m[4] === 'error' ? 'error' : 'aviso', m[5], m[6]);
    }
    if (hallazgos.length || sinUbicar) return { hallazgos, sinUbicar };
  }

  if (formato === 'ruff') {
    for (const m of src.matchAll(/^(.+?):(\d+):(\d+):\s+([A-Za-z]+\d+)?\s*(.*)$/gm)) push(m[1], m[2], m[3], 'error', m[4], m[5]);
    if (hallazgos.length || sinUbicar) return { hallazgos, sinUbicar };
  }

  if (formato === 'mypy') {
    for (const m of src.matchAll(/^(.+?):(\d+):(?:\s*(\d+):)?\s*(error|warning|note):\s*(.*?)(?:\s+\[([a-z-]+)\])?$/gm)) {
      push(m[1], m[2], m[3], m[4], m[6], m[5]);
    }
    if (hallazgos.length || sinUbicar) return { hallazgos, sinUbicar };
  }

  if (formato === 'go') {
    for (const m of src.matchAll(/^(.+?):(\d+):(\d+):\s*(.*)$/gm)) push(m[1], m[2], m[3], 'error', null, m[4]);
    if (hallazgos.length || sinUbicar) return { hallazgos, sinUbicar };
  }

  if (formato === 'clippy') {
    // rustc/clippy: la cabecera dice la severidad y el mensaje; la ubicación va en «-->»
    const lineas = src.split('\n');
    for (let i = 0; i < lineas.length; i++) {
      const cab = lineas[i].match(/^(error|warning)(\[([A-Z]\d+)\])?:\s+(.*)$/);
      if (!cab) continue;
      for (let j = i + 1; j < Math.min(i + 4, lineas.length); j++) {
        const ubi = lineas[j].match(/^\s*-->\s+(.+?):(\d+):(\d+)/);
        if (ubi) { push(ubi[1], ubi[2], ubi[3], cab[1], cab[3], cab[4]); break; }
      }
    }
    if (hallazgos.length || sinUbicar) return { hallazgos, sinUbicar };
  }

  /* Genérico: file:linea:col: mensaje  /  file:linea: mensaje  (y el de Python sin
     columna). Se ignoran las líneas que no empiezan por algo con pinta de ruta para
     no llenar la lista con cabeceras y resúmenes. */
  for (const linea of src.split('\n')) {
    // OJO con el `.+?`: la ruta puede llevar dos puntos propios (C:\Users\…), así que
    // no se puede prohibir «:» en la parte del archivo — con eso, todo diagnóstico de
    // una ruta absoluta de Windows se perdía. El filtro real es que acabe en extensión.
    const m = linea.match(/^\s*(?:at\s+)?(.+?):(\d+):(?:(\d+):)?\s*(.*)$/);
    if (!m) continue;
    if (/^(error|warning|info|note|npm|node|file|path|File|Traceback)/i.test(m[1])) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(m[1].trim())) continue;   // tiene que parecer un archivo
    push(m[1], m[2], m[3], /error|fail/i.test(m[4]) ? 'error' : 'aviso', null, m[4] || '(sin detalle)');
  }
  return { hallazgos, sinUbicar };
}

/* --------------------------------------------------------------------------- *
 *  ¿Es un fallo de la herramienta o del código?
 * --------------------------------------------------------------------------- */

/**
 * Distingue «el comprobador no está en este equipo» de «tu código tiene un error».
 * Meter lo primero en la lista de errores haría que el agente se pusiera a arreglar
 * un problema que no existe.
 */
function pareceFalloDeHerramienta(res) {
  const r = res || {};
  if (r.code === null) return true;                        // no se pudo ni lanzar
  if (r.code === 127 || r.code === 9009) return true;      // «command not found» / «no se reconoce»
  const txt = String(r.stderr || '') + '\n' + String(r.stdout || '');
  return /No module named|is not recognized as an internal|no se reconoce como un comando|command not found|Cannot find module|ENOENT/i.test(txt);
}

/* --------------------------------------------------------------------------- *
 *  Nuevo vs. preexistente
 * --------------------------------------------------------------------------- */

/**
 * Separa los hallazgos en los que caen en líneas que el turno ha tocado y los que
 * ya estaban antes.
 *
 * @param {Array} hallazgos
 * @param {{archivos?: string[], lineasDe?: (archivo:string)=>Set<number>|null}} opts
 *   `lineasDe` devuelve las líneas cambiadas de un archivo (1-based) o null si no se
 *   sabe (archivo nuevo o no hay pre-imagen) — en ese caso todo cuenta como nuevo.
 */
function clasificar(hallazgos, opts = {}) {
  const lineasDe = typeof opts.lineasDe === 'function' ? opts.lineasDe : () => null;
  const nuevos = [];
  const preexistentes = [];
  for (const h of hallazgos || []) {
    let cambiadas = null;
    try { cambiadas = lineasDe(h.archivo); } catch { cambiadas = null; }
    const nuevo = !cambiadas || !h.linea || cambiadas.has(h.linea);
    (nuevo ? nuevos : preexistentes).push(h);
  }
  return { nuevos, preexistentes };
}

/* --------------------------------------------------------------------------- *
 *  Texto para el modelo
 * --------------------------------------------------------------------------- */

const orden = { error: 0, aviso: 1 };
const porGravedad = (a, b) => (orden[a.severidad] - orden[b.severidad]) || ((a.linea || 0) - (b.linea || 0));

function lineaHallazgo(h, raiz) {
  const rel = raiz ? path.relative(raiz, h.archivo).replace(/\\/g, '/') : h.archivo;
  const pos = h.linea ? `:${h.linea}${h.columna ? ':' + h.columna : ''}` : '';
  return `- ${rel}${pos}  ${h.severidad}${h.codigo ? ' ' + h.codigo : ''}: ${h.mensaje}`;
}

/**
 * Resumen corto y legible de los diagnósticos de una comprobación.
 * @param {{nuevos, preexistentes}} clasificados
 */
function resumen(clasificados, { etiqueta = 'Comprobación', raiz = '', maxLineas = 8, otrosArchivos = 0 } = {}) {
  const nuevos = (clasificados && clasificados.nuevos) || [];
  const viejos = (clasificados && clasificados.preexistentes) || [];
  const errs = nuevos.filter(h => h.severidad === 'error').length;
  const avisos = nuevos.length - errs;
  if (!nuevos.length && !viejos.length && !otrosArchivos) return '';
  const cab = `${etiqueta}: ${errs} error(es)${avisos ? `, ${avisos} aviso(s)` : ''} en lo que has tocado`;
  const partes = [cab + ':'];
  for (const h of nuevos.slice().sort(porGravedad).slice(0, maxLineas)) partes.push(lineaHallazgo(h, raiz));
  if (nuevos.length > maxLineas) partes.push(`… (y ${nuevos.length - maxLineas} más)`);
  if (viejos.length) partes.push(`(además, ${viejos.length} hallazgo(s) en líneas que NO has tocado: ya estaban ahí, no los arregles salvo que el usuario lo pida)`);
  if (otrosArchivos) partes.push(`(y ${otrosArchivos} hallazgo(s) en otros archivos del proyecto)`);
  return partes.join('\n');
}

/** Hay errores NUEVOS que el agente tiene que atender para no dar el paso por bueno. */
function hayErroresNuevos(clasificados) {
  return !!clasificados && (clasificados.nuevos || []).some(h => h.severidad === 'error');
}

/* --------------------------------------------------------------------------- *
 *  Pruebas / compilación de cierre
 * --------------------------------------------------------------------------- */

/**
 * Texto de una ejecución de pruebas o de compilación: lo que el modelo necesita
 * para arreglar el fallo, no el volcado entero. Se recorta por arriba y por abajo
 * (el resumen de fallos suele estar al final) y se quedan las líneas que nombran
 * fallos o archivos.
 */
function resumenEjecucion(res, { etiqueta = 'Comprobación', comando = '', maxChars = 3500 } = {}) {
  const r = res || {};
  const salida = String(r.stdout || '') + (String(r.stderr || '').trim() ? '\n' + String(r.stderr || '') : '');
  const ok = r.code === 0;
  const cab = `${etiqueta} (${comando || 'comando'}) → ${ok ? 'OK' : 'FALLÓ'}${r.code == null ? '' : ' (código ' + r.code + ')'}`;
  if (ok) return cab;
  const lineas = salida.split(/\r?\n/).filter(l => l.trim());
  const interesantes = lineas.filter(l => /(^|\s)(FAIL|FAILED|ERROR|Error|error|✕|×|✗|Expected|Received|AssertionError|Traceback|passed|failed|Tests?:)/.test(l));
  const cuerpo = (interesantes.length >= 3 ? interesantes : lineas).slice(-60).join('\n');
  return `${cab}\n${clip(cuerpo, maxChars)}`;
}

module.exports = {
  planPorArchivos, planCierre, parsear, clasificar, resumen, resumenEjecucion,
  hayErroresNuevos, pareceFalloDeHerramienta, eslintDisponible, aAbsoluta,
};
