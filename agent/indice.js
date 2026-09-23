'use strict';

/* ============================================================================
   indice.js — el recorrido único del espacio de trabajo.

   Antes había DOS recorridos del árbol con la misma lógica copiada: el de
   `repomap.js` (mapa de símbolos) y el de `busqueda.js` (índice BM25). Cada
   uno leía su propia lista de .gitignore, aplicaba sus propios ignorados y
   recorría el disco por separado — el doble de E/S cada vez que el agente
   exploraba un proyecto, y dos sitios donde olvidar un ignorado nuevo.

   Aquí vive el recorrido compartido: directorios ignorados, reglas del
   .gitignore/.sagi-ignore, topes de profundidad y de ficheros. `repomap` y
   `busqueda` lo usan con sus propios parámetros (extensiones, tamaños) y
   conservan su API pública intacta.
   ============================================================================ */

const fs = require('fs');
const path = require('path');

const IGNORADOS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  'vendor', '.idea', '.vscode', '.gradle', '.terraform', 'tmp', 'temp', 'logs', 'release',
]);

/** Patrones simples del .gitignore (nombres, `*.ext` y `carpeta/`). */
function reglasIgnoradas(workspace) {
  const out = [];
  for (const nombre of ['.gitignore', '.sagi-ignore']) {
    try {
      const txt = fs.readFileSync(path.join(workspace, nombre), 'utf8');
      for (const linea of txt.split(/\r?\n/)) {
        const l = linea.trim();
        if (!l || l.startsWith('#') || l.startsWith('!')) continue;
        out.push(l.replace(/\/$/, ''));
      }
    } catch {}
  }
  return out;
}
function ignoradoPorRegla(rel, reglas) {
  for (const r of reglas) {
    if (!r) continue;
    if (r.startsWith('*.')) { if (rel.endsWith(r.slice(1))) return true; continue; }
    if (r.includes('/')) { if (rel === r || rel.startsWith(r + '/')) return true; continue; }
    if (rel === r || path.basename(rel) === r) return true;
  }
  return false;
}

/**
 * Recorre el espacio de trabajo UNA vez y devuelve los archivos que pasan los
 * filtros. `truncado` avisa de que el recorrido se topó con un tope (el mapa
 * lo enseña; la búsqueda simplemente indexa lo que hay).
 *
 * @returns {{ archivos: Array<{ruta, abs, bytes, grande}>, truncado: boolean }}
 */
function recorrer(workspace, {
  extensiones = null,       // Set de extensiones en minúsculas, o null para aceptar todas
  maxFichero = Infinity,    // por encima de esto el archivo se marca como `grande`
  maxFicheros = 6000,       // tope duro del recorrido
  maxProfundidad = 8,
  incluirGithub = false,    // el mapa enseña .github; la búsqueda lo salta como el resto de ocultos
} = {}) {
  if (!workspace) return { archivos: [], truncado: false };
  const archivos = [];
  let truncado = false;
  const reglas = reglasIgnoradas(workspace);
  const pila = [{ dir: workspace, prof: 0 }];
  while (pila.length && archivos.length < maxFicheros) {
    const { dir, prof } = pila.pop();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(workspace, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (IGNORADOS.has(e.name)) continue;
        if (e.name.startsWith('.') && !(incluirGithub && e.name === '.github')) continue;
        if (ignoradoPorRegla(rel, reglas)) continue;
        if (prof >= maxProfundidad) { truncado = true; continue; }
        pila.push({ dir: abs, prof: prof + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (extensiones && !extensiones.has(ext)) continue;
      if (ignoradoPorRegla(rel, reglas)) continue;
      if (archivos.length >= maxFicheros) { truncado = true; break; }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      archivos.push({ ruta: rel, abs, bytes: st.size, grande: st.size > maxFichero });
    }
  }
  if (pila.length && archivos.length >= maxFicheros) truncado = true;
  return { archivos, truncado };
}

/** Variante que devuelve solo la lista (la que usa la búsqueda). */
function listarArchivos(workspace, opts = {}) {
  return recorrer(workspace, opts).archivos;
}

module.exports = {
  recorrer, listarArchivos, reglasIgnoradas, ignoradoPorRegla,
  IGNORADOS,
};
