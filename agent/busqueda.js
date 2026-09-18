'use strict';
/*
 * busqueda.js — v2.5: búsqueda híbrida sobre el proyecto.
 *
 *  «¿Dónde está lo que decide si una actualización se puede aplicar?» no es una pregunta
 *  que se responda con una búsqueda de texto exacta: quien pregunta no sabe cómo se llama
 *  la función. Y tampoco con una búsqueda «semántica» sola: cuando el nombre SÍ se sabe
 *  (`precioConDescuento`), la coincidencia exacta gana siempre.
 *
 *  Aquí van las dos, y en ese orden:
 *
 *   1. Coincidencia EXACTA con ripgrep si está en el equipo (y si no, con un barrido en
 *      JavaScript, que para un proyecto normal cuesta milisegundos). Es lo que resuelve
 *      «dónde se usa esto».
 *   2. Ranking por relevancia con BM25 sobre trozos de archivo. Es recuperación de verdad
 *      (frecuencia del término, longitud del documento, saturación) y funciona con palabras
 *      que NO aparecen literalmente: quien busca «descarga del instalador» encuentra el
 *      archivo que habla de `lanzarInstalador` y de `quitAndInstall`.
 *
 *  Se elige BM25 local y no embeddings a propósito: no hace falta ninguna clave, no sale
 *  nada del equipo, no cuesta un céntimo por consulta y no hay que indexar el repositorio
 *  en un servicio. Para un espacio de trabajo de decenas de miles de líneas la diferencia
 *  con un embedding es pequeña; para el bolsillo y la privacidad, es enorme.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const repomap = require('./repomap');   // los mismos ignorados que el mapa del proyecto

const MAX_FICHERO = 300 * 1024;
const MAX_FICHEROS = 4000;
const MAX_LINEAS_CHUNK = 40;
const MAX_CHUNKS = 20000;
const TTL_MS = 20000;

/* Extensiones que se indexan: código y texto donde vive el conocimiento de un proyecto. */
const EXTENSIONES = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.php',
  '.java', '.cs', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.bat',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.md', '.txt', '.sql', '.html', '.css',
]);

/* Palabras vacías de los dos idiomas del proyecto: si no se quitan, «de la para» pesa
   tanto como el término que importa y el ranking se convierte en ruido. */
const VACIAS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'not',
  'but', 'you', 'all', 'any', 'can', 'use', 'our', 'out', 'into', 'when', 'what', 'how',
  'que', 'los', 'las', 'del', 'con', 'por', 'para', 'una', 'uno', 'este', 'esta', 'como',
  'mas', 'más', 'sin', 'sus', 'son', 'esa', 'ese', 'eso', 'hay', 'muy', 'dos', 'nos',
  'sea', 'ver', 'tan', 'tal', 'sus', 'les', 'ser', 'fue', 'era', 'han', 'has', 'hemos',
]);

