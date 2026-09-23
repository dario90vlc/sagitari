'use strict';

/* ============================================================================
   repomap.js — el mapa del repositorio.

   En un proyecto grande, las dos preguntas que más contexto queman son «¿dónde
   está esto?» y «¿qué hay en esta carpeta?». Sin un índice, el agente responde
   leyendo archivos uno a uno: se come el turno y aun así se le escapan cosas.

   Esto recorre el espacio de trabajo UNA vez (con topes: nada de node_modules,
   .git, dist ni binarios, ni archivos enormes), saca los símbolos que define
   cada archivo (funciones, clases, tipos, títulos de documentación) y ofrece:

     · un mapa compacto por carpetas, para el prompt y para la herramienta
     · búsqueda por nombre de símbolo o de archivo (`find_symbol`)

   Es determinista y sin dependencias: expresiones regulares sobre las líneas
   que empiezan una definición. No es un compilador —no resuelve tipos ni
   imports—, pero para «dónde está X» y «qué hay aquí» es exacto y cuesta
   milisegundos, que es justo lo que hace falta.
   ============================================================================ */

const fs = require('fs');
const path = require('path');
const indiceCompartido = require('./indice');
// Reexportados del recorrido único (este módulo los mantuvo en su API pública
// y `busqueda.js` los usaba desde aquí).
const IGNORADOS = indiceCompartido.IGNORADOS;
const MAX_FICHERO = 200 * 1024;      // por encima de esto no es código que se lea entero
const MAX_FICHEROS = 6000;           // tope duro del recorrido
const MAX_SIMBOLOS_POR_FICHERO = 80;
const MAX_PROFUNDIDAD = 8;

/* --------------------------------------------------------------------------- *
 *  Definiciones por lenguaje
 * --------------------------------------------------------------------------- */
const PATRONES = {
  js: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'función'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'clase'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'función'],
    [/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/, 'export'],
    [/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/, 'export'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+(\w+)/, 'def'],
    [/^\s*class\s+(\w+)/, 'clase'],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'func'],
    [/^type\s+(\w+)/, 'tipo'],
  ],
  rs: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 'fn'],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, 'tipo'],
  ],
  rb: [
    [/^\s*def\s+([\w?!]+)/, 'def'],
    [/^\s*(?:class|module)\s+(\w+)/, 'clase'],
  ],
  php: [
    [/^\s*(?:public|private|protected|static|abstract|final|\s)*function\s+(\w+)/, 'función'],
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'clase'],
  ],
  jvm: [
    [/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|async|override|virtual|final|\s)*\s(?:class|interface|record|struct|enum)\s+(\w+)/, 'tipo'],
    [/^\s*(?:public|private|protected|internal|static|async|override|virtual|\s)+[\w<>\[\],.?]+\s+(\w+)\s*\(/, 'método'],
  ],
  md: [
    [/^(#{1,3})\s+(.+?)\s*$/, 'sección'],
  ],
};
/** Exportaciones en bloque: `module.exports = { a, b }` (el estilo de este repo). */
const EXPORT_EN_BLOQUE = /^\s*module\.exports\s*=\s*\{([^}]*)\}/;
const EXT_A_LENGUAJE = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.rb': 'rb', '.php': 'php',
  '.java': 'jvm', '.cs': 'jvm', '.kt': 'jvm', '.md': 'md',
};

/* --------------------------------------------------------------------------- *
 *  Recorrido: el árbol lo recorre el módulo compartido `indice.js` (el mismo
 *  que usa la búsqueda). Aquí solo quedan los alias de la API pública.
 * --------------------------------------------------------------------------- */

// Alias del recorrido único (firmas idénticas a las que había aquí).
function reglasIgnoradas(workspace) { return indiceCompartido.reglasIgnoradas(workspace); }
function ignoradoPorRegla(rel, reglas) { return indiceCompartido.ignoradoPorRegla(rel, reglas); }

function simbolosDe(texto, ext) {
  const lenguaje = EXT_A_LENGUAJE[ext];
  if (!lenguaje) return [];
  const out = [];
  const lineas = texto.split(/\r?\n/);
  for (let i = 0; i < lineas.length && out.length < MAX_SIMBOLOS_POR_FICHERO; i++) {
    const l = lineas[i];
    if (!l.trim() || l.trim().startsWith('//') || l.trim().startsWith('*')) continue;
    const bloque = lenguaje === 'js' ? l.match(EXPORT_EN_BLOQUE) : null;
    if (bloque) {
      for (const n of bloque[1].split(',').map(x => x.trim().split(':')[0].trim()).filter(Boolean)) {
        if (/^[A-Za-z_$][\w$]*$/.test(n)) out.push({ name: n, kind: 'export', line: i + 1 });
      }
      continue;
    }
    for (const [re, kind] of PATRONES[lenguaje]) {
      const m = l.match(re);
      if (m) {
        const name = (kind === 'sección' ? m[2] : m[1] || '').trim();
        if (name) out.push({ name, kind, line: i + 1 });
        break;
      }
    }
  }
  return out;
}