function normalizar(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Trocea un texto en términos: separa camelCase y snake_case y quita palabras vacías.
 * El corte por mayúsculas tiene que hacerse ANTES de pasar a minúsculas — si no, todo
 * `precioConDescuento` queda en una sola palabra y buscar «descuento» no encuentra nada
 * (que es justo el término que un humano escribe).
 */
function terminos(texto) {
  const out = [];
  const limpio = String(texto == null ? '' : texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const palabra of limpio.split(/[^A-Za-z0-9_$]+/)) {
    if (!palabra) continue;
    const partes = palabra.split(/(?<=[a-z0-9])(?=[A-Z])|_|\$/).filter(Boolean);
    for (const p of [palabra, ...partes]) {
      const t = p.replace(/^_+|_+$/g, '').toLowerCase();
      if (t.length < 3 || VACIAS.has(t) || /^\d+$/.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

/* --------------------------------------------------------------------------- *
 *  ripgrep: la coincidencia exacta, cuando está disponible
 * --------------------------------------------------------------------------- */
let _rgCache = null;
/** ¿Hay ripgrep en el equipo? Se comprueba UNA vez por proceso. */
function disponibleRg() {
  if (_rgCache !== null) return _rgCache;
  try {
    const r = spawnSync('rg', ['--version'], { timeout: 4000, encoding: 'utf8' });
    _rgCache = !!(r && r.status === 0);
  } catch { _rgCache = false; }
  return _rgCache;
}

/** Coincidencias exactas de la consulta (ripgrep si se puede; si no, barrido en JS). */
function coincidencias(workspace, consulta, { limit = 30 } = {}) {
  const q = String(consulta || '').trim();
  if (!q) return { hits: [], metodo: 'ninguno' };
  if (disponibleRg()) {
    /* OJO con dos detalles que ya nos mordieron:
       · la ruta se pasa SIEMPRE explícita. Sin ella, y con la entrada estándar siendo un
         tubo (como aquí, que no hay terminal), ripgrep espera a que se CIERRE el tubo en
         vez de buscar: la búsqueda exacta se quedaba sin resultados y en silencio.
       · `stdio` deja la entrada en 'ignore' por el mismo motivo. */
    const rg = (patron, tope) => {
      /* `--no-require-git`: sin esto, ripgrep solo aplica el .gitignore si la carpeta es
         un repositorio de git. En un proyecto que no lo es (o en una carpeta copiada),
         buscaba dentro de lo que el usuario tiene mandado ignorar — y la mitad exacta
         devolvía lo que la mitad de relevancia había descartado bien. */
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '5', '--smart-case',
        '--no-require-git', '--glob', '!node_modules', '--glob', '!dist', '--glob', '!build',
        '--fixed-strings', '--', patron, workspace];
      try {
        const r = spawnSync('rg', args, { cwd: workspace, timeout: 15000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const hits = [];
        for (const linea of String(r.stdout || '').split(/\r?\n/)) {
          const m = linea.match(/^(.+?):(\d+):(.*)$/);
          if (!m) continue;
          // rg devuelve rutas absolutas (se pidió la carpeta): se enseñan relativas,
          // que es como las usa todo lo demás (y como las entiende el modelo)
          const rel = path.relative(workspace, m[1]).replace(/\\/g, '/') || m[1].replace(/\\/g, '/');
          hits.push({ ruta: rel, linea: Number(m[2]), texto: m[3].trim().slice(0, 200), exacta: true, patron });
          if (hits.length >= tope) break;
        }
        return hits;
      } catch { return []; }
    };
    const hits = rg(q, limit);
    if (hits.length) return { hits, metodo: 'ripgrep' };
    /* Una consulta de varias palabras casi nunca aparece literal («aplicar actualizacion
       instalador»). Sin esto, la mitad exacta de la búsqueda no aportaba nada en las
       preguntas de verdad: se busca también por los términos más largos, uno a uno. */
    const terminosLargos = [...new Set(terminos(q))].filter(t => t.length >= 4).sort((a, b) => b.length - a.length).slice(0, 2);
    const porTermino = [];
    for (const t of terminosLargos) {
      for (const h of rg(t, Math.ceil(limit / Math.max(1, terminosLargos.length)))) {
        if (porTermino.some(x => x.ruta === h.ruta && x.linea === h.linea)) continue;
        porTermino.push(h);
        if (porTermino.length >= limit) break;
      }
      if (porTermino.length >= limit) break;
    }
    if (porTermino.length) return { hits: porTermino, metodo: 'ripgrep' };
  }
  const hits = [];
  for (const f of listar(workspace)) {
    let texto = '';
    try { texto = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (!normalizar(texto).includes(normalizar(q))) continue;
    const lineas = texto.split(/\r?\n/);
    for (let i = 0; i < lineas.length && hits.length < limit; i++) {
      if (normalizar(lineas[i]).includes(normalizar(q))) hits.push({ ruta: f.ruta, linea: i + 1, texto: lineas[i].trim().slice(0, 200), exacta: true });
    }
    if (hits.length >= limit) break;
  }
  return { hits, metodo: 'barrido' };// sin ripgrep se recorre el proyecto (más lento, mismo resultado)
}

/* --------------------------------------------------------------------------- *
 *  Índice BM25 (recuperación por relevancia, sin dependencias)
 * --------------------------------------------------------------------------- */

/** Lista de archivos de texto/código del proyecto (con los mismos ignorados que el mapa). */
function listar(workspace) {
  if (!workspace) return [];
  const out = [];
  // mismas reglas que el mapa del proyecto: lo que el usuario ignora en .gitignore no
  // aparece ni en el mapa ni aquí (si no, buscaría dentro de dist/ y de los logs)
  const reglas = repomap.reglasIgnoradas(workspace);
  const pila = [workspace];
  const prof = new Map([[workspace, 0]]);
  while (pila.length && out.length < MAX_FICHEROS) {
    const dir = pila.pop();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(workspace, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || repomap.IGNORADOS.has(e.name)) continue;
        const p = (prof.get(dir) || 0) + 1;
        if (p > 8) continue;
        if (repomap.ignoradoPorRegla(rel, reglas)) continue;
        prof.set(abs, p);
        pila.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTENSIONES.has(ext)) continue;
      if (repomap.ignoradoPorRegla(rel, reglas)) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_FICHERO) continue;
      out.push({ ruta: rel, abs, bytes: st.size });
    }
  }
  return out;
}

/** Trocea un archivo en bloques de líneas: un bloque es la unidad que se puntúa. */
function trocear(texto, maxLineas = MAX_LINEAS_CHUNK) {
  const lineas = texto.split(/\r?\n/);
  const trozos = [];
  // se parte por líneas en blanco para no mezclar funciones distintas en un mismo bloque
  let actual = [];
  for (const l of lineas) {
    actual.push(l);
    const cierra = !l.trim() && actual.length >= 4;
    if (actual.length >= maxLineas || cierra) {
      if (actual.join('').trim()) trozos.push(actual);
      actual = [];
    }
  }
  if (actual.join('').trim()) trozos.push(actual);
  return trozos;
}

let cache = null;   // { raiz, ts, indice }

/** Índice BM25 del proyecto (con caché por TTL). */
function indice(workspace, opts = {}) {
  const ahora = Date.now();
  if (cache && cache.raiz === workspace && ahora - cache.ts < (opts.ttlMs || TTL_MS)) return cache.indice;
  const docs = [];
  const df = new Map();
  let totalLineas = 0;
  for (const f of listar(workspace)) {
    let texto = '';
    try { texto = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    let linea = 1;
    for (const trozo of trocear(texto)) {
      const cuerpo = trozo.join('\n');
      const tf = new Map();
      for (const t of terminos(cuerpo)) tf.set(t, (tf.get(t) || 0) + 1);
      if (!tf.size) { linea += trozo.length; continue; }
      docs.push({ ruta: f.ruta, linea, lineas: trozo.length, tf, len: terminos(cuerpo).length, cabeza: trozo.find(l => l.trim()) || '' });
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      totalLineas += trozo.length;
      linea += trozo.length;
    }
    if (docs.length >= MAX_CHUNKS) break;
  }
  const indiceListo = { docs, df, n: docs.length, mediaLen: docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 1, totalLineas };
  cache = { raiz: workspace, ts: ahora, indice: indiceListo };
  return indiceListo;
}
function invalidar(workspace) {
  if (!cache) return;
  if (!workspace || cache.raiz === workspace) cache = null;
}
function _resetForTests() { cache = null; _rgCache = null; }

/** Puntuación BM25 de un documento para unos términos. */
function puntuar(doc, terminosQ, idx, { k1 = 1.4, b = 0.75 } = {}) {
  let score = 0;
  const largo = doc.len || 1;
  for (const t of terminosQ) {
    const f = doc.tf.get(t);
    if (!f) continue;
    const nq = idx.df.get(t) || 1;
    const idf = Math.log(1 + (idx.n - nq + 0.5) / (nq + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (largo / (idx.mediaLen || 1)))));
  }
  return score;
}

/** Primera línea con contenido del bloque: da contexto sin pegar el archivo entero. */
function recorte(doc) {
  return String(doc.cabeza || '').trim().slice(0, 200);
}

/**
 * Búsqueda híbrida: coincidencias exactas primero, relevancia detrás, sin duplicar.
 * @returns {{hits: Array, metodo: string, indice: {chunks: number, archivos: number}}}
 */
function buscar(workspace, consulta, { limit = 12, exactas = 8 } = {}) {
  const q = String(consulta || '').trim();
  if (!workspace || !q) return { hits: [], metodo: 'ninguno', indice: { chunks: 0, archivos: 0 } };
  const idx = indice(workspace);
  const ts = terminos(q);
  // `exactas: 0` deja solo la mitad de relevancia (lo usan las pruebas para medirla sola)
  const ex = exactas > 0 ? coincidencias(workspace, q, { limit: exactas }) : { hits: [], metodo: 'ninguno' };
  const hits = [];
  const vistos = new Set();
  for (const h of ex.hits) {
    const clave = h.ruta + ':' + h.linea;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    hits.push({ ...h, tipo: 'exacta', score: 100 });
  }
  if (ts.length && idx.docs.length) {
    const puntuados = [];
    for (const d of idx.docs) {
      const s = puntuar(d, ts, idx);
      if (s > 0) puntuados.push({ d, s });
    }
    puntuados.sort((a, b) => b.s - a.s);
    // la misma zona de un archivo no se repite: el primero que entra es el mejor
    const porArchivo = new Map();
    for (const { d, s } of puntuados) {
      const clave = d.ruta + ':' + d.linea;
      if (vistos.has(clave)) continue;
      const yaEnRango = [...vistos].some(k => k.startsWith(d.ruta + ':') && Math.abs(Number(k.split(':')[1]) - d.linea) < MAX_LINEAS_CHUNK);
      if (yaEnRango) continue;
      const repes = porArchivo.get(d.ruta) || 0;
      if (repes >= 2) continue;
      porArchivo.set(d.ruta, repes + 1);
      vistos.add(clave);
      hits.push({ ruta: d.ruta, linea: d.linea, texto: recorte(d), tipo: 'relevancia', score: s });
    }
  }
  const orden = hits.sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits: orden, metodo: ex.metodo === 'ripgrep' ? 'ripgrep + relevancia' : 'barrido + relevancia', indice: { chunks: idx.docs.length, archivos: new Set(idx.docs.map(d => d.ruta)).size } };
}

/** Texto que ve el modelo (con de dónde sale cada cosa). */
function textoBusqueda(workspace, consulta, { limit = 12 } = {}) {
  const r = buscar(workspace, consulta, { limit });
  if (!r.hits.length) {
    return `Sin resultados para «${consulta}» (${r.indice.archivos} archivos indexados). Prueba con menos palabras, o usa repo_map para ver el índice del proyecto.`;
  }
  const exactas = r.hits.filter(h => h.tipo === 'exacta');
  const lineas = [`${r.hits.length} resultado(s) para «${consulta}» — ${r.metodo}, ${r.indice.chunks} bloques de ${r.indice.archivos} archivos:`];
  for (const h of r.hits) {
    lineas.push(`- ${h.ruta}:${h.linea}  ${h.tipo === 'exacta' ? '(coincidencia exacta)' : '(relevancia)'}${h.texto ? '  ' + h.texto : ''}`);
  }
  lineas.push(exactas.length
    ? 'Lee el tramo que te interese con read_file (offset/limit) en vez del archivo entero.'
    : 'No hay coincidencia literal: son los sitios MÁS relacionados con lo que buscas. Léelos con read_file antes de dar nada por hecho.');
  return lineas.join('\n');
}

module.exports = { buscar, textoBusqueda, indice, invalidar, listar, terminos, trocear, disponibleRg, coincidencias, EXTENSIONES, _resetForTests };