function extDe(nombre) {
  const e = path.extname(nombre).toLowerCase();
  return e;
}

/** Recorre el espacio de trabajo y construye el indice. */
function construir(workspace, opts = {}) {
  const raiz = workspace;
  const recorrido = indiceCompartido.recorrer(raiz, {
    extensiones: new Set(Object.keys(EXT_A_LENGUAJE)),
    maxFichero: MAX_FICHERO,
    maxFicheros: MAX_FICHEROS,
    maxProfundidad: MAX_PROFUNDIDAD,
    incluirGithub: true,
  });
  const archivos = [];
  for (const f of recorrido.archivos) {
    const ext = extDe(f.ruta);
    if (f.grande) { archivos.push({ ruta: f.ruta, ext, bytes: f.bytes, simbolos: [], grande: true }); continue; }
    let texto;
    try { texto = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    archivos.push({ ruta: f.ruta, ext, bytes: f.bytes, simbolos: simbolosDe(texto, ext) });
  }
  archivos.sort((a, b) => a.ruta.localeCompare(b.ruta));
  const simbolos = archivos.reduce((n, a) => n + a.simbolos.length, 0);
  return { raiz, archivos, totales: { ficheros: archivos.length, simbolos }, truncado: recorrido.truncado };
}

/* --------------------------------------------------------------------------- *
 *  Caché: el índice se recalcula con calma (TTL corto + invalidación al escribir)
 *  Recorrer el árbol entero en cada llamada al prompt sería absurdo; y hacerlo
 *  por firma de mtime exigiría `stat` de todos los archivos, que es casi el
 *  mismo coste que leerlos. Con TTL + invalidación explícita basta: quien escribe
 *  avisa (executors.invalidarMapa) y el resto del tiempo se sirve de memoria.
 * --------------------------------------------------------------------------- */
const TTL_MS = 20000;
let cache = null;   // { raiz, ts, indice }

function indice(workspace, opts = {}) {
  const ahora = Date.now();
  if (cache && cache.raiz === workspace && ahora - cache.ts < (opts.ttlMs || TTL_MS)) return cache.indice;
  const idx = construir(workspace, opts);
  cache = { raiz: workspace, ts: ahora, indice: idx };
  return idx;
}
function invalidar(workspace) {
  if (!cache) return;
  if (!workspace || cache.raiz === workspace) cache = null;
}
function _resetForTests() { cache = null; }

/* --------------------------------------------------------------------------- *
 *  Vistas
 * --------------------------------------------------------------------------- */

/** Mapa legible por carpetas, con presupuesto de caracteres. */
function mapa(workspace, opts = {}) {
  const idx = indice(workspace, opts);
  const presupuesto = opts.maxChars || 7000;
  if (!idx.archivos.length) return 'El espacio de trabajo no tiene archivos de código reconocibles.';
  const porCarpeta = new Map();
  for (const a of idx.archivos) {
    const dir = path.dirname(a.ruta) === '.' ? '(raíz)' : path.dirname(a.ruta);
    if (!porCarpeta.has(dir)) porCarpeta.set(dir, []);
    porCarpeta.get(dir).push(a);
  }
  const partes = [`MAPA DEL PROYECTO — ${idx.totales.ficheros} archivos, ${idx.totales.simbolos} símbolos`];
  let usado = partes[0].length;
  for (const [dir, lista] of [...porCarpeta.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bloque = [dir + '/'];
    for (const a of lista) {
      const nombres = a.simbolos.filter(s => s.kind !== 'sección').map(s => s.name);
      const detalle = nombres.length ? `: ${nombres.slice(0, 14).join(', ')}${nombres.length > 14 ? ` … (+${nombres.length - 14})` : ''}` : '';
      bloque.push(`  ${path.basename(a.ruta)}${detalle}`);
    }
    const texto = bloque.join('\n');
    if (usado + texto.length > presupuesto) { partes.push(`…(mapa recortado: usa find_symbol o list_dir para el resto${idx.truncado ? '; el recorrido está topado a ' + MAX_FICHEROS + ' archivos' : ''})`); break; }
    partes.push(texto);
    usado += texto.length + 1;
  }
  return partes.join('\n');
}

/** Bloque corto para el prompt: solo si el proyecto es lo bastante grande. */
function bloquePrompt(workspace, opts = {}) {
  let idx;
  try { idx = indice(workspace, opts); } catch { return ''; }
  if (idx.totales.ficheros < (opts.minFicheros || 25)) return '';
  const ranking = idx.archivos
    .filter(a => a.simbolos.length)
    .sort((a, b) => b.simbolos.length - a.simbolos.length)
    .slice(0, 12);
  if (!ranking.length) return '';
  const lineas = [`MAPA DEL PROYECTO (${idx.totales.ficheros} archivos — índice, no lo leas todo):`];
  let usado = lineas[0].length;
  for (const a of ranking) {
    const l = `- ${a.ruta}: ${a.simbolos.filter(s => s.kind !== 'sección').slice(0, 8).map(s => s.name).join(', ')}`;
    if (usado + l.length > (opts.maxChars || 1500)) break;
    lineas.push(l);
    usado += l.length + 1;
  }
  lineas.push('- Para el resto: repo_map (por carpetas), find_symbol (dónde se define algo) y search_code (busca por CONTENIDO: coincidencias exactas + lo más relacionado). Antes de leer un archivo entero, busca.');
  return lineas.join('\n');
}

/**
 * Búsqueda por nombre de símbolo o de archivo.
 * Devuelve { hits: [{ ruta, línea, nombre, tipo }], archivos: [ruta] }
 */
function buscar(workspace, consulta, opts = {}) {
  const idx = indice(workspace, opts);
  const q = String(consulta || '').trim().toLowerCase();
  const limite = opts.limit || 40;
  const partes = q.split(/[\s./\\]+/).filter(Boolean);
  const puntua = (texto) => {
    const t = String(texto).toLowerCase();
    if (!q) return 0;
    if (t === q) return 100;
    let p = t.includes(q) ? 60 : 0;
    for (const parte of partes) if (t.includes(parte)) p += 12;
    // camelCase: "abrirCuenta" se encuentra con "abrir cuenta"
    if (!p && partes.length > 1) {
      const plano = t.replace(/[^a-z0-9]/g, '');
      if (partes.every(x => plano.includes(x))) p += 20;
    }
    return p;
  };
  const hits = [];
  const archivos = [];
  for (const a of idx.archivos) {
    const pa = puntua(a.ruta);
    if (pa) archivos.push({ ruta: a.ruta, puntos: pa });
    for (const s of a.simbolos) {
      if (s.kind === 'sección') continue;
      const p = puntua(s.name);
      if (p) hits.push({ ruta: a.ruta, linea: s.line, nombre: s.name, tipo: s.kind, puntos: p });
    }
  }
  hits.sort((x, y) => y.puntos - x.puntos || x.ruta.localeCompare(y.ruta));
  archivos.sort((x, y) => y.puntos - x.puntos || x.ruta.localeCompare(y.ruta));
  return {
    hits: hits.slice(0, limite),
    archivos: archivos.slice(0, 15).map(x => x.ruta),
    totales: { simbolos: hits.length, archivos: archivos.length },
  };
}

/** Texto listo para devolver al modelo desde la herramienta find_symbol. */
function textoBusqueda(workspace, consulta, opts = {}) {
  const r = buscar(workspace, consulta, opts);
  if (!r.hits.length && !r.archivos.length) return `Sin resultados para «${consulta}». Prueba con menos palabras o usa repo_map para ver el índice.`;
  const lineas = [];
  if (r.hits.length) {
    lineas.push(`${r.hits.length}${r.totales.simbolos > r.hits.length ? ' de ' + r.totales.simbolos : ''} definiciones:`);
    for (const h of r.hits) lineas.push(`- ${h.ruta}:${h.linea}  ${h.tipo} ${h.nombre}`);
  }
  if (r.archivos.length) {
    lineas.push(r.hits.length ? 'Archivos que coinciden:' : 'Archivos que coinciden:');
    for (const f of r.archivos) lineas.push(`- ${f}`);
  }
  return lineas.join('\n');
}

module.exports = {
  construir, indice, invalidar, mapa, bloquePrompt, buscar, textoBusqueda, simbolosDe,
  IGNORADOS, MAX_FICHEROS, reglasIgnoradas, ignoradoPorRegla, _resetForTests,
};
